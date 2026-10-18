/**
 * 位置基础价值与时间常量。
 *
 * 数值来源：docs/game-rules-v1.md §3。
 * 硬约束：价值极差必须 ≤ MAX_VALUE_SPREAD，否则会出现「均衡概率为 0」的死位。
 * 依据见 docs/game-balance-v1.md §1.2。
 */

/** 位置基础价值表，键为玩家人数。 */
export const SLOT_VALUES: Readonly<Record<number, readonly number[]>> = Object.freeze({
  3: Object.freeze([4, 4, 5, 6, 7, 8]),
  4: Object.freeze([4, 4, 5, 5, 6, 6, 7, 8]),
  5: Object.freeze([4, 4, 5, 5, 5, 6, 6, 6, 7, 8]),
})

/** 一局固定轮数。 */
export const ROUNDS = 8

/** 价值极差上限。超过它会出现死位。 */
export const MAX_VALUE_SPREAD = 2.0

/** 提交时限（毫秒），自 ROUND_OPEN.openedAt 起算。 */
export const COMMIT_WINDOW_MS = 30_000

/** 揭示时限（毫秒），自提交截止起算。 */
export const REVEAL_WINDOW_MS = 15_000

export function slotValues(playerCount: number): readonly number[] {
  const values = SLOT_VALUES[playerCount]
  if (!values) {
    throw new Error(`不支持的人数：${playerCount}（支持 3–5 人）`)
  }
  return values
}

/** 位置数 = 人数 × 2。 */
export function slotCount(playerCount: number): number {
  return playerCount * 2
}

/** 价值极差 = 最大值 / 最小值。 */
export function valueSpread(values: readonly number[]): number {
  if (values.length === 0) return 0
  return Math.max(...values) / Math.min(...values)
}
