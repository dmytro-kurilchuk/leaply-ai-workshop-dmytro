# Self-hosted email countdown ("time bomb")

A dependency-free countdown timer rendered as an animated GIF, served from our
own infrastructure. Replaces countdownmail.com — no third party, no
`{{customer.email}}` leaving our systems (closes the GDPR review item), and the
urgency is **real**: the deadline matches the on-page timer to the second.

## The email snippet

Keep the label as **live HTML text** (localizable, and good for inbox
placement — high text-to-image ratio). The GIF renders the rounded clock card
itself — the rounded corners are baked into the image, so they render the same
in every client (no CSS `border-radius`, which Outlook ignores).

```html
<div style="text-align:center;font-family:Arial,Helvetica,sans-serif">
  <!-- Reuse the EXACT localized label from the current timer email.
       Do not re-translate it here. FR keeps a space before the colon. -->
  <p style="margin:0 0 8px;font-size:15px;font-weight:bold;color:#2e2a47">
    <span style="color:#e53935">66%</span> discount reserved for:
  </p>

  <img
    src="https://YOUR-APP.vercel.app/api/timer?offerStartedAt={{ "now" | date: "%s" }}&offerDurationSec=86400"
    width="380"
    height="96"
    alt="Time left on your 66% discount"
    style="display:block;margin:0 auto;border:0"
  />
</div>
```

- `YOUR-APP.vercel.app` → the URL Vercel gives us after deploy.
- `offerStartedAt` — stamped by Customer.io at send time (unix seconds). This is
  the real per-recipient start. **Use the same Liquid the on-page timer uses.**
- `offerDurationSec` — window length. `86400` = 24h.
- The corners are filled with white (`page`) by default. If the email
  background isn't white, pass `&page=<hex>` to match it so the rounding blends
  in (see Theming).

## Theming (one endpoint, any product palette)

The default look is Leaply **brand-warm**: navy `#2e2a47` digits on warm cream
`#fbf7f0`, with red `#e53935` colons as a subtle urgency note. Any product can
override the palette from the email URL — no redeploy needed:

- `bg` — card background hex (e.g. `bg=1a1530` for a velvet chip)
- `fg` — digit hex
- `accent` — colon hex
- `page` — color outside the rounded corners; set to the email background hex
  (default white `ffffff`)

Example (KDS-style):
`/api/timer?offerDurationSec=86400&bg=fbf7f0&fg=2e2a47&accent=e0a800`. Omit a
param and it falls back to the brand default. The card's `background` in the
HTML above should match `bg` so the corners frame cleanly.

## Three things that MUST be true (or the fix is incomplete)

1. **The offer has to actually expire** at `offerStartedAt + offerDurationSec`,
   server-side. If the discount still works after 00:00:00, this is still fake
   urgency — we've just made it consistent. The honest fix lives in checkout,
   not the timer.
2. **Customer.io must inject `offerStartedAt`.** If the param is missing the GIF
   falls back to a fresh window (safety net so a misconfigured send doesn't show
   a broken image) — but that fallback is _not_ honest urgency. Verify the param
   renders in a real send before going live.
3. **Email and landing page must use the same start + duration**, so both count
   down to the same moment.

## Known limit: Gmail image caching

Gmail proxies and caches images. The timer is **accurate at open** and refetches
on later opens when the cache revalidates, but it is not perfectly live on every
re-open. This is inherent to email countdowns (countdownmail has the same
limit) — the URL is fixed at send, so we can't cache-bust per open.

## How it works (for the engineers)

`app/api/timer/route.ts` validates the params (zod), computes
`remaining = deadline − now`, and builds the GIF:

- `lib/timer/render.ts` — draws the `HH:MM:SS` digits as real font glyphs
  (anti-aliased even-odd fill of the outlines) into a palette-indexed bitmap.
  Themeable via `bg`/`fg`/`accent` (three color ramps: digits, colons, and an
  optional "hot" ramp for the seconds); `DEFAULT_THEME` holds the brand-warm
  palette.
- `lib/timer/glyphs.ts` — digit + colon outlines baked once from the
  OFL-licensed Noto Sans bundled with Next.js (`@vercel/og`), so the renderer
  needs no font library at runtime. To restyle the typeface, re-extract from a
  different TTF; the rasterizer is font-agnostic.
- `lib/gif/encoder.ts` — a minimal, dependency-free animated GIF89a encoder
  (hand-written LZW). Validated by round-trip decode and against Apple ImageIO.

It animates ~30 one-second frames (~54 KB) then freezes; a GIF can't tick for
24h, and it only needs to feel live for the seconds someone looks at it. At zero
it shows `00:00:00`.
