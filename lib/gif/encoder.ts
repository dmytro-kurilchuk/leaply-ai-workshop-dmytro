// Minimal, dependency-free animated GIF89a encoder.
//
// Why hand-rolled: a self-hosted email countdown must render identically on a
// laptop and on a serverless host, forever, with nothing in the supply chain
// that can break on deploy. The GIF format is fully specified, so we own it.
//
// Indexed-color only. Frames are arrays of palette indices (one byte/pixel).

type RGB = [number, number, number]

// LSB-first bit writer used by the LZW coder.
class BitWriter {
  private bytes: number[] = []
  private acc = 0
  private accBits = 0

  write(value: number, bitCount: number): void {
    this.acc |= value << this.accBits
    this.accBits += bitCount
    while (this.accBits >= 8) {
      this.bytes.push(this.acc & 0xff)
      this.acc >>= 8
      this.accBits -= 8
    }
  }

  flush(): number[] {
    if (this.accBits > 0) {
      this.bytes.push(this.acc & 0xff)
      this.acc = 0
      this.accBits = 0
    }
    return this.bytes
  }
}

// GIF variable-width LZW compression of one frame's index stream.
function lzwCompress(minCodeSize: number, indices: Uint8Array): number[] {
  const clearCode = 1 << minCodeSize
  const eoiCode = clearCode + 1
  const bits = new BitWriter()

  let dict = new Map<string, number>()
  let codeSize = minCodeSize + 1
  let next = eoiCode + 1

  const resetDict = () => {
    dict = new Map()
    for (let i = 0; i < clearCode; i++) dict.set(String(i), i)
    codeSize = minCodeSize + 1
    next = eoiCode + 1
  }

  resetDict()
  bits.write(clearCode, codeSize)

  let prefix = String(indices[0])
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]
    const combined = prefix + "," + k
    if (dict.has(combined)) {
      prefix = combined
      continue
    }
    bits.write(dict.get(prefix)!, codeSize)
    if (next < 4096) {
      // Widen the code BEFORE assigning the code that needs the extra bit.
      // (The infamous GIF-LZW off-by-one: bumping after assigning desyncs
      // strict decoders like Apple's ImageIO and renders a blank image.)
      if (next === 1 << codeSize && codeSize < 12) codeSize++
      dict.set(combined, next++)
    } else {
      bits.write(clearCode, codeSize)
      resetDict()
    }
    prefix = String(k)
  }

  bits.write(dict.get(prefix)!, codeSize)
  bits.write(eoiCode, codeSize)
  return bits.flush()
}

export class GifEncoder {
  private out: number[] = []
  private width: number
  private height: number
  private palette: RGB[]
  private transparentIndex: number

  // transparentIndex (-1 = none): pixels with this palette index are left
  // unpainted, so whatever is behind the image shows through — this is how the
  // rounded corners stay rounded on any background.
  constructor(
    width: number,
    height: number,
    palette: RGB[],
    transparentIndex = -1
  ) {
    this.width = width
    this.height = height
    this.palette = palette
    this.transparentIndex = transparentIndex
    this.writeHeader()
  }

  private byte(b: number) {
    this.out.push(b & 0xff)
  }
  private short(s: number) {
    this.out.push(s & 0xff, (s >> 8) & 0xff)
  }

  private colorBits(): number {
    return Math.max(1, Math.ceil(Math.log2(this.palette.length)))
  }

  private writeHeader() {
    for (const c of "GIF89a") this.byte(c.charCodeAt(0))

    const bits = this.colorBits()
    this.short(this.width)
    this.short(this.height)
    // packed: global color table present, color resolution, table size.
    this.byte(0x80 | ((bits - 1) << 4) | (bits - 1))
    this.byte(0) // background color index
    this.byte(0) // pixel aspect ratio

    const tableSize = 1 << bits
    for (let i = 0; i < tableSize; i++) {
      const c = this.palette[i] ?? [0, 0, 0]
      this.byte(c[0])
      this.byte(c[1])
      this.byte(c[2])
    }
    // No Netscape loop block: the animation plays once and freezes on the
    // final (lowest) frame — correct for a countdown that must not jump back.
  }

  // delayCs = frame delay in centiseconds (1/100 s).
  addFrame(indices: Uint8Array, delayCs: number) {
    // Graphic Control Extension.
    const hasTransparency = this.transparentIndex >= 0
    this.byte(0x21)
    this.byte(0xf9)
    this.byte(4)
    // packed: disposal = 1 ("do not dispose") | transparency flag (bit 0).
    this.byte((1 << 2) | (hasTransparency ? 1 : 0))
    this.short(delayCs)
    this.byte(hasTransparency ? this.transparentIndex : 0)
    this.byte(0)

    // Image Descriptor.
    this.byte(0x2c)
    this.short(0)
    this.short(0)
    this.short(this.width)
    this.short(this.height)
    this.byte(0) // no local color table

    const minCodeSize = Math.max(2, this.colorBits())
    this.byte(minCodeSize)

    const data = lzwCompress(minCodeSize, indices)
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255)
      this.byte(chunk.length)
      for (const b of chunk) this.byte(b)
    }
    this.byte(0) // block terminator
  }

  finish(): Uint8Array {
    this.byte(0x3b) // trailer
    return Uint8Array.from(this.out)
  }
}

export type { RGB }
