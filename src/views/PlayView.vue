<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import PositionCard from '../components/PositionCard.vue'
import type { CardState } from '../components/card-state.ts'
import { useRoom } from '../app/useRoom.ts'
import { goRoom } from '../app/router.ts'
import { COMMIT_WINDOW_MS, REVEAL_WINDOW_MS, ROUNDS, slotValues } from '../core/values.ts'

const props = defineProps<{ code: string }>()

const { state, me, status, currentRound, hasCommitted, myPendingSlot, pick } = useRoom(props.code)

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 500)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const playerCount = computed(() => state.value.players.length || 3)

const baseValues = computed<readonly number[]>(() => {
  const round = currentRound.value
  if (round) return round.baseValues
  return slotValues(playerCount.value)
})

const bounties = computed<readonly number[]>(() => {
  const round = currentRound.value
  if (round) return round.bountyBefore
  return baseValues.value.map(() => 0)
})

const seatName = computed(() => {
  const map = new Map(state.value.players.map((p) => [p.seatId, p.nickname]))
  return (seatId: string) => map.get(seatId) ?? seatId
})

const phaseLabel = computed(() => {
  switch (state.value.phase) {
    case 'LOBBY':
      return '等待开局'
    case 'COMMITTING':
      return '提交中'
    case 'REVEALING':
      return '揭示中'
    case 'RESOLVED':
      return '本轮结算'
    case 'GAME_OVER':
      return '对局结束'
    default:
      return ''
  }
})

const deadline = computed<number | null>(() => {
  const round = currentRound.value
  if (!round) return null
  if (state.value.phase === 'COMMITTING') return round.openedAt + COMMIT_WINDOW_MS
  if (state.value.phase === 'REVEALING') {
    return round.openedAt + COMMIT_WINDOW_MS + REVEAL_WINDOW_MS
  }
  return null
})

const secondsLeft = computed<number | null>(() => {
  if (deadline.value === null) return null
  return Math.max(0, Math.ceil((deadline.value - now.value) / 1000))
})

function cardState(slot: number): CardState {
  const round = currentRound.value
  if (round && round.settled) {
    if (round.capturedBy[slot]) return 'captured'
    if ((round.colliders[slot]?.length ?? 0) >= 2) return 'collided'
    return 'empty'
  }
  if (hasCommitted.value) return 'locked'
  if (myPendingSlot.value === slot) return 'selected'
  return 'idle'
}

function winnerName(slot: number): string | undefined {
  const seatId = currentRound.value?.capturedBy[slot]
  return seatId ? seatName.value(seatId) : undefined
}

function colliderNames(slot: number): readonly string[] {
  return (currentRound.value?.colliders[slot] ?? []).map((s) => seatName.value(s))
}

const interactive = computed(
  () => state.value.phase === 'COMMITTING' && !hasCommitted.value,
)

const scoreboard = computed(() =>
  [...state.value.players].sort((a, b) => b.score - a.score),
)

const showHistory = ref(false)
</script>

<template>
  <main class="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-3 px-4 py-4">
    <header class="flex items-center justify-between text-xs">
      <span class="tnum">第 {{ state.round }} / {{ ROUNDS }} 轮</span>
      <span class="text-text-dim">{{ phaseLabel }}</span>
      <span
        v-if="secondsLeft !== null"
        class="tnum"
        :class="secondsLeft <= 5 ? 'text-collide' : 'text-text-dim'"
      >
        ⏱ {{ secondsLeft }}s{{ secondsLeft <= 5 ? ' 快提交' : '' }}
      </span>
      <span v-else class="text-text-dim">{{ status === 'open' ? '' : '重连中…' }}</span>
    </header>

    <p
      v-if="state.phase === 'REVEALING'"
      class="rounded-[8px] border border-hairline bg-felt-raised px-3 py-2 text-center text-xs text-text-dim"
    >
      已锁定，等待其他人揭示…
    </p>

    <section class="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      <PositionCard
        v-for="(base, slot) in baseValues"
        :key="slot"
        :slot-index="slot"
        :base-value="base"
        :bounty="bounties[slot] ?? 0"
        :state="cardState(slot)"
        :winner-name="winnerName(slot)"
        :collider-names="colliderNames(slot)"
        :disabled="!interactive"
        @select="pick"
      />
    </section>

    <section class="mt-auto rounded-[14px] border border-hairline bg-felt-raised">
      <ul class="flex items-center justify-between gap-2 overflow-x-auto px-3 py-2.5">
        <li
          v-for="player in scoreboard"
          :key="player.seatId"
          class="flex shrink-0 items-baseline gap-1.5 text-sm"
          :class="player.seatId === me?.seatId ? 'font-bold' : ''"
        >
          <span class="text-xs text-text-dim">{{ player.nickname }}</span>
          <span class="tnum">{{ player.score }}</span>
        </li>
      </ul>
    </section>

    <div class="flex items-center justify-between text-xs">
      <button type="button" class="text-text-dim" @click="showHistory = !showHistory">
        {{ showHistory ? '收起历史' : '历史' }}
      </button>
      <span v-if="state.phase === 'GAME_OVER'" class="text-bounty">本局结束</span>
    </div>

    <section
      v-if="showHistory"
      class="rounded-[14px] border border-hairline bg-felt-raised px-3 py-3 text-xs"
    >
      <table class="w-full">
        <thead>
          <tr class="text-text-dim">
            <th class="py-1 text-left font-normal">玩家</th>
            <th
              v-for="round in ROUNDS"
              :key="round"
              class="tnum py-1 text-center font-normal"
            >
              {{ round }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="player in state.players" :key="player.seatId">
            <td class="py-1 pr-2 whitespace-nowrap">{{ player.nickname }}</td>
            <td
              v-for="round in ROUNDS"
              :key="round"
              class="tnum py-1 text-center"
              :class="
                (state.rounds[round - 1]?.colliders[state.rounds[round - 1]?.picks[player.seatId] ?? -1]?.length ?? 0) >= 2
                  ? 'text-collide'
                  : 'text-text-dim'
              "
            >
              {{ state.rounds[round - 1]?.picks[player.seatId] ?? '·' }}
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section
      v-if="state.phase === 'GAME_OVER'"
      class="rounded-[14px] border border-hairline bg-felt-raised px-4 py-4"
    >
      <p class="mb-3 text-sm text-text-dim">最终排名</p>
      <ol class="flex flex-col gap-2">
        <li
          v-for="entry in state.ranking"
          :key="entry.seatId"
          class="flex items-baseline justify-between border-l-2 pl-3"
          :class="entry.rank === 1 ? 'border-bounty' : 'border-hairline'"
        >
          <span class="text-sm">
            <span class="tnum mr-2 text-text-dim">{{ entry.rank }}</span>{{ entry.nickname }}
          </span>
          <span class="tnum text-lg font-bold">{{ entry.score }}</span>
        </li>
      </ol>
      <button
        type="button"
        class="mt-4 w-full rounded-[8px] bg-bounty px-4 py-3 text-sm font-bold text-felt"
        @click="goRoom(props.code)"
      >
        返回房间
      </button>
    </section>
  </main>
</template>
