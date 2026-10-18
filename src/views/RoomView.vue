<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoom } from '../app/useRoom.ts'
import { goPlay, goHome, navigate } from '../app/router.ts'
import { getNickname } from '../app/session.ts'

const props = defineProps<{ code: string }>()

// 直接打开邀请链接的人还没有昵称。先让他回首页填昵称，
// 否则会被自动命名成「玩家」，而且没有任何地方能改。
const hasNickname = getNickname().trim().length > 0

const { state, me, isReady, status, setReady, reset } = useRoom(props.code, {
  enabled: hasNickname,
})

onMounted(() => {
  if (!hasNickname) navigate(`/?room=${encodeURIComponent(props.code)}`)
})

const copied = ref(false)

const players = computed(() => state.value.players)
const canStart = computed(() => players.value.length >= 3 && players.value.every((p) => p.ready))

async function copyCode() {
  try {
    await navigator.clipboard.writeText(props.code)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    copied.value = false
  }
}

function toggleReady() {
  setReady(!isReady.value)
}

// 开局后自动进入游戏页。
// immediate: true 让「游戏中刷新页面」也能回到牌桌，而不是卡在房间页。
// 只在「进行中」跳转；'over' 留在房间页，由下方按钮重开。
const ACTIVE_PHASES = new Set(['COMMITTING', 'REVEALING', 'RESOLVED'])
watch(
  () => state.value.phase,
  (phase) => {
    if (ACTIVE_PHASES.has(phase)) goPlay(props.code)
  },
  { immediate: true },
)

const isOver = computed(() => state.value.phase === 'GAME_OVER')

const statusText = computed(() => {
  switch (status.value) {
    case 'open':
      return '已连接'
    case 'connecting':
      return '连接中…'
    case 'reconnecting':
      return '重连中…'
    case 'closed':
      return '已断开'
    default:
      return '待连接'
  }
})
</script>

<template>
  <main class="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-5 py-8">
    <header class="flex items-center justify-between">
      <button type="button" class="text-sm text-text-dim" @click="goHome">← 退出</button>
      <span class="text-xs" :class="status === 'open' ? 'text-capture' : 'text-text-dim'">
        {{ statusText }}
      </span>
    </header>

    <section class="flex flex-col gap-2">
      <p class="text-xs text-text-dim">房间码</p>
      <div class="flex items-center justify-between gap-3">
        <span class="tnum text-[28px] font-bold tracking-[0.18em]">{{ code }}</span>
        <button
          type="button"
          class="shrink-0 rounded-[8px] border border-hairline px-3 py-2 text-xs"
          @click="copyCode"
        >
          {{ copied ? '已复制' : '复制房间码' }}
        </button>
      </div>
    </section>

    <section class="rounded-[14px] border border-hairline bg-felt-raised">
      <p class="border-b border-hairline px-4 py-2.5 text-xs text-text-dim">
        玩家 {{ players.length }} / 5
      </p>
      <ul class="flex flex-col">
        <li
          v-for="player in players"
          :key="player.seatId"
          class="flex items-center justify-between px-4 py-3 text-sm"
        >
          <span class="flex items-center gap-2">
            <span
              class="inline-block size-2 rounded-full"
              :class="player.connected ? 'bg-capture' : 'bg-hairline'"
            />
            <span :class="player.seatId === me?.seatId ? 'font-semibold' : ''">
              {{ player.nickname }}
            </span>
            <span v-if="player.seatId === me?.seatId" class="text-xs text-text-dim">(你)</span>
          </span>
          <span class="text-xs" :class="player.ready ? 'text-capture' : 'text-text-dim'">
            {{ player.ready ? '已准备' : '等待中' }}
          </span>
        </li>
        <li v-if="players.length === 0" class="px-4 py-6 text-center text-xs text-text-dim">
          还没有人加入
        </li>
      </ul>
    </section>

    <button
      type="button"
      class="rounded-[8px] px-4 py-3.5 text-[15px] font-bold transition active:scale-[0.99]"
      :class="isReady ? 'border border-hairline text-text' : 'bg-bounty text-felt'"
      @click="toggleReady"
    >
      {{ isReady ? '取消准备' : '准备' }}
    </button>

    <section
      v-if="isOver"
      class="rounded-[14px] border border-hairline bg-felt-raised px-4 py-4 text-center"
    >
      <p class="mb-3 text-sm">这一局已经结束了</p>
      <button
        type="button"
        class="w-full rounded-[8px] bg-bounty px-4 py-3 text-sm font-bold text-felt"
        @click="reset"
      >
        再来一局
      </button>
      <p class="mt-2 text-xs text-text-dim">所有人重新点「准备」即可开始</p>
    </section>

    <p class="text-center text-xs text-text-dim">
      满 3 人且全部准备后自动开始
      <span v-if="players.length < 3">（还差 {{ 3 - players.length }} 人）</span>
      <span v-else-if="!canStart">（等待其他人准备）</span>
    </p>
  </main>
</template>
