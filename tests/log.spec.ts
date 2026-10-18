import { describe, expect, it } from 'vitest'
import { findGaps, normalizeLog } from '../src/core/log.ts'
import { FOUR_SEATS, LogBuilder, lobby } from './helpers.ts'

describe('日志规范化', () => {
  it('按 seq 升序排列，与输入顺序无关', () => {
    const log = lobby(FOUR_SEATS)
    log.playRound(1, { 's-a': 0, 's-b': 1, 's-c': 2, 's-d': 3 })
    const reversed = [...log.events].reverse()
    const normalized = normalizeLog(reversed)
    expect(normalized.events.map((e) => e.seq)).toEqual(
      [...log.events].map((e) => e.seq).sort((a, b) => a - b),
    )
  })

  it('丢弃重复事件并计数', () => {
    const log = lobby(FOUR_SEATS)
    const withDuplicates = [...log.events, ...log.events]
    const normalized = normalizeLog(withDuplicates)
    expect(normalized.events).toHaveLength(log.events.length)
    expect(normalized.duplicates).toBe(log.events.length)
  })

  it('连续 seq 无缺口', () => {
    const log = lobby(FOUR_SEATS)
    expect(normalizeLog(log.events).gaps).toEqual([])
  })

  it('识别 seq 缺口', () => {
    const log = lobby(FOUR_SEATS)
    const withHole = log.events.filter((e) => e.seq !== 3)
    expect(findGaps(normalizeLog(withHole).events)).toEqual([{ from: 3, to: 3 }])
  })

  it('识别跨多号缺口', () => {
    const log = lobby(FOUR_SEATS)
    const withHole = log.events.filter((e) => e.seq < 3 || e.seq > 6)
    expect(findGaps(normalizeLog(withHole).events)).toEqual([{ from: 3, to: 6 }])
  })

  it('空日志不产生缺口', () => {
    expect(normalizeLog([]).gaps).toEqual([])
  })
})

describe('缺口暴露到局面', () => {
  it('project() 把 gaps 透出，供调用方判断日志是否完整', () => {
    const log = new LogBuilder()
    log.join('s-a', 'A')
    log.join('s-b', 'B')
    log.join('s-c', 'C')
    const withHole = log.events.filter((e) => e.seq !== 2)
    expect(normalizeLog(withHole).gaps).toHaveLength(1)
  })
})
