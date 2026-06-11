// Self-hosted email countdown timer ("time bomb").
//
//   <img src="https://<host>/api/timer?offerStartedAt={{ "now" | date: "%s" }}&offerDurationSec=86400">
//
// offerStartedAt   unix seconds, stamped by Customer.io at send time (real,
//                  per-recipient start — this is what makes the urgency honest).
// offerDurationSec window length; defaults to 24h.
//
// The deadline (start + duration) matches the on-page timer, so the email and
// the landing page count down to the exact same moment. When it hits zero the
// GIF freezes on 00:00:00, mirroring the page's switch to full price.

import { z } from "zod"
import { GifEncoder } from "@/lib/gif/encoder"
import {
  buildPalette,
  renderTime,
  formatRemaining,
  DEFAULT_THEME,
  TRANSPARENT_INDEX,
  type Theme,
} from "@/lib/timer/render"
import type { RGB } from "@/lib/gif/encoder"

export const runtime = "nodejs"
export const dynamic = "force-dynamic" // never cached/prerendered on our side

// How many ticking frames to animate before freezing. A GIF cannot tick for
// 24h (that's 86,400 frames); it just needs to feel live for the time a reader
// looks at it (120 frames = ~2 minutes). The displayed value is always
// accurate at open. Frames after the first carry only the changed pixels
// (mostly the seconds), so the file stays small despite the longer run.
const TICK_FRAMES = 120

// A 6-digit hex color ("#fbf7f0" or "fbf7f0") → RGB triple. Lets each product
// theme the same endpoint from the email (?bg=..&fg=..&accent=..).
const HexColor = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/)
  .transform(
    (s): RGB => [
      parseInt(s.slice(-6, -4), 16),
      parseInt(s.slice(-4, -2), 16),
      parseInt(s.slice(-2), 16),
    ]
  )

const ParamsSchema = z.object({
  // Optional safety net: if Customer.io fails to inject the timestamp we fall
  // back to "now" rather than serving a broken image. Verify CIO injects this.
  offerStartedAt: z.coerce.number().int().positive().optional(),
  offerDurationSec: z.coerce
    .number()
    .int()
    .positive()
    .max(99 * 3600)
    .default(86400),
  // Optional palette overrides; omitted parts fall back to the brand theme.
  bg: HexColor.optional(),
  fg: HexColor.optional(),
  accent: HexColor.optional(),
  // Color outside the rounded corners — set to the email background. White by
  // default, which matches a standard light email body.
  page: HexColor.optional(),
  // Corner radius in DISPLAY pixels (the image is 2x, so it's doubled
  // internally). Big value = pill (default), small = squarer chip.
  radius: z.coerce.number().int().min(0).max(96).optional(),
})

export async function GET(request: Request) {
  const url = new URL(request.url)
  const parsed = ParamsSchema.safeParse({
    offerStartedAt: url.searchParams.get("offerStartedAt") ?? undefined,
    offerDurationSec: url.searchParams.get("offerDurationSec") ?? undefined,
    bg: url.searchParams.get("bg") ?? undefined,
    fg: url.searchParams.get("fg") ?? undefined,
    accent: url.searchParams.get("accent") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    radius: url.searchParams.get("radius") ?? undefined,
  })

  const now = Math.floor(Date.now() / 1000)
  const params = parsed.success ? parsed.data : { offerDurationSec: 86400 }
  const start = ("offerStartedAt" in params && params.offerStartedAt) || now
  const deadline = start + params.offerDurationSec
  const remaining = Math.max(0, deadline - now)

  const theme: Theme = {
    bg: ("bg" in params && params.bg) || DEFAULT_THEME.bg,
    fg: ("fg" in params && params.fg) || DEFAULT_THEME.fg,
    accent: ("accent" in params && params.accent) || DEFAULT_THEME.accent,
    page: ("page" in params && params.page) || DEFAULT_THEME.page,
  }
  // Display px → 2x internal space; undefined falls back to the pill default.
  const radiusPx =
    "radius" in params && params.radius != null ? params.radius * 2 : undefined

  const gif = buildCountdownGif(remaining, theme, radiusPx)

  return new Response(new Uint8Array(gif), {
    headers: {
      "Content-Type": "image/gif",
      // Ask every client (incl. the Gmail image proxy) to refetch on each open
      // so the timer is accurate at open time rather than frozen at first open.
      "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    },
  })
}

function buildCountdownGif(
  remaining: number,
  theme: Theme,
  radiusPx?: number
): Uint8Array {
  const frameCount = remaining <= 0 ? 1 : Math.min(TICK_FRAMES, remaining + 1)
  let prev = renderTime(formatRemaining(remaining), radiusPx)
  const W = prev.width
  const H = prev.height
  const encoder = new GifEncoder(W, H, buildPalette(theme), TRANSPARENT_INDEX)

  // First frame paints the whole canvas (incl. the transparent rounded corners).
  encoder.addFrame(prev.indices, 100) // 100 centiseconds = 1s per tick

  // Each later frame carries only the rectangle that changed since the previous
  // one — usually just the seconds digits — relying on "do not dispose" so the
  // rest of the clock persists. Keeps 2 minutes of animation small.
  for (let i = 1; i < frameCount; i++) {
    const cur = renderTime(
      formatRemaining(Math.max(0, remaining - i)),
      radiusPx
    )
    const rect = changedRect(prev.indices, cur.indices, W, H)
    const sub = new Uint8Array(rect.w * rect.h)
    for (let y = 0; y < rect.h; y++)
      for (let x = 0; x < rect.w; x++)
        sub[y * rect.w + x] = cur.indices[(rect.y + y) * W + (rect.x + x)]
    encoder.addFrame(sub, 100, rect)
    prev = cur
  }
  return encoder.finish()
}

// Bounding box of pixels that differ between two equal-sized index buffers.
// Falls back to a 1×1 box (top-left) if nothing changed, so timing is kept.
function changedRect(a: Uint8Array, b: Uint8Array, w: number, h: number) {
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (a[y * w + x] !== b[y * w + x]) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: 1, h: 1 }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}
