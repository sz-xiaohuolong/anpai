/**
 * 机器人端到端验证。
 *
 * A 部分：授权边界
 *   - 只有房主能添加机器人
 *   - 只有房主能代机器人提交/揭示
 *
 * B 部分：**机器人公平性回归**
 *   1 真人 + 3 机器人，用与房主浏览器完全相同的调用方式（各自独立按均衡概率抽样）
 *   打满 8 轮。断言机器人**既不是永远互撞、也不是永不互撞**——
 *   「永不互撞」等于机器人之间完美协同，真人做不到，对玩家不公平。
 *
 * 需要先起 `pnpm dev:room`。
 */

const ORIGIN = process.env.ANPAI_ORIGIN ?? 'http://127.0.0.1:8787'
const BASE = process.env.ANPAI_ROOM ?? `BOT${Date.now().toString(36).toUpperCase()}`
const ROOM_A = `${BASE}A`
const ROOM_B = `${BASE}B`

const ROUNDS = 8
const INTERMISSION_MS = 5_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 轮询等待条件成立，而不是睡固定时长。
 *
 * 两个理由：
 *  1. 等待的应该是**条件**，不是时长——服务端慢时固定 sleep 会误报失败。
 *  2. 断言失败时能打印出到底卡在哪一步（WARN 行），而不是只看到一个数字不对。
 *
 * 注意：**不要在 `wrangler dev` 运行时紧接 `pnpm build` 跑本脚本**。重建 `dist/`
 * 会触发 worker 重载，把正在进行中的房间打断（表现为 A 部分停在 LOBBY、
 * 或机器人 JOIN 丢失）。等几秒让重载结束再跑。
 */
async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  console.log(`WARN  等待超时：${label}（${timeoutMs}ms）`)
  return false
}
const seatIdFor = (name) => `seat-${name}`

async function commitHex(room, seatId, round, slotIndex, nonceHex) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256')
    .update(`${room}|${round}|${seatId}|${slotIndex}|${nonceHex}`, 'utf8')
    .digest('hex')
}

