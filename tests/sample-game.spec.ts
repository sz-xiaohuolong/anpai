import { describe, expect, it } from 'vitest'
import { project } from '../src/core/rules.ts'
import {
  SAMPLE_EXPECTED_PENALTIES,
  SAMPLE_EXPECTED_SCORES,
  SAMPLE_NICKNAMES,
  sampleGameLog,
} from '../src/core/sample-game.ts'

/**
 * 参照对局回放：docs/game-rules-v1.md §8。
 * 这一条断言把「规则文档里写的示例」和「代码实际算出来的结果」绑在一起，
 * 任何一方漂移都会失败。
 */
describe('参照对局回放（4 人 8 轮）', () => {
  const state = project(sampleGameLog())

  it('打满 8 轮并进入 GAME_OVER', () => {
    expect(state.phase).toBe('GAME_OVER')
    expect(state.rounds).toHaveLength(8)
    expect(state.rounds.every((r) => r.settled)).toBe(true)
  })

  it('最终分数与规则文档一致：阿元 36 / 小北 29 / Kai 35 / 老周 41', () => {
    const actual = Object.fromEntries(state.players.map((p) => [p.seatId, p.score]))
    expect(actual).toEqual(SAMPLE_EXPECTED_SCORES)
    expect(state.ranking.map((e) => e.score)).toEqual([41, 36, 35, 29])
  })

  it('被罚次数与规则文档一致：阿元 3 / 小北 4 / Kai 3 / 老周 2', () => {
    const actual = Object.fromEntries(state.players.map((p) => [p.seatId, p.penalties]))
    expect(actual).toEqual(SAMPLE_EXPECTED_PENALTIES)
  })

  it('总分守恒：8 轮得分之和等于四人总分之和', () => {
    const fromRounds = state.rounds.reduce(
      (sum, r) => sum + Object.values(r.deltas).reduce((a, b) => a + b, 0),
      0,
    )
    const fromPlayers = state.players.reduce((sum, p) => sum + p.score, 0)
    expect(fromRounds).toBe(fromPlayers)
    expect(fromPlayers).toBe(36 + 29 + 35 + 41)
  })

  it('位 7 的赏金一路累积，最终有效价值达到 14', () => {
    const last = state.rounds[7]!
    expect(last.effective[7]).toBe(14)
    expect(last.baseValues[7]).toBe(8)
    expect(last.bountyBefore[7]).toBe(6)
  })

  it('排名第一的是老周', () => {
    expect(state.ranking[0]!.seatId).toBe('seat-zhou')
    expect(state.ranking[0]!.nickname).toBe(SAMPLE_NICKNAMES['seat-zhou'])
  })

  it('日志无缺口', () => {
    expect(state.gaps).toEqual([])
  })
})
