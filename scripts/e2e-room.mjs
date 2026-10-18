/**
 * 端到端验证：用 Node 充当 3 个客户端，跑完一整局并验证重开。
 *
 * 覆盖：
 *   1. 三个客户端进房
 *   2. 全员准备后自动开局
 *   3. 提交的哈希被转发，服务器事件里不含位置明文
 *   4. 揭示后各客户端投影一致、结算正确、赏金正确
 *   5. 打满 8 轮后「再来一局」回到未开局状态，并能重新开局
 *
 * 需要先起 `pnpm dev:room`。可用 ANPAI_ORIGIN 指向 Vite 端口以同时验证代理。
 */

const ORIGIN = process.env.ANPAI_ORIGIN ?? 'http://127.0.0.1:8787'
// DO 状态跨运行持久化，复用房间码会读到历史日志，因此每次生成唯一房间码。
const ROOM = process.env.ANPAI_ROOM ?? `E2E${Date.now().toString(36).toUpperCase()}`

const WS_URL = `${ORIGIN.replace(/^http/, 'ws')}/parties/anpai-room/${ROOM}`

const ROUNDS = 8
/** 与 party/coordination.ts 的 ROUND_INTERMISSION_MS 保持一致。 */
const INTERMISSION_MS = 5_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const seatIdFor = (token) => `seat-${token}`

async function commitHex(seatId, round, slotIndex, nonceHex) {
  const { createHash } = await import('node:crypto')
  const input = `${ROOM}|${round}|${seatId}|${slotIndex}|${nonceHex}`
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function makeClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    const state = { name, events: [], ws, logReceived: false }
    const timer = setTimeout(() => reject(new Error(`${name} 连接超时`)), 15000)

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'hello', seatId: seatIdFor(name), nickname: name }))
    })
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.t === 'welcome') {
        state.events = [...msg.log]
        state.logReceived = true
        clearTimeout(timer)
        resolve(state)
      } else if (msg.t === 'event') {
        state.events.push(msg.event)
      }
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`${name} WebSocket 错误`))
    })
  })
}

