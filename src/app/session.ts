/**
 * 会话：昵称、席位令牌与席位 ID 的本地持久化。
 *
 * 身份绑定 seatToken 而不是昵称，因此昵称可以重复。
 * 见 docs/game-architecture-v1.md §6。
 */

import { deriveSeatId, randomSeatToken } from '../core/crypto.ts'

const SEAT_TOKEN_KEY = 'anpai:seatToken'
const NICKNAME_KEY = 'anpai:nickname'

let cachedSeatId: string | null = null

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 隐私模式下可能不可写；退化为本次会话内有效。
  }
}

function getSeatToken(): string {
  const existing = read(SEAT_TOKEN_KEY)
  if (existing) return existing
  const token = randomSeatToken()
  write(SEAT_TOKEN_KEY, token)
  return token
}

/** 稳定席位 ID：同一浏览器、同一 localStorage 下始终相同。 */
export async function getSeatId(): Promise<string> {
  if (cachedSeatId) return cachedSeatId
  cachedSeatId = await deriveSeatId(getSeatToken())
  return cachedSeatId
}

export function getNickname(): string {
  return read(NICKNAME_KEY) ?? ''
}

export function setNickname(nickname: string): void {
  write(NICKNAME_KEY, nickname.trim())
}

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 生成房间码：去掉易混淆的 I/O/0/1。 */
export function randomRoomCode(length = 6): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) {
    out += ROOM_ALPHABET[byte % ROOM_ALPHABET.length]
  }
  return out
}

/** 校验并规范化房间码。 */
export function normalizeRoomCode(raw: string): string | null {
  const code = raw.trim().toUpperCase()
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return null
  return code
}

/** 邀请链接：直接指向房间页。 */
export function inviteUrl(roomCode: string): string {
  return `${location.origin}/room/${roomCode}`
}
