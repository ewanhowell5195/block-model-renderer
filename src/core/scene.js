import { THREE, parseJson, normalize, resolveNamespace } from "./platform.js"
import { prepareAssets, scopedCache, readFile } from "./assets.js"
import { parseBlockstate, resolveModelData, loadModel, billboardBeforeRender, AIR_BLOCKS, TECHNICAL_BLOCKS } from "./models.js"
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

  let sliceT = performance.now()
  async function breathe() {
    if (performance.now() - sliceT < 40) return
    await nextTask()
    sliceT = performance.now()
  }

  const cells = new Map()
  const paletteIndex = new Map()
  const palette = []
  const blockPalette = new Uint32Array(blocks.length).fill(0xFFFFFFFF)
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (!b?.id || !b.pos) continue
    const id = normalize(b.id)
    const posKey = b.pos[0] + "," + b.pos[1] + "," + b.pos[2]
    if (AIR_BLOCKS.test(id)) {
      cells.delete(posKey)
      continue
    }
    const biome = b.biome ?? args.biome ?? null
    const stateKey = id + "\0" + JSON.stringify(b.properties ?? null) + "\0" + JSON.stringify(biome)
    let pi = paletteIndex.get(stateKey)
    if (pi === undefined) {
      pi = palette.length
      paletteIndex.set(stateKey, pi)
      palette.push({ id, properties: b.properties ?? null, biome, models: null })
    }
    blockPalette[i] = pi
    cells.set(posKey, { pos: b.pos, palette: pi })
  }

  enter("parse")
  for (const entry of palette) {
    entry.models = await parseBlockstate(assets, entry.id, {
      data: entry.properties ?? {}, biome: entry.biome ?? undefined,
      ignoreAtlases: args.ignoreAtlases, version
    })
    await breathe()
    if (shouldCancel?.()) return null
  }
  const neighborAt = (pos, dx, dy, dz) => {
    const c = cells.get((pos[0] + dx) + "," + (pos[1] + dy) + "," + (pos[2] + dz))
    if (!c) return null
    const p = palette[c.palette]
    return { c, flat: { id: p.id, ...(p.properties ?? {}) } }
  }
  const cullMemo = new Map()
  const templateOf = new Map()
  const templateSpecs = new Map()
  let parsed = 0
  for (const cell of cells.values()) {
    const entry = palette[cell.palette]

    if (!args.technical && TECHNICAL_BLOCKS.has(entry.id)) {
      cell.template = null
      continue
    }

    const neighbors = {}
    let cullKey = String(cell.palette)
    for (const dir in DIRS) {
      const [dx, dy, dz] = DIRS[dir]
      const n = neighborAt(cell.pos, dx, dy, dz)
      if (n) neighbors[dir] = n.flat
      cullKey += "|" + (n ? n.c.palette : "")
    }
    let cull = cullMemo.get(cullKey)
    if (cull === undefined) {
      cull = await getCullFaces({ id: entry.id, blockstates: entry.properties ?? undefined, neighbors, assets, version })
      cullMemo.set(cullKey, cull)
    }
    cell.cull = cull.size ? cull : null

    let fh = null
    if (fluidTypeOf(entry.id, entry.properties, rules)) {
      const hood = {}
      for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy && !dz) continue
        const n = neighborAt(cell.pos, dx, dy, dz)
        if (n) hood[cellKey3(dx, dy, dz)] = n.flat
      }
      hood[""] = { id: entry.id, ...(entry.properties ?? {}) }
      fh = await fluidHeights(assets, fluidTypeOf(entry.id, entry.properties, rules), hood)
    }

    let seed = null
    if (await hasRandomModels(assets, entry.id)) {
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
  report(1, 1)

  let light = givenLight
  if (computeLight) {
    enter("light")
    if (cells.size) {
      light = await computeSceneLight(Array.from(cells.values(), c => ({
        id: palette[c.palette].id, properties: palette[c.palette].properties ?? undefined, pos: c.pos
      })), { assets, version, dimension: worldCfg?.dimension })
    }
    report(1, 1)
    if (shouldCancel?.()) return null
  }
  const lightingOpt = worldCfg ? { ...worldCfg, light } : lighting

  enter("build")
  const group = new THREE.Group()
  let daytimeUniform = null
  let built = 0
  for (const [key, spec] of templateSpecs) {
    const tmpl = new THREE.Group()
    if (daytimeUniform) tmpl.userData.daytime = daytimeUniform
    const models = spec.seed != null
      ? await parseBlockstate(assets, spec.entry.id, {
        data: spec.entry.properties ?? {}, biome: spec.entry.biome ?? undefined,
        seed: spec.seed, ignoreAtlases: args.ignoreAtlases, version
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
    if (++built % 16 === 0) {
      report(built, templateSpecs.size)
      await breathe()
      if (shouldCancel?.()) return null
    }
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
    optimized = await optimizeScene(placements, {
      maxAtlas: args.maxAtlas, translucency: args.translucency, resortDistance: args.resortDistance,
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
      const cell = cells.get(b.pos[0] + "," + b.pos[1] + "," + b.pos[2])
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
      for (const t of templates ?? []) {
        t.group.traverse(o => {
          if (!o.isMesh) return
          try { o.geometry?.dispose() } catch {}
          for (const m of [].concat(o.material)) { try { m?.dispose?.() } catch {} }
        })
      }
      group.traverse(o => {
        if (!o.isMesh) return
        try { o.geometry?.dispose() } catch {}
        for (const m of [].concat(o.material)) { try { m?.dispose?.() } catch {} }
      })
      group.removeFromParent()
    }
  }
}
