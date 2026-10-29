// The WebGL renderer behind <DancingBars> (docs/granola-ui.md §Dancing bars). Like Granola's, it draws the three
// mirrored capsules on a canvas laid over the DOM bars and adds motion blur, so fast moves read as smears rather than
// jumps. The DOM bars stay in place, invisible: they are measured for size, spacing and colour, and they take over
// again whenever WebGL is unavailable or its context is lost.

export interface BarsRenderer {
  /** Move each bar to a new offset (px pushed out of its half box; 0 = full height). */
  setTargets(offsets: number[]): void
  /** Re-read the bar colour from the DOM (after `--barcolor` changed). */
  refreshColor(): void
  dispose(): void
}

const DURATION = 0.3
const FRAME = 1 / 60
/** Samples along each frame's travel for the motion blur. */
const BLUR_SAMPLES = 6

/** cubic-bezier(x1, y1, x2, y2) as an easing function of progress 0..1. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const at = (a: number, b: number, t: number): number => 3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t
  return (x) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let lo = 0
    let hi = 1
    let t = x
    for (let i = 0; i < 20; i++) {
      t = (lo + hi) / 2
      if (at(x1, x2, t) < x) lo = t
      else hi = t
    }
    return at(y1, y2, t)
  }
}

const ease = cubicBezier(0.4, 0, 0.2, 1)

interface Move {
  from: number
  to: number
  start: number
  duration: number
  /** Where a reversal would head (CSS Transitions' "reversing-adjusted start value"). */
  reverseTo: number
  /** CSS Transitions' "reversing shortening factor". */
  factor: number
}

function position(m: Move, t: number): number {
  const p = m.duration > 0 ? ease((t - m.start) / m.duration) : 1
  return m.from + (m.to - m.from) * p
}

const VERTEX = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = (aPosition + 1.0) * 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`

const FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform vec2 uSize;
uniform float uPixel;
uniform vec3 uX;
uniform vec2 uBar;
uniform vec4 uColor;
uniform vec3 uFrom;
uniform vec3 uTo;

// Coverage of an upright capsule of width uBar.x and height uBar.y whose top-left corner is (x, top).
float capsule(vec2 p, float x, float top) {
  float r = uBar.x * 0.5;
  vec2 q = abs(p - vec2(x + r, top + uBar.y * 0.5)) - vec2(0.0, uBar.y * 0.5 - r);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  return clamp(0.5 - d / uPixel, 0.0, 1.0);
}

// Average coverage while the bar's top travels from 'from' to 'to' during one frame: a box-filtered motion blur.
float bar(vec2 p, float x, float from, float to) {
  float sum = 0.0;
  for (int i = 0; i < ${BLUR_SAMPLES}; i++) {
    sum += capsule(p, x, mix(from, to, float(i) / ${BLUR_SAMPLES - 1}.0));
  }
  return sum / ${BLUR_SAMPLES}.0;
}

void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uSize;
  // The lower half mirrors the upper one, so each bar reads as a capsule growing from the middle.
  p.y = min(p.y, uSize.y - p.y);
  float c = max(max(bar(p, uX.x, uFrom.x, uTo.x), bar(p, uX.y, uFrom.y, uTo.y)), bar(p, uX.z, uFrom.z, uTo.z));
  float a = c * uColor.a;
  gl_FragColor = vec4(uColor.rgb * a, a);
}`

let probe: CanvasRenderingContext2D | null | undefined

/** Any CSS colour (rgb(), oklch(), color(), …) as straight RGBA 0..1, via a 1×1 canvas. */
function rgba(color: string): [number, number, number, number] {
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!probe) return [0, 0, 0, 0]
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = color
  probe.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
  return [r / 255, g / 255, b / 255, a / 255]
}

/**
 * Start drawing `root`'s bars on `canvas`. `root` holds the two half boxes of DOM bars (the upper one first);
 * `initial` is where the bars start. Returns null when WebGL isn't available (or only in software).
 */
