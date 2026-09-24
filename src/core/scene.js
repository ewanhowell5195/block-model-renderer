import { THREE, normalize, jsonKey } from "./platform.js"
import { prepareAssets, scopedCache } from "./assets.js"
import { cloneInstance, parseBlockstate, resolveModelData, loadModel, billboardBeforeRender, AIR_BLOCKS, TECHNICAL_BLOCKS, parseDaytime, shaderSaltNow, REBIND_UNIFORMS, resolveWorldLighting, makeFog, randomOffset, rollPicks } from "./models.js"
import { getCullFaces } from "./render.js"
import { computeSceneLight, isFlatBlocks } from "./lighting.js"
import { fluidTypeOf, fluidHeights } from "./fluids.js"
import { blockRules } from "./data.js"
import { optimizePlacements, cullMaskOf, CULL_DIRS } from "./optimize.js"

const nextTask = globalThis.scheduler?.yield
  ? () => scheduler.yield()
  : () => new Promise(r => {
    const c = new MessageChannel()
    c.port1.onmessage = () => { c.port1.close(); r() }
    c.port2.postMessage(0)
  })

const DIRS = {
  up: [0, 1, 0],
  down: [0, -1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0]
}
const DIR_NAMES = Object.keys(DIRS)
const DIR_VECS = Object.values(DIRS)
const _nbr = new Int32Array(6)
const NO_OFFSET = [0, 0, 0]
const PK = (x, y, z) => ((x + 1048576) * 2048 + (y + 1024)) * 2097152 + (z + 1048576)

class CellTable {
  constructor(count) {
    let cap = 16
    while (cap < count * 2) cap *= 2
    this.mask = cap - 1
    this.keys = new Float64Array(cap).fill(-1)
    this.vals = new Int32Array(cap)
  }
  slot(key, x, y, z) {
    let s = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & this.mask
    while (this.keys[s] !== -1 && this.keys[s] !== key) s = (s + 1) & this.mask
    return s
  }
  get(x, y, z) {
    const key = PK(x, y, z)
    const s = this.slot(key, x, y, z)
    return this.keys[s] === key ? this.vals[s] : -1
  }
  set(x, y, z, v) {
    const key = PK(x, y, z)
    const s = this.slot(key, x, y, z)
    this.keys[s] = key
    this.vals[s] = v
  }
}

const templateCaches = new WeakMap()
const TEMPLATE_CACHE_MAX = 4096

function disposeTemplateGroup(g) {
  g.traverse(o => {
    if (!o.isMesh && !o.isLineSegments) return
    try { o.geometry?.dispose() } catch {}
    for (const m of [].concat(o.material)) { try { m?.dispose?.() } catch {} }
  })
}

function sweepTemplateCache(cache) {
  for (const [key, e] of cache) {
    if (cache.size <= TEMPLATE_CACHE_MAX) break
    if (e.users > 0) continue
    cache.delete(key)
    disposeTemplateGroup(e.group)
  }
}

function cloneTemplate(src, rebind) {
  const matClones = new Map()
  const cloneMat = m => {
    if (Array.isArray(m)) return m.map(cloneMat)
    let c = matClones.get(m)
    if (!c) {
      if (m.isShaderMaterial) {
        const u = m.uniforms
        m.uniforms = {}
        c = m.clone()
        m.uniforms = u
        c.uniforms = { ...u }
        for (const k of REBIND_UNIFORMS) {
          if (rebind[k] && c.uniforms[k]) c.uniforms[k] = rebind[k]
        }
      } else {
        c = m.clone()
      }
      matClones.set(m, c)
    }
    return c
  }
  const walk = (s, root) => {
    const d = s.isMesh ? new THREE.Mesh(s.geometry, cloneMat(s.material))
      : s.isLineSegments ? new THREE.LineSegments(s.geometry, cloneMat(s.material))
      : new THREE.Group()
    if (root) d.__templateSource = src
    d.name = s.name
    d.userData = root ? { ...s.userData } : s.userData
    d.visible = s.visible
    d.renderOrder = s.renderOrder
    d.matrixAutoUpdate = s.matrixAutoUpdate
    d.position.copy(s.position)
    d.quaternion.copy(s.quaternion)
    d.scale.copy(s.scale)
    d.matrix.copy(s.matrix)
    d.matrixWorldNeedsUpdate = true
    d.onBeforeRender = s.onBeforeRender
    for (const ch of s.children) d.add(walk(ch, false))
    return d
  }
  return walk(src, true)
}

