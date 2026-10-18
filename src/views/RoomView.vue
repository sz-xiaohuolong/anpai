<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoom } from '../app/useRoom.ts'
import { goPlay, goHome } from '../app/router.ts'
import { inviteUrl } from '../app/session.ts'

const props = defineProps<{ code: string }>()

const { state, me, isReady, status, setReady } = useRoom(props.code)

const copied = ref(false)

const players = computed(() => state.value.players)
const canStart = computed(() => players.value.length >= 3 && players.value.every((p) => p.ready))

async function copyInvite() {
  try {
    await navigator.clipboard.writeText(inviteUrl(props.code))
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
watch(
  () => state.value.phase,
  (phase) => {
    if (phase !== 'LOBBY') goPlay(props.code)
  },
)

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
          @click="copyInvite"
        >
          {{ copied ? '已复制' : '复制链接' }}
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

    <p class="text-center text-xs text-text-dim">
      满 3 人且全部准备后自动开始
      <span v-if="players.length < 3">（还差 {{ 3 - players.length }} 人）</span>
      <span v-else-if="!canStart">（等待其他人准备）</span>
    </p>
  </main>
</template>
