import { THREE, Canvas, loadTexture, platform } from "./platform.js"
import { subUpload, subFlush } from "./subtex.js"
import { initDynamic, dynamicFrame, primeDynamic, setInstanceHook, REBIND_UNIFORMS, loadSpriteTexture, cloneInstance } from "./models.js"
import { wasmReady, greedyMeshFast, settleWasm } from "./fast.js"
import { buildSchedules, evaluateAnimation } from "./animation.js"
import { listAtlasSprites } from "./assets.js"
import { createTranslucentSorter } from "./sorting.js"

const nextTask = globalThis.scheduler?.yield
  ? () => scheduler.yield()
  : () => new Promise(r => {
    const c = new MessageChannel()
    c.port1.onmessage = () => { c.port1.close(); r() }
    c.port2.postMessage(0)
  })

const STITCH_LOADS = 16

const matMap = m => m.uniforms?.map?.value ?? m.map

const geoHashes = new WeakMap()
function geoHash(geo) {
  let h = geoHashes.get(geo)
  if (h !== undefined) return h
  h = 0x811c9dc5
  for (const name of ["position", "normal", "uv"]) {
    const arr = geo.attributes[name]?.array
    if (!arr) continue
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
    for (let i = 0; i < bytes.length; i++) h = (h ^ bytes[i]) * 0x01000193 >>> 0
  }
  const idx = geo.index?.array
  if (idx) for (let i = 0; i < idx.length; i++) h = (h ^ idx[i]) * 0x01000193 >>> 0
  geoHashes.set(geo, h)
  return h
}
const matAnimated = m => !!(m.uniforms?.GameTime || matMap(m)?.userData?.frames)

function mergeInstanceSource(geometry, material) {
  const mats = [].concat(material)
  if (!geometry.index || !geometry.groups?.length || mats.length < 2) return { geometry, material }
  const keep = new Map()
  for (const g of geometry.groups) {
    const m = mats[g.materialIndex] ?? mats[0]
    if (!m || m.visible === false) continue
    let list = keep.get(m)
    if (!list) keep.set(m, list = [])
    list.push(g)
  }
  if (!keep.size) return null
  const src = geometry.index.array
  let total = 0
  for (const list of keep.values()) for (const g of list) total += Math.min(g.count, src.length - g.start)
  const index = new src.constructor(total)
  const geo = new THREE.BufferGeometry()
  for (const name in geometry.attributes) geo.setAttribute(name, geometry.attributes[name])
  let offset = 0
  const materials = []
  for (const [m, list] of keep) {
    const start = offset
    for (const g of list) {
      const count = Math.min(g.count, src.length - g.start)
      index.set(src.subarray(g.start, g.start + count), offset)
      offset += count
    }
    if (keep.size > 1) geo.addGroup(start, offset - start, materials.length)
    materials.push(m)
  }
  geo.setIndex(new THREE.BufferAttribute(index, 1))
  return { geometry: geo, material: materials.length > 1 ? materials : materials[0] }
}

const alphaSignature = m => [m.opacity, m.uniforms?.opacity?.value, m.blending, m.blendSrc, m.blendDst, m.blendEquation, m.transparent, m.depthWrite, m.alphaTest, m.defines ? Object.keys(m.defines).filter(k => k !== "FACE_ATTRS").sort().join(",") : ""].join("|")

const atlasSigCache = new WeakMap()
const atlasSigTable = new Map()
function atlasSigs(m) {
  let hit = atlasSigCache.get(m)
  if (hit !== undefined) return hit
  const sig = computeAtlasSignature(m)
  hit = atlasSigTable.get(sig)
  if (!hit) atlasSigTable.set(sig, hit = { id: atlasSigTable.size, sig, opaque: sig + "|O", translucent: sig + "|T" })
  atlasSigCache.set(m, hit)
  return hit
}

function computeAtlasSignature(m) {
  if (!m.uniforms) return matSignature(m)
  const u = m.uniforms
  return ["shader", m.side, u.d0?.value, u.d1?.value, u.ambient?.value,
    u.light0?.value?.toArray().join(","), u.light1?.value?.toArray().join(","),
    u.blockLightTint?.value?.toArray().join(","), u.skyLightColor?.value?.toArray().join(","), u.ambientColor?.value?.toArray().join(","),
    u.skyLightFactor?.value, u.brightness?.value, u.shadePos?.value?.toArray().join(","), u.shadeNeg?.value?.toArray().join(","), u.shadeMat?.value?.elements?.join(","), u.worldShade?.value,
    u.diffuseOn?.value, u.diffuse0?.value?.toArray().join(","), u.diffuse1?.value?.toArray().join(","), u.diffuseMix?.value?.toArray().join(","), alphaSignature(m)].join("|")
}

const sheetIds = new WeakMap()
let sheetCount = 0
function sheetId(sheet) {
  let id = sheetIds.get(sheet)
  if (id === undefined) sheetIds.set(sheet, id = ++sheetCount)
  return id
}

const fdCache = new WeakMap()
function faceDataOf(m) {
  let hit = fdCache.get(m)
  if (hit === undefined) fdCache.set(m, hit = computeFaceData(m))
  return hit
}

function computeFaceData(m) {
  const u = m.uniforms
  if (!u) return null
  const so = u.shadeOverride?.value
  let dir = 0
  if (so) {
    if (so.y > 0.5) dir = 1
    else if (so.y < -0.5) dir = 2
    else if (so.z > 0.5) dir = 3
    else if (so.z < -0.5) dir = 4
    else if (so.x > 0.5) dir = 5
    else if (so.x < -0.5) dir = 6
  }
  return [u.emission?.value ?? 0, dir + (u.shadeEnabled?.value !== false ? 8 : 0) + (u.aoEnabled?.value !== false ? 16 : 0)]
}

const sigCache = new WeakMap()
function matSignature(m) {
  let hit = sigCache.get(m)
  if (hit === undefined) sigCache.set(m, hit = computeSignature(m))
  return hit
}

function computeSignature(m) {
  if (m.uniforms) {
    const u = m.uniforms
    return ["shader", m.side, u.shadeEnabled?.value, u.shadeOverride?.value?.toArray().join(","), u.d0?.value, u.d1?.value, u.ambient?.value,
      u.light0?.value?.toArray().join(","), u.light1?.value?.toArray().join(","), u.emission?.value,
      u.blockLightTint?.value?.toArray().join(","), u.skyLightColor?.value?.toArray().join(","), u.ambientColor?.value?.toArray().join(","),
      u.skyLightFactor?.value, u.brightness?.value, u.shadePos?.value?.toArray().join(","), u.shadeNeg?.value?.toArray().join(","), u.aoEnabled?.value,
      u.diffuseOn?.value, u.diffuse0?.value?.toArray().join(","), u.diffuse1?.value?.toArray().join(","), u.diffuseMix?.value?.toArray().join(","), alphaSignature(m)].join("|")
  }
  return [m.type, m.side, alphaSignature(m)].join("|")
}

let _pixelCanvas = null, _pixelCtx = null
function pixelData(img) {
  const px = platform.imagePixels?.(img)
  if (px) return px
  if (!_pixelCanvas) {
    _pixelCanvas = new Canvas(1, 1)
    _pixelCtx = _pixelCanvas.getContext("2d", { willReadFrequently: true })
  }
  _pixelCanvas.width = img.width
  _pixelCanvas.height = img.height
  _pixelCtx.clearRect(0, 0, img.width, img.height)
  _pixelCtx.drawImage(img, 0, 0)
  return _pixelCtx.getImageData(0, 0, img.width, img.height).data
}

const opaqueCache = new WeakMap()
function isOpaque(tex) {
  let o = opaqueCache.get(tex)
  if (o !== undefined) return o
  if (tex.userData?.opaque !== undefined) {
    opaqueCache.set(tex, tex.userData.opaque)
    return tex.userData.opaque
  }
  const d = pixelData(tex.image)
  o = true
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { o = false; break }
  opaqueCache.set(tex, o)
  return o
}

const translucentCache = new WeakMap()
function isTranslucent(tex, cutoff) {
  if (tex.userData?.translucent !== undefined) return tex.userData.translucent
  let t = translucentCache.get(tex)
  if (t !== undefined) return t
  const min = cutoff?.min ?? 5
  const max = cutoff?.max ?? 240
  const d = pixelData(tex.image)
  t = false
  for (let i = 3; i < d.length; i += 4) if (d[i] > min && d[i] < max) { t = true; break }
  translucentCache.set(tex, t)
  return t
}

const texHash = new WeakMap()
const animHash = new WeakMap()
let animHashId = 0
function hashTexture(tex) {
  const sh = tex.userData?.srcHash
  if (sh) return sh
  if (tex.userData?.frames) {
    let ah = animHash.get(tex)
    if (ah === undefined) animHash.set(tex, ah = `anim${++animHashId}_${tex.image.width}x${tex.image.height}`)
    return ah
  }
  const img = tex.image
  let h = texHash.get(img)
  if (h !== undefined) return h
  const d = pixelData(img)
  let v = 2166136261
  for (let i = 0; i < d.length; i++) { v ^= d[i]; v = Math.imul(v, 16777619) }
  h = `${v >>> 0}_${img.width}x${img.height}`
  texHash.set(img, h)
  return h
}

let _maxAtlas = null
function detectMaxAtlas() {
  if (_maxAtlas) return _maxAtlas
  let canvasMax = Infinity
  if (typeof OffscreenCanvas !== "undefined" && Canvas === OffscreenCanvas) {
    canvasMax = 4096
    for (const size of [32768, 16384, 8192]) {
      try {
        const c = new Canvas(size, 1)
        const ctx = c.getContext("2d")
        ctx.fillRect(size - 1, 0, 1, 1)
        if (ctx.getImageData(size - 1, 0, 1, 1).data[3] === 255) { canvasMax = size; break }
      } catch {}
    }
  }
  let glMax = platform.maxTextureSize?.() ?? 16384
  _maxAtlas = Math.min(canvasMax, glMax)
  return _maxAtlas
}

const orientCorner = (oc, ha, hb) => (((oc & 1 ? hb : ha) ^ (oc >> 1 & 1)) << 1) | ((oc & 1 ? ha : hb) ^ (oc >> 2))

function orientCode(orient) {
  const o = orient[0]
  if (o < 0) return -1
  const oc = (orient[2] >> 1 === o >> 1 ? 1 : 0) | (o >> 1 << 1) | ((o & 1) << 2)
  for (let k = 1; k < 4; k++) if (orient[k] !== orientCorner(oc, k >> 1, k & 1)) return -1
  return oc
}

let _ef = null
const _fa = new Float64Array(6), _fb = new Float64Array(6), _fu = new Float64Array(6), _fv = new Float64Array(6), _fo = new Int8Array(4)
function extractFlat(geo, grp, mw, nm, tex, mat, cull, tiled) {
  _ef ??= new THREE.Vector3()
  const pos = geo.attributes.position, uv = geo.attributes.uv, nrm = geo.attributes.normal, idx = geo.index, n = grp.count
  if (!uv || n > 6) return null
  _ef.fromBufferAttribute(nrm, idx.getX(grp.start)).applyMatrix3(nm).normalize()
  const na = Math.abs(_ef.x) > 0.99 ? 0 : Math.abs(_ef.y) > 0.99 ? 1 : Math.abs(_ef.z) > 0.99 ? 2 : -1
  if (na < 0) return null
  const ns = _ef.getComponent(na) > 0 ? 1 : -1
  const pa = na === 0 ? 1 : 0, pb = na === 2 ? 1 : 2
  const A = _fa, B = _fb, U = _fu, V = _fv
  let pc = 0, a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity, umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity
  for (let k = 0; k < n; k++) {
    const i = idx.getX(grp.start + k)
    _ef.fromBufferAttribute(pos, i).applyMatrix4(mw)
    const cn = _ef.getComponent(na)
    if (k === 0) pc = cn
    else if (Math.abs(cn - pc) > 0.01) return null
    const a = A[k] = _ef.getComponent(pa), b = B[k] = _ef.getComponent(pb), u = U[k] = uv.getX(i), v = V[k] = uv.getY(i)
    if (a < a0) a0 = a
    if (a > a1) a1 = a
    if (b < b0) b0 = b
    if (b > b1) b1 = b
    if (u < umin) umin = u
    if (u > umax) umax = u
    if (v < vmin) vmin = v
    if (v > vmax) vmax = v
  }
  const wa = a1 - a0, wb = b1 - b0
  if (wa < 0.01 || wb < 0.01) return null
  for (let k = 0; k < n; k++) if ((Math.abs(A[k] - a0) > 0.01 && Math.abs(A[k] - a1) > 0.01) || (Math.abs(B[k] - b0) > 0.01 && Math.abs(B[k] - b1) > 0.01)) return null
  const du = umax - umin, dv = vmax - vmin
  if (du < 1e-4 || dv < 1e-4) return null
  let c0 = 0, c1 = -1
  while (Math.abs(A[c0] - a0) >= 0.01) c0++
  for (let k = 0; k < n && c1 < 0; k++) if (Math.abs(A[k] - a1) < 0.01 && Math.abs(B[k] - B[c0]) < 0.01) c1 = k
  if (c1 < 0) return null
  const uAxisIsPa = Math.abs(U[c1] - U[c0]) > Math.abs(V[c1] - V[c0])
  const tw = tex.image.width, th = tex.image.height
  const sub = { sx: Math.round(umin * tw), sy: Math.round((1 - vmax) * th), sw: Math.round(du * tw), sh: Math.round(dv * th) }
  if (sub.sw < 1 || sub.sh < 1) return null
  if (Math.abs(umin * tw - sub.sx) > 1e-3 || Math.abs((1 - vmax) * th - sub.sy) > 1e-3 || Math.abs(du * tw - sub.sw) > 1e-3 || Math.abs(dv * th - sub.sh) > 1e-3) return null
  const verts = new Array(n), orient = _fo.fill(-1)
  let clash = false
  for (let k = 0; k < n; k++) {
    const ha = Math.abs(A[k] - a1) < 0.01 ? 1 : 0, hb = Math.abs(B[k] - b1) < 0.01 ? 1 : 0, u = (U[k] - umin) / du, v = (V[k] - vmin) / dv
    const ur = Math.round(u), vr = Math.round(v)
    if (Math.abs(u - ur) > 1e-3 || Math.abs(v - vr) > 1e-3) return null
    verts[k] = { ha, hb, u, v }
    if (orient[ha * 2 + hb] >= 0 && orient[ha * 2 + hb] !== ur * 2 + vr) clash = true
    orient[ha * 2 + hb] = ur * 2 + vr
  }
  const oc = tiled && !clash ? orientCode(orient) : -1
  if (tiled && oc < 0) return null
  const srcHash = hashTexture(tex)
  const col = geo.attributes.color
  let tint = null
  if (col) {
    const a = idx.getX(grp.start) * 3
    if (col.array[a] !== 255 || col.array[a + 1] !== 255 || col.array[a + 2] !== 255) tint = [col.array[a], col.array[a + 1], col.array[a + 2]]
  }
  const { id: sigId, sig } = atlasSigs(mat)
  const cellKey = `${sigId}:${srcHash}:${sub.sx},${sub.sy},${sub.sw},${sub.sh}:${Math.round(wa * 100)}x${Math.round(wb * 100)}:${tiled ? "" : orient.join("")}:${faceDataOf(mat)?.join(",") ?? ""}:${tint ?? ""}`
  return { na, ns, pa, pb, pc, a0, b0, wa, wb, uAxisIsPa, sub, verts, sig, tex, mat, srcHash, cull, cellKey, tint, oc }
}

