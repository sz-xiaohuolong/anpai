<script setup lang="ts">
import { computed } from 'vue'
import { project } from './core/rules.ts'
import { sampleGameLog } from './core/sample-game.ts'
import { ROUNDS } from './core/values.ts'

/**
 * 走通骨架：在浏览器里直接跑规则引擎，投影出规则文档 §8 那局参照对局。
 * 这是阶段 1 的可运行证据；真正的页面在阶段 3 实现（见 docs/game-ui-v1.md）。
 */
const state = computed(() => project(sampleGameLog()))
</script>

<template>
  <main class="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-5 py-10">
    <header class="flex flex-col gap-1">
      <h1 class="text-4xl font-bold tracking-tight">暗牌</h1>
      <p class="text-sm text-text-dim">
        {{ ROUNDS }} 轮 · 同时暗选 · 撞车归零 · 空位赏金累积
      </p>
    </header>

    <section class="rounded-[14px] border border-hairline bg-felt-raised p-5">
      <h2 class="mb-1 text-sm text-text-dim">规则引擎自检</h2>
      <p class="mb-4 text-xs text-text-dim">
        下面是规则文档 §8 的参照对局，由 <code>project()</code> 在浏览器内实时投影。
      </p>

      <p class="mb-4 text-xs">
        状态：<span class="text-bounty">{{ state.phase }}</span>
        · 已结算 {{ state.rounds.filter((r) => r.settled).length }} / {{ ROUNDS }} 轮
        · 日志缺口 {{ state.gaps.length }}
      </p>

      <ol class="flex flex-col gap-2">
        <li
          v-for="entry in state.ranking"
          :key="entry.seatId"
          class="flex items-baseline justify-between border-l-2 pl-3"
          :class="entry.rank === 1 ? 'border-bounty' : 'border-hairline'"
        >
          <span class="text-sm">
            <span class="tnum mr-2 text-text-dim">{{ entry.rank }}</span>
            {{ entry.nickname }}
          </span>
          <span class="tnum text-lg font-bold">{{ entry.score }}</span>
        </li>
      </ol>

      <p class="mt-4 text-xs text-text-dim">
        被罚次数：
        <span v-for="entry in state.ranking" :key="entry.seatId" class="tnum mr-3">
          {{ entry.nickname }} {{ entry.penalties }}
        </span>
      </p>
    </section>

    <footer class="text-xs text-text-dim">
      阶段 1 · 纯规则引擎已实现。页面与联机见
      <code>docs/game-implementation-plan-v1.md</code>。
    </footer>
  </main>
</template>
