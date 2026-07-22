import { THREE, Canvas, loadTexture, platform } from "./platform.js"
import { subUpload, subFlush } from "./subtex.js"
import { initDynamic, dynamicFrame, primeDynamic, REBIND_UNIFORMS } from "./models.js"
import { sortTranslucent } from "./sorting.js"

const nextTask = globalThis.scheduler?.yield
  ? () => scheduler.yield()
  : () => new Promise(r => {
    const c = new MessageChannel()
    c.port1.onmessage = () => { c.port1.close(); r() }
    c.port2.postMessage(0)
  })

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

function atlasSignature(m) {
  if (!m.uniforms) return matSignature(m)
  const u = m.uniforms
  return ["shader", m.side, u.d0?.value, u.d1?.value, u.ambient?.value,
    u.light0?.value?.toArray().join(","), u.light1?.value?.toArray().join(","),
    u.blockLightTint?.value?.toArray().join(","), u.skyLightColor?.value?.toArray().join(","), u.ambientColor?.value?.toArray().join(","),
    u.skyLightFactor?.value, u.brightness?.value, u.shadePos?.value?.toArray().join(","), u.shadeNeg?.value?.toArray().join(","), u.worldShade?.value].join("|")
}

function faceDataOf(m) {
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

function matSignature(m) {
  if (m.uniforms) {
    const u = m.uniforms
    return ["shader", m.side, u.shadeEnabled?.value, u.shadeOverride?.value?.toArray().join(","), u.d0?.value, u.d1?.value, u.ambient?.value,
      u.light0?.value?.toArray().join(","), u.light1?.value?.toArray().join(","), u.emission?.value,
      u.blockLightTint?.value?.toArray().join(","), u.skyLightColor?.value?.toArray().join(","), u.ambientColor?.value?.toArray().join(","),
      u.skyLightFactor?.value, u.brightness?.value, u.shadePos?.value?.toArray().join(","), u.shadeNeg?.value?.toArray().join(","), u.aoEnabled?.value].join("|")
  }
  return [m.type, m.side].join("|")
}

let _pixelCanvas = null, _pixelCtx = null
function pixelData(img) {
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
  if (tex.userData?.frames) {
    let ah = animHash.get(tex)
    if (ah === undefined) animHash.set(tex, ah = `anim${++animHashId}_${tex.image.width}x${tex.image.height}`)
    return ah
  }
  const sh = tex.userData?.srcHash
  if (sh) return sh
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

let _ef = null
function extractFlat(geo, grp, mw, nm, tex, mat, cull) {
  _ef ??= new THREE.Vector3()
  const pos = geo.attributes.position, uv = geo.attributes.uv, nrm = geo.attributes.normal, idx = geo.index
  if (!uv) return null
  _ef.fromBufferAttribute(nrm, idx.getX(grp.start)).applyMatrix3(nm).normalize()
  const na = Math.abs(_ef.x) > 0.99 ? 0 : Math.abs(_ef.y) > 0.99 ? 1 : Math.abs(_ef.z) > 0.99 ? 2 : -1
  if (na < 0) return null
  const ns = _ef.getComponent(na) > 0 ? 1 : -1
  const [pa, pb] = [0, 1, 2].filter(a => a !== na)
  const P = []
  let pc = null
  for (let i = grp.start; i < grp.start + grp.count; i++) {
    const a = idx.getX(i)
    _ef.fromBufferAttribute(pos, a).applyMatrix4(mw)
    const cn = _ef.getComponent(na)
    if (pc === null) pc = cn
    else if (Math.abs(cn - pc) > 0.01) return null
    P.push({ a: _ef.getComponent(pa), b: _ef.getComponent(pb), u: uv.getX(a), v: uv.getY(a) })
  }
  const a0 = Math.min(...P.map(p => p.a)), a1 = Math.max(...P.map(p => p.a))
  const b0 = Math.min(...P.map(p => p.b)), b1 = Math.max(...P.map(p => p.b))
  const wa = a1 - a0, wb = b1 - b0
  if (wa < 0.01 || wb < 0.01) return null
  for (const p of P) if ((Math.abs(p.a - a0) > 0.01 && Math.abs(p.a - a1) > 0.01) || (Math.abs(p.b - b0) > 0.01 && Math.abs(p.b - b1) > 0.01)) return null
  const umin = Math.min(...P.map(p => p.u)), umax = Math.max(...P.map(p => p.u))
  const vmin = Math.min(...P.map(p => p.v)), vmax = Math.max(...P.map(p => p.v))
  if (umax - umin < 1e-4 || vmax - vmin < 1e-4) return null
  const c0 = P.find(p => Math.abs(p.a - a0) < 0.01)
  const c1 = P.find(p => Math.abs(p.a - a1) < 0.01 && Math.abs(p.b - c0.b) < 0.01)
  if (!c1) return null
  const uAxisIsPa = Math.abs(c1.u - c0.u) > Math.abs(c1.v - c0.v)
  const tw = tex.image.width, th = tex.image.height
  const sub = { sx: Math.round(umin * tw), sy: Math.round((1 - vmax) * th), sw: Math.round((umax - umin) * tw), sh: Math.round((vmax - vmin) * th) }
  if (sub.sw < 1 || sub.sh < 1) return null
  if (Math.abs(umin * tw - sub.sx) > 1e-3 || Math.abs((1 - vmax) * th - sub.sy) > 1e-3 || Math.abs((umax - umin) * tw - sub.sw) > 1e-3 || Math.abs((vmax - vmin) * th - sub.sh) > 1e-3) return null
  const verts = P.map(p => ({ ha: Math.abs(p.a - a1) < 0.01 ? 1 : 0, hb: Math.abs(p.b - b1) < 0.01 ? 1 : 0, u: (p.u - umin) / (umax - umin), v: (p.v - vmin) / (vmax - vmin) }))
  const srcHash = hashTexture(tex)
  const corners = {}
  for (const c of verts) corners[`${c.ha}${c.hb}`] = `${c.u.toFixed(2)},${c.v.toFixed(2)}`
  const orient = Object.keys(corners).sort().map(k => k + ":" + corners[k]).join("|")
  const cellKey = `${srcHash}:${sub.sx},${sub.sy},${sub.sw},${sub.sh}:${wa.toFixed(2)}x${wb.toFixed(2)}:${orient}:${faceDataOf(mat)?.join(",") ?? ""}`
  return { na, ns, pa, pb, pc, a0, b0, wa, wb, uAxisIsPa, sub, verts, sig: atlasSignature(mat), tex, mat, srcHash, cull, cellKey }
}

function extractFlats(geo, grp, mw, nm, tex, mat, cull) {
  if (grp.count % 6) return null
  const out = []
  for (let s = grp.start; s < grp.start + grp.count; s += 6) {
    const flat = extractFlat(geo, { start: s, count: 6 }, mw, nm, tex, mat, cull)
    if (!flat) return null
    out.push({ flat, start: s, count: 6 })
  }
  return out
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
  sweepAtlasCache()
}

async function buildAtlas(textures, maxAtlas, breathe) {
  const pad = 1
  const rep = new Map()
  for (const t of textures) { const h = hashTexture(t); if (!rep.has(h)) rep.set(h, t) }
  const colorSpace = textures[0].colorSpace ?? THREE.NoColorSpace
  const cacheKey = Array.from(rep.keys()).sort().join("|") + "\0" + maxAtlas + "\0" + colorSpace
  let entry = atlasCache.get(cacheKey)
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
  let ai = 0, x = 0, y = 0, rowH = 0
  const sizes = [{ w: 0, h: 0 }]
  for (const it of items) {
    const cw = it.w + pad * 2, ch = it.h + pad * 2
    if (x + cw > maxAtlas) { y += rowH; x = 0; rowH = 0 }
    if (y + ch > maxAtlas) { ai++; x = 0; y = 0; rowH = 0; sizes[ai] = { w: 0, h: 0 } }
    it.ai = ai; it.px = x; it.py = y
    x += cw; rowH = Math.max(rowH, ch)
    sizes[ai].w = Math.max(sizes[ai].w, x)
    sizes[ai].h = Math.max(sizes[ai].h, y + rowH)
  }
  const ctxs = sizes.map(s => new Canvas(s.w, s.h).getContext("2d"))
  const byHash = new Map()
  let drawn = 0
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
  const atlases = []
  for (const ctx of ctxs) {
    const a = await loadTexture(ctx.canvas)
    a.magFilter = a.minFilter = THREE.NearestFilter
    a.generateMipmaps = false
    a.colorSpace = colorSpace
    a.needsUpdate = true
    atlases.push(a)
  }
  const rects = new Map()
  for (const t of textures) rects.set(t, byHash.get(hashTexture(t)))
  entry = { atlases, sizes, byHash, users: 1, bytes: sizes.reduce((n, s) => n + s.w * s.h * 4, 0) }
  atlasCache.set(cacheKey, entry)
  sweepAtlasCache()
  return { atlases, rects, sizes, entry }
}

const GR_M = 1 << 25, GR_W = 67108864
const packCell = (i, j) => (j + GR_M) * GR_W + (i + GR_M)
function greedyRects(cellSet) {
  const done = new Set(), rects = []
  const coords = Float64Array.from(cellSet).sort()
  for (const v of coords) {
    if (done.has(v)) continue
    const im = v % GR_W, i0 = im - GR_M, j0 = (v - im) / GR_W - GR_M
    let a1 = i0
    while (cellSet.has(v + (a1 - i0 + 1)) && !done.has(v + (a1 - i0 + 1))) a1++
    let b1 = j0, grow = true
    while (grow) {
      const rowBase = v + (b1 + 1 - j0) * GR_W
      for (let x = 0; x <= a1 - i0; x++) { const c = rowBase + x; if (!cellSet.has(c) || done.has(c)) { grow = false; break } }
      if (grow) b1++
    }
    for (let y = 0; y <= b1 - j0; y++) for (let x = 0; x <= a1 - i0; x++) done.add(v + y * GR_W + x)
    rects.push([i0, a1, j0, b1])
  }
  return rects
}

class GrowF32 {
  constructor() { this.a = new Float32Array(4096); this.length = 0 }
  ensure(n) {
    if (this.length + n <= this.a.length) return
    let cap = this.a.length * 2
    while (cap < this.length + n) cap *= 2
    const b = new Float32Array(cap)
    b.set(this.a)
    this.a = b
  }
  push3(x, y, z) { this.ensure(3); const a = this.a, l = this.length; a[l] = x; a[l + 1] = y; a[l + 2] = z; this.length = l + 3 }
  push2(x, y) { this.ensure(2); const a = this.a, l = this.length; a[l] = x; a[l + 1] = y; this.length = l + 2 }
  data() { return this.a.length === this.length ? this.a : this.a.slice(0, this.length) }
}
const makeAcc = () => ({ P: new GrowF32(), N: new GrowF32(), U: new GrowF32(), F: new GrowF32() })

let _v = null, _n = null
function appendGroup(geo, start, count, mat, nmat, rect, W, H, acc, fd) {
  const idx = geo.index, pos = geo.attributes.position, nrm = geo.attributes.normal, uv = geo.attributes.uv
  if (idx.array && !pos.isInterleavedBufferAttribute && !nrm.isInterleavedBufferAttribute && !uv.isInterleavedBufferAttribute) {
    const ia = idx.array, pa = pos.array, na = nrm.array, ua = uv.array
    const m = mat.elements, e = nmat.elements
    const m0 = m[0], m1 = m[1], m2 = m[2], m4 = m[4], m5 = m[5], m6 = m[6], m8 = m[8], m9 = m[9], m10 = m[10], m12 = m[12], m13 = m[13], m14 = m[14]
    const e0 = e[0], e1 = e[1], e2 = e[2], e3 = e[3], e4 = e[4], e5 = e[5], e6 = e[6], e7 = e[7], e8 = e[8]
    const P = acc.P, N = acc.N, U = acc.U, F = acc.F
    P.ensure(count * 3); N.ensure(count * 3); U.ensure(count * 2)
    if (fd) F.ensure(count * 2)
    const Pa = P.a, Na = N.a, Ua = U.a, Fa = F.a
    let pl = P.length, nl = N.length, ul = U.length, fl = F.length
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
      if (fd) { Fa[fl] = fd[0]; Fa[fl + 1] = fd[1]; fl += 2 }
    }
    P.length = pl; N.length = nl; U.length = ul
    if (fd) F.length = fl
    return
  }
  _v ??= new THREE.Vector3()
  _n ??= new THREE.Vector3()
  for (let i = start; i < start + count; i++) {
    const a = idx.getX(i)
    _v.fromBufferAttribute(pos, a).applyMatrix4(mat)
    _n.fromBufferAttribute(nrm, a).applyMatrix3(nmat).normalize()
    const u = uv.getX(a), v = uv.getY(a)
    acc.P.push3(_v.x, _v.y, _v.z)
    acc.N.push3(_n.x, _n.y, _n.z)
    if (rect) acc.U.push2((rect.x + u * rect.w) / W, 1 - (rect.y + (1 - v) * rect.h) / H)
    else acc.U.push2(u, v)
    if (fd) acc.F.push2(fd[0], fd[1])
  }
}

export function createSharedAtlas(opts = {}) {
  return {
    size: opts.size ?? 2048,
    renderer: opts.renderer ?? null,
    serial: 0,
    sheets: new Map(),
    dispose() {
      for (const sheet of this.sheets.values()) {
        for (const page of sheet.pages) { try { page.texture.dispose() } catch {} }
      }
      this.sheets.clear()
    }
  }
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
  page.ctx.drawImage(img, dx, dy)
  page.ctx.drawImage(img, 0, 0, iw, 1, dx, dy - 1, iw, 1)
  page.ctx.drawImage(img, 0, ih - 1, iw, 1, dx, dy + ih, iw, 1)
  page.ctx.drawImage(img, 0, 0, 1, ih, dx - 1, dy, 1, ih)
  page.ctx.drawImage(img, iw - 1, 0, 1, ih, dx + iw, dy, 1, ih)
  if (tex.userData?.frames) {
    ;(page.texture.userData.regions ??= []).push({ x: dx, y: dy, w: iw, h: ih, frames: tex.userData.frames, times: tex.userData.times, interpolate: !!tex.userData.interpolate })
  }
  let subbed = false
  if (shared.renderer) {
    try {
      const sub = new Canvas(cw, ch)
      const sctx = sub.getContext("2d")
      sctx.drawImage(img, 1, 1)
      sctx.drawImage(img, 0, 0, iw, 1, 1, 0, iw, 1)
      sctx.drawImage(img, 0, ih - 1, iw, 1, 1, ih + 1, iw, 1)
      sctx.drawImage(img, 0, 0, 1, ih, 0, 1, 1, ih)
      sctx.drawImage(img, iw - 1, 0, 1, ih, iw + 1, 1, 1, ih)
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
function tiledSub(srcImg, key, sub, ur, vr) {
  const k = key + "|" + ur + "x" + vr
  let c = tiledCache.get(k)
  if (c) return c
  c = new Canvas(sub.sw * ur, sub.sh * vr)
  const ctx = c.getContext("2d")
  for (let j = 0; j < vr; j++) for (let i = 0; i < ur; i++) ctx.drawImage(srcImg, sub.sx, sub.sy, sub.sw, sub.sh, i * sub.sw, j * sub.sh, sub.sw, sub.sh)
  texHash.set(c, k + "_" + c.width + "x" + c.height)
  tiledCache.set(k, c)
  if (tiledCache.size > 4096) tiledCache.delete(tiledCache.keys().next().value)
  return c
}

export async function optimizeScene(placements, opts = {}) {
  if (!Array.isArray(placements)) throw new Error("optimizeScene requires an array of placements")
  const shared = opts.sharedAtlas ?? null
  const maxAtlas = opts.maxAtlas ?? detectMaxAtlas()
  const maxTile = Math.max(64, maxAtlas >> 5)
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
  const scanKey = (shared ? "s" : "n") + "\0" + JSON.stringify(cutoff ?? null)

  function registerAnim(mat, tex) {
    const id = tex ?? mat
    if (!animTexId.has(id)) animTexId.set(id, animTexId.size)
    const key = matSignature(mat) + "|a" + animTexId.get(id)
    if (!anims.has(key)) {
      const tr = mat.userData?.glint ? true : tex ? isTranslucent(tex, cutoff) : false
      mat.transparent = tr
      mat.depthWrite = !tr
      anims.set(key, { material: mat, acc: makeAcc() })
    }
    return key
  }
  function registerAtlas(mat, tex, sig, translucent) {
    let grp = atlasGroups.get(sig)
    if (!grp) atlasGroups.set(sig, grp = { textures: new Set(), repMat: mat, translucent })
    grp.textures.add(tex)
  }

  stage(500)
  let ti = 0
  for (const p of placements) {
    ti++
    if (!p.group || tdata.has(p.group)) continue
    const tmpl = p.group
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
      tdata.set(tmpl, { merge, meshes, billboards, dynamics })
      report(ti / placements.length)
      await breathe()
      if (shouldCancel?.()) return null
      continue
    }
    tmpl.updateMatrixWorld(true)
    const nodes = []
    tmpl.traverse(o => nodes.push(o))
    const nodeIdx = new Map(nodes.map((n, i) => [n, i]))
    const rec = { meshes: [], merge: [], billboards: [], dynamics: [], regs: [] }
    const recMesh = new Map()
    const flats = [], meshMap = new Map(), billboards = [], dynamics = []
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
      const sig = atlasSignature(mat) + (translucent ? "|T" : "|O")
      registerAtlas(mat, tex, sig, translucent)
      return { ...face, sig, fd: faceDataOf(mat), translucent }
    }
    for (const o of nodes) {
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
        if (matAnimated(mat)) {
          if (tex?.userData?.frames && !mat.userData?.glint) {
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
        const fls = shared ? null : extractFlats(geo, g, o.matrixWorld, nm, tex, mat, cull)
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
      if (!rectsOverlap(A.flat, B.flat)) continue
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
    ;(tmpl.__scanCache ??= new Map()).set(scanKey, rec)
    tdata.set(tmpl, { merge, meshes: Array.from(meshMap.values()), billboards, dynamics })
    report(ti / placements.length)
    await breathe()
    if (shouldCancel?.()) return null
  }

  const _primeCam = new THREE.Object3D()
  const grids = new Map()
  const cellIds = new Map()
  stage(800)
  let scanned = 0
  for (const p of placements) {
    if (++scanned % 4096 === 0) {
      report(scanned / placements.length)
      await breathe()
      if (shouldCancel?.()) return null
    }
    const td = tdata.get(p.group)
    if (!td) continue
    for (const f of td.merge) {
      if (f.cull && p.cull?.has(f.cull)) continue
      let cid = f.cid
      if (cid === undefined) {
        cid = cellIds.get(f.cellKey)
        if (cid === undefined) cellIds.set(f.cellKey, cid = cellIds.size)
        f.cid = cid
      }
      const wpc = f.pc + p.pos[f.na] * 16
      const wa0 = f.a0 + p.pos[f.pa] * 16, wb0 = f.b0 + p.pos[f.pb] * 16
      const phaseA = ((wa0 % f.wa) + f.wa) % f.wa, phaseB = ((wb0 % f.wb) + f.wb) % f.wb
      const key = cid + "|" + f.na + "|" + Math.round(wpc * 100) + "|" + f.ns + "|" + Math.round(phaseA * 100) + "|" + Math.round(phaseB * 100)
      let grid = grids.get(key)
      if (!grid) grids.set(key, grid = { f, wpc, phaseA, phaseB, cells: new Set() })
      grid.cells.add(packCell(Math.round((wa0 - phaseA) / f.wa), Math.round((wb0 - phaseB) / f.wb)))
    }
  }
  const greedyQuads = []
  stage(2500)
  let gi = 0
  for (const grid of grids.values()) {
    report(++gi / grids.size)
    await breathe()
    if (shouldCancel?.()) return null
    const f = grid.f
    const translucent = isTranslucent(f.tex, cutoff)
    const sig = f.sig + (translucent ? "|T" : "|O")
    let grp = atlasGroups.get(sig)
    if (!grp) atlasGroups.set(sig, grp = { textures: new Set(), repMat: f.mat, translucent })
    const maxA = Math.max(1, Math.floor(maxTile / f.sub.sw)), maxB = Math.max(1, Math.floor(maxTile / f.sub.sh))
    for (const [i0, i1, j0, j1] of greedyRects(grid.cells)) {
      for (let ci = i0; ci <= i1; ci += maxA) for (let cj = j0; cj <= j1; cj += maxB) {
        const ei = Math.min(ci + maxA - 1, i1), ej = Math.min(cj + maxB - 1, j1)
        const Na = ei - ci + 1, Nb = ej - cj + 1
        const wALo = grid.phaseA + ci * f.wa, wAHi = grid.phaseA + (ei + 1) * f.wa
        const wBLo = grid.phaseB + cj * f.wb, wBHi = grid.phaseB + (ej + 1) * f.wb
        const ur = f.uAxisIsPa ? Na : Nb, vr = f.uAxisIsPa ? Nb : Na
        const pseudo = { image: tiledSub(f.tex.image, f.cellKey, f.sub, ur, vr), colorSpace: f.tex.colorSpace }
        grp.textures.add(pseudo)
        greedyQuads.push({ sig, pseudo, f, wpc: grid.wpc, wALo, wAHi, wBLo, wBHi })
      }
    }
  }

  const atlases = new Map()
  const created = { textures: [], materials: [], atlasEntries: [] }
  stage(800)
  let ai = 0
  for (const [sig, grp] of atlasGroups) {
    report(++ai / atlasGroups.size)
    await breathe()
    if (shouldCancel?.()) return null
    if (shared) {
      let sheet = shared.sheets.get(sig)
      if (!sheet) shared.sheets.set(sig, sheet = { pages: [], rects: new Map() })
      const rects = new Map()
      for (const t of grp.textures) rects.set(t, await sharedLocate(shared, sheet, t))
      subFlush(shared.renderer)
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
        m.transparent = grp.translucent
        m.depthWrite = !grp.translucent
        created.materials.push(m)
        return m
      })
      atlases.set(sig, { rects, sizes, materials, accs: sheet.pages.map(makeAcc) })
      continue
    }
    const { atlases: ats, rects, sizes, entry } = await buildAtlas(Array.from(grp.textures), maxAtlas, breathe)
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
      m.transparent = grp.translucent
      m.depthWrite = !grp.translucent
      created.materials.push(m)
      return m
    })
    atlases.set(sig, { rects, sizes, materials, accs: ats.map(makeAcc) })
  }

  stage(3000)
  const blockT = new THREE.Matrix4(), full = new THREE.Matrix4(), nmat = new THREE.Matrix3()
  const dynamicInstances = [], dynBuckets = new Map(), bbBuckets = new Map()
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i]
    const td = tdata.get(p.group)
    if (!td) continue
    blockT.makeTranslation(p.pos[0] * 16, p.pos[1] * 16, p.pos[2] * 16)
    for (const m of td.meshes) {
      full.multiplyMatrices(blockT, m.matrix)
      nmat.getNormalMatrix(full)
      for (const f of m.faces) {
        if (f.cull && p.cull?.has(f.cull)) continue
        if (f.animKey) appendGroup(m.geo, f.start, f.count, full, nmat, null, 0, 0, anims.get(f.animKey).acc)
        else {
          const at = atlases.get(f.sig), rect = at.rects.get(f.tex), s = at.sizes[rect.ai]
          appendGroup(m.geo, f.start, f.count, full, nmat, rect, s.w, s.h, at.accs[rect.ai], f.fd)
        }
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
      const inst = d.node.clone()
      const meshes = []
      inst.traverse(o => { if (o.isMesh) meshes.push(o) })
      for (const m of meshes) {
        let inPart = false
        for (let n = m; n && n !== inst; n = n.parent) if (n.name?.startsWith("part:")) { inPart = true; break }
        if (inPart) {
          const key = geoHash(m.geometry) + "|" + [].concat(m.material).map(x => matSignature(x) + (matMap(x)?.uuid ?? "")).join(",")
          let bucket = dynBuckets.get(key)
          if (!bucket) dynBuckets.set(key, bucket = { geometry: m.geometry, material: m.material, entries: [] })
          bucket.entries.push({ parent: m.parent, local: m.matrix.clone(), root: inst })
        }
        m.removeFromParent()
      }
      initDynamic(inst)
      holder.add(inst)
      dynamicInstances.push({ holder, object: inst, pos: p.pos })
    }
    if (i % 2000 === 1999) {
      report((i + 1) / placements.length)
      await nextTask()
      if (shouldCancel?.()) return null
    }
  }

  stage(1500)
  let appended = 0
  for (const q of greedyQuads) {
    if (++appended % 512 === 0) {
      report(appended / greedyQuads.length)
      await breathe()
      if (shouldCancel?.()) return null
    }
    const at = atlases.get(q.sig), rect = at.rects.get(q.pseudo), s = at.sizes[rect.ai], acc = at.accs[rect.ai], f = q.f
    const fd = faceDataOf(f.mat)
    for (const vert of f.verts) {
      const p = [0, 0, 0], nn = [0, 0, 0]
      p[f.na] = q.wpc
      p[f.pa] = vert.ha ? q.wAHi : q.wALo
      p[f.pb] = vert.hb ? q.wBHi : q.wBLo
      nn[f.na] = f.ns
      acc.P.push3(p[0], p[1], p[2])
      acc.N.push3(nn[0], nn[1], nn[2])
      acc.U.push2((rect.x + vert.u * rect.w) / s.w, 1 - (rect.y + (1 - vert.v) * rect.h) / s.h)
      if (fd) acc.F.push2(fd[0], fd[1])
    }
  }

  const group = new THREE.Group()
  let drawCalls = 0, tris = 0
  function addMesh(acc, material) {
    if (!acc.P.length) return
    const geo = new THREE.BufferGeometry()
    const pd = acc.P.data()
    geo.setAttribute("position", new THREE.BufferAttribute(pd, 3))
    geo.setAttribute("normal", new THREE.BufferAttribute(acc.N.data(), 3))
    geo.setAttribute("uv", new THREE.BufferAttribute(acc.U.data(), 2))
    if (acc.F?.length) geo.setAttribute("faceData", new THREE.BufferAttribute(acc.F.data(), 2))
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
    const mesh = new THREE.Mesh(geo, material)
    if (material.transparent) mesh.renderOrder = material.side === THREE.BackSide ? 0 : 1
    group.add(mesh)
    drawCalls++
    tris += acc.P.length / 9
  }
  stage(900)
  let meshCount = anims.size, mi = 0
  for (const at of atlases.values()) meshCount += at.accs.length
  for (const { materials, accs } of atlases.values()) {
    for (let i = 0; i < accs.length; i++) {
      addMesh(accs[i], materials[i])
      report(++mi / meshCount)
      await breathe()
    }
  }
  for (const { material, acc } of anims.values()) {
    addMesh(acc, material)
    report(++mi / meshCount)
    await breathe()
  }
  const primers = []
  const _bbPos = new THREE.Vector3(), _bbQuat = new THREE.Quaternion(), _bbFlip = new THREE.Quaternion(0, 1, 0, 0), _bbM = new THREE.Matrix4(), _bbInv = new THREE.Matrix4()
  for (const bucket of bbBuckets.values()) {
    const entries = bucket.entries
    const merged = mergeInstanceSource(bucket.geometry, bucket.material)
    if (!merged) continue
    const im = new THREE.InstancedMesh(merged.geometry, merged.material, entries.length)
    im.frustumCulled = false
    im.userData.billboard = true
    im.userData.billboardEntries = entries
    im.onBeforeRender = function (renderer, scene, camera) {
      _bbInv.copy(this.matrixWorld).invert()
      camera.getWorldQuaternion(_bbQuat).multiply(_bbFlip)
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        _bbPos.copy(e.pos).applyMatrix4(this.matrixWorld)
        this.setMatrixAt(i, _bbM.compose(_bbPos, _bbQuat, e.scale).premultiply(_bbInv))
      }
      this.instanceMatrix.needsUpdate = true
    }
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
    let inited = false
    im.onBeforeRender = function (renderer, scene, camera) {
      _dynInv.copy(this.matrixWorld).invert()
      let any = !inited
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        if (!dynamicFrame(e.root, renderer, camera) && inited) continue
        this.setMatrixAt(i, _dynM.multiplyMatrices(e.parent.matrixWorld, e.local).premultiply(_dynInv))
        any = true
      }
      if (any) this.instanceMatrix.needsUpdate = true
      inited = true
    }
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
    let inited = false
    const baseBeforeRender = bm.onBeforeRender
    bm.onBeforeRender = function (renderer, scene, camera, geometry, material, grp) {
      _dynInv.copy(this.matrixWorld).invert()
      for (const s of slots) {
        if (!dynamicFrame(s.e.root, renderer, camera) && inited) continue
        this.setMatrixAt(s.id, _dynM.multiplyMatrices(s.e.parent.matrixWorld, s.e.local).premultiply(_dynInv))
      }
      inited = true
      baseBeforeRender.call(this, renderer, scene, camera, geometry, material, grp)
    }
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

  const sorter = sortTranslucent(group, { resortDistance: opts.resortDistance })

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
      for (const m of created.materials) { try { m.dispose() } catch {} }
      for (const e of created.atlasEntries) { try { releaseAtlas(e) } catch {} }
      group.removeFromParent()
    }
  }
}