function extractFlats(geo, grp, mw, nm, tex, mat, cull, tiled) {
  if (grp.count % 6) return null
  const out = []
  for (let s = grp.start; s < grp.start + grp.count; s += 6) {
    const flat = extractFlat(geo, { start: s, count: 6 }, mw, nm, tex, mat, cull, tiled)
    if (!flat) return null
    flat.tiled = tiled
    out.push({ flat, start: s, count: 6 })
  }
  return out
}

class GridTable {
  constructor() {
    this.size = 0
    this.alloc(1024)
  }
  alloc(cap) {
    this.mask = cap - 1
    this.keys = new Float64Array(cap)
    this.cids = new Int32Array(cap).fill(-1)
    this.vals = new Int32Array(cap)
  }
  slot(cid, key) {
    let h = Math.imul((key >>> 0) ^ Math.imul((key / 4294967296) | 0, 0x85ebca6b) ^ Math.imul(cid, 0x9e3779b1), 0x27d4eb2d)
    h = (h ^ (h >>> 15)) & this.mask
    const keys = this.keys, cids = this.cids
    while (cids[h] >= 0 && (cids[h] !== cid || keys[h] !== key)) h = (h + 1) & this.mask
    return h
  }
  get(cid, key) {
    const s = this.slot(cid, key)
    return this.cids[s] < 0 ? -1 : this.vals[s]
  }
  set(cid, key, v) {
    if ((this.size + 1) * 2 > this.mask) {
      const { keys, cids, vals } = this
      this.alloc((this.mask + 1) * 2)
      for (let i = 0; i < cids.length; i++) if (cids[i] >= 0) this.place(cids[i], keys[i], vals[i])
    }
    this.place(cid, key, v)
    this.size++
  }
  place(cid, key, v) {
    const s = this.slot(cid, key)
    this.cids[s] = cid
    this.keys[s] = key
    this.vals[s] = v
  }
}

function posMod(v, m) {
  const iv = v | 0, im = m | 0
  return iv === v && im === m && im > 0 ? ((iv % im) + im) % im : ((v % m) + m) % m
}

function cullBit(dir) {
  switch (dir) {
    case "down": return 1
    case "up": return 2
    case "north": return 4
    case "south": return 8
    case "west": return 16
    case "east": return 32
    default: return 64
  }
}

export const CULL_DIRS = ["down", "up", "north", "south", "west", "east"]

export function cullMaskOf(set) {
  let m = 0
  for (const dir of set) m |= cullBit(dir)
  return m
}

function faceCulled(f, cm, cull) {
  const b = cullBit(f.cull)
  return b < 64 ? (cm & b) !== 0 : !!cull?.has(f.cull)
}

function scanCells(scan, from, to) {
  const { placeGroup, placeCull, groupTd, culls, cullMask, P, base, cellIds, gridIndex, gridNames, grids, cellRuns, cellOrients } = scan
  for (let i = from; i < to; i++) {
    const td = placeGroup[i] < 0 ? undefined : groupTd[placeGroup[i]]
    if (!td) continue
    const cull = placeCull[i] < 0 ? null : culls[placeCull[i]], cm = placeCull[i] < 0 ? 0 : cullMask[placeCull[i]]
    if (!td.mergeFree && (td.mergeBits & ~cm) === 0) continue
    const o3 = i * 3, merge = td.merge
    for (let k = 0; k < merge.length; k++) {
      const f = merge[k]
      if (cm && f.cb && (f.cb < 64 ? (cm & f.cb) !== 0 : cull.has(f.cull))) continue
      let cid = f.cid
      if (cid === undefined) {
        cid = cellIds.get(f.cellKey)
        if (cid === undefined) cellIds.set(f.cellKey, cid = cellIds.size)
        f.cid = cid
      }
      const wpc = f.pc + P[o3 + f.na] * 16
      const wa0 = f.a0 + P[o3 + f.pa] * 16, wb0 = f.b0 + P[o3 + f.pb] * 16
      const phaseA = posMod(wa0, f.wa), phaseB = posMod(wb0, f.wb)
      const wq = Math.round((f.pc + (P[o3 + f.na] - base[f.na]) * 16) * 100), pa = Math.round(phaseA * 100), pb = Math.round(phaseB * 100)
      const key = pa >= 0 && pa < 2048 && pb >= 0 && pb < 2048 && wq > -1e8 && wq < 1e8
        ? ((wq * 2048 + pa) * 2048 + pb) * 8 + f.na * 2 + (f.ns > 0 ? 1 : 0)
        : f.na + "|" + wq + "|" + f.ns + "|" + pa + "|" + pb
      let g
      if (typeof key === "number") {
        g = gridIndex.get(cid, key)
        if (g < 0) gridIndex.set(cid, key, g = grids.length)
      } else {
        const sk = cid + "#" + key
        g = gridNames.get(sk) ?? -1
        if (g < 0) gridNames.set(sk, g = grids.length)
      }
      if (g === grids.length) grids.push({ f, wpc, phaseA, phaseB, index: g, mixed: false })
      else if (f.oc !== grids[g].f.oc && !grids[g].mixed) scan.mixed = grids[g].mixed = true
      cellRuns.push3(g, Math.round((wa0 - phaseA) / f.wa), Math.round((wb0 - phaseB) / f.wb))
      if (cellOrients) cellOrients.push(f.oc)
    }
  }
}

function hashCell(g, i, j) {
  let h = Math.imul(g, 0x9e3779b1) ^ Math.imul(i, 0x85ebca6b) ^ Math.imul(j, 0xc2b2ae35)
  h = Math.imul(h ^ (h >>> 16), 0x27d4eb2d)
  return h ^ (h >>> 15)
}

function indexOrients(grids, cells) {
  let n = 0
  for (let c = 0; c < cells.length; c += 3) if (grids[cells[c]].mixed) n++
  let cap = 1024
  while (cap < n * 2) cap *= 2
  const slots = new Int32Array(cap).fill(-1), mask = cap - 1
  for (let c = 0; c < cells.length; c += 3) {
    const g = cells[c], i = cells[c + 1], j = cells[c + 2]
    if (!grids[g].mixed) continue
    let h = hashCell(g, i, j) & mask, s
    while ((s = slots[h]) >= 0 && (cells[s] !== g || cells[s + 1] !== i || cells[s + 2] !== j)) h = (h + 1) & mask
    if (s < 0) slots[h] = c
  }
  return { slots, mask, cells }
}

const MIXED = 8

function chunkOrient(scan, g, i0, i1, j0, j1) {
  const { slots, mask, cells } = scan.orientIndex, orients = scan.cellOrients.a, out = scan.quadOrients, at = out.length
  let first = -1, mixed = false
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    let h = hashCell(g, i, j) & mask, s
    while ((s = slots[h]) >= 0 && (cells[s] !== g || cells[s + 1] !== i || cells[s + 2] !== j)) h = (h + 1) & mask
    if (s < 0) throw new Error(`merged quad covers cell ${i},${j} that grid ${g} never placed`)
    const oc = orients[s / 3]
    if (first < 0) first = oc
    else if (oc !== first) mixed = true
    out.push(oc)
  }
  if (mixed) return MIXED
  out.length = at
  return first
}

const TILED_SPAN = 4096, TILED_SORT_SPAN = 32, MIXED_SPAN = 32

function splitQuads(scan, from, to) {
  const { grids, rectRun, rectAt, maxTile, tiles, atlasGroups, cutoff, greedyQuads, quadOrients } = scan
  for (let gi = from; gi < to; gi++) {
    const grid = grids[gi], f = grid.f
    let tile = f.tile
    if (!tile) {
      const translucent = isTranslucent(f.tex, cutoff)
      const sig = f.sig + (translucent ? "|T" : "|O")
      let grp = atlasGroups.get(sig)
      if (!grp) atlasGroups.set(sig, grp = { textures: new Set(), repMat: f.mat, translucent })
      const content = f.srcHash + ":" + f.sub.sx + "," + f.sub.sy + "," + f.sub.sw + "," + f.sub.sh
      const tileKey = sig + "#" + content
      tile = tiles.get(tileKey)
      if (!tile) tiles.set(tileKey, tile = { sig, grp, f, content, ur: 0, vr: 0, pseudo: null })
      f.tile = tile
    }
    const span = Math.min(tile.grp.translucent ? TILED_SORT_SPAN : TILED_SPAN, grid.mixed ? MIXED_SPAN : TILED_SPAN)
    const maxA = f.tiled ? span : Math.max(1, Math.floor(maxTile / f.sub.sw)), maxB = f.tiled ? span : Math.max(1, Math.floor(maxTile / f.sub.sh))
    for (let ri = rectAt[grid.index], rEnd = rectAt[grid.index + 1]; ri < rEnd; ri += 5) {
      const i0 = rectRun[ri + 1], i1 = rectRun[ri + 2], j0 = rectRun[ri + 3], j1 = rectRun[ri + 4]
      for (let ci = i0; ci <= i1; ci += maxA) for (let cj = j0; cj <= j1; cj += maxB) {
        const ei = Math.min(ci + maxA - 1, i1), ej = Math.min(cj + maxB - 1, j1)
        const Na = ei - ci + 1, Nb = ej - cj + 1
        const wALo = grid.phaseA + ci * f.wa, wAHi = grid.phaseA + (ei + 1) * f.wa
        const wBLo = grid.phaseB + cj * f.wb, wBHi = grid.phaseB + (ej + 1) * f.wb
        const ur = f.uAxisIsPa ? Na : Nb, vr = f.uAxisIsPa ? Nb : Na
        if (ur > tile.ur) tile.ur = ur
        if (vr > tile.vr) tile.vr = vr
        const at = grid.mixed ? quadOrients.length : 0, oc = grid.mixed ? chunkOrient(scan, grid.index, ci, ei, cj, ej) : f.oc
        greedyQuads.push({ tile, ur, vr, f, wpc: grid.wpc, wALo, wAHi, wBLo, wBHi, ca: Na, cb: Nb, oc, at, lx: -1, ly: -1 })
      }
    }
  }
}

function countBakes(bake, placeCount) {
  const { placeGroup, placeCull, groupTd, culls, cullMask, planFor, touched } = bake
  for (let i = 0; i < placeCount; i++) {
    const td = placeGroup[i] < 0 ? undefined : groupTd[placeGroup[i]]
    if (!td || td.inert) continue
    const cull = placeCull[i] < 0 ? null : culls[placeCull[i]], cm = placeCull[i] < 0 ? 0 : cullMask[placeCull[i]]
    const need = planFor(td, cm, cull).need
    for (let k = 0; k < need.length; k++) {
      const [acc, n, nF] = need[k]
      if (acc.need === 0) touched.push(acc)
      acc.need += n
      acc.needF += nF
    }
  }
}

function bakeCells(bake, from, to) {
  const { placeGroup, placeCull, groupTd, culls, cullMask, P, bakes, planFor, placeExtras, blockT, full, nmat } = bake
  for (let i = from; i < to; i++) {
    const td = placeGroup[i] < 0 ? undefined : groupTd[placeGroup[i]]
    if (!td || td.inert) continue
    const cull = placeCull[i] < 0 ? null : culls[placeCull[i]], cm = placeCull[i] < 0 ? 0 : cullMask[placeCull[i]]
    const { faces, meshes, offs } = planFor(td, cm, cull), B = bakes.buf
    if (!faces.length && td.simple) continue
    const tx = P[i * 3] * 16, ty = P[i * 3 + 1] * 16, tz = P[i * 3 + 2] * 16
    let fullFor = null
    for (let k = 0; k < faces.length; k++) {
      const f = faces[k], off = offs[k]
      if (off >= 0) {
        appendBaked(B, off, f.count, !!f.fd, tx, ty, tz, f.acc)
        continue
      }
      if (fullFor !== meshes[k]) {
        fullFor = meshes[k]
        full.multiplyMatrices(blockT.makeTranslation(tx, ty, tz), fullFor.matrix)
        nmat.getNormalMatrix(full)
      }
      appendGroup(fullFor.geo, f.start, f.count, full, nmat, f.rect, f.sw, f.sh, f.acc, f.fd)
    }
    if (!td.simple) placeExtras(td, i)
  }
}

