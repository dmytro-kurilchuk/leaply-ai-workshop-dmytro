// Renders countdown frames as palette-indexed bitmaps for the GIF encoder.
//
// Digits are real font glyphs (Poppins SemiBold, baked in lib/timer/glyphs.ts)
// rather than fake 7-segment shapes — cleaner, more legible, more "designed". The
// outlines are flattened and filled with anti-aliasing here; the marketing
// label ("66% discount reserved for:") stays as live, localizable HTML text in
// the email, which also keeps the text-to-image ratio high for inbox placement.

import type { RGB } from "@/lib/gif/encoder"
import { FONT, type GlyphPoint } from "@/lib/timer/glyphs"

// ----- look & feel -------------------------------------------------------

// A timer's palette is fully themeable so one endpoint can wear any Leaply
// look (and match the offer page to the pixel). Three bg→color ramps:
//   fg     — the hours/minutes digits
//   accent — the colons
//   hot    — the seconds digits (the fastest-moving part), so urgency can be
//            isolated to the running numbers without shouting everywhere else.
// The rounded corners are transparent, so the timer is rounded on ANY
// background. `page` is only the fallback color shown by the rare client that
// ignores GIF transparency (defaults to white). Omit accent/hot to fall back
// to fg (a single calm color).
export type Theme = { bg: RGB; fg: RGB; accent?: RGB; hot?: RGB; page?: RGB }

// Default = Leaply "brand-warm": navy digits on warm cream, red colons as a
// subtle urgency note. Other products can override via the route's hex params.
export const DEFAULT_THEME: Theme = {
  bg: [251, 247, 240], // #fbf7f0 cream
  fg: [46, 42, 71], // #2e2a47 navy
  accent: [229, 57, 53], // #e53935 signal-red colons
}

const RAMP_STEPS = 16 // anti-aliasing shades per ramp (smoother edges)

// Drawn at 2× and displayed at half size (width/height attrs in the email) so
// it's crisp on Retina screens, where a 1× image gets stretched and looks soft.
const HEIGHT = 192 // image height in px (displays at 96)
const PAD_X = 36 // horizontal padding inside the GIF
const SPACING = 4 // extra tracking between glyph cells
const FIGURE_PX = 124 // rendered height of the digits (the rest is padding)
const COLON_RISE = 20 // px to lift the colon dots toward the digit centre
const RADIUS = 40 // rounded-corner radius of the card (px)

function lerp(from: RGB, to: RGB, t: number): RGB {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ]
}

// Three stacked ramps of RAMP_STEPS each: fg (digits), accent (colons), hot
// (seconds), then one extra slot for the transparent corner color. Index 0 is
// the card background. Length 3R + 1 = 25 → 5-bit color.
export function buildPalette(theme: Theme = DEFAULT_THEME): RGB[] {
  const accent = theme.accent ?? theme.fg
  const hot = theme.hot ?? theme.fg
  const page = theme.page ?? [255, 255, 255]
  const ramp = (to: RGB) =>
    Array.from({ length: RAMP_STEPS }, (_, i) =>
      lerp(theme.bg, to, i / (RAMP_STEPS - 1))
    )
  return [
    ...ramp(theme.fg),
    ...ramp(accent),
    ...ramp(hot),
    page, // TRANSPARENT_INDEX — only seen if a client ignores transparency
  ]
}

// Index offsets for the colon (accent) and seconds (hot) ramps, plus the
// transparent corner index.
const ACCENT_RAMP = RAMP_STEPS
const HOT_RAMP = RAMP_STEPS * 2
export const TRANSPARENT_INDEX = RAMP_STEPS * 3

// Signed distance to a rounded rectangle centred at the origin.
function roundedRectSdf(
  px: number,
  py: number,
  hw: number,
  hh: number,
  r: number
): number {
  const qx = Math.abs(px) - hw + r
  const qy = Math.abs(py) - hh + r
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return Math.min(Math.max(qx, qy), 0) + outside - r
}

