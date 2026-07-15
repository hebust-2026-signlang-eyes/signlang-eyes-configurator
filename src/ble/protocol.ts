// SLM1 BLE protocol codec for signlang_manager.
// Keep in sync with the device-side implementation:
// https://github.com/syxxzzr/signlang-eyes/blob/main/src/signlang_manager/manager_service.cpp

export const SERVICE_UUID = '3b5f1000-4ad2-4f53-9a65-6f6d65796573'
export const RX_UUID = '3b5f1001-4ad2-4f53-9a65-6f6d65796573'
export const TX_UUID = '3b5f1002-4ad2-4f53-9a65-6f6d65796573'

export const HEADER_SIZE = 24
export const MAGIC = Uint8Array.of(0x53, 0x4c, 0x4d, 0x31) // "SLM1"
export const PROTOCOL_VERSION = 1

export const PacketType = {
  Request: 1,
  Response: 2,
  Event: 3,
  Stream: 4,
} as const

export const CommandId = {
  GetCapabilities: 0x0001,
  SetStreamConfig: 0x0101,
  HandposeFrame: 0x0102,
  ListGestures: 0x0201,
  AddGestureBegin: 0x0202,
  AddGestureChunk: 0x0203,
  AddGestureCommit: 0x0204,
  AddGestureAbort: 0x0205,
  DeleteGesture: 0x0206,
  GetStatus: 0x0301,
} as const

export const Status = {
  Ok: 0,
  BadRequest: 1,
  NotFound: 2,
  InternalError: 3,
  Unsupported: 4,
} as const

export const STATUS_NAME: Record<number, string> = {
  0: 'OK',
  1: 'BadRequest',
  2: 'NotFound',
  3: 'InternalError',
  4: 'Unsupported',
}

export interface DecodedPacket {
  type: number
  commandId: number
  requestId: number
  flags: number
  payload: Uint8Array
}

export const ProtocolDecodeErrorCode = {
  PacketTooShort: 'packetTooShort',
  BadMagic: 'badMagic',
  UnsupportedVersion: 'unsupportedVersion',
  UnsupportedHeaderSize: 'unsupportedHeaderSize',
  PacketSizeMismatch: 'packetSizeMismatch',
  PayloadCrcMismatch: 'payloadCrcMismatch',
  PayloadTooShort: 'payloadTooShort',
} as const

export type ProtocolDecodeErrorCode =
  (typeof ProtocolDecodeErrorCode)[keyof typeof ProtocolDecodeErrorCode]

export class ProtocolDecodeError extends Error {
  constructor(
    readonly code: ProtocolDecodeErrorCode,
    readonly details: Readonly<Record<string, number>> = {},
  ) {
    super(code)
    this.name = 'ProtocolDecodeError'
  }
}

// --- CRC32 (poly 0xEDB88320, init 0xFFFFFFFF, final xor) ---------------------

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i]!
    for (let b = 0; b < 8; b += 1) {
      const mask = -(crc & 1)
      crc = (crc >>> 1) ^ (0xedb88320 & mask)
    }
  }
  return (~crc) >>> 0
}

// --- Packet encode / decode --------------------------------------------------

export interface EncodePacketArgs {
  type: number
  commandId: number
  requestId?: number
  flags?: number
  payload?: Uint8Array
}

export function encodePacket({
  type,
  commandId,
  requestId = 0,
  flags = 0,
  payload = new Uint8Array(),
}: EncodePacketArgs): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + payload.length)
  const view = new DataView(out.buffer)

  out.set(MAGIC, 0)
  view.setUint8(4, PROTOCOL_VERSION)
  view.setUint8(5, type)
  view.setUint16(6, commandId, true)
  view.setUint32(8, requestId, true)
  view.setUint16(12, flags, true)
  view.setUint16(14, HEADER_SIZE, true)
  view.setUint32(16, payload.length, true)
  view.setUint32(20, crc32(payload), true)
  out.set(payload, HEADER_SIZE)
  return out
}

