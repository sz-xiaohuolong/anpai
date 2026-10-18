/**
 * 机器人策略：**写死的确定性规则，不是 AI**。
 *
 * 它只需要「会操作」——能开一局、不卡流程、不做出明显犯傻的选择，
 * 用来在人数不够时补位测试。
 *
 * 纯函数、无随机、无时钟：同样的局面永远得到同样的选择。
 * 这让它可以放进 src/core（受架构边界约束），也能被单测直接断言。
 */

import type { GameState } from './rules.ts'
import { slotValues } from './values.ts'

/**
 * 选一个位置。
 *
 * 策略：在「有效价值」和「上一轮拥挤程度」之间取平衡——
 *   分数 = 有效价值 / (1 + 上一轮选它的人数)
 *
 * 效果：优先高价值位；上一轮被抢爆的位会被降权，避免连续撞车。
 * 平手时取编号小的，保证确定性。
 */
export function chooseSlot(state: GameState): number | null {
  const playerCount = state.players.length
  if (playerCount === 0) return null

  const current = state.rounds[state.round - 1]
  const base = current?.baseValues ?? slotValues(playerCount)
  const bounty = current?.bountyBefore ?? base.map(() => 0)
  const effective = base.map((value, index) => value + (bounty[index] ?? 0))

  const previous = state.rounds[state.round - 2]
  const crowding = new Array<number>(effective.length).fill(0)
  if (previous) {
    for (const pick of Object.values(previous.picks)) {
      if (pick !== null && pick >= 0 && pick < crowding.length) {
        crowding[pick] = (crowding[pick] ?? 0) + 1
      }
    }
  }

  let best: number | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (let slot = 0; slot < effective.length; slot++) {
    const score = (effective[slot] ?? 0) / (1 + (crowding[slot] ?? 0))
    if (score > bestScore) {
      bestScore = score
      best = slot
    }
  }
  return best
}
