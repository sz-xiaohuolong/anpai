/**
 * 房间协调：纯状态机。
 *
 * 它**只做协调**，不做任何游戏判定：
 *   ✅ 分配单调 seq、维护席位与在线状态、判断阶段是否收齐、按截止时间推进
 *   ❌ 不算分、不判撞车、不判赏金、不判胜负
 *
 * 时间由调用方以 `now` 参数传入，因此本模块可在 Node 中直接单测。
 * 见 docs/game-architecture-v1.md §1 与 AGENTS.md §6 硬约束 3。
 */

import { COMMIT_WINDOW_MS, REVEAL_WINDOW_MS, ROUNDS } from '../src/core/values.ts'
import { MAX_PLAYERS, MIN_PLAYERS, type GameEvent, type SeatId } from '../src/core/types.ts'

/** 一轮结算后到下一轮打开的间隔，用于客户端播放揭示动画。 */
export const ROUND_INTERMISSION_MS = 5_000

export type RoomPhase = 'lobby' | 'committing' | 'revealing' | 'settled' | 'over'

export interface SeatRecord {
  seatId: SeatId
  nickname: string
  connected: boolean
  ready: boolean
  /** 当前占用的连接 id；重连时会换。 */
  connectionId: string | null
}

export interface RoomState {
  /** 已分配的最大 seq。 */
  seq: number
  seats: SeatRecord[]
  /** 当前轮次；0 表示尚未开局。 */
  round: number
  phase: RoomPhase
  openedAt: number | null
  commitDeadline: number | null
  revealDeadline: number | null
  /** 本轮已进入日志的提交者。 */
  committed: SeatId[]
  /** 本轮已揭示者。 */
  revealed: SeatId[]
  /** 下一轮打开时间（phase === 'settled' 时有效）。 */
  nextRoundAt: number | null
  log: GameEvent[]
}

export interface StepResult {
  state: RoomState
  events: GameEvent[]
}

export function createRoom(): RoomState {
  return {
    seq: 0,
    seats: [],
    round: 0,
    phase: 'lobby',
    openedAt: null,
    commitDeadline: null,
    revealDeadline: null,
    committed: [],
    revealed: [],
    nextRoundAt: null,
    log: [],
  }
}

function emit(
  state: RoomState,
  author: SeatId,
  type: GameEvent['type'],
  payload: GameEvent['payload'],
  now: number,
): GameEvent {
  state.seq += 1
  const event = { seq: state.seq, ts: now, author, type, payload } as GameEvent
  state.log.push(event)
  return event
}

function cloneState(state: RoomState): RoomState {
  return {
    ...state,
    seats: state.seats.map((s) => ({ ...s })),
    committed: [...state.committed],
    revealed: [...state.revealed],
    log: [...state.log],
  }
}

function connectedSeats(state: RoomState): SeatRecord[] {
  return state.seats.filter((s) => s.connected)
}

function findSeat(state: RoomState, seatId: SeatId): SeatRecord | undefined {
  return state.seats.find((s) => s.seatId === seatId)
}

export interface HelloInput {
  seatId: SeatId
  nickname: string
  connectionId: string
}

/**
 * 席位加入或重连。
 *
 * 同一 seatId 换连接即视为重连：接管席位，旧连接由调用方断开。
 */
export function applyHello(state: RoomState, input: HelloInput, now: number): StepResult {
  const next = cloneState(state)
  const existing = findSeat(next, input.seatId)
  const events: GameEvent[] = []

  if (existing) {
    existing.connected = true
    existing.connectionId = input.connectionId
    existing.nickname = input.nickname
    // 重连也要重新入日志一次，让其他客户端看到在线状态恢复。
    events.push(
      emit(next, input.seatId, 'JOIN', { nickname: input.nickname, seatId: input.seatId }, now),
    )
  } else {
    if (next.seats.length >= MAX_PLAYERS) {
      return { state, events: [] }
    }
    next.seats.push({
      seatId: input.seatId,
      nickname: input.nickname,
      connected: true,
      ready: false,
      connectionId: input.connectionId,
    })
    events.push(
      emit(next, input.seatId, 'JOIN', { nickname: input.nickname, seatId: input.seatId }, now),
    )
  }

  return { state: next, events }
}

