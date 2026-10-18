import { describe, expect, it } from 'vitest'
import { chooseSlot } from '../src/core/bot.ts'
import { project } from '../src/core/rules.ts'
import { THREE_SEATS, lobby } from './helpers.ts'

describe('机器人策略（写死的确定性规则）', () => {
  it('无历史拥挤时，选当前有效价值最高的位', () => {
    const log = lobby(THREE_SEATS)
    log.roundOpen(1)
    const state = project(log.events)
    // 3 人 6 格基础价值 4,4,5,6,7,8 → 最高是位 5
    expect(chooseSlot(state)).toBe(5)
  })

  it('上一轮被抢爆的位会被降权', () => {
    const log = lobby(THREE_SEATS)
    // 位 5 两人撞车、位 4 一人独占，位 0–3 空置
    log.playRound(1, { 's-a': 5, 's-b': 5, 's-c': 4 })
    log.roundOpen(2)

    const state = project(log.events)
    // 第 2 轮有效价值：位0=5 位1=5 位2=6 位3=7 位4=7 位5=8
    // 拥挤度：位5=2、位4=1
    // 位3 得 7/1=7，位5 只有 8/3≈2.67 → 应选位 3
    expect(chooseSlot(state)).toBe(3)
  })

  it('是确定性的：同一局面永远给同一个答案', () => {
    const log = lobby(THREE_SEATS)
    log.playRound(1, { 's-a': 0, 's-b': 1, 's-c': 2 })
    log.roundOpen(2)
    const state = project(log.events)
    expect(chooseSlot(state)).toBe(chooseSlot(state))
  })

  it('没有玩家时返回 null', () => {
    expect(chooseSlot(project([]))).toBeNull()
  })

  it('从不越界：返回值落在合法位置区间内', () => {
    for (let round = 1; round <= 4; round++) {
      const log = lobby(THREE_SEATS)
      for (let r = 1; r < round; r++) {
        log.playRound(r, { 's-a': 0, 's-b': 1, 's-c': 2 })
      }
      log.roundOpen(round)
      const state = project(log.events)
      const slot = chooseSlot(state)
      expect(slot).not.toBeNull()
      expect(slot!).toBeGreaterThanOrEqual(0)
      expect(slot!).toBeLessThan(6)
    }
  })
})