// ----- glyph rasterization ----------------------------------------------

// Scale/position the em-space outlines to sit centred in HEIGHT. The digit
// figure box (the tallest extent across all digits) sets the scale.
const { figTop, figBot } = (() => {
  let top = -Infinity
  let bot = Infinity
  for (const d of "0123456789")
    for (const contour of FONT.glyphs[d].c)
      for (const [, y] of contour) {
        if (y > top) top = y
        if (y < bot) bot = y
      }
  return { figTop: top, figBot: bot }
})()

const SCALE = FIGURE_PX / (figTop - figBot)
const TOP_PAD = (HEIGHT - FIGURE_PX) / 2
const BASELINE = TOP_PAD + figTop * SCALE // pixel y of the font baseline

const sy = (y: number) => BASELINE - y * SCALE // font y is up, pixel y is down

// Poppins (and most text fonts) have proportional-width digits. A clock needs
// fixed-width digits or it wobbles, so every digit is drawn in one cell as wide
// as the widest digit and centred by its ink box. The colon keeps its own width.
const DIGIT_CELL_UNITS = Math.max(
  ...[..."0123456789"].map((d) => FONT.glyphs[d].adv)
)
function inkCenterX(ch: string): number {
  let min = Infinity
  let max = -Infinity
  for (const contour of FONT.glyphs[ch].c)
    for (const [x] of contour) {
      if (x < min) min = x
      if (x > max) max = x
    }
  return max < min ? 0 : (min + max) / 2
}

// Append the line segments of one closed contour to `edges`, flattening any
// quadratic-bezier (off-curve) spans. Handles TrueType's implied on-curve
// midpoints between consecutive off-curve points. `xOff` is a pixel x-shift
// (used to centre a digit within its fixed cell).
function contourEdges(
  pts: GlyphPoint[],
  edges: number[][],
  xOff: number
): void {
  const sx = (x: number) => x * SCALE + xOff
  const n = pts.length
  if (n < 2) return

  // Insert implied on-curve midpoints between consecutive off-curve points.
  const ex: GlyphPoint[] = []
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    ex.push(a)
    const b = pts[(i + 1) % n]
    if (!a[2] && !b[2]) ex.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 1])
  }

  // Rotate so the contour starts on an on-curve point.
  let start = ex.findIndex((p) => p[2] === 1)
  if (start < 0) start = 0 // degenerate; treat first as on-curve
  const m = ex.length
  const P = (i: number) => ex[((i % m) + m) % m]

  let px = sx(P(start)[0])
  let py = sy(P(start)[1])
  const x0 = px
  const y0 = py

  let i = start
  let consumed = 0
  while (consumed < m) {
    const b = P(i + 1)
    if (b[2] === 1) {
      const nx = sx(b[0])
      const ny = sy(b[1])
      edges.push([px, py, nx, ny])
      px = nx
      py = ny
      i += 1
      consumed += 1
    } else {
      // quadratic: current point → control b → next on-curve c
      const c = P(i + 2)
      const cx = sx(b[0])
      const cy = sy(b[1])
      const ex2 = sx(c[0])
      const ey2 = sy(c[1])
      const STEPS = 10
      for (let t = 1; t <= STEPS; t++) {
        const u = t / STEPS
        const mt = 1 - u
        const nx = mt * mt * px + 2 * mt * u * cx + u * u * ex2
        const ny = mt * mt * py + 2 * mt * u * cy + u * u * ey2
        edges.push([px, py, nx, ny])
        px = nx
        py = ny
      }
      i += 2
      consumed += 2
    }
  }
  edges.push([px, py, x0, y0]) // close the contour
}

export type Bitmap = { width: number; height: number; indices: Uint8Array }
type Cell = { w: number; cov: Float32Array }