const rectsOverlap = (f, g) => f.a0 < g.a0 + g.wa - 0.01 && g.a0 < f.a0 + f.wa - 0.01 && f.b0 < g.b0 + g.wb - 0.01 && g.b0 < f.b0 + f.wb - 0.01

const atlasCache = new Map()
const ATLAS_CACHE_BYTES = 256 * 1024 * 1024
function sweepAtlasCache() {
  let bytes = 0
  for (const e of atlasCache.values()) bytes += e.bytes
  for (const [key, e] of atlasCache) {
    if (bytes <= ATLAS_CACHE_BYTES) break
    if (e.users > 0) continue
    atlasCache.delete(key)
    bytes -= e.bytes
    for (const a of e.atlases) { try { a.dispose() } catch {} }
  }
}
function releaseAtlas(entry) {
  entry.users--
  if (entry.owned) {
    for (const a of entry.atlases) { try { a.dispose() } catch {} }
    return
  }
  sweepAtlasCache()
}

function releaseImage(texture) {
  const { width, height } = texture.image
  texture.image = { width, height }
}

async function buildAtlas(textures, maxAtlas, breathe, owned) {
  const pad = 1
  const rep = new Map()
  for (const t of textures) { const h = hashTexture(t); if (!rep.has(h)) rep.set(h, t) }
  const colorSpace = textures[0].colorSpace ?? THREE.NoColorSpace
  const cacheKey = Array.from(rep.keys()).sort().join("|") + "\0" + maxAtlas + "\0" + colorSpace
  let entry = owned ? null : atlasCache.get(cacheKey)
  if (entry) {
    atlasCache.delete(cacheKey)
    atlasCache.set(cacheKey, entry)
    entry.users++
    const rects = new Map()
    for (const t of textures) rects.set(t, entry.byHash.get(hashTexture(t)))
    return { atlases: entry.atlases, rects, sizes: entry.sizes, entry }
  }
  const items = Array.from(rep.values()).map(t => ({ t, img: t.image, w: t.image.width, h: t.image.height }))
  items.sort((a, b) => b.h - a.h)
  let area = 0, widest = 0
  for (const it of items) {
    area += (it.w + pad * 2) * (it.h + pad * 2)
    widest = Math.max(widest, it.w + pad * 2)
  }
  const pageW = Math.min(maxAtlas, Math.max(widest, Math.ceil(Math.sqrt(area))))
  let ai = 0, x = 0, y = 0, rowH = 0
  const sizes = [{ w: 0, h: 0 }]
  for (const it of items) {
    const cw = it.w + pad * 2, ch = it.h + pad * 2
    if (x + cw > pageW) { y += rowH; x = 0; rowH = 0 }
    if (y + ch > maxAtlas) { ai++; x = 0; y = 0; rowH = 0; sizes[ai] = { w: 0, h: 0 } }
    it.ai = ai; it.px = x; it.py = y
    x += cw; rowH = Math.max(rowH, ch)
    sizes[ai].w = Math.max(sizes[ai].w, x)
    sizes[ai].h = Math.max(sizes[ai].h, y + rowH)
  }
  const byHash = new Map()
  let drawn = 0
  const pixels = platform.imageFromPixels ? items.map(it => pixelData(it.img)) : []
  let canvases
  if (pixels.length && pixels.every(Boolean)) {
    const pages = sizes.map(s => new Uint8ClampedArray(s.w * s.h * 4))
    for (let n = 0; n < items.length; n++) {
      if (++drawn % 64 === 0) await breathe?.()
      const it = items[n], px = pixels[n], page = pages[it.ai], pw = sizes[it.ai].w, dx = it.px + pad, dy = it.py + pad, { w, h } = it
      const row = y => px.subarray(y * w * 4, (y + 1) * w * 4)
      for (let y = 0; y < h; y++) {
        const at = ((dy + y) * pw + dx) * 4
        page.set(row(y), at)
        page.set(px.subarray(y * w * 4, y * w * 4 + 4), at - 4)
        page.set(px.subarray((y * w + w - 1) * 4, (y * w + w) * 4), at + w * 4)
      }
      page.set(row(0), ((dy - 1) * pw + dx) * 4)
      page.set(row(h - 1), ((dy + h) * pw + dx) * 4)
      byHash.set(hashTexture(it.t), { ai: it.ai, x: dx, y: dy, w, h })
    }
    canvases = pages.map((page, i) => platform.imageFromPixels(page, sizes[i].w, sizes[i].h))
  } else {
    const ctxs = sizes.map(s => new Canvas(s.w, s.h).getContext("2d"))
    for (const it of items) {
      if (++drawn % 64 === 0) await breathe?.()
      const ctx = ctxs[it.ai], dx = it.px + pad, dy = it.py + pad, { w, h, img } = it
      ctx.drawImage(img, dx, dy)
      ctx.drawImage(img, 0, 0, w, 1, dx, dy - 1, w, 1)
      ctx.drawImage(img, 0, h - 1, w, 1, dx, dy + h, w, 1)
      ctx.drawImage(img, 0, 0, 1, h, dx - 1, dy, 1, h)
      ctx.drawImage(img, w - 1, 0, 1, h, dx + w, dy, 1, h)
      byHash.set(hashTexture(it.t), { ai: it.ai, x: dx, y: dy, w, h })
    }
    canvases = ctxs.map(ctx => ctx.canvas)
  }
  const atlases = []
  for (const canvas of canvases) {
    const a = await loadTexture(canvas)
    a.magFilter = a.minFilter = THREE.NearestFilter
    a.generateMipmaps = false
    a.colorSpace = colorSpace
    a.needsUpdate = true
    atlases.push(a)
  }
  const rects = new Map()
  for (const t of textures) rects.set(t, byHash.get(hashTexture(t)))
  entry = { atlases, sizes, byHash, users: 1, owned, bytes: sizes.reduce((n, s) => n + s.w * s.h * 4, 0) }
  if (owned) return { atlases, rects, sizes, entry }
  atlasCache.set(cacheKey, entry)
  sweepAtlasCache()
  return { atlases, rects, sizes, entry }
}

const GR_M = 1 << 25, GR_W = 67108864
const packCell = (i, j) => (j + GR_M) * GR_W + (i + GR_M)
export function greedyMeshJs(triples, gridCount) {
  const starts = new Int32Array(gridCount + 1)
  for (let i = 0; i < triples.length; i += 3) {
    const g = triples[i]
    if (g >= 0 && g < gridCount) starts[g + 1]++
  }
  for (let g = 0; g < gridCount; g++) starts[g + 1] += starts[g]
  const cells = new Float64Array(starts[gridCount])
  const fill = starts.slice(0, gridCount)
  for (let i = 0; i < triples.length; i += 3) {
    const g = triples[i]
    if (g >= 0 && g < gridCount) cells[fill[g]++] = packCell(triples[i + 1], triples[i + 2])
  }
  const out = []
  for (let g = 0; g < gridCount; g++) {
    if (starts[g] === starts[g + 1]) continue
    greedyRects(cells.subarray(starts[g], starts[g + 1]), g, out)
  }
  return Int32Array.from(out)
}

function greedyRects(coords, g, out) {
  coords.sort()
  let n = 0
  for (let k = 0; k < coords.length; k++) if (k === 0 || coords[k] !== coords[n - 1]) coords[n++] = coords[k]
  const done = new Uint8Array(n)
  function indexOf(v) {
    let lo = 0, hi = n - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (coords[mid] < v) lo = mid + 1
      else if (coords[mid] > v) hi = mid - 1
      else return mid
    }
    return -1
  }
  const free = v => {
    const k = indexOf(v)
    return k >= 0 && !done[k]
  }
  for (let k = 0; k < n; k++) {
    if (done[k]) continue
    const v = coords[k]
    const im = v % GR_W, i0 = im - GR_M, j0 = (v - im) / GR_W - GR_M
    let a1 = i0
    while (free(v + (a1 - i0 + 1))) a1++
    let b1 = j0, grow = true
    while (grow) {
      const rowBase = v + (b1 + 1 - j0) * GR_W
      for (let x = 0; x <= a1 - i0; x++) if (!free(rowBase + x)) { grow = false; break }
      if (grow) b1++
    }
    for (let y = 0; y <= b1 - j0; y++) for (let x = 0; x <= a1 - i0; x++) done[indexOf(v + y * GR_W + x)] = 1
    out.push(g, i0, a1, j0, b1)
  }
}

const SPARSE_AREA = 256
function sparseCells(triples, gridCount) {
  const lo = new Int32Array(gridCount * 2).fill(2147483647), hi = new Int32Array(gridCount * 2).fill(-2147483648)
  for (let i = 0; i < triples.length; i += 3) {
    const g = triples[i] * 2, a = triples[i + 1], b = triples[i + 2]
    if (a < lo[g]) lo[g] = a
    if (a > hi[g]) hi[g] = a
    if (b < lo[g + 1]) lo[g + 1] = b
    if (b > hi[g + 1]) hi[g + 1] = b
  }
  let area = 0
  for (let g = 0; g < gridCount * 2; g += 2) if (hi[g] >= lo[g]) area += (hi[g] - lo[g] + 1) * (hi[g + 1] - lo[g + 1] + 1)
  return area > SPARSE_AREA * (triples.length / 3)
}

const GROW_IN_PLACE = typeof ArrayBuffer.prototype.transfer === "function"

class GrowI32 {
  constructor() { this.a = new Int32Array(4096); this.length = 0 }
  push3(x, y, z) {
    if (this.length + 3 > this.a.length) {
      const b = new Int32Array(this.a.length * 2)
      b.set(this.a)
      this.a = b
    }
    const a = this.a, l = this.length
    a[l] = x; a[l + 1] = y; a[l + 2] = z
    this.length = l + 3
  }
  data() { return this.a.length === this.length ? this.a : this.a.subarray(0, this.length) }
}

class GrowU8 {
  constructor() { this.a = new Uint8Array(4096); this.length = 0 }
  ensure(n) {
    if (this.length + n <= this.a.length) return
    let cap = this.a.length * 2
    while (cap < this.length + n) cap *= 2
    if (GROW_IN_PLACE) {
      this.a = new Uint8Array(this.a.buffer.transfer(cap * 1))
      return
    }
    const b = new Uint8Array(cap)
    b.set(this.a)
    this.a = b
  }
  reserve(n) {
    if (n <= this.a.length) return
    if (GROW_IN_PLACE) { this.a = new Uint8Array(this.a.buffer.transfer(n)); return }
    const b = new Uint8Array(n); b.set(this.a); this.a = b
  }
  push(x) { this.ensure(1); this.a[this.length++] = x }
  push3(x, y, z) { this.ensure(3); const a = this.a, l = this.length; a[l] = x; a[l + 1] = y; a[l + 2] = z; this.length = l + 3 }
  append(v) { if (!v.length) return; this.ensure(v.length); this.a.set(v, this.length); this.length += v.length }
}

class GrowF32 {
  constructor() { this.a = new Float32Array(4096); this.length = 0 }
  ensure(n) {
    if (this.length + n <= this.a.length) return
    let cap = this.a.length * 2
    while (cap < this.length + n) cap *= 2
    if (GROW_IN_PLACE) {
      this.a = new Float32Array(this.a.buffer.transfer(cap * 4))
      return
    }
    const b = new Float32Array(cap)
    b.set(this.a)
    this.a = b
  }
  push3(x, y, z) { this.ensure(3); const a = this.a, l = this.length; a[l] = x; a[l + 1] = y; a[l + 2] = z; this.length = l + 3 }
  append(v) { if (!v.length) return; this.ensure(v.length); this.a.set(v, this.length); this.length += v.length }
  push2(x, y) { this.ensure(2); const a = this.a, l = this.length; a[l] = x; a[l + 1] = y; this.length = l + 2 }
  reserve(n) {
    if (n <= this.a.length) return
    if (GROW_IN_PLACE) { this.a = new Float32Array(this.a.buffer.transfer(n * 4)); return }
    const b = new Float32Array(n); b.set(this.a); this.a = b
  }
}
function byteNormal(N, i) {
  const x = Math.round(N[i] * 127), y = Math.round(N[i + 1] * 127), z = Math.round(N[i + 2] * 127)
  const len = Math.sqrt(x * x + y * y + z * z)
  return len > 0 && Math.abs(x / len - N[i]) < 1e-6 && Math.abs(y / len - N[i + 1]) < 1e-6 && Math.abs(z / len - N[i + 2]) < 1e-6
}

function releaseArray() {
  this.array = null
}

function byteFaceData(emission, flags) {
  const k = emission * 15
  return Math.abs(k - Math.round(k)) < 1e-4 && k >= 0 && k <= 255 && Number.isInteger(flags) && flags >= 0 && flags <= 255
}

function quadLayout(f) {
  const corners = [], index = []
  for (const vert of f.verts) {
    let c = corners.findIndex(o => o.ha === vert.ha && o.hb === vert.hb && o.u === vert.u && o.v === vert.v)
    if (c < 0) c = corners.push(vert) - 1
    index.push(c)
  }
  return { corners, index }
}

