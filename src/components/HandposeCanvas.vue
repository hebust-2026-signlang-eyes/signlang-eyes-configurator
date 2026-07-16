<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import {
  type HandDetection,
  type HandposeFrame,
  type Keypoint,
  type RecognitionResult,
} from '@/ble/protocol'
import {
  COUNTDOWN_NUMBER_COLOR,
  COUNTDOWN_NUMBER_WEIGHT,
  countdownWipeAngles,
} from '@/lib/countdownOverlay'

const props = withDefaults(
  defineProps<{
    frame: HandposeFrame | null
    emptyLabel?: string
    leftLabel?: string
    rightLabel?: string
    recognition: RecognitionResult | null
    hideRecognition?: boolean
    countdownSeconds?: number
    countdownProgress?: number
    themeKey?: string
  }>(),
  {
    emptyLabel: 'No hand detected',
    leftLabel: 'Left',
    rightLabel: 'Right',
    recognition: null,
    hideRecognition: false,
    countdownSeconds: 0,
    countdownProgress: 0,
    themeKey: '',
  },
)

const canvasRef = ref<HTMLCanvasElement | null>(null)

let smoothBox: Bounds | null = null

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface ProjectedPoint {
  x: number
  y: number
  z: number
  depth: number
}

interface SceneColors {
  background: string
  grid: string
  surface: string
  shadow: string
  foreground: string
  muted: string
  accent: string
}

const PALM_POINTS = [0, 5, 9, 13, 17]
const FINGER_PATHS = [
  [0, 1, 2, 3, 4],
  [0, 5, 6, 7, 8],
  [0, 9, 10, 11, 12],
  [0, 13, 14, 15, 16],
  [0, 17, 18, 19, 20],
]

const IDLE_KEYPOINTS: Keypoint[] = [
  { x: 0.5, y: 0.84, z: 0.04, confidence: 1 },
  { x: 0.42, y: 0.72, z: 0.02, confidence: 1 },
  { x: 0.34, y: 0.63, z: -0.01, confidence: 1 },
  { x: 0.28, y: 0.54, z: -0.03, confidence: 1 },
  { x: 0.23, y: 0.45, z: -0.04, confidence: 1 },
  { x: 0.44, y: 0.59, z: -0.02, confidence: 1 },
  { x: 0.42, y: 0.44, z: -0.05, confidence: 1 },
  { x: 0.41, y: 0.31, z: -0.07, confidence: 1 },
  { x: 0.4, y: 0.2, z: -0.08, confidence: 1 },
  { x: 0.5, y: 0.56, z: -0.03, confidence: 1 },
  { x: 0.5, y: 0.39, z: -0.07, confidence: 1 },
  { x: 0.5, y: 0.24, z: -0.09, confidence: 1 },
  { x: 0.5, y: 0.12, z: -0.1, confidence: 1 },
  { x: 0.57, y: 0.59, z: -0.01, confidence: 1 },
  { x: 0.6, y: 0.44, z: -0.04, confidence: 1 },
  { x: 0.62, y: 0.31, z: -0.06, confidence: 1 },
  { x: 0.64, y: 0.22, z: -0.07, confidence: 1 },
  { x: 0.64, y: 0.65, z: 0.01, confidence: 1 },
  { x: 0.7, y: 0.54, z: -0.01, confidence: 1 },
  { x: 0.74, y: 0.44, z: -0.03, confidence: 1 },
  { x: 0.78, y: 0.35, z: -0.04, confidence: 1 },
]

function computeBoundsFromDetections(detections: HandDetection[]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let any = false

  for (const det of detections) {
    if (!det.present) continue
    for (const kp of det.keypoints) {
      if (!Number.isFinite(kp.x) || !Number.isFinite(kp.y)) continue
      any = true
      minX = Math.min(minX, kp.x)
      minY = Math.min(minY, kp.y)
      maxX = Math.max(maxX, kp.x)
      maxY = Math.max(maxY, kp.y)
    }
  }

  return any ? { minX, minY, maxX, maxY } : null
}

function fitBounds(raw: Bounds, width: number, height: number) {
  if (!smoothBox) {
    smoothBox = { ...raw }
  } else {
    const amount = 0.3
    smoothBox.minX += (raw.minX - smoothBox.minX) * amount
    smoothBox.minY += (raw.minY - smoothBox.minY) * amount
    smoothBox.maxX += (raw.maxX - smoothBox.maxX) * amount
    smoothBox.maxY += (raw.maxY - smoothBox.maxY) * amount
  }

  const box = smoothBox
  const pad = 0.18
  const boxWidth = Math.max(box.maxX - box.minX, 1e-3)
  const boxHeight = Math.max(box.maxY - box.minY, 1e-3)
  const padX = boxWidth * pad
  const padY = boxHeight * pad
  const spanX = boxWidth + padX * 2
  const spanY = boxHeight + padY * 2
  const scale = Math.min(width / spanX, height / spanY)
  const offsetX = (width - spanX * scale) / 2
  const offsetY = (height - spanY * scale) / 2

  return {
    tx: (x: number) => offsetX + (x - (box.minX - padX)) * scale,
    ty: (y: number) => offsetY + (y - (box.minY - padY)) * scale,
  }
}