export function applyLeave(state: RoomState, seatId: SeatId, now: number): StepResult {
  const next = cloneState(state)
  const seat = findSeat(next, seatId)
  if (!seat) return { state, events: [] }

  seat.connected = false
  seat.connectionId = null
  const event = emit(next, seatId, 'LEAVE', { seatId, reason: 'closed' }, now)
  return { state: next, events: [event] }
}

export function applyReady(
  state: RoomState,
  seatId: SeatId,
  ready: boolean,
  now: number,
): StepResult {
  const next = cloneState(state)
  const seat = findSeat(next, seatId)
  if (!seat) return { state, events: [] }

  seat.ready = ready
  const events: GameEvent[] = [emit(next, seatId, 'READY', { seatId, ready }, now)]

  if (next.phase === 'lobby' && shouldStart(next)) {
    events.push(...openRound(next, 1, now))
  }

  return { state: next, events }
}

/** 开局条件：人数在 3–5 之间且全员已准备。 */
function shouldStart(state: RoomState): boolean {
  const connected = connectedSeats(state)
  if (connected.length < MIN_PLAYERS) return false
  return connected.every((s) => s.ready)
}

function openRound(state: RoomState, round: number, now: number): GameEvent[] {
  state.round = round
  state.phase = 'committing'
  state.openedAt = now
  state.commitDeadline = now + COMMIT_WINDOW_MS
  state.revealDeadline = null
  state.committed = []
  state.revealed = []
  state.nextRoundAt = null
  return [emit(state, 'system', 'ROUND_OPEN', { round, openedAt: now }, now)]
}

export interface CommitInput {
  seatId: SeatId
  round: number
  commit: string
}

export function applyCommit(state: RoomState, input: CommitInput, now: number): StepResult {
  if (state.phase !== 'committing') return { state, events: [] }
  if (input.round !== state.round) return { state, events: [] }
  if (!findSeat(state, input.seatId)) return { state, events: [] }
  // 承诺不可覆盖。
  if (state.committed.includes(input.seatId)) return { state, events: [] }

  const next = cloneState(state)
  next.committed.push(input.seatId)
  const events: GameEvent[] = [
    emit(
      next,
      input.seatId,
      'COMMIT',
      { round: input.round, commit: input.commit },
      now,
    ),
  ]

  if (commitPhaseComplete(next)) {
    events.push(...closeCommitPhase(next, now))
  }

  return { state: next, events }
}

export interface RevealInput {
  seatId: SeatId
  round: number
  slotIndex: number
  nonceHex: string
}

export function applyReveal(state: RoomState, input: RevealInput, now: number): StepResult {
  if (state.phase !== 'revealing') return { state, events: [] }
  if (input.round !== state.round) return { state, events: [] }
  // 只有提交过的人才能揭示；且只认第一条。
  if (!state.committed.includes(input.seatId)) return { state, events: [] }
  if (state.revealed.includes(input.seatId)) return { state, events: [] }

  const next = cloneState(state)
  next.revealed.push(input.seatId)
  const events: GameEvent[] = [
    emit(
      next,
      input.seatId,
      'REVEAL',
      { round: input.round, slotIndex: input.slotIndex, nonceHex: input.nonceHex },
      now,
    ),
  ]

  if (revealPhaseComplete(next)) {
    events.push(...closeRound(next, now))
  }

  return { state: next, events }
}

/**
 * 提交阶段是否收齐。
 *
 * 用**全部席位**而不是在线席位：掉线的人应当有机会在截止前重连回来，
 * 而不是被立刻判弃权。真正没回来的，由提交超时兜底。
 */
function commitPhaseComplete(state: RoomState): boolean {
  return state.seats.length >= MIN_PLAYERS && state.committed.length >= state.seats.length
}

function revealPhaseComplete(state: RoomState): boolean {
  return state.committed.every((seatId) => state.revealed.includes(seatId))
}

