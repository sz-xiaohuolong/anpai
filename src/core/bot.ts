/**
 * 机器人策略：**写死的确定性规则，不是 AI**。
 *
 * 纯函数、无随机、无时钟：同样的输入永远得到同样的输出。
 * 这让它可以放进 src/core（受架构边界约束），也能被单测直接断言。
 *
 * ── 为什么必须有 `reserved` 参数 ──────────────────────────────
 * 早先的实现只根据「公开局面」决策。但同一局里的多个机器人看到的是
 * **同一份公开局面**，纯函数必然给出**同一个答案**——三个机器人每一轮
 * 都选同一个位置，必定撞车。这不是策略不好，是结构性错误。
 *
 * 所以机器人必须**依次决策**：房主按固定顺序逐个询问，每个机器人都知道
 * 本轮前面几个机器人已经占了哪些位（`reserved`），从而错开。
 */

import type { GameState } from './rules.ts'
import { slotValues } from './values.ts'

export interface BotContext {
  /**
   * 本轮已经被其它机器人预定的位置。
   * 由调用方（房主的浏览器）按决策顺序累积传入。
   */
  reserved?: readonly number[]
}

/** 已被其它机器人预定的位置，等价于多少「上一轮的竞争者」。 */
const RESERVED_WEIGHT = 3

/**
 * 选一个位置。
 *
 * 分数 = 有效价值 / (1 + 上一轮选它的人数 + 3 × 本轮已被其它机器人预定)
 *
 * 三项的含义：
 *   - **有效价值**（基础 + 赏金）：优先值钱的位。
 *   - **上一轮拥挤度**：上一轮被抢爆的位降权，避免连续撞车。
 *   - **本轮预定**：让同一局的多个机器人错开，这是修掉「机器人互撞」的关键。
 *
 * 平手取编号小的，保证确定性。
 */
export function chooseSlot(state: GameState, context: BotContext = {}): number | null {
  const playerCount = state.players.length
  if (playerCount === 0) return null

  const current = state.rounds[state.round - 1]
  const base = current?.baseValues ?? slotValues(playerCount)
  const bounty = current?.bountyBefore ?? base.map(() => 0)
  const effective = base.map((value, index) => value + (bounty[index] ?? 0))
  const slotTotal = effective.length

  // 上一轮每个位置被几个人选。
  const crowding = new Array<number>(slotTotal).fill(0)
  const previous = state.rounds[state.round - 2]
  if (previous) {
    for (const pick of Object.values(previous.picks)) {
      if (pick !== null && pick >= 0 && pick < slotTotal) {
        crowding[pick] = (crowding[pick] ?? 0) + 1
      }
    }
  }

  // 本轮已被其它机器人预定的位置。
  const reserved = new Array<number>(slotTotal).fill(0)
  for (const slot of context.reserved ?? []) {
    if (slot >= 0 && slot < slotTotal) reserved[slot] = (reserved[slot] ?? 0) + 1
  }

  let best: number | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (let slot = 0; slot < slotTotal; slot++) {
    const contention = (crowding[slot] ?? 0) + RESERVED_WEIGHT * (reserved[slot] ?? 0)
    const score = (effective[slot] ?? 0) / (1 + contention)
    if (score > bestScore) {
      bestScore = score
      best = slot
    }
  }
  return best
}
