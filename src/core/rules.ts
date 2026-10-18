/**
 * 规则引擎：事件日志 → 局面。
 *
 * project() 是**纯函数**：同一份日志必然投影出同一局面。
 * 不得出现 Math.random / Date.now / performance.now（见 AGENTS.md §6 硬约束 2）。
 *
 * 时间只作为**协调**依据，且其结论必须以 ROUND_TIMEOUT 事件的形式进入日志，
 * 因此 project() 本身不读时钟。
 *
 * 规则依据：docs/game-rules-v1.md
 */

import { normalizeLog } from './log.ts'
import { MAX_PLAYERS, MIN_PLAYERS, type GameEvent, type SeatId, type SlotIndex } from './types.ts'
import { ROUNDS, slotValues } from './values.ts'

export type Phase = 'LOBBY' | 'COMMITTING' | 'REVEALING' | 'RESOLVED' | 'GAME_OVER'

export interface PlayerState {
  seatId: SeatId
  nickname: string
  /** 由房主添加的机器人席位。机器人由房主浏览器代为操作。 */
  bot: boolean
  connected: boolean
  ready: boolean
  score: number
  /** 被罚（撞车）次数。 */
  penalties: number
  /** 最后一次成功独占位置的轮次；从未独占为 null。用于平局裁决。 */
  lastSoloRound: number | null
}

export interface RoundRecord {
  round: number
  openedAt: number
  baseValues: readonly number[]
  bountyBefore: readonly number[]
  effective: readonly number[]
  /** 本轮提交过承诺的席位。 */
  committed: readonly SeatId[]
  /** 每个席位的选择；null 表示弃权（未揭示或未提交）。 */
  picks: Readonly<Record<SeatId, SlotIndex | null>>
  /** 每个位置的独占者；null 表示无人独占（空置或撞车）。 */
  capturedBy: readonly (SeatId | null)[]
  /** 每个位置的撞车者列表（长度 ≥ 2 表示撞车）。 */
  colliders: readonly (readonly SeatId[])[]
  /** 无人选择的位置。 */
  empty: readonly SlotIndex[]
  /** 本轮每个席位的得分增量。 */
  deltas: Readonly<Record<SeatId, number>>
  bountyAfter: readonly number[]
  timedOutCommit: boolean
  timedOutReveal: boolean
  settled: boolean
  /** 本轮参与席位数，用于判断提交/揭示阶段是否已收齐。 */
  seatCount: number
}

export interface RankEntry {
  seatId: SeatId
  nickname: string
  score: number
  /** 名次，从 1 开始；并列时同名次。 */
  rank: number
  penalties: number
  lastSoloRound: number | null
}

export interface GameState {
  phase: Phase
  /** 当前轮次（1-based）。尚未开局时为 1。 */
  round: number
  players: readonly PlayerState[]
  /** 已开始的所有轮次（含进行中的那一轮）。 */
  rounds: readonly RoundRecord[]
  /** 仅 GAME_OVER 时非空。 */
  ranking: readonly RankEntry[]
  /** 日志缺口；非空表示日志不完整，调用方应先补齐再信任本局面。 */
  gaps: readonly { from: number; to: number }[]
}

const EMPTY_STATE: GameState = {
  phase: 'LOBBY',
  round: 1,
  players: [],
  rounds: [],
  ranking: [],
  gaps: [],
}

/**
 * 把事件日志投影为局面。
 *
 * 传入的日志可以是任意顺序、含重复的；内部会先规范化。
 */
