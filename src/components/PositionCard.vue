<script setup lang="ts">
/**
 * 位置卡片 —— 整个游戏最重要的组件。
 *
 * 信息层级（见 docs/game-ui-v1.md §3.1）：
 *   「有效价值」是最大的数字，「基础 + 赏金」是它的解释。
 * 反过来会让玩家只盯不变的基础价值，正好是核心机制失效的路径。
 */
import type { CardState } from './card-state.ts'

const props = defineProps<{
  slotIndex: number
  baseValue: number
  bounty: number
  state: CardState
  winnerName?: string
  colliderNames?: readonly string[]
  disabled?: boolean
}>()

const emit = defineEmits<{ select: [slotIndex: number] }>()

const effective = () => props.baseValue + props.bounty

const ringClass = () => {
  if (props.state === 'selected') return 'ring-2 ring-focus'
  if (props.state === 'captured') return 'border-l-4 border-l-capture'
  if (props.state === 'collided') return 'border-l-4 border-l-collide'
  return ''
}

const dimClass = () => {
  if (props.state === 'locked') return 'opacity-60'
  if (props.state === 'empty') return 'opacity-35'
  return ''
}

const label = () => {
  if (props.state === 'captured') return `✓ ${props.winnerName ?? ''}`
  if (props.state === 'collided') return `✕ ${(props.colliderNames ?? []).join(' ')}`
  if (props.state === 'empty') return '○ 无人问津'
  if (props.state === 'locked') return '已锁定'
  if (props.state === 'selected') return '已选'
  return ''
}

function onClick() {
  if (props.disabled) return
  if (props.state !== 'idle') return
  emit('select', props.slotIndex)
}
</script>

<template>
  <button
    type="button"
    class="flex min-h-[112px] flex-col items-stretch justify-between rounded-[10px] bg-card px-3 py-2.5 text-left text-card-ink transition duration-150 disabled:cursor-default"
    :class="[ringClass(), dimClass()]"
    :disabled="disabled || state !== 'idle'"
    @click="onClick"
  >
    <span class="text-[11px] text-card-ink-dim">位 {{ slotIndex }}</span>

    <span class="tnum text-[40px] leading-none font-bold">{{ effective() }}</span>

    <span class="flex items-baseline justify-between text-[13px]">
      <span class="text-card-ink-dim">基础 {{ baseValue }}</span>
      <span v-if="bounty > 0" class="tnum font-semibold text-bounty">+{{ bounty }} 赏金</span>
    </span>

    <span v-if="label()" class="mt-1 truncate text-[11px] text-card-ink-dim">{{ label() }}</span>
  </button>
</template>
