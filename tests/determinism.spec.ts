import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { project } from '../src/core/rules.ts'
import { sampleGameLog } from '../src/core/sample-game.ts'
import { FOUR_SEATS, lobby, shuffled } from './helpers.ts'

describe('确定性', () => {
  it('同一份日志投影两次，结果深比较相等', () => {
    const log = lobby(FOUR_SEATS)
    for (let r = 1; r <= 4; r++) {
      log.playRound(r, { 's-a': r % 8, 's-b': (r + 1) % 8, 's-c': (r + 2) % 8, 's-d': (r + 3) % 8 })
    }
    expect(project(log.events)).toEqual(project(log.events))
  })

  it('打乱事件顺序后投影，结果与顺序输入相同', () => {
    const log = lobby(FOUR_SEATS)
    for (let r = 1; r <= 5; r++) {
      log.playRound(r, { 's-a': r % 8, 's-b': (r + 1) % 8, 's-c': (r + 2) % 8, 's-d': (r + 3) % 8 })
    }
    expect(project(shuffled(log.events, 7))).toEqual(project(log.events))
    expect(project(shuffled(log.events, 991))).toEqual(project(log.events))
  })

  it('含重复事件的日志投影结果不变', () => {
    const log = lobby(FOUR_SEATS)
    log.playRound(1, { 's-a': 0, 's-b': 1, 's-c': 2, 's-d': 3 })
    const doubled = [...log.events, ...log.events]
    expect(project(doubled)).toEqual(project(log.events))
  })

  it('参照对局投影两次结果相等', () => {
    expect(project(sampleGameLog())).toEqual(project(sampleGameLog()))
  })
})

/**
 * 判定逻辑中不得出现随机数与时钟。
 * 这是把「事件日志是唯一真相」从口号变成可执行检查的第二道防线
 * （第一道是 ESLint；这里保证即使 lint 被跳过，测试也会失败）。
 *
 * 注意：必须先剥掉注释再扫——规则文件顶部那句禁令本身含有这三个词。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('判定逻辑不含随机与时钟', () => {
  const FORBIDDEN = ['Math.random', 'Date.now', 'performance.now']
  const files = ['rules.ts', 'values.ts', 'log.ts']

  it.each(files)('src/core/%s 的代码（不含注释）不含随机数或时钟调用', (file) => {
    const path = fileURLToPath(new URL(`../src/core/${file}`, import.meta.url))
    const code = stripComments(readFileSync(path, 'utf8'))
    for (const token of FORBIDDEN) {
      expect(code, `${file} 不应出现 ${token}`).not.toContain(token)
    }
  })
})
