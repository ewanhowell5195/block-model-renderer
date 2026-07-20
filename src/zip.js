const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

function eocdScan(ua) {
  for (let i = ua.length - 22; i >= 0; i--) {
    if (ua[i] === 0x50 && ua[i + 1] === 0x4b && ua[i + 2] === 0x05 && ua[i + 3] === 0x06) return i
  }
  return -1
}

function centralRecord(dv, ua, o) {
  const nameLen = dv.getUint16(o + 28, true)
  const extraLen = dv.getUint16(o + 30, true)
  const commentLen = dv.getUint16(o + 32, true)
  const filePath = textDecoder.decode(ua.subarray(o + 46, o + 46 + nameLen))
  const method = dv.getUint16(o + 10, true)
  let compressedSize = dv.getUint32(o + 20, true)
  const uncompressedSize = dv.getUint32(o + 24, true)
  let localOffset = dv.getUint32(o + 42, true)
  if (compressedSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF) {
    let eo = o + 46 + nameLen
    const end = eo + extraLen
    while (eo + 4 <= end) {
      const id = dv.getUint16(eo, true), sz = dv.getUint16(eo + 2, true)
      if (id === 1) {
        let fo = eo + 4
        if (uncompressedSize === 0xFFFFFFFF) fo += 8
        if (compressedSize === 0xFFFFFFFF) {
          compressedSize = Number(dv.getBigUint64(fo, true))
          fo += 8
        }
        if (localOffset === 0xFFFFFFFF) localOffset = Number(dv.getBigUint64(fo, true))
        break
      }
      eo += 4 + sz
    }
  }
  return { filePath, method, compressedSize, localOffset, next: o + 46 + nameLen + extraLen + commentLen }
}

export function parseZip(bytes) {
  const ua = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const dv = new DataView(ua.buffer, ua.byteOffset, ua.byteLength)

  const offEOCD = eocdScan(ua)
  if (offEOCD === -1) throw new Error("Not a zip file (no end of central directory record)")

  let offCenDir = dv.getUint32(offEOCD + 16, true)
  let recordCount = dv.getUint16(offEOCD + 10, true)
  if ((offCenDir === 0xFFFFFFFF || recordCount === 0xFFFF) && offEOCD >= 20 && dv.getUint32(offEOCD - 20, true) === 0x07064b50) {
    const off64 = Number(dv.getBigUint64(offEOCD - 12, true))
    if (dv.getUint32(off64, true) === 0x06064b50) {
      recordCount = Number(dv.getBigUint64(off64 + 32, true))
      offCenDir = Number(dv.getBigUint64(off64 + 48, true))
    }
  }

  const files = new Map()
  let o = offCenDir
  for (let i = 0; i < recordCount; i++) {
    const r = centralRecord(dv, ua, o)
    if (!r.filePath.endsWith("/")) {
      const dataStart = r.localOffset + 30 + dv.getUint16(r.localOffset + 26, true) + dv.getUint16(r.localOffset + 28, true)
      files.set(r.filePath, {
        method: r.method,
        data: ua.subarray(dataStart, dataStart + r.compressedSize)
      })
    }
    o = r.next
  }
  return files
}

export async function parseZipSlices(slice, size) {
  const tail = await slice(Math.max(0, size - 66000), size)
  const e = eocdScan(tail)
  if (e === -1) throw new Error("Not a zip file (no end of central directory record)")
  const tdv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let count = tdv.getUint16(e + 10, true)
  let cdSize = tdv.getUint32(e + 12, true)
  let cdOff = tdv.getUint32(e + 16, true)
  if ((cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || count === 0xFFFF) && e >= 20 && tdv.getUint32(e - 20, true) === 0x07064b50) {
    const off64 = Number(tdv.getBigUint64(e - 12, true))
    const rec = await slice(off64, off64 + 56)
    const rdv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength)
    if (rdv.getUint32(0, true) === 0x06064b50) {
      count = Number(rdv.getBigUint64(32, true))
      cdSize = Number(rdv.getBigUint64(40, true))
      cdOff = Number(rdv.getBigUint64(48, true))
    }
  }
  const cd = await slice(cdOff, cdOff + cdSize)
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
  const files = new Map()
  let o = 0
  for (let i = 0; i < count && o + 46 <= cd.length; i++) {
    const r = centralRecord(dv, cd, o)
    if (!r.filePath.endsWith("/")) {
      files.set(r.filePath, { method: r.method, compressedSize: r.compressedSize, localOffset: r.localOffset, slice })
    }
    o = r.next
  }
  return files
}

export async function zipEntryData(f) {
  if (f.data) return f.data
  const head = await f.slice(f.localOffset, f.localOffset + 30)
  const hdv = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const start = f.localOffset + 30 + hdv.getUint16(26, true) + hdv.getUint16(28, true)
  return f.slice(start, start + f.compressedSize)
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
  for (const part of localParts.concat(centralParts, eocd)) {
    out.set(part, pos)
    pos += part.length
  }
  return out
}
