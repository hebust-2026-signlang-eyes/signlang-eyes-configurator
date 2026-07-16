import { describe, expect, it } from 'vitest'

import {
  KEYPOINT_COUNT,
  PayloadWriter,
  ProtocolDecodeErrorCode,
  STREAM_HANDPOSE_PAYLOAD_VERSION,
  parseHandposeFrame,
  parseStreamHandposePayload,
} from '../../../src/ble/protocol'
import { expectProtocolDecodeError } from './error-assertions'

function frameWriter(detectionCount: number): PayloadWriter {
  return new PayloadWriter()
    .u8(1)
    .u8(detectionCount)
    .u16(KEYPOINT_COUNT)
    .u64(10n)
    .u64(20n)
    .u64(30n)
    .u64(40n)
    .u32(1920)
    .u32(1080)
    .u32(256)
    .u32(256)
}

describe('parseHandposeFrame', () => {
  it('parses frame metadata without detections', () => {
    expect(parseHandposeFrame(frameWriter(0).finish())).toEqual({
      format: 1,
      detectionCount: 0,
      keypointCount: KEYPOINT_COUNT,
      sequenceNumber: 10n,
      timestampNs: 20n,
      sourceSequenceNumber: 30n,
      sourceTimestampNs: 40n,
      imageWidth: 1920,
      imageHeight: 1080,
      modelWidth: 256,
      modelHeight: 256,
      detections: [],
    })
  })

  it('parses detection metadata, bounds, and all keypoints', () => {
    const writer = frameWriter(1)
      .u8(1)
      .u8(1)
      .u16(42)
      .f32(0.875)
      .f32(0.625)
      .f32(0.125)
      .f32(0.25)
      .f32(0.75)
      .f32(0.875)
    for (let index = 0; index < KEYPOINT_COUNT; index += 1) {
      writer
        .f32(index + 1)
        .f32(index + 1.25)
        .f32(-(index + 1))
        .f32(0.75)
    }

    const frame = parseHandposeFrame(writer.finish())
    const detection = frame.detections[0]!

    expect(detection).toMatchObject({
      present: true,
      isLeftHand: true,
      classId: 42,
      confidence: 0.875,
      presenceConfidence: 0.625,
      box: { left: 0.125, top: 0.25, right: 0.75, bottom: 0.875 },
    })
    expect(detection.keypoints).toHaveLength(KEYPOINT_COUNT)
    expect(detection.keypoints[0]).toEqual({
      x: 1,
      y: 1.25,
      z: -1,
      confidence: 0.75,
    })
    expect(detection.keypoints[KEYPOINT_COUNT - 1]).toEqual({
      x: 21,
      y: 21.25,
      z: -21,
      confidence: 0.75,
    })
  })
})

describe('parseStreamHandposePayload', () => {
  it('treats a format-1 payload as a legacy handpose frame', () => {
    const payload = Uint8Array.of(1, 2, 3)
    const parsed = parseStreamHandposePayload(payload)

    expect(parsed.handposePayload).toBe(payload)
    expect(parsed.recognition).toBeNull()
  })

  it('parses a v3 wrapper without recognition data', () => {
    const handpose = Uint8Array.of(1, 2, 3)
    const payload = new PayloadWriter()
      .u8(STREAM_HANDPOSE_PAYLOAD_VERSION)
      .u8(0)
      .u16(0)
      .u32(handpose.length)
      .pushBytes(handpose)
      .finish()

    expect(parseStreamHandposePayload(payload)).toEqual({
      handposePayload: handpose,
      recognition: null,
    })
  })

  it('parses recognition data from a v3 wrapper using the compact layout', () => {
    const handpose = Uint8Array.of(1, 2, 3)
    const gestureName = '挥手'
    const payload = new PayloadWriter()
      .u8(STREAM_HANDPOSE_PAYLOAD_VERSION)
      .u8(1)
      .u16(0)
      .u32(handpose.length)
      .pushBytes(handpose)
      .u64(100n)
      .u64(200n)
      .u8(1)
      .u32(7)
      .f32(0.25)
      .string(gestureName)
      .finish()

    expect(payload).toHaveLength(
      35 + handpose.length + new TextEncoder().encode(gestureName).length,
    )
    expect(parseStreamHandposePayload(payload)).toEqual({
      handposePayload: handpose,
      recognition: {
        sequenceNumber: 100n,
        timestampNs: 200n,
        recognized: true,
        gestureId: 7,
        distance: 0.25,
        gestureName,
      },
    })
  })

  it('parses a v2 wrapper while discarding removed confidence fields', () => {
    const handpose = Uint8Array.of(1, 2, 3)
    const payload = new PayloadWriter()
      .u8(2)
      .u8(1)
      .u16(0)
      .u32(handpose.length)
      .pushBytes(handpose)
      .u64(100n)
      .u64(200n)
      .u8(1)
      .u32(7)
      .f32(0.875)
      .f32(0.5)
      .f32(0.375)
      .f32(0.25)
      .string('wave')
      .finish()

    expect(parseStreamHandposePayload(payload)).toEqual({
      handposePayload: handpose,
      recognition: {
        sequenceNumber: 100n,
        timestampNs: 200n,
        recognized: true,
        gestureId: 7,
        distance: 0.25,
        gestureName: 'wave',
      },
    })
  })

  it('rejects an unsupported stream payload version', () => {
    expectProtocolDecodeError(
      () => parseStreamHandposePayload(Uint8Array.of(4)),
      ProtocolDecodeErrorCode.UnsupportedVersion,
      { version: 4, expected: STREAM_HANDPOSE_PAYLOAD_VERSION },
    )
  })

  it('rejects a v3 wrapper with a truncated handpose payload', () => {
    const payload = new PayloadWriter()
      .u8(STREAM_HANDPOSE_PAYLOAD_VERSION)
      .u8(0)
      .u16(0)
      .u32(4)
      .pushBytes(Uint8Array.of(1, 2))
      .finish()

    expectProtocolDecodeError(
      () => parseStreamHandposePayload(payload),
      ProtocolDecodeErrorCode.PayloadTooShort,
      { remaining: 2, expected: 4 },
    )
  })

  it('rejects a v3 wrapper with a truncated gesture name', () => {
    const payload = new PayloadWriter()
      .u8(STREAM_HANDPOSE_PAYLOAD_VERSION)
      .u8(1)
      .u16(0)
      .u32(0)
      .u64(100n)
      .u64(200n)
      .u8(1)
      .u32(7)
      .f32(0.25)
      .u16(4)
      .pushBytes(Uint8Array.of(0x61, 0x62))
      .finish()

    expectProtocolDecodeError(
      () => parseStreamHandposePayload(payload),
      ProtocolDecodeErrorCode.PayloadTooShort,
      { remaining: 2, expected: 4 },
    )
  })
})
