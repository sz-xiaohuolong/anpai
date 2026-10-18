/**
 * 机器人端到端验证。
 *
 * 重点不是机器人策略（那有单测），而是**服务端的授权边界**：
 *   - 只有房主能添加机器人
 *   - 只有房主能代机器人提交/揭示
 *   - 2 个真人 + 1 个机器人可以开局
 *
 * 需要先起 `pnpm dev:room`。
 */

const ORIGIN = process.env.ANPAI_ORIGIN ?? 'http://127.0.0.1:8787'
const ROOM = process.env.ANPAI_ROOM ?? `BOT${Date.now().toString(36).toUpperCase()}`
const WS_URL = `${ORIGIN.replace(/^http/, 'ws')}/parties/anpai-room/${ROOM}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const seatIdFor = (name) => `seat-${name}`

async function commitHex(seatId, round, slotIndex, nonceHex) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256')
    .update(`${ROOM}|${round}|${seatId}|${slotIndex}|${nonceHex}`, 'utf8')
    .digest('hex')
}

function makeClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    const state = { name, events: [], errors: [], ws }
    const timer = setTimeout(() => reject(new Error(`${name} 连接超时`)), 15000)
    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ t: 'hello', seatId: seatIdFor(name), nickname: name })),
    )
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.t === 'welcome') {
        state.events = [...msg.log]
        clearTimeout(timer)
        resolve(state)
      } else if (msg.t === 'event') {
        state.events.push(msg.event)
      } else if (msg.t === 'error') {
        state.errors.push(msg.message)
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
    results.push({ label, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  }

  const { project } = await import('../src/core/rules.ts')
  const host = await makeClient('ann')
  const guest = await makeClient('bob')

  // 非房主添加机器人 → 被拒
  guest.ws.send(JSON.stringify({ t: 'addBot' }))
  await sleep(500)
  check('非房主添加机器人被拒绝', guest.errors.length === 1, guest.errors[0] ?? '无错误')

  // 房主添加机器人
  host.ws.send(JSON.stringify({ t: 'addBot' }))
  await sleep(700)
  const withBot = project(host.events)
  check('房主可以添加机器人', withBot.players.length === 3, `players=${withBot.players.length}`)
  const bot = withBot.players.find((p) => p.bot)
  check('机器人席位带 bot 标记', bot !== undefined, bot?.nickname ?? '未找到')

  // 2 真人 + 1 机器人 → 可以开局
  host.ws.send(JSON.stringify({ t: 'ready', ready: true }))
  guest.ws.send(JSON.stringify({ t: 'ready', ready: true }))
  await sleep(1000)
  const started = project(host.events)
  check(
    '2 真人 + 1 机器人即可开局',
    started.phase === 'COMMITTING' && started.round === 1,
    `phase=${started.phase} round=${started.round}`,
  )

  // 非房主代机器人提交 → 被拒
  const botSeat = bot.seatId
  const nonce = 'b'.repeat(32)
  const hash = await commitHex(botSeat, 1, 2, nonce)
  guest.ws.send(JSON.stringify({ t: 'commit', round: 1, commit: hash, forSeat: botSeat }))
  await sleep(500)
  check('非房主代机器人提交被拒绝', guest.errors.length === 2, guest.errors[1] ?? '无错误')

  // 房主代机器人提交 → 接受
  host.ws.send(JSON.stringify({ t: 'commit', round: 1, commit: hash, forSeat: botSeat }))
  await sleep(500)
  const afterCommit = project(host.events)
  check(
    '房主可以代机器人提交',
    afterCommit.rounds[0]?.committed.includes(botSeat) === true,
    JSON.stringify(afterCommit.rounds[0]?.committed),
  )

  // 真人各自提交
  for (const [client, slot] of [[host, 0], [guest, 1]]) {
    const sid = seatIdFor(client.name)
    const n = `${'c'.repeat(30)}${slot}${client.name === 'ann' ? 0 : 1}`
    const h = await commitHex(sid, 1, slot, n)
    client.pending = { slot, nonce: n }
    client.ws.send(JSON.stringify({ t: 'commit', round: 1, commit: h }))
  }
  await sleep(700)
  check('全员提交后进入揭示阶段', project(host.events).phase === 'REVEALING')

  // 揭示
  host.ws.send(JSON.stringify({ t: 'reveal', round: 1, slotIndex: 2, nonceHex: nonce, forSeat: botSeat }))
  for (const client of [host, guest]) {
    const sid = seatIdFor(client.name)
    client.ws.send(
      JSON.stringify({
        t: 'reveal',
        round: 1,
        slotIndex: client.pending.slot,
        nonceHex: client.pending.nonce,
      }),
    )
    void sid
  }
  await sleep(900)

  const settled = project(host.events)
  check('第 1 轮结算完成', settled.rounds[0]?.settled === true)
  check(
    '机器人独占位 2 并得分',
    settled.rounds[0]?.capturedBy[2] === botSeat,
    `capturedBy[2]=${settled.rounds[0]?.capturedBy[2]}`,
  )
  const botPlayer = settled.players.find((p) => p.seatId === botSeat)
  check('机器人分数正确（3 人 6 格，位 2 = 5 分）', botPlayer.score === 5, `score=${botPlayer.score}`)

  host.ws.close()
  guest.ws.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('机器人 E2E 失败：', err.message)
  process.exit(1)
})
