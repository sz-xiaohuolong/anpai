import { describe, expect, it } from 'vitest'
import { chooseSlot } from '../src/core/bot.ts'
import { project } from '../src/core/rules.ts'
import { LogBuilder, THREE_SEATS, lobby } from './helpers.ts'

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

  it('是确定性的：同一输入永远给同一个答案', () => {
    const log = lobby(THREE_SEATS)
    log.playRound(1, { 's-a': 0, 's-b': 1, 's-c': 2 })
    log.roundOpen(2)
    const state = project(log.events)
    expect(chooseSlot(state, { reserved: [] })).toBe(chooseSlot(state, { reserved: [] }))
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

describe('机器人之间必须错开（回归）', () => {
  it('reserved 会改变选择——这是错开的机制', () => {
    const log = lobby(THREE_SEATS)
    log.roundOpen(1)
    const state = project(log.events)

    const first = chooseSlot(state, { reserved: [] })
    const second = chooseSlot(state, { reserved: [first!] })
    const third = chooseSlot(state, { reserved: [first!, second!] })

    expect(new Set([first, second, third]).size).toBe(3)
  })

  it('同一局面下不传 reserved，多个机器人会算出同一个位', () => {
    // 这正是必须先修掉的结构性问题：纯函数 + 同一份公开局面 = 同一个答案。
    const log = lobby(THREE_SEATS)
    log.roundOpen(1)
    const state = project(log.events)
    const a = chooseSlot(state)
    const b = chooseSlot(state)
    const c = chooseSlot(state)
    expect(new Set([a, b, c]).size).toBe(1)
  })

  it('1 真人 + 3 机器人打满 8 轮，机器人从不互撞', () => {
    const human = 's-human'
    const bots = ['bot-1', 'bot-2', 'bot-3']
    const log = new LogBuilder()
    log.join(human, '我')
    for (const bot of bots) log.joinBot(bot, bot)
    log.ready(human)
    for (const bot of bots) log.ready(bot)

    for (let round = 1; round <= 8; round++) {
      log.roundOpen(round)
      const state = project(log.events)

      const reserved: number[] = []
      const picks: Record<string, number> = { [human]: 0 }

      for (const bot of bots) {
        const slot = chooseSlot(state, { reserved })
        expect(slot, `第 ${round} 轮 ${bot} 没有给出选择`).not.toBeNull()
        reserved.push(slot!)
        picks[bot] = slot!
      }

      // 核心断言：同一轮内机器人各占一个不同的位置
      expect(new Set(reserved).size, `第 ${round} 轮机器人互撞：${reserved.join(',')}`).toBe(
        bots.length,
      )

      for (const seat of [human, ...bots]) log.commit(seat, round)
      for (const seat of [human, ...bots]) log.reveal(seat, round, picks[seat]!)
    }

    const final = project(log.events)
    expect(final.phase).toBe('GAME_OVER')
    // 机器人之间零碰撞 → 它们一次都不该被判罚
    for (const bot of bots) {
      const player = final.players.find((p) => p.seatId === bot)!
      expect(player.penalties, `${bot} 被罚了 ${player.penalties} 次`).toBe(0)
    }
  })
})
