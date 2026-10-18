/**
 * 机器人端到端验证。
 *
 * A 部分：授权边界
 *   - 只有房主能添加机器人
 *   - 只有房主能代机器人提交/揭示
 *
 * B 部分：**机器人互撞回归**
 *   1 真人 + 3 机器人，用与房主浏览器完全相同的「依次决策 + 累积 reserved」
 *   方式打满 8 轮，断言三个机器人从不选中同一个位置。
 *   这是「三个机器人每次都撞」那个 bug 的端到端回归。
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

  guest.ws.send(JSON.stringify({ t: 'addBot' }))
  await sleep(500)
  check('非房主添加机器人被拒绝', guest.errors.length === 1, guest.errors[0] ?? '无错误')

  host.ws.send(JSON.stringify({ t: 'addBot' }))
  await sleep(700)
  const withBot = project(host.events)
  check('房主可以添加机器人', withBot.players.length === 3, `players=${withBot.players.length}`)
  const bot = withBot.players.find((p) => p.bot)
  check('机器人席位带 bot 标记', bot !== undefined, bot?.nickname ?? '未找到')

  const botSeat = bot.seatId
  const nonce = 'b'.repeat(32)
  const hash = await commitHex(ROOM_A, botSeat, 1, 2, nonce)

  // 必须先开局才能测提交：未开局时任何提交都会被拒，断言会「蒙对」。
  host.ws.send(JSON.stringify({ t: 'ready', ready: true }))
  guest.ws.send(JSON.stringify({ t: 'ready', ready: true }))
  await sleep(1000)
  const startedA = project(host.events)
  check(
    '2 真人 + 1 机器人即可开局',
    startedA.phase === 'COMMITTING' && startedA.round === 1,
    `phase=${startedA.phase} round=${startedA.round}`,
  )

  guest.ws.send(JSON.stringify({ t: 'commit', round: 1, commit: hash, forSeat: botSeat }))
  await sleep(500)
  check('非房主代机器人提交被拒绝', guest.errors.length === 2, guest.errors[1] ?? '无错误')

  host.ws.send(JSON.stringify({ t: 'commit', round: 1, commit: hash, forSeat: botSeat }))
  await sleep(500)
  check(
    '房主可以代机器人提交',
    project(host.events).rounds[0]?.committed.includes(botSeat) === true,
    JSON.stringify(project(host.events).rounds[0]?.committed),
  )
  host.ws.close()
  guest.ws.close()

  // ── B 部分：三个机器人互撞回归 ────────────────────────────────
  console.log('\n── B 机器人互撞回归（1 真人 + 3 机器人，8 轮）──')
  const solo = await connect(ROOM_B, 'solo')
  for (let i = 0; i < 3; i++) {
    solo.ws.send(JSON.stringify({ t: 'addBot' }))
    await sleep(300)
  }
  solo.ws.send(JSON.stringify({ t: 'ready', ready: true }))
  await sleep(1200)

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
    let guard = 0
    while (!(project(solo.events).round === round && project(solo.events).phase === 'COMMITTING')) {
      await sleep(250)
      if (guard++ > 120) throw new Error(`第 ${round} 轮没有进入提交阶段`)
    }

    const state = project(solo.events)
    const reserved = []
    const plan = { [soloSeat]: HUMAN_SLOT }

    // 与房主浏览器完全相同的顺序决策方式
    for (const seat of botSeats) {
      const slot = chooseSlot(state, { reserved })
      if (slot === null) throw new Error(`第 ${round} 轮 ${seat} 无选择`)
      reserved.push(slot)
      plan[seat] = slot
    }
    roundBotSlots.push([...reserved])

    for (const [seat, slot] of Object.entries(plan)) {
      const forSeat = seat === soloSeat ? undefined : seat
      const h = await commitHex(ROOM_B, seat, round, slot, nonceFor(seat, round))
      solo.ws.send(JSON.stringify({ t: 'commit', round, commit: h, forSeat }))
    }
    await sleep(400)
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
    await sleep(600)
  }

  await sleep(800)
  const final = project(solo.events)
  check('打满 8 轮进入 GAME_OVER', final.phase === 'GAME_OVER', `phase=${final.phase}`)

  const collisions = roundBotSlots.filter((slots) => new Set(slots).size !== slots.length)
  check(
    '8 轮内机器人从不选中同一个位置',
    collisions.length === 0,
    collisions.length ? `撞车轮次：${JSON.stringify(collisions)}` : '零碰撞',
  )

  const penalties = botSeats.map((seat) => final.players.find((p) => p.seatId === seat).penalties)
  check('三个机器人被罚次数全为 0', penalties.every((n) => n === 0), JSON.stringify(penalties))

  check(
    '每轮三个机器人各占不同位置',
    roundBotSlots.every((slots) => new Set(slots).size === 3),
    JSON.stringify(roundBotSlots),
  )

  solo.ws.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('机器人 E2E 失败：', err.message)
  process.exit(1)
})
