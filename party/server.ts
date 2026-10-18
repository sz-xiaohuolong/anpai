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
  applyCommit,
  applyHello,
  applyLeave,
  applyReady,
  applyReveal,
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
        const result = applyCommit(
          this.room,
          { seatId, round: message.round, commit: message.commit },
          now,
        )
        this.room = result.state
        this.broadcastEvents(result.events)
        await this.persist()
        break
      }
      case 'reveal': {
        const result = applyReveal(
          this.room,
          {
            seatId,
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
