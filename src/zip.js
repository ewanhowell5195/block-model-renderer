const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

export function parseZip(bytes) {
  const ua = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const dv = new DataView(ua.buffer, ua.byteOffset, ua.byteLength)

  let offEOCD = -1
  for (let i = ua.length - 22; i >= 0; i--) {
    if (ua[i] === 0x50 && ua[i + 1] === 0x4b && ua[i + 2] === 0x05 && ua[i + 3] === 0x06) {
      offEOCD = i
      break
    }
  }
  if (offEOCD === -1) throw new Error("Not a zip file (no end of central directory record)")

  const offCenDir = dv.getUint32(offEOCD + 16, true)
  const recordCount = dv.getUint16(offEOCD + 10, true)

  const files = new Map()
  let o = offCenDir
  for (let i = 0; i < recordCount; i++) {
    const nameLen = dv.getUint16(o + 28, true)
    const extraLen = dv.getUint16(o + 30, true)
    const commentLen = dv.getUint16(o + 32, true)
    const filePath = textDecoder.decode(ua.subarray(o + 46, o + 46 + nameLen))

    if (!filePath.endsWith("/")) {
      const localOffset = dv.getUint32(o + 42, true)
      const method = dv.getUint16(localOffset + 8, true)
      const compressedSize = dv.getUint32(o + 20, true)
      const localNameLen = dv.getUint16(localOffset + 26, true)
      const localExtraLen = dv.getUint16(localOffset + 28, true)
      const dataStart = localOffset + 30 + localNameLen + localExtraLen
      files.set(filePath, {
        method,
        data: ua.subarray(dataStart, dataStart + compressedSize)
      })
    }

    o += 46 + nameLen + extraLen + commentLen
  }
  return files
}

const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}

export function crc32(data) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

export function buildZip(files, deflate) {
  const localParts = []
  const centralParts = []
  let offset = 0
  let count = 0

  for (const [name, data] of Object.entries(files)) {
    const nameBytes = textEncoder.encode(name)
    const crc = crc32(data)
    let method = 0
    let content = data
    if (deflate) {
      const deflated = deflate(data)
      if (deflated.length < data.length) {
        method = 8
        content = deflated
      }
    }

    const local = new Uint8Array(30 + nameBytes.length)
    const ldv = new DataView(local.buffer)
    ldv.setUint32(0, 0x04034b50, true)
    ldv.setUint16(4, 20, true)
    ldv.setUint16(6, 0, true)
    ldv.setUint16(8, method, true)
    ldv.setUint16(10, 0, true)
    ldv.setUint16(12, 0x21, true)
    ldv.setUint32(14, crc, true)
    ldv.setUint32(18, content.length, true)
    ldv.setUint32(22, data.length, true)
    ldv.setUint16(26, nameBytes.length, true)
    ldv.setUint16(28, 0, true)
    local.set(nameBytes, 30)

    const central = new Uint8Array(46 + nameBytes.length)
    const cdv = new DataView(central.buffer)
    cdv.setUint32(0, 0x02014b50, true)
    cdv.setUint16(4, 20, true)
    cdv.setUint16(6, 20, true)
    cdv.setUint16(8, 0, true)
    cdv.setUint16(10, method, true)
    cdv.setUint16(12, 0, true)
    cdv.setUint16(14, 0x21, true)
    cdv.setUint32(16, crc, true)
    cdv.setUint32(20, content.length, true)
    cdv.setUint32(24, data.length, true)
    cdv.setUint16(28, nameBytes.length, true)
    cdv.setUint32(42, offset, true)
    central.set(nameBytes, 46)

    localParts.push(local, content)
    centralParts.push(central)
    offset += local.length + content.length
    count++
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0)
  const eocd = new Uint8Array(22)
  const edv = new DataView(eocd.buffer)
  edv.setUint32(0, 0x06054b50, true)
  edv.setUint16(8, count, true)
  edv.setUint16(10, count, true)
  edv.setUint32(12, centralSize, true)
  edv.setUint32(16, offset, true)

  const total = offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let pos = 0
  for (const part of [...localParts, ...centralParts, eocd]) {
    out.set(part, pos)
    pos += part.length
  }
  return out
}
