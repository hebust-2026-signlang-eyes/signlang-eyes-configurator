import { describe, expect, it } from 'vitest'

import {
  PayloadWriter,
  ProtocolDecodeErrorCode,
  ProtocolStatusError,
  Status,
  buildGestureBlob,
  parseGestureList,
} from '../../../src/ble/protocol'
import { expectProtocolDecodeError } from './error-assertions'

describe('parseGestureList', () => {
  it('parses an empty gesture list', () => {
    const payload = new PayloadWriter().u16(Status.Ok).u16(0).finish()

    expect(parseGestureList(payload)).toEqual([])
  })

  it('parses calibrated before each gesture name', () => {
    const payload = new PayloadWriter()
      .u16(Status.Ok)
      .u16(2)
      .u32(7)
      .u8(1)
      .u32(12)
      .u8(0)
      .string('wave')
      .u32(9)
      .u8(0)
      .u32(3)
      .u8(1)
      .string('hello 👋')
      .finish()

    expect(parseGestureList(payload)).toEqual([
      {
        id: 7,
        enabled: true,
        sampleCount: 12,
        calibrated: false,
        name: 'wave',
      },
      {
        id: 9,
        enabled: false,
        sampleCount: 3,
        calibrated: true,
        name: 'hello 👋',
      },
    ])
  })

  it('surfaces a non-OK response with its device message', () => {
    const payload = new PayloadWriter()
      .u16(Status.NotFound)
      .string('gesture store missing')
      .finish()

    let caught: unknown
    try {
      parseGestureList(payload)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ProtocolStatusError)
    expect(caught).toMatchObject({
      command: 'ListGestures',
      status: Status.NotFound,
      statusName: 'NotFound',
      deviceMessage: 'gesture store missing',
    })
  })

  it('rejects a truncated gesture name', () => {
    const payload = new PayloadWriter()
      .u16(Status.Ok)
      .u16(1)
      .u32(1)
      .u8(1)
      .u32(2)
      .u8(1)
      .u16(4)
      .pushBytes(Uint8Array.of(0x61, 0x62))
      .finish()

    expectProtocolDecodeError(
      () => parseGestureList(payload),
      ProtocolDecodeErrorCode.PayloadTooShort,
      { remaining: 2, expected: 4 },
    )
  })
})

describe('buildGestureBlob', () => {
  it('prefixes every frame with the frame count and byte length', () => {
    const blob = buildGestureBlob([Uint8Array.of(1, 2), new Uint8Array(), Uint8Array.of(3)])

    expect(blob).toEqual(Uint8Array.of(3, 0, 0, 0, 2, 0, 0, 0, 1, 2, 0, 0, 0, 0, 1, 0, 0, 0, 3))
  })
})