function connect(room, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${ORIGIN.replace(/^http/, 'ws')}/parties/anpai-room/${room}`)
    const state = { room, name, events: [], errors: [], ws }
    const timer = setTimeout(() => reject(new Error(`${name}@${room} 连接超时`)), 15000)
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
  const { chooseSlot } = await import('../src/core/bot.ts')

  // ── A 部分：授权边界 ──────────────────────────────────────────
  console.log('── A 授权边界 ──')
  const host = await connect(ROOM_A, 'ann')
  const guest = await connect(ROOM_A, 'bob')

  // 两条「被拒绝」断言都是否定式：不能靠 sleep 猜，要靠「后发的合法消息已被处理」
  // 来证明先发的非法消息一定也已经处理过——同一个 DO 上的消息是顺序处理的。
  guest.ws.send(JSON.stringify({ t: 'addBot' }))
  host.ws.send(JSON.stringify({ t: 'addBot' }))
  await waitFor(() => project(host.events).players.length === 3, '房主添加机器人')
  check('非房主添加机器人被拒绝', guest.errors.length === 1, guest.errors[0] ?? '无错误')

  const withBot = project(host.events)
  check('房主可以添加机器人', withBot.players.length === 3, `players=${withBot.players.length}`)
  const bot = withBot.players.find((p) => p.bot)
  check('机器人席位带 bot 标记', bot !== undefined, bot?.nickname ?? '未找到')
  if (!bot) {
    // 前置条件不成立时直接退出：后面的断言都会失去意义，且会抛 TypeError 掩盖真因。
    console.log('\n前置条件不成立（没有机器人席位），A 部分后续断言无法进行。')
    host.ws.close()
    guest.ws.close()
    process.exit(1)
  }

  const botSeat = bot.seatId
  const nonce = 'b'.repeat(32)
  const hash = await commitHex(ROOM_A, botSeat, 1, 2, nonce)

  // 必须先开局才能测提交：未开局时任何提交都会被拒，断言会「蒙对」。
  host.ws.send(JSON.stringify({ t: 'ready', ready: true }))
  guest.ws.send(JSON.stringify({ t: 'ready', ready: true }))
  await waitFor(() => {
    const s = project(host.events)
    return s.phase === 'COMMITTING' && s.round === 1
  }, '全员准备后开局')
  const startedA = project(host.events)
  check(
    '2 真人 + 1 机器人即可开局',
    startedA.phase === 'COMMITTING' && startedA.round === 1,
    `phase=${startedA.phase} round=${startedA.round}`,
  )

  guest.ws.send(JSON.stringify({ t: 'commit', round: 1, commit: hash, forSeat: botSeat }))
  host.ws.send(JSON.stringify({ t: 'commit', round: 1, commit: hash, forSeat: botSeat }))
  await waitFor(
    () => project(host.events).rounds[0]?.committed.includes(botSeat) === true,
    '房主代机器人提交',
  )
  check('非房主代机器人提交被拒绝', guest.errors.length === 2, guest.errors[1] ?? '无错误')

  check(
    '房主可以代机器人提交',
    project(host.events).rounds[0]?.committed.includes(botSeat) === true,
    JSON.stringify(project(host.events).rounds[0]?.committed),
  )
  host.ws.close()
  guest.ws.close()

  // ── B 部分：机器人公平性回归 ──────────────────────────────────
  console.log('\n── B 机器人公平性回归（1 真人 + 3 机器人，8 轮）──')
  const solo = await connect(ROOM_B, 'solo')
  for (let i = 0; i < 3; i++) solo.ws.send(JSON.stringify({ t: 'addBot' }))
  await waitFor(
    () => project(solo.events).players.filter((p) => p.bot).length === 3,
    '添加 3 个机器人',
  )
  solo.ws.send(JSON.stringify({ t: 'ready', ready: true }))
  await waitFor(() => {
    const s = project(solo.events)
    return s.phase === 'COMMITTING' && s.round === 1
  }, '1 真人 + 3 机器人开局')

  const botSeats = project(solo.events)
    .players.filter((p) => p.bot)
    .map((p) => p.seatId)
  check('1 真人 + 3 机器人开局', botSeats.length === 3, `bots=${botSeats.join(',')}`)

  const HUMAN_SLOT = 0
  const nonceFor = (seat, round) =>
    `${String(round).padStart(2, '0')}${'d'.repeat(28)}${String(seat).slice(-1)}`
  const roundBotSlots = []
  const soloSeat = seatIdFor('solo')

  for (let round = 1; round <= ROUNDS; round++) {
    // 等到本轮真正进入提交阶段
    const inCommit = await waitFor(() => {
      const s = project(solo.events)
      return s.round === round && s.phase === 'COMMITTING'
    }, `第 ${round} 轮进入提交阶段`, 30_000)
    if (!inCommit) throw new Error(`第 ${round} 轮没有进入提交阶段`)

    const state = project(solo.events)
    const plan = { [soloSeat]: HUMAN_SLOT }

    // 与房主浏览器完全相同的调用方式：各自独立，不共享任何「已占位」信息
    for (const seat of botSeats) {
      const slot = chooseSlot(state, { seatId: seat, roomCode: ROOM_B })
      if (slot === null) throw new Error(`第 ${round} 轮 ${seat} 无选择`)
      plan[seat] = slot
    }
    roundBotSlots.push(botSeats.map((seat) => plan[seat]))

    const seatsThisRound = Object.keys(plan)
    for (const [seat, slot] of Object.entries(plan)) {
      const forSeat = seat === soloSeat ? undefined : seat
      const h = await commitHex(ROOM_B, seat, round, slot, nonceFor(seat, round))
      solo.ws.send(JSON.stringify({ t: 'commit', round, commit: h, forSeat }))
    }
    // 等四条提交都被服务端接收，再揭示——固定 sleep 会漏掉慢路径
    await waitFor(
      () => (project(solo.events).rounds[round - 1]?.committed.length ?? 0) === seatsThisRound.length,
      `第 ${round} 轮四条提交到齐`,
    )
    for (const [seat, slot] of Object.entries(plan)) {
      const forSeat = seat === soloSeat ? undefined : seat
      solo.ws.send(
        JSON.stringify({
          t: 'reveal',
          round,
          slotIndex: slot,
          nonceHex: nonceFor(seat, round),
          forSeat,
        }),
      )
    }
    // 等本轮真正结算，再进入下一轮——否则下一轮的开局等待会白等 5 秒间隔
    await waitFor(
      () => project(solo.events).rounds[round - 1]?.settled === true,
      `第 ${round} 轮结算`,
    )
  }

  await waitFor(() => project(solo.events).phase === 'GAME_OVER', '打满 8 轮进入 GAME_OVER')
  const final = project(solo.events)
  check('打满 8 轮进入 GAME_OVER', final.phase === 'GAME_OVER', `phase=${final.phase}`)

  // 机器人现在各自独立按均衡概率抽样，因此**既不该永远互撞，也不该永不互撞**。
  // 「永不互撞」= 完美协同，真人做不到，对玩家不公平（这是上一版被推翻的设计）。
  const distinctRounds = roundBotSlots.filter((slots) => new Set(slots).size === slots.length)
  check(
    '机器人不是永远互撞（存在全员各占一位的轮次）',
    distinctRounds.length >= 1,
    `各占一位的轮次 ${distinctRounds.length}/8`,
  )

  const botRoundPenalties = botSeats.reduce(
    (sum, seat) => sum + final.players.find((p) => p.seatId === seat).penalties,
    0,
  )
  check(
    '机器人也不是永不互撞（8 轮里存在撞车）',
    botRoundPenalties >= 1,
    `机器人累计被罚 ${botRoundPenalties} 次`,
  )

  const scoredSeats = final.players.filter((p) => p.score > 0).length
  check('四个席位都拿到过分', scoredSeats === 4, `${scoredSeats}/4`)

  console.log('   8 轮机器人落点:', JSON.stringify(roundBotSlots))

  solo.ws.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('机器人 E2E 失败：', err.message)
  process.exit(1)
})