export function project(rawLog: readonly GameEvent[]): GameState {
  const { events: allEvents, gaps } = normalizeLog(rawLog)

  // 「再来一局」：只投影最后一条 GAME_RESET 之后的事件。
  // 这样日志保持追加式、不需要清空，也不会有「清空与写入」的竞态。
  let resetAt = -1
  for (let i = allEvents.length - 1; i >= 0; i--) {
    if (allEvents[i]!.type === 'GAME_RESET') {
      resetAt = i
      break
    }
  }
  const events = resetAt >= 0 ? allEvents.slice(resetAt + 1) : allEvents

  if (events.length === 0) return EMPTY_STATE

  const roster = buildRoster(events)
  const playerCount = roster.length
  const players = roster.map((r) => ({
    seatId: r.seatId,
    nickname: r.nickname,
    bot: r.bot,
    connected: r.connected,
    ready: r.ready,
    score: 0,
    penalties: 0,
    lastSoloRound: null as number | null,
  }))
  const bySeat = new Map(players.map((p) => [p.seatId, p]))

  // 人数不在 3–5 时无法开局，停留在 LOBBY。
  if (playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
    return { ...EMPTY_STATE, players, gaps }
  }

  const values = slotValues(playerCount)
  const seatIds = players.map((p) => p.seatId)

  const rounds: RoundRecord[] = []
  let bounty = values.map(() => 0)

  for (let round = 1; round <= ROUNDS; round++) {
    const open = events.find(
      (e) => e.type === 'ROUND_OPEN' && e.payload.round === round,
    ) as (GameEvent & { type: 'ROUND_OPEN' }) | undefined
    if (!open) break

    const record = buildRound(events, round, open.payload.openedAt, values, bounty, seatIds)
    rounds.push(record)

    if (!record.settled) break

    for (const seatId of seatIds) {
      const player = bySeat.get(seatId)!
      player.score += record.deltas[seatId] ?? 0
      if (record.colliders.some((c) => c.includes(seatId))) player.penalties += 1
      const capturedSlot = record.capturedBy.findIndex((s) => s === seatId)
      if (capturedSlot >= 0) player.lastSoloRound = round
    }

    bounty = [...record.bountyAfter]
  }

  const settledCount = rounds.filter((r) => r.settled).length
  const phase = derivePhase(rounds, settledCount)
  const currentRound = Math.min(rounds.length || 1, ROUNDS)
  const ranking = phase === 'GAME_OVER' ? buildRanking(players) : []

  return { phase, round: currentRound, players, rounds, ranking, gaps }
}

function derivePhase(rounds: readonly RoundRecord[], settledCount: number): Phase {
  if (rounds.length === 0) return 'LOBBY'
  if (settledCount >= ROUNDS) return 'GAME_OVER'

  const last = rounds[rounds.length - 1]!
  if (last.settled) return 'RESOLVED'
  if (commitPhaseClosed(last)) return 'REVEALING'
  return 'COMMITTING'
}

function commitPhaseClosed(record: RoundRecord): boolean {
  if (record.timedOutCommit) return true
  return record.committed.length >= record.seatCount
}

