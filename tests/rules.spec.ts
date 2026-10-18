import { describe, expect, it } from 'vitest'
import { project } from '../src/core/rules.ts'
import { FOUR_SEATS, LogBuilder, THREE_SEATS, lobby } from './helpers.ts'

/** 4 人局基础价值：slot0=4 slot1=4 slot2=5 slot3=5 slot4=6 slot5=6 slot6=7 slot7=8 */
const V4 = [4, 4, 5, 5, 6, 6, 7, 8] as const

function scores(log: LogBuilder): Record<string, number> {
  const state = project(log.events)
  return Object.fromEntries(state.players.map((p) => [p.seatId, p.score]))
}

function bountyOf(log: LogBuilder, roundIndex: number): readonly number[] {
  return project(log.events).rounds[roundIndex]!.bountyAfter
}

describe('结算：独占与撞车', () => {
  it('独占一个位置 → 拿走该位置的基础价值', () => {
    const log = lobby(FOUR_SEATS)
    log.playRound(1, { 's-a': 0, 's-b': 1, 's-c': 2, 's-d': 3 })
    expect(scores(log)).toEqual({ 's-a': V4[0], 's-b': V4[1], 's-c': V4[2], 's-d': V4[3] })
  })

  it('2 人选同一位置 → 两人各得 0，且不影响他人', () => {
    const log = lobby(FOUR_SEATS)
    log.playRound(1, { 's-a': 0, 's-b': 0, 's-c': 2, 's-d': 3 })
    expect(scores(log)).toEqual({ 's-a': 0, 's-b': 0, 's-c': V4[2], 's-d': V4[3] })
  })

  it('3 人选同一位置 → 三人各得 0', () => {
    const log = lobby(FOUR_SEATS)
    log.playRound(1, { 's-a': 0, 's-b': 0, 's-c': 0, 's-d': 3 })
    expect(scores(log)).toEqual({ 's-a': 0, 's-b': 0, 's-c': 0, 's-d': V4[3] })
  })

  it('撞车不扣分，只记一次被罚', () => {
    const log = lobby(FOUR_SEATS)
    log.playRound(1, { 's-a': 0, 's-b': 0, 's-c': 2, 's-d': 3 })
    const state = project(log.events)
    const a = state.players.find((p) => p.seatId === 's-a')!
    expect(a.score).toBe(0)
    expect(a.penalties).toBe(1)
  })
})

describe('赏金', () => {
  it('无人选择的位置 → 赏金 +1', () => {
    const log = lobby(FOUR_SEATS)
    log.playRound(1, { 's-a': 0, 's-b': 1, 's-c': 2, 's-d': 3 })
    // slot0-3 被取走 → 归零；slot4-7 空置 → +1
    expect(bountyOf(log, 0)).toEqual([0, 0, 0, 0, 1, 1, 1, 1])
  })

  it('独占时拿走「基础价值 + 累积赏金」', () => {
    const log = lobby(FOUR_SEATS)
    log.playRound(1, { 's-a': 0, 's-b': 1, 's-c': 2, 's-d': 3 }) // slot4 空置 → 赏金 1
    log.playRound(2, { 's-a': 4, 's-b': 1, 's-c': 2, 's-d': 3 }) // slot4 有效价值 = 6 + 1
    expect(scores(log)['s-a']).toBe(V4[0] + V4[4] + 1)
  })

  it('连续两轮无人选择 → 赏金累加为 +2（不是重置为 1）', () => {
    const log = lobby(FOUR_SEATS)
    log.playRound(1, { 's-a': 0, 's-b': 1, 's-c': 2, 's-d': 3 })
    log.playRound(2, { 's-a': 0, 's-b': 1, 's-c': 2, 's-d': 3 })
    expect(bountyOf(log, 1)[7]).toBe(2)
  })

  it('赏金被独占取走后归零', () => {
    const log = lobby(FOUR_SEATS)
    log.playRound(1, { 's-a': 0, 's-b': 1, 's-c': 2, 's-d': 3 })
    log.playRound(2, { 's-a': 0, 's-b': 1, 's-c': 2, 's-d': 3 })
    expect(bountyOf(log, 1)[7]).toBe(2)
    log.playRound(3, { 's-a': 7, 's-b': 1, 's-c': 2, 's-d': 3 })
    expect(bountyOf(log, 2)[7]).toBe(0)
    expect(scores(log)['s-a']).toBe(V4[0] * 2 + V4[7] + 2)
  })

  it('撞车后赏金保留且不增长', () => {
    const log = lobby(FOUR_SEATS)
    log.playRound(1, { 's-a': 0, 's-b': 1, 's-c': 2, 's-d': 3 }) // slot7 空置 → 1
    expect(bountyOf(log, 0)[7]).toBe(1)
    log.playRound(2, { 's-a': 7, 's-b': 7, 's-c': 2, 's-d': 3 }) // 撞车
    expect(bountyOf(log, 1)[7]).toBe(1) // 既没归零，也没涨到 2
    expect(scores(log)['s-a']).toBe(V4[0])
    expect(scores(log)['s-b']).toBe(V4[1])
  })
})

