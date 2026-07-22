const SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

function chunks(bytes) {
  const out = []
  let o = 8
  while (o + 8 <= bytes.length) {
    const len = (bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3]) >>> 0
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7])
    out.push({ type, start: o + 8, len })
    if (type === "IEND") break
    o += 12 + len
  }
  return out
}

export function pngInfo(bytes) {
  if (!bytes || bytes.length < 33) return null
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return null
  const cs = chunks(bytes)
  if (cs[0]?.type !== "IHDR") return null
  const h = cs[0].start
  const info = {
    width: (bytes[h] << 24 | bytes[h + 1] << 16 | bytes[h + 2] << 8 | bytes[h + 3]) >>> 0,
    height: (bytes[h + 4] << 24 | bytes[h + 5] << 16 | bytes[h + 6] << 8 | bytes[h + 7]) >>> 0,
    bitDepth: bytes[h + 8],
    colorType: bytes[h + 9],
    interlace: bytes[h + 12],
    tRNS: null,
    idat: []
  }
  for (const c of cs) {
    if (c.type === "tRNS") info.tRNS = bytes.subarray(c.start, c.start + c.len)
    else if (c.type === "IDAT") info.idat.push(bytes.subarray(c.start, c.start + c.len))
  }
  return info
}

async function inflateZlib(parts) {
  const stream = new Blob(parts).stream().pipeThrough(new DecompressionStream("deflate"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

async function rawScanlines(info) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[info.colorType]
  const bpp = Math.max(1, (channels * info.bitDepth) >> 3)
  const rowBytes = Math.ceil(channels * info.bitDepth * info.width / 8)
  const data = await inflateZlib(info.idat)
  if (data.length < (rowBytes + 1) * info.height) return null
  const out = new Uint8Array(rowBytes * info.height)
  for (let y = 0; y < info.height; y++) {
    const f = data[y * (rowBytes + 1)]
    const src = (y * (rowBytes + 1)) + 1
    const dst = y * rowBytes
    const prev = dst - rowBytes
    for (let x = 0; x < rowBytes; x++) {
      const raw = data[src + x]
      const a = x >= bpp ? out[dst + x - bpp] : 0
      const b = y > 0 ? out[prev + x] : 0
      const c = y > 0 && x >= bpp ? out[prev + x - bpp] : 0
      let v
      if (f === 0) v = raw
      else if (f === 1) v = raw + a
      else if (f === 2) v = raw + b
      else if (f === 3) v = raw + ((a + b) >> 1)
      else if (f === 4) v = raw + paeth(a, b, c)
      else return null
      out[dst + x] = v & 0xFF
    }
  }
  return { data: out, rowBytes, channels }
}

// { opaque, translucent } from the file bytes, or null when the fast path
// can't answer (not a PNG, interlaced, 16-bit, exotic filters)
export async function classifyPngAlpha(bytes, cutoff) {
  const info = pngInfo(bytes)
  if (!info || info.interlace !== 0) return null
  const min = cutoff?.min ?? 5
  const max = cutoff?.max ?? 240
  const ct = info.colorType
  if (ct === 0 || ct === 2) {
    if (!info.tRNS) return { opaque: true, translucent: false }
    return { opaque: false, translucent: false }
  }
  if (ct === 3) {
    if (!info.tRNS) return { opaque: true, translucent: false }
    let mid = false, below = false
    for (const a of info.tRNS) {
      if (a < 255) below = true
      if (a > min && a < max) mid = true
    }
    if (!mid) return { opaque: !below, translucent: false }
    if (info.bitDepth !== 8) return null
    const raw = await rawScanlines(info).catch(() => null)
    if (!raw) return null
    let opaque = true, translucent = false
    for (let i = 0; i < raw.data.length; i++) {
      const a = raw.data[i] < info.tRNS.length ? info.tRNS[raw.data[i]] : 255
      if (a < 255) opaque = false
      if (a > min && a < max) { translucent = true; break }
    }
    return { opaque, translucent }
  }
  if ((ct === 4 || ct === 6) && info.bitDepth === 8) {
    const raw = await rawScanlines(info).catch(() => null)
    if (!raw) return null
    const step = raw.channels
    let opaque = true, translucent = false
    for (let i = step - 1; i < raw.data.length; i += step) {
      const a = raw.data[i]
      if (a < 255) opaque = false
      if (a > min && a < max) { translucent = true; break }
    }
    return { opaque, translucent }
  }
  return null
}

export function hashBytes(bytes) {
  let v = 2166136261
  for (let i = 0; i < bytes.length; i++) { v ^= bytes[i]; v = Math.imul(v, 16777619) }
  return v >>> 0
}