const CK3 = (() => {
  const t = new Array(27)
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    t[(dy + 1) * 9 + (dz + 1) * 3 + (dx + 1)] = cellKey3(dx, dy, dz)
  }
  return t
})()

function cellKey3(dx, dy, dz) {
  let k = dy === 1 ? "up" : dy === -1 ? "down" : ""
  if (dz === -1) k += (k ? "_" : "") + "north"
  else if (dz === 1) k += (k ? "_" : "") + "south"
  if (dx === -1) k += (k ? "_" : "") + "west"
  else if (dx === 1) k += (k ? "_" : "") + "east"
  return k
}

export async function createScene(assets, blocks, args = {}) {
  if (assets == null || assets.length === 0) throw new Error("createScene requires assets")
  const flat = isFlatBlocks(blocks)
  if (!flat && !Array.isArray(blocks)) throw new Error("createScene requires an array of blocks, or a { palette, raw } run")
  const raw = flat ? blocks.raw : null
  const count = flat ? raw.length >> 2 : blocks.length
  assets = scopedCache(await prepareAssets(assets))
  const defaults = args.defaults ?? assets.defaults
  const rules = await blockRules(assets)
  const lightingArg = args.lighting ?? "world"
  const worldCfg = lightingArg && typeof lightingArg === "object" ? lightingArg : lightingArg === "world" ? {} : null
  const lighting = worldCfg ? "world" : lightingArg
  const optimize = args.optimize !== false
  const version = args.version ?? assets.version
  const onProgress = args.onProgress
  const shouldCancel = args.shouldCancel
  const origin = Array.isArray(args.origin) ? args.origin : [0, 0, 0]
  const offsetOrigin = args.randomOffset ? (Array.isArray(args.randomOffset.origin) ? args.randomOffset.origin : [origin[0], origin[2]]) : null

  const givenLight = worldCfg?.light && typeof worldCfg.light === "object" ? worldCfg.light : null
  const computeLight = worldCfg != null && !givenLight && worldCfg.light !== false
  const stageNames = ["parse", ...(computeLight ? ["light"] : []), "build", ...(optimize ? ["optimize"] : [])]
  let stage = null, stageIndex = -1
  const enter = name => {
    stageIndex++
    stage = { index: stageIndex, count: stageNames.length, name }
    onProgress?.(stage, 0, 1)
  }
  const report = (done, total) => onProgress?.(stage, done, total)

  const sliceMs = args.sliceMs ?? 40
  let sliceT = performance.now()
  async function breathe() {
    if (performance.now() - sliceT < sliceMs) return
    await nextTask()
    sliceT = performance.now()
  }

  const cellX = new Int32Array(count), cellY = new Int32Array(count), cellZ = new Int32Array(count)
  const cellPal = new Int32Array(count), cellCtx = new Uint8Array(count)
  let cellN = 0, liveCells = 0
  let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity
  function grow(x, y, z) {
    if (x < cx0) cx0 = x
    if (x > cx1) cx1 = x
    if (y < cy0) cy0 = y
    if (y > cy1) cy1 = y
    if (z < cz0) cz0 = z
    if (z > cz1) cz1 = z
  }
  if (flat) {
    for (let j = 0; j < raw.length; j += 4) if (blocks.palette[raw[j]]) grow(raw[j + 1], raw[j + 2], raw[j + 3])
  } else {
    for (let i = 0; i < blocks.length; i++) {
      const p = blocks[i]?.pos
      if (p) grow(p[0], p[1], p[2])
    }
  }
  const cW = cx1 - cx0 + 3, cH = cy1 - cy0 + 3, cD = cz1 - cz0 + 3
  const cVol = cx0 === Infinity ? 0 : cW * cH * cD
  const cellIdx = cVol > 0 && cVol <= 24e6 ? new Int32Array(cVol) : null
  const cellMap = cellIdx ? null : new CellTable(count)
  const CI = (x, y, z) => {
    const ix = x - cx0 + 1, iy = y - cy0 + 1, iz = z - cz0 + 1
    return ix >= 0 && iy >= 0 && iz >= 0 && ix < cW && iy < cH && iz < cD ? (iz * cH + iy) * cW + ix : -1
  }
  function cellAt(x, y, z) {
    let j = -1
    if (cellIdx) {
      const i = CI(x, y, z)
      if (i >= 0) j = cellIdx[i] - 1
    } else j = cellMap.get(x, y, z)
    return j >= 0 && cellPal[j] >= 0 ? j : -1
  }
  function cellOffset(c) {
    const limits = offsetOrigin ? palette[cellPal[c]].offsetLimits : null
    return limits ? randomOffset(cellX[c] + offsetOrigin[0], cellZ[c] + offsetOrigin[1], limits[0], limits[1]) : NO_OFFSET
  }
  function putCell(x, y, z, pi, context) {
    if (cellIdx) {
      const i = CI(x, y, z)
      if (i < 0) return
      const j = cellIdx[i] - 1
      if (j >= 0 && cellPal[j] >= 0) { cellPal[j] = pi; cellCtx[j] = context; return }
      cellIdx[i] = cellN + 1
    } else {
      const j = cellMap.get(x, y, z)
      if (j >= 0 && cellPal[j] >= 0) { cellPal[j] = pi; cellCtx[j] = context; return }
      cellMap.set(x, y, z, cellN)
    }
    cellX[cellN] = x
    cellY[cellN] = y
    cellZ[cellN] = z
    cellPal[cellN] = pi
    cellCtx[cellN] = context
    cellN++
    liveCells++
  }
  function dropCell(x, y, z) {
    const j = cellAt(x, y, z)
    if (j >= 0) { cellPal[j] = -1; liveCells-- }
  }
  const NOFF = cellIdx ? DIR_VECS.map(v => v[0] + v[1] * cW + v[2] * cW * cH) : null
  const HOFF = new Int32Array(27)
  if (cellIdx) for (let k = 0; k < 27; k++) {
    const dy = ((k / 9) | 0) - 1, dz = (((k % 9) / 3) | 0) - 1, dx = (k % 3) - 1
    HOFF[k] = dx + dy * cW + dz * cW * cH
  }
  const overlays = []
  const paletteIndex = new Map()
  const palette = []
  let blockPalette = new Uint16Array(count).fill(0xFFFF)
  function widenPalette() {
    const wide = new Uint32Array(count)
    for (let i = 0; i < count; i++) wide[i] = blockPalette[i] === 0xFFFF ? 0xFFFFFFFF : blockPalette[i]
    blockPalette = wide
  }
  const NO_PROPS = {}
  const piMemo = new WeakMap()
  const idInfo = new Map()
  const infoOf = rawId => {
    let info = idInfo.get(rawId)
    if (info === undefined) {
      const nid = normalize(rawId)
      idInfo.set(rawId, info = { id: nid, air: AIR_BLOCKS.test(nid) })
    }
    return info
  }
  function stateIndex(id, properties, biome) {
    const stateKey = id + "\0" + JSON.stringify(properties ?? null) + "\0" + JSON.stringify(biome)
    let pi = paletteIndex.get(stateKey)
    if (pi === undefined) {
      pi = palette.length
      if (pi === 0xFFFF) widenPalette()
      paletteIndex.set(stateKey, pi)
      palette.push({ id, properties: properties ?? null, biome, nbt: null, pos: null, models: null })
    }
    return pi
  }
  function nbtIndex(id, properties, biome, nbt, pos) {
    const stateKey = id + "\0" + JSON.stringify(properties ?? null) + "\0" + JSON.stringify(biome) + "\0" + jsonKey(nbt)
    let pi = paletteIndex.get(stateKey)
    if (pi === undefined) {
      pi = palette.length
      if (pi === 0xFFFF) widenPalette()
      paletteIndex.set(stateKey, pi)
      palette.push({ id, properties: properties ?? null, biome, nbt, pos, models: null })
    }
    return pi
  }
  function place(i, pi, x, y, z, overlay, context) {
    blockPalette[i] = pi
    if (overlay) overlays.push({ pos: [x, y, z], palette: pi })
    else putCell(x, y, z, pi, context ? 1 : 0)
  }
  if (flat) {
    const fpal = blocks.palette, blockNbt = blocks.blockNbt
    const flatPi = new Int32Array(fpal.length).fill(-1)
    for (let i = 0, j = 0; i < count; i++, j += 4) {
      const s = raw[j], e = fpal[s]
      if (!e?.id) continue
      const info = infoOf(e.id)
      if (info.air) {
        dropCell(raw[j + 1], raw[j + 2], raw[j + 3])
        continue
      }
      const nbt = blockNbt?.get(i)
      const biome = e.biome ?? args.biome ?? null
      let pi
      if (nbt) pi = nbtIndex(info.id, e.properties, biome, nbt, [raw[j + 1], raw[j + 2], raw[j + 3]])
      else {
        pi = flatPi[s]
        if (pi < 0) pi = flatPi[s] = stateIndex(info.id, e.properties, biome)
      }
      place(i, pi, raw[j + 1], raw[j + 2], raw[j + 3], e.overlay, e.context === true)
    }
  } else {
    for (let i = 0; i < count; i++) {
      const b = blocks[i]
      if (!b?.id || !b.pos) continue
      const info = infoOf(b.id)
      if (info.air) {
        dropCell(b.pos[0], b.pos[1], b.pos[2])
        continue
      }
      const id = info.id
      const biome = b.biome ?? args.biome ?? null
      let pi
      if (b.nbt) pi = nbtIndex(id, b.properties, biome, b.nbt, b.pos)
      else {
        const po = b.properties ?? NO_PROPS
        let byId = piMemo.get(po)
        if (!byId) piMemo.set(po, byId = new Map())
        const bk = biome == null ? id : id + "\0" + JSON.stringify(biome)
        pi = byId.get(bk)
        if (pi === undefined) byId.set(bk, pi = stateIndex(id, b.properties, biome))
      }
      place(i, pi, b.pos[0], b.pos[1], b.pos[2], b.overlay, b.context === true)
    }
  }

  const sigIds = (assets.cache.sigIds ??= new Map())
  enter("parse")
  for (const entry of palette) {
    const rolls = entry.pos ? undefined : {}
    entry.models = await parseBlockstate(assets, entry.id, {
      data: entry.properties ?? {}, biome: entry.biome ?? undefined, nbt: entry.nbt ?? undefined,
      mapArt: args.mapArt, pos: entry.pos ?? undefined, rolls, ignoreAtlases: args.ignoreAtlases, version, defaults
    })
    entry.rolls = rolls?.lists?.length ? rolls : null
    entry.offsetLimits = offsetOrigin ? rules.offset(entry.id) : null
    entry.flat = { id: entry.id, ...(entry.properties ?? {}) }
    entry.sig = entry.id + "\u0000" + JSON.stringify(entry.properties ?? null)
    let sid = sigIds.get(entry.sig)
    if (sid === undefined) sigIds.set(entry.sig, sid = sigIds.size)
    entry.sigId = sid
    entry.fluid = fluidTypeOf(entry.id, entry.properties, rules)
    await breathe()
    if (shouldCancel?.()) return null
  }
  // the cull key is the cell's own state plus its six neighbours, packed into
  // two integers rather than built as a string. -1 is "nothing there" and -2 is
  // "occluded from outside", which sit just past the palette
  // one object of a fixed shape, refilled per fluid cell. fluidHeights is
  // awaited before the next cell touches it
  const HOOD_KEYS = [...new Set(CK3.filter(Boolean))].concat("self")
  const HOOD = {}
  for (const k of HOOD_KEYS) HOOD[k] = null

  const cullCache = (assets.cache.cullFaces ??= new Map())
  const cullEnv = (version ?? "") + "\u0000" + (defaults ?? "") + "\u0001"
  const cullMemo = new Map()
  const extOcc = args.externalOcclusion
  const CB = palette.length + 2
  const CB3 = CB * CB * CB
  const cullNumeric = CB <= 2000
  const templateOf = new Map()
  const templateSpecs = new Map()
  const templateKeys = [], templateIds = new Map()
  const cullSets = [], maskCull = new Int32Array(64).fill(-1)
  const palSig = Int32Array.from(palette, e => e.sigId + 2)
  const sigNumeric = palSig.every(s => s < 8192)
  const cullNums = (assets.cache.cullMasks ??= new Map())
  let cullNum = cullNums.get(cullEnv)
  if (!cullNum) cullNums.set(cullEnv, cullNum = new Map())
  async function cullFacesFor(entry, cached) {
    const neighbors = {}
    for (let di = 0; di < 6; di++) {
      if (_nbr[di] >= 0) neighbors[DIR_NAMES[di]] = palette[_nbr[di]].flat
      else if (_nbr[di] === -2) neighbors[DIR_NAMES[di]] = true
    }
    const faces = () => getCullFaces({ id: entry.id, blockstates: entry.properties ?? undefined, neighbors, assets, version, defaults })
    if (!cached) return faces()
    let ck = cullEnv + entry.sigId
    for (let di = 0; di < 6; di++) ck += "," + (_nbr[di] >= 0 ? palette[_nbr[di]].sigId : _nbr[di])
    let cull = cullCache.get(ck)
    if (cull === undefined) cullCache.set(ck, cull = await faces())
    return cull
  }
  const cellTmpl = new Int32Array(cellN).fill(-1), cellCull = new Int32Array(cellN).fill(-1)
  let parsed = 0
  for (let c = 0; c < cellN; c++) {
    const cellPi = cellPal[c]
    if (cellPi < 0) continue
    const entry = palette[cellPi]

    if (cellCtx[c] || (!args.technical && TECHNICAL_BLOCKS.has(entry.id))) continue

    const px = cellX[c], py = cellY[c], pz = cellZ[c]
    const bi = cellIdx ? CI(px, py, pz) : -1
    for (let di = 0; di < 6; di++) {
      let nc
      if (bi >= 0) {
        const j = cellIdx[bi + NOFF[di]] - 1
        nc = j >= 0 && cellPal[j] >= 0 ? j : -1
      } else {
        const v = DIR_VECS[di]
        nc = cellAt(px + v[0], py + v[1], pz + v[2])
      }
      if (nc >= 0) { _nbr[di] = cellPal[nc]; continue }
      const v = DIR_VECS[di]
      _nbr[di] = extOcc?.(px + v[0], py + v[1], pz + v[2]) ? -2 : -1
    }
    let mask
    if (sigNumeric) {
      const s0 = _nbr[0] >= 0 ? palSig[_nbr[0]] : _nbr[0] + 2
      const s1 = _nbr[1] >= 0 ? palSig[_nbr[1]] : _nbr[1] + 2
      const s2 = _nbr[2] >= 0 ? palSig[_nbr[2]] : _nbr[2] + 2
      const s3 = _nbr[3] >= 0 ? palSig[_nbr[3]] : _nbr[3] + 2
      const s4 = _nbr[4] >= 0 ? palSig[_nbr[4]] : _nbr[4] + 2
      const s5 = _nbr[5] >= 0 ? palSig[_nbr[5]] : _nbr[5] + 2
      const hi = ((palSig[cellPi] * 8192 + s0) * 8192 + s1) * 8192 + s2
      const lo = (s3 * 8192 + s4) * 8192 + s5
      let bucket = cullNum.get(hi)
      if (bucket === undefined) cullNum.set(hi, bucket = new Map())
      mask = bucket.get(lo)
      if (mask === undefined) bucket.set(lo, mask = cullMaskOf(await cullFacesFor(entry, false)))
    } else {
      let hi, lo
      if (cullNumeric) {
        const s0 = _nbr[0] < 0 ? palette.length - _nbr[0] - 1 : _nbr[0]
        const s1 = _nbr[1] < 0 ? palette.length - _nbr[1] - 1 : _nbr[1]
        const s2 = _nbr[2] < 0 ? palette.length - _nbr[2] - 1 : _nbr[2]
        const s3 = _nbr[3] < 0 ? palette.length - _nbr[3] - 1 : _nbr[3]
        const s4 = _nbr[4] < 0 ? palette.length - _nbr[4] - 1 : _nbr[4]
        const s5 = _nbr[5] < 0 ? palette.length - _nbr[5] - 1 : _nbr[5]
        hi = ((cellPi * CB + s0) * CB + s1) * CB + s2
        lo = (s3 * CB + s4) * CB + s5
      } else {
        hi = String(cellPi) + "|" + _nbr[0] + "|" + _nbr[1] + "|" + _nbr[2]
        lo = _nbr[3] + "|" + _nbr[4] + "|" + _nbr[5]
      }
      let bucket = cullMemo.get(hi)
      if (bucket === undefined) cullMemo.set(hi, bucket = new Map())
      mask = bucket.get(lo)
      if (mask === undefined) bucket.set(lo, mask = cullMaskOf(await cullFacesFor(entry, true)))
    }
    if (mask) {
      let ci = maskCull[mask]
      if (ci < 0) maskCull[mask] = ci = cullSets.push(new Set(CULL_DIRS.filter((d, i) => mask & (1 << i)))) - 1
      cellCull[c] = ci
    }

    let fh = null
    if (entry.fluid) {
      const hood = HOOD
      for (let k = 0; k < HOOD_KEYS.length; k++) hood[HOOD_KEYS[k]] = null
      if (bi >= 0) {
        for (let k = 0; k < 27; k++) {
          if (k === 13) continue
          const j = cellIdx[bi + HOFF[k]] - 1
          if (j >= 0 && cellPal[j] >= 0) hood[CK3[k]] = palette[cellPal[j]].flat
        }
      } else for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy && !dz) continue
        const nc = cellAt(px + dx, py + dy, pz + dz)
        if (nc >= 0) hood[CK3[(dy + 1) * 9 + (dz + 1) * 3 + (dx + 1)]] = palette[cellPal[nc]].flat
      }
      hood.self = entry.flat
      fh = await fluidHeights(assets, entry.fluid, hood)
    }

    const pick = entry.rolls ? rollPicks(entry.rolls, px + origin[0], py + origin[1], pz + origin[2]) : null
    const packed = fh === null && pick !== null ? pick * palette.length + cellPi : -1
    const templateKey = pick === null && fh === null
      ? cellPi
      : packed >= 0 && packed <= Number.MAX_SAFE_INTEGER ? -1 - packed : cellPi + "|" + (pick ?? "") + "|" + (fh ? JSON.stringify(fh) : "")
    let ti = templateIds.get(templateKey)
    if (ti === undefined) {
      templateIds.set(templateKey, ti = templateKeys.push(templateKey) - 1)
      templateSpecs.set(templateKey, { entry, palette: cellPi, pick, pos: pick === null ? null : [px + origin[0], py + origin[1], pz + origin[2]], fh })
    }
    cellTmpl[c] = ti

    if (++parsed % 256 === 0) {
      report(parsed, liveCells)
      await breathe()
      if (shouldCancel?.()) return null
    }
  }
  for (const o of overlays) {
    o.template = o.palette
    if (!templateSpecs.has(o.template)) templateSpecs.set(o.template, { entry: palette[o.palette], palette: o.palette, pick: null, pos: null, fh: null })
  }
  report(1, 1)

  let light = givenLight
  if (computeLight) {
    enter("light")
    if (liveCells) {
      const lightRaw = new Int32Array(liveCells * 4)
      for (let c = 0, q = 0; c < cellN; c++) {
        if (cellPal[c] < 0) continue
        lightRaw[q++] = cellPal[c]
        lightRaw[q++] = cellX[c]
        lightRaw[q++] = cellY[c]
        lightRaw[q++] = cellZ[c]
      }
      const lightPalette = palette.map(e => ({ id: e.id, properties: e.properties ?? undefined }))
      light = await computeSceneLight({ palette: lightPalette, raw: lightRaw }, { assets, version, defaults, dimension: worldCfg?.dimension, sliceMs: args.sliceMs, externalOcclusion: extOcc, release: args.release })
    }
    report(1, 1)
    if (shouldCancel?.()) return null
  }
  const fog = worldCfg ? makeFog(worldCfg.fog, resolveWorldLighting(worldCfg).dim) : null
  const lightingOpt = worldCfg ? { ...worldCfg, light, fog } : lighting

  enter("build")
  const group = new THREE.Group()
  let daytimeUniform = worldCfg ? { value: parseDaytime(worldCfg.daytime) } : null
  let tcache = templateCaches.get(assets.cache)
  if (!tcache) templateCaches.set(assets.cache, tcache = new Map())
  const usedEntries = []
  const envSig = (worldCfg ? JSON.stringify({ ...worldCfg, light: !!light, daytime: 0, fog: 0 }) : String(lighting))
    + "\0" + (args.shaderScale ?? "") + "\0" + (args.ignoreAtlases ? 1 : 0) + "\0" + (version ?? "") + "\0" + (defaults ?? "") + "\0" + shaderSaltNow()
  const rebind = { daytime: daytimeUniform, ...(light?.uniforms ?? {}), ...(fog?.uniforms ?? {}) }
  let built = 0
  for (const [key, spec] of templateSpecs) {
    const cacheable = !spec.entry.nbt && !spec.entry.pos
    const cacheKey = cacheable
      ? spec.entry.id + "\0" + JSON.stringify(spec.entry.properties) + "\0" + JSON.stringify(spec.entry.biome)
        + "\0" + (spec.pick ?? "") + "\0" + (spec.fh ? JSON.stringify(spec.fh) : "") + "\0" + envSig
      : null
    let tmpl
    const hit = cacheKey ? tcache.get(cacheKey) : undefined
    if (hit) {
      tcache.delete(cacheKey)
      tcache.set(cacheKey, hit)
      hit.users++
      usedEntries.push(hit)
      tmpl = cloneTemplate(hit.group, rebind)
      if (daytimeUniform) tmpl.userData.daytime = daytimeUniform
      daytimeUniform ??= tmpl.userData.daytime
      templateOf.set(key, tmpl)
    } else {
      tmpl = new THREE.Group()
      if (daytimeUniform) tmpl.userData.daytime = daytimeUniform
      const models = spec.pos
        ? await parseBlockstate(assets, spec.entry.id, {
          data: spec.entry.properties ?? {}, biome: spec.entry.biome ?? undefined, nbt: spec.entry.nbt ?? undefined,
          mapArt: args.mapArt, pos: spec.pos, ignoreAtlases: args.ignoreAtlases, version, defaults
        })
        : spec.entry.models
      for (const model of models) {
        try {
          await loadModel(tmpl, assets, await resolveModelData(assets, model), {
            display: {}, animate: false, lighting: lightingOpt,
            shaderScale: args.shaderScale,
            block: { id: spec.entry.id, properties: spec.entry.properties ?? {} },
            fluidHeights: spec.fh, version, defaults
          })
        } catch {}
      }
      daytimeUniform ??= tmpl.userData.daytime
      templateOf.set(key, tmpl)
      if (cacheKey) {
        const entry = { group: tmpl, users: 1 }
        tcache.set(cacheKey, entry)
        usedEntries.push(entry)
        sweepTemplateCache(tcache)
      }
    }
    report(++built, templateSpecs.size)
    await breathe()
    if (shouldCancel?.()) return null
  }
  report(1, 1)
  if (daytimeUniform) group.userData.daytime = daytimeUniform
  if (fog) group.userData.fog = fog

  let drawCalls = 0, tris = 0
  let optimized = null
  if (optimize) {
    enter("optimize")
    let n = overlays.length
    for (let c = 0; c < cellN; c++) if (cellPal[c] >= 0 && cellTmpl[c] >= 0) n++
    const groups = [], gi = new Int32Array(n), pos = offsetOrigin ? new Float64Array(n * 3) : new Int32Array(n * 3), ci = new Int32Array(n)
    const groupIds = new Map()
    function addPlacement(i, key, x, y, z, cull) {
      let g = groupIds.get(key)
      if (g === undefined) groupIds.set(key, g = groups.push(templateOf.get(key)) - 1)
      gi[i] = g
      pos[i * 3] = x
      pos[i * 3 + 1] = y
      pos[i * 3 + 2] = z
      ci[i] = cull
    }
    let pn = 0
    for (let c = 0; c < cellN; c++) {
      if (cellPal[c] < 0 || cellTmpl[c] < 0) continue
      const off = cellOffset(c)
      addPlacement(pn++, templateKeys[cellTmpl[c]], cellX[c] + off[0], cellY[c] + off[1], cellZ[c] + off[2], cellCull[c])
    }
    for (const o of overlays) addPlacement(pn++, o.template, o.pos[0], o.pos[1], o.pos[2], -1)
    optimized = await optimizePlacements({ n, groups, gi, pos, culls: cullSets, ci }, {
      maxAtlas: args.maxAtlas, translucency: args.translucency, resortDistance: args.resortDistance, sliceMs,
      sharedAtlas: args.sharedAtlas,
      batchDynamics: args.batchDynamics,
      release: args.release,
      onProgress: relayProgress(onProgress, stage),
      shouldCancel
    })
    if (!optimized) return null
    group.add(optimized.group)
    drawCalls = optimized.drawCalls
    tris = optimized.tris
  } else {
    const cullVariants = new Map()
    for (let c = 0; c < cellN; c++) {
      if (cellPal[c] < 0 || cellTmpl[c] < 0) continue
      const templateKey = templateKeys[cellTmpl[c]]
      const cellCullSet = cellCull[c] >= 0 ? cullSets[cellCull[c]] : null
      let tmpl = templateOf.get(templateKey)
      if (cellCullSet) {
        const key = templateKey + "|" + Array.from(cellCullSet).sort().join(",")
        let culled = cullVariants.get(key)
        if (culled === undefined) {
          const spec = templateSpecs.get(templateKey)
          culled = new THREE.Group()
          culled.userData.daytime = daytimeUniform
          const models = spec.pos
            ? await parseBlockstate(assets, spec.entry.id, {
              data: spec.entry.properties ?? {}, biome: spec.entry.biome ?? undefined,
              pos: spec.pos, ignoreAtlases: args.ignoreAtlases, version, defaults
            })
            : spec.entry.models
          for (const model of models) {
            try {
              await loadModel(culled, assets, await resolveModelData(assets, model), {
                display: {}, animate: false, lighting: lightingOpt, cull: cellCullSet,
                shaderScale: args.shaderScale,
                block: { id: spec.entry.id, properties: spec.entry.properties ?? {} },
                fluidHeights: spec.fh, version, defaults
              })
            } catch {}
          }
          cullVariants.set(key, culled)
          templateOf.set(key, culled)
        }
        tmpl = culled
      }
      const inst = cloneInstance(tmpl, true)
      const off = cellOffset(c)
      inst.position.set((cellX[c] + off[0]) * 16, (cellY[c] + off[1]) * 16, (cellZ[c] + off[2]) * 16)
      group.add(inst)
      inst.traverse(o => {
        if (o.isLineSegments) { drawCalls++; return }
        if (!o.isMesh) return
        if (o.userData.billboard) o.onBeforeRender = billboardBeforeRender
        drawCalls++
        tris += (o.geometry.index?.count ?? o.geometry.attributes.position?.count ?? 0) / 3
      })
      await breathe()
      if (shouldCancel?.()) return null
    }
    for (const o of overlays) {
      const inst = cloneInstance(templateOf.get(o.template), true)
      inst.position.set(o.pos[0] * 16, o.pos[1] * 16, o.pos[2] * 16)
      group.add(inst)
      inst.traverse(m => {
        if (m.isLineSegments) { drawCalls++; return }
        if (!m.isMesh) return
        if (m.userData.billboard) m.onBeforeRender = billboardBeforeRender
        drawCalls++
        tris += (m.geometry.index?.count ?? m.geometry.attributes.position?.count ?? 0) / 3
      })
    }
  }

  const bounds = new THREE.Box3().setFromObject(group)

  let templates = null, blockTemplate = null, blockOffset = null
  if (args.keepTemplates) {
    templates = []
    const templateIdx = new Map()
    for (const [key, spec] of templateSpecs) {
      templateIdx.set(key, templates.length)
      templates.push({ palette: spec.palette, group: templateOf.get(key) })
    }
    blockTemplate = new Uint32Array(count).fill(0xFFFFFFFF)
    if (offsetOrigin) blockOffset = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      let c
      if (flat) {
        if (!blocks.palette[raw[i * 4]]) continue
        c = cellAt(raw[i * 4 + 1], raw[i * 4 + 2], raw[i * 4 + 3])
      } else {
        const b = blocks[i]
        if (!b?.pos) continue
        c = cellAt(b.pos[0], b.pos[1], b.pos[2])
      }
      if (c < 0 || cellTmpl[c] < 0) continue
      blockTemplate[i] = templateIdx.get(templateKeys[cellTmpl[c]])
      if (blockOffset) blockOffset.set(cellOffset(c), i * 3)
    }
  }

  return sceneHandle({ group, palette, blockPalette, templates, blockTemplate, blockOffset, bounds, light, drawCalls, tris, optimized, ownsLight: computeLight, usedEntries, tcache })
}

