import { describe, expect, it } from 'vitest'
import { chooseSlot, equilibriumProbabilities } from '../src/core/bot.ts'
import { project } from '../src/core/rules.ts'
import { LogBuilder, THREE_SEATS, lobby } from './helpers.ts'

/**
 * 三张基础价值表的静态均衡概率，取自 `docs/game-balance-v1.md` §2.2。
 * 文档给的是闭式解、精确到 0.1 个百分点，因此这里按「四舍五入到 1 位小数的百分数」
 * 逐位断言——三张表都钉住，避免只保住 4 人局、3/5 人局悄悄算错。
 */
const EQUILIBRIUM_TABLES = [
  {
    label: '3 人 6 格',
    values: [4, 4, 5, 6, 7, 8],
    players: 3,
    expectedPercent: [3.4, 3.4, 13.6, 21.1, 26.9, 31.7],
  },
  {
    label: '4 人 8 格',
    values: [4, 4, 5, 5, 6, 6, 7, 8],
    players: 4,
    expectedPercent: [3.1, 3.1, 10.1, 10.1, 15.4, 15.4, 19.6, 23.1],
  },
  {
    label: '5 人 10 格',
    values: [4, 4, 5, 5, 5, 6, 6, 6, 7, 8],
    players: 5,
    expectedPercent: [2.8, 2.8, 8.1, 8.1, 8.1, 12.2, 12.2, 12.2, 15.5, 18.3],
  },
] as const

/** 4 人 8 格基础价值下的均衡概率（抽样器无偏性断言的参照）。 */
const EQUILIBRIUM_4P = EQUILIBRIUM_TABLES[1].expectedPercent.map((percent) => percent / 100)

function fourBotState() {
  const log = new LogBuilder()
  for (const seat of ['bot-1', 'bot-2', 'bot-3', 'bot-4']) {
    log.joinBot(seat, seat)
    log.ready(seat)
  }
  log.roundOpen(1)
  return project(log.events)
}

/**
 * 模拟 N 局「4 人 8 格 8 轮」。每局用不同房间码，因此每局都是独立抽样。
 * 全程确定性，所以结果是固定值，断言可以收紧而不会 flaky。
 */
function simulateFourBots(games: number) {
  let collisionRounds = 0
  let totalRounds = 0
  const penalties: number[] = []
  /** 每个玩家每局的 8 轮总分。 */
  const totals: number[] = []

  for (let game = 0; game < games; game++) {
    const room = `SIM${game.toString(36).toUpperCase()}`
    const seats = ['bot-1', 'bot-2', 'bot-3', 'bot-4']
    const log = new LogBuilder()
    for (const seat of seats) {
      log.joinBot(seat, seat)
      log.ready(seat)
    }

    const gameTotal = new Map<string, number>(seats.map((seat) => [seat, 0]))

    for (let round = 1; round <= 8; round++) {
      log.roundOpen(round)
      const state = project(log.events)
      const picks = seats.map((seat) => chooseSlot(state, { seatId: seat, roomCode: room })!)
      const counts = new Map<number, number>()
      for (const slot of picks) counts.set(slot, (counts.get(slot) ?? 0) + 1)

      let collided = false
      picks.forEach((slot, index) => {
        const seat = seats[index]!
        if ((counts.get(slot) ?? 0) >= 2) {
          collided = true
          penalties.push(1)
        } else {
          penalties.push(0)
          gameTotal.set(seat, (gameTotal.get(seat) ?? 0) + state.rounds[round - 1]!.effective[slot]!)
        }
      })
      if (collided) collisionRounds++
      totalRounds++

      for (const seat of seats) log.commit(seat, round)
      seats.forEach((seat, index) => log.reveal(seat, round, picks[index]!))
    }

    for (const seat of seats) totals.push(gameTotal.get(seat) ?? 0)
  }

  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
  return {
    collisionRate: collisionRounds / totalRounds,
    penaltyRate: mean(penalties),
    meanTotalScore: mean(totals),
  }
}