export function decodePacket(bytes: Uint8Array): DecodedPacket {
  if (bytes.length < HEADER_SIZE) {
    throw new ProtocolDecodeError(ProtocolDecodeErrorCode.PacketTooShort, {
      actual: bytes.length,
      expected: HEADER_SIZE,
    })
  }
  if (
    bytes[0] !== 0x53 ||
    bytes[1] !== 0x4c ||
    bytes[2] !== 0x4d ||
    bytes[3] !== 0x31
  ) {
    throw new ProtocolDecodeError(ProtocolDecodeErrorCode.BadMagic)
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint8(4)
  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolDecodeError(ProtocolDecodeErrorCode.UnsupportedVersion, {
      version,
      expected: PROTOCOL_VERSION,
    })
  }

  const type = view.getUint8(5)
  const commandId = view.getUint16(6, true)
  const requestId = view.getUint32(8, true)
  const flags = view.getUint16(12, true)
  const headerSize = view.getUint16(14, true)
  const payloadSize = view.getUint32(16, true)
  const expectedCrc = view.getUint32(20, true)
  if (headerSize !== HEADER_SIZE) {
    throw new ProtocolDecodeError(ProtocolDecodeErrorCode.UnsupportedHeaderSize, {
      actual: headerSize,
      expected: HEADER_SIZE,
    })
  }
  const expectedPacketSize = headerSize + payloadSize
  if (bytes.length !== expectedPacketSize) {
    throw new ProtocolDecodeError(ProtocolDecodeErrorCode.PacketSizeMismatch, {
      actual: bytes.length,
      expected: expectedPacketSize,
    })
  }

  const payload = bytes.slice(headerSize)
  const actualCrc = crc32(payload)
  if (actualCrc !== expectedCrc) {
    throw new ProtocolDecodeError(ProtocolDecodeErrorCode.PayloadCrcMismatch, {
      actual: actualCrc,
      expected: expectedCrc,
    })
  }

  return { type, commandId, requestId, flags, payload }
}

// --- Payload reader / writer -------------------------------------------------

export class PayloadWriter {
  private parts: Uint8Array[] = []
  private length = 0

  pushBytes(bytes: Uint8Array): this {
    this.parts.push(bytes)
    this.length += bytes.length
    return this
  }

  u8(value: number): this {
    return this.pushBytes(Uint8Array.of(value & 0xff))
  }

  u16(value: number): this {
    const b = new Uint8Array(2)
    new DataView(b.buffer).setUint16(0, value, true)
    return this.pushBytes(b)
  }

  u32(value: number): this {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, value, true)
    return this.pushBytes(b)
  }

  u64(value: bigint): this {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setBigUint64(0, value, true)
    return this.pushBytes(b)
  }

  f32(value: number): this {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setFloat32(0, value, true)
    return this.pushBytes(b)
  }

  string(value: string): this {
    const bytes = new TextEncoder().encode(value)
    this.u16(bytes.length)
    return this.pushBytes(bytes)
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length)
    let offset = 0
    for (const part of this.parts) {
      out.set(part, offset)
      offset += part.length
    }
    return out
  }
}

export class PayloadReader {
  private view: DataView
  private offset = 0
  private decoder = new TextDecoder()

  constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get remaining(): number {
    return this.bytes.length - this.offset
  }

  private requireLength(len: number): void {
    if (this.remaining < len) {
      throw new ProtocolDecodeError(ProtocolDecodeErrorCode.PayloadTooShort, {
        remaining: this.remaining,
        expected: len,
      })
    }
  }

  u8(): number {
    this.requireLength(1)
    const v = this.view.getUint8(this.offset)
    this.offset += 1
    return v
  }

  u16(): number {
    this.requireLength(2)
    const v = this.view.getUint16(this.offset, true)
    this.offset += 2
    return v
  }

