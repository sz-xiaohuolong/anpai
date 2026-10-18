import { describe, expect, it } from 'vitest'
import {
  ROUND_INTERMISSION_MS,
  applyAddBot,
  applyRemoveBot,
  applyReset,
  hostSeatId,
  applyCommit,
  applyHello,
  applyLeave,
  applyReady,
  applyReveal,
  createRoom,
  nextDeadline,
  tick,
  type RoomState,
} from '../party/coordination.ts'
import { COMMIT_WINDOW_MS, REVEAL_WINDOW_MS, ROUNDS } from '../src/core/values.ts'

const T0 = 1_700_000_000_000

/** 建立 3 人已准备的房间并开局。 */
function startedRoom(now = T0): RoomState {
  let state = createRoom()
  for (const [i, seatId] of ['s-a', 's-b', 's-c'].entries()) {
    state = applyHello(
      state,
      { seatId, nickname: seatId.toUpperCase(), connectionId: `conn-${i}` },
      now,
    ).state
  }
  for (const seatId of ['s-a', 's-b', 's-c']) {
    state = applyReady(state, seatId, true, now).state
  }
  return state
}

function commitAll(state: RoomState, now: number): RoomState {
  let next = state
  for (const seatId of ['s-a', 's-b', 's-c']) {
    next = applyCommit(next, { seatId, round: next.round, commit: `c-${seatId}` }, now).state
  }
  return next
}

function revealAll(state: RoomState, now: number): RoomState {
  let next = state
  const slots: Record<string, number> = { 's-a': 0, 's-b': 1, 's-c': 2 }
  for (const seatId of ['s-a', 's-b', 's-c']) {
    next = applyReveal(
      next,
      { seatId, round: next.round, slotIndex: slots[seatId]!, nonceHex: '0'.repeat(32) },
      now,
    ).state
  }
  return next
}

describe('席位', () => {
  it('开局前处于 lobby', () => {
    const state = createRoom()
    expect(state.phase).toBe('lobby')
    expect(state.seats).toHaveLength(0)
  })

  it('hello 新增席位并写入 JOIN 事件', () => {
    const { state, events } = applyHello(
      createRoom(),
      { seatId: 's-a', nickname: '阿元', connectionId: 'c1' },
      T0,
    )
    expect(state.seats).toHaveLength(1)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('JOIN')
    expect(events[0]!.seq).toBe(1)
  })

  it('同一 seatId 再 hello 视为重连，不新增席位', () => {
    let state = applyHello(
      createRoom(),
      { seatId: 's-a', nickname: '阿元', connectionId: 'c1' },
      T0,
    ).state
    state = applyHello(state, { seatId: 's-a', nickname: '阿元', connectionId: 'c2' }, T0 + 1).state
    expect(state.seats).toHaveLength(1)
    expect(state.seats[0]!.connectionId).toBe('c2')
  })

  it('超过 5 人拒绝加入', () => {
    let state = createRoom()
    for (let i = 0; i < 5; i++) {
      state = applyHello(
        state,
        { seatId: `s-${i}`, nickname: `P${i}`, connectionId: `c-${i}` },
        T0,
      ).state
    }
    const result = applyHello(
      state,
      { seatId: 's-x', nickname: 'X', connectionId: 'cx' },
      T0,
    )
    expect(result.state.seats).toHaveLength(5)
    expect(result.events).toHaveLength(0)
  })

  it('leave 标记掉线但不移出席位', () => {
    const { state } = applyLeave(startedRoom(), 's-b', T0 + 100)
    expect(state.seats).toHaveLength(3)
    expect(state.seats.find((s) => s.seatId === 's-b')!.connected).toBe(false)
  })

  it('seq 单调递增且无重复', () => {
    const state = startedRoom()
    const seqs = state.log.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })
})

