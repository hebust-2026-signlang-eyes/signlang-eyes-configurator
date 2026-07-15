// High-level client around the SLM1 BLE protocol: handles connection,
// TX notification reassembly, request/response correlation, and the
// real-time handpose stream.

import { SignlangClientError, SignlangClientErrorCode } from './errors'
import {
  CommandId,
  PacketType,
  PayloadWriter,
  RX_UUID,
  SERVICE_UUID,
  Status,
  TX_UUID,
  buildGestureBlob,
  decodePacket,
  encodePacket,
  parseGestureList,
  parseHandposeFrame,
  parseStreamHandposePayload,
  parseStatus,
  readStatusResponse,
  statusError,
  type DecodedPacket,
  type DeviceStatus,
  type GestureInfo,
  type HandposeFrame,
  type RecognitionResult,
} from './protocol'

interface PendingRequest {
  resolve: (packet: DecodedPacket) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface SignlangClientCallbacks {
  // `raw` is the wire_handpose_frame payload, retained for gesture recording.
  onHandpose?: (
    frame: HandposeFrame,
    raw: Uint8Array,
    recognition: RecognitionResult | null,
  ) => void
  onDisconnect?: () => void
  onError?: (err: Error) => void
}

export interface UploadGestureOptions {
  name: string
  frames: Uint8Array[]
  replaceExisting: boolean
  chunkSize?: number
  onProgress?: (sent: number, total: number) => void
}

const REQUEST_TIMEOUT_MS = 5000
const DEFAULT_CHUNK_SIZE = 180
const MIN_CHUNK_SIZE = 20

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export class SignlangClient {
  private device: BluetoothDevice | null = null
  private server: BluetoothRemoteGATTServer | null = null
  private rx: BluetoothRemoteGATTCharacteristic | null = null
  private tx: BluetoothRemoteGATTCharacteristic | null = null

  private notifyBuffer: Uint8Array = new Uint8Array(0)
  private nextRequestId = 1
  private readonly pending = new Map<string, PendingRequest>()

  private readonly onTxValue = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic
    const view = target.value
    if (!view) return
    const chunk = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    this.ingest(chunk)
  }

  private readonly onGattDisconnected = () => {
    this.cleanupAfterDisconnect()
    this.callbacks.onDisconnect?.()
  }

  constructor(private readonly callbacks: SignlangClientCallbacks = {}) {}

  get connected(): boolean {
    return this.server?.connected ?? false
  }