export function createBarsRenderer(canvas: HTMLCanvasElement, root: HTMLElement, initial: number[], onLost: () => void): BarsRenderer | null {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', failIfMajorPerformanceCaveat: true })
  if (!gl) return null

  const program = gl.createProgram()
  const buffer = gl.createBuffer()
  const shaders: WebGLShader[] = []
  const release = (): void => {
    gl.deleteBuffer(buffer)
    gl.deleteProgram(program)
    shaders.forEach((s) => gl.deleteShader(s))
  }
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type)
    if (!shader) throw new Error('Could not allocate a shader')
    shaders.push(shader)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compilation failed')
    return shader
  }
  try {
    if (!program || !buffer) throw new Error('Could not allocate WebGL resources')
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Shader linking failed')
  } catch (e) {
    console.warn('Dancing bars: WebGL unavailable, using DOM bars', e)
    release()
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return null
  }

  gl.useProgram(program)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  // One triangle that covers the whole viewport.
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const aPosition = gl.getAttribLocation(program, 'aPosition')
  gl.enableVertexAttribArray(aPosition)
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0)
  const u = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name)
  const uniforms = { size: u('uSize'), pixel: u('uPixel'), x: u('uX'), bar: u('uBar'), color: u('uColor'), from: u('uFrom'), to: u('uTo') }

  const clock = (): number => performance.now() / 1000
  const moves: Move[] = [0, 1, 2].map((i) => ({ from: initial[i] ?? 0, to: initial[i] ?? 0, start: 0, duration: 0, reverseTo: initial[i] ?? 0, factor: 1 }))
  let disposed = false
  let raf = 0
  let lastFrame = 0
  let color = ''

  const draw = (): void => {
    const t = clock()
    gl.uniform3fv(uniforms.from, moves.map((m) => position(m, t - FRAME)))
    gl.uniform3fv(uniforms.to, moves.map((m) => position(m, t)))
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
  const animating = (): boolean => moves.some((m) => clock() < m.start + m.duration + FRAME)

  const frame = (now: number): void => {
    raf = 0
    if (disposed || document.hidden) return
    // At most 60 fps on high-refresh displays.
    if (now - lastFrame < 1000 * FRAME - 1) {
      raf = requestAnimationFrame(frame)
      return
    }
    lastFrame = now
    draw()
    if (animating()) raf = requestAnimationFrame(frame)
  }
  const kick = (): void => {
    if (!disposed && !raf) raf = requestAnimationFrame(frame)
  }

  const readColor = (): boolean => {
    const bar = root.firstElementChild?.firstElementChild
    if (!(bar instanceof HTMLElement)) return false
    const next = getComputedStyle(bar).backgroundColor
    if (next === color) return false
    color = next
    gl.uniform4fv(uniforms.color, rgba(next))
    return true
  }

  const measure = (): void => {
    const box = root.firstElementChild
    const bars = box ? [...box.children].filter((c): c is HTMLElement => c instanceof HTMLElement) : []
    if (!(box instanceof HTMLElement) || bars.length < 3) return
    const width = root.clientWidth
    const height = root.clientHeight
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(width * dpr))
    const h = Math.max(1, Math.round(height * dpr))
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    gl.viewport(0, 0, w, h)
    const style = getComputedStyle(bars[0])
    gl.uniform2f(uniforms.size, width, height)
    gl.uniform1f(uniforms.pixel, 1 / dpr)
    gl.uniform2f(uniforms.bar, parseFloat(style.width), parseFloat(style.height))
    gl.uniform3fv(uniforms.x, bars.slice(0, 3).map((b) => b.offsetLeft - box.offsetLeft))
    readColor()
    draw()
  }

  const handleLost = (e: Event): void => {
    e.preventDefault()
    onLost()
  }
  canvas.addEventListener('webglcontextlost', handleLost)
  const resize = new ResizeObserver(measure)
  resize.observe(root)
  window.addEventListener('resize', measure)
  // Theme switches change the bar colour without touching the bars themselves. Only the root's and the document's
  // inline styles matter (`--barcolor`, theme variables); ancestors' styles change every frame while they animate.
  const theme = new MutationObserver(() => readColor() && kick())
  for (let el: HTMLElement | null = root; el; el = el.parentElement) {
    const own = el === root || el === document.documentElement
    theme.observe(el, { attributes: true, attributeFilter: own ? ['class', 'data-theme', 'style'] : ['class', 'data-theme'] })
  }
  const onVisibility = (): void => {
    if (!document.hidden) kick()
  }
  document.addEventListener('visibilitychange', onVisibility)
  measure()

  return {
    setTargets(offsets) {
      const t = clock()
      let moved = false
      moves.forEach((m, i) => {
        const target = offsets[i]
        if (target === undefined || target === m.to) return
        moved = true
        const running = t < m.start + m.duration
        const progress = m.duration > 0 ? ease((t - m.start) / m.duration) : 1
        // Turning back toward where a running move began takes proportionally less time, as CSS transitions do.
        const reversing = running && target === m.reverseTo
        const factor = reversing ? Math.min(1, Math.abs(progress * m.factor + 1 - m.factor)) : 1
        const from = position(m, t)
        moves[i] = { from, to: target, start: t, duration: DURATION * factor, reverseTo: reversing ? m.to : from, factor }
      })
      if (moved) kick()
    },
    refreshColor() {
      if (readColor()) kick()
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      resize.disconnect()
      theme.disconnect()
      window.removeEventListener('resize', measure)
      document.removeEventListener('visibilitychange', onVisibility)
      canvas.removeEventListener('webglcontextlost', handleLost)
      release()
      if (!canvas.isConnected) gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
}
