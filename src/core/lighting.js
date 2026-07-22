import { THREE, normalize } from "./platform.js"
import { prepareAssets, scopedCache } from "./assets.js"
import { blockRules } from "./data.js"
import { parseBlockstate, resolveModelData, loadModel, defaultBlockstates, AIR_BLOCKS, LIGHT_DIMENSIONS } from "./models.js"
import { occludingFaces } from "./occlusion.js"
import { fluidTypeOf } from "./fluids.js"

const DIR = [
  { dx: -1, dy: 0, dz: 0, face: "west", opposite: "east" },
  { dx: 1, dy: 0, dz: 0, face: "east", opposite: "west" },
  { dx: 0, dy: -1, dz: 0, face: "down", opposite: "up" },
  { dx: 0, dy: 1, dz: 0, face: "up", opposite: "down" },
  { dx: 0, dy: 0, dz: -1, face: "north", opposite: "south" },
  { dx: 0, dy: 0, dz: 1, face: "south", opposite: "north" }
]

async function buildBlockModel(assets, id, props, version) {
  const g = new THREE.Group()
  for (const model of await parseBlockstate(assets, id, { data: props ?? {}, ignoreAtlases: true, version })) {
    if (model.model === "block-model-renderer:missing") return null
    await loadModel(g, assets, await resolveModelData(assets, model), { display: {}, animate: false })
  }
  return g
}

function isFullCube(masks) {
  if (!masks) return false
  for (const dir in masks) {
    const m = masks[dir]
    for (let v = 0; v < 16; v++) if (m[v] !== 0xffff) return false
  }
  return true
}

function maskEmpty(masks) {
  if (!masks) return true
  for (const dir in masks) {
    const m = masks[dir]
    for (let v = 0; v < 16; v++) if (m[v]) return false
  }
  return true
}

function unionCovers(a, b) {
  if (!a && !b) return false
  for (let v = 0; v < 16; v++) if (((a ? a[v] : 0) | (b ? b[v] : 0)) !== 0xffff) return false
  return true
}

