import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { SignlangClientError } from '@/ble/errors'
import { SignlangClient } from '@/ble/signlangClient'
import { ProtocolDecodeError, ProtocolStatusError } from '@/ble/protocol'
import type {
  DeviceStatus,
  GestureInfo,
  HandposeFrame,
  RecognitionResult,
} from '@/ble/protocol'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected'
export type DeviceNoticeKind = 'info' | 'success' | 'error'

const RECORDING_COUNTDOWN_MS = 5000
const RECORDING_COUNTDOWN_TICK_MS = 8

// Recognition results are momentary — drop them if no fresh result arrives.
const RECOGNITION_TTL_MS = 1000

export function useSignlangDevice() {
  const { t, te } = useI18n()
  const supported = SignlangClient.isSupported()

  const state = ref<ConnectionState>('disconnected')
  const deviceName = ref('')
  const status = ref<DeviceStatus | null>(null)
  const gestures = ref<GestureInfo[]>([])
  const streaming = ref(false)
  const error = ref('')

  // Frames arrive at high rate — keep them out of deep reactivity.
  const frame = shallowRef<HandposeFrame | null>(null)
  const recognition = shallowRef<RecognitionResult | null>(null)
  const fps = ref(0)

  // Gesture recording / upload state.
  const recordingPreparing = ref(false)
  const recordingCountdownMs = ref(0)
  const recording = ref(false)
  const recordedCount = ref(0)
  const recordedHandFrames = ref(0)
  const uploading = ref(false)
  const uploadProgress = ref(0)
  const uploadResult = ref('')

  // Raw wire frames captured while recording (kept out of reactivity).
  let recordedRaw: Uint8Array[] = []
  let frameTimestamps: number[] = []
  let recordingCountdownTimer: ReturnType<typeof setTimeout> | null = null
  let recordingCountdownEndsAt = 0
  let recognitionExpiryTimer: ReturnType<typeof setTimeout> | null = null

  const recordingSessionActive = computed(
    () => recordingPreparing.value || recording.value,
  )
  const recordingCountdownSeconds = computed(() =>
    recordingCountdownMs.value > 0
      ? Math.ceil(recordingCountdownMs.value / 1000)
      : 0,
  )
  const recordingCountdownProgress = computed(() =>
    Math.max(0, Math.min(1, recordingCountdownMs.value / RECORDING_COUNTDOWN_MS)),
  )

  function clearRecognitionExpiry() {
    if (recognitionExpiryTimer) {
      clearTimeout(recognitionExpiryTimer)
      recognitionExpiryTimer = null
    }
  }

  function setRecognition(result: RecognitionResult) {
    recognition.value = result
    clearRecognitionExpiry()
    recognitionExpiryTimer = setTimeout(() => {
      recognition.value = null
      recognitionExpiryTimer = null
    }, RECOGNITION_TTL_MS)
  }

  function pushNotice(kind: DeviceNoticeKind, title: string, message?: string) {
    if (kind === 'error') error.value = message || title
    toast[kind](title, { description: message })
  }

  function notifyError(err: unknown, title = t('notices.operationFailed')) {
    let message: string
    if (err instanceof ProtocolStatusError) {
      message = localizeProtocolStatusError(err)
    } else if (err instanceof ProtocolDecodeError) {
      message = localizeProtocolDecodeError(err)
    } else if (err instanceof SignlangClientError) {
      message = localizeSignlangClientError(err)
    } else {
      message = err instanceof Error ? err.message : String(err)
    }
    pushNotice('error', title, message)
  }

  function localizeProtocolStatusError(err: ProtocolStatusError): string {
    const commandKey = `protocol.commands.${err.command}`
    const statusKey = `protocol.statuses.${err.statusName}`
    const command = te(commandKey) ? t(commandKey) : err.command
    const status = te(statusKey)
      ? t(statusKey)
      : t('protocol.unknownStatus', { status: err.status })

    return err.deviceMessage
      ? t('protocol.errorWithMessage', {
          command,
          status,
          message: err.deviceMessage,
        })
      : t('protocol.error', { command, status })
  }

  function localizeProtocolDecodeError(err: ProtocolDecodeError): string {
    const key = `protocol.decodeErrors.${err.code}`
    return te(key) ? t(key, err.details) : err.code
  }

  function localizeSignlangClientError(err: SignlangClientError): string {
    const key = `protocol.clientErrors.${err.code}`
    return te(key) ? t(key) : err.code
  }

  function resetAfterDisconnect(notify: boolean) {
    const wasConnected = state.value === 'connected' || state.value === 'connecting'
    const disconnectedName = deviceName.value
    state.value = 'disconnected'
    streaming.value = false
    status.value = null
    gestures.value = []
    frame.value = null
    recognition.value = null
    clearRecognitionExpiry()
    fps.value = 0
    cancelRecordingCountdown()
    recording.value = false
    if (notify && wasConnected) {
      pushNotice('info', t('notices.bluetoothDisconnected'), disconnectedName || undefined)
    }
  }

  const client = new SignlangClient({
    onHandpose(f, raw, result) {
      frame.value = f
      if (result) setRecognition(result)
      const now = performance.now()
      frameTimestamps.push(now)
      const cutoff = now - 1000
      frameTimestamps = frameTimestamps.filter((t) => t >= cutoff)
      fps.value = frameTimestamps.length

      const hasHand = f.detections.some((d) => d.present)
      if (recording.value && hasHand) {
        recordedRaw.push(raw)
        recordedCount.value = recordedRaw.length
        recordedHandFrames.value += 1
      }
    },
    onDisconnect() {
      resetAfterDisconnect(true)
    },
    onError(err) {
      notifyError(err, t('notices.bluetoothNotifyFailed'))
    },
  })

  const handCount = computed(
    () => frame.value?.detections.filter((d) => d.present).length ?? 0,
  )

  // Encoder window size — a useful "record at least this many frames" hint.
  const recommendedFrames = computed(() => status.value?.encoderSequenceLen ?? 0)

  async function connect() {
    error.value = ''
    state.value = 'connecting'
    try {
      await client.connect()
      deviceName.value = client.deviceName
      state.value = 'connected'
      status.value = await client.getStatus()
      gestures.value = await client.listGestures()
      await setStreaming(true)
      pushNotice('success', t('notices.bluetoothConnected'), deviceName.value || 'SignLang Eyes')
    } catch (err) {
      state.value = 'disconnected'
      await client.disconnect()
      notifyError(err, t('notices.bluetoothConnectFailed'))
    }
  }

  async function disconnect() {
    const wasConnected = state.value === 'connected' || state.value === 'connecting'
    await client.disconnect()
    if (wasConnected && state.value !== 'disconnected') {
      resetAfterDisconnect(true)
    }
  }

  async function setStreaming(enabled: boolean) {
    try {
      await client.setStreaming(enabled)
      streaming.value = enabled
      if (status.value) status.value.streamingEnabled = enabled
    } catch (err) {
      notifyError(
        err,
        enabled ? t('notices.streamStartFailed') : t('notices.streamStopFailed'),
      )
    }
  }

  async function refreshGestures() {
    try {
      gestures.value = await client.listGestures()
    } catch (err) {
      notifyError(err, t('notices.refreshGesturesFailed'))
    }
  }

  // --- Recording -------------------------------------------------------------

  async function startRecording() {
    if (recordingSessionActive.value) return
    error.value = ''
    uploadResult.value = ''
    clearRecording()
    if (!streaming.value) await setStreaming(true)
    startRecordingCountdown()
  }

  function startRecordingCountdown() {
    cancelRecordingCountdown()
    recording.value = false
    recordingPreparing.value = true
    recordingCountdownEndsAt = Date.now() + RECORDING_COUNTDOWN_MS
    recordingCountdownMs.value = RECORDING_COUNTDOWN_MS
    scheduleRecordingCountdownTick()
  }

  function scheduleRecordingCountdownTick() {
    const nextDelay = Math.min(
      RECORDING_COUNTDOWN_TICK_MS,
      Math.max(0, recordingCountdownMs.value),
    )
    recordingCountdownTimer = setTimeout(updateRecordingCountdown, nextDelay)
  }

  function updateRecordingCountdown() {
    const remaining = Math.max(0, recordingCountdownEndsAt - Date.now())
    recordingCountdownMs.value = remaining
    if (remaining === 0) {
      finishRecordingCountdown()
    } else if (recordingPreparing.value) {
      scheduleRecordingCountdownTick()
    }
  }

  function finishRecordingCountdown() {
    if (recordingCountdownTimer) {
      clearTimeout(recordingCountdownTimer)
      recordingCountdownTimer = null
    }
    recordingCountdownEndsAt = 0
    recordingCountdownMs.value = 0
    if (!recordingPreparing.value) return
    recordingPreparing.value = false
    recording.value = true
    pushNotice('info', t('notices.recordingStarted'), t('notices.recordingStartedDesc'))
  }

  function cancelRecordingCountdown() {
    if (recordingCountdownTimer) {
      clearTimeout(recordingCountdownTimer)
      recordingCountdownTimer = null
    }
    recordingCountdownEndsAt = 0
    recordingCountdownMs.value = 0
    recordingPreparing.value = false
  }

  function stopRecording() {
    const wasSessionActive = recordingSessionActive.value
    cancelRecordingCountdown()
    recording.value = false
    if (wasSessionActive) {
      pushNotice('info', t('notices.recordingStopped'), t('notices.recordingStoppedDesc', { count: recordedCount.value }))
    }
  }

  function cancelRecording() {
    const wasSessionActive = recordingSessionActive.value
    cancelRecordingCountdown()
    recording.value = false
    clearRecording()
    if (wasSessionActive) {
      pushNotice('info', t('notices.recordingCancelled'), t('notices.recordingCancelledDesc'))
    }
  }

  function clearRecording() {
    recordedRaw = []
    recordedCount.value = 0
    recordedHandFrames.value = 0
  }

  // --- Upload / delete -------------------------------------------------------

  // Both upload and delete modify the prototype DB; per §4 we pause the stream
  // first so stream packets don't interleave with command responses.
  async function withStreamPaused<T>(fn: () => Promise<T>): Promise<T> {
    const wasStreaming = streaming.value
    if (wasStreaming) {
      try {
        await client.setStreaming(false)
        streaming.value = false
        // No frames arrive while paused — drop the last one so the live
        // preview falls back to its idle state instead of looking frozen.
        frame.value = null
        recognition.value = null
        clearRecognitionExpiry()
      } catch {
        // tolerate — reassembly still routes responses correctly
      }
    }
    try {
      return await fn()
    } finally {
      if (wasStreaming) {
        try {
          await client.setStreaming(true)
          streaming.value = true
        } catch {
          /* ignore resume failure */
        }
      }
    }
  }

  async function uploadGesture(name: string, replaceExisting: boolean) {
    error.value = ''
    uploadResult.value = ''
    if (recordingSessionActive.value) stopRecording()
    if (!name.trim()) {
      notifyError(t('notices.nameRequired'), t('notices.uploadBlocked'))
      return
    }
    if (recordedRaw.length === 0) {
      notifyError(t('notices.framesRequired'), t('notices.uploadBlocked'))
      return
    }

    const frames = recordedRaw
    uploading.value = true
    uploadProgress.value = 0
    try {
      const gestureId = await withStreamPaused(() =>
        client.uploadGesture({
          name,
          frames,
          replaceExisting,
          onProgress: (sent, total) => {
            uploadProgress.value = total > 0 ? sent / total : 0
          },
        }),
      )
      uploadResult.value = t('notices.uploadSuccessDesc', {
        name,
        id: gestureId,
        count: frames.length,
      })
      pushNotice('success', t('notices.uploadSuccess'), uploadResult.value)
      clearRecording()
      await refreshGestures()
    } catch (err) {
      notifyError(err, t('notices.uploadFailed'))
    } finally {
      uploading.value = false
    }
  }

  async function deleteGesture(g: GestureInfo) {
    error.value = ''
    uploadResult.value = ''
    try {
      await withStreamPaused(() => client.deleteGestureById(g.id))
      await refreshGestures()
      pushNotice('success', t('notices.deleteSuccess'), t('notices.deleteSuccessDesc', { name: g.name, id: g.id }))
    } catch (err) {
      notifyError(err, t('notices.deleteFailed'))
    }
  }

  return {
    supported,
    state,
    deviceName,
    status,
    gestures,
    streaming,
    error,
    frame,
    recognition,
    fps,
    handCount,
    recommendedFrames,
    recordingPreparing,
    recordingCountdownMs,
    recordingCountdownSeconds,
    recordingCountdownProgress,
    recordingSessionActive,
    recording,
    recordedCount,
    recordedHandFrames,
    uploading,
    uploadProgress,
    uploadResult,
    connect,
    disconnect,
    setStreaming,
    refreshGestures,
    startRecording,
    stopRecording,
    cancelRecording,
    clearRecording,
    uploadGesture,
    deleteGesture,
  }
}