  get deviceName(): string {
    return this.device?.name ?? 'unknown'
  }

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth
  }

  async connect(): Promise<void> {
    if (!navigator.bluetooth) {
      throw new SignlangClientError(SignlangClientErrorCode.WebBluetoothUnavailable)
    }

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    })
    this.device = device
    device.addEventListener('gattserverdisconnected', this.onGattDisconnected)

    if (!device.gatt) {
      throw new SignlangClientError(SignlangClientErrorCode.MissingGattServer)
    }
    this.server = await device.gatt.connect()

    const service = await this.server.getPrimaryService(SERVICE_UUID)
    this.rx = await service.getCharacteristic(RX_UUID)
    this.tx = await service.getCharacteristic(TX_UUID)

    // Subscribe to notifications BEFORE sending any command.
    this.notifyBuffer = new Uint8Array(0)
    await this.tx.startNotifications()
    this.tx.addEventListener('characteristicvaluechanged', this.onTxValue)
  }

  async disconnect(): Promise<void> {
    const wasConnected = this.connected
    this.device?.removeEventListener('gattserverdisconnected', this.onGattDisconnected)
    if (this.tx) {
      try {
        await this.tx.stopNotifications()
      } catch {
        // ignore — device may already be gone
      }
    }
    this.server?.disconnect()
    this.cleanupAfterDisconnect()
    if (wasConnected) this.callbacks.onDisconnect?.()
  }

  private cleanupAfterDisconnect(): void {
    this.tx?.removeEventListener('characteristicvaluechanged', this.onTxValue)
    this.device?.removeEventListener('gattserverdisconnected', this.onGattDisconnected)
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new SignlangClientError(SignlangClientErrorCode.Disconnected))
    }
    this.pending.clear()
    this.notifyBuffer = new Uint8Array(0)
    this.rx = null
    this.tx = null
    this.server = null
    this.device = null
  }

  // --- Notification reassembly ----------------------------------------------

  private ingest(chunk: Uint8Array): void {
    this.notifyBuffer = concat(this.notifyBuffer, chunk)

    while (this.notifyBuffer.length >= 24) {
      if (
        this.notifyBuffer[0] !== 0x53 ||
        this.notifyBuffer[1] !== 0x4c ||
        this.notifyBuffer[2] !== 0x4d ||
        this.notifyBuffer[3] !== 0x31
      ) {
        // Sync lost — drop the buffer rather than crash the stream.
        this.callbacks.onError?.(
          new SignlangClientError(SignlangClientErrorCode.PacketSyncLost),
        )
        this.notifyBuffer = new Uint8Array(0)
        return
      }

      const view = new DataView(
        this.notifyBuffer.buffer,
        this.notifyBuffer.byteOffset,
        this.notifyBuffer.byteLength,
      )
      const headerSize = view.getUint16(14, true)
      const payloadSize = view.getUint32(16, true)
      const packetSize = headerSize + payloadSize

      if (this.notifyBuffer.length < packetSize) return

      const packetBytes = this.notifyBuffer.slice(0, packetSize)
      this.notifyBuffer = this.notifyBuffer.slice(packetSize)

      try {
        this.handlePacket(decodePacket(packetBytes))
      } catch (err) {
        this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }

  private handlePacket(packet: DecodedPacket): void {
    if (packet.type === PacketType.Stream && packet.commandId === CommandId.HandposeFrame) {
      const stream = parseStreamHandposePayload(packet.payload)
      this.callbacks.onHandpose?.(
        parseHandposeFrame(stream.handposePayload),
        stream.handposePayload,
        stream.recognition,
      )
      return
    }

    if (packet.type === PacketType.Response) {
      const key = `${packet.commandId}:${packet.requestId}`
      const entry = this.pending.get(key)
      if (entry) {
        clearTimeout(entry.timer)
        this.pending.delete(key)
        entry.resolve(packet)
      }
    }
  }

  // --- Commands -------------------------------------------------------------

  private async writeCommand(commandId: number, payload: Uint8Array): Promise<DecodedPacket> {
    if (!this.rx) {
      throw new SignlangClientError(SignlangClientErrorCode.NotConnected)
    }
    const requestId = this.nextRequestId++
    const packet = encodePacket({
      type: PacketType.Request,
      commandId,
      requestId,
      payload,
    })

    const key = `${commandId}:${requestId}`
    const responsePromise = new Promise<DecodedPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(new SignlangClientError(SignlangClientErrorCode.CommandTimeout))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(key, { resolve, reject, timer })
    })

    if (this.rx.properties.writeWithoutResponse) {
      await this.rx.writeValueWithoutResponse(packet)
    } else {
      await this.rx.writeValueWithResponse(packet)
    }

    return responsePromise
  }

  async getStatus(): Promise<DeviceStatus> {
    const resp = await this.writeCommand(CommandId.GetStatus, new Uint8Array())
    return parseStatus(resp.payload)
  }

  async getCapabilities(): Promise<DeviceStatus> {
    const resp = await this.writeCommand(CommandId.GetCapabilities, new Uint8Array())
    return parseStatus(resp.payload, 'GetCapabilities')
  }

  private expectOk(payload: Uint8Array, label: string): void {
    const res = readStatusResponse(payload)
    if (res.status !== Status.Ok) throw statusError(label, res)
  }

  async setStreaming(enabled: boolean): Promise<void> {
    const payload = new PayloadWriter().u8(enabled ? 1 : 0).finish()
    const resp = await this.writeCommand(CommandId.SetStreamConfig, payload)
    this.expectOk(resp.payload, 'SetStreamConfig')
  }

  async listGestures(): Promise<GestureInfo[]> {
    const resp = await this.writeCommand(CommandId.ListGestures, new Uint8Array())
    return parseGestureList(resp.payload)
  }

  async deleteGestureById(id: number): Promise<void> {
    const payload = new PayloadWriter().u8(1).u32(id).finish()
    const resp = await this.writeCommand(CommandId.DeleteGesture, payload)
    this.expectOk(resp.payload, 'DeleteGesture')
  }

  async deleteGestureByName(name: string): Promise<void> {
    const payload = new PayloadWriter().u8(2).string(name).finish()
    const resp = await this.writeCommand(CommandId.DeleteGesture, payload)
    this.expectOk(resp.payload, 'DeleteGesture')
  }

  // --- Gesture upload (§8.6–8.9, §10) ---------------------------------------

  private async addGestureBegin(
    transferId: number,
    totalSize: number,
    replaceExisting: boolean,
    name: string,
  ): Promise<void> {
    const payload = new PayloadWriter()
      .u32(transferId)
      .u32(totalSize)
      .u8(replaceExisting ? 1 : 0)
      .string(name)
      .finish()
    const resp = await this.writeCommand(CommandId.AddGestureBegin, payload)
    this.expectOk(resp.payload, 'AddGestureBegin')
  }

  private async addGestureChunk(
    transferId: number,
    offset: number,
    data: Uint8Array,
  ): Promise<void> {
    const payload = new PayloadWriter()
      .u32(transferId)
      .u32(offset)
      .u32(data.length)
      .pushBytes(data)
      .finish()
    const resp = await this.writeCommand(CommandId.AddGestureChunk, payload)
    this.expectOk(resp.payload, 'AddGestureChunk')
  }

  private async addGestureCommit(transferId: number): Promise<number> {
    const payload = new PayloadWriter().u32(transferId).finish()
    const resp = await this.writeCommand(CommandId.AddGestureCommit, payload)
    const res = readStatusResponse(resp.payload)
    if (res.status !== Status.Ok) throw statusError('AddGestureCommit', res)
    // OK body is `u16 status` followed by `u32 gesture_id`.
    return new DataView(
      resp.payload.buffer,
      resp.payload.byteOffset,
      resp.payload.byteLength,
    ).getUint32(2, true)
  }

  async addGestureAbort(): Promise<void> {
    const resp = await this.writeCommand(CommandId.AddGestureAbort, new Uint8Array())
    this.expectOk(resp.payload, 'AddGestureAbort')
  }

  // Writes the blob as a sequence of AddGestureChunk commands. Chunk size
  // shrinks automatically if a GATT write is rejected for being too large (§5).
  private async writeBlobChunks(
    transferId: number,
    blob: Uint8Array,
    initialChunkSize: number,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<void> {
    let chunkSize = initialChunkSize
    let offset = 0
    onProgress?.(0, blob.length)
    while (offset < blob.length) {
      const end = Math.min(offset + chunkSize, blob.length)
      try {
        await this.addGestureChunk(transferId, offset, blob.subarray(offset, end))
      } catch (err) {
        if (chunkSize > MIN_CHUNK_SIZE) {
          chunkSize = Math.max(MIN_CHUNK_SIZE, chunkSize >> 1)
          continue // retry the same offset with a smaller chunk
        }
        throw err
      }
      offset = end
      onProgress?.(offset, blob.length)
    }
  }

  // Full upload flow: begin -> chunked write -> commit. On any failure the
  // session is aborted.
  async uploadGesture(opts: UploadGestureOptions): Promise<number> {
    const name = opts.name.trim()
    if (!name) {
      throw new SignlangClientError(SignlangClientErrorCode.GestureNameRequired)
    }
    if (opts.frames.length === 0) {
      throw new SignlangClientError(SignlangClientErrorCode.GestureFramesRequired)
    }

    const blob = buildGestureBlob(opts.frames)
    const transferId = Math.floor(Math.random() * 0x1_0000_0000) >>> 0

    await this.addGestureBegin(transferId, blob.length, opts.replaceExisting, name)
    try {
      await this.writeBlobChunks(
        transferId,
        blob,
        opts.chunkSize ?? DEFAULT_CHUNK_SIZE,
        opts.onProgress,
      )
      return await this.addGestureCommit(transferId)
    } catch (err) {
      await this.addGestureAbort().catch(() => {
        // best-effort cleanup; surface the original error
      })
      throw err
    }
  }
}