describe('均衡概率', () => {
  it.each(EQUILIBRIUM_TABLES)('$label 与文档 §2.2 的分析结果一致', ({ values, players, expectedPercent }) => {
    const p = equilibriumProbabilities(values, players)
    p.forEach((value, index) => {
      expect(+(value * 100).toFixed(1), `slot ${index}`).toBe(expectedPercent[index])
    })
  })

  it('三张表都没有死位（均衡概率为 0 的位置）', () => {
    for (const { label, values, players } of EQUILIBRIUM_TABLES) {
      const p = equilibriumProbabilities(values, players)
      expect(p.filter((value) => value <= 1e-9), `${label} 出现死位`).toEqual([])
    }
  })

  it('概率之和为 1，且全部非负', () => {
    for (const { values, players } of EQUILIBRIUM_TABLES) {
      const p = equilibriumProbabilities(values, players)
      expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
      expect(p.every((value) => value >= 0)).toBe(true)
    }
  })

  it('价值越高被选概率越大', () => {
    const p = equilibriumProbabilities([4, 4, 5, 5, 6, 6, 7, 8], 4)
    // 8 分位应高于 7 分位，7 分位高于 6 分位
    expect(p[7]!).toBeGreaterThan(p[6]!)
    expect(p[6]!).toBeGreaterThan(p[4]!)
  })

  it('只有一个人时不撞车，均匀分布', () => {
    const p = equilibriumProbabilities([4, 4, 5, 5], 1)
    expect(p).toEqual([0.25, 0.25, 0.25, 0.25])
  })
})

describe('抽样器', () => {
  it('无偏：大量不同席位的落点分布逼近均衡概率', () => {
    const state = fourBotState()
    const histogram = new Array(8).fill(0)
    const samples = 24000
    for (let index = 0; index < samples; index++) {
      histogram[chooseSlot(state, { seatId: `bot-${index}`, roomCode: 'BIAS' })!]++
    }
    const observed = histogram.map((count) => count / samples)
    observed.forEach((value, slot) => {
      // 24000 次抽样的 3σ 约 0.01，留一倍余量
      expect(Math.abs(value - EQUILIBRIUM_4P[slot]!), `slot ${slot}`).toBeLessThan(0.02)
    })
  })

  it('确定性：同一（房间, 席位, 轮次）永远给同一个位置', () => {
    const state = fourBotState()
    const a = chooseSlot(state, { seatId: 'bot-1', roomCode: 'DET' })
    const b = chooseSlot(state, { seatId: 'bot-1', roomCode: 'DET' })
    expect(a).toBe(b)
  })

  it('不同房间码会给出不同落点（证明种子确实随房间变化）', () => {
    const state = fourBotState()
    const patterns = new Set<string>()
    for (let index = 0; index < 40; index++) {
      const room = `SEED${index}`
      patterns.add(
        ['bot-1', 'bot-2', 'bot-3', 'bot-4']
          .map((seat) => chooseSlot(state, { seatId: seat, roomCode: room }))
          .join(','),
      )
    }
    expect(patterns.size).toBeGreaterThan(5)
  })

  it('没有玩家时返回 null', () => {
    expect(chooseSlot(project([]))).toBeNull()
  })

  it('返回值始终落在合法区间内', () => {
    const log = lobby(THREE_SEATS)
    log.roundOpen(1)
    const state = project(log.events)
    for (let index = 0; index < 200; index++) {
      const slot = chooseSlot(state, { seatId: `bot-${index}`, roomCode: 'RANGE' })
      expect(slot).not.toBeNull()
      expect(slot!).toBeGreaterThanOrEqual(0)
      expect(slot!).toBeLessThan(6)
    }
  })
})

/**
 * 公平性回归。这里同时挡住两种失败模式：
 *   - 「永远互撞」：早期版本各自挑最高分，撞车率 100%
 *   - 「永不互撞」：后来改成依次避让，机器人完美协同，真人独自承担所有撞车
 * 真人基线（docs/game-balance-v1.md）：撞车率 69.1%、单人每轮被罚 40.3%。
 */
describe('公平性（回归）', () => {
  const result = simulateFourBots(600)

  it('回合级撞车率落在真人区间，既不永远撞也不永不撞', () => {
    expect(result.collisionRate).toBeGreaterThan(0.55)
    expect(result.collisionRate).toBeLessThan(0.82)
  })

  it('单人每轮被罚率落在真人区间', () => {
    expect(result.penaltyRate).toBeGreaterThan(0.28)
    expect(result.penaltyRate).toBeLessThan(0.52)
  })

  it('人均 8 轮总分处于合理量级（既非人人满分，也非人人零分）', () => {
    // 若永不撞车，人均接近 8 轮满额约 44；若总是撞车则接近 0。
    // 真人基线（docs/game-balance-v1.md）人均约 35。
    expect(result.meanTotalScore).toBeGreaterThan(24)
    expect(result.meanTotalScore).toBeLessThan(44)
  })
})