function emitQuads(quads, from, to, orients) {
  for (let i = from; i < to; i++) {
    const q = quads[i], f = q.f, tile = q.tile, out = tile.acc.out, rect = tile.rect, size = tile.size
    const P = out.position, N = out.normal, U = out.uv, T = out.color, F = out.faceData, I = out.index, R = f.tiled ? out.tileRect : null, L = out.tileLookup
    const na = f.na, pa = f.pa, pb = f.pb, sub = f.sub, tint = f.tint, nv = f.ns * out.unit
    const tr = tint ? tint[0] : 255, tg = tint ? tint[1] : 255, tb = tint ? tint[2] : 255
    const fe = !F ? 0 : out.bytes ? Math.round(f.fd[0] * 15) : f.fd[0] * 15, ff = F ? f.fd[1] : 0
    const corners = f.layout.corners, order = f.layout.index
    const split = f.tiled && (!R || (q.oc === MIXED && q.lx < 0))
    const ca = split ? q.ca : 1, cb = split ? q.cb : 1
    const ox = tile.direct ? rect.x + sub.sx : rect.x, oy = tile.direct ? rect.y + sub.sy : rect.y
    const rw = tile.direct ? sub.sw : sub.sw * q.ur, rh = tile.direct ? sub.sh : sub.sh * q.vr
    let v0 = out.verts, i0 = out.indices
    for (let a = 0; a < ca; a++) for (let b = 0; b < cb; b++) {
      const aLo = split ? q.wALo + a * f.wa : q.wALo, aHi = split ? q.wALo + (a + 1) * f.wa : q.wAHi
      const bLo = split ? q.wBLo + b * f.wb : q.wBLo, bHi = split ? q.wBLo + (b + 1) * f.wb : q.wBHi
      const oc = split && q.oc === MIXED ? orients[q.at + b * q.ca + a] : q.oc
      for (let c = 0; c < corners.length; c++) {
        const vert = corners[c], o3 = (v0 + c) * 3, o2 = (v0 + c) * 2
        P[o3 + na] = q.wpc
        P[o3 + pa] = vert.ha ? aHi : aLo
        P[o3 + pb] = vert.hb ? bHi : bLo
        N[o3 + na] = nv
        if (R) {
          const o4 = (v0 + c) * 4
          U[o2] = (split ? 1 : q.ca) + vert.ha * 0.5 + (oc & 1) * 0.25 + (oc >> 1 & 1) * 0.125
          U[o2 + 1] = (split ? 1 : q.cb) + vert.hb * 0.5 + (oc >> 2 & 1) * 0.25 + (oc >> 3) * 0.125
          R[o4] = ox; R[o4 + 1] = oy; R[o4 + 2] = rw; R[o4 + 3] = rh
          if (oc === MIXED) { L[o2] = q.lx; L[o2 + 1] = q.ly }
        } else if (split) {
          const to = orientCorner(oc, vert.ha, vert.hb)
          U[o2] = (ox + (to >> 1) * rw) / size.w
          U[o2 + 1] = 1 - (oy + (1 - (to & 1)) * rh) / size.h
        } else {
          U[o2] = (ox + vert.u * rw) / size.w
          U[o2 + 1] = 1 - (oy + (1 - vert.v) * rh) / size.h
        }
        T[o3] = tr; T[o3 + 1] = tg; T[o3 + 2] = tb
        if (F) { F[o2] = fe; F[o2 + 1] = ff }
      }
      for (let k = 0; k < 6; k++) I[i0 + k] = v0 + order[k]
      v0 += corners.length
      i0 += 6
    }
    out.verts = v0
    out.indices = i0
  }
}

function dedupMesh(acc) {
  const P = acc.P.a, N = acc.N.a, U = acc.U.a, T = acc.T.a, F = acc.F.length ? acc.F.a : null, n = acc.P.length / 3
  const index = new Uint32Array(n), src = new Int32Array(n)
  function same(o, i) {
    const s3 = src[o] * 3, i3 = i * 3, s2 = src[o] * 2, i2 = i * 2
    return P[s3] === P[i3] && P[s3 + 1] === P[i3 + 1] && P[s3 + 2] === P[i3 + 2]
      && N[s3] === N[i3] && N[s3 + 1] === N[i3 + 1] && N[s3 + 2] === N[i3 + 2]
      && U[s2] === U[i2] && U[s2 + 1] === U[i2 + 1]
      && T[s3] === T[i3] && T[s3 + 1] === T[i3 + 1] && T[s3 + 2] === T[i3 + 2]
      && (!F || (F[s2] === F[i2] && F[s2 + 1] === F[i2 + 1]))
  }
  let w = 0, p0 = -1, p1 = -1, p2 = -1
  for (let t = 0; t < n; t += 3) {
    let c0 = -1, c1 = -1, c2 = -1
    for (let k = 0; k < 3; k++) {
      const i = t + k
      let o = p0 >= 0 && same(p0, i) ? p0 : p1 >= 0 && same(p1, i) ? p1 : p2 >= 0 && same(p2, i) ? p2 : -1
      if (o < 0) src[o = w++] = i
      index[i] = o
      if (k === 0) c0 = o
      else if (k === 1) c1 = o
      else c2 = o
    }
    p0 = c0; p1 = c1; p2 = c2
  }
  return { index, src, verts: w, indices: n }
}

const VERTEX_BYTES = 28, TILE_BYTES = 8, LOOKUP_VERTEX_BYTES = 4, LOOKUP_MAX = 4096
function meshBytes(acc, quads, vertexBytes) {
  const verts = acc.dedup.verts + quads * 4
  return verts * vertexBytes + (acc.dedup.indices + quads * 6) * (verts <= 65536 ? 2 : 4)
}

function packMesh(acc) {
  const P = acc.P.a, N = acc.N.a, U = acc.U.a, T = acc.T.a, F = acc.F.length ? acc.F.a : null
  const { index, src, verts: w, indices: n } = acc.dedup
  const verts = w + acc.quadVerts
  const position = new Float32Array(verts * 3), uv = new Float32Array(verts * 2), color = new Uint8Array(verts * 3)
  let byteNormals = true
  for (let o = 0; o < w; o++) {
    const s3 = src[o] * 3, s2 = src[o] * 2, o3 = o * 3, o2 = o * 2
    position[o3] = P[s3]; position[o3 + 1] = P[s3 + 1]; position[o3 + 2] = P[s3 + 2]
    uv[o2] = U[s2]; uv[o2 + 1] = U[s2 + 1]
    color[o3] = T[s3]; color[o3 + 1] = T[s3 + 1]; color[o3 + 2] = T[s3 + 2]
    if (byteNormals) byteNormals = byteNormal(N, s3)
  }
  let normal
  if (byteNormals) {
    normal = new Int8Array(verts * 3)
    for (let o = 0; o < w; o++) {
      const s3 = src[o] * 3, o3 = o * 3
      normal[o3] = Math.round(N[s3] * 127); normal[o3 + 1] = Math.round(N[s3 + 1] * 127); normal[o3 + 2] = Math.round(N[s3 + 2] * 127)
    }
  } else {
    normal = new Int16Array(verts * 3)
    for (let o = 0; o < w; o++) {
      const s3 = src[o] * 3, o3 = o * 3
      normal[o3] = Math.round(N[s3] * 32767); normal[o3 + 1] = Math.round(N[s3 + 1] * 32767); normal[o3 + 2] = Math.round(N[s3 + 2] * 32767)
    }
  }
  let faceData = null, bytes = acc.quadBytes
  if (F || acc.quadFaceData) {
    if (F) for (let o = 0; o < w && bytes; o++) bytes = byteFaceData(F[src[o] * 2], F[src[o] * 2 + 1])
    faceData = bytes ? new Uint8Array(verts * 2) : new Float32Array(verts * 2)
    if (F) for (let o = 0; o < w; o++) {
      const s2 = src[o] * 2
      faceData[o * 2] = bytes ? Math.round(F[s2] * 15) : F[s2] * 15
      faceData[o * 2 + 1] = F[s2 + 1]
    }
  }
  const out = { position, normal, uv, color, faceData, tileRect: acc.tiled ? new Uint16Array(verts * 4) : null, tileLookup: acc.lookup ? new Uint16Array(verts * 2) : null, index: new (verts <= 65536 ? Uint16Array : Uint32Array)(n + acc.quads * 6), verts: w, indices: n, unit: byteNormals ? 127 : 32767, bytes }
  out.index.set(index)
  return out
}

const makeAcc = () => ({ P: new GrowF32(), N: new GrowF32(), U: new GrowF32(), F: new GrowF32(), T: new GrowU8(), need: 0, needF: 0, quads: 0, quadVerts: 0, quadFaceData: false, quadBytes: true, tiled: false, tiledQuads: 0, tiledCells: 0, lookup: false, lookupQuads: 0, lookupCells: 0, dedup: null, out: null })

function releaseLookup(texture) {
  const { width, height } = texture.image
  texture.image = { data: null, width, height }
}

function packLookup(quads, orients, stride, release) {
  const rows = Array.from({ length: MIXED_SPAN + 1 }, () => [])
  let area = 0
  for (const q of quads) {
    if (q.oc !== MIXED || !q.tile.acc.lookup) continue
    rows[q.cb].push(q)
    area += q.ca * q.cb
  }
  if (!area) return null
  let width = MIXED_SPAN
  while (width < LOOKUP_MAX && width * width < area) width *= 2
  let x = 0, y = 0, shelf = 0
  for (let h = MIXED_SPAN; h > 0; h--) for (const q of rows[h]) {
    if (x + q.ca > width) { y += shelf; x = 0; shelf = 0 }
    if (y + h > LOOKUP_MAX) continue
    if (!shelf) shelf = h
    q.lx = x
    q.ly = y
    x += q.ca
  }
  const height = y + shelf, data = new Uint8Array(width * height * stride)
  for (const row of rows) for (const q of row) {
    if (q.lx < 0) continue
    for (let b = 0; b < q.cb; b++) for (let a = 0; a < q.ca; a++) data[((q.ly + b) * width + q.lx + a) * stride] = orients[q.at + b * q.ca + a]
  }
  const texture = new THREE.DataTexture(data, width, height, stride === 1 ? THREE.RedFormat : THREE.RGBAFormat)
  texture.minFilter = texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  if (release) texture.onUpdate = releaseLookup
  return { texture, size: new THREE.Vector2(width, height) }
}

const BAKE_STRIDE = 13

function bakeFace(bakes, mesh, f) {
  const geo = mesh.geo, idx = geo.index, pos = geo.attributes.position, nrm = geo.attributes.normal, uv = geo.attributes.uv
  if (!idx?.array || pos.isInterleavedBufferAttribute || nrm.isInterleavedBufferAttribute || uv.isInterleavedBufferAttribute) return -1
  const ia = idx.array, pa = pos.array, na = nrm.array, ua = uv.array, ca = geo.attributes.color?.array
  const m = mesh.matrix.elements, e = (mesh.nm ??= new THREE.Matrix3().getNormalMatrix(mesh.matrix)).elements
  const n = f.count, rect = f.rect, W = f.sw, H = f.sh, fd = f.fd
  const off = bakes.len, need = off + 3 + n * BAKE_STRIDE
  if (need > bakes.buf.length) {
    let cap = bakes.buf.length * 2
    while (cap < need) cap *= 2
    const b = new Float64Array(cap)
    b.set(bakes.buf.subarray(0, off))
    bakes.buf = b
  }
  const B = bakes.buf
  B[off] = m[12]; B[off + 1] = m[13]; B[off + 2] = m[14]
  for (let k = 0, o = off + 3; k < n; k++, o += BAKE_STRIDE) {
    const a = ia[f.start + k], a3 = a * 3, a2 = a * 2
    const x = pa[a3], y = pa[a3 + 1], z = pa[a3 + 2]
    B[o] = m[0] * x + m[4] * y + m[8] * z
    B[o + 1] = m[1] * x + m[5] * y + m[9] * z
    B[o + 2] = m[2] * x + m[6] * y + m[10] * z
    const nx0 = na[a3], ny0 = na[a3 + 1], nz0 = na[a3 + 2]
    let nx = e[0] * nx0 + e[3] * ny0 + e[6] * nz0
    let ny = e[1] * nx0 + e[4] * ny0 + e[7] * nz0
    let nz = e[2] * nx0 + e[5] * ny0 + e[8] * nz0
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (len > 0) { const inv = 1 / len; nx *= inv; ny *= inv; nz *= inv }
    B[o + 3] = nx; B[o + 4] = ny; B[o + 5] = nz
    const u = ua[a2], v = ua[a2 + 1]
    if (rect) { B[o + 6] = (rect.x + u * rect.w) / W; B[o + 7] = 1 - (rect.y + (1 - v) * rect.h) / H }
    else { B[o + 6] = u; B[o + 7] = v }
    if (ca) { B[o + 8] = ca[a3]; B[o + 9] = ca[a3 + 1]; B[o + 10] = ca[a3 + 2] }
    else { B[o + 8] = 255; B[o + 9] = 255; B[o + 10] = 255 }
    if (fd) { B[o + 11] = fd[0]; B[o + 12] = fd[1] }
  }
  bakes.len = need
  return off
}

