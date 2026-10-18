import { describe, expect, it } from 'vitest'
import {
  canonicalCommitString,
  commitOf,
  isValidNonceHex,
  randomNonceHex,
  verifyReveal,
} from '../src/core/crypto.ts'

/**
 * 测试向量来源：docs/game-architecture-v1.md §5.2。
 * 不同实现必须复现出同一结果，否则跨客户端校验会失败。
 */
const VECTORS = [
  {
    roomCode: 'ANPAI7K',
    round: 1,
    seatId: 'seat-a1b2',
    slotIndex: 3,
    nonceHex: '000102030405060708090a0b0c0d0e0f',
    expected: '84ccd19d209dcdf0ddbe7acc33edbf38ddbf3b52d8900b5e9506686da88cca80',
  },
  {
    roomCode: 'ANPAI7K',
    round: 10,
    seatId: 'seat-c3d4',
    slotIndex: 9,
    nonceHex: 'fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0',
    expected: '56c818d56708c55c2edf154bd35dc4e219c1d7de7547c07546fbbe09da128f80',
  },
]

const CROSS_ROOM_CONTROL = 'ea78b9b1b8143f16171cebb4acd5c7fe68ce9652ccc0ea75c8d900d3908c85df'

describe('commit 编码', () => {
  it('规范字符串逐字节符合文档定义', () => {
    expect(canonicalCommitString(VECTORS[0]!)).toBe(
      'ANPAI7K|1|seat-a1b2|3|000102030405060708090a0b0c0d0e0f',
    )
  })

  it.each(VECTORS)('测试向量：room=$roomCode round=$round', async (vector) => {
    const actual = await commitOf(vector)
    expect(actual).toBe(vector.expected)
  })

  it('跨房间重放会产生不同哈希', async () => {
    const base = VECTORS[0]!
    const crossRoom = await commitOf({ ...base, roomCode: 'ANPAI8M' })
    expect(crossRoom).toBe(CROSS_ROOM_CONTROL)
    expect(crossRoom).not.toBe(base.expected)
  })

  it('换席位会产生不同哈希', async () => {
    const base = VECTORS[0]!
    const other = await commitOf({ ...base, seatId: 'seat-zzzz' })
    expect(other).not.toBe(base.expected)
  })
})

describe('commit-reveal 性质', () => {
  const context = { roomCode: 'ANPAI7K', seatId: 'seat-a1b2' }

  it('绑定：揭示后改选会导致校验失败', async () => {
    const nonceHex = randomNonceHex()
    const commit = await commitOf({ ...context, round: 1, slotIndex: 3, nonceHex })
    await expect(
      verifyReveal(commit, { round: 1, slotIndex: 4, nonceHex }, context),
    ).resolves.toBe(false)
    await expect(
      verifyReveal(commit, { round: 1, slotIndex: 3, nonceHex }, context),
    ).resolves.toBe(true)
  })

  it('隐藏：不知道 nonce 时无法通过校验', async () => {
    const commit = await commitOf({
      ...context,
      round: 1,
      slotIndex: 3,
      nonceHex: randomNonceHex(),
    })
    const wrongNonce = 'f'.repeat(32)
    await expect(
      verifyReveal(commit, { round: 1, slotIndex: 3, nonceHex: wrongNonce }, context),
    ).resolves.toBe(false)
  })

  it('nonce 格式非法时直接判否', async () => {
    const commit = await commitOf({
      ...context,
      round: 1,
      slotIndex: 3,
      nonceHex: randomNonceHex(),
    })
    await expect(
      verifyReveal(commit, { round: 1, slotIndex: 3, nonceHex: 'short' }, context),
    ).resolves.toBe(false)
  })
})

describe('nonce', () => {
  it('是 32 位小写十六进制且随机', () => {
    const a = randomNonceHex()
    const b = randomNonceHex()
    expect(isValidNonceHex(a)).toBe(true)
    expect(a).toHaveLength(32)
    expect(a).not.toBe(b)
  })

  it('拒绝大写与错误长度', () => {
    expect(isValidNonceHex('A'.repeat(32))).toBe(false)
    expect(isValidNonceHex('a'.repeat(31))).toBe(false)
    expect(isValidNonceHex('a'.repeat(33))).toBe(false)
  })
})
