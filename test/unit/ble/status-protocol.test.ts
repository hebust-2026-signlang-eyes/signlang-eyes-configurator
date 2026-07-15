import { describe, expect, it } from 'vitest'

import {
  PayloadWriter,
  ProtocolStatusError,
  Status,
  parseStatus,
  readStatusResponse,
  statusError,
} from '../../../src/ble/protocol'

describe('status protocol', () => {
  it('parses a successful device status response', () => {
    const payload = new PayloadWriter()
      .u16(Status.Ok)
      .u16(1)
      .u16(0)
      .u32(30)
      .u32(128)
      .u32(24)
      .u8(1)
      .finish()

    expect(parseStatus(payload)).toEqual({
      status: Status.Ok,
      protocolVersion: 1,
      reserved: 0,
      encoderSequenceLen: 30,
      embeddingDim: 128,
      streamFps: 24,
      streamingEnabled: true,
    })
  })

  it('includes the command label and device message in status errors', () => {
    const payload = new PayloadWriter().u16(Status.InternalError).string('device detail').finish()

    let caught: unknown
    try {
      parseStatus(payload, 'GetCapabilities')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ProtocolStatusError)
    expect(caught).toMatchObject({
      command: 'GetCapabilities',
      status: Status.InternalError,
      statusName: 'InternalError',
      deviceMessage: 'device detail',
    })
  })

  it('reads OK and error status response bodies', () => {
    const ok = new PayloadWriter().u16(Status.Ok).finish()
    const error = new PayloadWriter().u16(Status.NotFound).string('gesture missing').finish()

    expect(readStatusResponse(ok)).toEqual({ status: Status.Ok, message: '' })
    expect(readStatusResponse(error)).toEqual({
      status: Status.NotFound,
      message: 'gesture missing',
    })
  })

  it('uses the numeric value for an unknown status', () => {
    expect(statusError('Command', { status: 99, message: '' })).toMatchObject({
      command: 'Command',
      status: 99,
      statusName: '99',
      deviceMessage: '',
    })
  })
})
