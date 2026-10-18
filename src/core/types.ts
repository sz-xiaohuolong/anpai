/**
 * 《暗牌》核心事件模型。
 *
 * 本目录（src/core）必须是可在 Node 中直接运行的纯 TypeScript：
 * 不得 import Vue、DOM 或任何网络模块。见 AGENTS.md §6 硬约束 1。
 */

export type SeatId = string
export type SlotIndex = number

/** 服务器代发事件时使用的系统席位。 */
export const SYSTEM_SEAT: SeatId = 'system'

export interface EventBase {
  /** 服务器分配的单调递增序号，全局唯一，决定规范顺序。 */
  seq: number
  /** 服务器时间戳（毫秒）。仅用于协调与调试，不参与判定。 */
  ts: number
  /** 事件发起者。服务器代发的事件使用 SYSTEM_SEAT。 */
  author: SeatId
}

export type GameEvent =
  | (EventBase & {
      type: 'JOIN'
      payload: { nickname: string; seatId: SeatId; bot?: boolean }
    })
  | (EventBase & { type: 'LEAVE'; payload: { seatId: SeatId; reason: 'closed' | 'timeout' } })
  | (EventBase & { type: 'READY'; payload: { seatId: SeatId; ready: boolean } })
  | (EventBase & { type: 'ROUND_OPEN'; payload: { round: number; openedAt: number } })
  | (EventBase & { type: 'COMMIT'; payload: { round: number; commit: string } })
  | (EventBase & {
      type: 'REVEAL'
      payload: { round: number; slotIndex: SlotIndex; nonceHex: string }
    })
  | (EventBase & { type: 'ROUND_TIMEOUT'; payload: { round: number; phase: 'commit' | 'reveal' } })
  /** 一局结束后重开。project() 只从最后一条 GAME_RESET 之后开始投影。 */
  | (EventBase & { type: 'GAME_RESET'; payload: { at: number } })

export type GameEventType = GameEvent['type']

/** 开局所需的最少人数。 */
export const MIN_PLAYERS = 3
/** 本作支持的最多人数。 */
export const MAX_PLAYERS = 5
