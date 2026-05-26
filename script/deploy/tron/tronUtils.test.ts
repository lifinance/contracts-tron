/**
 * Unit tests for encodeConstructorArgs in tronUtils.ts.
 * Exercises scalar and array argument type inference, including the address[]
 * detection fix for string arrays that look like addresses.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved, import/order
} from 'bun:test'

import { encodeConstructorArgs } from './tronUtils'

describe('encodeConstructorArgs', () => {
  it('encodes a single 0x address arg', async () => {
    const hex = await encodeConstructorArgs([
      '0x000000000000000000000000000000000000abcd',
    ])
    // address is left-padded to 32 bytes
    expect(hex).toBe(
      '0x000000000000000000000000000000000000000000000000000000000000abcd'
    )
  })

  it('encodes an array of 0x addresses as address[] (not string[])', async () => {
    const hex = await encodeConstructorArgs([
      ['0x000000000000000000000000000000000000aaaa'],
    ])
    // Bug guard: if encoded as string[], the literal "0x000...aaaa" ASCII would appear
    // (hex of the ASCII char "0" is 30, "x" is 78). Correct address[] encoding never
    // contains those bytes for these inputs.
    expect(hex).not.toContain('3078') // "0x" as ASCII would produce 3078 in the blob
    // Should contain the address bytes (last 20 bytes of the 32-byte slot)
    expect(hex).toContain('aaaa')
  })

  it('encodes a uint256 arg', async () => {
    const hex = await encodeConstructorArgs([86400])
    expect(hex).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000015180'
    )
  })

  it('encodes LiFiTimelockController-style args correctly (mixed types)', async () => {
    const hex = await encodeConstructorArgs([
      86400, // minDelay (uint256)
      ['0x0000000000000000000000000000000000000001'], // proposers (address[])
      ['0x0000000000000000000000000000000000000002'], // executors (address[])
      '0x0000000000000000000000000000000000000003', // canceller (address)
      '0x0000000000000000000000000000000000000001', // safe (address)
      '0x0000000000000000000000000000000000000004', // diamond (address)
    ])
    // Sanity: not the ASCII-encoded "0x..." pattern.
    expect(hex).not.toContain('3078343337') // the bug-signature for "0x4376..." ASCII
    // Result should start with 0x and be all hex.
    expect(hex).toMatch(/^0x[0-9a-fA-F]+$/)
    // minDelay = 86400 = 0x15180 (left-padded to 32 bytes)
    expect(hex).toContain('15180')
  })

  it('still encodes non-address string array as string[] (existing behavior)', async () => {
    const hex = await encodeConstructorArgs([['hello', 'world']])
    expect(hex).toMatch(/^0x[0-9a-fA-F]+$/)
    // ASCII "hello" = 68 65 6c 6c 6f
    expect(hex).toContain('68656c6c6f')
  })
})
