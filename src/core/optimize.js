import { THREE, Canvas, loadTexture, platform } from "./platform.js"
import { sortTranslucent } from "./sorting.js"

const nextTask = globalThis.scheduler?.yield
  ? () => scheduler.yield()
  : () => new Promise(r => {
    const c = new MessageChannel()
    c.port1.onmessage = () => { c.port1.close(); r() }
    c.port2.postMessage(0)
  })

const matMap = m => m.uniforms?.map?.value ?? m.map
const matAnimated = m => !!(m.uniforms?.GameTime || matMap(m)?.userData?.frames)

function matSignature(m) {
  if (m.uniforms) {
    const u = m.uniforms
    return ["shader", m.side, u.shadeEnabled?.value, u.shadeOverride?.value?.toArray().join(","), u.d0?.value, u.d1?.value, u.ambient?.value,
      u.light0?.value?.toArray().join(","), u.light1?.value?.toArray().join(","), u.emission?.value].join("|")
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
function hashTexture(tex) {
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
  const verts = P.map(p => ({ ha: Math.abs(p.a - a1) < 0.01 ? 1 : 0, hb: Math.abs(p.b - b1) < 0.01 ? 1 : 0, u: (p.u - umin) / (umax - umin), v: (p.v - vmin) / (vmax - vmin) }))
  const srcHash = hashTexture(tex)
  const corners = {}
  for (const c of verts) corners[`${c.ha}${c.hb}`] = `${c.u.toFixed(2)},${c.v.toFixed(2)}`
  const orient = Object.keys(corners).sort().map(k => k + ":" + corners[k]).join("|")
  const cellKey = `${srcHash}:${sub.sx},${sub.sy},${sub.sw},${sub.sh}:${wa.toFixed(2)}x${wb.toFixed(2)}:${orient}`
  return { na, ns, pa, pb, pc, a0, b0, wa, wb, uAxisIsPa, sub, verts, sig: matSignature(mat), tex, mat, srcHash, cull, cellKey }
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

async function buildAtlas(textures, maxAtlas, breathe) {
  const pad = 1
  const rep = new Map()
  for (const t of textures) { const h = hashTexture(t); if (!rep.has(h)) rep.set(h, t) }
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
    a.colorSpace = textures[0].colorSpace ?? THREE.NoColorSpace
    a.needsUpdate = true
    atlases.push(a)
  }
  const rects = new Map()
  for (const t of textures) rects.set(t, byHash.get(hashTexture(t)))
  return { atlases, rects, sizes }
}

function greedyRects(cellSet) {
  const done = new Set(), rects = []
  const coords = Array.from(cellSet).map(s => s.split(",").map(Number)).sort((p, q) => p[1] - q[1] || p[0] - q[0])
  for (const [a, b] of coords) {
    if (done.has(a + "," + b)) continue
    let a1 = a
    while (cellSet.has((a1 + 1) + "," + b) && !done.has((a1 + 1) + "," + b)) a1++
    let b1 = b, grow = true
    while (grow) {
      for (let x = a; x <= a1; x++) if (!cellSet.has(x + "," + (b1 + 1)) || done.has(x + "," + (b1 + 1))) { grow = false; break }
      if (grow) b1++
    }
    for (let y = b; y <= b1; y++) for (let x = a; x <= a1; x++) done.add(x + "," + y)
    rects.push([a, a1, b, b1])
  }
  return rects
}

let _v = null, _n = null
function appendGroup(geo, start, count, mat, nmat, rect, W, H, acc) {
  _v ??= new THREE.Vector3()
  _n ??= new THREE.Vector3()
  const idx = geo.index, pos = geo.attributes.position, nrm = geo.attributes.normal, uv = geo.attributes.uv
  for (let i = start; i < start + count; i++) {
    const a = idx.getX(i)
    _v.fromBufferAttribute(pos, a).applyMatrix4(mat)
    _n.fromBufferAttribute(nrm, a).applyMatrix3(nmat).normalize()
    const u = uv.getX(a), v = uv.getY(a)
    acc.P.push(_v.x, _v.y, _v.z)
    acc.N.push(_n.x, _n.y, _n.z)
    if (rect) acc.U.push((rect.x + u * rect.w) / W, 1 - (rect.y + (1 - v) * rect.h) / H)
    else acc.U.push(u, v)
  }
}

export async function optimizeScene(placements, opts = {}) {
  if (!Array.isArray(placements)) throw new Error("optimizeScene requires an array of placements")
  const maxAtlas = opts.maxAtlas ?? detectMaxAtlas()
  const maxTile = Math.max(64, maxAtlas >> 5)
  const cutoff = opts.translucency
  const onProgress = opts.onProgress
  const shouldCancel = opts.shouldCancel
  const tiledCache = new Map()

  let sliceT = performance.now()
  async function breathe() {
    if (performance.now() - sliceT < 40) return
    await nextTask()
    sliceT = performance.now()
  }

  function tiledSub(srcImg, key, sub, ur, vr) {
    const k = key + "|" + ur + "x" + vr
    let c = tiledCache.get(k)
    if (c) return c
    c = new Canvas(sub.sw * ur, sub.sh * vr)
    const ctx = c.getContext("2d")
    for (let j = 0; j < vr; j++) for (let i = 0; i < ur; i++) ctx.drawImage(srcImg, sub.sx, sub.sy, sub.sw, sub.sh, i * sub.sw, j * sub.sh, sub.sw, sub.sh)
    texHash.set(c, k + "_" + c.width + "x" + c.height)
    tiledCache.set(k, c)
    return c
  }

  let progBase = 0, progSpan = 0
  function stage(span) { progBase += progSpan; progSpan = span }
  const report = f => onProgress?.(Math.round(progBase + Math.min(f, 1) * progSpan), 10000)

  const atlasGroups = new Map()
  const anims = new Map(), animTexId = new Map()
  const fixedAnimMats = new Set()
  const tdata = new Map()
  stage(500)
  let ti = 0
  for (const p of placements) {
    ti++
    if (!p.group || tdata.has(p.group)) continue
    const tmpl = p.group
    tmpl.updateMatrixWorld(true)
    const flats = [], meshMap = new Map()
    function atlasFace(o, face) {
      let m = meshMap.get(o)
      if (!m) meshMap.set(o, m = { geo: o.geometry, matrix: o.matrixWorld.clone(), faces: [] })
      m.faces.push(face)
    }
    function toAtlas(mat, tex, face) {
      const translucent = isTranslucent(tex, cutoff)
      const sig = matSignature(mat) + (translucent ? "|T" : "|O")
      let grp = atlasGroups.get(sig)
      if (!grp) atlasGroups.set(sig, grp = { textures: new Set(), repMat: mat, translucent })
      grp.textures.add(tex)
      return { ...face, sig }
    }
    tmpl.traverse(o => {
      if (!o.isMesh) return
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
          const id = tex ?? mat
          if (!animTexId.has(id)) animTexId.set(id, animTexId.size)
          const key = matSignature(mat) + "|a" + animTexId.get(id)
          if (!anims.has(key)) {
            const tr = tex ? isTranslucent(tex, cutoff) : false
            mat.transparent = tr
            mat.depthWrite = !tr
            fixedAnimMats.add(mat)
            anims.set(key, { material: mat, acc: { P: [], N: [], U: [] } })
          }
          atlasFace(o, { start: g.start, count: g.count, animKey: key, cull })
          continue
        }
        const fls = extractFlats(geo, g, o.matrixWorld, nm, tex, mat, cull)
        if (fls) for (const fl of fls) flats.push({ flat: fl.flat, o, mat, tex, start: fl.start, count: fl.count, cull })
        else atlasFace(o, toAtlas(mat, tex, { start: g.start, count: g.count, tex, cull }))
      }
    })
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
      if (demote.has(c)) atlasFace(c.o, toAtlas(c.mat, c.tex, { start: c.start, count: c.count, tex: c.tex, cull: c.cull }))
      else merge.push(c.flat)
    }
    tdata.set(tmpl, { merge, meshes: Array.from(meshMap.values()) })
    report(ti / placements.length)
    await breathe()
    if (shouldCancel?.()) return null
  }

  const grids = new Map()
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
      const wpc = f.pc + p.pos[f.na] * 16
      const wa0 = f.a0 + p.pos[f.pa] * 16, wb0 = f.b0 + p.pos[f.pb] * 16
      const phaseA = ((wa0 % f.wa) + f.wa) % f.wa, phaseB = ((wb0 % f.wb) + f.wb) % f.wb
      const key = f.na + "|" + wpc.toFixed(2) + "|" + f.ns + "|" + f.cellKey + "|" + phaseA.toFixed(2) + "|" + phaseB.toFixed(2)
      let grid = grids.get(key)
      if (!grid) grids.set(key, grid = { f, wpc, phaseA, phaseB, cells: new Set() })
      grid.cells.add(Math.round((wa0 - phaseA) / f.wa) + "," + Math.round((wb0 - phaseB) / f.wb))
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
  const created = { textures: [], materials: [] }
  stage(800)
  let ai = 0
  for (const [sig, grp] of atlasGroups) {
    report(++ai / atlasGroups.size)
    await breathe()
    if (shouldCancel?.()) return null
    const { atlases: ats, rects, sizes } = await buildAtlas(Array.from(grp.textures), maxAtlas, breathe)
    created.textures.push(...ats)
    const materials = ats.map(a => {
      const m = grp.repMat.clone()
      if (m.uniforms) {
        m.uniforms.map.value = a
        if (grp.repMat.uniforms.daytime) m.uniforms.daytime = grp.repMat.uniforms.daytime
      }
      else m.map = a
      m.transparent = grp.translucent
      m.depthWrite = !grp.translucent
      created.materials.push(m)
      return m
    })
    atlases.set(sig, { rects, sizes, materials, accs: ats.map(() => ({ P: [], N: [], U: [] })) })
  }

  stage(3000)
  const blockT = new THREE.Matrix4(), full = new THREE.Matrix4(), nmat = new THREE.Matrix3()
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
          appendGroup(m.geo, f.start, f.count, full, nmat, rect, s.w, s.h, at.accs[rect.ai])
        }
      }
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
    for (const vert of f.verts) {
      const p = [0, 0, 0], nn = [0, 0, 0]
      p[f.na] = q.wpc
      p[f.pa] = vert.ha ? q.wAHi : q.wALo
      p[f.pb] = vert.hb ? q.wBHi : q.wBLo
      nn[f.na] = f.ns
      acc.P.push(p[0], p[1], p[2])
      acc.N.push(nn[0], nn[1], nn[2])
      acc.U.push((rect.x + vert.u * rect.w) / s.w, 1 - (rect.y + (1 - vert.v) * rect.h) / s.h)
    }
  }

  const group = new THREE.Group()
  let drawCalls = 0, tris = 0
  function addMesh(acc, material) {
    if (!acc.P.length) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.Float32BufferAttribute(acc.P, 3))
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(acc.N, 3))
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(acc.U, 2))
    group.add(new THREE.Mesh(geo, material))
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
  onProgress?.(10000, 10000)

  const sorter = sortTranslucent(group, { resortDistance: opts.resortDistance })

  return {
    group,
    drawCalls,
    tris,
    atlasTextures: created.textures,
    sortTranslucent: camera => sorter.sort(camera),
    dispose() {
      sorter.detach()
      group.traverse(o => { if (o.isMesh) o.geometry.dispose() })
      for (const m of created.materials) m.dispose()
      for (const t of created.textures) t.dispose()
      group.removeFromParent()
    }
  }
}