export async function computeSceneLight(blocks, opts = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) throw new Error("computeSceneLight requires an array of blocks")
  if (opts.assets == null || opts.assets.length === 0) throw new Error("computeSceneLight requires the assets option")
  const assets = scopedCache(await prepareAssets(opts.assets))
  const version = opts.version
  const occCache = assets.cache.occlusion
  const defaults = await defaultBlockstates(assets)
  const rules = await blockRules(assets)

  function stateKey(bid, props) {
    let key = bid
    if (props) for (const k of Object.keys(props).sort()) key += "," + k + "=" + props[k]
    return key
  }

  async function masksFor(bid, props) {
    if (AIR_BLOCKS.test(bid)) return null
    const key = stateKey(bid, props)
    let m = occCache.get(key)
    if (m === undefined) {
      try {
        const g = await buildBlockModel(assets, bid, props, version)
        m = g ? occludingFaces(g, bid, false, rules) : null
      } catch { m = null }
      occCache.set(key, m)
    }
    return m
  }

  const cells = []
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const b of blocks) {
    if (!b?.id) continue
    const id = normalize(b.id)
    if (AIR_BLOCKS.test(id)) continue
    const [x, y, z] = b.pos ?? [b.x, b.y, b.z]
    cells.push({ x, y, z, id, properties: b.properties })
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  if (!cells.length) throw new Error("computeSceneLight requires at least one non-air block")

  const origin = [minX - 1, minY - 1, minZ - 1]
  const w = maxX - minX + 3, h = maxY - minY + 3, d = maxZ - minZ + 3
  const n = w * h * d
  const blockLight = new Uint8Array(n)
  const skyLight = new Uint8Array(n)

  const states = [null]
  const stateIds = new Map()
  const cellState = new Uint16Array(n)
  let processed = 0
  for (const c of cells) {
    const key = stateKey(c.id, c.properties)
    let si = stateIds.get(key)
    if (si === undefined) {
      const resolveDefault = k => {
        const raw = defaults.unique(c.id)[k] ?? defaults.properties[k]
        return Array.isArray(raw) ? raw[0] : raw
      }
      const masks = await masksFor(c.id, c.properties)
      const useShape = rules.shapeOcclusion(c.id, c.properties, resolveDefault) && !maskEmpty(masks)
      const partial = rules.dampening(c.id, c.properties, resolveDefault)
      states.push({
        emit: rules.emission(c.id, c.properties, resolveDefault),
        damp: isFullCube(masks) ? 15 : partial || (fluidTypeOf(c.id, c.properties, rules) ? 1 : 0),
        ao: rules.aoBlocking(c.id, c.properties, resolveDefault),
        masks: useShape ? masks : null
      })
      si = states.length - 1
      stateIds.set(key, si)
    }
    const i = ((c.z - origin[2]) * h + (c.y - origin[1])) * w + (c.x - origin[0])
    const prev = states[cellState[i]]
    const next = states[si]
    if (!prev || next.damp > prev.damp || (next.damp === prev.damp && next.emit > prev.emit)) cellState[i] = si
    if (++processed % 8192 === 0) {
      opts.onProgress?.(processed, cells.length)
      await new Promise(resolve => setTimeout(resolve))
    }
  }
  opts.onProgress?.(cells.length, cells.length)

  const strideY = w, strideZ = w * h

  const sliceMs = opts.sliceMs ?? 0
  let sliceT = performance.now()
  async function breathe() {
    if (!sliceMs || performance.now() - sliceT < sliceMs) return
    await new Promise(resolve => setTimeout(resolve))
    sliceT = performance.now()
  }

  async function spread(light) {
    const buckets = []
    for (let l = 0; l <= 15; l++) buckets[l] = []
    for (let i = 0; i < n; i++) if (light[i] > 1) buckets[light[i]].push(i)
    for (let lvl = 15; lvl >= 2; lvl--) {
      const bucket = buckets[lvl]
      for (let bi = 0; bi < bucket.length; bi++) {
        if (sliceMs && (bi & 2047) === 2047) await breathe()
        const i = bucket[bi]
        if (light[i] !== lvl) continue
        const x = i % w, r = (i / w) | 0, y = r % h, z = (r / h) | 0
        const fromMasks = states[cellState[i]]?.masks
        for (let di = 0; di < 6; di++) {
          const dir = DIR[di]
          if (dir.dx === -1 && x === 0) continue
          if (dir.dx === 1 && x === w - 1) continue
          if (dir.dy === -1 && y === 0) continue
          if (dir.dy === 1 && y === h - 1) continue
          if (dir.dz === -1 && z === 0) continue
          if (dir.dz === 1 && z === d - 1) continue
          const j = i + dir.dx + dir.dy * strideY + dir.dz * strideZ
          const to = states[cellState[j]]
          const nl = lvl - Math.max(1, to?.damp ?? 0)
          if (nl <= light[j]) continue
          const toMasks = to?.masks
          if ((fromMasks || toMasks) && unionCovers(fromMasks?.[dir.face], toMasks?.[dir.opposite])) continue
          light[j] = nl
          if (nl > 1) buckets[nl].push(j)
        }
      }
    }
  }

  const dimOpt = opts.dimension
  const hasSkyLight = (typeof dimOpt === "object" && dimOpt
    ? dimOpt.hasSkyLight
    : (LIGHT_DIMENSIONS[dimOpt] ?? LIGHT_DIMENSIONS.overworld).hasSkyLight) !== false
  if (hasSkyLight) {
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        let aboveMasks = null
        for (let y = h - 1; y >= 0; y--) {
          const i = (z * h + y) * w + x
          const state = states[cellState[i]]
          if (state && state.damp !== 0) break
          const masks = state?.masks
          if ((aboveMasks || masks) && unionCovers(aboveMasks?.down, masks?.up)) break
          skyLight[i] = 15
          aboveMasks = masks
        }
      }
    }
  }

  for (let i = 0; i < n; i++) {
    const emit = states[cellState[i]]?.emit
    if (emit) blockLight[i] = emit
  }

  await spread(blockLight)
  await spread(skyLight)

  const sampleBlock = new Uint8Array(blockLight)
  const sampleSky = new Uint8Array(skyLight)
  for (let i = 0; i < n; i++) {
    if (states[cellState[i]]?.damp !== 15) continue
    const x = i % w, r = (i / w) | 0, y = r % h, z = (r / h) | 0
    let bl = blockLight[i], sl = skyLight[i]
    if (x > 0) { bl = Math.max(bl, blockLight[i - 1]); sl = Math.max(sl, skyLight[i - 1]) }
    if (x < w - 1) { bl = Math.max(bl, blockLight[i + 1]); sl = Math.max(sl, skyLight[i + 1]) }
    if (y > 0) { bl = Math.max(bl, blockLight[i - strideY]); sl = Math.max(sl, skyLight[i - strideY]) }
    if (y < h - 1) { bl = Math.max(bl, blockLight[i + strideY]); sl = Math.max(sl, skyLight[i + strideY]) }
    if (z > 0) { bl = Math.max(bl, blockLight[i - strideZ]); sl = Math.max(sl, skyLight[i - strideZ]) }
    if (z < d - 1) { bl = Math.max(bl, blockLight[i + strideZ]); sl = Math.max(sl, skyLight[i + strideZ]) }
    sampleBlock[i] = bl
    sampleSky[i] = sl
  }

  const solidCell = new Uint8Array(n)
  const aoCell = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const st = states[cellState[i]]
    if (st?.damp === 15) solidCell[i] = 1
    if (st?.damp === 15 || st?.ao) aoCell[i] = 1
  }

  const W2 = w + 1, H2 = h + 1, D2 = d + 1
  const cols = Math.ceil(Math.sqrt(H2))
  const rows = Math.ceil(H2 / cols)
  const texW = cols * W2, texH = rows * D2
  const bytes = new Uint8Array(texW * texH * 4)
  const clampIdx = (x, y, z) => ((z < 0 ? 0 : z >= d ? d - 1 : z) * h + (y < 0 ? 0 : y >= h ? h - 1 : y)) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)
  for (let y = 0; y <= h; y++) {
    await breathe()
    const tx = (y % cols) * W2, ty = ((y / cols) | 0) * D2
    for (let z = 0; z <= d; z++) {
      let ti = ((ty + z) * texW + tx) * 4
      for (let x = 0; x <= w; x++, ti += 4) {
        let bl = 0, sl = 0, open = 0, blf = 0, slf = 0
        for (let dy = -1; dy <= 0; dy++) for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
          const ci = clampIdx(x + dx, y + dy, z + dz)
          if (solidCell[ci]) {
            blf += sampleBlock[ci]
            slf += sampleSky[ci]
          } else {
            bl += blockLight[ci]
            sl += skyLight[ci]
            open++
          }
        }
        bytes[ti] = Math.round((open ? bl / open : blf / 8) * 17)
        bytes[ti + 1] = Math.round((open ? sl / open : slf / 8) * 17)
        if (x < w && y < h && z < d && aoCell[(z * h + y) * w + x]) bytes[ti + 2] = 255
        bytes[ti + 3] = 255
      }
    }
  }
  const texture = new THREE.DataTexture(bytes, texW, texH)
  texture.minFilter = texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  const uniforms = {
    lightVol: { value: texture },
    lightVolOrigin: { value: new THREE.Vector3(...origin) },
    lightVolSize: { value: new THREE.Vector3(w, h, d) },
    lightVolTex: { value: new THREE.Vector2(texW, texH) },
    lightVolCols: { value: cols }
  }

  return {
    origin,
    size: [w, h, d],
    blockLight,
    skyLight,
    uniforms,
    lightAt(x, y, z) {
      const lx = x - origin[0], ly = y - origin[1], lz = z - origin[2]
      if (lx < 0 || ly < 0 || lz < 0 || lx >= w || ly >= h || lz >= d) return { block: 0, sky: 15 }
      const i = (lz * h + ly) * w + lx
      return { block: blockLight[i], sky: skyLight[i] }
    },
    setOffset(x = 0, y = 0, z = 0) {
      if (typeof x === "object") ({ x = 0, y = 0, z = 0 } = Array.isArray(x) ? { x: x[0], y: x[1], z: x[2] } : x)
      uniforms.lightVolOrigin.value.set(origin[0] + x / 16, origin[1] + y / 16, origin[2] + z / 16)
    },
    dispose() {
      texture.dispose()
    }
  }
}