function buildRound(
  events: readonly GameEvent[],
  round: number,
  openedAt: number,
  baseValues: readonly number[],
  bountyBefore: readonly number[],
  seatIds: readonly SeatId[],
): RoundRecord {
  const slotTotal = baseValues.length
  const effective = baseValues.map((v, i) => v + (bountyBefore[i] ?? 0))

  const commits = new Map<SeatId, string>()
  const reveals = new Map<SeatId, SlotIndex>()
  let timedOutCommit = false
  let timedOutReveal = false

  for (const event of events) {
    if (!('round' in event.payload) || event.payload.round !== round) continue
    switch (event.type) {
      case 'COMMIT':
        // 只认该轮第一条承诺：承诺一旦入日志不可覆盖。
        if (!commits.has(event.author)) commits.set(event.author, event.payload.commit)
        break
      case 'REVEAL':
        if (!reveals.has(event.author)) reveals.set(event.author, event.payload.slotIndex)
        break
      case 'ROUND_TIMEOUT':
        if (event.payload.phase === 'commit') timedOutCommit = true
        else timedOutReveal = true
        break
      default:
        break
    }
  }

  const picks: Record<SeatId, SlotIndex | null> = {}
  for (const seatId of seatIds) {
    picks[seatId] = reveals.has(seatId) ? reveals.get(seatId)! : null
  }

  const counts = new Array<number>(slotTotal).fill(0)
  const occupants: SeatId[][] = Array.from({ length: slotTotal }, () => [])
  for (const seatId of seatIds) {
    const slot = picks[seatId]
    if (slot === null || slot === undefined) continue
    if (slot < 0 || slot >= slotTotal) continue
    counts[slot]! += 1
    occupants[slot]!.push(seatId)
  }

  const capturedBy: (SeatId | null)[] = new Array(slotTotal).fill(null)
  const colliders: SeatId[][] = Array.from({ length: slotTotal }, () => [])
  const empty: SlotIndex[] = []
  const deltas: Record<SeatId, number> = {}
  for (const seatId of seatIds) deltas[seatId] = 0

  const bountyAfter = [...bountyBefore]

  for (let slot = 0; slot < slotTotal; slot++) {
    const count = counts[slot]!
    if (count === 1) {
      const winner = occupants[slot]![0]!
      capturedBy[slot] = winner
      deltas[winner] = effective[slot]!
      bountyAfter[slot] = 0
    } else if (count >= 2) {
      colliders[slot] = occupants[slot]!
      // 撞车：所有选择者本轮 0 分；价值不发放，赏金保留且不增长。
      bountyAfter[slot] = bountyBefore[slot] ?? 0
    } else {
      empty.push(slot)
      bountyAfter[slot] = (bountyBefore[slot] ?? 0) + 1
    }
  }

  // 一轮只有在**提交阶段关闭之后**才可能结算。
  // 否则「零提交」会让 reveals.size >= commits.size 变成空真，回合刚开始就被判结束。
  const commitClosed = timedOutCommit || commits.size >= seatIds.length
  const revealClosed = commitClosed && (timedOutReveal || reveals.size >= commits.size)

  return {
    round,
    openedAt,
    baseValues: [...baseValues],
    bountyBefore: [...bountyBefore],
    effective,
    committed: [...commits.keys()],
    picks,
    capturedBy,
    colliders,
    empty,
    deltas,
    bountyAfter,
    timedOutCommit,
    timedOutReveal,
    settled: revealClosed,
    seatCount: seatIds.length,
  }
}

interface RosterEntry {
  seatId: SeatId
  nickname: string
  bot: boolean
  connected: boolean
  ready: boolean
}

function buildRoster(events: readonly GameEvent[]): RosterEntry[] {
  const roster: RosterEntry[] = []
  const index = new Map<SeatId, number>()

  for (const event of events) {
    switch (event.type) {
      case 'JOIN': {
        const { nickname, seatId, bot } = event.payload
        const existing = index.get(seatId)
        if (existing === undefined) {
          index.set(seatId, roster.length)
          roster.push({ seatId, nickname, bot: bot === true, connected: true, ready: false })
        } else {
          // 重连：沿用原席位，更新昵称与在线状态。
          roster[existing]!.nickname = nickname
          roster[existing]!.connected = true
          if (bot === true) roster[existing]!.bot = true
        }
        break
      }
      case 'LEAVE': {
        const at = index.get(event.payload.seatId)
        if (at !== undefined) roster[at]!.connected = false
        break
      }
      case 'READY': {
        const at = index.get(event.payload.seatId)
        if (at !== undefined) roster[at]!.ready = event.payload.ready
        break
      }
      default:
        break
    }
  }

  return roster
}

/**
 * 排名与平局裁决（docs/game-rules-v1.md §9.3）：
 *   1. 分数高者在前
 *   2. 平分时，最后一次独占位置更晚者在前
 *   3. 从未独占过任何位置者，排在所有至少独占过一次者之后
 *   4. 仍相同则并列（同名次）
 */
function buildRanking(players: readonly PlayerState[]): RankEntry[] {
  const sorted = [...players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const aSolo = a.lastSoloRound ?? -1
    const bSolo = b.lastSoloRound ?? -1
    if (bSolo !== aSolo) return bSolo - aSolo
    return 0
  })

  const entries: RankEntry[] = []
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]!
    const prev = entries[i - 1]
    const tied =
      prev !== undefined &&
      prev.score === p.score &&
      (prev.lastSoloRound ?? -1) === (p.lastSoloRound ?? -1)
    entries.push({
      seatId: p.seatId,
      nickname: p.nickname,
      score: p.score,
      rank: tied ? prev!.rank : i + 1,
      penalties: p.penalties,
      lastSoloRound: p.lastSoloRound,
    })
  }
  return entries
}
