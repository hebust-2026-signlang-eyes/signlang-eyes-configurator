import { describe, expect, it } from 'vitest'

import {
  CommandId,
  HEADER_SIZE,
  MAGIC,
  PROTOCOL_VERSION,
  PacketType,
  ProtocolDecodeErrorCode,
  crc32,
  decodePacket,
  encodePacket,
} from '../../../src/ble/protocol'
import { expectProtocolDecodeError } from './error-assertions'

function encodedPacket(): Uint8Array {
  return encodePacket({
    type: PacketType.Response,
    commandId: CommandId.ListGestures,
    requestId: 0x78563412,
    flags: 0x1234,
    payload: Uint8Array.of(0x10, 0x20, 0x30),
  })
}

describe('crc32', () => {
  it('matches the standard CRC32 check vector', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
})

describe('SLM1 packet codec', () => {
  it('encodes and decodes a packet without losing header fields', () => {
    const packet = encodedPacket()

    expect(packet).toHaveLength(HEADER_SIZE + 3)
    expect(packet.slice(0, MAGIC.length)).toEqual(MAGIC)
    expect(decodePacket(packet)).toEqual({
      type: PacketType.Response,
      commandId: CommandId.ListGestures,
      requestId: 0x78563412,
      flags: 0x1234,
      payload: Uint8Array.of(0x10, 0x20, 0x30),
    })
  })

  it('rejects packets shorter than the fixed header', () => {
    expectProtocolDecodeError(
      () => decodePacket(new Uint8Array(HEADER_SIZE - 1)),
      ProtocolDecodeErrorCode.PacketTooShort,
      { actual: HEADER_SIZE - 1, expected: HEADER_SIZE },
    )
  })

  it('rejects an invalid magic value', () => {
    const packet = encodedPacket()
    packet[0] = 0

    expectProtocolDecodeError(() => decodePacket(packet), ProtocolDecodeErrorCode.BadMagic)
  })

  it('rejects an unsupported protocol version', () => {
    const packet = encodedPacket()
    packet[4] = PROTOCOL_VERSION + 1

    expectProtocolDecodeError(
      () => decodePacket(packet),
      ProtocolDecodeErrorCode.UnsupportedVersion,
      { version: PROTOCOL_VERSION + 1, expected: PROTOCOL_VERSION },
    )
  })

  it('rejects an unsupported header size', () => {
    const packet = encodedPacket()
    new DataView(packet.buffer).setUint16(14, HEADER_SIZE + 1, true)

    expectProtocolDecodeError(
      () => decodePacket(packet),
      ProtocolDecodeErrorCode.UnsupportedHeaderSize,
      { actual: HEADER_SIZE + 1, expected: HEADER_SIZE },
    )
  })

  it('rejects a packet whose declared payload size does not match', () => {
    const packet = encodedPacket().slice(0, -1)

    expectProtocolDecodeError(
      () => decodePacket(packet),
      ProtocolDecodeErrorCode.PacketSizeMismatch,
      { actual: packet.length, expected: HEADER_SIZE + 3 },
    )
  })

  it('rejects a payload that does not match its CRC', () => {
    const packet = encodedPacket()
    packet[HEADER_SIZE] = packet[HEADER_SIZE]! ^ 0xff

    expectProtocolDecodeError(
      () => decodePacket(packet),
      ProtocolDecodeErrorCode.PayloadCrcMismatch,
    )
  })
})