// Rasterize one glyph to a coverage map (0..1 per pixel). Even-odd fill with
// 4× vertical supersampling and analytic horizontal coverage — clean AA edges.
function rasterize(ch: string): Cell {
  const glyph = FONT.glyphs[ch]
  const isDigit = ch >= "0" && ch <= "9"
  const cellUnits = isDigit ? DIGIT_CELL_UNITS : glyph.adv
  const w = Math.max(1, Math.round(cellUnits * SCALE))
  // Centre digits in the fixed-width cell by their ink box; colon stays natural.
  const xOff = isDigit ? (cellUnits / 2 - inkCenterX(ch)) * SCALE : 0
  const cov = new Float32Array(w * HEIGHT)
  const edges: number[][] = []
  for (const contour of glyph.c) contourEdges(contour, edges, xOff)

  const SS = 4
  for (let y = 0; y < HEIGHT; y++) {
    const acc = new Float32Array(w)
    for (let s = 0; s < SS; s++) {
      const yy = y + (s + 0.5) / SS
      const xs: number[] = []
      for (const [ax, ay, bx, by] of edges) {
        if (ay <= yy !== by <= yy)
          xs.push(ax + ((yy - ay) / (by - ay)) * (bx - ax))
      }
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = xs[k]
        const xb = xs[k + 1]
        const l = Math.max(0, Math.floor(xa))
        const r = Math.min(w - 1, Math.ceil(xb) - 1)
        for (let px = l; px <= r; px++) {
          const cl = Math.max(xa, px)
          const cr = Math.min(xb, px + 1)
          if (cr > cl) acc[px] += cr - cl
        }
      }
    }
    for (let px = 0; px < w; px++) cov[y * w + px] = Math.min(1, acc[px] / SS)
  }
  return { w, cov }
}

const cellCache = new Map<string, Cell>()
function cellOf(ch: string): Cell {
  let c = cellCache.get(ch)
  if (!c) {
    c = rasterize(ch)
    cellCache.set(ch, c)
  }
  return c
}

// Rasterize one "HH:MM:SS"-shaped string to palette indices.
export function renderTime(text: string): Bitmap {
  const chars = [...text]
  // The seconds are the digits after the last colon — draw them "hot".
  const lastColon = chars.lastIndexOf(":")
  const cells = chars.map((ch, i) => ({
    ch,
    cell: cellOf(ch),
    hot: ch !== ":" && i > lastColon,
  }))

  const width =
    PAD_X * 2 +
    cells.reduce((sum, c) => sum + c.cell.w, 0) +
    SPACING * (cells.length - 1)
  const indices = new Uint8Array(width * HEIGHT) // 0 = card background

  // Carve the rounded card: pixels outside the rounded rectangle are made
  // transparent so the corners stay rounded on any background. Inside stays
  // index 0 (card bg) for the glyph overlay to read against.
  const hw = width / 2
  const hh = HEIGHT / 2
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < width; x++) {
      const sdf = roundedRectSdf(x + 0.5 - hw, y + 0.5 - hh, hw, hh, RADIUS)
      if (sdf > 0) indices[y * width + x] = TRANSPARENT_INDEX
    }
  }

  let originX = PAD_X
  for (const { ch, cell, hot } of cells) {
    const ramp = ch === ":" ? ACCENT_RAMP : hot ? HOT_RAMP : 0
    // Lift the colon so its dots sit centred against the tall digits instead
    // of low like a typographic colon.
    const rise = ch === ":" ? COLON_RISE : 0
    for (let y = 0; y < HEIGHT; y++) {
      const destY = y - rise
      if (destY < 0 || destY >= HEIGHT) continue
      for (let x = 0; x < cell.w; x++) {
        const cv = cell.cov[y * cell.w + x]
        const shade = Math.round(cv * (RAMP_STEPS - 1))
        if (shade <= 0) continue
        indices[destY * width + (originX + x)] = ramp + shade
      }
    }
    originX += cell.w + SPACING
  }
  return { width, height: HEIGHT, indices }
}

// Format remaining whole seconds as HH:MM:SS (hours capped at 99).
export function formatRemaining(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.min(99, Math.floor(s / 3600))
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(h)}:${p(m)}:${p(sec)}`
}