describe('弃权与超时', () => {
  it('提交了但未揭示 → 弃权，得 0 且不占位置（该位置因此可能 +1 赏金）', () => {
    const log = lobby(FOUR_SEATS)
    log.roundOpen(1)
    for (const seatId of FOUR_SEATS) log.commit(seatId, 1)
    // 只有 c、d 揭示；a、b 不揭示
    log.reveal('s-c', 1, 2)
    log.reveal('s-d', 1, 3)
    log.timeout(1, 'reveal')

    const state = project(log.events)
    expect(state.rounds[0]!.settled).toBe(true)
    expect(state.rounds[0]!.picks['s-a']).toBeNull()
    expect(state.rounds[0]!.picks['s-b']).toBeNull()
    // slot0、slot1 因 a、b 弃权而空置 → 赏金 +1
    expect(state.rounds[0]!.bountyAfter[0]).toBe(1)
    expect(state.rounds[0]!.bountyAfter[1]).toBe(1)
    expect(scores(log)).toEqual({ 's-a': 0, 's-b': 0, 's-c': V4[2], 's-d': V4[3] })
  })

  it('零提交的轮次也能合法推进，全员弃权', () => {
    const log = lobby(FOUR_SEATS)
    log.roundOpen(1)
    log.timeout(1, 'commit')

    const state = project(log.events)
    expect(state.rounds[0]!.settled).toBe(true)
    expect(state.rounds[0]!.committed).toEqual([])
    expect(state.rounds[0]!.bountyAfter).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
    expect(state.players.every((p) => p.score === 0)).toBe(true)
  })

  it('承诺不可覆盖：同一轮的第二条 COMMIT 被忽略', () => {
    const log = lobby(FOUR_SEATS)
    log.roundOpen(1)
    log.commit('s-a', 1, 'first')
    log.commit('s-a', 1, 'second')
    const state = project(log.events)
    expect(state.rounds[0]!.committed).toEqual(['s-a'])
  })
})

describe('阶段推进', () => {
  it('未开局时停在 LOBBY', () => {
    const log = lobby(FOUR_SEATS)
    expect(project(log.events).phase).toBe('LOBBY')
  })

  it('人数不足时停在 LOBBY', () => {
    const log = new LogBuilder()
    log.join('s-a', 'A')
    log.join('s-b', 'B')
    log.roundOpen(1)
    expect(project(log.events).phase).toBe('LOBBY')
  })

  it('未收齐提交时为 COMMITTING，收齐后为 REVEALING', () => {
    const log = lobby(FOUR_SEATS)
    log.roundOpen(1)
    log.commit('s-a', 1)
    expect(project(log.events).phase).toBe('COMMITTING')
    log.commit('s-b', 1)
    log.commit('s-c', 1)
    log.commit('s-d', 1)
    expect(project(log.events).phase).toBe('REVEALING')
  })

  it('刚开局的回合（零提交、未超时）不算已结算', () => {
    // 回归测试：零提交时「全员已揭示」曾是空真，导致回合刚开始就被判结束。
    const log = lobby(THREE_SEATS)
    log.roundOpen(1)
    const state = project(log.events)
    expect(state.rounds[0]!.settled).toBe(false)
    expect(state.phase).toBe('COMMITTING')
  })

  it('全部揭示后该轮 settled', () => {
    const log = lobby(FOUR_SEATS)
    log.playRound(1, { 's-a': 0, 's-b': 1, 's-c': 2, 's-d': 3 })
    expect(project(log.events).rounds[0]!.settled).toBe(true)
  })

  it('打满 8 轮后进入 GAME_OVER', () => {
    const log = lobby(FOUR_SEATS)
    for (let r = 1; r <= 8; r++) {
      log.playRound(r, { 's-a': 0, 's-b': 1, 's-c': 2, 's-d': 3 })
    }
    const state = project(log.events)
    expect(state.phase).toBe('GAME_OVER')
    expect(state.rounds).toHaveLength(8)
  })
})