function appendBaked(B, off, n, hasF, tx, ty, tz, acc) {
  const ox = B[off] + tx, oy = B[off + 1] + ty, oz = B[off + 2] + tz
  const Pa = acc.P.a, Na = acc.N.a, Ua = acc.U.a, Ta = acc.T.a
  let pl = acc.P.length, nl = acc.N.length, ul = acc.U.length, tl = acc.T.length
  for (let k = 0, o = off + 3; k < n; k++, o += BAKE_STRIDE) {
    Pa[pl] = B[o] + ox; Pa[pl + 1] = B[o + 1] + oy; Pa[pl + 2] = B[o + 2] + oz
    Na[nl] = B[o + 3]; Na[nl + 1] = B[o + 4]; Na[nl + 2] = B[o + 5]
    Ua[ul] = B[o + 6]; Ua[ul + 1] = B[o + 7]
    Ta[tl] = B[o + 8]; Ta[tl + 1] = B[o + 9]; Ta[tl + 2] = B[o + 10]
    pl += 3; nl += 3; ul += 2; tl += 3
  }
  acc.P.length = pl; acc.N.length = nl; acc.U.length = ul; acc.T.length = tl
  if (hasF) {
    const Fa = acc.F.a
    let fl = acc.F.length
    for (let k = 0, o = off + 3; k < n; k++, o += BAKE_STRIDE, fl += 2) { Fa[fl] = B[o + 11]; Fa[fl + 1] = B[o + 12] }
    acc.F.length = fl
  }
}

let _v = null, _n = null
function appendGroup(geo, start, count, mat, nmat, rect, W, H, acc, fd) {
  const idx = geo.index, pos = geo.attributes.position, nrm = geo.attributes.normal, uv = geo.attributes.uv
  if (idx.array && !pos.isInterleavedBufferAttribute && !nrm.isInterleavedBufferAttribute && !uv.isInterleavedBufferAttribute) {
    const ia = idx.array, pa = pos.array, na = nrm.array, ua = uv.array
    const m = mat.elements, e = nmat.elements
    const m0 = m[0], m1 = m[1], m2 = m[2], m4 = m[4], m5 = m[5], m6 = m[6], m8 = m[8], m9 = m[9], m10 = m[10], m12 = m[12], m13 = m[13], m14 = m[14]
    const e0 = e[0], e1 = e[1], e2 = e[2], e3 = e[3], e4 = e[4], e5 = e[5], e6 = e[6], e7 = e[7], e8 = e[8]
    const ca = geo.attributes.color?.array
    const P = acc.P, N = acc.N, U = acc.U, F = acc.F, T = acc.T
    const Pa = P.a, Na = N.a, Ua = U.a, Fa = F.a, Ta = T.a
    let pl = P.length, nl = N.length, ul = U.length, fl = F.length, tl = T.length
    for (let i = start; i < start + count; i++) {
      const a = ia[i], a3 = a * 3, a2 = a * 2
      const x = pa[a3], y = pa[a3 + 1], z = pa[a3 + 2]
      Pa[pl] = m0 * x + m4 * y + m8 * z + m12
      Pa[pl + 1] = m1 * x + m5 * y + m9 * z + m13
      Pa[pl + 2] = m2 * x + m6 * y + m10 * z + m14
      pl += 3
      const nx0 = na[a3], ny0 = na[a3 + 1], nz0 = na[a3 + 2]
      let nx = e0 * nx0 + e3 * ny0 + e6 * nz0
      let ny = e1 * nx0 + e4 * ny0 + e7 * nz0
      let nz = e2 * nx0 + e5 * ny0 + e8 * nz0
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
      if (len > 0) { const inv = 1 / len; nx *= inv; ny *= inv; nz *= inv }
      Na[nl] = nx; Na[nl + 1] = ny; Na[nl + 2] = nz
      nl += 3
      const u = ua[a2], v = ua[a2 + 1]
      if (rect) { Ua[ul] = (rect.x + u * rect.w) / W; Ua[ul + 1] = 1 - (rect.y + (1 - v) * rect.h) / H }
      else { Ua[ul] = u; Ua[ul + 1] = v }
      ul += 2
      if (ca) { Ta[tl] = ca[a3]; Ta[tl + 1] = ca[a3 + 1]; Ta[tl + 2] = ca[a3 + 2] }
      else { Ta[tl] = 255; Ta[tl + 1] = 255; Ta[tl + 2] = 255 }
      tl += 3
      if (fd) { Fa[fl] = fd[0]; Fa[fl + 1] = fd[1]; fl += 2 }
    }
    P.length = pl; N.length = nl; U.length = ul; T.length = tl
    if (fd) F.length = fl
    return
  }
  _v ??= new THREE.Vector3()
  _n ??= new THREE.Vector3()
  const col = geo.attributes.color
  for (let i = start; i < start + count; i++) {
    const a = idx.getX(i)
    _v.fromBufferAttribute(pos, a).applyMatrix4(mat)
    _n.fromBufferAttribute(nrm, a).applyMatrix3(nmat).normalize()
    const u = uv.getX(a), v = uv.getY(a)
    acc.P.push3(_v.x, _v.y, _v.z)
    acc.N.push3(_n.x, _n.y, _n.z)
    if (rect) acc.U.push2((rect.x + u * rect.w) / W, 1 - (rect.y + (1 - v) * rect.h) / H)
    else acc.U.push2(u, v)
    if (col) acc.T.push3(col.array[a * 3], col.array[a * 3 + 1], col.array[a * 3 + 2])
    else acc.T.push3(255, 255, 255)
    if (fd) acc.F.push2(fd[0], fd[1])
  }
}

async function stitchSharedAtlas(shared, assets, opts = {}) {
  const sprites = await listAtlasSprites(assets, opts.atlases ?? ["blocks", "items"])
  let sheet = shared.sheets.get("*")
  if (!sheet) shared.sheets.set("*", sheet = { pages: [], rects: new Map() })
  const total = sprites.length * 2
  let n = 0
  let next = 0
  let cancelled = false
  const loaded = new Array(sprites.length)
  async function loadNext() {
    while (next < sprites.length && !cancelled) {
      const i = next++
      loaded[i] = await loadSpriteTexture(sprites[i], assets)
      if (++n % 64 === 0) {
        opts.onProgress?.(n, total)
        await nextTask()
        if (opts.shouldCancel?.()) cancelled = true
      }
    }
  }
  await Promise.all(Array.from({ length: STITCH_LOADS }, loadNext))
  if (cancelled) return null
  const texs = loaded.filter(tex => tex?.image)
  let area = 0
  for (const tex of texs) area += (tex.image.width + 2) * (tex.image.height + 2)
  if (shared.autoSize && !sheet.pages.length) {
    const cap = Math.min(detectMaxAtlas(), 8192)
    const fill = 1 - Math.min(Math.max(shared.headroom, 0), 0.95)
    let size = 1024
    while (size < cap && size * size * fill < area * 1.15) size *= 2
    shared.size = size
  }
  for (const tex of texs) {
    await sharedLocate(shared, sheet, tex)
    if (++n % 64 === 0) {
      opts.onProgress?.(n, total)
      await nextTask()
      if (opts.shouldCancel?.()) return null
    }
  }
  subFlush(shared.renderer)
  return shared
}

function exportSharedAtlasLayout(shared) {
  const sheet = shared.sheets.get("*")
  return {
    size: shared.size,
    pages: sheet?.pages.length ?? 0,
    rects: sheet ? Array.from(sheet.rects.entries()) : []
  }
}

function adoptSharedAtlasLayout(shared, layout) {
  const pages = []
  for (let i = 0; i < layout.pages; i++) {
    pages.push({ canvas: null, ctx: null, texture: new THREE.Texture(), x: 0, y: layout.size, rowH: 0, index: i })
  }
  shared.size = layout.size
  shared.sheets.set("*", { pages, rects: new Map(layout.rects) })
  shared.frozen = true
  return shared
}

async function insertSharedTextures(shared, items) {
  let sheet = shared.sheets.get("*")
  if (!sheet) shared.sheets.set("*", sheet = { pages: [], rects: new Map() })
  const rects = []
  for (const it of items) {
    let r = sheet.rects.get(it.key)
    if (!r && it.image) {
      const userData = { srcHash: it.key }
      if (it.frames?.length) {
        userData.frames = it.frames.map(f => {
          const c = new Canvas(f.width, f.height)
          c.getContext("2d").drawImage(f, 0, 0)
          f.close?.()
          return c
        })
        if (it.times) userData.times = it.times
        userData.interpolate = !!it.interpolate
      }
      r = await sharedLocate(shared, sheet, { image: it.image, userData, colorSpace: undefined })
    } else if (it.frames) {
      for (const f of it.frames) f.close?.()
    }
    it.image?.close?.()
    if (r) rects.push([it.key, r])
  }
  subFlush(shared.renderer)
  return { rects, pages: sheet.pages.length }
}

function makeAtlasPlayer(shared) {
  let schedules = null
  let version = -1
  let cursor = 0
  let timer = null
  function tick() {
    if (!schedules || version !== shared.serial) {
      version = shared.serial
      const texs = []
      for (const sheet of shared.sheets.values()) {
        for (const pg of sheet.pages) if (pg.texture.userData?.regions?.length) texs.push(pg.texture)
      }
      const prev = new Map((schedules ?? []).map(s => [s.region, s.lastKey]))
      schedules = buildSchedules(texs)
      for (const s of schedules) if (prev.has(s.region)) s.lastKey = prev.get(s.region)
    }
    const N = schedules.length
    if (!N) return
    const budget = 64
    const t = performance.now() / 50
    if (N <= budget) evaluateAnimation(schedules, [], t)
    else {
      cursor %= N
      const subset = []
      for (let i = 0; i < budget; i++) subset.push(schedules[(cursor + i) % N])
      cursor = (cursor + budget) % N
      evaluateAnimation(subset, [], t)
    }
  }
  return {
    playing: false,
    play() {
      if (this.playing || this._disposed) return
      this.playing = true
      timer = setInterval(tick, 50)
      timer.unref?.()
    },
    pause() {
      this.playing = false
      clearInterval(timer)
      timer = null
    },
    dispose() {
      this.pause()
      this._disposed = true
      schedules = null
    }
  }
}

export function createSharedAtlas(opts = {}) {
  const shared = {
    size: opts.size ?? 2048,
    autoSize: opts.size == null,
    headroom: opts.headroom ?? 0.25,
    renderer: opts.renderer ?? null,
    serial: 0,
    sheets: new Map(),
    animation: null,
    texture(sig, page) {
      return this.sheets.get(sig)?.pages[page]?.texture ?? null
    },
    stitch(assets, opts) {
      return stitchSharedAtlas(this, assets, opts)
    },
    exportLayout() {
      return exportSharedAtlasLayout(this)
    },
    adoptLayout(layout) {
      return adoptSharedAtlasLayout(this, layout)
    },
    insert(items) {
      return insertSharedTextures(this, items)
    },
    dispose() {
      this.animation?.dispose()
      for (const sheet of this.sheets.values()) {
        for (const page of sheet.pages) { try { page.texture.dispose() } catch {} }
      }
      this.sheets.clear()
    }
  }
  if (opts.animate) {
    shared.animation = makeAtlasPlayer(shared)
    shared.animation.play()
  }
  return shared
}

function paddedSprite(src, w, h) {
  const cw = w + 2, ch = h + 2
  const out = new (platform.ImageData ?? ImageData)(cw, ch)
  const d = out.data
  for (let y = 0; y < ch; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - 1))
    const row = y * cw * 4
    d.set(src.subarray(sy * w * 4, (sy + 1) * w * 4), row + 4)
    if (y === 0 || y === ch - 1) continue
    d.set(src.subarray(sy * w * 4, sy * w * 4 + 4), row)
    d.set(src.subarray((sy + 1) * w * 4 - 4, (sy + 1) * w * 4), row + (cw - 1) * 4)
  }
  return out
}

async function sharedLocate(shared, sheet, tex) {
  const key = hashTexture(tex)
  let r = sheet.rects.get(key)
  if (r) return r
  const iw = tex.image.width, ih = tex.image.height
  const cw = iw + 2, ch = ih + 2
  let page = sheet.pages[sheet.pages.length - 1]
  if (page && page.x + cw > shared.size) { page.y += page.rowH; page.x = 0; page.rowH = 0 }
  if (!page || page.y + ch > shared.size) {
    const canvas = new Canvas(shared.size, shared.size)
    const texture = await loadTexture(canvas)
    texture.magFilter = texture.minFilter = THREE.NearestFilter
    texture.generateMipmaps = false
    texture.colorSpace = tex.colorSpace ?? THREE.NoColorSpace
    texture.needsUpdate = true
    page = { canvas, ctx: canvas.getContext("2d"), texture, x: 0, y: 0, rowH: 0, index: sheet.pages.length }
    sheet.pages.push(page)
  }
  const dx = page.x + 1, dy = page.y + 1
  const img = tex.image
  const pixels = platform.imagePixels?.(img)
  const padded = pixels ? paddedSprite(pixels, iw, ih) : null
  if (padded) page.ctx.putImageData(padded, dx - 1, dy - 1)
  else {
    page.ctx.drawImage(img, dx, dy)
    page.ctx.drawImage(img, 0, 0, iw, 1, dx, dy - 1, iw, 1)
    page.ctx.drawImage(img, 0, ih - 1, iw, 1, dx, dy + ih, iw, 1)
    page.ctx.drawImage(img, 0, 0, 1, ih, dx - 1, dy, 1, ih)
    page.ctx.drawImage(img, iw - 1, 0, 1, ih, dx + iw, dy, 1, ih)
  }
  if (tex.userData?.frames) {
    ;(page.texture.userData.regions ??= []).push({ x: dx, y: dy, w: iw, h: ih, name: tex.userData.name, order: tex.userData.order, frames: tex.userData.frames, times: tex.userData.times, interpolate: !!tex.userData.interpolate })
  }
  let subbed = false
  if (shared.renderer) {
    try {
      let sub = padded
      if (!sub) {
        sub = new Canvas(cw, ch)
        const sctx = sub.getContext("2d")
        sctx.drawImage(img, 1, 1)
        sctx.drawImage(img, 0, 0, iw, 1, 1, 0, iw, 1)
        sctx.drawImage(img, 0, ih - 1, iw, 1, 1, ih + 1, iw, 1)
        sctx.drawImage(img, 0, 0, 1, ih, 0, 1, 1, ih)
        sctx.drawImage(img, iw - 1, 0, 1, ih, iw + 1, 1, 1, ih)
      }
      subbed = subUpload(shared.renderer, page.texture, sub, dx - 1, dy - 1)
    } catch {}
  }
  if (!subbed) page.texture.needsUpdate = true
  page.x += cw
  page.rowH = Math.max(page.rowH, ch)
  r = { ai: page.index, x: dx, y: dy, w: iw, h: ih, serial: ++shared.serial }
  sheet.rects.set(key, r)
  return r
}

