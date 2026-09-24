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
    plte: null,
    idat: []
  }
  for (const c of cs) {
    if (c.type === "tRNS") info.tRNS = bytes.subarray(c.start, c.start + c.len)
    else if (c.type === "PLTE") info.plte = bytes.subarray(c.start, c.start + c.len)
    else if (c.type === "IDAT") info.idat.push(bytes.subarray(c.start, c.start + c.len))
  }
  return info
}

async function inflateZlib(parts) {
  const stream = new DecompressionStream("deflate")
  const writer = stream.writable.getWriter()
  for (const part of parts) writer.write(part).catch(() => {})
  writer.close().catch(() => {})
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]

function unfilter(data, offset, rowBytes, rows, bpp) {
  if (data.length < offset + (rowBytes + 1) * rows) return null
  const out = new Uint8Array(rowBytes * rows)
  for (let y = 0; y < rows; y++) {
    const f = data[offset + y * (rowBytes + 1)]
    const src = offset + y * (rowBytes + 1) + 1
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
  return out
}

async function rawScanlines(info) {
  const channels = CHANNELS[info.colorType]
  const bpp = Math.max(1, (channels * info.bitDepth) >> 3)
  const rowBytes = Math.ceil(channels * info.bitDepth * info.width / 8)
  const data = unfilter(await inflateZlib(info.idat), 0, rowBytes, info.height, bpp)
  return data ? { data, rowBytes, channels } : null
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

function pixelWriter({ colorType: ct, bitDepth: bd, plte, tRNS: trns }) {
  const channels = CHANNELS[ct]
  const sample = bd === 16
    ? (rows, row, x, k) => (rows[row + (x * channels + k) * 2] << 8) | rows[row + (x * channels + k) * 2 + 1]
    : bd === 8
      ? (rows, row, x, k) => rows[row + x * channels + k]
      : (rows, row, x) => (rows[row + ((x * bd) >> 3)] >> (8 - bd - ((x * bd) & 7))) & ((1 << bd) - 1)
  const to8 = bd === 16 ? v => v >> 8 : bd < 8 && ct === 0 ? v => v * 255 / ((1 << bd) - 1) : v => v
  const key = i => trns && trns.length >= i * 2 + 2 ? (trns[i * 2] << 8) | trns[i * 2 + 1] : -1
  if (ct === 6) {
    return (rows, row, x, out, o) => {
      out[o] = to8(sample(rows, row, x, 0))
      out[o + 1] = to8(sample(rows, row, x, 1))
      out[o + 2] = to8(sample(rows, row, x, 2))
      out[o + 3] = to8(sample(rows, row, x, 3))
      return true
    }
  }
  if (ct === 4) {
    return (rows, row, x, out, o) => {
      out[o] = out[o + 1] = out[o + 2] = to8(sample(rows, row, x, 0))
      out[o + 3] = to8(sample(rows, row, x, 1))
      return true
    }
  }
  if (ct === 2) {
    const kr = key(0), kg = key(1), kb = key(2)
    return (rows, row, x, out, o) => {
      const r = sample(rows, row, x, 0), g = sample(rows, row, x, 1), b = sample(rows, row, x, 2)
      out[o] = to8(r)
      out[o + 1] = to8(g)
      out[o + 2] = to8(b)
      out[o + 3] = r === kr && g === kg && b === kb ? 0 : 255
      return true
    }
  }
  if (ct === 0) {
    const kv = key(0)
    return (rows, row, x, out, o) => {
      const v = sample(rows, row, x, 0)
      out[o] = out[o + 1] = out[o + 2] = to8(v)
      out[o + 3] = v === kv ? 0 : 255
      return true
    }
  }
  return (rows, row, x, out, o) => {
    const v = sample(rows, row, x, 0)
    if (v * 3 + 2 >= plte.length) return false
    out[o] = plte[v * 3]
    out[o + 1] = plte[v * 3 + 1]
    out[o + 2] = plte[v * 3 + 2]
    out[o + 3] = trns && v < trns.length ? trns[v] : 255
    return true
  }
}

export async function decodePng(bytes) {
  const info = pngInfo(bytes)
  if (!info || !info.width || !info.height) return null
  const ct = info.colorType, bd = info.bitDepth, channels = CHANNELS[ct]
  if (!channels || ![1, 2, 4, 8, 16].includes(bd) || (ct === 3 && !info.plte)) return null
  const data = await inflateZlib(info.idat).catch(() => null)
  if (!data) return null
  const { width, height } = info
  const out = new Uint8ClampedArray(width * height * 4)
  const bpp = Math.max(1, (channels * bd) >> 3)
  if (!info.interlace && ct === 6 && bd === 8) {
    const rows = unfilter(data, 0, width * 4, height, 4)
    if (!rows) return null
    out.set(rows)
    return { width, height, data: out }
  }
  const write = pixelWriter(info)
  let offset = 0
  for (const [x0, y0, dx, dy] of info.interlace ? ADAM7 : [[0, 0, 1, 1]]) {
    const pw = Math.ceil((width - x0) / dx), ph = Math.ceil((height - y0) / dy)
    if (pw <= 0 || ph <= 0) continue
    const rowBytes = Math.ceil(channels * bd * pw / 8)
    const rows = unfilter(data, offset, rowBytes, ph, bpp)
    if (!rows) return null
    offset += (rowBytes + 1) * ph
    for (let y = 0; y < ph; y++) {
      const row = y * rowBytes
      let o = ((y0 + y * dy) * width + x0) * 4
      for (let x = 0; x < pw; x++, o += dx * 4) if (!write(rows, row, x, out, o)) return null
    }
  }
  return { width, height, data: out }
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  return c
})

function crc32(bytes, start, end) {
  let c = -1
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

export function encodeStoredPng(rgba, width, height) {
  const rowBytes = width * 4 + 1
  const raw = height * rowBytes
  const blocks = Math.max(1, Math.ceil(raw / 65535))
  const zlibLen = 2 + raw + blocks * 5 + 4
  const out = new Uint8Array(8 + 25 + 12 + zlibLen + 12)
  const dv = new DataView(out.buffer)
  out.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  function chunk(at, type, len) {
    dv.setUint32(at, len)
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i)
    return at + 8
  }
  function seal(at, len) {
    dv.setUint32(at + 8 + len, crc32(out, at + 4, at + 8 + len))
    return at + 12 + len
  }
  let at = 8
  let p = chunk(at, "IHDR", 13)
  dv.setUint32(p, width)
  dv.setUint32(p + 4, height)
  out.set([8, 6, 0, 0, 0], p + 8)
  at = seal(at, 13)
  p = chunk(at, "IDAT", zlibLen)
  out[p++] = 0x78
  out[p++] = 0x01
  const rows = new Uint8Array(raw)
  for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * rowBytes + 1)
  let a = 1, b = 0, src = 0
  do {
    const len = Math.min(65535, raw - src)
    out[p++] = src + len >= raw ? 1 : 0
    out[p++] = len & 255
    out[p++] = len >> 8
    out[p++] = ~len & 255
    out[p++] = (~len >> 8) & 255
    out.set(rows.subarray(src, src + len), p)
    p += len
    for (let i = src; i < src + len; i++) {
      a = (a + rows[i]) % 65521
      b = (b + a) % 65521
    }
    src += len
  } while (src < raw)
  dv.setUint32(p, ((b << 16) | a) >>> 0)
  at = seal(at, zlibLen)
  chunk(at, "IEND", 0)
  seal(at, 0)
  return out
}

export function hashBytes(bytes) {
  let v = 2166136261
  for (let i = 0; i < bytes.length; i++) { v ^= bytes[i]; v = Math.imul(v, 16777619) }
  return v >>> 0
}
