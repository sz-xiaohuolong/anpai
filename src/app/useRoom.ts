/**
 * 房间组合式函数：把 RoomClient、事件日志与 project() 接在一起。
 *
 * 规则判定全部在客户端完成（project 是纯函数）；
 * 服务器只负责排序与转播。见 docs/game-architecture-v1.md §1。
 */

import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import { chooseSlot } from '../core/bot.ts'
import { commitOf, randomNonceHex } from '../core/crypto.ts'
import { project, type GameState, type PlayerState } from '../core/rules.ts'
import type { GameEvent } from '../core/types.ts'
import { RoomClient } from '../net/client.ts'
import { roomSocketUrl, type ConnectionStatus } from '../net/protocol.ts'
import { getNickname, getSeatId } from './session.ts'

interface PendingPick {
  round: number
  slotIndex: number
  nonceHex: string
}

export function useRoom(roomCode: string, options: { enabled?: boolean } = {}) {
  const events = ref<GameEvent[]>([])
  const status = ref<ConnectionStatus>('idle')
  const seatId = ref<string | null>(null)
  const client = ref<RoomClient | null>(null)
  const error = ref<string | null>(null)

  /** 本轮已提交但还没揭示的选择，只在本地内存里。 */
  const pending = reactive(new Map<number, PendingPick>())
  const revealedRounds = new Set<number>()

  const state = computed<GameState>(() => project(events.value))

  const me = computed<PlayerState | null>(
    () => state.value.players.find((p) => p.seatId === seatId.value) ?? null,
  )

  const isReady = computed(() => me.value?.ready ?? false)

  const currentRound = computed(() => state.value.rounds[state.value.round - 1] ?? null)

  const hasCommitted = computed(() => {
    const round = currentRound.value
    if (!round || !seatId.value) return false
    return round.committed.includes(seatId.value)
  })

  const myPickThisRound = computed<number | null>(() => {
    const round = currentRound.value
    if (!round || !seatId.value) return null
    return round.picks[seatId.value] ?? null
  })

  /** 我在本轮已选但尚未确认的位置（用于卡片高亮）。 */
  const myPendingSlot = computed<number | null>(
    () => pending.get(state.value.round)?.slotIndex ?? null,
  )

  /** 房主 = 第一个加入的席位。由日志推导，不是服务端特权。 */
  const isHost = computed(() => state.value.players[0]?.seatId === seatId.value)

  void (async () => {
    // 没有昵称时不连接：否则会以「玩家」身份写入 JOIN，房间列表里凭空多一个人。
    if (options.enabled === false) return
    try {
      const id = await getSeatId()
      seatId.value = id
      const room = new RoomClient({
        url: roomSocketUrl(location.origin, roomCode),
        seatId: id,
        nickname: getNickname() || '玩家',
        handlers: {
          onLog: (log) => {
            events.value = [...log]
          },
          onEvent: (event) => {
            events.value = [...events.value, event]
          },
          onStatus: (next) => {
            status.value = next
          },
        },
      })
      client.value = room
      room.connect()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  })()

  /**
   * 一旦进入揭示阶段，立刻把自己的承诺揭示出去。
   *
   * 这是「提交了但没揭示 = 弃权」规则下的客户端义务：
   * 不揭示会自损，所以必须主动揭示。
   */
  watch(
    () => [state.value.phase, state.value.round] as const,
    ([phase, round]) => {
      if (phase !== 'REVEALING') return
      const pick = pending.get(round)
      if (!pick || revealedRounds.has(round)) return
      revealedRounds.add(round)
      client.value?.sendReveal(round, pick.slotIndex, pick.nonceHex)
    },
    { immediate: true },
  )

  // ── 机器人执行器 ──────────────────────────────────────────────
  // 机器人住在房主的浏览器里：房主替它算承诺、发提交、发揭示。
  // 服务器只知道「这条提交是 bot-1 席位发的」，不知道它选了什么。
  //
  // 机器人各自独立决策：按对称混合策略均衡的概率抽样，种子 = (房间码, 席位, 轮次)。
  //
  // 房间码必须参与种子。只用 (席位, 轮次) 时，同一局里每一轮的抽样点都被固定，
  // 第 1 轮在每一局里都给出同一组落点——等于一次抽样被重复了成千上万次，
  // 实测撞车率会掉到 37%（真人基线 69%），机器人反而比真人更少撞车、占了便宜。
  const botPicks = reactive(new Map<string, { round: number; slotIndex: number; nonceHex: string }>())
  const botScheduled = new Set<string>()
  const botRevealed = new Set<string>()

  async function runBotCommit(botSeat: string, round: number): Promise<void> {
    // 延时期间局面可能已经推进，触发时必须重新确认。
    if (state.value.phase !== 'COMMITTING' || state.value.round !== round) return

    const slotIndex = chooseSlot(state.value, { seatId: botSeat, roomCode })
    if (slotIndex === null) return

    const nonceHex = randomNonceHex()
    const commit = await commitOf({ roomCode, round, seatId: botSeat, slotIndex, nonceHex })
    botPicks.set(botSeat, { round, slotIndex, nonceHex })
    client.value?.sendCommit(round, commit, botSeat)
  }

  watch(
    () => [state.value.phase, state.value.round] as const,
    ([phase, round]) => {
      if (phase === 'LOBBY') {
        // 重开一局后轮次从 1 重新开始，必须清掉上一局的调度标记。
        botPicks.clear()
        botScheduled.clear()
        botRevealed.clear()
        return
      }
      if (!isHost.value) return

      const bots = state.value.players.filter((player) => player.bot).map((player) => player.seatId)
      if (bots.length === 0) return

      if (phase === 'COMMITTING') {
        bots.forEach((botSeat, index) => {
          const key = `${botSeat}:${round}`
          if (botScheduled.has(key)) return
          botScheduled.add(key)
          // 错开一点，让揭示阶段看起来不像同一瞬间全部返回。
          setTimeout(() => void runBotCommit(botSeat, round), 600 + index * 400)
        })
        return
      }

      if (phase === 'REVEALING') {
        for (const botSeat of bots) {
          const pick = botPicks.get(botSeat)
          if (!pick || pick.round !== round) continue
          const key = `${botSeat}:${round}`
          if (botRevealed.has(key)) continue
          botRevealed.add(key)
          client.value?.sendReveal(round, pick.slotIndex, pick.nonceHex, botSeat)
        }
      }
    },
    { immediate: true },
  )

  async function pick(slotIndex: number): Promise<void> {
    if (state.value.phase !== 'COMMITTING') return
    if (hasCommitted.value) return
    if (!seatId.value) return

    const round = state.value.round
    const nonceHex = randomNonceHex()
    const commit = await commitOf({
      roomCode,
      round,
      seatId: seatId.value,
      slotIndex,
      nonceHex,
    })
    pending.set(round, { round, slotIndex, nonceHex })
    client.value?.sendCommit(round, commit)
  }

  function setReady(ready: boolean): void {
    client.value?.sendReady(ready)
  }

  /** 一局结束后重开（仅 phase === 'over' 或 'lobby' 时服务端才接受）。 */
  function reset(): void {
    client.value?.sendReset()
  }

  function addBot(): void {
    client.value?.sendAddBot()
  }

  function removeBot(botSeatId: string): void {
    client.value?.sendRemoveBot(botSeatId)
  }

  onScopeDispose(() => {
    client.value?.close()
    client.value = null
  })

  return {
    state,
    me,
    isReady,
    status,
    seatId,
    error,
    currentRound,
    hasCommitted,
    myPickThisRound,
    myPendingSlot,
    pick,
    setReady,
    reset,
    isHost,
    addBot,
    removeBot,
  }
}
