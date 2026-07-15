import { expect } from 'vitest'

import { ProtocolDecodeError, type ProtocolDecodeErrorCode } from '../../../src/ble/protocol'

export function expectProtocolDecodeError(
  action: () => unknown,
  code: ProtocolDecodeErrorCode,
  details: Readonly<Record<string, number>> = {},
): void {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(ProtocolDecodeError)
  const protocolError = caught as ProtocolDecodeError
  expect(protocolError.code).toBe(code)
  expect(protocolError.details).toMatchObject(details)
}