describe('再来一局：project 只投影最后一条 GAME_RESET 之后', () => {
  it('第二局从第 1 轮重新开始，不带上一局的分数与轮次', () => {
    const log = lobby(THREE_SEATS)
    for (let r = 1; r <= 8; r++) log.playRound(r, { 's-a': 0, 's-b': 1, 's-c': 2 })
    const firstGame = project(log.events)
    expect(firstGame.phase).toBe('GAME_OVER')
    expect(firstGame.rounds).toHaveLength(8)

    log.gameReset()
    for (const seatId of THREE_SEATS) log.join(seatId, seatId.toUpperCase())
    log.playRound(1, { 's-a': 1, 's-b': 2, 's-c': 0 })

    const secondGame = project(log.events)
    expect(secondGame.rounds).toHaveLength(1)
    expect(secondGame.round).toBe(1)
    expect(secondGame.phase).not.toBe('GAME_OVER')
    // 3 人 6 格：位 1=4、位 2=5、位 0=4，各独占一次
    expect(Object.fromEntries(secondGame.players.map((p) => [p.seatId, p.score]))).toEqual({
      's-a': 4,
      's-b': 5,
      's-c': 4,
    })
  })
})

describe('机器人席位', () => {
  it('JOIN 带 bot 标记时，PlayerState.bot 为 true', () => {
    const log = lobby(THREE_SEATS)
    log.joinBot('bot-1', '机器人1')
    log.roundOpen(1)
    const state = project(log.events)
    const bot = state.players.find((p) => p.seatId === 'bot-1')!
    expect(bot.bot).toBe(true)
    expect(state.players.filter((p) => p.bot)).toHaveLength(1)
    // 真人席位不应被误标
    expect(state.players.filter((p) => !p.bot)).toHaveLength(3)
  })
})

describe('人数与位置数', () => {
  it('3 人局用 6 个位置的基础价值表', () => {
    const log = lobby(THREE_SEATS)
    log.playRound(1, { 's-a': 0, 's-b': 1, 's-c': 2 })
    const state = project(log.events)
    expect(state.rounds[0]!.baseValues).toEqual([4, 4, 5, 6, 7, 8])
    expect(state.rounds[0]!.bountyAfter).toHaveLength(6)
  })
})

describe('排名与平局裁决', () => {
  it('平分时，最后一次独占位置更晚者在前', () => {
    // 3 人 6 格：slot0=4 slot1=4 slot2=5 slot3=6 slot4=7 slot5=8
    // 场景经过赏金核算：b 只在「始终有人占」的位上移动，因此不触发赏金加成。
    const log = lobby(THREE_SEATS)
    for (let r = 1; r <= 4; r++) log.playRound(r, { 's-a': 0, 's-b': 2, 's-c': 1 })
    for (let r = 5; r <= 7; r++) log.playRound(r, { 's-a': 0, 's-b': 1, 's-c': 3 })
    log.playRound(8, { 's-a': 0, 's-b': 3, 's-c': 3 }) // b 与 c 撞车，a 继续独占

    const state = project(log.events)
    const bySeat = Object.fromEntries(state.ranking.map((e) => [e.seatId, e]))

    // a = 8×4 = 32，最后一次独占在第 8 轮
    expect(bySeat['s-a']!.score).toBe(32)
    expect(bySeat['s-a']!.lastSoloRound).toBe(8)

    // b = 4×5 + 3×4 = 32，最后一次独占在第 7 轮（第 8 轮撞车）
    expect(bySeat['s-b']!.score).toBe(32)
    expect(bySeat['s-b']!.lastSoloRound).toBe(7)

    // c = 4×4 + (6+4) + 6 + 6 = 38（第 5 轮吃到了 slot3 累积的 4 点赏金）
    expect(bySeat['s-c']!.score).toBe(38)
    expect(bySeat['s-c']!.lastSoloRound).toBe(7)

    // 同分 32，a 的独占更晚 → a 在前
    expect(bySeat['s-c']!.rank).toBe(1)
    expect(bySeat['s-a']!.rank).toBe(2)
    expect(bySeat['s-b']!.rank).toBe(3)
  })

  it('分数与最后独占轮次都相同 → 并列同名次', () => {
    const log = lobby(THREE_SEATS)
    for (let r = 1; r <= 8; r++) log.playRound(r, { 's-a': 0, 's-b': 1, 's-c': 2 })
    const state = project(log.events)
    const bySeat = Object.fromEntries(state.ranking.map((e) => [e.seatId, e]))
    expect(bySeat['s-a']!.score).toBe(32)
    expect(bySeat['s-b']!.score).toBe(32)
    expect(bySeat['s-c']!.score).toBe(40)
    expect(bySeat['s-c']!.rank).toBe(1)
    expect(bySeat['s-a']!.rank).toBe(2)
    expect(bySeat['s-b']!.rank).toBe(2)
  })

  it('GAME_OVER 之前不产出排名', () => {
    const log = lobby(FOUR_SEATS)
    log.playRound(1, { 's-a': 0, 's-b': 1, 's-c': 2, 's-d': 3 })
    expect(project(log.events).ranking).toEqual([])
  })
})