async function main() {
  const results = []
  const check = (label, ok, detail = '') => {
    results.push({ label, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  }

  const { project } = await import('../src/core/rules.ts')
  const names = ['ann', 'bob', 'cyn']
  const clients = []
  for (const name of names) clients.push(await makeClient(name))
  check('三个客户端进房并收到 welcome + 全量日志', clients.every((c) => c.logReceived))

  // 全员准备 → 自动开局。
  // 不用固定 sleep：机器负载高时它会漏掉轮次，让测试变成随机失败。
  const waitForPhase = async (label, predicate, tries = 120) => {
    for (let i = 0; i < tries; i++) {
      if (predicate(project(clients[0].events))) return
      await sleep(250)
    }
    throw new Error(`等待超时：${label}`)
  }

  for (const c of clients) c.ws.send(JSON.stringify({ t: 'ready', ready: true }))
  await waitForPhase('第 1 轮进入提交阶段', (s) => s.phase === 'COMMITTING' && s.round === 1)
  const opens = clients[0].events.filter((e) => e.type === 'ROUND_OPEN')
  check('全员准备后自动开局（收到 ROUND_OPEN）', opens.length === 1, `opens=${opens.length}`)

  /** 固定选位：ann→0, bob→1, cyn→2，因此每轮得分固定为 4 / 4 / 5。 */
  const slots = { ann: 0, bob: 1, cyn: 2 }
  const nonceFor = (name, round) =>
    `${String(round).padStart(2, '0')}${'a'.repeat(30)}${names.indexOf(name)}`

  async function playRound(round) {
    for (const c of clients) {
      const hash = await commitHex(seatIdFor(c.name), round, slots[c.name], nonceFor(c.name, round))
      c.ws.send(JSON.stringify({ t: 'commit', round, commit: hash }))
    }
    await sleep(400)
    for (const c of clients) {
      c.ws.send(
        JSON.stringify({
          t: 'reveal',
          round,
          slotIndex: slots[c.name],
          nonceHex: nonceFor(c.name, round),
        }),
      )
    }
    await sleep(500)
  }

  await playRound(1)

  const commitEvents = clients[0].events.filter((e) => e.type === 'COMMIT')
  check('第 1 轮三条 COMMIT 被转发', commitEvents.length === 3)

  const serialized = JSON.stringify(commitEvents.map((e) => e.payload))
  check(
    'COMMIT 负载不含位置明文（服务器不知道你选了什么）',
    !/slot|位/.test(serialized),
    serialized.slice(0, 64),
  )

  const revealEvents = clients[0].events.filter((e) => e.type === 'REVEAL')
  check('第 1 轮三条 REVEAL 被转发', revealEvents.length === 3)

  const seqSets = clients.map((c) => c.events.map((e) => e.seq).join(','))
  check('三个客户端的日志序号序列一致', new Set(seqSets).size === 1)

  const firstProjection = project(clients[0].events)
  const firstScores = Object.fromEntries(firstProjection.players.map((p) => [p.nickname, p.score]))
  check(
    '第 1 轮结算正确（4 / 4 / 5）',
    JSON.stringify(firstScores) === JSON.stringify({ ann: 4, bob: 4, cyn: 5 }),
    JSON.stringify(firstScores),
  )
  check(
    '第 1 轮空位赏金各 +1',
    [3, 4, 5].every((i) => firstProjection.rounds[0].bountyAfter[i] === 1),
    JSON.stringify(firstProjection.rounds[0].bountyAfter),
  )

  // 打满 8 轮：每轮都等到真正进入提交阶段再操作
  for (let round = 2; round <= ROUNDS; round++) {
    await waitForPhase(`第 ${round} 轮进入提交阶段`, (s) => s.phase === 'COMMITTING' && s.round === round)
    await playRound(round)
  }
  await waitForPhase('第 8 轮结算完成', (s) => s.phase === 'GAME_OVER')

  const finished = clients.map((c) => project(c.events))
  const scoreOf = (s) => JSON.stringify(s.players.map((p) => p.score))
  check('打满 8 轮后三个客户端投影仍一致', finished.every((s) => scoreOf(s) === scoreOf(finished[0])))
  check('打满 8 轮进入 GAME_OVER', finished[0].phase === 'GAME_OVER', `phase=${finished[0].phase}`)

  const finalScores = Object.fromEntries(finished[0].players.map((p) => [p.nickname, p.score]))
  check(
    '总分正确（32 / 32 / 40）',
    JSON.stringify(finalScores) === JSON.stringify({ ann: 32, bob: 32, cyn: 40 }),
    JSON.stringify(finalScores),
  )

  const seqs = clients[0].events.map((e) => e.seq).sort((a, b) => a - b)
  check('seq 连续无缺口', seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), `共 ${seqs.length} 条`)

  // 再来一局
  clients[0].ws.send(JSON.stringify({ t: 'reset' }))
  await sleep(900)
  const afterReset = clients.map((c) => project(c.events))
  check(
    '重开后回到未开局状态',
    afterReset.every((s) => s.phase === 'LOBBY' && s.rounds.length === 0),
    `phase=${afterReset[0].phase} rounds=${afterReset[0].rounds.length}`,
  )

  for (const c of clients) c.ws.send(JSON.stringify({ t: 'ready', ready: true }))
  await sleep(1000)
  const reopened = clients.map((c) => project(c.events))
  check(
    '重开后能再次开局，且从第 1 轮开始',
    reopened.every((s) => s.phase === 'COMMITTING' && s.round === 1),
    `phase=${reopened[0].phase} round=${reopened[0].round}`,
  )

  for (const c of clients) c.ws.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('E2E 失败：', err.message)
  process.exit(1)
})
