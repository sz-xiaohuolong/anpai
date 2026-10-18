import type { GameEvent, SeatId } from '../src/core/types.ts'

export const BASE_TS = 1_700_000_000_000

/** 事件日志构造器。seq 从 1 开始连续，因此默认无缺口。 */
export class LogBuilder {
  private seq = 0
  readonly events: GameEvent[] = []

  private push<T extends GameEvent['type']>(
    author: SeatId,
    type: T,
    payload: Extract<GameEvent, { type: T }>['payload'],
  ): this {
    this.seq += 1
    this.events.push({
      seq: this.seq,
      ts: BASE_TS + this.seq,
      author,
      type,
      payload,
    } as GameEvent)
    return this
  }

  join(seatId: SeatId, nickname = seatId): this {
    return this.push(seatId, 'JOIN', { nickname, seatId })
  }

  ready(seatId: SeatId, ready = true): this {
    return this.push(seatId, 'READY', { seatId, ready })
  }

  roundOpen(round: number, openedAt = BASE_TS + round * 1000): this {
    return this.push('system', 'ROUND_OPEN', { round, openedAt })
  }

  commit(seatId: SeatId, round: number, commit = `c-${seatId}-${round}`): this {
    return this.push(seatId, 'COMMIT', { round, commit })
  }

  reveal(seatId: SeatId, round: number, slotIndex: number, nonceHex = '0'.repeat(32)): this {
    return this.push(seatId, 'REVEAL', { round, slotIndex, nonceHex })
  }

  gameReset(): this {
    return this.push('system', 'GAME_RESET', { at: BASE_TS })
  }

  timeout(round: number, phase: 'commit' | 'reveal'): this {
    return this.push('system', 'ROUND_TIMEOUT', { round, phase })
  }

  /** 完整走一轮：开局 → 全员提交 → 全员揭示。 */
  playRound(round: number, picks: Readonly<Record<SeatId, number>>): this {
    this.roundOpen(round)
    const seats = Object.keys(picks)
    for (const seatId of seats) this.commit(seatId, round)
    for (const seatId of seats) this.reveal(seatId, round, picks[seatId]!)
    return this
  }
}

export const FOUR_SEATS: readonly SeatId[] = ['s-a', 's-b', 's-c', 's-d']
export const THREE_SEATS: readonly SeatId[] = ['s-a', 's-b', 's-c']
export const FIVE_SEATS: readonly SeatId[] = ['s-a', 's-b', 's-c', 's-d', 's-e']

/** 建立一个已准备就绪的房间（未开局）。 */
export function lobby(seats: readonly SeatId[]): LogBuilder {
  const log = new LogBuilder()
  for (const seatId of seats) log.join(seatId, seatId.toUpperCase())
  for (const seatId of seats) log.ready(seatId)
  return log
}

/** 打乱事件顺序（用于验证投影与到达顺序无关）。 */
export function shuffled<T>(items: readonly T[], seed = 42): T[] {
  const out = [...items]
  let state = seed
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}
