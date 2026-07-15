import { describe, expect, it } from 'vitest'

import { ProtocolDecodeErrorCode, STATUS_NAME } from '../../../src/ble/protocol'
import { SignlangClientErrorCode } from '../../../src/ble/errors'
import { messages } from '../../../src/i18n'

const protocolCommands = [
  'GetStatus',
  'GetCapabilities',
  'ListGestures',
  'SetStreamConfig',
  'DeleteGesture',
  'AddGestureBegin',
  'AddGestureChunk',
  'AddGestureCommit',
  'AddGestureAbort',
]

for (const [locale, localeMessages] of Object.entries(messages)) {
  describe(`${locale} protocol messages`, () => {
    it('defines every protocol command', () => {
      expect(Object.keys(localeMessages.protocol.commands).sort()).toEqual(
        [...protocolCommands].sort(),
      )
    })

    it('defines every known protocol status', () => {
      expect(Object.keys(localeMessages.protocol.statuses).sort()).toEqual(
        Object.values(STATUS_NAME).sort(),
      )
    })

    it('defines every protocol decode error', () => {
      expect(Object.keys(localeMessages.protocol.decodeErrors).sort()).toEqual(
        Object.values(ProtocolDecodeErrorCode).sort(),
      )
    })

    it('defines every BLE client error', () => {
      expect(Object.keys(localeMessages.protocol.clientErrors).sort()).toEqual(
        Object.values(SignlangClientErrorCode).sort(),
      )
    })

    it('keeps required placeholders in error templates', () => {
      expect(localeMessages.protocol.error).toContain('{command}')
      expect(localeMessages.protocol.error).toContain('{status}')
      expect(localeMessages.protocol.errorWithMessage).toContain('{command}')
      expect(localeMessages.protocol.errorWithMessage).toContain('{status}')
      expect(localeMessages.protocol.errorWithMessage).toContain('{message}')
      expect(localeMessages.protocol.unknownStatus).toContain('{status}')
    })
  })
}
