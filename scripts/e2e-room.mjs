/**
 * 阶段 2 端到端验证：用 Node 充当 3 个客户端，跑通「hello → ready → commit → reveal」。
 *
 * 验证点（对应实施计划阶段 2 的验收标准）：
 *   1. 三个客户端能进同一房间
 *   2. 全员准备后自动开局并收到 ROUND_OPEN
 *   3. 提交的哈希被服务器转发，且服务器事件里不含位置明文
 *   4. 揭示后各客户端投影出的局面一致
 */

const ORIGIN = process.env.ANPAI_ORIGIN ?? 'http://127.0.0.1:8787'
// 每次用唯一房间码：DO 状态会跨运行持久化，复用房间码会读到历史日志。
const ROOM = process.env.ANPAI_ROOM ?? `E2E${Date.now().toString(36).toUpperCase()}`

const WS_URL = `${ORIGIN.replace(/^http/, 'ws')}/parties/anpai-room/${ROOM}`

function seatIdFor(token) {
  return `seat-${token}`
}

async function commitHex(seatId, round, slotIndex, nonceHex) {
  const { createHash } = await import('node:crypto')
  const input = `${ROOM}|${round}|${seatId}|${slotIndex}|${nonceHex}`
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function makeClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    const state = { name, events: [], welcome: null, ws, logReceived: false }
    const timer = setTimeout(() => reject(new Error(`${name} 连接超时`)), 15000)

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'hello', seatId: seatIdFor(name), nickname: name }))
    })
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.t === 'welcome') {
        state.welcome = msg
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const results = []
  const check = (label, ok, detail = '') => {
    results.push({ label, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  }

  // 1. 三个客户端进房
  const names = ['ann', 'bob', 'cyn']
  const clients = []
  for (const name of names) {
    clients.push(await makeClient(name))
  }
  check('三个客户端进房并收到 welcome + 全量日志', clients.every((c) => c.logReceived))

  // 2. 全员准备 → 自动开局
  for (const c of clients) c.ws.send(JSON.stringify({ t: 'ready', ready: true }))
  await sleep(1200)
  const opens = clients[0].events.filter((e) => e.type === 'ROUND_OPEN')
  check(
    '全员准备后自动开局（收到 ROUND_OPEN）',
    opens.length === 1,
    `opens=${opens.length} seqs=[${opens.map((e) => e.seq).join(',')}] rounds=[${opens
      .map((e) => e.payload?.round)
      .join(',')}]`,
  )

  // 3. 提交
  const slots = { ann: 0, bob: 1, cyn: 2 }
  const nonces = {}
  for (const c of clients) {
    const seatId = seatIdFor(c.name)
    const nonce = 'a'.repeat(31) + String(names.indexOf(c.name))
    nonces[c.name] = nonce
    const hash = await commitHex(seatId, 1, slots[c.name], nonce)
    c.ws.send(JSON.stringify({ t: 'commit', round: 1, commit: hash }))
  }
  await sleep(1000)
  const commitEvents = clients[0].events.filter((e) => e.type === 'COMMIT')
  check('三条 COMMIT 被转发', commitEvents.length === 3)

  const serialized = JSON.stringify(commitEvents.map((e) => e.payload))
  const leaksSlot = /slot|位/.test(serialized)
  check('COMMIT 负载不含位置明文（服务器不知道你选了什么）', !leaksSlot, serialized.slice(0, 80))

  // 4. 揭示
  for (const c of clients) {
    c.ws.send(
      JSON.stringify({
        t: 'reveal',
        round: 1,
        slotIndex: slots[c.name],
        nonceHex: nonces[c.name],
      }),
    )
  }
  await sleep(1200)
  const revealEvents = clients[0].events.filter((e) => e.type === 'REVEAL')
  check('三条 REVEAL 被转发', revealEvents.length === 3)

  // 5. 各客户端日志一致
  const seqSets = clients.map((c) => c.events.map((e) => e.seq).join(','))
  check('三个客户端的日志序号序列一致', new Set(seqSets).size === 1, seqSets[0]?.slice(0, 40))

  // 5b. 真实网络日志 → 纯函数投影：三个客户端必须算出同一局面
  await sleep(600)
  const { project } = await import('../src/core/rules.ts')
  const projections = clients.map((c) => project(c.events))
  const scores = projections.map((s) =>
    Object.fromEntries(s.players.map((p) => [p.nickname, p.score])),
  )
  const same = JSON.stringify(scores[0]) === JSON.stringify(scores[1]) &&
               JSON.stringify(scores[1]) === JSON.stringify(scores[2])
  check('三个客户端投影出的局面一致', same, JSON.stringify(scores[0]))

  const settled = projections[0].rounds[0]?.settled === true
  check('第 1 轮已结算', settled)

  // 3 人 6 格，位 0/1/2 各被独占一次（基础 4/4/5）；位 3/4/5 空置 → 赏金 +1
  const expected = { ann: 4, bob: 4, cyn: 5 }
  const actual = scores[0] ?? {}
  const scoresOk = ['ann','bob','cyn'].every((n) => actual[n] === expected[n])
  check('结算分数正确（4 / 4 / 5）', scoresOk, JSON.stringify(actual))

  const bounty = projections[0].rounds[0]?.bountyAfter ?? []
  check('空位赏金各 +1', bounty[3] === 1 && bounty[4] === 1 && bounty[5] === 1, JSON.stringify(bounty))

  // 6. 服务器下发的日志无缺口
  const seqs = clients[0].events.map((e) => e.seq).sort((a, b) => a - b)
  const contiguous = seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1)
  check('服务器分配的 seq 连续无缺口', contiguous, `共 ${seqs.length} 条`)

  for (const c of clients) c.ws.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('E2E 失败：', err.message)
  process.exit(1)
})
