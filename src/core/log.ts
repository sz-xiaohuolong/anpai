/**
 * 日志规范化：规范顺序、去重、缺口检测。
 *
 * 规范顺序 = seq 升序。去重键 = seq（服务器保证全局唯一）。
 * 见 docs/game-architecture-v1.md §4。
 */

import type { GameEvent } from './types.ts'

export interface NormalizedLog {
  /** 按 seq 升序、已去重的完整事件列表。 */
  events: readonly GameEvent[]
  /** 缺失的 seq 区间。非空表示日志不完整，调用方应先补齐再投影。 */
  gaps: readonly { from: number; to: number }[]
  /** 被丢弃的重复事件数。 */
  duplicates: number
}

/**
 * 规范化日志。可安全地对任意顺序、含重复的输入调用。
 */
export function normalizeLog(raw: readonly GameEvent[]): NormalizedLog {
  const bySeq = new Map<number, GameEvent>()
  let duplicates = 0

  for (const event of raw) {
    if (bySeq.has(event.seq)) {
      duplicates++
      continue
    }
    bySeq.set(event.seq, event)
  }

  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq)

  return { events, gaps: findGaps(events), duplicates }
}

/**
 * 找出 seq 序列中的缺口。
 *
 * 注意：seq 由服务器单调分配，因此**任何**缺口都表示日志不完整，
 * 与事件的 author 无关。早期设计曾按 author 分组检测，那是错的——
 * 服务器分配的是全局序号，不是每席位序号。
 */
export function findGaps(events: readonly GameEvent[]): { from: number; to: number }[] {
  const gaps: { from: number; to: number }[] = []
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]!.seq
    const curr = events[i]!.seq
    if (curr > prev + 1) {
      gaps.push({ from: prev + 1, to: curr - 1 })
    }
  }
  return gaps
}

/** 返回指定轮次的事件（不含 ROUND_OPEN 之外的跨轮事件）。 */
export function eventsForRound(events: readonly GameEvent[], round: number): GameEvent[] {
  return events.filter((e) => 'round' in e.payload && e.payload.round === round)
}
