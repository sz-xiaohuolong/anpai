import { describe, expect, it } from 'vitest'
import {
  COMMIT_WINDOW_MS,
  MAX_VALUE_SPREAD,
  REVEAL_WINDOW_MS,
  ROUNDS,
  SLOT_VALUES,
  slotCount,
  slotValues,
  valueSpread,
} from '../src/core/values.ts'
import { MAX_PLAYERS, MIN_PLAYERS } from '../src/core/types.ts'

describe('数值表', () => {
  it('覆盖 3–5 人', () => {
    expect(Object.keys(SLOT_VALUES).map(Number).sort()).toEqual([3, 4, 5])
  })

  it('位置数 = 人数 × 2', () => {
    for (const count of [3, 4, 5]) {
      expect(slotValues(count)).toHaveLength(slotCount(count))
    }
  })

  /**
   * 这是硬约束：极差超过 2.0× 会出现「均衡概率为 0」的死位。
   * 依据见 docs/game-balance-v1.md §1.2。
   */
  it('价值极差不超过上限', () => {
    for (const count of [3, 4, 5]) {
      const spread = valueSpread(slotValues(count))
      expect(spread, `${count} 人局极差 ${spread}`).toBeLessThanOrEqual(MAX_VALUE_SPREAD)
    }
  })

  it('数值全部为正整数', () => {
    for (const values of Object.values(SLOT_VALUES)) {
      for (const value of values) {
        expect(Number.isInteger(value)).toBe(true)
        expect(value).toBeGreaterThan(0)
      }
    }
  })

  it('不支持的人数会抛错', () => {
    expect(() => slotValues(2)).toThrow()
    expect(() => slotValues(6)).toThrow()
  })
})

describe('常量', () => {
  it('轮数为 8', () => {
    expect(ROUNDS).toBe(8)
  })

  it('人数区间为 3–5', () => {
    expect(MIN_PLAYERS).toBe(3)
    expect(MAX_PLAYERS).toBe(5)
  })

  it('提交时限长于揭示时限', () => {
    expect(COMMIT_WINDOW_MS).toBeGreaterThan(REVEAL_WINDOW_MS)
    expect(REVEAL_WINDOW_MS).toBeGreaterThan(0)
  })
})

describe('valueSpread', () => {
  it('计算最大值与最小值之比', () => {
    expect(valueSpread([4, 8])).toBe(2)
    expect(valueSpread([5, 5, 5])).toBe(1)
  })

  it('空数组返回 0', () => {
    expect(valueSpread([])).toBe(0)
  })
})