function cssVar(name: string, fallback: string) {
  const canvas = canvasRef.value
  if (!canvas) return fallback
  return getComputedStyle(canvas).getPropertyValue(name).trim() || fallback
}

function sceneColors(): SceneColors {
  return {
    background: cssVar('--canvas-bg', 'hsl(216 25% 8%)'),
    grid: cssVar('--canvas-grid', 'hsl(216 17% 21%)'),
    surface: cssVar('--hand-surface', 'hsl(185 23% 22%)'),
    shadow: cssVar('--hand-shadow', 'hsl(216 35% 3%)'),
    foreground: cssVar('--foreground', 'hsl(210 28% 93%)'),
    muted: cssVar('--muted-foreground', 'hsl(214 12% 62%)'),
    accent: cssVar('--accent', 'hsl(176 58% 32%)'),
  }
}

function drawBackground(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const colors = sceneColors()
  ctx.fillStyle = colors.background
  ctx.fillRect(0, 0, width, height)

  ctx.save()
  ctx.globalAlpha = 0.28
  ctx.strokeStyle = colors.grid
  ctx.lineWidth = 1
  const step = width < 520 ? 32 : 40
  for (let x = step; x < width; x += step) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }
  for (let y = step; y < height; y += step) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }
  ctx.restore()

  const glow = ctx.createRadialGradient(
    width * 0.5,
    height * 0.45,
    0,
    width * 0.5,
    height * 0.45,
    Math.max(width, height) * 0.62,
  )
  glow.addColorStop(0, colors.accent)
  glow.addColorStop(1, colors.background)
  ctx.save()
  ctx.globalAlpha = 0.12
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, width, height)
  ctx.restore()
}

function projectPoints(
  keypoints: Keypoint[],
  tx: (x: number) => number,
  ty: (y: number) => number,
) {
  const zValues = keypoints.map((kp) => kp.z).filter(Number.isFinite)
  const minZ = Math.min(...zValues)
  const maxZ = Math.max(...zValues)
  const zSpan = Math.max(maxZ - minZ, 1e-4)

  return keypoints.map((kp) => {
    const depth = 1 - (kp.z - minZ) / zSpan
    return {
      x: tx(kp.x),
      y: ty(kp.y),
      z: kp.z,
      depth: Math.max(0, Math.min(1, depth)),
    }
  })
}

function pointAt(points: ProjectedPoint[], index: number) {
  return points[index] ?? null
}

function drawPath(
  ctx: CanvasRenderingContext2D,
  points: ProjectedPoint[],
  indices: number[],
) {
  const first = pointAt(points, indices[0] ?? -1)
  if (!first) return false

  ctx.beginPath()
  ctx.moveTo(first.x, first.y)
  for (let i = 1; i < indices.length; i += 1) {
    const point = pointAt(points, indices[i] ?? -1)
    if (!point) return false
    ctx.lineTo(point.x, point.y)
  }
  return true
}

function drawPalm(
  ctx: CanvasRenderingContext2D,
  points: ProjectedPoint[],
  colors: SceneColors,
  tint: string,
  inactive: boolean,
) {
  if (!drawPath(ctx, points, PALM_POINTS)) return
  ctx.closePath()

  ctx.save()
  ctx.shadowColor = colors.shadow
  ctx.shadowBlur = inactive ? 12 : 22
  ctx.shadowOffsetY = inactive ? 8 : 14
  ctx.globalAlpha = inactive ? 0.2 : 0.32
  ctx.fillStyle = tint
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.globalAlpha = inactive ? 0.12 : 0.2
  ctx.strokeStyle = tint
  ctx.lineWidth = 4
  ctx.stroke()
  ctx.restore()
}