const tiledCache = new Map()
const TILED_CACHE_BYTES = 64 * 1024 * 1024
let tiledBytes = 0
function tiledSub(srcImg, key, sub, ur, vr) {
  const k = key + "|" + ur + "x" + vr
  let c = tiledCache.get(k)
  if (c) {
    tiledCache.delete(k)
    tiledCache.set(k, c)
    return c
  }
  const px = platform.imageFromPixels ? pixelData(srcImg) : null
  if (px) {
    const W = sub.sw * ur, rowBytes = sub.sw * 4, out = new Uint8ClampedArray(W * sub.sh * vr * 4)
    for (let row = 0; row < sub.sh; row++) {
      const from = ((sub.sy + row) * srcImg.width + sub.sx) * 4, line = px.subarray(from, from + rowBytes)
      for (let j = 0; j < vr; j++) {
        const to = (j * sub.sh + row) * W * 4
        for (let i = 0; i < ur; i++) out.set(line, to + i * rowBytes)
      }
    }
    c = platform.pixelImage(out, W, sub.sh * vr)
  } else {
    c = new Canvas(sub.sw * ur, sub.sh * vr)
    const ctx = c.getContext("2d")
    for (let j = 0; j < vr; j++) for (let i = 0; i < ur; i++) ctx.drawImage(srcImg, sub.sx, sub.sy, sub.sw, sub.sh, i * sub.sw, j * sub.sh, sub.sw, sub.sh)
  }
  texHash.set(c, k + "_" + c.width + "x" + c.height)
  tiledCache.set(k, c)
  tiledBytes += c.width * c.height * 4
  for (const [old, img] of tiledCache) {
    if (tiledBytes <= TILED_CACHE_BYTES || old === k) break
    tiledCache.delete(old)
    tiledBytes -= img.width * img.height * 4
  }
  return c
}

function billboardHook(entries) {
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), flip = new THREE.Quaternion(0, 1, 0, 0), m = new THREE.Matrix4(), inv = new THREE.Matrix4()
  return function (renderer, scene, camera) {
    inv.copy(this.matrixWorld).invert()
    camera.getWorldQuaternion(quat).multiply(flip)
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      pos.copy(e.pos).applyMatrix4(this.matrixWorld)
      this.setMatrixAt(i, m.compose(pos, quat, e.scale).premultiply(inv))
    }
    this.instanceMatrix.needsUpdate = true
  }
}

function dynamicHook(entries) {
  const m = new THREE.Matrix4(), inv = new THREE.Matrix4()
  let inited = false
  return function (renderer, scene, camera) {
    inv.copy(this.matrixWorld).invert()
    let any = !inited
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (!dynamicFrame(e.root, renderer, camera) && inited) continue
      this.setMatrixAt(i, m.multiplyMatrices(e.parent.matrixWorld, e.local).premultiply(inv))
      any = true
    }
    if (any) this.instanceMatrix.needsUpdate = true
    inited = true
  }
}

function batchedHook(slots, baseBeforeRender) {
  const m = new THREE.Matrix4(), inv = new THREE.Matrix4()
  let inited = false
  return function (renderer, scene, camera, geometry, material, grp) {
    inv.copy(this.matrixWorld).invert()
    for (const s of slots) {
      if (!dynamicFrame(s.e.root, renderer, camera) && inited) continue
      this.setMatrixAt(s.id, m.multiplyMatrices(s.e.parent.matrixWorld, s.e.local).premultiply(inv))
    }
    inited = true
    baseBeforeRender.call(this, renderer, scene, camera, geometry, material, grp)
  }
}

function optimizedHandle({ group, drawCalls, tris, created, sorter }) {
  return {
    group,
    drawCalls,
    tris,
    atlasTextures: created.textures,
    sortTranslucent: camera => sorter.sort(camera),
    dispose() {
      if (this.__disposed) return
      this.__disposed = true
      sorter.detach()
      group.traverse(o => { if (o.isMesh) { try { o.geometry.dispose() } catch {} if (o.isInstancedMesh || o.isBatchedMesh) { try { o.dispose() } catch {} } } })
      for (const g of created.geometries) { try { g.dispose() } catch {} }
      for (const m of created.materials) { try { m.dispose() } catch {} }
      for (const e of created.atlasEntries) { try { releaseAtlas(e) } catch {} }
      for (const t of created.lookups) { try { t.dispose() } catch {} }
      group.removeFromParent()
    }
  }
}

export async function optimizeScene(placements, opts = {}) {
  if (!Array.isArray(placements)) throw new Error("optimizeScene requires an array of placements")
  const n = placements.length
  const groups = [], gi = new Int32Array(n), pos = new Float64Array(n * 3), culls = [], ci = new Int32Array(n)
  const groupIds = new Map(), cullIds = new Map()
  for (let i = 0; i < n; i++) {
    const p = placements[i]
    gi[i] = ci[i] = -1
    if (!p.group) continue
    let g = groupIds.get(p.group)
    if (g === undefined) groupIds.set(p.group, g = groups.push(p.group) - 1)
    gi[i] = g
    pos[i * 3] = p.pos[0]
    pos[i * 3 + 1] = p.pos[1]
    pos[i * 3 + 2] = p.pos[2]
    if (p.cull) {
      let c = cullIds.get(p.cull)
      if (c === undefined) cullIds.set(p.cull, c = culls.push(p.cull) - 1)
      ci[i] = c
    }
  }
  return optimizePlacements({ n, groups, gi, pos, culls, ci }, opts)
}