  u32(): number {
    this.requireLength(4)
    const v = this.view.getUint32(this.offset, true)
    this.offset += 4
    return v
  }

  u64(): bigint {
    this.requireLength(8)
    const v = this.view.getBigUint64(this.offset, true)
    this.offset += 8
    return v
  }

  f32(): number {
    this.requireLength(4)
    const v = this.view.getFloat32(this.offset, true)
    this.offset += 4
    return v
  }

  string(): string {
    const len = this.u16()
    const slice = this.bytesOfLength(len)
    return this.decoder.decode(slice)
  }

  bytesOfLength(len: number): Uint8Array {
    this.requireLength(len)
    const slice = this.bytes.subarray(this.offset, this.offset + len)
    this.offset += len
    return slice
  }
}

// --- Status / capabilities ---------------------------------------------------

export interface DeviceStatus {
  status: number
  protocolVersion: number
  reserved: number
  encoderSequenceLen: number
  embeddingDim: number
  streamFps: number
  streamingEnabled: boolean
}

export function parseStatus(payload: Uint8Array, label = 'GetStatus'): DeviceStatus {
  const r = new PayloadReader(payload)
  const status = r.u16()
  if (status !== Status.Ok) {
    const message = r.remaining >= 2 ? r.string() : ''
    throw statusError(label, { status, message })
  }

  return {
    status,
    protocolVersion: r.u16(),
    reserved: r.u16(),
    encoderSequenceLen: r.u32(),
    embeddingDim: r.u32(),
    streamFps: r.u32(),
    streamingEnabled: r.u8() !== 0,
  }
}

// --- Gesture list ------------------------------------------------------------

export interface GestureInfo {
  id: number
  enabled: boolean
  sampleCount: number
  calibrated: boolean
  name: string
}

export function parseGestureList(payload: Uint8Array): GestureInfo[] {
  const r = new PayloadReader(payload)
  const status = r.u16()
  if (status !== Status.Ok) {
    const message = r.remaining >= 2 ? r.string() : ''
    throw statusError('ListGestures', { status, message })
  }
  const count = r.u16()
  const out: GestureInfo[] = []
  for (let i = 0; i < count; i += 1) {
    out.push({
      id: r.u32(),
      enabled: r.u8() !== 0,
      sampleCount: r.u32(),
      calibrated: r.u8() !== 0,
      name: r.string(),
    })
  }
  return out
}

// --- Response status helper --------------------------------------------------

export interface StatusResponse {
  status: number
  message: string
}

export class ProtocolStatusError extends Error {
  readonly statusName: string

  constructor(
    readonly command: string,
    readonly status: number,
    readonly deviceMessage: string,
  ) {
    const statusName = STATUS_NAME[status] ?? String(status)
    super(`${command} [${statusName}]${deviceMessage ? `: ${deviceMessage}` : ''}`)
    this.name = 'ProtocolStatusError'
    this.statusName = statusName
  }
}

// Reads the leading `u16 status` and, for non-OK responses, the trailing
// `string message`. Returns message='' when none is present.
export function readStatusResponse(payload: Uint8Array): StatusResponse {
  const r = new PayloadReader(payload)
  const status = r.u16()
  const message = status !== Status.Ok && r.remaining >= 2 ? r.string() : ''
  return { status, message }
}

export function statusError(label: string, res: StatusResponse): ProtocolStatusError {
  return new ProtocolStatusError(label, res.status, res.message)
}

// --- Gesture upload blob (§10) -----------------------------------------------

// blob = u32 frame_count, then per frame: u32 frame_payload_size + wire bytes.
// Each `frame` is the raw wire_handpose_frame payload captured from the stream.
export function buildGestureBlob(frames: Uint8Array[]): Uint8Array {
  let total = 4
  for (const f of frames) total += 4 + f.length

  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let offset = 0
  view.setUint32(offset, frames.length, true)
  offset += 4
  for (const f of frames) {
    view.setUint32(offset, f.length, true)
    offset += 4
    out.set(f, offset)
    offset += f.length
  }
  return out
}