describe('开局', () => {
  it('人数不足 3 时全员准备也不开局', () => {
    let state = createRoom()
    for (const [i, seatId] of ['s-a', 's-b'].entries()) {
      state = applyHello(state, { seatId, nickname: seatId, connectionId: `c${i}` }, T0).state
    }
    state = applyReady(state, 's-a', true, T0).state
    state = applyReady(state, 's-b', true, T0).state
    expect(state.phase).toBe('lobby')
  })

  it('3 人全员准备后自动开局并发出 ROUND_OPEN', () => {
    const state = startedRoom()
    expect(state.phase).toBe('committing')
    expect(state.round).toBe(1)
    expect(state.log.some((e) => e.type === 'ROUND_OPEN' && e.payload.round === 1)).toBe(true)
  })

  it('开局时设定提交截止时间', () => {
    const state = startedRoom(T0)
    expect(state.commitDeadline).toBe(T0 + COMMIT_WINDOW_MS)
    expect(nextDeadline(state)).toBe(T0 + COMMIT_WINDOW_MS)
  })
})

describe('提交阶段', () => {
  it('提交写入 COMMIT 事件，且负载不含位置明文', () => {
    const state = startedRoom()
    const { state: after, events } = applyCommit(
      state,
      { seatId: 's-a', round: 1, commit: 'deadbeef' },
      T0 + 100,
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('COMMIT')
    // 服务器只看到 round 与哈希，看不到任何人选了哪个位置
    expect(Object.keys(events[0]!.payload).sort()).toEqual(['commit', 'round'])
    expect(JSON.stringify(events[0]!.payload)).not.toContain('slot')
    expect(after.committed).toEqual(['s-a'])
  })

  it('同一席位重复提交被忽略（承诺不可覆盖）', () => {
    let state = applyCommit(startedRoom(), { seatId: 's-a', round: 1, commit: 'x' }, T0).state
    const result = applyCommit(state, { seatId: 's-a', round: 1, commit: 'y' }, T0 + 1)
    expect(result.events).toHaveLength(0)
    state = result.state
    expect(state.committed).toEqual(['s-a'])
  })

  it('轮次不匹配的提交被忽略', () => {
    const result = applyCommit(startedRoom(), { seatId: 's-a', round: 99, commit: 'x' }, T0)
    expect(result.events).toHaveLength(0)
  })

  it('全员提交后进入揭示阶段并设定揭示截止', () => {
    const state = commitAll(startedRoom(), T0 + 100)
    expect(state.phase).toBe('revealing')
    expect(state.revealDeadline).toBe(T0 + 100 + REVEAL_WINDOW_MS)
  })
})

describe('揭示阶段', () => {
  it('未提交者不能揭示', () => {
    const state = startedRoom()
    const result = applyReveal(state, { seatId: 's-a', round: 1, slotIndex: 0, nonceHex: '0'.repeat(32) }, T0)
    expect(result.events).toHaveLength(0)
  })

  it('重复揭示被忽略', () => {
    let state = commitAll(startedRoom(), T0)
    state = applyReveal(state, { seatId: 's-a', round: 1, slotIndex: 0, nonceHex: '0'.repeat(32) }, T0 + 10).state
    const result = applyReveal(state, { seatId: 's-a', round: 1, slotIndex: 1, nonceHex: '0'.repeat(32) }, T0 + 20)
    expect(result.events).toHaveLength(0)
  })

  it('全员揭示后进入 settled 并设定下一轮时间', () => {
    const state = revealAll(commitAll(startedRoom(), T0), T0 + 1000)
    expect(state.phase).toBe('settled')
    expect(state.nextRoundAt).toBe(T0 + 1000 + ROUND_INTERMISSION_MS)
  })
})

describe('超时与推进', () => {
  it('提交超时 → 发出 ROUND_TIMEOUT(commit) 并进入揭示阶段', () => {
    const state = startedRoom(T0)
    const { state: after, events } = tick(state, T0 + COMMIT_WINDOW_MS)
    expect(events.some((e) => e.type === 'ROUND_TIMEOUT' && e.payload.phase === 'commit')).toBe(true)
    expect(['revealing', 'settled']).toContain(after.phase)
  })

  it('零提交时超时后直接结算并开下一轮', () => {
    let state = startedRoom(T0)
    state = tick(state, T0 + COMMIT_WINDOW_MS).state
    expect(state.phase).toBe('settled')
    const { state: after } = tick(state, T0 + COMMIT_WINDOW_MS + ROUND_INTERMISSION_MS)
    expect(after.round).toBe(2)
    expect(after.phase).toBe('committing')
  })

  it('揭示超时 → 发出 ROUND_TIMEOUT(reveal) 并结算', () => {
    let state = commitAll(startedRoom(T0), T0 + 100)
    state = applyReveal(state, { seatId: 's-a', round: 1, slotIndex: 0, nonceHex: '0'.repeat(32) }, T0 + 200).state
    // s-b、s-c 一直不揭示
    const { state: after, events } = tick(state, T0 + 100 + REVEAL_WINDOW_MS)
    expect(events.some((e) => e.type === 'ROUND_TIMEOUT' && e.payload.phase === 'reveal')).toBe(true)
    expect(after.phase).toBe('settled')
  })

  it('空闲 tick 不产生事件', () => {
    const state = startedRoom(T0)
    const result = tick(state, T0 + 1)
    expect(result.events).toHaveLength(0)
    expect(result.state).toBe(state)
  })

  it('打满 8 轮后进入 over', () => {
    let state = startedRoom(T0)
    let now = T0
    for (let round = 1; round <= ROUNDS; round++) {
      expect(state.round).toBe(round)
      state = commitAll(state, now)
      state = revealAll(state, now)
      now += ROUND_INTERMISSION_MS
      state = tick(state, now).state
    }
    expect(state.phase).toBe('over')
    expect(state.round).toBe(ROUNDS)
    expect(nextDeadline(state)).toBeNull()
  })
})

describe('再来一局', () => {
  function finishedRoom(now: number): RoomState {
    let state = startedRoom(now)
    for (let round = 1; round <= ROUNDS; round++) {
      state = commitAll(state, now)
      state = revealAll(state, now)
      now += ROUND_INTERMISSION_MS
      state = tick(state, now).state
    }
    return state
  }

  it('进行中拒绝重开', () => {
    const state = startedRoom()
    const result = applyReset(state, T0 + 10)
    expect(result.events).toHaveLength(0)
    expect(result.state).toBe(state)
  })

  it('结束后重开：回到 lobby、清空轮次、全员取消准备', () => {
    const finished = finishedRoom(T0)
    expect(finished.phase).toBe('over')

    const { state, events } = applyReset(finished, T0 + 999_999)
    expect(state.phase).toBe('lobby')
    expect(state.round).toBe(0)
    expect(state.nextRoundAt).toBeNull()
    expect(state.seats.every((s) => !s.ready)).toBe(true)
    expect(events[0]!.type).toBe('GAME_RESET')
    expect(events.filter((e) => e.type === 'JOIN')).toHaveLength(3)
  })

  it('重开后全员再次准备可以重新开局', () => {
    const finished = finishedRoom(T0)
    let state = applyReset(finished, T0 + 999_999).state
    for (const seatId of ['s-a', 's-b', 's-c']) {
      state = applyReady(state, seatId, true, T0 + 1_000_000).state
    }
    expect(state.phase).toBe('committing')
    expect(state.round).toBe(1)
  })
})

describe('机器人', () => {
  function twoHumans(now: number): RoomState {
    let state = createRoom()
    for (const [i, seatId] of ['s-a', 's-b'].entries()) {
      state = applyHello(state, { seatId, nickname: seatId, connectionId: `c${i}` }, now).state
    }
    return state
  }

  it('房主是第一个加入的席位', () => {
    const state = twoHumans(T0)
    expect(hostSeatId(state)).toBe('s-a')
  })

  it('等待页可以添加机器人，机器人自动准备', () => {
    const { state, events } = applyAddBot(twoHumans(T0), T0 + 10)
    expect(state.seats).toHaveLength(3)
    const bot = state.seats[2]!
    expect(bot.bot).toBe(true)
    expect(bot.ready).toBe(true)
    expect(events[0]!.type).toBe('JOIN')
    expect((events[0]!.payload as { bot?: boolean }).bot).toBe(true)
  })

  it('2 个真人 + 1 个机器人即可开局', () => {
    let state = applyAddBot(twoHumans(T0), T0 + 10).state
    state = applyReady(state, 's-a', true, T0 + 20).state
    state = applyReady(state, 's-b', true, T0 + 30).state
    expect(state.phase).toBe('committing')
    expect(state.round).toBe(1)
  })

  it('最多 5 个席位', () => {
    let state = twoHumans(T0)
    for (let i = 0; i < 3; i++) state = applyAddBot(state, T0 + i).state
    expect(state.seats).toHaveLength(5)
    const blocked = applyAddBot(state, T0 + 99)
    expect(blocked.events).toHaveLength(0)
    expect(blocked.state.seats).toHaveLength(5)
  })

  it('开局后不能再添加机器人', () => {
    let state = applyAddBot(twoHumans(T0), T0 + 10).state
    state = applyReady(state, 's-a', true, T0 + 20).state
    state = applyReady(state, 's-b', true, T0 + 30).state
    expect(state.phase).toBe('committing')
    const result = applyAddBot(state, T0 + 40)
    expect(result.events).toHaveLength(0)
  })

  it('可以移除机器人，但不能移除真人', () => {
    let state = applyAddBot(twoHumans(T0), T0 + 10).state
    const botSeat = state.seats[2]!.seatId
    const removedBot = applyRemoveBot(state, botSeat, T0 + 20)
    expect(removedBot.state.seats).toHaveLength(2)

    state = removedBot.state
    const removedHuman = applyRemoveBot(state, 's-a', T0 + 30)
    expect(removedHuman.events).toHaveLength(0)
    expect(removedHuman.state.seats).toHaveLength(2)
  })

  it('重开一局后机器人保留且仍然准备', () => {
    let state = applyAddBot(twoHumans(T0), T0 + 10).state
    state = applyReady(state, 's-a', true, T0 + 20).state
    state = applyReady(state, 's-b', true, T0 + 30).state
    let now = T0 + 100
    for (let round = 1; round <= ROUNDS_TOTAL; round++) {
      // 含机器人在内全员提交并揭示：机器人也由测试代打
      state = commitAllSeats(state, now)
      state = revealAllSeats(state, now)
      now += ROUND_INTERMISSION_MS
      state = tick(state, now).state
    }
    expect(state.phase).toBe('over')

    const reset = applyReset(state, now + 1000)
    expect(reset.state.phase).toBe('lobby')
    expect(reset.state.seats).toHaveLength(3)
    const bot = reset.state.seats.find((s) => s.bot)!
    expect(bot.ready).toBe(true)
    expect(reset.state.seats.filter((s) => !s.bot).every((s) => !s.ready)).toBe(true)
  })
})

const ROUNDS_TOTAL = ROUNDS

function commitAllSeats(state: RoomState, now: number): RoomState {
  let next = state
  for (const seat of next.seats) {
    next = applyCommit(next, { seatId: seat.seatId, round: next.round, commit: `c-${seat.seatId}` }, now)
      .state
  }
  return next
}

function revealAllSeats(state: RoomState, now: number): RoomState {
  let next = state
  next.seats.forEach((seat, index) => {
    next = applyReveal(
      next,
      { seatId: seat.seatId, round: next.round, slotIndex: index, nonceHex: '0'.repeat(32) },
      now,
    ).state
  })
  return next
}
