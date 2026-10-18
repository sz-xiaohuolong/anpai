/**
 * 机器人策略：**写死的确定性规则，不是 AI**。
 *
 * 纯函数、无随机源、无时钟。抽样种子由「自己的席位 + 轮次」派生，
 * 因此同一局面永远得到同一个选择，测试可以直接断言。
 *
 * ── 三次踩坑，都记在这里避免再犯 ────────────────────────────
 *
 * **坑 1：各自独立地「挑分数最高的」→ 必然互撞。**
 * 同局机器人看到同一份公开局面，纯函数给出同一个答案。
 *
 * **坑 2：让它们互相知道对方选什么 → 完美协同，对人类不公平。**
 * 「依次决策、后来者避开已占位」之后机器人之间零碰撞：它们每轮稳稳各占一位、
 * 全部拿满分，而真人要独自承担所有撞车。真人做不到这种协同，这是在作弊。
 *
 * **坑 3：按「价值 / 拥挤度」加权抽样 → 撞车率 100%，且被人类碾压。**
 * 抽样分布过度集中在少数高位：机器人互撞率 100%（真人基线 69%），
 * 同时一个只会挑最高价值的真人能以 57:24 碾压它们。
 *
 * **当前模型：按对称混合策略均衡的概率抽样。**
 * 均衡的定义就是「对手无法占你便宜」。按它出牌时：
 *   - 机器人互撞率 ≈ 真人互撞率（4 人 8 格约 69%）
 *   - 真人既占不到便宜、也不会被系统性地欺负
 * 公式是闭式解，不是 AI 判断。
 */

import type { GameState } from './rules.ts'
import { slotValues } from './values.ts'

export interface BotContext {
  /**
   * 机器人自己的席位 ID。
   *
   * 只用来派生「属于这个机器人的抽样种子」——不是用来偷看别人的选择。
   * 不同机器人拿到不同种子，因此彼此独立。
   */
  seatId?: string

  /**
   * 房间码。**必须传**，否则同一局里各轮的抽样点会被固定住：
   * 种子只由 (席位, 轮次) 决定时，第 1 轮在每一局里都给出同一组落点，
   * 等于一次抽样被重复了成千上万次——实测撞车率会掉到 37%（真人基线 69%），
   * 机器人反而比真人更少撞车、占了便宜。带上房间码后，每局都是独立抽样。
   */
  roomCode?: string
}

/**
 * 选一个位置。
 *
 * 步骤：取本轮有效价值 → 求对称混合策略均衡概率 → 用确定性种子按该分布抽样。
 */
export function chooseSlot(state: GameState, context: BotContext = {}): number | null {
  const playerCount = state.players.length
  if (playerCount === 0) return null

  const current = state.rounds[state.round - 1]
  const base = current?.baseValues ?? slotValues(playerCount)
  const bounty = current?.bountyBefore ?? base.map(() => 0)
  const effective = base.map((value, index) => value + (bounty[index] ?? 0))

  const probabilities = equilibriumProbabilities(effective, playerCount)
  const seed = `${context.roomCode ?? ''}:${context.seatId ?? 'bot'}:${state.round}`
  return sampleFrom(probabilities, seed)
}

/**
 * 对称混合策略均衡。
 *
 * 博弈：每人选一个位置；独占则得该位置的价值，≥2 人则都拿 0。
 * 给定其他 n−1 人按 p 出牌，选位置 i 的期望收益是 v_i · (1 − p_i)^(n−1)。
 * 均衡时所有「会被选」的位置期望收益相等，于是
 *
 *     p_i = 1 − (u / v_i)^(1/(n−1))
 *
 * 其中 u 由 Σp_i = 1 定出。价值太低、解出负概率的位置退出候选集，
 * 迭代直到候选集稳定。
 */
export function equilibriumProbabilities(
  values: readonly number[],
  playerCount: number,
): number[] {
  const slotTotal = values.length
  if (slotTotal === 0) return []

  // 只有一个人时不存在撞车，随便选。
  if (playerCount <= 1) return values.map(() => 1 / slotTotal)

  const exponent = 1 / (playerCount - 1)
  let active = values.map((_, index) => index)

  for (let iteration = 0; iteration < 64; iteration++) {
    if (active.length === 0) return values.map(() => 1 / slotTotal)

    const sum = active.reduce((acc, index) => acc + (values[index] ?? 0) ** -exponent, 0)
    const scaled = (active.length - 1) / sum
    const threshold = scaled ** (playerCount - 1)

    const probabilities = values.map(() => 0)
    for (const index of active) {
      probabilities[index] = 1 - scaled * (values[index] ?? 0) ** -exponent
    }

    const dropped = active.filter((index) => (probabilities[index] ?? 0) <= 1e-9)
    if (dropped.length > 0) {
      active = active.filter((index) => !dropped.includes(index))
      continue
    }

    const added = values
      .map((_, index) => index)
      .filter((index) => !active.includes(index) && (values[index] ?? 0) > threshold + 1e-9)
    if (added.length > 0) {
      active = active.concat(added)
      continue
    }

    const total = probabilities.reduce((acc, value) => acc + value, 0)
    if (total <= 0) return values.map(() => 1 / slotTotal)
    return probabilities.map((value) => value / total)
  }

  return values.map(() => 1 / slotTotal)
}

function sampleFrom(probabilities: readonly number[], seed: string): number | null {
  if (probabilities.length === 0) return null
  const target = deterministicUnit(seed)
  let accumulated = 0
  for (let slot = 0; slot < probabilities.length; slot++) {
    accumulated += probabilities[slot] ?? 0
    if (target < accumulated) return slot
  }
  return probabilities.length - 1
}

/**
 * 把任意字符串映射到 [0, 1)。
 *
 * FNV-1a 加一轮雪崩混合。没有随机源，因此同一颗种子永远得到同一个数——
 * 机器人「看起来随机」但完全可复现。
 */
function deterministicUnit(seed: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x2c1b3c6d) >>> 0
  hash ^= hash >>> 12
  hash = Math.imul(hash, 0x297a2d39) >>> 0
  hash ^= hash >>> 15
  // 必须归一化：JS 的 `^` 返回**有符号** 32 位整数，直接除会得到负数，
  // 而负数会让抽样永远落在第 0 个位置（曾经因此让机器人一半时间选 0 号位）。
  return (hash >>> 0) / 0x100000000
}