// --- Wire handpose frame -----------------------------------------------------
export const KEYPOINT_COUNT = 21

export interface Keypoint {
  x: number
  y: number
  z: number
  confidence: number
}

export interface HandDetection {
  present: boolean
  isLeftHand: boolean
  classId: number
  confidence: number
  presenceConfidence: number
  box: { left: number; top: number; right: number; bottom: number }
  keypoints: Keypoint[]
}

export interface HandposeFrame {
  format: number
  detectionCount: number
  keypointCount: number
  sequenceNumber: bigint
  timestampNs: bigint
  sourceSequenceNumber: bigint
  sourceTimestampNs: bigint
  imageWidth: number
  imageHeight: number
  modelWidth: number
  modelHeight: number
  detections: HandDetection[]
}

export interface RecognitionResult {
  sequenceNumber: bigint
  timestampNs: bigint
  recognized: boolean
  gestureId: number
  confidence: number
  secondConfidence: number
  confidenceMargin: number
  distance: number
  gestureName: string
}

export interface StreamHandposePayload {
  handposePayload: Uint8Array
  recognition: RecognitionResult | null
}

export function parseStreamHandposePayload(payload: Uint8Array): StreamHandposePayload {
  if (payload[0] !== 2) {
    return { handposePayload: payload, recognition: null }
  }

  const r = new PayloadReader(payload)
  const version = r.u8()
  if (version !== 2) {
    return { handposePayload: payload, recognition: null }
  }

  const flags = r.u8()
  r.u16() // reserved
  const handposePayloadSize = r.u32()
  const handposePayload = r.bytesOfLength(handposePayloadSize)

  if ((flags & 0x01) === 0) {
    return { handposePayload, recognition: null }
  }

  return {
    handposePayload,
    recognition: {
      sequenceNumber: r.u64(),
      timestampNs: r.u64(),
      recognized: r.u8() !== 0,
      gestureId: r.u32(),
      confidence: r.f32(),
      secondConfidence: r.f32(),
      confidenceMargin: r.f32(),
      distance: r.f32(),
      gestureName: r.string(),
    },
  }
}

export function parseHandposeFrame(payload: Uint8Array): HandposeFrame {
  const r = new PayloadReader(payload)
  const format = r.u8()
  const detectionCount = r.u8()
  const keypointCount = r.u16()

  const frame: HandposeFrame = {
    format,
    detectionCount,
    keypointCount,
    sequenceNumber: r.u64(),
    timestampNs: r.u64(),
    sourceSequenceNumber: r.u64(),
    sourceTimestampNs: r.u64(),
    imageWidth: r.u32(),
    imageHeight: r.u32(),
    modelWidth: r.u32(),
    modelHeight: r.u32(),
    detections: [],
  }

  for (let d = 0; d < detectionCount; d += 1) {
    const present = r.u8() !== 0
    const isLeftHand = r.u8() !== 0
    const classId = r.u16()
    const confidence = r.f32()
    const presenceConfidence = r.f32()
    const box = {
      left: r.f32(),
      top: r.f32(),
      right: r.f32(),
      bottom: r.f32(),
    }
    const keypoints: Keypoint[] = []
    for (let k = 0; k < KEYPOINT_COUNT; k += 1) {
      keypoints.push({ x: r.f32(), y: r.f32(), z: r.f32(), confidence: r.f32() })
    }
    frame.detections.push({
      present,
      isLeftHand,
      classId,
      confidence,
      presenceConfidence,
      box,
      keypoints,
    })
  }

  return frame
}

// MediaPipe-style hand connectivity for drawing the skeleton.
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  // thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // middle
  [9, 10], [10, 11], [11, 12],
  // ring
  [13, 14], [14, 15], [15, 16],
  // pinky
  [0, 17], [17, 18], [18, 19], [19, 20],
  // palm
  [5, 9], [9, 13], [13, 17],
]