function relayProgress(onProgress, stage) {
  return onProgress ? (done, total) => onProgress(stage, done, total) : undefined
}

function sceneHandle({ group, palette, blockPalette, templates, blockTemplate, blockOffset, bounds, light, drawCalls, tris, optimized, ownsLight, usedEntries, tcache }) {
  return {
    group,
    palette,
    blockPalette,
    templates,
    blockTemplate,
    blockOffset,
    bounds,
    light,
    drawCalls,
    tris,
    sortTranslucent: camera => optimized?.sortTranslucent(camera),
    dispose() {
      optimized?.dispose()
      if (ownsLight) light?.dispose?.()
      const cachedGeos = new Set()
      for (const e of usedEntries) e.group.traverse(o => { if (o.isMesh || o.isLineSegments) cachedGeos.add(o.geometry) })
      if (!this.__released) {
        this.__released = true
        for (const e of usedEntries) e.users--
        sweepTemplateCache(tcache)
      }
      for (const t of templates ?? []) {
        t.group.traverse(o => {
          if (!o.isMesh && !o.isLineSegments) return
          if (!cachedGeos.has(o.geometry)) { try { o.geometry?.dispose() } catch {} }
          for (const m of [].concat(o.material)) { try { m?.dispose?.() } catch {} }
        })
      }
      group.traverse(o => {
        if (!o.isMesh && !o.isLineSegments) return
        for (const m of [].concat(o.material)) { try { m?.dispose?.() } catch {} }
        if (cachedGeos.has(o.geometry)) return
        try { o.geometry?.dispose() } catch {}
      })
      group.removeFromParent()
    }
  }
}
