import { describe, expect, it } from 'vitest'

import { PayloadWriter, Status, parseGestureList } from './protocol'

describe('parseGestureList', () => {
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
      .string('你好')
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
        name: '你好',
      },
    ])
  })
})
