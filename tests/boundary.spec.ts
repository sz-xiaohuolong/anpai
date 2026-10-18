import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 架构边界检查：把 AGENTS.md §6 硬约束 1 变成每次测试都会执行的断言。
 *
 * 「src/core 必须是可在 Node 中直接运行的纯 TypeScript」——
 * 这条纪律如果只写在文档里，迟早会被一次随手的 import 破坏。
 *
 * 注：实施计划里原本写的是用 ESLint 规则实现同一目的。这里改为测试实现，
 * 因为测试在 CI 与本地都必然执行，不依赖 lint 是否被跳过。ESLint 层见 PROGRESS 的说明。
 */

const CORE_DIR = fileURLToPath(new URL('../src/core', import.meta.url))

function coreFiles(): string[] {
  return readdirSync(CORE_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `${CORE_DIR}/${name}`)
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 禁止出现在 core 中的 import 目标。 */
const FORBIDDEN_IMPORTS = [
  'vue',
  'pinia',
  'node:fs',
  'node:path',
  'node:url',
  'node:http',
  'node:net',
  'ws',
  'partyserver',
]

/** 禁止出现在 core 中的浏览器/宿主专有全局。 */
const FORBIDDEN_GLOBALS = [
  'document.',
  'window.',
  'localStorage',
  'sessionStorage',
  'WebSocket',
  'fetch(',
  'navigator.',
]

describe('架构边界：src/core 保持纯净', () => {
  const files = coreFiles()

  it('至少存在若干 core 模块（防止 glob 失效导致空跑）', () => {
    expect(files.length).toBeGreaterThanOrEqual(5)
  })

  it.each(files)('%s 不 import 框架、Node 或网络模块', (path) => {
    const code = stripComments(readFileSync(path, 'utf8'))
    const importTargets = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    for (const target of importTargets) {
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(target, `${path} 不应 import ${target}`).not.toBe(forbidden)
      }
      // 只允许 core 内部相对引用
      if (target.startsWith('.')) {
        expect(target, `${path} 的相对引用不得逃出 core：${target}`).not.toMatch(/\.\.\/\.\.\//)
      }
    }
  })

  it.each(files)('%s 不触碰浏览器专有全局', (path) => {
    const code = stripComments(readFileSync(path, 'utf8'))
    for (const token of FORBIDDEN_GLOBALS) {
      expect(code, `${path} 不应出现 ${token}`).not.toContain(token)
    }
  })
})
