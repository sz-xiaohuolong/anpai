/**
 * 房间 WebSocket 客户端。
 *
 * 设计前提：**断线是常态，不是异常**。手机上切后台等于断线
 * （iOS Safari 会挂起页面并掐断 WebSocket），因此重连是主路径。
 * 见 docs/game-architecture-v1.md §7。
 */

import { normalizeLog } from '../core/log.ts'
import type { GameEvent } from '../core/types.ts'
import type { ClientMessage, ConnectionStatus, ServerMessage } from './protocol.ts'

export interface RoomClientHandlers {
  onLog?: (events: readonly GameEvent[]) => void
  onEvent?: (event: GameEvent) => void
  onStatus?: (status: ConnectionStatus) => void
}

export interface RoomClientOptions {
  url: string
  seatId: string
  nickname: string
  handlers?: RoomClientHandlers
}

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 8_000

export class RoomClient {
  private socket: WebSocket | null = null
  private status: ConnectionStatus = 'idle'
  private attempt = 0
  private closedByUser = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private events: GameEvent[] = []

  constructor(private readonly options: RoomClientOptions) {}

  getStatus(): ConnectionStatus {
    return this.status
  }

  /** 当前已知的完整日志。重连后由服务器下发全量覆盖。 */
  getEvents(): readonly GameEvent[] {
    return this.events
  }

  connect(): void {
    this.closedByUser = false
    this.open()
  }

  close(): void {
    this.closedByUser = true
    this.clearTimer()
    this.socket?.close()
    this.socket = null
    this.setStatus('closed')
  }

  sendReady(ready: boolean): void {
    this.send({ t: 'ready', ready })
  }

  sendCommit(round: number, commit: string): void {
    this.send({ t: 'commit', round, commit })
  }

  sendReveal(round: number, slotIndex: number, nonceHex: string): void {
    this.send({ t: 'reveal', round, slotIndex, nonceHex })
  }

  private open(): void {
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting')
    const socket = new WebSocket(this.options.url)
    this.socket = socket

    socket.addEventListener('open', () => {
      this.attempt = 0
      this.setStatus('open')
      this.send({ t: 'hello', seatId: this.options.seatId, nickname: this.options.nickname })
    })

    socket.addEventListener('message', (event) => {
      this.handleMessage(typeof event.data === 'string' ? event.data : '')
    })

    socket.addEventListener('close', () => {
      if (this.closedByUser) return
      this.scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      // close 事件随后会到，这里不重复处理。
    })
  }

  private handleMessage(raw: string): void {
    let message: ServerMessage
    try {
      message = JSON.parse(raw) as ServerMessage
    } catch {
      return
    }

    if (message.t === 'welcome') {
      // 服务器下发的是权威全量日志，直接覆盖本地。
      this.events = [...message.log]
      this.options.handlers?.onLog?.(this.events)
      return
    }

    if (message.t === 'event') {
      this.events.push(message.event)
      this.options.handlers?.onEvent?.(message.event)
      return
    }

    // error：不打断连接，交由上层决定如何提示。
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(message))
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return
    this.clearTimer()
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS)
    this.attempt += 1
    this.setStatus('reconnecting')
    this.timer = setTimeout(() => this.open(), delay)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return
    this.status = status
    this.options.handlers?.onStatus?.(status)
  }
}

/** 服务器下发的全量日志可能含缺口；调用方据此决定是否等待补齐。 */
export function gapsIn(events: readonly GameEvent[]): readonly { from: number; to: number }[] {
  return normalizeLog(events).gaps
}
