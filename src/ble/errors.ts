export const SignlangClientErrorCode = {
  WebBluetoothUnavailable: 'webBluetoothUnavailable',
  MissingGattServer: 'missingGattServer',
  Disconnected: 'disconnected',
  PacketSyncLost: 'packetSyncLost',
  NotConnected: 'notConnected',
  CommandTimeout: 'commandTimeout',
  GestureNameRequired: 'gestureNameRequired',
  GestureFramesRequired: 'gestureFramesRequired',
} as const

export type SignlangClientErrorCode =
  (typeof SignlangClientErrorCode)[keyof typeof SignlangClientErrorCode]

export class SignlangClientError extends Error {
  constructor(readonly code: SignlangClientErrorCode) {
    super(code)
    this.name = 'SignlangClientError'
  }
}
