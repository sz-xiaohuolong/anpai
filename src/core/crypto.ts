/**
 * commit-reveal 密码学原语。
 *
 * 规范编码（必须逐字节一致，绑定房间与席位以防跨房间/跨玩家重放）：
 *
 *   commit = SHA-256( UTF8( roomCode + "|" + round + "|" + seatId + "|" + slotIndex + "|" + nonceHex ) )
 *
 * 见 docs/game-architecture-v1.md §5。测试向量同 §5.2。
 *
 * 为什么这些函数是 async：使用平台 WebCrypto，不自行实现哈希算法。
 * 它们**不参与** project() 的判定——哈希校验是日志准入层的完整性过滤，
 * 不是游戏规则。见 docs/game-architecture-v1.md §3.3。
 */

import type { SeatId, SlotIndex } from './types.ts'

export interface CommitInput {
  roomCode: string
  round: number
  seatId: SeatId
  slotIndex: SlotIndex
  nonceHex: string
}

/** nonce 的十六进制字符数（16 字节）。 */
export const NONCE_HEX_LENGTH = 32

export function canonicalCommitString(input: CommitInput): string {
  return `${input.roomCode}|${input.round}|${input.seatId}|${input.slotIndex}|${input.nonceHex}`
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0')
  }
  return out
}

/** 计算承诺哈希，返回小写十六进制。 */
export async function commitOf(input: CommitInput): Promise<string> {
  const data = new TextEncoder().encode(canonicalCommitString(input))
  const digest = await crypto.subtle.digest('SHA-256', data)
  return toHex(new Uint8Array(digest))
}

/** 生成 16 字节随机 nonce 的小写十六进制表示。 */
export function randomNonceHex(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}

/** 生成 16 字节随机席位令牌（存入 localStorage，明文永不进日志）。 */
export function randomSeatToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}

/**
 * 由席位令牌派生公开席位 ID。
 *
 * 日志里只出现 seatId，绝不出现 seatToken —— 否则任何人都能冒用他人席位。
 * 见 docs/game-architecture-v1.md §6。
 */
export async function deriveSeatId(seatToken: string): Promise<string> {
  const data = new TextEncoder().encode(`anpai-seat:${seatToken}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return `seat-${toHex(new Uint8Array(digest)).slice(0, 16)}`
}

/** nonce 必须是 32 位小写十六进制。 */
export function isValidNonceHex(nonceHex: string): boolean {
  return new RegExp(`^[0-9a-f]{${NONCE_HEX_LENGTH}}$`).test(nonceHex)
}

/**
 * 校验一次揭示是否与承诺一致。
 *
 * 该函数是日志准入层的完整性过滤：不一致的 REVEAL 不得进入日志。
 * 若它已进入日志（例如某个改过的客户端强行广播），所有客户端会做出
 * 同一判断并同样地丢弃它，因此投影结果仍一致。
 */
export async function verifyReveal(
  commit: string,
  reveal: { round: number; slotIndex: SlotIndex; nonceHex: string },
  context: { roomCode: string; seatId: SeatId },
): Promise<boolean> {
  if (!isValidNonceHex(reveal.nonceHex)) return false
  const expected = await commitOf({
    roomCode: context.roomCode,
    round: reveal.round,
    seatId: context.seatId,
    slotIndex: reveal.slotIndex,
    nonceHex: reveal.nonceHex,
  })
  return expected === commit
}