export async function optimizePlacements({ n: placeCount, groups, gi: placeGroup, pos: P, culls, ci: placeCull }, opts = {}) {
  await wasmReady()
  const shared = opts.sharedAtlas ?? null
  let maxAtlasSize = opts.maxAtlas
  const maxAtlas = () => maxAtlasSize ??= detectMaxAtlas()
  const cutoff = opts.translucency
  const onProgress = opts.onProgress
  const shouldCancel = opts.shouldCancel

  const sliceMs = opts.sliceMs ?? 40
  let sliceT = performance.now()
  async function breathe() {
    if (performance.now() - sliceT < sliceMs) return
    await nextTask()
    sliceT = performance.now()
  }

  let progBase = 0, progSpan = 0
  function stage(span) { progBase += progSpan; progSpan = span }
  const report = f => onProgress?.(Math.round(progBase + Math.min(f, 1) * progSpan), 10000)

  const atlasGroups = new Map()
  const anims = new Map(), animTexId = new Map()
  const tdata = new Map()
  const frozenSheet = shared?.frozen ? shared.sheets.get("*") : null
  const scanKey = (!shared ? "n" : !shared.frozen ? "s" : frozenSheet ? "f" + sheetId(frozenSheet) : "f") + "\0" + JSON.stringify(cutoff ?? null)

  function registerAnim(mat, tex) {
    const id = tex ?? mat
    if (!animTexId.has(id)) animTexId.set(id, animTexId.size)
    const key = matSignature(mat) + "|a" + animTexId.get(id)
    if (!anims.has(key)) {
      const tr = mat.userData?.glint ? true : tex ? isTranslucent(tex, cutoff) : false
      if (tr && !mat.transparent) {
        mat.transparent = true
        mat.depthWrite = false
      }
      anims.set(key, { material: mat, acc: makeAcc() })
    }
    return key
  }
  function registerAtlas(mat, tex, sig, translucent) {
    let grp = atlasGroups.get(sig)
    if (!grp) atlasGroups.set(sig, grp = { textures: new Set(), repMat: mat, translucent })
    grp.textures.add(tex)
  }

  if (shared?.frozen && shared.requestSpace) {
    const sheet = shared.sheets.get("*")
    if (sheet) {
      const miss = new Map()
      for (const g of groups) {
        g.traverse(o => {
          if (!o.isMesh) return
          for (const mat of [].concat(o.material)) {
            const tex = mat && matMap(mat)
            if (!tex?.image || mat.userData?.glint) continue
            if (tex.wrapS === THREE.RepeatWrapping || tex.wrapT === THREE.RepeatWrapping) continue
            const k = hashTexture(tex)
            if (!sheet.rects.has(k) && !miss.has(k)) miss.set(k, tex)
          }
        })
      }
      if (miss.size) {
        const res = await Promise.resolve(shared.requestSpace(Array.from(miss, ([key, t]) => ({
          key, image: t.image, w: t.image.width, h: t.image.height,
          frames: t.userData?.frames ?? null, times: t.userData?.times ?? null, interpolate: !!t.userData?.interpolate
        })))).catch(() => null)
        if (res) {
          for (const [key, r] of res.rects) sheet.rects.set(key, r)
          while (sheet.pages.length < res.pages) sheet.pages.push({ canvas: null, ctx: null, texture: new THREE.Texture(), x: 0, y: shared.size, rowH: 0, index: sheet.pages.length })
        }
      }
    }
  }

  stage(500)
  const scanOrder = []
  const scanSeen = new Uint8Array(groups.length)
  for (let i = 0; i < placeCount; i++) {
    const g = placeGroup[i]
    if (g < 0 || scanSeen[g]) continue
    scanSeen[g] = 1
    scanOrder.push(g)
  }
  let ti = 0
  for (const gid of scanOrder) {
    ti++
    const tmpl = groups[gid]
    if (!tmpl || tdata.has(tmpl)) continue
    const source = tmpl.__templateSource
    const cachedScan = source?.__scanCache?.get(scanKey)
    if (cachedScan) {
      const nodes = []
      tmpl.traverse(o => nodes.push(o))
      const nodeMats = ni => [].concat(nodes[ni].material)
      const animKeys = cachedScan.regs.map(r => {
        const mat = nodeMats(r.ni)[r.mi]
        if (r.kind === 1) return registerAnim(mat, matMap(mat))
        registerAtlas(mat, r.tex, r.sig, r.translucent)
        return null
      })
      const meshes = cachedScan.meshes.map(m => ({
        geo: nodes[m.ni].geometry,
        matrix: m.matrix,
        faces: m.faces.map(fc => {
          if (fc.kind === 1) return { start: fc.start, count: fc.count, animKey: animKeys[fc.ri], cull: fc.cull }
          return { start: fc.start, count: fc.count, tex: fc.tex, cull: fc.cull, sig: fc.sig, fd: fc.fd }
        })
      }))
      const merge = cachedScan.merge.map(m => ({ ...m.f, mat: nodeMats(m.ni)[m.mi], cid: undefined }))
      const billboards = cachedScan.billboards.map(b => ({ geo: nodes[b.ni].geometry, material: nodes[b.ni].material, matrix: b.matrix }))
      const dynamics = cachedScan.dynamics.map(d => ({ node: nodes[d.ni], parentMatrix: d.parentMatrix }))
      const lines = (cachedScan.lines ?? []).map(l => ({ geo: nodes[l.ni].geometry, material: nodes[l.ni].material, matrix: l.matrix }))
      tdata.set(tmpl, { merge, meshes, billboards, dynamics, lines })
      report(ti / scanOrder.length)
      await breathe()
      if (shouldCancel?.()) return null
      continue
    }
    tmpl.updateMatrixWorld(true)
    const nodes = []
    tmpl.traverse(o => nodes.push(o))
    const nodeIdx = new Map(nodes.map((n, i) => [n, i]))
    const rec = { meshes: [], merge: [], billboards: [], dynamics: [], lines: [], regs: [] }
    const recMesh = new Map()
    const flats = [], meshMap = new Map(), billboards = [], dynamics = [], lines = []
    for (const o of nodes) {
      if (o.userData?.dynamic) {
        const parentMatrix = (o.parent?.matrixWorld ?? o.matrixWorld).clone()
        dynamics.push({ node: o, parentMatrix })
        rec.dynamics.push({ ni: nodeIdx.get(o), parentMatrix })
      }
    }
    const inPart = o => {
      let part = false
      for (let n = o; n && n !== tmpl; n = n.parent) {
        if (n.name?.startsWith("part:")) part = true
        if (n.userData?.dynamic) return part
      }
      return false
    }
    function atlasFace(o, face, fc) {
      let m = meshMap.get(o)
      if (!m) {
        const matrix = o.matrixWorld.clone()
        meshMap.set(o, m = { geo: o.geometry, matrix, faces: [] })
        recMesh.set(o, m.rec = { ni: nodeIdx.get(o), matrix, faces: [] })
      }
      m.faces.push(face)
      recMesh.get(o).faces.push(fc)
    }
    function toAtlas(mat, tex, face) {
      const translucent = isTranslucent(tex, cutoff)
      const sig = translucent ? atlasSigs(mat).translucent : atlasSigs(mat).opaque
      registerAtlas(mat, tex, sig, translucent)
      return { ...face, sig, fd: faceDataOf(mat), translucent }
    }
    for (const o of nodes) {
      if (o.isLineSegments) {
        if (inPart(o)) continue
        const matrix = o.matrixWorld.clone()
        lines.push({ geo: o.geometry, material: o.material, matrix })
        rec.lines.push({ ni: nodeIdx.get(o), matrix })
        continue
      }
      if (!o.isMesh || inPart(o)) continue
      if (o.userData.billboard) {
        const matrix = o.matrixWorld.clone()
        billboards.push({ geo: o.geometry, material: o.material, matrix })
        rec.billboards.push({ ni: nodeIdx.get(o), matrix })
        continue
      }
      const geo = o.geometry, mats = [].concat(o.material)
      const nm = new THREE.Matrix3().getNormalMatrix(o.matrixWorld)
      const gs = geo.groups.length ? geo.groups : [{ start: 0, count: geo.index.count, materialIndex: 0 }]
      for (const g of gs) {
        const mat = mats[g.materialIndex]
        if (!mat || mat.visible === false) continue
        const tex = matMap(mat)
        if (!tex && !matAnimated(mat)) continue
        const cull = o.userData.cullface?.[g.materialIndex] ?? null
        const offAtlas = shared?.frozen && (!tex || !shared.sheets.get("*")?.rects.has(hashTexture(tex)))
        const tiled = !!shared && !!mat.userData?.atlasTiling
        if (matAnimated(mat) || offAtlas) {
          if (!offAtlas && tex?.userData?.frames && !mat.userData?.glint) {
            const fls = tiled ? extractFlats(geo, g, o.matrixWorld, nm, tex, mat, cull, true) : null
            if (fls) {
              for (const fl of fls) flats.push({ flat: fl.flat, o, mi: g.materialIndex, mat, tex, start: fl.start, count: fl.count, cull })
              continue
            }
            const face = toAtlas(mat, tex, { start: g.start, count: g.count, tex, cull })
            rec.regs.push({ kind: 0, ni: nodeIdx.get(o), mi: g.materialIndex, tex, sig: face.sig, translucent: face.translucent })
            atlasFace(o, face, { kind: 0, start: g.start, count: g.count, tex, cull, sig: face.sig, fd: face.fd })
            continue
          }
          const ri = rec.regs.length
          rec.regs.push({ kind: 1, ni: nodeIdx.get(o), mi: g.materialIndex })
          const key = registerAnim(mat, tex)
          atlasFace(o, { start: g.start, count: g.count, animKey: key, cull }, { kind: 1, ri, start: g.start, count: g.count, cull })
          continue
        }
        const fls = shared && !tiled ? null : extractFlats(geo, g, o.matrixWorld, nm, tex, mat, cull, tiled)
        if (fls) for (const fl of fls) flats.push({ flat: fl.flat, o, mi: g.materialIndex, mat, tex, start: fl.start, count: fl.count, cull })
        else {
          const face = toAtlas(mat, tex, { start: g.start, count: g.count, tex, cull })
          rec.regs.push({ kind: 0, ni: nodeIdx.get(o), mi: g.materialIndex, tex, sig: face.sig, translucent: face.translucent })
          atlasFace(o, face, { kind: 0, start: g.start, count: g.count, tex, cull, sig: face.sig, fd: face.fd })
        }
      }
    }
    const byPlane = new Map()
    for (const c of flats) {
      const f = c.flat, k = f.na + "|" + f.ns + "|" + Math.round(f.pc * 100)
      let arr = byPlane.get(k)
      if (!arr) byPlane.set(k, arr = [])
      arr.push(c)
    }
    const demote = new Set()
    for (const arr of byPlane.values()) for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const A = arr[i], B = arr[j]
      if (!rectsOverlap(A.flat, B.flat) || A.mat.side + B.mat.side === 1) continue
      if (A.flat.sig !== B.flat.sig || A.tex !== B.tex || !isOpaque(A.tex) || !isOpaque(B.tex)) { demote.add(A); demote.add(B) }
    }
    const merge = []
    for (const c of flats) {
      if (demote.has(c)) {
        const face = toAtlas(c.mat, c.tex, { start: c.start, count: c.count, tex: c.tex, cull: c.cull })
        rec.regs.push({ kind: 0, ni: nodeIdx.get(c.o), mi: c.mi, tex: c.tex, sig: face.sig, translucent: face.translucent })
        atlasFace(c.o, face, { kind: 0, start: c.start, count: c.count, tex: c.tex, cull: c.cull, sig: face.sig, fd: face.fd })
      } else {
        merge.push(c.flat)
        const { mat, ...rest } = c.flat
        rec.merge.push({ ni: nodeIdx.get(c.o), mi: c.mi, f: rest })
      }
    }
    for (const m of meshMap.values()) rec.meshes.push(m.rec)
    ;((source ?? tmpl).__scanCache ??= new Map()).set(scanKey, rec)
    tdata.set(tmpl, { merge, meshes: Array.from(meshMap.values()), billboards, dynamics, lines })
    report(ti / scanOrder.length)
    await breathe()
    if (shouldCancel?.()) return null
  }

  const _primeCam = new THREE.Object3D()
  const groupTd = groups.map(g => tdata.get(g))
  for (const td of tdata.values()) {
    let bits = 0, free = false
    for (const f of td.merge) {
      f.cb = f.cull ? cullBit(f.cull) : 0
      if (f.cb === 0 || f.cb === 64) free = true
      else bits |= f.cb
    }
    td.mergeBits = bits
    td.mergeFree = free
    td.simple = !td.lines.length && !td.billboards.length && !td.dynamics.length
    td.inert = td.simple && !td.meshes.length
  }
  const cullMask = Int32Array.from(culls, cullMaskOf)
  const grids = []
  const cellRuns = new GrowI32()
  const gridIndex = new GridTable()
  const gridNames = new Map()
  const cellIds = new Map()
  stage(800)
  const base = [Infinity, Infinity, Infinity]
  for (let i = 0; i < placeCount; i++) {
    if (placeGroup[i] < 0) continue
    for (let a = 0; a < 3; a++) if (P[i * 3 + a] < base[a]) base[a] = P[i * 3 + a]
  }
  for (let a = 0; a < 3; a++) base[a] = Number.isFinite(base[a]) ? Math.floor(base[a]) : 0
  const cellOrients = shared ? new GrowU8() : null
  const cellScan = { placeGroup, placeCull, groupTd, culls, cullMask, P, base, cellIds, gridIndex, gridNames, grids, cellRuns, cellOrients, mixed: false }
  for (let i = 0; i < placeCount; i += 4096) {
    const to = Math.min(i + 4096, placeCount)
    scanCells(cellScan, i, to)
    report(to / placeCount)
    await breathe()
    if (shouldCancel?.()) return null
  }
  const cellData = cellRuns.data()
  let rectRun = !grids.length ? new Int32Array(0) : sparseCells(cellData, grids.length) ? null : greedyMeshFast(cellData, grids.length)
  if (!rectRun) rectRun = greedyMeshJs(cellData, grids.length)
  settleWasm()
  // where each grid's rectangles start, the run is grouped and ascending
  const rectAt = new Int32Array(grids.length + 1).fill(rectRun.length)
  for (let i = rectRun.length - 5; i >= 0; i -= 5) rectAt[rectRun[i]] = i
  for (let g = grids.length - 1; g >= 0; g--) if (rectAt[g] === rectRun.length) rectAt[g] = rectAt[g + 1]

  const greedyQuads = []
  const tiles = new Map()
  const maxTile = grids.length && !shared ? Math.max(64, maxAtlas() >> 5) : 0
  stage(2500)
  const quadOrients = shared ? new GrowU8() : null
  const quadScan = { grids, rectRun, rectAt, maxTile, tiles, atlasGroups, cutoff, greedyQuads, quadOrients, cellOrients, orientIndex: cellScan.mixed ? indexOrients(grids, cellData) : null }
  for (let i = 0; i < grids.length; i += 1024) {
    const to = Math.min(i + 1024, grids.length)
    splitQuads(quadScan, i, to)
    report(to / grids.length)
    await breathe()
    if (shouldCancel?.()) return null
  }
  for (const tile of tiles.values()) {
    const tf = tile.f, img = tf.tex.image, sub = tf.sub
    tile.direct = tf.tiled || (tile.ur === 1 && tile.vr === 1)
    tile.pseudo = tile.direct ? tf.tex : { image: tiledSub(img, tile.content, sub, tile.ur, tile.vr), colorSpace: tf.tex.colorSpace }
    tile.grp.textures.add(tile.pseudo)
  }

  const atlases = new Map()
  const created = { textures: [], materials: [], atlasEntries: [], geometries: [], lookups: [] }
  stage(800)
  let ai = 0
  for (const [sig, grp] of atlasGroups) {
    report(++ai / atlasGroups.size)
    await breathe()
    if (shouldCancel?.()) return null
    if (shared) {
      let sheet
      const rects = new Map()
      if (shared.frozen) {
        sheet = shared.sheets.get("*")
        for (const t of grp.textures) rects.set(t, sheet.rects.get(hashTexture(t)))
      } else {
        const stitched = shared.sheets.get("*"), colorSpace = grp.textures.values().next().value.colorSpace ?? THREE.NoColorSpace
        sheet = stitched && (!stitched.pages.length || stitched.pages[0].texture.colorSpace === colorSpace) ? stitched : shared.sheets.get(sig)
        if (!sheet) shared.sheets.set(sig, sheet = { pages: [], rects: new Map() })
        for (const t of grp.textures) rects.set(t, await sharedLocate(shared, sheet, t))
        subFlush(shared.renderer)
      }
      const sizes = sheet.pages.map(() => ({ w: shared.size, h: shared.size }))
      const materials = sheet.pages.map(pg => {
        const m = grp.repMat.clone()
        if (m.uniforms) {
          m.uniforms.map.value = pg.texture
          for (const k of REBIND_UNIFORMS) {
            if (grp.repMat.uniforms[k]) m.uniforms[k] = grp.repMat.uniforms[k]
          }
          m.defines = { ...m.defines, FACE_ATTRS: "" }
        }
        else m.map = pg.texture
        if (grp.translucent && !m.transparent) {
          m.transparent = true
          m.depthWrite = false
        }
        created.materials.push(m)
        return m
      })
      atlases.set(sig, { rects, sizes, materials, accs: sheet.pages.map(makeAcc) })
      continue
    }
    const { atlases: ats, rects, sizes, entry } = await buildAtlas(Array.from(grp.textures), maxAtlas(), breathe, !!opts.release)
    const regionLists = ats.map(() => [])
    const claimed = new Set()
    for (const t of grp.textures) {
      if (!t.userData?.frames) continue
      const r = rects.get(t)
      const key = r.ai + ":" + r.x + "," + r.y
      if (claimed.has(key)) continue
      claimed.add(key)
      regionLists[r.ai].push({ x: r.x, y: r.y, w: r.w, h: r.h, frames: t.userData.frames, times: t.userData.times, interpolate: !!t.userData.interpolate })
    }
    regionLists.forEach((regions, i) => {
      if (regions.length) ats[i].userData.regions = regions
      else delete ats[i].userData.regions
      if (opts.release) ats[i].onUpdate = releaseImage
    })
    created.textures.push(...ats)
    created.atlasEntries.push(entry)
    const materials = ats.map(a => {
      const m = grp.repMat.clone()
      if (m.uniforms) {
        m.uniforms.map.value = a
        for (const k of REBIND_UNIFORMS) {
          if (grp.repMat.uniforms[k]) m.uniforms[k] = grp.repMat.uniforms[k]
        }
        m.defines = { ...m.defines, FACE_ATTRS: "" }
      }
      else m.map = a
      if (grp.translucent && !m.transparent) {
        m.transparent = true
        m.depthWrite = false
      }
      created.materials.push(m)
      return m
    })
    atlases.set(sig, { rects, sizes, materials, accs: ats.map(makeAcc) })
  }

  stage(3000)
  const blockT = new THREE.Matrix4(), full = new THREE.Matrix4(), nmat = new THREE.Matrix3()
  const dynKeys = new WeakMap()
  function dynBucketFor(geo, mat) {
    let byMat = dynKeys.get(geo)
    if (!byMat) dynKeys.set(geo, byMat = new Map())
    let bucket = byMat.get(mat)
    if (bucket) return bucket
    const key = geoHash(geo) + "|" + [].concat(mat).map(x => matSignature(x) + (matMap(x)?.uuid ?? "")).join(",")
    bucket = dynBuckets.get(key)
    if (!bucket) dynBuckets.set(key, bucket = { geometry: geo, material: mat, entries: [] })
    byMat.set(mat, bucket)
    return bucket
  }

  const dynamicInstances = [], dynBuckets = new Map(), bbBuckets = new Map(), lineBuckets = new Map()
  const dynPlans = new WeakMap()
  function dynPlanFor(node) {
    let plan = dynPlans.get(node)
    if (plan) return plan
    const proto = cloneInstance(node, true)
    const found = []
    proto.traverse(o => { if ((o.isMesh && !o.isSkinnedMesh) || o.isLineSegments) found.push(o) })
    const parts = []
    for (const m of found) {
      let inPart = false
      for (let n = m; n && n !== proto; n = n.parent) if (n.name?.startsWith("part:")) { inPart = true; break }
      if (m.isLineSegments) {
        if (!inPart) m.removeFromParent()
        continue
      }
      if (inPart) parts.push({ parent: m.parent, local: m.matrix.clone(), bucket: dynBucketFor(m.geometry, m.material) })
      m.removeFromParent()
    }
    const paths = new Map()
    const index = (o, path) => {
      paths.set(o, path)
      for (let i = 0; i < o.children.length; i++) index(o.children[i], path.concat(i))
    }
    index(proto, [])
    for (const pt of parts) {
      pt.path = paths.get(pt.parent)
      pt.parent = null
    }
    dynPlans.set(node, plan = { proto, parts })
    return plan
  }
  const touched = []
  const bakes = { buf: new Float64Array(4096), len: 0 }
  function planFor(td, cm, cull) {
    const plans = td.plans ??= new Map()
    let plan = plans.get(cm)
    if (plan !== undefined) return plan
    const faces = [], meshes = [], offs = [], need = new Map()
    for (const m of td.meshes) {
      for (const f of m.faces) {
        if (cm && f.cull && faceCulled(f, cm, cull)) continue
        let acc = f.acc
        if (acc === undefined) {
          if (f.animKey) { acc = anims.get(f.animKey).acc; f.rect = null; f.sw = 0; f.sh = 0 }
          else {
            const at = atlases.get(f.sig), rect = at.rects.get(f.tex), sz = at.sizes[rect.ai]
            acc = at.accs[rect.ai]
            f.rect = rect; f.sw = sz.w; f.sh = sz.h
          }
          f.acc = acc
        }
        let off = f.bake
        if (off === undefined) off = f.bake = bakeFace(bakes, m, f)
        faces.push(f)
        meshes.push(m)
        offs.push(off)
        const n = need.get(acc) ?? [acc, 0, 0]
        n[1] += f.count
        if (f.fd) n[2] += f.count
        need.set(acc, n)
      }
    }
    plan = { faces, meshes, offs: Int32Array.from(offs), need: Array.from(need.values()) }
    if (!(cm & 64)) plans.set(cm, plan)
    return plan
  }
  const bake = { placeGroup, placeCull, groupTd, culls, cullMask, P, bakes, planFor, placeExtras, blockT, full, nmat, touched }
  countBakes(bake, placeCount)
  for (const acc of touched) {
    acc.P.reserve(acc.P.length + acc.need * 3)
    acc.N.reserve(acc.N.length + acc.need * 3)
    acc.U.reserve(acc.U.length + acc.need * 2)
    acc.T.reserve(acc.T.length + acc.need * 3)
    if (acc.needF) acc.F.reserve(acc.F.length + acc.needF * 2)
    acc.need = 0
    acc.needF = 0
  }
  for (let i = 0; i < placeCount; i += 8192) {
    const to = Math.min(i + 8192, placeCount)
    bakeCells(bake, i, to)
    report(to / placeCount)
    await breathe()
    if (shouldCancel?.()) return null
  }
  function placeExtras(td, i) {
    const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2]
    blockT.makeTranslation(px * 16, py * 16, pz * 16)
    for (const l of td.lines ?? []) {
      const key = matSignature(l.material) + "|" + (l.material?.color?.getHexString?.() ?? "") + "|" + (l.material?.opacity ?? 1) + "|" + !!l.material?.transparent
      let bucket = lineBuckets.get(key)
      if (!bucket) lineBuckets.set(key, bucket = { material: l.material, positions: [] })
      full.multiplyMatrices(blockT, l.matrix)
      const src = l.geo.attributes.position
      const v = new THREE.Vector3()
      for (let i = 0; i < src.count; i++) {
        v.fromBufferAttribute(src, i).applyMatrix4(full)
        bucket.positions.push(v.x, v.y, v.z)
      }
    }
    for (const b of td.billboards) {
      const key = geoHash(b.geo) + "|" + [].concat(b.material).map(x => matSignature(x) + (matMap(x)?.uuid ?? "")).join(",")
      let bucket = bbBuckets.get(key)
      if (!bucket) bbBuckets.set(key, bucket = { geometry: b.geo, material: b.material, entries: [] })
      full.multiplyMatrices(blockT, b.matrix)
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3()
      full.decompose(pos, quat, scale)
      bucket.entries.push({ pos, scale })
    }
    for (const d of td.dynamics) {
      const holder = new THREE.Group()
      holder.matrixAutoUpdate = false
      holder.matrix.multiplyMatrices(blockT, d.parentMatrix)
      holder.matrixWorldNeedsUpdate = true
      const plan = dynPlanFor(d.node)
      const inst = cloneInstance(plan.proto, true)
      for (const pt of plan.parts) {
        let n = inst
        const path = pt.path
        for (let i = 0; i < path.length; i++) n = n.children[path[i]]
        pt.bucket.entries.push({ parent: n, local: pt.local, root: inst })
      }
      initDynamic(inst)
      holder.add(inst)
      dynamicInstances.push({ holder, object: inst, pos: [px, py, pz] })
    }
  }

  const packs = []
  for (const { materials, accs, sizes } of atlases.values()) for (let i = 0; i < accs.length; i++) packs.push({ acc: accs[i], material: materials[i], size: sizes[i] })
  for (const { material, acc } of anims.values()) packs.push({ acc, material })
  for (const tile of tiles.values()) {
    const at = atlases.get(tile.sig), rect = at.rects.get(tile.pseudo)
    tile.rect = rect
    tile.size = at.sizes[rect.ai]
    tile.acc = at.accs[rect.ai]
  }
  stage(900)
  for (let i = 0; i < packs.length; i++) {
    packs[i].acc.dedup = dedupMesh(packs[i].acc)
    report((i + 1) / packs.length)
    await breathe()
  }
  for (const q of greedyQuads) {
    if (!q.f.tiled) continue
    const acc = q.tile.acc
    acc.tiledQuads++
    acc.tiledCells += q.ca * q.cb
    if (q.oc !== MIXED) continue
    acc.lookupQuads++
    acc.lookupCells += q.ca * q.cb
  }
  const lookupStride = platform.webgl2?.() ? 1 : 4
  for (const { acc } of packs) {
    if (!acc.tiledQuads) continue
    const split = meshBytes(acc, acc.tiledQuads - acc.lookupQuads + acc.lookupCells, VERTEX_BYTES + TILE_BYTES)
    const looked = acc.lookupQuads ? meshBytes(acc, acc.tiledQuads, VERTEX_BYTES + TILE_BYTES + LOOKUP_VERTEX_BYTES) + acc.lookupCells * lookupStride : Infinity
    acc.tiled = Math.min(split, looked) <= meshBytes(acc, acc.tiledCells, VERTEX_BYTES)
    acc.lookup = acc.tiled && looked < split
  }
  const lookup = quadOrients?.length ? packLookup(greedyQuads, quadOrients.a, lookupStride, !!opts.release) : null
  if (lookup) created.lookups.push(lookup.texture)
  for (const q of greedyQuads) {
    const f = q.f, acc = q.tile.acc
    if (!f.layout) {
      f.layout = quadLayout(f)
      f.fd = faceDataOf(f.mat)
      f.fdBytes = !f.fd || byteFaceData(f.fd[0], f.fd[1])
    }
    const count = f.tiled && (!acc.tiled || (q.oc === MIXED && q.lx < 0)) ? q.ca * q.cb : 1
    acc.quads += count
    acc.quadVerts += f.layout.corners.length * count
    if (f.fd) acc.quadFaceData = true
    if (!f.fdBytes) acc.quadBytes = false
  }
  for (const { acc } of packs) {
    acc.out = packMesh(acc)
    acc.P = acc.N = acc.U = acc.T = acc.F = acc.dedup = null
  }

  stage(1500)
  for (let i = 0; i < greedyQuads.length; i += 4096) {
    emitQuads(greedyQuads, i, Math.min(i + 4096, greedyQuads.length), quadOrients?.a)
    report(i / greedyQuads.length)
    await breathe()
    if (shouldCancel?.()) return null
  }

  const group = new THREE.Group()
  let drawCalls = 0, tris = 0
  function addMesh(packed, material) {
    if (!packed.index.length) return
    const geo = new THREE.BufferGeometry()
    const pd = packed.position
    geo.setAttribute("position", new THREE.BufferAttribute(pd, 3))
    geo.setAttribute("normal", new THREE.BufferAttribute(packed.normal, 3, true))
    geo.setAttribute("uv", new THREE.BufferAttribute(packed.uv, 2))
    geo.setAttribute("color", new THREE.BufferAttribute(packed.color, 3, true))
    if (packed.faceData) geo.setAttribute("faceData", new THREE.BufferAttribute(packed.faceData, 2))
    if (packed.tileRect) geo.setAttribute("tileRect", new THREE.BufferAttribute(packed.tileRect, 4))
    if (packed.tileLookup) geo.setAttribute("tileLookup", new THREE.BufferAttribute(packed.tileLookup, 2))
    geo.setIndex(new THREE.BufferAttribute(packed.index, 1))
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let i = 0; i < pd.length; i += 3) {
      const x = pd[i], y = pd[i + 1], z = pd[i + 2]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ))
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
      Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2) / 2
    )
    if (opts.release && !material.transparent) {
      for (const a of Object.values(geo.attributes)) a.onUpload(releaseArray)
      geo.index.onUpload(releaseArray)
    }
    const mesh = new THREE.Mesh(geo, material)
    if (material.transparent) mesh.renderOrder = material.side === THREE.BackSide ? 0 : 1
    group.add(mesh)
    drawCalls++
    tris += packed.index.length / 3
  }
  for (const { acc, material, size } of packs) {
    if (acc.out.tileRect) {
      material.defines = { ...material.defines, TILED: "" }
      material.uniforms.atlasSize = { value: new THREE.Vector2(size.w, size.h) }
    }
    if (acc.out.tileLookup) {
      material.defines.TILE_LOOKUP = ""
      material.uniforms.tileLookupMap = { value: lookup.texture }
      material.uniforms.tileLookupSize = { value: lookup.size }
    }
    addMesh(acc.out, material)
  }
  for (const bucket of lineBuckets.values()) {
    if (!bucket.positions.length) continue
    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(bucket.positions), 3))
    created.geometries.push(geo)
    const seg = new THREE.LineSegments(geo, bucket.material)
    seg.userData.outline = true
    group.add(seg)
    drawCalls++
  }

  const primers = []
  for (const bucket of bbBuckets.values()) {
    const entries = bucket.entries
    const merged = mergeInstanceSource(bucket.geometry, bucket.material)
    if (!merged) continue
    const im = new THREE.InstancedMesh(merged.geometry, merged.material, entries.length)
    im.frustumCulled = false
    im.userData.billboard = true
    im.userData.billboardEntries = entries
    setInstanceHook(im, billboardHook(entries))
    primers.push(() => im.onBeforeRender(null, null, _primeCam))
    group.add(im)
    drawCalls++
    tris += (merged.geometry.index?.count ?? merged.geometry.attributes.position?.count ?? 0) / 3 * entries.length
  }
  for (const d of dynamicInstances) group.add(d.holder)
  const _dynM = new THREE.Matrix4(), _dynInv = new THREE.Matrix4()
  const canBatch = opts.batchDynamics !== false && parseInt(THREE.REVISION) >= 159 && typeof THREE.BatchedMesh === "function" && platform.batchedMesh !== false
  const batchGroups = new Map()
  for (const bucket of dynBuckets.values()) {
    const entries = bucket.entries
    const merged = mergeInstanceSource(bucket.geometry, bucket.material)
    if (!merged) continue
    if (canBatch && !Array.isArray(merged.material)) {
      const key = matSignature(merged.material) + "|" + (matMap(merged.material)?.uuid ?? "")
      let g = batchGroups.get(key)
      if (!g) batchGroups.set(key, g = { material: merged.material, parts: [] })
      g.parts.push({ geometry: merged.geometry, entries })
      continue
    }
    const im = new THREE.InstancedMesh(merged.geometry, merged.material, entries.length)
    im.frustumCulled = false
    setInstanceHook(im, dynamicHook(entries))
    primers.push(() => {
      _dynInv.copy(im.matrixWorld).invert()
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        primeDynamic(e.root)
        im.setMatrixAt(i, _dynM.multiplyMatrices(e.parent.matrixWorld, e.local).premultiply(_dynInv))
      }
      im.instanceMatrix.needsUpdate = true
    })
    group.add(im)
    drawCalls++
    tris += (merged.geometry.index?.count ?? merged.geometry.attributes.position?.count ?? 0) / 3 * entries.length
  }
  for (const g of batchGroups.values()) {
    let instances = 0, verts = 0, indices = 0
    for (const p of g.parts) {
      const v = p.geometry.attributes.position.count
      instances += p.entries.length
      verts += v * p.entries.length
      indices += (p.geometry.index?.count ?? v) * p.entries.length
    }
    const bm = new THREE.BatchedMesh(instances, verts, indices, g.material)
    bm.frustumCulled = false
    if ("perObjectFrustumCulled" in bm) bm.perObjectFrustumCulled = false
    if ("sortObjects" in bm) bm.sortObjects = false
    const slots = []
    for (const p of g.parts) {
      const gid = bm.addInstance ? bm.addGeometry(p.geometry) : null
      for (const e of p.entries) slots.push({ id: bm.addInstance ? bm.addInstance(gid) : bm.addGeometry(p.geometry), e, geometry: p.geometry })
    }
    bm.userData.batchSlots = slots
    bm.onBeforeRender = batchedHook(slots, bm.onBeforeRender)
    primers.push(() => {
      _dynInv.copy(bm.matrixWorld).invert()
      for (const s of slots) {
        primeDynamic(s.e.root)
        bm.setMatrixAt(s.id, _dynM.multiplyMatrices(s.e.parent.matrixWorld, s.e.local).premultiply(_dynInv))
      }
    })
    group.add(bm)
    drawCalls++
    tris += indices / 3
  }
  if (primers.length) {
    group.updateMatrixWorld(true)
    for (const prime of primers) prime()
  }
  onProgress?.(10000, 10000)

  const sorter = createTranslucentSorter(group, { resortDistance: opts.resortDistance })

  return optimizedHandle({ group, drawCalls, tris, created, sorter })
}
