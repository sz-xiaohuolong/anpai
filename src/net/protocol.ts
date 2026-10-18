/**
 * 客户端 ↔ 服务器消息协议。
 *
 * 只传「协调所需的最小信息」。服务器从始至终不知道任何人选了哪个位置：
 * COMMIT 里只有哈希，REVEAL 到达时已无法更改选择。
 */

import type { GameEvent } from '../core/types.ts'

export type ClientMessage =
  | { t: 'hello'; seatId: string; nickname: string }
  | { t: 'ready'; ready: boolean }
  | { t: 'commit'; round: number; commit: string; forSeat?: string }
  | { t: 'reveal'; round: number; slotIndex: number; nonceHex: string; forSeat?: string }
  | { t: 'addBot' }
  | { t: 'removeBot'; seatId: string }
  | { t: 'reset' }

export type ServerMessage =
  | { t: 'welcome'; seatId: string; log: GameEvent[] }
  | { t: 'event'; event: GameEvent }
  | { t: 'error'; code: 'bad-message' | 'rejected'; message: string }

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

/**
 * PartyServer 的路由名：**绑定名的 kebab-case**。
 * 绑定为 `AnpaiRoom` → `anpai-room`。
 * 路由形如 `/parties/:server/:room`。
 */
export const PARTY_NAME = 'anpai-room'

/** 连接地址：`/parties/anpai-room/<房间码>`。 */
export function roomSocketUrl(origin: string, roomCode: string): string {
  const base = origin.replace(/^http/, 'ws').replace(/\/$/, '')
  return `${base}/parties/${PARTY_NAME}/${encodeURIComponent(roomCode)}`
}
