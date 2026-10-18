/**
 * 参照对局：docs/game-rules-v1.md §8 那局 4 人 8 轮。
 *
 * 它同时被单元测试与开发页使用，作为「规则引擎真的能跑完整局」的可执行证据。
 * 该局由一次真实模拟生成，分数经算术校验：阿元 36 / 小北 29 / Kai 35 / 老周 41。
 *
 * 注意：这里的 commit 是占位字符串。project() 不做哈希校验——哈希校验属于
 * 日志准入层的完整性过滤，不属于游戏规则（见 docs/game-architecture-v1.md §3.3）。
 */

import type { GameEvent, SeatId } from './types.ts'

export const SAMPLE_SEATS = {
  yuan: 'seat-yuan',
  bei: 'seat-bei',
  kai: 'seat-kai',
  zhou: 'seat-zhou',
} as const satisfies Record<string, SeatId>

export const SAMPLE_NICKNAMES: Readonly<Record<SeatId, string>> = {
  [SAMPLE_SEATS.yuan]: '阿元',
  [SAMPLE_SEATS.bei]: '小北',
  [SAMPLE_SEATS.kai]: 'Kai',
  [SAMPLE_SEATS.zhou]: '老周',
}

/** 每轮每人的选择，索引与轮次一致（第 0 项为第 1 轮）。 */
const SAMPLE_PICKS: readonly Readonly<Record<SeatId, number>>[] = [
  { [SAMPLE_SEATS.yuan]: 6, [SAMPLE_SEATS.bei]: 7, [SAMPLE_SEATS.kai]: 5, [SAMPLE_SEATS.zhou]: 4 },
  { [SAMPLE_SEATS.yuan]: 3, [SAMPLE_SEATS.bei]: 6, [SAMPLE_SEATS.kai]: 3, [SAMPLE_SEATS.zhou]: 1 },
  { [SAMPLE_SEATS.yuan]: 4, [SAMPLE_SEATS.bei]: 4, [SAMPLE_SEATS.kai]: 6, [SAMPLE_SEATS.zhou]: 5 },
  { [SAMPLE_SEATS.yuan]: 6, [SAMPLE_SEATS.bei]: 6, [SAMPLE_SEATS.kai]: 0, [SAMPLE_SEATS.zhou]: 2 },
  { [SAMPLE_SEATS.yuan]: 4, [SAMPLE_SEATS.bei]: 5, [SAMPLE_SEATS.kai]: 5, [SAMPLE_SEATS.zhou]: 3 },
  { [SAMPLE_SEATS.yuan]: 5, [SAMPLE_SEATS.bei]: 1, [SAMPLE_SEATS.kai]: 6, [SAMPLE_SEATS.zhou]: 1 },
  { [SAMPLE_SEATS.yuan]: 4, [SAMPLE_SEATS.bei]: 2, [SAMPLE_SEATS.kai]: 6, [SAMPLE_SEATS.zhou]: 1 },
  { [SAMPLE_SEATS.yuan]: 6, [SAMPLE_SEATS.bei]: 0, [SAMPLE_SEATS.kai]: 4, [SAMPLE_SEATS.zhou]: 4 },
]

/** 该局预期最终分数。 */
export const SAMPLE_EXPECTED_SCORES: Readonly<Record<SeatId, number>> = {
  [SAMPLE_SEATS.yuan]: 36,
  [SAMPLE_SEATS.bei]: 29,
  [SAMPLE_SEATS.kai]: 35,
  [SAMPLE_SEATS.zhou]: 41,
}

/** 该局预期被罚次数：阿元 3 / 小北 4 / Kai 3 / 老周 2。 */
export const SAMPLE_EXPECTED_PENALTIES: Readonly<Record<SeatId, number>> = {
  [SAMPLE_SEATS.yuan]: 3,
  [SAMPLE_SEATS.bei]: 4,
  [SAMPLE_SEATS.kai]: 3,
  [SAMPLE_SEATS.zhou]: 2,
}

const BASE_TS = 1_700_000_000_000
const SEAT_ORDER: readonly SeatId[] = [
  SAMPLE_SEATS.yuan,
  SAMPLE_SEATS.bei,
  SAMPLE_SEATS.kai,
  SAMPLE_SEATS.zhou,
]

/** 构造参照对局的完整事件日志（seq 从 1 开始连续，无缺口）。 */
export function sampleGameLog(): GameEvent[] {
  const events: GameEvent[] = []
  let seq = 0

  const push = (author: SeatId, event: Omit<GameEvent, 'seq' | 'ts' | 'author'>) => {
    seq += 1
    events.push({ ...event, seq, ts: BASE_TS + seq, author } as GameEvent)
  }

  for (const seatId of SEAT_ORDER) {
    push(seatId, { type: 'JOIN', payload: { nickname: SAMPLE_NICKNAMES[seatId]!, seatId } })
  }
  for (const seatId of SEAT_ORDER) {
    push(seatId, { type: 'READY', payload: { seatId, ready: true } })
  }

  for (let index = 0; index < SAMPLE_PICKS.length; index++) {
    const round = index + 1
    const openedAt = BASE_TS + 1000 * round
    push('system', { type: 'ROUND_OPEN', payload: { round, openedAt } })

    const picks = SAMPLE_PICKS[index]!
    for (const seatId of SEAT_ORDER) {
      push(seatId, {
        type: 'COMMIT',
        payload: { round, commit: `placeholder-${seatId}-${round}` },
      })
    }
    for (const seatId of SEAT_ORDER) {
      push(seatId, {
        type: 'REVEAL',
        payload: { round, slotIndex: picks[seatId]!, nonceHex: '0'.repeat(32) },
      })
    }
  }

  return events
}
