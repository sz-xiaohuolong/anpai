<script setup lang="ts">
import { ref } from 'vue'
import { goRoom } from '../app/router.ts'
import { getNickname, normalizeRoomCode, randomRoomCode, setNickname } from '../app/session.ts'

const nickname = ref(getNickname())
const joinCode = ref('')
const error = ref<string | null>(null)
const showRules = ref(false)

function rememberNickname() {
  setNickname(nickname.value)
}

function createRoom() {
  error.value = null
  if (!nickname.value.trim()) {
    error.value = '请先填一个昵称'
    return
  }
  rememberNickname()
  goRoom(randomRoomCode())
}

function joinRoom() {
  error.value = null
  if (!nickname.value.trim()) {
    error.value = '请先填一个昵称'
    return
  }
  const code = normalizeRoomCode(joinCode.value)
  if (!code) {
    error.value = '房间码格式不对（4–12 位字母或数字）'
    return
  }
  rememberNickname()
  goRoom(code)
}
</script>

<template>
  <main class="mx-auto flex min-h-screen w-full max-w-md flex-col gap-8 px-5 py-12">
    <header class="flex flex-col gap-2">
      <h1 class="text-[44px] leading-none font-bold tracking-tight">暗牌</h1>
      <p class="text-[15px] text-text-dim">8 轮，8 个位置，谁在骗谁？</p>
    </header>

    <section class="flex flex-col gap-4">
      <label class="flex flex-col gap-1.5">
        <span class="text-xs text-text-dim">昵称</span>
        <input
          v-model="nickname"
          maxlength="12"
          placeholder="你的名字"
          class="rounded-[8px] border border-hairline bg-felt-raised px-3 py-3 text-[15px] outline-none focus:border-focus"
        />
      </label>

      <button
        type="button"
        class="rounded-[8px] bg-bounty px-4 py-3.5 text-[15px] font-bold text-felt transition active:scale-[0.99]"
        @click="createRoom"
      >
        创建房间
      </button>

      <div class="flex gap-2">
        <input
          v-model="joinCode"
          maxlength="12"
          placeholder="房间码"
          class="min-w-0 flex-1 rounded-[8px] border border-hairline bg-felt-raised px-3 py-3 text-[15px] uppercase outline-none focus:border-focus"
          @keyup.enter="joinRoom"
        />
        <button
          type="button"
          class="shrink-0 rounded-[8px] border border-hairline px-5 py-3 text-[15px] transition active:scale-[0.99]"
          @click="joinRoom"
        >
          加入
        </button>
      </div>

      <p v-if="error" class="text-xs text-collide">{{ error }}</p>
    </section>

    <section class="rounded-[14px] border border-hairline bg-felt-raised">
      <button
        type="button"
        class="flex w-full items-center justify-between px-4 py-3 text-left text-sm"
        @click="showRules = !showRules"
      >
        <span>60 秒看懂规则</span>
        <span class="text-text-dim">{{ showRules ? '收起' : '展开' }}</span>
      </button>
      <div v-if="showRules" class="flex flex-col gap-2 border-t border-hairline px-4 py-3 text-[13px] text-text-dim">
        <p>每轮所有人<strong class="text-text">同时秘密选一个位置</strong>。</p>
        <p>只有你一个人选 → 你拿走它的分数。</p>
        <p>两个人以上选了同一个 → <strong class="text-collide">这些人都拿 0 分</strong>。</p>
        <p>没人选的位置，下轮<strong class="text-bounty">赏金 +1</strong>，越来越值钱。</p>
      </div>
    </section>
  </main>
</template>
