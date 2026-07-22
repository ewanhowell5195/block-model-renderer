import { THREE, parseJson, normalize, resolveNamespace } from "./platform.js"
import { prepareAssets, scopedCache, readFile } from "./assets.js"
import { parseBlockstate, resolveModelData, loadModel, billboardBeforeRender, AIR_BLOCKS, TECHNICAL_BLOCKS, parseDaytime, shaderSaltNow } from "./models.js"
import { getCullFaces } from "./render.js"
import { computeSceneLight } from "./lighting.js"
import { fluidTypeOf, fluidHeights } from "./fluids.js"
import { blockRules } from "./data.js"
import { optimizeScene } from "./optimize.js"

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

const templateCaches = new WeakMap()
const TEMPLATE_CACHE_MAX = 4096
const REBIND_UNIFORMS = ["daytime", "lightVol", "lightVolOrigin", "lightVolSize", "lightVolTex", "lightVolCols"]

function disposeTemplateGroup(g) {
  g.traverse(o => {
    if (!o.isMesh) return
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
    const d = s.isMesh ? new THREE.Mesh(s.geometry, cloneMat(s.material)) : new THREE.Group()
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

async function hasRandomModels(assets, id) {
  const cache = assets.cache.sceneRandom ??= new Map()
  if (cache.has(id)) return cache.get(id)
  let random = false
  try {
    const { namespace, item } = resolveNamespace(id)
    const buf = await readFile(`assets/${namespace}/blockstates/${item}.json`, assets)
    if (buf) {
      const json = parseJson(buf)
      if (json.variants) random = Object.values(json.variants).some(v => Array.isArray(v) && v.length > 1)
      else if (json.multipart) random = json.multipart.some(p => Array.isArray(p.apply) && p.apply.length > 1)
    }
  } catch {}
  cache.set(id, random)
  return random
}

const posHash = (x, y, z) => {
  const h = Math.imul(x, 3129871) ^ Math.imul(z, 116129781) ^ y
  return (Math.imul(Math.imul(h, h), 42317861) + Math.imul(h, 11) | 0) >>> 16
}

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
  if (!Array.isArray(blocks)) throw new Error("createScene requires an array of blocks")
  assets = scopedCache(await prepareAssets(assets))
  const rules = await blockRules(assets)
  const lightingArg = args.lighting ?? "world"
  const worldCfg = lightingArg && typeof lightingArg === "object" ? lightingArg : lightingArg === "world" ? {} : null
  const lighting = worldCfg ? "world" : lightingArg
  const optimize = args.optimize !== false
  const version = args.version
  const onProgress = args.onProgress
  const shouldCancel = args.shouldCancel

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

  const cells = new Map()
  const overlays = []
  const paletteIndex = new Map()
  const palette = []
  const blockPalette = new Uint32Array(blocks.length).fill(0xFFFFFFFF)
  const PK = (x, y, z) => ((x + 1048576) * 2048 + (y + 1024)) * 2097152 + (z + 1048576)
  const NO_PROPS = {}
  const piMemo = new WeakMap()
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (!b?.id || !b.pos) continue
    const id = normalize(b.id)
    const posKey = PK(b.pos[0], b.pos[1], b.pos[2])
    if (AIR_BLOCKS.test(id)) {
      cells.delete(posKey)
      continue
    }
    const biome = b.biome ?? args.biome ?? null
    let pi
    const po = b.nbt ? null : (b.properties ?? NO_PROPS)
    let byId = po ? piMemo.get(po) : null
    if (po) {
      if (!byId) piMemo.set(po, byId = new Map())
      const bk = biome == null ? id : id + "\0" + JSON.stringify(biome)
      pi = byId.get(bk)
      if (pi === undefined) {
        const stateKey = id + "\0" + JSON.stringify(b.properties ?? null) + "\0" + JSON.stringify(biome)
        pi = paletteIndex.get(stateKey)
        if (pi === undefined) {
          pi = palette.length
          paletteIndex.set(stateKey, pi)
          palette.push({ id, properties: b.properties ?? null, biome, nbt: null, pos: null, models: null })
        }
        byId.set(bk, pi)
      }
    } else {
      const stateKey = id + "\0" + JSON.stringify(b.properties ?? null) + "\0" + JSON.stringify(biome) + "\0" + JSON.stringify(b.nbt)
      pi = paletteIndex.get(stateKey)
      if (pi === undefined) {
        pi = palette.length
        paletteIndex.set(stateKey, pi)
        palette.push({ id, properties: b.properties ?? null, biome, nbt: b.nbt, pos: b.pos, models: null })
      }
    }
    blockPalette[i] = pi
    if (b.overlay) overlays.push({ pos: b.pos, palette: pi })
    else cells.set(posKey, { pos: b.pos, palette: pi, context: b.context === true })
  }

  enter("parse")
  for (const entry of palette) {
    entry.models = await parseBlockstate(assets, entry.id, {
      data: entry.properties ?? {}, biome: entry.biome ?? undefined, nbt: entry.nbt ?? undefined,
      mapArt: args.mapArt, pos: entry.pos ?? undefined, ignoreAtlases: args.ignoreAtlases, version
    })
    entry.flat = { id: entry.id, ...(entry.properties ?? {}) }
    entry.fluid = fluidTypeOf(entry.id, entry.properties, rules)
    entry.random = await hasRandomModels(assets, entry.id)
    await breathe()
    if (shouldCancel?.()) return null
  }
  const neighborAt = (pos, dx, dy, dz) => {
    const c = cells.get(PK(pos[0] + dx, pos[1] + dy, pos[2] + dz))
    if (!c) return null
    return { c, flat: palette[c.palette].flat }
  }
  const cullMemo = new Map()
  const templateOf = new Map()
  const templateSpecs = new Map()
  let parsed = 0
  for (const cell of cells.values()) {
    const entry = palette[cell.palette]

    if (cell.context || (!args.technical && TECHNICAL_BLOCKS.has(entry.id))) {
      cell.template = null
      continue
    }

    const px = cell.pos[0], py = cell.pos[1], pz = cell.pos[2]
    let cullKey = String(cell.palette)
    for (let di = 0; di < 6; di++) {
      const [dx, dy, dz] = DIR_VECS[di]
      const c = cells.get(PK(px + dx, py + dy, pz + dz))
      if (c) { _nbr[di] = c.palette; cullKey += "|" + c.palette }
      else if (args.externalOcclusion?.(px + dx, py + dy, pz + dz)) { _nbr[di] = -2; cullKey += "|X" }
      else { _nbr[di] = -1; cullKey += "|" }
    }
    let cull = cullMemo.get(cullKey)
    if (cull === undefined) {
      const neighbors = {}
      for (let di = 0; di < 6; di++) {
        if (_nbr[di] >= 0) neighbors[DIR_NAMES[di]] = palette[_nbr[di]].flat
        else if (_nbr[di] === -2) neighbors[DIR_NAMES[di]] = true
      }
      cull = await getCullFaces({ id: entry.id, blockstates: entry.properties ?? undefined, neighbors, assets, version })
      cullMemo.set(cullKey, cull)
    }
    cell.cull = cull.size ? cull : null

    let fh = null
    if (entry.fluid) {
      const hood = {}
      for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy && !dz) continue
        const n = neighborAt(cell.pos, dx, dy, dz)
        if (n) hood[cellKey3(dx, dy, dz)] = n.flat
      }
      hood.self = entry.flat
      fh = await fluidHeights(assets, entry.fluid, hood)
    }

    let seed = null
    if (entry.random) {
      seed = Math.imul((posHash(cell.pos[0], cell.pos[1], cell.pos[2]) & 15) + 1, 0x9E3779B1) >>> 0
    }
    const templateKey = cell.palette + "|" + (seed ?? "") + "|" + (fh ? JSON.stringify(fh) : "")
    cell.template = templateKey
    if (!templateSpecs.has(templateKey)) templateSpecs.set(templateKey, { entry, palette: cell.palette, seed, fh })

    if (++parsed % 256 === 0) {
      report(parsed, cells.size)
      await breathe()
      if (shouldCancel?.()) return null
    }
  }
  for (const o of overlays) {
    o.template = o.palette + "||"
    if (!templateSpecs.has(o.template)) templateSpecs.set(o.template, { entry: palette[o.palette], palette: o.palette, seed: null, fh: null })
  }
  report(1, 1)

  let light = givenLight
  if (computeLight) {
    enter("light")
    if (cells.size) {
      light = await computeSceneLight(Array.from(cells.values(), c => ({
        id: palette[c.palette].id, properties: palette[c.palette].properties ?? undefined, pos: c.pos
      })), { assets, version, dimension: worldCfg?.dimension, sliceMs: args.sliceMs })
    }
    report(1, 1)
    if (shouldCancel?.()) return null
  }
  const lightingOpt = worldCfg ? { ...worldCfg, light } : lighting

  enter("build")
  const group = new THREE.Group()
  let daytimeUniform = worldCfg ? { value: parseDaytime(worldCfg.daytime) } : null
  let tcache = templateCaches.get(assets.cache)
  if (!tcache) templateCaches.set(assets.cache, tcache = new Map())
  const usedEntries = []
  const envSig = (worldCfg ? JSON.stringify({ ...worldCfg, light: !!light, daytime: 0 }) : String(lighting))
    + "\0" + (args.shaderScale ?? "") + "\0" + (args.ignoreAtlases ? 1 : 0) + "\0" + (version ?? "") + "\0" + shaderSaltNow()
  const rebind = { daytime: daytimeUniform, ...(light?.uniforms ?? {}) }
  let built = 0
  for (const [key, spec] of templateSpecs) {
    const cacheable = !spec.entry.nbt && !spec.entry.pos
    const cacheKey = cacheable
      ? spec.entry.id + "\0" + JSON.stringify(spec.entry.properties) + "\0" + JSON.stringify(spec.entry.biome)
        + "\0" + (spec.seed ?? "") + "\0" + (spec.fh ? JSON.stringify(spec.fh) : "") + "\0" + envSig
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
      const models = spec.seed != null
        ? await parseBlockstate(assets, spec.entry.id, {
          data: spec.entry.properties ?? {}, biome: spec.entry.biome ?? undefined, nbt: spec.entry.nbt ?? undefined,
          mapArt: args.mapArt, pos: spec.entry.pos ?? undefined, seed: spec.seed, ignoreAtlases: args.ignoreAtlases, version
        })
        : spec.entry.models
      for (const model of models) {
        try {
          await loadModel(tmpl, assets, await resolveModelData(assets, model), {
            display: {}, animate: false, lighting: lightingOpt,
            shaderScale: args.shaderScale,
            block: { id: spec.entry.id, properties: spec.entry.properties ?? {} },
            fluidHeights: spec.fh, version
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

  let drawCalls = 0, tris = 0
  let optimized = null
  if (optimize) {
    enter("optimize")
    const placements = []
    for (const cell of cells.values()) {
      if (!cell.template) continue
      placements.push({ group: templateOf.get(cell.template), pos: cell.pos, cull: cell.cull })
    }
    for (const o of overlays) {
      placements.push({ group: templateOf.get(o.template), pos: o.pos, cull: null })
    }
    optimized = await optimizeScene(placements, {
      maxAtlas: args.maxAtlas, translucency: args.translucency, resortDistance: args.resortDistance, sliceMs,
      sharedAtlas: args.sharedAtlas,
      batchDynamics: args.batchDynamics,
      onProgress: (done, total) => report(done, total),
      shouldCancel
    })
    if (!optimized) return null
    group.add(optimized.group)
    drawCalls = optimized.drawCalls
    tris = optimized.tris
  } else {
    const cullVariants = new Map()
    for (const cell of cells.values()) {
      if (!cell.template) continue
      let tmpl = templateOf.get(cell.template)
      if (cell.cull) {
        const key = cell.template + "|" + Array.from(cell.cull).sort().join(",")
        let culled = cullVariants.get(key)
        if (culled === undefined) {
          const spec = templateSpecs.get(cell.template)
          culled = new THREE.Group()
          culled.userData.daytime = daytimeUniform
          const models = spec.seed != null
            ? await parseBlockstate(assets, spec.entry.id, {
              data: spec.entry.properties ?? {}, biome: spec.entry.biome ?? undefined,
              seed: spec.seed, ignoreAtlases: args.ignoreAtlases, version
            })
            : spec.entry.models
          for (const model of models) {
            try {
              await loadModel(culled, assets, await resolveModelData(assets, model), {
                display: {}, animate: false, lighting: lightingOpt, cull: cell.cull,
                shaderScale: args.shaderScale,
                block: { id: spec.entry.id, properties: spec.entry.properties ?? {} },
                fluidHeights: spec.fh, version
              })
            } catch {}
          }
          cullVariants.set(key, culled)
          templateOf.set(key, culled)
        }
        tmpl = culled
      }
      const inst = tmpl.clone()
      inst.position.set(cell.pos[0] * 16, cell.pos[1] * 16, cell.pos[2] * 16)
      group.add(inst)
      inst.traverse(o => {
        if (!o.isMesh) return
        if (o.userData.billboard) o.onBeforeRender = billboardBeforeRender
        drawCalls++
        tris += (o.geometry.index?.count ?? o.geometry.attributes.position?.count ?? 0) / 3
      })
      await breathe()
      if (shouldCancel?.()) return null
    }
    for (const o of overlays) {
      const inst = templateOf.get(o.template).clone()
      inst.position.set(o.pos[0] * 16, o.pos[1] * 16, o.pos[2] * 16)
      group.add(inst)
      inst.traverse(m => {
        if (!m.isMesh) return
        if (m.userData.billboard) m.onBeforeRender = billboardBeforeRender
        drawCalls++
        tris += (m.geometry.index?.count ?? m.geometry.attributes.position?.count ?? 0) / 3
      })
    }
  }

  const bounds = new THREE.Box3().setFromObject(group)

  let templates = null, blockTemplate = null
  if (args.keepTemplates) {
    templates = []
    const templateIdx = new Map()
    for (const [key, spec] of templateSpecs) {
      templateIdx.set(key, templates.length)
      templates.push({ palette: spec.palette, group: templateOf.get(key) })
    }
    blockTemplate = new Uint32Array(blocks.length).fill(0xFFFFFFFF)
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      if (!b?.pos) continue
      const cell = cells.get(PK(b.pos[0], b.pos[1], b.pos[2]))
      if (cell?.template) blockTemplate[i] = templateIdx.get(cell.template)
    }
  }

  return {
    group,
    palette,
    blockPalette,
    templates,
    blockTemplate,
    bounds,
    light,
    drawCalls,
    tris,
    sortTranslucent: camera => optimized?.sortTranslucent(camera),
    dispose() {
      optimized?.dispose()
      if (computeLight) light?.dispose?.()
      const cachedGeos = new Set()
      for (const e of usedEntries) e.group.traverse(o => { if (o.isMesh) cachedGeos.add(o.geometry) })
      if (!this.__released) {
        this.__released = true
        for (const e of usedEntries) e.users--
        sweepTemplateCache(tcache)
      }
      for (const t of templates ?? []) {
        t.group.traverse(o => {
          if (!o.isMesh) return
          if (!cachedGeos.has(o.geometry)) { try { o.geometry?.dispose() } catch {} }
          for (const m of [].concat(o.material)) { try { m?.dispose?.() } catch {} }
        })
      }
      group.traverse(o => {
        if (!o.isMesh) return
        for (const m of [].concat(o.material)) { try { m?.dispose?.() } catch {} }
        if (cachedGeos.has(o.geometry)) return
        try { o.geometry?.dispose() } catch {}
      })
      group.removeFromParent()
    }
  }
}