function drawSegment(
  ctx: CanvasRenderingContext2D,
  start: ProjectedPoint,
  end: ProjectedPoint,
  colors: SceneColors,
  tint: string,
  inactive: boolean,
) {
  const depth = (start.depth + end.depth) / 2
  const width = inactive ? 9 + depth * 5 : 11 + depth * 8

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.shadowColor = colors.shadow
  ctx.shadowBlur = inactive ? 8 : 16
  ctx.shadowOffsetY = inactive ? 5 : 9
  ctx.globalAlpha = inactive ? 0.38 : 0.78
  ctx.strokeStyle = colors.surface
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(start.x, start.y)
  ctx.lineTo(end.x, end.y)
  ctx.stroke()
  ctx.restore()

  ctx.save()
  ctx.lineCap = 'round'
  ctx.globalAlpha = inactive ? 0.1 : 0.22
  ctx.strokeStyle = tint
  ctx.lineWidth = width + 1
  ctx.beginPath()
  ctx.moveTo(start.x, start.y)
  ctx.lineTo(end.x, end.y)
  ctx.stroke()
  ctx.restore()

  ctx.save()
  ctx.lineCap = 'round'
  ctx.globalAlpha = inactive ? 0.18 : 0.35
  ctx.strokeStyle = colors.foreground
  ctx.lineWidth = Math.max(1.2, width * 0.13)
  ctx.beginPath()
  ctx.moveTo(start.x - 1.2, start.y - 1.2)
  ctx.lineTo(end.x - 1.2, end.y - 1.2)
  ctx.stroke()
  ctx.restore()
}

function drawFingerVolumes(
  ctx: CanvasRenderingContext2D,
  points: ProjectedPoint[],
  colors: SceneColors,
  tint: string,
  inactive: boolean,
) {
  const segments = FINGER_PATHS.flatMap((path) =>
    path.slice(0, -1).map((startIndex, i) => {
      const endIndex = path[i + 1]!
      const start = pointAt(points, startIndex)
      const end = pointAt(points, endIndex)
      if (!start || !end) return null
      return { start, end, depth: (start.depth + end.depth) / 2 }
    }),
  )
    .filter((segment): segment is NonNullable<typeof segment> => segment !== null)
    .sort((a, b) => a.depth - b.depth)

  for (const segment of segments) {
    drawSegment(ctx, segment.start, segment.end, colors, tint, inactive)
  }
}

function drawJointCaps(
  ctx: CanvasRenderingContext2D,
  points: ProjectedPoint[],
  colors: SceneColors,
  tint: string,
  inactive: boolean,
) {
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i]!
    const radius = (i === 0 ? 6.5 : 4.4) + point.depth * (inactive ? 1.4 : 2.6)
    const gradient = ctx.createRadialGradient(
      point.x - radius * 0.32,
      point.y - radius * 0.38,
      radius * 0.2,
      point.x,
      point.y,
      radius,
    )
    gradient.addColorStop(0, colors.foreground)
    gradient.addColorStop(0.42, colors.surface)
    gradient.addColorStop(1, tint)

    ctx.save()
    ctx.globalAlpha = inactive ? 0.32 : 0.74
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  points: ProjectedPoint[],
  det: HandDetection,
  colors: SceneColors,
  tint: string,
  inactive: boolean,
) {
  const wrist = pointAt(points, 0)
  if (!wrist || inactive) return

  const label = `${(det.confidence * 100).toFixed(0)}%`
  ctx.save()
  ctx.font = '600 13px Inter, system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const paddingX = 9
  const textWidth = ctx.measureText(label).width
  const x = wrist.x + 12
  const y = wrist.y - 14

  ctx.fillStyle = colors.background
  ctx.globalAlpha = 0.82
  ctx.beginPath()
  ctx.roundRect(x - paddingX, y - 11, textWidth + paddingX * 2, 22, 7)
  ctx.fill()

  ctx.globalAlpha = 1
  ctx.fillStyle = tint
  ctx.fillText(label, x, y)
  ctx.restore()
}

function drawDetection(
  ctx: CanvasRenderingContext2D,
  det: HandDetection,
  tx: (x: number) => number,
  ty: (y: number) => number,
  inactive = false,
) {
  const colors = sceneColors()
  const tint = colors.accent
  const points = projectPoints(det.keypoints, tx, ty)

  drawPalm(ctx, points, colors, tint, inactive)
  drawFingerVolumes(ctx, points, colors, tint, inactive)
  drawJointCaps(ctx, points, colors, tint, inactive)
  drawLabel(ctx, points, det, colors, tint, inactive)
}

function idleDetection(): HandDetection {
  return {
    present: true,
    isLeftHand: false,
    classId: 0,
    confidence: 0,
    presenceConfidence: 0,
    box: { left: 0, top: 0, right: 1, bottom: 1 },
    keypoints: IDLE_KEYPOINTS,
  }
}

function drawIdle(ctx: CanvasRenderingContext2D, width: number, height: number) {
  smoothBox = null
  const colors = sceneColors()
  const det = idleDetection()
  const raw = computeBoundsFromDetections([det])
  if (!raw) return
  const fit = fitBounds(raw, width, height)

  drawDetection(ctx, det, fit.tx, fit.ty, true)

  ctx.save()
  ctx.fillStyle = colors.muted
  ctx.font = '500 14px Inter, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(props.emptyLabel, width / 2, height - 28)
  ctx.restore()
}