function closeCommitPhase(state: RoomState, now: number): GameEvent[] {
  state.phase = 'revealing'
  state.revealDeadline = now + REVEAL_WINDOW_MS
  return []
}

function closeRound(state: RoomState, now: number): GameEvent[] {
  state.phase = 'settled'
  state.nextRoundAt = now + ROUND_INTERMISSION_MS
  return []
}

/**
 * 推进时间。调用方应定期（或按当前截止时间设 alarm）调用。
 *
 * 处理：提交超时、揭示超时、结算后开下一轮、整局结束。
 */
export function tick(state: RoomState, now: number): StepResult {
  let next = state
  const events: GameEvent[] = []

  // 提交超时
  if (
    next.phase === 'committing' &&
    next.commitDeadline !== null &&
    now >= next.commitDeadline
  ) {
    next = cloneState(next)
    next.phase = 'revealing'
    next.revealDeadline = now + REVEAL_WINDOW_MS
    events.push(
      emit(next, 'system', 'ROUND_TIMEOUT', { round: next.round, phase: 'commit' }, now),
    )
    // 零提交时立刻可以结算
    if (revealPhaseComplete(next)) {
      events.push(...closeRound(next, now))
    }
  }

  // 揭示超时
  if (
    next.phase === 'revealing' &&
    next.revealDeadline !== null &&
    now >= next.revealDeadline
  ) {
    next = cloneState(next)
    events.push(
      emit(next, 'system', 'ROUND_TIMEOUT', { round: next.round, phase: 'reveal' }, now),
    )
    events.push(...closeRound(next, now))
  }

  // 结算后开下一轮
  if (next.phase === 'settled' && next.nextRoundAt !== null && now >= next.nextRoundAt) {
    next = cloneState(next)
    if (next.round >= ROUNDS) {
      next.phase = 'over'
      next.nextRoundAt = null
    } else {
      const openEvents = openRound(next, next.round + 1, now)
      events.push(...openEvents)
      // 若没有任何在线玩家，closeRound 不会被触发，由 tick 继续兜底。
      if (commitPhaseComplete(next)) {
        events.push(...closeCommitPhase(next, now))
      }
    }
  }

  // 注意：判断「有没有变化」必须看 state 是否被替换，不能看 events 是否为空。
  // 「整局结束」这个分支只改状态、不产生事件，用 events 判空会把改动丢掉。
  if (next === state) return { state, events: [] }
  return { state: next, events }
}

/**
 * 再来一局：只在「一局已结束」或「尚未开局」时允许。
 *
 * 日志保持追加式——写一条 GAME_RESET，然后为每个在线席位重发 JOIN。
 * project() 只投影最后一条 GAME_RESET 之后的事件，因此不需要清空日志，
 * 也就不存在「清空与写入」的竞态。
 */
export function applyReset(state: RoomState, now: number): StepResult {
  // 最后一轮结算后还有一段 intermission 才进入 'over'，玩家会在这段时间点「再来一局」，
  // 因此 'settled' 且已打满轮数也必须允许，否则点击会被静默忽略。
  const finished =
    state.phase === 'over' || (state.phase === 'settled' && state.round >= ROUNDS)
  if (!finished && state.phase !== 'lobby') return { state, events: [] }

  const next = cloneState(state)
  const events: GameEvent[] = [emit(next, 'system', 'GAME_RESET', { at: now }, now)]

  next.round = 0
  next.phase = 'lobby'
  next.openedAt = null
  next.commitDeadline = null
  next.revealDeadline = null
  next.committed = []
  next.revealed = []
  next.nextRoundAt = null

  for (const seat of next.seats) {
    seat.ready = false
    if (seat.connected) {
      events.push(
        emit(next, seat.seatId, 'JOIN', { nickname: seat.nickname, seatId: seat.seatId }, now),
      )
    }
  }

  return { state: next, events }
}

/** 下一次需要唤醒的时间点；null 表示无需定时器。 */
export function nextDeadline(state: RoomState): number | null {
  if (state.phase === 'committing') return state.commitDeadline
  if (state.phase === 'revealing') return state.revealDeadline
  if (state.phase === 'settled') return state.nextRoundAt
  return null
}
