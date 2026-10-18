/**
 * 房间 Durable Object：协调层薄适配。
 *
 * 本文件**不得包含任何游戏规则**（见 AGENTS.md §6 硬约束 3）。
 * 它只做：排序（分配 seq）、广播、在线状态、按截止时间推进阶段。
 * 全部判定逻辑在客户端；协调逻辑在 ./coordination.ts（纯函数，已单测）。
 */

import { Server, type Connection } from 'partyserver'
import type { GameEvent } from '../src/core/types.ts'
import type { ClientMessage, ServerMessage } from '../src/net/protocol.ts'
import {
  applyAddBot,
  applyCommit,
  applyHello,
  applyLeave,
  applyReady,
  applyRemoveBot,
  applyReset,
  applyReveal,
  isHost,
  createRoom,
  nextDeadline,
  tick,
  type RoomState,
} from './coordination.ts'

const STORAGE_KEY = 'room'

interface ConnState {
  seatId: string
}

export class AnpaiRoom extends Server<Env> {
  static options = { hibernate: false }

  private room: RoomState = createRoom()

  async onStart(): Promise<void> {
    const saved = await this.ctx.storage.get<RoomState>(STORAGE_KEY)
    if (saved) this.room = saved
    await this.reschedule()
  }

  async onMessage(
    conn: Connection<ConnState>,
    raw: string | ArrayBuffer | ArrayBufferView,
  ): Promise<void> {
    if (typeof raw !== 'string') return

    let message: ClientMessage
    try {
      message = JSON.parse(raw) as ClientMessage
    } catch {
      this.reject(conn, 'bad-message', '消息不是合法 JSON')
      return
    }

    const now = Date.now()

    if (message.t === 'hello') {
      await this.handleHello(conn, message.seatId, message.nickname, now)
      return
    }

    const seatId = conn.state?.seatId
    if (!seatId) {
      this.reject(conn, 'rejected', '请先发送 hello')
      return
    }

    switch (message.t) {
      case 'ready': {
        const result = applyReady(this.room, seatId, message.ready, now)
        this.room = result.state
        this.broadcastEvents(result.events)
        await this.persist()
        break
      }
      case 'commit': {
        const actor = this.resolveActor(conn, seatId, message.forSeat)
        if (actor === null) return
        const result = applyCommit(
          this.room,
          { seatId: actor, round: message.round, commit: message.commit },
          now,
        )
        this.room = result.state
        this.broadcastEvents(result.events)
        await this.persist()
        break
      }
      case 'reveal': {
        const actor = this.resolveActor(conn, seatId, message.forSeat)
        if (actor === null) return
        const result = applyReveal(
          this.room,
          {
            seatId: actor,
            round: message.round,
            slotIndex: message.slotIndex,
            nonceHex: message.nonceHex,
          },
          now,
        )
        this.room = result.state
        this.broadcastEvents(result.events)
        await this.persist()
        break
      }
      case 'addBot': {
        if (!isHost(this.room, seatId)) {
          this.reject(conn, 'rejected', '只有房主可以添加机器人')
          return
        }
        const result = applyAddBot(this.room, now)
        this.room = result.state
        this.broadcastEvents(result.events)
        await this.persist()
        break
      }
      case 'removeBot': {
        if (!isHost(this.room, seatId)) {
          this.reject(conn, 'rejected', '只有房主可以移除机器人')
          return
        }
        const result = applyRemoveBot(this.room, message.seatId, now)
        this.room = result.state
        this.broadcastEvents(result.events)
        await this.persist()
        break
      }
      case 'reset': {
        const result = applyReset(this.room, now)
        this.room = result.state
        this.broadcastEvents(result.events)
        await this.persist()
        break
      }
      default:
        this.reject(conn, 'bad-message', '未知消息类型')
    }
  }

  async onClose(conn: Connection<ConnState>): Promise<void> {
    const seatId = conn.state?.seatId
    if (!seatId) return
    const result = applyLeave(this.room, seatId, Date.now())
    this.room = result.state
    this.broadcastEvents(result.events)
    await this.persist()
  }

  async onAlarm(): Promise<void> {
    const result = tick(this.room, Date.now())
    this.room = result.state
    this.broadcastEvents(result.events)
    await this.persist()
  }

  private async handleHello(
    conn: Connection<ConnState>,
    seatId: string,
    nickname: string,
    now: number,
  ): Promise<void> {
    if (!seatId || !nickname) {
      this.reject(conn, 'rejected', 'seatId 与昵称必填')
      return
    }

    // 单席位单连接：同一 seatId 的其他连接被接管断开。
    for (const other of this.getConnections<ConnState>()) {
      if (other.id !== conn.id && other.state?.seatId === seatId) {
        other.close(4000, 'seat taken over')
      }
    }

    const result = applyHello(this.room, { seatId, nickname, connectionId: conn.id }, now)
    this.room = result.state
    conn.setState({ seatId })

    // 新连接拿到权威全量日志；其余人只收到增量。
    this.send(conn, { t: 'welcome', seatId, log: this.room.log })
    this.broadcastEvents(result.events, [conn.id])
    await this.persist()
  }

  /**
   * 解析一次提交/揭示的实际归属席位。
   *
   * 普通情况就是 sender 自己。带 `forSeat` 时表示房主代机器人操作：
   * 只有房主可以这么做，且目标必须确实是机器人席位。
   * 这是**授权**检查，不是游戏规则判定——服务器仍然不知道任何人选了什么。
   */
  private resolveActor(
    conn: Connection<ConnState>,
    senderSeat: string,
    forSeat: string | undefined,
  ): string | null {
    if (!forSeat) return senderSeat
    const target = this.room.seats.find((seat) => seat.seatId === forSeat)
    if (!target?.bot) {
      this.reject(conn, 'rejected', '目标席位不是机器人')
      return null
    }
    if (!isHost(this.room, senderSeat)) {
      this.reject(conn, 'rejected', '只有房主可以代机器人操作')
      return null
    }
    return forSeat
  }

  private broadcastEvents(events: readonly GameEvent[], except?: string[]): void {
    for (const event of events) {
      const payload: ServerMessage = { t: 'event', event }
      this.broadcast(JSON.stringify(payload), except)
    }
  }

  private send(conn: Connection<ConnState>, message: ServerMessage): void {
    try {
      conn.send(JSON.stringify(message))
    } catch {
      // 连接可能已关闭，忽略。
    }
  }

  private reject(
    conn: Connection<ConnState>,
    code: 'bad-message' | 'rejected',
    message: string,
  ): void {
    this.send(conn, { t: 'error', code, message })
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY, this.room)
    await this.reschedule()
  }

  private async reschedule(): Promise<void> {
    const at = nextDeadline(this.room)
    if (at === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(at)
  }
}