function drawRecognitionBadge(
  ctx: CanvasRenderingContext2D,
  width: number,
  recognition: RecognitionResult | null,
) {
  if (!recognition || !recognition.recognized || !recognition.gestureName.trim()) return

  const colors = sceneColors()
  const label = recognition.gestureName
  const paddingX = 12
  const height = 34
  const xMax = width - 14
  const y = 14

  ctx.save()
  ctx.font = '700 14px Inter, system-ui, sans-serif'
  const labelWidth = ctx.measureText(label).width
  const badgeWidth = Math.min(width - 28, labelWidth + paddingX * 2)
  const x = xMax - badgeWidth

  ctx.shadowColor = colors.shadow
  ctx.shadowBlur = 18
  ctx.shadowOffsetY = 10
  ctx.fillStyle = colors.background
  ctx.globalAlpha = 0.86
  ctx.beginPath()
  ctx.roundRect(x, y, badgeWidth, height, 10)
  ctx.fill()

  ctx.globalAlpha = 1
  ctx.strokeStyle = colors.accent
  ctx.lineWidth = 1.5
  ctx.stroke()

  ctx.shadowColor = 'transparent'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = '700 14px Inter, system-ui, sans-serif'
  ctx.fillStyle = colors.foreground
  ctx.fillText(label, x + paddingX, y + height / 2, badgeWidth - paddingX * 2)
  ctx.restore()
}

function drawCountdownOverlay(ctx: CanvasRenderingContext2D, width: number, height: number) {
  if (props.countdownSeconds <= 0 || props.countdownProgress <= 0) return

  const colors = sceneColors()
  const cx = width / 2
  const cy = height / 2
  const veilRadius = Math.hypot(width, height)
  const progress = Math.max(0, Math.min(1, props.countdownProgress))
  const { startAngle, endAngle } = countdownWipeAngles(progress)
  const fontSize = Math.max(72, Math.min(width, height) * 0.22)

  ctx.save()
  ctx.fillStyle = colors.background
  ctx.globalAlpha = 0.52
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.arc(cx, cy, veilRadius, startAngle, endAngle)
  ctx.closePath()
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.shadowColor = colors.accent
  ctx.shadowBlur = fontSize * 0.42
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0
  ctx.fillStyle =
    COUNTDOWN_NUMBER_COLOR === 'foreground'
      ? colors.foreground
      : COUNTDOWN_NUMBER_COLOR
  ctx.font = `${COUNTDOWN_NUMBER_WEIGHT} ${fontSize}px Inter, system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(props.countdownSeconds), cx, cy + fontSize * 0.03)
  ctx.restore()
}

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const cssWidth = canvas.clientWidth || 640
  const cssHeight = canvas.clientHeight || 420
  if (canvas.width !== cssWidth * dpr || canvas.height !== cssHeight * dpr) {
    canvas.width = cssWidth * dpr
    canvas.height = cssHeight * dpr
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssWidth, cssHeight)
  drawBackground(ctx, cssWidth, cssHeight)

  const present = props.frame?.detections.filter((det) => det.present) ?? []
  if (!props.frame || present.length === 0) {
    drawIdle(ctx, cssWidth, cssHeight)
    if (!props.hideRecognition) drawRecognitionBadge(ctx, cssWidth, props.recognition)
    drawCountdownOverlay(ctx, cssWidth, cssHeight)
    return
  }

  const raw = computeBoundsFromDetections(present)
  if (!raw) return
  const fit = fitBounds(raw, cssWidth, cssHeight)

  for (const det of present) {
    drawDetection(ctx, det, fit.tx, fit.ty)
  }
  if (!props.hideRecognition) drawRecognitionBadge(ctx, cssWidth, props.recognition)
  drawCountdownOverlay(ctx, cssWidth, cssHeight)
}

watch(
  () => [
    props.frame,
    props.emptyLabel,
    props.leftLabel,
    props.rightLabel,
    props.recognition,
    props.hideRecognition,
    props.countdownSeconds,
    props.countdownProgress,
    props.themeKey,
  ],
  () => draw(),
)

const ro = new ResizeObserver(() => draw())
watch(canvasRef, (el) => {
  if (!el) return
  ro.observe(el)
  draw()
})

onBeforeUnmount(() => ro.disconnect())
</script>

<template>
  <canvas ref="canvasRef" class="handpose-canvas"></canvas>
</template>

<style scoped>
.handpose-canvas {
  width: 100%;
  height: clamp(320px, 48vw, 560px);
  display: block;
  border-radius: var(--radius);
  background: var(--canvas-bg);
}

@media (max-width: 640px) {
  .handpose-canvas {
    height: 330px;
  }
}
</style>
