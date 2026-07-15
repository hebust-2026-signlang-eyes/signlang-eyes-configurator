import { describe, expect, it } from 'vitest'

import { PayloadReader, PayloadWriter, ProtocolDecodeErrorCode } from '../../../src/ble/protocol'
import { expectProtocolDecodeError } from './error-assertions'

describe('payload codec', () => {
  it('writes integers in little-endian order', () => {
    const payload = new PayloadWriter().u16(0x1234).u32(0x89abcdef).finish()

    expect(payload).toEqual(Uint8Array.of(0x34, 0x12, 0xef, 0xcd, 0xab, 0x89))
  })

  it('round-trips every supported primitive from a sliced buffer', () => {
    const payload = new PayloadWriter()
      .u8(0xab)
      .u16(0x1234)
      .u32(0x89abcdef)
      .u64(0x0123456789abcdefn)
      .f32(0.625)
      .string('gesture 👋')
      .pushBytes(Uint8Array.of(0xde, 0xad))
      .finish()
    const padded = new Uint8Array(payload.length + 4)
    padded.set(payload, 2)
    const reader = new PayloadReader(padded.subarray(2, 2 + payload.length))

    expect(reader.u8()).toBe(0xab)
    expect(reader.u16()).toBe(0x1234)
    expect(reader.u32()).toBe(0x89abcdef)
    expect(reader.u64()).toBe(0x0123456789abcdefn)
    expect(reader.f32()).toBe(0.625)
    expect(reader.string()).toBe('gesture 👋')
    expect(reader.bytesOfLength(2)).toEqual(Uint8Array.of(0xde, 0xad))
    expect(reader.remaining).toBe(0)
  })

  it('rejects a length-prefixed value that exceeds the remaining payload', () => {
    const payload = new PayloadWriter().u16(4).pushBytes(Uint8Array.of(0x61, 0x62)).finish()

    expectProtocolDecodeError(
      () => new PayloadReader(payload).string(),
      ProtocolDecodeErrorCode.PayloadTooShort,
      { remaining: 2, expected: 4 },
    )
  })

  it('rejects a fixed-width read beyond the payload boundary', () => {
    expectProtocolDecodeError(
      () => new PayloadReader(Uint8Array.of(1)).u32(),
      ProtocolDecodeErrorCode.PayloadTooShort,
      { remaining: 1, expected: 4 },
    )
  })
})
