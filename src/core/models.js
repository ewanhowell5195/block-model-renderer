import { THREE, Canvas, loadImage, loadTexture, AXIS_VECTORS, UV_CENTER, parseJson, normalize, resolveNamespace, isBefore } from "./platform.js"
import { COLORS, parseColor, getPotionColor } from "./colors.js"
import { blockRules, colorTables, itemRules } from "./data.js"
import { fluidHeights } from "./fluids.js"
import { prepareAssets, readFile, readFileAll, readOverlayFile, getMissingImage, getAtlasesContaining } from "./assets.js"
import { buildAnimation } from "./animation.js"
import { modelLoaders, activeLoaders } from "./loaders.js"
import { mapArtFor, mapIdOf } from "./maps.js"

const LEGACY_ITEM_PROPS = { holder_type: "context_entity_type", shift_down: "extended_view" }

export const SKIP_BLOCKS = new Set(["air", "cave_air", "void_air", "moving_piston"])
export const TECHNICAL_BLOCKS = new Set(["barrier", "light", "structure_void"])
export const AIR_BLOCKS = new RegExp(`(^|:)(${Array.from(SKIP_BLOCKS).join("|")})$`)

const X_CYCLE = { north: "up", up: "south", south: "down", down: "north" }
const Y_CYCLE = { north: "east", east: "south", south: "west", west: "north" }

const CULL_VECS = {
  east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
  south: [0, 0, 1], north: [0, 0, -1], top: [0, 1, 0], bottom: [0, -1, 0]
}

const SHADE_DIR_VECS = {
  east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
  south: [0, 0, 1], north: [0, 0, -1]
}

const NAMED_TIMES = { day: 1000, noon: 6000, sunset: 12000, night: 13000, midnight: 18000, sunrise: 23000 }

const dynamicStates = new WeakMap()

function dynState(root) {
  let s = dynamicStates.get(root)
  if (!s) dynamicStates.set(root, s = { openness: 0, target: null, last: null, auto: true, frame: -1, book: null })
  return s
}

export function poseSpecial(root, data = {}) {
  const kind = root?.userData?.dynamic
  if (!kind) return
  const s = dynState(root)
  if (kind === "banner" || kind === "dragon_head" || kind === "enchanting_book" || kind === "piglin_head") {
    s.auto = false
  } else if (kind === "bell") {
    s.ring = null
  } else if (kind === "decorated_pot") {
    s.wobble = null
  } else {
    s.openness = data.openness ?? 0
    s.target = null
    s.last = null
  }
  applyDynamicPose(root, data)
}

export function initDynamic(root) {
  const kind = root.userData?.dynamic
  if (!kind) return
  if (kind === "bell") {
    root.ring = direction => { dynState(root).ring = { t0: dynNow(), dir: typeof direction === "string" ? direction : "north" } }
  }
  if (kind === "chest" || kind === "shulker_box") {
    root.open = () => { dynState(root).target = 1 }
    root.close = () => { dynState(root).target = 0 }
  }
  if (kind === "decorated_pot") {
    root.wobble = style => { dynState(root).wobble = { t0: dynNow(), style: style === "negative" ? "negative" : "positive" } }
  }
  root.traverse(o => { if (o.isMesh) o.onBeforeRender = dynamicBeforeRender })
}

const dynNow = () => typeof performance !== "undefined" ? performance.now() : Date.now()

function dynamicBeforeRender(renderer, scene, camera) {
  let root = this
  while (root && !root.userData?.dynamic) root = root.parent
  if (root) dynamicFrame(root, renderer, camera)
}

const PRIME_RENDERER = { info: { render: { frame: -1 } } }
let _primeCamera = null
export function primeDynamic(root) {
  _primeCamera ??= new THREE.Object3D()
  dynamicFrame(root, PRIME_RENDERER, _primeCamera)
}

export function dynamicFrame(root, renderer, camera) {
  const s = dynState(root)
  const frame = renderer.info.render.frame
  if (s.frame === frame) return s.moved
  s.frame = frame
  const now = dynNow()
  const kind = root.userData.dynamic
  let moved
  if (kind === "banner") moved = bannerFrame(root, s, now)
  else if (kind === "bell") moved = bellFrame(root, s, now)
  else if (kind === "decorated_pot") moved = potFrame(root, s, now)
  else if (kind === "dragon_head" || kind === "piglin_head") moved = headFrame(root, s, now)
  else if (kind === "enchanting_book") moved = bookFrame(root, s, camera, now)
  else moved = lidFrame(root, s, now)
  s.moved = !!moved
  if (s.moved) root.updateWorldMatrix(false, true)
  return s.moved
}

function lidFrame(root, s, now) {
  if (s.target === null) return
  if (s.last === null) s.last = now
  const dt = Math.min(now - s.last, 250)
  s.last = now
  const d = s.target - s.openness
  const step = dt / 500
  if (Math.abs(d) <= step) {
    s.openness = s.target
    s.target = null
    s.last = null
  } else {
    s.openness += Math.sign(d) * step
  }
  applyDynamicPose(root, { openness: s.openness })
  return true
}

function bannerFrame(root, s, now) {
  if (!s.auto) return
  if (s.seed === undefined) {
    _dcam ??= new THREE.Vector3()
    const p = _dcam.setFromMatrixPosition(root.matrixWorld)
    const hash = Math.floor(p.x / 16) * 7 + Math.floor(p.y / 16) * 9 + Math.floor(p.z / 16) * 13
    s.seed = (hash % 100 + 100) % 100
    s.t0 = now
  }
  applyDynamicPose(root, { phase: ((s.seed + (now - s.t0) / 50) % 100) / 100 })
  return true
}

function bellFrame(root, s, now) {
  if (!s.ring) return
  const ticks = (now - s.ring.t0) / 50
  if (ticks >= 50) {
    applyDynamicPose(root, {})
    s.ring = null
    return true
  }
  applyDynamicPose(root, { ticks, direction: s.ring.dir })
  return true
}

function headFrame(root, s, now) {
  if (!s.auto) return
  s.t0 ??= now
  const p = (now - s.t0) / 50 * Math.PI * 0.2
  if (root.userData.dynamic === "dragon_head") {
    applyDynamicPose(root, { openness: (Math.sin(p) + 1) / 2 })
  } else {
    applyDynamicPose(root, { left: (1 - Math.cos(p * 1.2)) / 2, right: (1 - Math.cos(p)) / 2 })
  }
  return true
}

function potFrame(root, s, now) {
  if (!s.wobble) return
  const duration = s.wobble.style === "negative" ? 10 : 7
  const progress = (now - s.wobble.t0) / 50 / duration
  if (progress >= 1) {
    applyDynamicPose(root, {})
    s.wobble = null
    return true
  }
  applyDynamicPose(root, { style: s.wobble.style, progress })
  return true
}

const wrapRad = v => {
  while (v >= Math.PI) v -= Math.PI * 2
  while (v < -Math.PI) v += Math.PI * 2
  return v
}

let _dcam
function bookFrame(root, s, camera, now) {
  if (!s.auto) return
  let b = s.book
  if (!b) {
    const rot = -Math.PI / 2
    b = s.book = { time: 0, rot, oRot: rot, tRot: rot, open: 0, oOpen: 0, flip: 0, oFlip: 0, flipT: 0, flipA: 0, acc: 0, last: null }
  }
  if (b.last === null) b.last = now
  b.acc = Math.min(b.acc + (now - b.last), 250)
  b.last = now
  _dcam ??= new THREE.Vector3()
  const cam = _dcam.setFromMatrixPosition(camera.matrixWorld)
  root.parent?.worldToLocal(cam)
  const range = (root.userData.range ?? 3) * 16
  while (b.acc >= 50) {
    b.acc -= 50
    bookTick(b, cam, range, root.position)
  }
  const partial = b.acc / 50
  applyDynamicPose(root, {
    time: b.time + partial,
    rot: b.oRot + wrapRad(b.rot - b.oRot) * partial,
    open: b.oOpen + (b.open - b.oOpen) * partial,
    flip: b.oFlip + (b.flip - b.oFlip) * partial
  })
  return true
}

function bookTick(b, cam, range, pos) {
  b.oOpen = b.open
  b.oRot = b.rot
  const dx = cam.x - pos.x, dy = cam.y - pos.y, dz = cam.z - pos.z
  if (dx * dx + dy * dy + dz * dz < range * range) {
    b.tRot = Math.atan2(dz, dx)
    b.open += 0.1
    if (b.open < 0.5 || Math.floor(Math.random() * 40) === 0) {
      const prev = b.flipT
      do {
        b.flipT += Math.floor(Math.random() * 4) - Math.floor(Math.random() * 4)
      } while (prev === b.flipT)
    }
  } else {
    b.tRot += 0.02
    b.open -= 0.1
  }
  b.rot = wrapRad(b.rot)
  b.tRot = wrapRad(b.tRot)
  b.rot += wrapRad(b.tRot - b.rot) * 0.4
  b.open = Math.max(0, Math.min(1, b.open))
  b.time++
  b.oFlip = b.flip
  let f = (b.flipT - b.flip) * 0.4
  f = Math.max(-0.2, Math.min(0.2, f))
  b.flipA += (f - b.flipA) * 0.9
  b.flip += b.flipA
}

const _pm = [], _pt = []
function applyDynamicPose(root, data = {}) {
  const kind = root?.userData?.dynamic
  if (!kind) return
  const parts = []
  root.traverse(o => { if (o.name?.startsWith("part:")) parts.push(o) })
  if (kind === "banner") {
    const a = (0.0125 - 0.01 * Math.cos(Math.PI * 2 * (data.phase ?? 0))) * Math.PI
    for (const g of parts) {
      if (g.name !== "part:flag") continue
      g.rotation.set(a, 0, 0)
    }
    return
  }
  if (kind === "bell") {
    let x = 0, z = 0
    if (data.direction) {
      const ticks = data.ticks ?? 0
      const r = Math.sin(ticks / Math.PI) / (4 + ticks / 3)
      if (data.direction === "north") x = -r
      else if (data.direction === "south") x = r
      else if (data.direction === "east") z = -r
      else if (data.direction === "west") z = r
    }
    for (const g of parts) {
      if (g.name !== "part:bell_body") continue
      g.rotation.set(x, 0, z)
    }
    return
  }
  if (kind === "chest") {
    const eased = 1 - (1 - (data.openness ?? 0)) ** 3
    for (const g of parts) {
      if (g.name !== "part:lid") continue
      g.rotation.set(0, 0, 0)
      g.rotateOnAxis(AXIS_VECTORS[g.userData.partAxis ?? "x"], THREE.MathUtils.degToRad(eased * 90))
    }
    return
  }
  if (kind === "decorated_pot") {
    let rx = 0, ry = 0, rz = 0
    const t = data.progress ?? 0
    if (t >= 0 && t <= 1) {
      if (data.style === "positive") {
        const dt = t * Math.PI * 2
        rx = -1.5 * (Math.cos(dt) + 0.5) * Math.sin(dt / 2) * 0.015625
        rz = Math.sin(dt) * 0.015625
      } else if (data.style === "negative") {
        ry = Math.sin(-t * 3 * Math.PI) * 0.125 * (1 - t)
      }
    }
    for (const g of parts) {
      if (g.name !== "part:pot") continue
      g.rotation.set(rx, ry, rz)
    }
    return
  }
  if (kind === "dragon_head") {
    const a = -(data.openness ?? 0) * 0.4
    for (const g of parts) {
      if (g.name !== "part:jaw") continue
      g.rotation.set(0, 0, 0)
      g.rotateOnAxis(AXIS_VECTORS[g.userData.partAxis ?? "x"], a)
    }
    return
  }
  if (kind === "enchanting_book") {
    const time = data.time ?? 0
    const open = data.open ?? 0
    const rot = data.rot ?? -Math.PI / 2
    const flip = data.flip ?? 0
    const f = (Math.sin(time * 0.02) * 0.1 + 1.25) * open
    const frac = v => v - Math.floor(v)
    const clamp01 = v => Math.max(0, Math.min(1, v))
    const flipR = clamp01(frac(flip + 0.25) * 1.6 - 0.3)
    const flipL = clamp01(frac(flip + 0.75) * 1.6 - 0.3)
    const hover = (0.1 + Math.sin(time * 0.1) * 0.01) * 16
    _pm[0] ??= new THREE.Matrix4()
    _pm[1] ??= new THREE.Matrix4()
    _pm[2] ??= new THREE.Matrix4()
    const R = _pm[0].makeTranslation(0, 4 + hover, 0)
      .multiply(_pm[1].makeRotationY(-rot))
      .multiply(_pm[2].makeRotationZ(THREE.MathUtils.degToRad(80)))
    const sx = Math.sin(f)
    const POSE = {
      cover_left: [Math.PI + f, 0],
      cover_right: [-f, 0],
      book_spine: [Math.PI / 2, 0],
      pages_left: [f, sx],
      pages_right: [-f, sx],
      flipping_page_right: [f - f * 2 * flipR, sx],
      flipping_page_left: [f - f * 2 * flipL, sx]
    }
    _pt[0] ??= new THREE.Matrix4()
    _pt[1] ??= new THREE.Matrix4()
    for (const g of parts) {
      const pose = POSE[g.name.slice(5)]
      if (!pose) continue
      const p = g.userData.partPivot ?? [0, 0, 0]
      _pt[0].copy(R)
        .multiply(_pt[1].makeTranslation(p[0] + pose[1], p[1], p[2]))
        .multiply(new THREE.Matrix4().makeRotationY(pose[0]))
      _pt[0].decompose(g.position, g.quaternion, g.scale)
    }
    return
  }
  if (kind === "piglin_head") {
    const POSE = {
      left_ear: -(0.7 - (data.left ?? 0) * 0.4),
      right_ear: 0.7 - (data.right ?? 0) * 0.4
    }
    for (const g of parts) {
      const a = POSE[g.name.slice(5)]
      if (a === undefined) continue
      g.rotation.set(0, 0, 0)
      g.rotateOnAxis(AXIS_VECTORS[g.userData.partAxis ?? "z"], a)
    }
    return
  }
  if (kind === "shulker_box") {
    for (const g of parts) {
      if (g.name !== "part:lid") continue
      const p = g.userData.partPivot ?? [0, 0, 0]
      g.position.set(p[0], p[1] + (data.openness ?? 0) * 8, p[2])
      g.rotation.set(0, 0, 0)
      g.rotateOnAxis(AXIS_VECTORS[g.userData.partAxis ?? "y"], THREE.MathUtils.degToRad((data.openness ?? 0) * 270))
    }
  }
}

let _bbPos, _bbQuat, _bbFlip, _bbScale
export function billboardBeforeRender(renderer, scene, camera) {
  _bbPos ??= new THREE.Vector3()
  _bbQuat ??= new THREE.Quaternion()
  _bbFlip ??= new THREE.Quaternion(0, 1, 0, 0)
  _bbScale ??= new THREE.Vector3()
  const m = this.matrixWorld
  _bbPos.setFromMatrixPosition(m)
  _bbScale.setFromMatrixScale(m)
  m.compose(_bbPos, camera.getWorldQuaternion(_bbQuat).multiply(_bbFlip), _bbScale)
}

const CARDINAL_LIGHTS = {
  default: { down: 0.5, up: 1, north: 0.8, south: 0.8, west: 0.6, east: 0.6 },
  nether: { down: 0.9, up: 0.9, north: 0.8, south: 0.8, west: 0.6, east: 0.6 }
}

export const LIGHT_DIMENSIONS = {
  overworld: { skyLightFactor: "overworld", skyLightColor: 0x7A7AFF, ambientColor: 0x0A0A0A, blockLightTint: 0xFFD88C, cardinalLight: "default", hasSkyLight: true },
  the_nether: { skyLightFactor: 0, skyLightColor: 0x7A7AFF, ambientColor: 0x302821, blockLightTint: 0xFFD88C, cardinalLight: "nether", hasSkyLight: false },
  the_end: { skyLightFactor: 0, skyLightColor: 0xAC60CD, ambientColor: 0x3F473F, blockLightTint: 0xFFD88C, cardinalLight: "default", hasSkyLight: true }
}

export function resolveWorldLighting(param) {
  const o = param && typeof param === "object" ? param : {}
  const d = o.dimension
  const dim = typeof d === "object" && d
    ? { ...LIGHT_DIMENSIONS.overworld, ...d }
    : LIGHT_DIMENSIONS[d] ?? LIGHT_DIMENSIONS.overworld
  const c = dim.cardinalLight
  const cardinal = typeof c === "object" && c ? { ...CARDINAL_LIGHTS.default, ...c } : CARDINAL_LIGHTS[c] ?? CARDINAL_LIGHTS.default
  return { dim, cardinal, daytime: o.daytime, brightness: Math.max(0, Math.min(1, o.brightness ?? 0.5)), light: o.light }
}

function parseDaytime(v) {
  if (v == null) return NAMED_TIMES.noon
  if (typeof v === "number") return ((v % 24000) + 24000) % 24000
  return NAMED_TIMES[String(v).toLowerCase()] ?? NAMED_TIMES.noon
}

function parseTransformation(t) {
  if (!t) return null
  if (Array.isArray(t)) {
    return new THREE.Matrix4().fromArray(t)
  }
  const mat = new THREE.Matrix4()
  const [tx, ty, tz] = t.translation || [0, 0, 0]
  const T = new THREE.Matrix4().makeTranslation(tx * 16, ty * 16, tz * 16)
  const L = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...(t.left_rotation || [0, 0, 0, 1])))
  const rawScale = t.scale || [1, 1, 1]
  const S = new THREE.Matrix4().makeScale(...rawScale.map(s => s === 0 ? 0.001 : s))
  const R = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...(t.right_rotation || [0, 0, 0, 1])))
  mat.multiply(T).multiply(L).multiply(S).multiply(R)
  return mat
}

function composeTransformations(parent, child) {
  if (!parent && !child) return null
  if (!parent) return child
  if (!child) return parent
  return new THREE.Matrix4().copy(parent).multiply(child)
}

export async function defaultBlockstates(assets) {
  return assets.defaultBlockstates ??= (async () => {
    const properties = {}
    const rules = []
    for (const buf of await readFileAll("assets/block-model-renderer/default_blockstates.json", assets)) {
      let json
      try { json = parseJson(buf) } catch { continue }
      for (const [key, value] of Object.entries(json.properties ?? {})) {
        if (!(key in properties)) properties[key] = value
      }
      for (const rule of json.blocks ?? []) {
        if (!rule?.match || !rule.defaults) continue
        rules.push({
          patterns: rule.match.split("|").map(pattern => new RegExp("^" + pattern.replace(/\*/g, ".*") + "$")),
          value: rule.defaults
        })
      }
    }
    const matched = new Map()
    function unique(block) {
      let hit = matched.get(block)
      if (hit === undefined) {
        hit = rules.find(rule => rule.patterns.some(regex => regex.test(block)))?.value ?? {}
        matched.set(block, hit)
      }
      return hit
    }
    return { properties, unique }
  })()
}

function getMultipartDefaults(multipart) {
  const first = {}
  function walk(when) {
    if (!when) return
    if (when.OR)  { walk(when.OR[0]); return }
    if (when.AND) { for (const s of when.AND) walk(s); return }
    for (const [k, v] of Object.entries(when)) {
      if (!(k in first)) first[k] = String(v).split("|")[0]
    }
  }
  for (const part of multipart) walk(part.when)
  return first
}

function seededRandom(seed) {
  let a = seed | 0
  return () => {
    a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function pickWeighted(value, rand) {
  if (!Array.isArray(value)) return value
  if (!rand || value.length <= 1) return value[0]
  let total = 0
  for (const entry of value) total += entry.weight ?? 1
  let r = rand() * total
  for (const entry of value) {
    r -= entry.weight ?? 1
    if (r < 0) return entry
  }
  return value[value.length - 1]
}

export async function parseBlockstate(assets, blockstate, args) {
  if (!blockstate) throw new Error("parseBlockstate requires a blockstate id")
  if (AIR_BLOCKS.test(blockstate)) return []
  if (assets == null || assets.length === 0) throw new Error("parseBlockstate requires assets")
  let data = args?.data ?? {}
  const rand = args?.seed != null ? seededRandom(args.seed) : null
  assets = await prepareAssets(assets, args?.version ? { version: args.version } : undefined)
  const defaults = await defaultBlockstates(assets)
  const rules = await blockRules(assets)
  const colors = await colorTables(assets)

  const { namespace, item: block } = resolveNamespace(blockstate)

  let frameMapArt = null
  if (args?.nbt && /^(glow_)?item_frame$/.test(block) && /(^|:)filled_map$/.test(args.nbt.Item?.id ?? "")) {
    frameMapArt = await mapArtFor(assets, mapIdOf(args.nbt.Item), args.mapArt, { pos: args.pos, facing: data.facing ?? "north", nbt: args.nbt })
    if (!frameMapArt) data = { ...data, map: "false" }
  }

  let buf = await readFile(`assets/${namespace}/blockstates/${block}.json`, assets)
  const overlayBuf = await readOverlayFile(`assets/${namespace}/blockstates/${block}.json`, assets)
  if (buf && assets[buf.hintIndex]?.overrideRole === "additional") buf = null

  if (!buf && !overlayBuf) {
    if (rules.waterlogged(block)) return [waterPart(colors)]
    const m = { type: "block", model: "block-model-renderer:missing" }
    if (args?.ignoreAtlases) m.ignore_atlas_restrictions = true
    if (args?.version) m.version = args.version
    return [m]
  }

  const models = []
  let invalid = false
  if (buf) collectStateModels(parseJson(buf))
  if (overlayBuf) collectStateModels(parseJson(overlayBuf))
  if (invalid) return ["block-model-renderer:missing.json"]

  function collectStateModels(json) {

    const start = models.length

    if (json.variants) {
      const variants = Object.entries(json.variants)

      const scored = variants.map(([key, value]) => {
        let score = 0
        if (key === "") {
          score = 0.1
        } else {
          const parts = key.split(",").map(s => s.trim())
          score = parts.reduce((acc, part) => {
            const [k, v] = part.split("=")
            const raw = data[k] ?? defaults.unique(blockstate)[k] ?? defaults.properties[k]
            const actuals = Array.isArray(raw) ? raw.map(e => e.toString()) : [raw?.toString()]
            const index = actuals.indexOf(v)
            if (index === -1) return acc
            return acc + (actuals.length - index)
          }, 0)
        }

        return { score, value }
      }).filter(e => Array.isArray(e.value) ? e.value.length : e.value)

      if (scored.length > 0) {
        scored.sort((a, b) => b.score - a.score)
        models.push(pickWeighted(scored[0].value, rand))
      }
    } else if (json.multipart) {
      const ranges = new Set
      const multipartDefaults = getMultipartDefaults(json.multipart)

      const scoredParts = json.multipart.map((part, index) => {
        const when = part.when
        if (!when) return { score: 0, values: [], part, index, match: true }

        const conds = when.OR ?? when.AND ?? [when]
        const isOr = !!when.OR

        let score = 0
        let match = isOr ? false : true

        const values = {}

        for (const cond of conds) {
          const matches = Object.entries(cond).every(([k, v]) => {
            const allowed = v.toString().split("|")
            const raw = data[k] ?? defaults.unique(blockstate)[k] ?? defaults.properties[k] ?? multipartDefaults[k]
            let actuals
            if (Array.isArray(raw)) {
              actuals = raw.map(e => e.toString())
              ranges.add(k)
            } else {
              actuals = [raw?.toString()]
            }
            const matchIndex = actuals.findIndex(val => allowed.includes(val ?? "none"))
            if (matchIndex !== -1) score += actuals.length - matchIndex
            return matchIndex !== -1
          })

          if (matches) {
            for (const key in cond) {
              values[key] = cond[key]
            }
          }

          if (isOr && matches) {
            match = true
            break
          }
          if (!isOr && !matches) {
            match = false
            break
          }
        }

        return { score, values: Object.entries(values), part, index, match }
      }).filter(p => p.match)

      const usedKeyValues = {}

      scoredParts
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .forEach(({ values, part }) => {
          if (values.some(([k, v]) => usedKeyValues[k] && usedKeyValues[k] !== v)) return
          for (const [key, value] of values) {
            if (ranges.has(key)) {
              usedKeyValues[key] = value
            }
          }
          const apply = pickWeighted(part.apply, rand)
          if (apply?.model) models.push(apply)
        })
    }

    for (const model of models.slice(start)) {
      if (args?.version && isBefore(args.version, "1.21.11")) delete model.z
      if (json.allow_invalid_rotations) {
        model.allow_invalid_rotations = true
      } else if (model.x && model.x % 90 !== 0 || model.y && model.y % 90 !== 0 || model.z && model.z % 90 !== 0) {
        invalid = true
      }
    }
  }

  for (const model of models) {
    model.type = "block"
    if (args?.ignoreAtlases) model.ignore_atlas_restrictions = true
    if (args?.version) model.version = args.version
    if (args?.version && isBefore(args.version, "1.13")) {
      const i = model.model.indexOf(":") + 1
      if (!model.model.slice(i).includes("/")) {
        model.model = model.model.slice(0, i) + "block/" + model.model.slice(i)
      }
    }

    if (colors.colormapBlocks[block]) {
      const tint = await getBiomeTint(assets, colors.colormapBlocks[block], args?.biome)
      const index = colors.tables.tintindex[block] ?? 0
      model.tints = []
      for (let t = 0; t <= index; t++) model.tints.push(t === index ? tint : "#FFFFFF")
    } else if (colors.tables.fixed[block]) {
      model.tints = [colors.tables.fixed[block]]
    } else if (colors.tables.indexed[block]) {
      const entry = colors.tables.indexed[block]
      model.tints = [entry.colors[data[entry.property]] ?? entry.colors[entry.default]]
    }

    if (block === "end_portal" || block == "end_gateway") {
      model.shader = {
        type: "end_portal",
        layers: block === "end_portal" ? 15 : 16
      }
    }

    if (block === "water" || block === "flowing_water") model.fluid = "water"
    else if (block === "lava" || block === "flowing_lava") model.fluid = "lava"
  }

  if (((data?.waterlogged === true || data?.waterlogged === "true") && rules.waterloggable(block)) || rules.waterlogged(block)) {
    models.push(waterPart(colors))
  }

  if (args?.nbt) {
    if (/(^|_)banner$/.test(block)) {
      const patterns = bannerPatternsOf(args.nbt)
      if (patterns.length) {
        for (const m of models) if (m && typeof m === "object") m.banner_patterns = patterns
      }
    }
    let drop = false
    const extra = await blockEntityItemModels(assets, block, data, { ...args, frameMapArt, dropModels: () => { drop = true } })
    if (drop) models.length = 0
    models.push(...extra)
  }

  return models
}

const LEGACY_BANNER_PATTERNS = {
  bl: "square_bottom_left", br: "square_bottom_right", tl: "square_top_left", tr: "square_top_right",
  bs: "stripe_bottom", ts: "stripe_top", ls: "stripe_left", rs: "stripe_right", cs: "stripe_center",
  ms: "stripe_middle", drs: "stripe_downright", dls: "stripe_downleft", ss: "small_stripes",
  cr: "cross", sc: "straight_cross", bt: "triangle_bottom", tt: "triangle_top",
  bts: "triangles_bottom", tts: "triangles_top", ld: "diagonal_left", rd: "diagonal_right",
  lud: "diagonal_up_left", rud: "diagonal_up_right", mc: "circle", mr: "rhombus",
  vh: "half_vertical", hh: "half_horizontal", vhr: "half_vertical_right", hhb: "half_horizontal_bottom",
  bo: "border", cbo: "curly_border", gra: "gradient", gru: "gradient_up", bri: "bricks",
  glb: "globe", cre: "creeper", sku: "skull", flo: "flower", moj: "mojang", pig: "piglin"
}
const DYE_ORDER = ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"]

function bannerPatternsOf(nbt) {
  const list = Array.isArray(nbt.patterns) ? nbt.patterns : Array.isArray(nbt.Patterns) ? nbt.Patterns : []
  const out = []
  for (const entry of list) {
    if (!entry) continue
    const pattern = entry.pattern ?? entry.Pattern?.asset_id ?? LEGACY_BANNER_PATTERNS[entry.Pattern]
    if (!pattern) continue
    out.push({ pattern, color: entry.color ?? DYE_ORDER[entry.Color] ?? "white" })
  }
  return out
}

const FRAME_ITEM_ROT = { south: [0, Math.PI], west: [0, Math.PI / 2], east: [0, -Math.PI / 2], up: [-Math.PI / 2, Math.PI], down: [Math.PI / 2, Math.PI] }
const SHELF_ITEM_YAW = { south: 0, west: -Math.PI / 2, north: Math.PI, east: Math.PI / 2 }
const LIVE_FRAME_ITEM = /(^|:)(compass|clock)$/
const itemComponent = (item, key) => item?.components?.[key] ?? item?.components?.["minecraft:" + key]

function itemHasFoil(item, rules) {
  if (typeof item?.id !== "string") return false
  const override = itemComponent(item, "enchantment_glint_override")
  if (override != null) return !(override === false || override === 0 || override === "false")
  const id = normalize(item.id)
  if (rules.alwaysGlint(id)) return true
  if (/(^|:)compass$/.test(id) && (itemComponent(item, "lodestone_tracker") != null || item.tag?.LodestonePos != null || item.tag?.LodestoneTracked)) return true
  const enchantments = itemComponent(item, "enchantments")
  const levels = enchantments?.levels ?? enchantments
  if (levels && typeof levels === "object" && Object.keys(levels).length) return true
  return Array.isArray(item.tag?.Enchantments) && item.tag.Enchantments.length > 0
}

async function blockEntityItemModels(assets, block, data, args) {
  const nbt = args.nbt
  const out = []
  const context = block.endsWith("shelf") ? "on_shelf" : "fixed"
  const glintRules = await itemRules(assets)
  const itemArgs = id => ({
    version: args.version,
    ignoreAtlases: args.ignoreAtlases,
    data: id.components ?? {},
    glint: itemHasFoil(id, glintRules) || undefined,
    display: { type: "fallback", display: context }
  })
  const compose = async (entry, mat) => {
    const full = new THREE.Matrix4().copy(mat)
    const s = (await resolveModelData(assets, entry)).display?.[context]
    if (s) {
      const r = (s.rotation ?? [0, 0, 0]).map(v => THREE.MathUtils.degToRad(v))
      full.multiply(new THREE.Matrix4().compose(
        new THREE.Vector3(...(s.translation ?? [0, 0, 0]).map(v => Math.max(-80, Math.min(80, v)))),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2], "XYZ")),
        new THREE.Vector3(...(s.scale ?? [1, 1, 1]).map(v => Math.max(-4, Math.min(4, v === 0 ? 0.001 : v))))
      ))
    }
    full.premultiply(new THREE.Matrix4().makeTranslation(8, 8, 8)).multiply(new THREE.Matrix4().makeTranslation(-8, -8, -8))
    const own = entry.transformation
      ? (entry.transformation instanceof THREE.Matrix4 ? entry.transformation : parseTransformation(entry.transformation))
      : null
    if (own) full.multiply(own)
    entry.transformation = full.elements
    return entry
  }
  const _e = new THREE.Euler()

  let mapHandled = false
  if (/^(glow_)?item_frame$/.test(block) && /(^|:)filled_map$/.test(nbt.Item?.id ?? "")) {
    const facing = data.facing ?? "north"
    const art = args.frameMapArt ?? null
    mapHandled = !!art
    if (art) {
      const invisible = nbt.Invisible === 1 || nbt.Invisible === true
      if (invisible) args.dropModels?.()
      const spin = ((Number(nbt.ItemRotation ?? 0) % 4) + 4) % 4
      const f = FRAME_ITEM_ROT[facing]
      const mat = new THREE.Matrix4()
      if (f) mat.makeRotationFromEuler(_e.set(f[0], f[1], 0))
      if (spin) mat.multiply(new THREE.Matrix4().makeRotationZ(spin * Math.PI / 2))
      mat.premultiply(new THREE.Matrix4().makeTranslation(8, 8, 8)).multiply(new THREE.Matrix4().makeTranslation(-8, -8, -8))
      const z = invisible ? 15.85 : 14.85
      const entry = {
        model: {
          textures: { map: "block-model-renderer:map_art" },
          elements: [{ from: [0, 0, z], to: [16, 16, z], shade: false, faces: { north: { texture: "#map" } } }]
        },
        texture_images: { "block-model-renderer:map_art": art },
        transformation: mat.elements
      }
      if (block === "glow_item_frame") entry.emission = 15
      out.push(entry)
    }
  }

  if (/^(glow_)?item_frame$/.test(block) && typeof nbt.Item?.id === "string" && !LIVE_FRAME_ITEM.test(nbt.Item.id) && !mapHandled) {
    const facing = data.facing ?? "north"
    const rot = Number(nbt.ItemRotation ?? 0)
    const invisible = nbt.Invisible === 1 || nbt.Invisible === true
    if (invisible) args.dropModels?.()
    const f = FRAME_ITEM_ROT[facing]
    const mat = new THREE.Matrix4()
    if (f) mat.makeRotationFromEuler(_e.set(f[0], f[1], 0))
    mat.multiply(new THREE.Matrix4().makeTranslation(0, 0, invisible ? 8 : 7))
    if (rot) mat.multiply(new THREE.Matrix4().makeRotationZ(rot * Math.PI / 4))
    mat.multiply(new THREE.Matrix4().makeScale(0.5, 0.5, 0.5))
    for (const entry of await parseItemDefinition(assets, nbt.Item.id, itemArgs(nbt.Item))) {
      await compose(entry, mat)
      if (block === "glow_item_frame") entry.emission = 15
      out.push(entry)
    }
  }

  if (block.endsWith("shelf") && Array.isArray(nbt.Items)) {
    const yaw = SHELF_ITEM_YAW[data.facing] ?? Math.PI
    const alignBottom = Number(nbt.align_items_to_bottom ?? 0) === 1
    for (const item of nbt.Items) {
      if (typeof item?.id !== "string" || LIVE_FRAME_ITEM.test(item.id)) continue
      const slot = Math.min(2, Math.max(0, Number(item.Slot ?? 0)))
      const mat = new THREE.Matrix4().makeRotationY(yaw)
      mat.multiply(new THREE.Matrix4().makeTranslation((slot - 1) * 5, alignBottom ? -4 : 0, -4))
      mat.multiply(new THREE.Matrix4().makeScale(0.25, 0.25, 0.25))
      for (const entry of await parseItemDefinition(assets, item.id, itemArgs(item))) {
        await compose(entry, mat)
        entry.shelf_align = alignBottom ? "bottom" : "center"
        out.push(entry)
      }
    }
  }

  return out
}

function waterPart(colors) {
  return {
    model: "block-model-renderer:block/water",
    type: "block",
    fluid: "water",
    tints: [colors?.tables.fixed.water ?? "#3F76E4"],
    scale: [0.999, 0.999, 0.999]
  }
}

export async function getBiomeTint(assets, mapName, biome) {
  const entries = biome == null ? [{}] : Array.isArray(biome) ? biome : [biome]
  if (!entries.length) entries.push({})
  const toInt = t => typeof t === "number" ? t : parseInt(String(t).replace("#", ""), 16)
  let r = 0, g = 0, b = 0, total = 0
  for (const entry of entries) {
    let v
    if (entry.tint !== undefined && !entry.combine) {
      v = toInt(entry.tint)
    } else {
      const hex = await getColorMapTint(assets, mapName, entry.temperature ?? 0.5, entry.downfall ?? 1)
      v = parseInt(hex.slice(1), 16)
      if (entry.tint !== undefined) v = ((v & 0xFEFEFE) + toInt(entry.tint)) >> 1
    }
    const w = entry.weight ?? 1
    r += ((v >> 16) & 255) * w
    g += ((v >> 8) & 255) * w
    b += (v & 255) * w
    total += w
  }
  const c = (Math.round(r / total) << 16 | Math.round(g / total) << 8 | Math.round(b / total)) >>> 0
  return "#" + c.toString(16).padStart(6, "0").toUpperCase()
}

async function getColorMapTint(assets, mapName, temperature, downfall) {
  if (isNaN(temperature) || isNaN(downfall)) return "#FF00FF"
  temperature = Math.min(1, Math.max(0, temperature))
  downfall = Math.min(1, Math.max(0, downfall))

  const buf = await readFile(`assets/minecraft/textures/colormap/${mapName}.png`, assets)
  if (!buf) return "#FFFFFF"

  const image = await loadImage(buf)
  const canvas = new Canvas(256, 256)
  const ctx = canvas.getContext("2d", { willReadFrequently: true })

  if (image.width !== 256 || image.height !== 256) return "#FF00FF"
  ctx.drawImage(image, 0, 0)

  const x = Math.round((1 - temperature) * 255)
  const y = Math.round((1 - downfall * temperature) * 255)

  if (x < 0 || x > 255 || y < 0 || y > 255) return "#FF00FF"

  const { data } = ctx.getImageData(x, y, 1, 1)
  const [r, g, b] = data
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase()
}

export async function parseItemDefinition(assets, itemId, args) {
  if (!itemId) throw new Error("parseItemDefinition requires an item id")
  if (assets == null || assets.length === 0) throw new Error("parseItemDefinition requires assets")
  const data = { ...(args?.data ?? {}) }
  if (data.custom_model_data != null && typeof data.custom_model_data !== "object") {
    data.custom_model_data = { floats: [Number(data.custom_model_data)] }
  }
  if (data.dyed_color != null && typeof data.dyed_color === "object" && "rgb" in data.dyed_color) {
    data.dyed_color = data.dyed_color.rgb
  }
  const display = args?.display ?? "gui"
  assets = await prepareAssets(assets, args?.version ? { version: args.version } : undefined)

  const { namespace, item } = resolveNamespace(itemId)
  const glint = !!(args?.glint || itemHasFoil({ id: itemId, components: data }, await itemRules(assets)))

  const buf = await readFile(`assets/${namespace}/items/${item}.json`, assets)

  if (!buf) {
    const legacy = (!args?.version || isBefore(args.version, "1.21.4")) && await readFile(`assets/${namespace}/models/item/${item}.json`, assets)
    const m = { type: "item", model: legacy ? `${namespace}:item/${item}` : "block-model-renderer:missing" }
    if (args?.ignoreAtlases) m.ignore_atlas_restrictions = true
    if (args?.version) m.version = args.version
    if (glint) m.glint = true
    return [m]
  }

  const json = parseJson(buf)

  const normalizedData = {}
  for (const key in data) normalizedData[normalize(key)] = data[key]
  const itemColors = await colorTables(assets)
  const models = await resolveItemModel(assets, json.model, normalizedData, display, undefined, args?.version)
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    model.type = "item"
    if (args?.ignoreAtlases) model.ignore_atlas_restrictions = true
    if (args?.version) model.version = args.version
    if (model.tints) {
      const tints = []
      for (const tint of model.tints) {
        if (typeof tint === "string") {
          tints.push(tint)
          continue
        }
        const type = normalize(tint.type)
        if (type === "team" && normalizedData["team"] !== undefined) {
          const teamColor = itemColors.tables.team[normalize(normalizedData["team"])]
          tints.push(teamColor !== undefined ? parseColor(teamColor) : parseColor(tint.default ?? 16777215))
        } else if (type === "dye" && normalizedData["dyed_color"] !== undefined) {
          tints.push(parseColor(normalizedData["dyed_color"]))
        } else if (type === "map_color" && normalizedData["map_color"] !== undefined) {
          tints.push(parseColor(normalizedData["map_color"]))
        } else if (type === "potion" && normalizedData["potion_contents"]?.potion) {
          const color = getPotionColor(normalizedData["potion_contents"].potion, itemColors)
          tints.push(color ?? parseColor(tint.default ?? -13083194))
        } else if (type === "custom_model_data" && normalizedData["custom_model_data"]?.colors) {
          const c = normalizedData["custom_model_data"].colors[tint.index ?? 0]
          if (c !== undefined) {
            tints.push(parseColor(c))
          } else {
            tints.push(tint.default !== undefined ? parseColor(tint.default) : "#FFFFFF")
          }
        } else if (type === "firework" && normalizedData["firework_explosion"]?.colors?.length) {
          const colors = normalizedData["firework_explosion"].colors.map(c => {
            const hex = parseColor(c)
            const v = parseInt(hex.slice(1), 16)
            return [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]
          })
          const r = Math.round(colors.reduce((s, c) => s + c[0], 0) / colors.length)
          const g = Math.round(colors.reduce((s, c) => s + c[1], 0) / colors.length)
          const b = Math.round(colors.reduce((s, c) => s + c[2], 0) / colors.length)
          tints.push("#" + ((r << 16 | g << 8 | b) >>> 0).toString(16).padStart(6, "0"))
        } else if (type === "grass" || type === "foliage" || type === "dry_foliage") {
          tints.push(await getColorMapTint(assets, type, tint.temperature, tint.downfall))
        } else if (tint.value !== undefined || tint.default !== undefined) {
          const color = tint.value ?? tint.default
          if (Array.isArray(color)) {
            tints.push("#" + color.map(c => Math.round(c * 255).toString(16).padStart(2, "0")).join(""))
          } else {
            tints.push(parseColor(color))
          }
        } else {
          tints.push("#FFFFFF")
        }
      }
      model.tints = tints
    } else if (Object.keys(model).length === 1) {
      models[i] = model.model
    }
  }
  if (glint) {
    for (let i = 0; i < models.length; i++) {
      if (typeof models[i] === "string") models[i] = { model: models[i] }
      models[i].glint = true
    }
  }
  return models
}

async function resolveItemModel(assets, def, data, display, accTransform, version) {
  while (def) {
    const type = normalize(def.type)
    const currentTransform = composeTransformations(accTransform, parseTransformation(def.transformation))

    if (type === "special") {
      const model = {
        model: def.base
      }
      model.special = Object.assign({}, def.model, { type: normalize(def.model.type) })
      if (data["banner_patterns"]) model.special.patterns = data["banner_patterns"]
      if (data["base_color"] != null) model.special.base_color = data["base_color"]
      if (currentTransform) model.transformation = currentTransform.elements
      return [model]
    }

    if (type === "composite") {
      const result = []
      for (const model of def.models) {
        const nested = await resolveItemModel(assets, model, data, display, currentTransform, version)
        result.push(...nested)
      }
      return result
    }

    if (type === "select") {
      const prop = (version ? null : LEGACY_ITEM_PROPS[normalize(def.property)]) ?? normalize(def.property)
      let raw
      if (prop === "custom_model_data") raw = data["custom_model_data"]?.strings?.[def.index ?? 0]
      else if (prop === "component") raw = data[normalize(def.component)]
      else if (prop === "block_state") raw = data.block_state?.[def.block_state_property]
      else if (prop === "charge") {
        const projectiles = data.charged_projectiles ?? []
        if (!projectiles.length) raw = "none"
        else if (projectiles.some(p => normalize(typeof p === "string" ? p : p?.id ?? "") === "firework_rocket")) raw = "rocket"
        else raw = "arrow"
      }
      else if (prop === "trim_material") raw = data.trim?.material ?? data.trim_material
      else raw = data[prop]
      let value = normalize(raw ?? "")
      if (!value && prop === "display_context") {
        value = typeof display === "string" ? display : display.display
      } else if (!value && prop === "local_time" && def.pattern) {
        const now = new Date()
        const pad = n => String(n).padStart(2, "0")
        value = def.pattern.replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|EE|E|HH|H|hh|h|mm|m|ss|s|a|Z|z|w|W|D|u|G/g, m => {
          switch (m) {
            case "yyyy": return now.getFullYear()
            case "yy": return String(now.getFullYear()).slice(-2)
            case "MMMM": return now.toLocaleString("en", { month: "long" })
            case "MMM": return now.toLocaleString("en", { month: "short" })
            case "MM": return pad(now.getMonth() + 1)
            case "M": return now.getMonth() + 1
            case "dd": return pad(now.getDate())
            case "d": return now.getDate()
            case "EEEE": return now.toLocaleString("en", { weekday: "long" })
            case "EEE": case "EE": case "E": return now.toLocaleString("en", { weekday: "short" })
            case "HH": return pad(now.getHours())
            case "H": return now.getHours()
            case "hh": return pad(now.getHours() % 12 || 12)
            case "h": return now.getHours() % 12 || 12
            case "mm": return pad(now.getMinutes())
            case "m": return now.getMinutes()
            case "ss": return pad(now.getSeconds())
            case "s": return now.getSeconds()
            case "a": return now.getHours() < 12 ? "AM" : "PM"
            case "Z": case "z": { const o = -now.getTimezoneOffset(); return (o >= 0 ? "+" : "-") + pad(Math.floor(Math.abs(o) / 60)) + pad(Math.abs(o) % 60) }
            case "w": { const d = new Date(now.getFullYear(), 0, 1); return Math.ceil(((now - d) / 86400000 + d.getDay() + 1) / 7) }
            case "W": return Math.ceil(now.getDate() / 7)
            case "D": return Math.ceil((now - new Date(now.getFullYear(), 0, 1)) / 86400000) + 1
            case "u": return now.getDay() || 7
            case "G": return "AD"
            default: return m
          }
        })
      }
      const matched = def.cases.find(c => {
        const when = c.when
        if (Array.isArray(when)) return when.map(normalize).includes(value)
        return normalize(when) === value
      })
      def = matched?.model || def.fallback
      accTransform = currentTransform
      continue
    }

    if (type === "condition") {
      const prop = (version ? null : LEGACY_ITEM_PROPS[normalize(def.property)]) ?? normalize(def.property)
      let isTruthy
      if (prop === "custom_model_data") {
        const v = data["custom_model_data"]?.flags?.[def.index ?? 0]
        isTruthy = v === true || v === "true"
      } else if (prop === "has_component") {
        const component = normalize(def.component ?? "")
        isTruthy = component in data && data[component] !== undefined && data[component] !== null
      } else {
        const v = normalize(data[prop])
        isTruthy = v === true || v === "true"
      }
      def = isTruthy ? def.on_true : def.on_false
      accTransform = currentTransform
      continue
    }

    if (type === "range_dispatch") {
      const prop = (version ? null : LEGACY_ITEM_PROPS[normalize(def.property)]) ?? normalize(def.property)
      const defaultValue = prop === "count" ? 1 : 0
      const num = parseFloat(prop === "custom_model_data" ? data["custom_model_data"]?.floats?.[def.index ?? 0] ?? defaultValue : data[prop] ?? defaultValue)
      const scaled = (def.scale ?? 1) * num
      const entries = def.entries || []
      let chosen = def.fallback
      for (const entry of entries) {
        if (scaled >= entry.threshold) chosen = entry.model
      }
      def = chosen
      accTransform = currentTransform
      continue
    }

    if (type === "model") {
      if (currentTransform) def = { ...def, transformation: currentTransform.elements }
      return [def]
    }

    if (type === "bundle/selected_item") {
      const selectedItem = data["bundle/selected_item"]
      if (!selectedItem) return []
      return await parseItemDefinition(assets, selectedItem, { display })
    }

    return []
  }
  return []
}

async function loadMinecraftTexture(path, assets, type) {
  if (type === "block" || type === "item") {
    const atlases = await getAtlasesContaining(path, assets)
    const allowed = type === "block" ? ["blocks"] : ["blocks", "items"]
    if (!allowed.some(a => atlases.has(a))) return { image: await getMissingImage(assets) }
  }

  const buf = await readFile(path, assets)
  if (!buf) return { image: await getMissingImage(assets) }

  const image = await loadImage(buf)

  let meta
  try {
    meta = parseJson(await readFile(path + ".mcmeta", assets, buf.hintIndex)).animation ?? {}
  } catch {
    return { image }
  }

  return buildAnimation(image, meta)
}

function applyTint(img, tint) {
  const canvas = new Canvas(img.width, img.height)
  const ctx = canvas.getContext("2d")
  ctx.drawImage(img, 0, 0)
  ctx.globalCompositeOperation = "multiply"
  ctx.fillStyle = COLORS.dye[tint] ?? tint
  ctx.fillRect(0, 0, img.width, img.height)
  ctx.globalCompositeOperation = "destination-in"
  ctx.drawImage(img, 0, 0)
  return canvas
}

let _alphaCanvas = null, _alphaCtx = null
function imageIsTranslucent(img, cutoff) {
  const min = cutoff?.min ?? 5
  const max = cutoff?.max ?? 240
  if (!_alphaCanvas) {
    _alphaCanvas = new Canvas(1, 1)
    _alphaCtx = _alphaCanvas.getContext("2d", { willReadFrequently: true })
  }
  _alphaCanvas.width = img.width
  _alphaCanvas.height = img.height
  _alphaCtx.clearRect(0, 0, img.width, img.height)
  _alphaCtx.drawImage(img, 0, 0)
  const data = _alphaCtx.getImageData(0, 0, img.width, img.height).data
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > min && data[i] < max) return true
  }
  return false
}

export function isCrossModel(models) {
  const elements = (Array.isArray(models) ? models : [models]).flatMap(m => m?.elements ?? [])
  return elements.length > 0 && elements.every(el => {
    const r = el.rotation
    if (!r) return false
    const y = r.axis ? (r.axis === "y" ? r.angle : null) : (r.x || r.z ? null : r.y ?? null)
    return y != null && (((y % 90) + 90) % 90) === 45
  })
}

export async function resolveModelData(assets, model) {
  if (model == null) throw new Error("resolveModelData requires a model")
  if (assets == null || assets.length === 0) throw new Error("resolveModelData requires assets")
  assets = await prepareAssets(assets)

  let texImages = null
  if (typeof model === "object" && model.texture_images) {
    texImages = model.texture_images
    model = { ...model }
    delete model.texture_images
  }
  const modelCache = !texImages && assets.cache?.models
  const cacheKey = modelCache ? (typeof model === "string" ? model : JSON.stringify(model)) : null
  if (cacheKey && modelCache.has(cacheKey)) return structuredClone(modelCache.get(cacheKey))

  let merged = {}

  let type
  if (typeof model === "object") {
    merged = structuredClone(model)
    model = model.model
  }

  let currentNamespace, currentItem
  if (typeof model === "object") {
    currentItem = model
  } else {
    ({ namespace: currentNamespace, item: currentItem } = resolveNamespace(model))
  }

  let stack = []
  let currentPath

  try {
    if (!merged.allow_invalid_rotations && (merged.x && merged.x % 90 !== 0 || merged.y && merged.y % 90 !== 0 || merged.z && merged.z % 90 !== 0)) {
      delete merged.x
      delete merged.y
      delete merged.z
      throw new Error
    }
    while (true) {
      let json
      if (typeof currentItem === "object") {
        json = currentItem
      } else {
        const buf = await readFile(`assets/${currentNamespace}/models/${currentItem}.json`, assets)

        const sourceEntry = assets[buf.hintIndex]
        if (sourceEntry?.bundledOverrides) {
          merged.overridden = true
        }

        json = parseJson(buf)
      }

      stack.push(json)

      if (!json.parent || json.parent.startsWith("builtin")) break

      const parentId = json.parent.replace(/^minecraft:/, "")
      const resolved = resolveNamespace(parentId)
      currentNamespace = resolved.namespace
      currentItem = resolved.item
    }
  } catch {
    stack = [parseJson(await readFile("assets/block-model-renderer/models/missing.json", assets))]
    merged.model = "block-model-renderer:missing.json"
  }

  if (merged.special) {
    const resolved = await resolveSpecialModel(assets, merged.special, merged.model)
    if (resolved) {
      stack.push(resolved.model)
      if (resolved.rotation) {
        merged.x = resolved.rotation[0]
        merged.y = resolved.rotation[1]
        merged.z = resolved.rotation[2]
      }
      if (resolved.translation) {
        merged.translation = resolved.translation
      }
      if (resolved.scale) {
        merged.scale = resolved.scale
      }
    }
    delete merged.special
  }

  const collected = new Map()
  for (const layer of stack) {
    for (const key in layer) {
      let values = collected.get(key)
      if (!values) collected.set(key, values = [])
      values.push(layer[key])
    }
  }

  const modelType = merged.type ?? collected.get("type")?.find(v => v)
  const loaderOwned = new Set()
  for (const [key, values] of collected) {
    let value
    for (const loader of activeLoaders()) {
      value = await loader.mergeKey?.(key, values, merged, stack)
      if (value !== undefined) break
    }
    if (value !== undefined) {
      merged[key] = value
      loaderOwned.add(key)
    } else if (key === "textures") {
      merged.textures ??= {}
      for (const layerTextures of values) {
        for (const [slot, tex] of Object.entries(layerTextures)) {
          if (!(slot in merged.textures)) {
            merged.textures[slot] = tex
          }
        }
      }
    } else if (key === "display") {
      if (modelType === "block") continue
      merged.display ??= {}
      for (const layerDisplay of values) {
        for (const [slot, entry] of Object.entries(layerDisplay)) {
          if (!(slot in merged.display)) {
            merged.display[slot] = entry
          }
        }
      }
    } else if (!merged[key]) {
      merged[key] = values.find(v => v) ?? values[values.length - 1]
    }
  }

  function handleNestedTexture(key) {
    const v = merged.textures[key]
    if (v == null || typeof v === "string") return
    merged.textures[key] = v.sprite
    if (!merged.textures[key] || merged.textures[key].startsWith("#")) {
      delete merged.textures[key]
    }
  }

  for (const key in merged.textures) {
    handleNestedTexture(key)
    let value = merged.textures[key]
    while (value?.startsWith("#")) {
      const ref = value.slice(1)
      handleNestedTexture(ref)
      if (value === merged.textures[key]) {
        delete merged.textures[key]
        break
      }
      value = merged.textures[ref]
    }
    merged.textures[key] = value

    if (!merged.textures[key]) {
      delete merged.textures[key]
    }
  }

  if (merged.display) {
    convertLegacyDisplay(merged)
  }

  if (normalize(stack[stack.length - 1].parent) === "builtin/generated") {
    if (!merged.gui_light) {
      merged.gui_light = "front"
    }

    if (!merged.elements) {
      merged.generated = true
      merged.elements = []
      for (const [key, texRef] of Object.entries(merged.textures)) {
        const match = key.match(/^layer(\d+)$/)
        if (match) {
          const tintIndex = Number(match[1])
          const texId = "#" + key
          const { namespace, item } = resolveNamespace(texRef)
          const loaded = await loadMinecraftTexture(`assets/${namespace}/textures/${item}.png`, assets)
          const image = loaded.image
          const width = image.width
          const height = image.height
          const depth = 16 / Math.max(width, height)
          const sourceFrames = loaded.frames ?? [image]
          const probe = new Canvas(width, height)
          const pctx = probe.getContext("2d", { willReadFrequently: true })
          const frameMasks = sourceFrames.map(frame => {
            pctx.clearRect(0, 0, width, height)
            pctx.drawImage(frame, 0, 0, width, height)
            const fdata = pctx.getImageData(0, 0, width, height).data
            const mask = new Uint8Array(width * height)
            for (let p = 0; p < width * height; p++) {
              if (fdata[p * 4 + 3] >= 1) mask[p] = 1
            }
            return mask
          })

          function isOpaque(mask, x, y) {
            if (x < 0 || x >= width || y < 0 || y >= height) return
            return mask[y * width + x] === 1
          }

          function isEdge(x, y, dx, dy) {
            return frameMasks.some(mask => isOpaque(mask, x, y) && !isOpaque(mask, x + dx, y + dy))
          }

          merged.elements.push({
            from: [0, 16 - height * depth, 8 - depth / 2],
            to: [width * depth, 16, 8 + depth / 2],
            faces: {
              north: { texture: texId, uv: [16, 0, 0, 16], tintindex: tintIndex },
              south: { texture: texId, uv: [0, 0, 16, 16], tintindex: tintIndex }
            }
          })

          const addRun = (face, x1, y1, x2, y2, u1, v1, u2, v2) => merged.elements.push({
            from: [x1, y1, 8 - depth / 2],
            to: [x2, y2, 8 + depth / 2],
            faces: { [face]: { texture: texId, uv: [u1, v1, u2, v2], tintindex: tintIndex } }
          })

          for (let y = 0; y < height; y++) {
            for (const [face, dy] of [["up", -1], ["down", 1]]) {
              let start = -1
              for (let x = 0; x <= width; x++) {
                const edge = x < width && isEdge(x, y, 0, dy)
                if (edge && start === -1) start = x
                else if (!edge && start !== -1) {
                  addRun(face, start * depth, 16 - (y + 1) * depth, x * depth, 16 - y * depth,
                    start / width * 16, y / height * 16, x / width * 16, (y + 1) / height * 16)
                  start = -1
                }
              }
            }
          }

          for (let x = 0; x < width; x++) {
            for (const [face, dx] of [["west", -1], ["east", 1]]) {
              let start = -1
              for (let y = 0; y <= height; y++) {
                const edge = y < height && isEdge(x, y, dx, 0)
                if (edge && start === -1) start = y
                else if (!edge && start !== -1) {
                  addRun(face, x * depth, 16 - y * depth, (x + 1) * depth, 16 - start * depth,
                    x / width * 16, start / height * 16, (x + 1) / width * 16, y / height * 16)
                  start = -1
                }
              }
            }
          }
        }
      }
    }
  }

  if (merged.banner_patterns && Array.isArray(merged.elements)) {
    const dye = (await colorTables(assets)).tables.dye
    merged.textures ??= {}
    merged.tints ??= []
    applyPatternLayers(merged, { patterns: merged.banner_patterns }, dye, "banner", el => Object.values(el.faces ?? {}).some(f => f.texture === "#tinted"))
    delete merged.banner_patterns
  }

  if (!loaderOwned.has("parent")) delete merged.parent
  if (!loaderOwned.has("model")) delete merged.model
  if (merged.type === "block") delete merged.display

  if (cacheKey) modelCache.set(cacheKey, structuredClone(merged))
  if (texImages) merged.texture_images = texImages
  return merged
}

function applyPatternLayers(model, data, dye, folder, isBase) {
  if (!data.patterns?.length) return
  const layers = model.elements.filter(isBase)
  data.patterns.forEach((entry, i) => {
    const ref = typeof entry.pattern === "string" ? entry.pattern : entry.pattern?.asset_id
    if (!ref) return
    const { namespace, item } = resolveNamespace(normalize(ref))
    const key = `pattern_${i}`
    model.textures[key] = `${namespace === "minecraft" ? "" : `${namespace}:`}entity/${folder}/${item}`
    const grow = 0.02 * (i + 1)
    const tintIndex = model.tints.length
    model.tints.push(dye[normalize(entry.color ?? "white")])
    for (const el of layers) {
      const clone = structuredClone(el)
      delete clone.type
      clone.from = clone.from.map(v => v - grow)
      clone.to = clone.to.map(v => v + grow)
      for (const face of Object.values(clone.faces)) {
        face.texture = `#${key}`
        face.tintindex = tintIndex
      }
      model.elements.push(clone)
    }
  })
}

async function resolveSpecialModel(assets, data, base) {
  const originalType = data.type

  if (data.type === "head") {
    data.type = `${data.kind}_${data.kind.includes("skeleton") ? "skull" : "head"}`
  }

  let modelPath
  if (originalType === "chest" && data.chest_type && data.chest_type !== "single") {
    modelPath = `block-model-renderer:block/chest/_template_chest_${data.chest_type}`
  } else if (originalType === "copper_golem_statue" && data.pose && data.pose !== "standing") {
    modelPath = `block-model-renderer:block/copper_golem_statue/_template_copper_golem_statue_${data.pose}`
  } else if (originalType === "bed") {
    if (!assets.version || !isBefore(assets.version, "26.2")) return
    modelPath = `block-model-renderer:block/bed/_template_bed_${normalize(data.part ?? "head")}`
  } else {
    const baseItem = base ? resolveNamespace(base).item : null
    if (baseItem && await readFile(`assets/block-model-renderer/models/${baseItem}.json`, assets)) {
      modelPath = `block-model-renderer:${baseItem}`
    } else if (await readFile(`assets/block-model-renderer/models/item/${data.type}.json`, assets)) {
      modelPath = `block-model-renderer:item/${data.type}`
    } else {
      return
    }
  }

  const model = await resolveModelData(assets, modelPath)
  let translation, rotation, scale

  switch (originalType) {
    case "banner": {
      translation = [-8, -20, -8]
      rotation = [0, 0, 180]
      scale = [1.5, 1.5, 1.5]
      const dye = (await colorTables(assets)).tables.dye
      model.tints = [dye[data.color]]
      model.pose = { phase: 0 }
      applyPatternLayers(model, data, dye, "banner", el => Object.values(el.faces).some(f => f.texture === "#tinted"))
      break
    }
    case "bed":
      model.textures = { bed: `entity/bed/${normalize(data.texture)}` }
      rotation = [-90, 180, 0]
      break
    case "chest": {
      rotation = [0, 180, 0]
      const chestType = data.chest_type ?? "single"
      const suffix = chestType !== "single" ? `_${chestType}` : ""
      model.textures = { chest: `entity/chest/${normalize(data.texture)}${suffix}` }
      model.pose = { openness: Number(data.openness) || 0 }
      break
    }
    case "shulker_box":
      translation = [-8, 8, -8]
      rotation = [0, 0, 180]
      model.textures = { shulker_box: `entity/shulker/${normalize(data.texture)}` }
      model.pose = { openness: Number(data.openness) || 0 }
      break
    case "end_cube":
      model.shader = { type: "end_portal", layers: data.effect === "gateway" ? 16 : 15 }
      break
    case "copper_golem_statue":
      translation = [0, 8, -16]
      model.textures = { golem: `${normalize(data.texture).slice(9).slice(0, -4)}` }
      break
    case "conduit":
      translation = [-8, -8, -8]
      rotation = [0, 180, 0]
      break
    case "head":
    case "player_head":
      translation = [-8, -16, -8]
      rotation = [0, 0, 180]
      break
    case "decorated_pot":
      rotation = [0, 180, 0]
      break
    case "shield":
      if (data.base_color != null) {
        const dye = (await colorTables(assets)).tables.dye
        model.textures = { shield: "entity/shield/base" }
        model.tints = [dye[normalize(data.base_color)]]
        for (const el of model.elements) {
          if (el.type !== "plate") continue
          for (const face of Object.values(el.faces)) face.tintindex = 0
        }
        applyPatternLayers(model, data, dye, "shield", el => el.type === "plate")
      }
      break
  }
  return {
    model,
    translation,
    rotation,
    scale
  }
}

async function makeThreeTexture(img) {
  const texture = await loadTexture(img)
  texture.userData ??= {}
  texture.colorSpace = THREE.NoColorSpace
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  return texture
}

function bakeMirroredScale(displayGroup, solid) {
  const sign = new THREE.Matrix4().makeScale(
    Math.sign(displayGroup.scale.x),
    Math.sign(displayGroup.scale.y),
    Math.sign(displayGroup.scale.z)
  )
  displayGroup.updateWorldMatrix(false, true)
  const invDisp = displayGroup.matrixWorld.clone().invert()
  const v = new THREE.Vector3()
  displayGroup.traverse(o => {
    if (!o.isMesh) return
    const rel = invDisp.clone().multiply(o.matrixWorld)
    const bake = rel.clone().invert().multiply(sign).multiply(rel)
    const nm = new THREE.Matrix3().getNormalMatrix(bake)
    const pos = o.geometry.attributes.position
    const nrm = o.geometry.attributes.normal
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(bake)
      pos.setXYZ(i, v.x, v.y, v.z)
      if (nrm) {
        v.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize()
        nrm.setXYZ(i, v.x, v.y, v.z)
      }
    }
    pos.needsUpdate = true
    if (nrm) nrm.needsUpdate = true
    if (solid && o.geometry.index) {
      const idx = o.geometry.index
      for (let i = 0; i + 2 < idx.count; i += 3) {
        const a = idx.getX(i)
        idx.setX(i, idx.getX(i + 2))
        idx.setX(i + 2, a)
      }
      idx.needsUpdate = true
    }
  })
  displayGroup.scale.set(
    Math.abs(displayGroup.scale.x),
    Math.abs(displayGroup.scale.y),
    Math.abs(displayGroup.scale.z)
  )
}

function convertLegacyDisplay(merged) {
  const d = merged.display
  if (d.gui && merged.version && isBefore(merged.version, "1.9")) {
    const g = d.gui
    const r = g.rotation ?? [0, 0, 0]
    const t = g.translation ?? [0, 0, 0]
    const s = g.scale ?? [1, 1, 1]
    d.gui = {
      rotation: [30 - r[0], 225 - r[1], r[2]],
      translation: t,
      scale: [0.625 * s[0], 0.625 * s[1], 0.625 * s[2]]
    }
  }
  const legacyNames = !merged.version || isBefore(merged.version, "1.9")
  if (legacyNames && d.thirdperson && !d.thirdperson_righthand) {
    const o = d.thirdperson
    const converted = { ...o }
    if (o.rotation) {
      const e = new THREE.Euler(
        THREE.MathUtils.degToRad(o.rotation[0]),
        THREE.MathUtils.degToRad(o.rotation[1]),
        THREE.MathUtils.degToRad(o.rotation[2]),
        "XYZ"
      )
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
        .multiply(new THREE.Quaternion().setFromEuler(e))
      const out = new THREE.Euler().setFromQuaternion(q, "XYZ")
      converted.rotation = [out.x, out.y, out.z].map(r => Math.round(THREE.MathUtils.radToDeg(r) * 100) / 100)
    }
    if (o.translation) {
      converted.translation = [o.translation[0], -o.translation[2], o.translation[1]]
    }
    d.thirdperson_righthand = converted
    delete d.thirdperson
  }
  if (legacyNames && d.firstperson && !d.firstperson_righthand) {
    d.firstperson_righthand = { ...d.firstperson }
    delete d.firstperson
  }
}

function shouldIgnoreAtlases(model) {
  return model.ignore_atlas_restrictions || (model.version && isBefore(model.version, "1.21.11"))
}

async function modelPassesAtlasRules(model, assets) {
  if (model.type !== "block" && model.type !== "item") return true
  if (shouldIgnoreAtlases(model)) return true
  const textures = model.textures ?? {}
  const usedSlots = new Set()
  for (const el of model.elements ?? []) {
    for (const face of Object.values(el.faces ?? {})) {
      if (typeof face?.texture === "string" && face.texture.startsWith("#")) {
        usedSlots.add(face.texture.slice(1))
      }
    }
  }
  const entries = []
  for (const slot of usedSlots) {
    const value = textures[slot]
    if (typeof value !== "string" || !value || value.startsWith("#")) continue
    const { namespace, item } = resolveNamespace(value)
    entries.push(`assets/${namespace}/textures/${item}.png`)
  }
  if (!entries.length) return true

  const memberships = await Promise.all(entries.map(p => getAtlasesContaining(p, assets)))

  let anyInItems = false
  let anyBlocksOnly = false
  for (const atlases of memberships) {
    if (atlases.size === 0) continue
    if (model.type === "block") {
      if (!(atlases.size === 1 && atlases.has("blocks"))) return
    } else {
      for (const a of atlases) if (a !== "blocks" && a !== "items") return
      if (atlases.has("items")) anyInItems = true
      else anyBlocksOnly = true
    }
  }
  if (model.type === "item" && anyInItems && anyBlocksOnly) return
  return true
}

export async function loadModel(scene, assets, model, args) {
  if (model == null) throw new Error("loadModel requires a model")
  if (assets == null || assets.length === 0) throw new Error("loadModel requires assets")
  const display = args?.display ?? "gui"
  const lightingArg = args?.lighting
  const lighting = lightingArg && typeof lightingArg === "object" ? "world" : lightingArg
  const world = lighting === "world" ? resolveWorldLighting(lightingArg) : null
  const light = world?.light && typeof world.light === "object" ? world.light : null
  const daytime = scene?.userData?.daytime ?? { value: parseDaytime(world?.daytime) }
  if (scene) scene.userData.daytime = daytime
  const block = args?.block ? { ...args.block, neighbors: args?.neighbors ?? null } : null
  if (args?.version && !model.version) model.version = args.version
  assets = await prepareAssets(assets, args?.version ? { version: args.version } : undefined)

  let blockEmission = 0
  if (args?.emission != null) {
    blockEmission = Math.max(0, Math.min(15, args.emission))
  } else if (model.emission != null) {
    blockEmission = Math.max(0, Math.min(15, model.emission))
  } else if (block?.id) {
    const blockId = normalize(block.id)
    const defaults = await defaultBlockstates(assets)
    blockEmission = (await blockRules(assets)).emission(blockId, block.properties, k => {
      const raw = defaults.unique(blockId)[k] ?? defaults.properties[k]
      return Array.isArray(raw) ? raw[0] : raw
    })
  }

  if (!(await modelPassesAtlasRules(model, assets))) {
    const missing = await resolveModelData(assets, { model: "block-model-renderer:missing" })
    for (const k of Object.keys(model)) delete model[k]
    Object.assign(model, missing)
  }

  const textureCache = assets.cache?.textures ?? new Map()
  const materialCache = new Map()

  function resolveTexturePath(id) {
    const { namespace, item } = resolveNamespace(id)
    return `assets/${namespace}/textures/${item}.png`
  }

  async function loadModelTexture(id, tint) {
    const direct = id != null ? model.texture_images?.[id] : undefined
    const atlas = shouldIgnoreAtlases(model) ? "" : (model.type ?? "")
    const srgb = lighting === "scene" || lighting === "off" ? "\0srgb" : ""
    const cacheKey = `${id ?? ""}\0${tint ?? ""}\0${atlas}${srgb}`
    if (!direct && textureCache.has(cacheKey)) return textureCache.get(cacheKey)

    let loaded
    if (direct) {
      loaded = { image: direct }
    } else if (id) {
      const path = resolveTexturePath(id)
      loaded = await loadMinecraftTexture(path, assets, shouldIgnoreAtlases(model) ? undefined : model.type)
    } else {
      loaded = { image: await getMissingImage(assets) }
    }

    let image = loaded.image
    let frames = loaded.frames
    if (tint) {
      image = applyTint(image, tint)
      if (frames) frames = frames.map(f => applyTint(f, tint))
    }

    const texture = await makeThreeTexture(image)
    texture.userData.translucent = imageIsTranslucent(image, assets.translucency)
    if (loaded.animated && frames) {
      texture.userData.frames = frames
      texture.userData.times = loaded.times
      texture.userData.interpolate = loaded.interpolate
    }

    if (direct) return texture
    if (assets.cache && !assets.cache.ephemeral) texture.userData.cached = true
    textureCache.set(cacheKey, texture)
    return texture
  }

  let settings
  if (typeof display === "object") {
    if (display.type === "fallback" && model.display?.[display.display ?? "gui"]) {
      settings = model.display[display.display ?? "gui"]
    } else {
      settings = structuredClone(display)
    }
  } else {
    settings = model.display?.[display]
  }

  if (model.billboard) {
    delete settings.rotation
  }

  let rotation = [0, 0, 0]
  if (settings?.rotation) {
    rotation = settings.rotation
  }
  rotation = rotation.map(e => e + 0.00001)

  const isFront = model.gui_light === "front"
  const lightConfig = isFront ? {
    light0: [-0.2006, 0.9749, 0.0969], d0: 0.6422,
    light1: [-0.2209, 0.1706, 0.9603], d1: 0.5997,
    ambient: 0.3968
  } : {
    light0: [-0.1046, 0.9761, 0.1904], d0: 0.5943,
    light1: [-0.9317, 0.2644, -0.2488], d1: 0.5992,
    ambient: 0.4001
  }
  lightConfig.daytime = daytime
  lightConfig.light = light
  lightConfig.blockLightTint = tintVec(world?.dim.blockLightTint, 0xFFD88C)
  lightConfig.skyLightColor = tintVec(world?.dim.skyLightColor, 0x7A7AFF)
  lightConfig.ambientColor = tintVec(world?.dim.ambientColor, 0x0A0A0A)
  lightConfig.skyLightFactor = typeof world?.dim.skyLightFactor === "number" ? world.dim.skyLightFactor : -1
  lightConfig.brightness = world?.brightness ?? 0.5
  lightConfig.cardinal = world?.cardinal

  const rootGroup = new THREE.Group()
  const displayGroup = new THREE.Group()
  const containerGroup = new THREE.Group()
  rootGroup.add(displayGroup)
  displayGroup.add(containerGroup)

  if (model.x || model.y || model.z) {
    const x = THREE.MathUtils.degToRad(-(model?.x ?? 0))
    const y = THREE.MathUtils.degToRad(-(model?.y ?? 0))
    const z = THREE.MathUtils.degToRad(model?.z ?? 0)
    containerGroup.rotation.set(x, y, z, "ZYX")
  }

  const cull = args?.cull instanceof Set ? args.cull
    : args?.cull ? new Set(Object.keys(args.cull).filter(k => args.cull[k])) : null
  const cullEuler = new THREE.Euler(
    THREE.MathUtils.degToRad(-(model?.x ?? 0)),
    THREE.MathUtils.degToRad(-(model?.y ?? 0)),
    THREE.MathUtils.degToRad(model?.z ?? 0), "ZYX")
  function worldCullface(dir) {
    const v = CULL_VECS[dir]
    if (!v) return null
    const w = new THREE.Vector3(v[0], v[1], v[2]).applyEuler(cullEuler)
    const ax = Math.abs(w.x), ay = Math.abs(w.y), az = Math.abs(w.z)
    if (ax >= ay && ax >= az) return w.x > 0 ? "east" : "west"
    if (ay >= az) return w.y > 0 ? "up" : "down"
    return w.z > 0 ? "south" : "north"
  }

  if (model.translation) {
    containerGroup.position.set(...model.translation)
  }

  if (model.scale) {
    containerGroup.scale.set(...model.scale)
  }

  async function applyFluidHeights(mesh, heights) {
    const geo = mesh.geometry
    const pos = geo.attributes.position, uv = geo.attributes.uv
    const H = { nw: heights.nw, ne: heights.ne, sw: heights.sw, se: heights.se }
    const cornerOf = i => (pos.getZ(i) < 0 ? (pos.getX(i) < 0 ? "nw" : "ne") : (pos.getX(i) < 0 ? "sw" : "se"))
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0) pos.setY(i, H[cornerOf(i)] * 16 - 7)
    }
    pos.needsUpdate = true
    for (const start of [0, 4, 16, 20]) {
      for (let i = start; i < start + 4; i++) {
        uv.setY(i, pos.getY(i) > -6.99 ? 1 - (1 - H[cornerOf(i)]) * 0.5 : 0.5)
      }
    }
    if (model.fluid === "water" && heights.overlay) {
      for (const [face, mi] of [["east", 0], ["west", 1], ["south", 4], ["north", 5]]) {
        if (!heights.overlay[face] || mesh.material[mi].visible === false) continue
        const tint = model.tints?.[0]
        const mkey = `minecraft:block/water_overlay\0${tint ?? ""}\0false`
        let material = materialCache.get(mkey)
        if (!material) {
          material = await makeMaterial(await loadModelTexture("minecraft:block/water_overlay", tint), assets, model.shader, false, true, lightConfig, lighting, undefined, 0, false)
          materialCache.set(mkey, material)
        }
        mesh.material[mi] = material
        mesh.material[mi + 6] = new THREE.MeshBasicMaterial({ visible: false })
      }
    }
    const vertIdx = {}
    for (let i = 8; i < 12; i++) vertIdx[cornerOf(i)] = i
    const order = [vertIdx.nw, vertIdx.sw, vertIdx.se, vertIdx.nw, vertIdx.se, vertIdx.ne]
    for (let k = 0; k < 6; k++) geo.index.setX(geo.groups[2].start + k, order[k])
    geo.index.needsUpdate = true
    if (heights.angle != null) {
      let texRef = "#flow"
      while (texRef && texRef.startsWith("#")) texRef = model.textures?.[texRef.slice(1)]
      const tint = model.tints?.[0]
      for (const [idx, side] of [[2, false], [8, "back"]]) {
        const mkey = `${texRef ?? ""}\0${tint ?? ""}\0${side}\0flow`
        let material = materialCache.get(mkey)
        if (!material) {
          material = await makeMaterial(await loadModelTexture(texRef, tint), assets, model.shader, side, true, lightConfig, lighting, undefined, 0, false)
          materialCache.set(mkey, material)
        }
        mesh.material[idx] = material
      }
      const c = Math.cos(heights.angle) * 0.25, s = Math.sin(heights.angle) * 0.25
      const flowUV = {
        nw: [0.5 - c - s, 0.5 - c + s],
        sw: [0.5 - c + s, 0.5 + c + s],
        se: [0.5 + c + s, 0.5 + c - s],
        ne: [0.5 + c - s, 0.5 - c - s]
      }
      for (const [corner, [fu, fv]] of Object.entries(flowUV)) uv.setXY(vertIdx[corner], fu, 1 - fv)
    }
    uv.needsUpdate = true
    if (heights.same) {
      const hidden = new THREE.MeshBasicMaterial({ visible: false })
      const FACE_INDEX = { east: 0, west: 1, up: 2, down: 3, south: 4, north: 5 }
      for (const dir in FACE_INDEX) {
        if (heights.same[dir]) {
          mesh.material[FACE_INDEX[dir]] = hidden
          mesh.material[FACE_INDEX[dir] + 6] = hidden
        }
      }
    }
    if (!heights.full) {
      mesh.userData.cullface[2] = null
      mesh.userData.cullface[8] = null
    }
  }

  async function buildElement(element, target) {
    const from = new THREE.Vector3().fromArray(element.from)
    const to = new THREE.Vector3().fromArray(element.to)
    const size = new THREE.Vector3().subVectors(to, from)
    size.x ||= 0.001
    size.y ||= 0.001
    size.z ||= 0.001

    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z)

    if (element.rotation?.rescale) {
      let rescaleAxis = element.rotation.axis
      let rescaleAngle = element.rotation.angle
      if (rescaleAngle === undefined) {
        for (const a of ["x", "y", "z"]) {
          if (element.rotation[a]) {
            rescaleAxis = a
            rescaleAngle = element.rotation[a]
            break
          }
        }
      }
      if (rescaleAngle) {
        const angle = Math.abs(rescaleAngle)
        const rescale = 1 / Math.cos(THREE.MathUtils.degToRad(angle > 45 ? 90 - angle : angle))
        const scale = new THREE.Vector3(rescale, rescale, rescale)
        scale[rescaleAxis || "y"] = 1
        geometry.scale(scale.x, scale.y, scale.z)
      }
    }

    const faceOrder = ["east", "west", "up", "down", "south", "north"]

    const cullDirs = new Array(6).fill(null)

    for (let i = 0; i < faceOrder.length; i++) {
      const faceName = faceOrder[i]
      const face = element.faces?.[faceName]
      if (face?.cullface != null && face.cullface !== "" && !model.transformation) cullDirs[i] = worldCullface(face.cullface)
      if (!face) continue
      let [u1, v1, u2, v2] = face.uv || []
      if (!face.uv) {
        const [fx, fy, fz] = element.from
        const [tx, ty, tz] = element.to
        switch (faceName) {
          case "up":    u1 = fx; u2 = tx; v1 = fz; v2 = tz; break
          case "down":  u1 = fx; u2 = tx; v1 = 16 - tz; v2 = 16 - fz; break
          case "north": u1 = 16 - tx; u2 = 16 - fx; v1 = 16 - ty; v2 = 16 - fy; break
          case "south": u1 = fx; u2 = tx; v1 = 16 - ty; v2 = 16 - fy; break
          case "east":  u1 = 16 - tz; u2 = 16 - fz; v1 = 16 - ty; v2 = 16 - fy; break
          case "west":  u1 = fz; u2 = tz; v1 = 16 - ty; v2 = 16 - fy; break
        }
      }

      let uv = [
        [u1, v1],
        [u2, v1],
        [u1, v2],
        [u2, v2]
      ]

      const rot = face.rotation ?? 0
      if (rot === 90) uv = [uv[2], uv[0], uv[3], uv[1]]
      else if (rot === 180) uv = [uv[3], uv[2], uv[1], uv[0]]
      else if (rot === 270) uv = [uv[1], uv[3], uv[0], uv[2]]

      if (model?.uvlock) {
        let dir = faceName
        let x = ((model.x ?? 0) % 360 + 360) % 360

        function rotateUV(angle) {
          if (!angle) return
          const rad = THREE.MathUtils.degToRad(angle)
          uv = uv.map(([u, v]) => {
            const vec = new THREE.Vector2(u, v)
            vec.rotateAround(UV_CENTER, rad)
            return [vec.x, vec.y]
          })
        }

        if (x) {
          switch (faceName) {
            case "east":  rotateUV(model.x); break
            case "west":  rotateUV(-model.x); break
            case "north": rotateUV(180); break
            case "south": rotateUV(x === 180 ? 180 : 0); break
            case "up":    rotateUV(x === 90 ? 180 : 0); break
            case "down":  rotateUV(x === 270 ? 180 : 0); break
          }
          for (let i = 0; i < x / 90; i++) dir = X_CYCLE[dir] ?? dir
        }

        if (model.y) {
          const y = ((model.y % 360) + 360) % 360
          for (let i = 0; i < y / 90; i++) dir = Y_CYCLE[dir] ?? dir

          if (dir === "up" || dir === "down") {
            rotateUV((dir === "up") ^ !!(x % 180) ? model.y : -model.y)
          }
        }

        if (model.z) {
          rotateUV(dir === "north" ? -model.z : dir === "south" ? model.z : model.z)
        }
      }

      geometry.attributes.uv.array.set(uv.flatMap(([u, v]) => [u / 16, 1 - v / 16]), i * 8)
    }
    geometry.attributes.uv.needsUpdate = true

    async function faceMaterials(back) {
      const out = []
      for (let i = 0; i < faceOrder.length; i++) {
        const faceName = faceOrder[i]
        const face = element.faces?.[faceName]
        if (!face || !face.texture || (cull && cullDirs[i] && cull.has(cullDirs[i]) && !(model.fluid && faceName === "up"))) {
          out.push(new THREE.MeshBasicMaterial({ visible: false }))
          continue
        }

        let texRef = face.texture
        if (texRef && !texRef.startsWith("#")) texRef = "#" + texRef

        let tint
        if (model.tints) {
          tint = model.tints[face.tintindex]
        }

        while (texRef && texRef.startsWith("#")) {
          texRef = model.textures?.[texRef.slice(1)]
        }

        const legacyShade = !model.version || isBefore(model.version, "26.3")
        const modernShade = !model.version || !isBefore(model.version, "26.3")
        let shadeDir = null
        if (model.type !== "item") {
          if (modernShade && SHADE_DIR_VECS[element.shade_direction_override]) shadeDir = element.shade_direction_override
          else if (legacyShade && element.shade === false) shadeDir = "up"
        }
        const side = back ? "back" : false
        const emission = Math.max(blockEmission, !model.version || !isBefore(model.version, "1.21.2") ? Math.max(0, Math.min(15, element.light_emission ?? 0)) : 0)
        const ao = model.ambientocclusion !== false
        const mkey = `${texRef ?? ""}\0${tint ?? ""}\0${shadeDir ?? ""}\0${side}\0${emission}\0${ao}`
        let material = materialCache.get(mkey)
        if (!material) {
          material = await makeMaterial(await loadModelTexture(texRef, tint), assets, model.shader, side, true, lightConfig, lighting, shadeDir, emission, ao)
          if (args?.shaderScale && material.uniforms?.Scale) material.uniforms.Scale.value = args.shaderScale
          materialCache.set(mkey, material)
        }
        out.push(material)
      }
      return out
    }

    const materials = await faceMaterials(false)
    if (model.double_sided) {
      materials.push(...await faceMaterials("back"))
      const groups = geometry.groups.map(g => ({ ...g }))
      geometry.clearGroups()
      for (const g of groups) geometry.addGroup(g.start, g.count, g.materialIndex + 6)
      for (const g of groups) geometry.addGroup(g.start, g.count, g.materialIndex)
      cullDirs.push(...cullDirs)
    }

    const mesh = new THREE.Mesh(geometry, materials)
    mesh.userData.cullface = cullDirs
    mesh.userData.element = element
    mesh.position.set(
      from.x + size.x / 2 - 8,
      from.y + size.y / 2 - 8,
      from.z + size.z / 2 - 8
    )

    const fh = args?.fluidHeights ?? (model.fluid && args?.neighbors ? await fluidHeights(assets, model.fluid, args.neighbors) : null)
    if (model.fluid && fh) await applyFluidHeights(mesh, fh)

    if (element.part && !element.rotation) {
      const pivot = new THREE.Vector3(
        (element.pivot?.[0] ?? 8) - 8,
        (element.pivot?.[1] ?? 8) - 8,
        (element.pivot?.[2] ?? 8) - 8
      )
      const partGroup = new THREE.Group()
      partGroup.name = "part:" + element.part
      partGroup.userData.partPivot = [pivot.x, pivot.y, pivot.z]
      partGroup.position.copy(pivot)
      mesh.position.sub(pivot)
      partGroup.add(mesh)
      target.add(partGroup)
      return true
    }

    if (element.rotation) {
      let { origin, axis, angle, x, y, z } = element.rotation
      if (!isNaN(angle) || axis) {
        if (isNaN(angle) || !axis) {
          return false
        }
      }
      if (model.version) {
        const preMultiAxis = isBefore(model.version, "1.21.11")
        if (axis && preMultiAxis && (Math.abs(angle) > 45 || (isBefore(model.version, "1.21.6") && angle % 22.5 !== 0))) {
          return false
        }
        if (!axis && preMultiAxis) {
          return false
        }
      }

      const pivot = new THREE.Vector3(
        origin[0] - 8,
        origin[1] - 8,
        origin[2] - 8
      )

      const rotGroup = new THREE.Group()
      rotGroup.position.copy(pivot)
      if (element.part) {
        rotGroup.name = "part:" + element.part
        rotGroup.userData.partPivot = [pivot.x, pivot.y, pivot.z]
        rotGroup.userData.partAxis = axis ?? null
      }

      mesh.position.sub(pivot)
      rotGroup.add(mesh)

      if (axis) {
        rotGroup.rotateOnAxis(AXIS_VECTORS[axis], THREE.MathUtils.degToRad(angle))
      } else {
        rotGroup.rotateZ(THREE.MathUtils.degToRad(z ?? 0))
        rotGroup.rotateY(THREE.MathUtils.degToRad(y ?? 0))
        rotGroup.rotateX(THREE.MathUtils.degToRad(x ?? 0))
      }

      target.add(rotGroup)
    } else {
      target.add(mesh)
    }
    return true
  }

  const replaceElements = modelLoaders.some(l => l.replaceElements && l.match?.(model))
  for (const element of replaceElements ? [] : model.elements || []) {
    if (!(await buildElement(element, containerGroup))) {
      return await loadModel(scene, assets, await resolveModelData(assets, "block-model-renderer:missing"), { display })
    }
  }

  function mergeElementMeshes(group) {
    const buckets = new Map()
    const vert = new THREE.Vector3()
    const norm = new THREE.Vector3()
    const matrix = new THREE.Matrix4()
    const normalMatrix = new THREE.Matrix3()
    const collision = []
    for (const child of Array.from(group.children)) {
      const mesh = child.isMesh ? child : child.children.length === 1 && child.children[0].isMesh ? child.children[0] : null
      if (!mesh) continue
      child.updateMatrix()
      if (mesh === child) {
        matrix.copy(child.matrix)
      } else {
        mesh.updateMatrix()
        matrix.multiplyMatrices(child.matrix, mesh.matrix)
      }
      normalMatrix.getNormalMatrix(matrix)
      const geo = mesh.geometry
      const pos = geo.attributes.position
      const nrm = geo.attributes.normal
      const uv = geo.attributes.uv
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
      for (let i = 0; i < pos.count; i++) {
        vert.fromBufferAttribute(pos, i).applyMatrix4(matrix)
        if (vert.x < x0) x0 = vert.x
        if (vert.y < y0) y0 = vert.y
        if (vert.z < z0) z0 = vert.z
        if (vert.x > x1) x1 = vert.x
        if (vert.y > y1) y1 = vert.y
        if (vert.z > z1) z1 = vert.z
      }
      if (x0 !== Infinity) collision.push([x0, y0, z0, x1, y1, z1])
      for (const group of geo.groups) {
        const material = mesh.material[group.materialIndex]
        if (!material || material.visible === false) continue
        const dir = mesh.userData.cullface?.[group.materialIndex] ?? null
        let dirs = buckets.get(material)
        if (!dirs) buckets.set(material, dirs = new Map())
        let acc = dirs.get(dir)
        if (!acc) dirs.set(dir, acc = { positions: [], normals: [], uvs: [] })
        for (let i = group.start; i < group.start + group.count; i++) {
          const a = geo.index.getX(i)
          vert.fromBufferAttribute(pos, a).applyMatrix4(matrix)
          norm.fromBufferAttribute(nrm, a).applyMatrix3(normalMatrix).normalize()
          acc.positions.push(vert.x, vert.y, vert.z)
          acc.normals.push(norm.x, norm.y, norm.z)
          acc.uvs.push(uv.getX(a), uv.getY(a))
        }
      }
      group.remove(child)
      geo.dispose()
    }
    group.userData.collision = collision
    for (const [material, dirs] of buckets) {
      for (const [dir, acc] of dirs) {
        const geo = new THREE.BufferGeometry()
        geo.setAttribute("position", new THREE.Float32BufferAttribute(acc.positions, 3))
        geo.setAttribute("normal", new THREE.Float32BufferAttribute(acc.normals, 3))
        geo.setAttribute("uv", new THREE.Float32BufferAttribute(acc.uvs, 2))
        geo.setIndex(Array.from(Array(acc.positions.length / 3).keys()))
        const mesh = new THREE.Mesh(geo, material)
        mesh.userData.cullface = [dir]
        group.add(mesh)
      }
    }
  }

  if (args?.mergeElements !== false && !model.fluid && (model.elements?.length ?? 0) > 1 && !(model.dynamic && model.elements?.some(e => e?.part))) mergeElementMeshes(containerGroup)

  for (const loader of activeLoaders()) {
    if (loader.build && loader.match?.(model)) {
      await loader.build({
        group: containerGroup,
        model,
        assets,
        args,
        block,
        helpers: {
          THREE,
          lighting,
          daytime,
          readFile: (path, hint) => readFile(path, assets, hint),
          loadTexture: (id, tint) => loadModelTexture(id, tint),
          buildElements: async (elements = []) => {
            const g = new THREE.Group()
            for (const element of elements) await buildElement(element, g)
            if (args?.mergeElements !== false && !model.fluid && elements.length > 1) mergeElementMeshes(g)
            return g
          },
          resolveTexture: ref => {
            let t = ref
            while (typeof t === "string" && t.startsWith("#")) t = model.textures?.[t.slice(1)]
            return t
          },
          createMaterial: async (id, opts = {}) => {
            const shadeDir = SHADE_DIR_VECS[opts.shade_direction] ? opts.shade_direction : null
            const emission = Math.max(0, blockEmission, Math.min(15, opts.light_emission ?? 0))
            const key = `loader\0${id}\0${opts.tint ?? ""}\0${opts.shade !== false}\0${shadeDir ?? ""}\0${!!opts.double_sided}\0${opts.shader ? JSON.stringify(opts.shader) : ""}\0${emission}\0${opts.ao !== false}`
            let material = materialCache.get(key)
            if (!material) {
              material = await makeMaterial(await loadModelTexture(id, opts.tint), assets, opts.shader, opts.double_sided, opts.shade !== false, lightConfig, lighting, shadeDir, emission, opts.ao)
              materialCache.set(key, material)
            }
            return material
          }
        }
      })
    }
  }

  if (settings) {
    if (settings.rotation) {
      const delta = new THREE.Euler(
        THREE.MathUtils.degToRad(settings.rotation[0]),
        THREE.MathUtils.degToRad(settings.rotation[1]),
        THREE.MathUtils.degToRad(settings.rotation[2]),
        displayGroup.rotation.order
      )
      displayGroup.quaternion.multiply(new THREE.Quaternion().setFromEuler(delta))
    }
    if (settings.translation) {
      displayGroup.position.set(
        Math.max(-80, Math.min(80, settings.translation[0])),
        Math.max(-80, Math.min(80, settings.translation[1])),
        Math.max(-80, Math.min(80, settings.translation[2]))
      )
    }
    if (settings.scale) {
      displayGroup.scale.set(
        Math.max(-4, Math.min(4, settings.scale[0])),
        Math.max(-4, Math.min(4, settings.scale[1])),
        Math.max(-4, Math.min(4, settings.scale[2]))
      )
    }
  }

  if (model.shelf_align) {
    const box = new THREE.Box3().setFromObject(containerGroup)
    if (!box.isEmpty()) {
      containerGroup.position.y = model.shelf_align === "bottom" ? -box.min.y : -(box.min.y + box.max.y) / 2
    }
  }

  if (model.transformation) {
    const mat = model.transformation instanceof THREE.Matrix4
      ? model.transformation
      : parseTransformation(model.transformation)
    if (mat) {
      const wrapped = new THREE.Matrix4()
        .makeTranslation(-8, -8, -8)
        .multiply(mat)
        .multiply(new THREE.Matrix4().makeTranslation(8, 8, 8))
      containerGroup.applyMatrix4(wrapped)
    }
  }

  if (displayGroup.scale.x * displayGroup.scale.y * displayGroup.scale.z < 0) {
    bakeMirroredScale(displayGroup, model.version && isBefore(model.version, "1.15"))
  }

  if (model.billboard) {
    rootGroup.traverse(o => {
      if (!o.isMesh) return
      o.userData.billboard = true
      o.onBeforeRender = billboardBeforeRender
    })
  }

  if (model.glint && !model.billboard && !model.dynamic) {
    const glintTexture = await loadGlintTexture(assets)
    if (glintTexture) {
      const meshes = []
      rootGroup.traverse(o => { if (o.isMesh && !o.userData.glint) meshes.push(o) })
      for (const mesh of meshes) {
        const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        const overlayMats = source.map(m => {
          const baseTexture = m && m.visible !== false ? (m.uniforms?.map?.value ?? m.map) : null
          if (!baseTexture) {
            let hidden = materialCache.get("glint\0hidden")
            if (!hidden) materialCache.set("glint\0hidden", hidden = new THREE.MeshBasicMaterial({ visible: false }))
            return hidden
          }
          const key = `glint\0${baseTexture.uuid}\0${m.side}`
          let material = materialCache.get(key)
          if (!material) {
            material = makeGlintMaterial(glintTexture, baseTexture, m.side)
            materialCache.set(key, material)
          }
          return material
        })
        if (overlayMats.every(m => m.visible === false)) continue
        const overlay = new THREE.Mesh(mesh.geometry, Array.isArray(mesh.material) ? overlayMats : overlayMats[0])
        overlay.userData.glint = true
        if (mesh.userData.cullface) overlay.userData.cullface = mesh.userData.cullface
        mesh.add(overlay)
      }
    }
  }

  if (model.dynamic) {
    rootGroup.userData.dynamic = model.dynamic
    initDynamic(rootGroup)
    if (model.pose) poseSpecial(rootGroup, model.pose)
    else applyDynamicPose(rootGroup, {})
  }

  rootGroup.userData.model = model
  if (scene) scene.add(rootGroup)

  return rootGroup
}

let shaderSalt = 0

function patchShaderSalt(scene) {
  scene.traverse(obj => {
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : []
    for (const mat of mats) {
      const m = mat.fragmentShader?.match(/\/\/salt:(\d+)$/)
      if (m && Number(m[1]) !== shaderSalt) {
        mat.fragmentShader = mat.fragmentShader.slice(0, m.index) + `//salt:${shaderSalt}`
        mat.needsUpdate = true
      }
    }
  })
}

export function applyShaderSalt(scene) {
  if (shaderSalt) patchShaderSalt(scene)
}

export function bumpShaderSalt(scene) {
  shaderSalt++
  patchShaderSalt(scene)
}

function tintVec(input, fallback) {
  if (input == null) input = fallback
  if (Array.isArray(input)) return new THREE.Vector3(input[0], input[1], input[2])
  if (input?.isColor) return new THREE.Vector3(input.r, input.g, input.b)
  if (typeof input === "string") input = parseInt(input.replace(/^#/, ""), 16)
  return new THREE.Vector3(((input >> 16) & 255) / 255, ((input >> 8) & 255) / 255, (input & 255) / 255)
}

async function loadGlintTexture(assets) {
  const cache = assets.cache?.textures
  const cached = cache?.get("\0glint")
  if (cached !== undefined) return cached
  let texture = null
  const buf = await readFile("assets/minecraft/textures/misc/enchanted_glint_item.png", assets)
  if (buf) {
    texture = await makeThreeTexture(await loadImage(buf))
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.magFilter = texture.minFilter = THREE.LinearFilter
    texture.needsUpdate = true
    if (assets.cache && !assets.cache.ephemeral) texture.userData.cached = true
  }
  cache?.set("\0glint", texture)
  return texture
}

function makeGlintMaterial(glintTexture, baseTexture, side) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: baseTexture },
      glintMap: { value: glintTexture },
      GameTime: { value: 0.727 }
    },
    vertexShader: `
      varying vec2 vUv;
      #include <clipping_planes_pars_vertex>
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        #include <clipping_planes_vertex>
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      uniform sampler2D glintMap;
      uniform float GameTime;
      varying vec2 vUv;
      #include <clipping_planes_pars_fragment>
      void main() {
        #include <clipping_planes_fragment>
        if (vUv.x < 0.0 || vUv.x > 1.0 || vUv.y < 0.0 || vUv.y > 1.0) discard;
        if (texture2D(map, vUv).a < 0.5) discard;
        float ticks = GameTime * 24000.0;
        vec2 offset = vec2(-fract(ticks / 550.0), fract(ticks / 150.0));
        vec2 uvGlint = mat2(0.9848078, 0.1736482, -0.1736482, 0.9848078) * (vUv * 0.25) + offset;
        gl_FragColor = vec4(texture2D(glintMap, uvGlint).rgb * 0.75, 1.0);
      }
    `,
    clipping: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcColorFactor,
    blendDst: THREE.OneFactor,
    side: side ?? THREE.FrontSide
  })
  material.userData.glint = true
  return material
}

async function makeMaterial(texture, assets, shader, doubleSided, shadeEnabled, lightConfig, lighting, shadeDir, emission = 0, ao = true) {
  if ((lighting === "scene" || lighting === "off") && shader?.type !== "end_portal") {
    texture.colorSpace = THREE.SRGBColorSpace
    texture.needsUpdate = true
    const side = doubleSided === "back" ? THREE.BackSide : doubleSided ? THREE.DoubleSide : THREE.FrontSide
    if (lighting === "scene") {
      const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0, alphaTest: 0.5, side })
      if (emission > 0) {
        mat.emissive = new THREE.Color(0xffffff)
        mat.emissiveMap = texture
        mat.emissiveIntensity = emission / 15
      }
      return mat
    }
    return new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5, side })
  }
  if (shader?.type === "end_portal") {
    const skyBuf = await readFile(`assets/minecraft/textures/environment/end_sky.png`, assets)
    const skyTexture = await makeThreeTexture(skyBuf ? await loadImage(skyBuf) : new Canvas(1, 1))
    for (const t of [skyTexture, texture]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.needsUpdate = true
    }
    return new THREE.ShaderMaterial({
      uniforms: {
        GameTime: {
          value: 0.727
        },
        Scale: {
          value: 1
        },
        Aspect: {
          value: 1
        },
        Sampler0: {
          value: skyTexture
        },
        Sampler1: {
          value: texture
        }
      },
      vertexShader: `
        varying vec4 texProj0;
        #include <clipping_planes_pars_vertex>

        vec4 projection_from_position(vec4 position) {
          vec4 projection = position * 0.5;
          projection.xy = vec2(projection.x + projection.w, projection.y + projection.w);
          projection.zw = position.zw;
          return projection;
        }

        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          #include <clipping_planes_vertex>
          gl_Position = projectionMatrix * mvPosition;

          texProj0 = projection_from_position(gl_Position);
        }
      `,
      fragmentShader: `
        varying vec4 texProj0;
        #include <clipping_planes_pars_fragment>

        uniform float GameTime;
        uniform float Scale;
        uniform float Aspect;
        uniform sampler2D Sampler0;
        uniform sampler2D Sampler1;

        mat2 mat2_rotate_z(float radians) {
          return mat2(
            cos(radians), -sin(radians),
            sin(radians), cos(radians)
          );
        }

        vec3 getColor(int i) {
          if (i == 0) return vec3(0.022087, 0.098399, 0.110818);
          if (i == 1) return vec3(0.011892, 0.095924, 0.089485);
          if (i == 2) return vec3(0.027636, 0.101689, 0.100326);
          if (i == 3) return vec3(0.046564, 0.109883, 0.114838);
          if (i == 4) return vec3(0.064901, 0.117696, 0.097189);
          if (i == 5) return vec3(0.063761, 0.086895, 0.123646);
          if (i == 6) return vec3(0.084817, 0.111994, 0.166380);
          if (i == 7) return vec3(0.097489, 0.154120, 0.091064);
          if (i == 8) return vec3(0.106152, 0.131144, 0.195191);
          if (i == 9) return vec3(0.097721, 0.110188, 0.187229);
          if (i == 10) return vec3(0.133516, 0.138278, 0.148582);
          if (i == 11) return vec3(0.070006, 0.243332, 0.235792);
          if (i == 12) return vec3(0.196766, 0.142899, 0.214696);
          if (i == 13) return vec3(0.047281, 0.315338, 0.321970);
          if (i == 14) return vec3(0.204675, 0.390010, 0.302066);
          return vec3(0.080955, 0.314821, 0.661491);
        }

        const mat4 SCALE_TRANSLATE = mat4(
          0.5, 0.0, 0.0, 0.25,
          0.0, 0.5, 0.0, 0.25,
          0.0, 0.0, 1.0, 0.0,
          0.0, 0.0, 0.0, 1.0
        );

        mat4 end_portal_layer(float layer) {
          mat4 translate = mat4(
            0.25, 0.0, 0.0, 17.0 / layer,
            0.0, 0.25, 0.0, (2.0 + layer / 1.5) * (GameTime * 1.5),
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0
          );

          mat2 rotate = mat2_rotate_z(radians((layer * layer * 4321.0 + layer * 9.0) * 2.0));

          mat2 scale = mat2((4.5 - layer / 4.0) * 2.0);

          return mat4(scale * rotate) * translate * SCALE_TRANSLATE;
        }

        void main() {
          #include <clipping_planes_fragment>
          vec3 color = texture2DProj(Sampler0, texProj0 * vec4(Scale * Aspect, Scale, 1.0, 1.0)).rgb * getColor(0);
          for (int i = 0; i < ${shader.layers ?? 15}; i++) {
            color += texture2DProj(Sampler1, texProj0 * vec4(Scale * Aspect, Scale * 16.0 / 9.0, 1.0, 1.0) * end_portal_layer(float(i + 1))).rgb * getColor(i);
          }
          gl_FragColor = vec4(color, 1.0);
        }
        //salt:${shaderSalt}`,
      clipping: true
    })
  }
  const volume = lightConfig?.light?.uniforms ? lightConfig.light : null
  return new THREE.ShaderMaterial({
    defines: volume ? { LIGHT_VOLUME: "" } : {},
    uniforms: {
      map: { value: texture },
      light0: { value: new THREE.Vector3(...(lightConfig?.light0 ?? [0, 0, 1])) },
      light1: { value: new THREE.Vector3(...(lightConfig?.light1 ?? [0, 1, 0])) },
      d0: { value: lightConfig?.d0 ?? 0.6 },
      d1: { value: lightConfig?.d1 ?? 0.6 },
      ambient: { value: lightConfig?.ambient ?? 0.4 },
      shadeEnabled: { value: shadeEnabled !== false },
      shadeOverride: { value: new THREE.Vector3(...(SHADE_DIR_VECS[shadeDir] ?? [0, 0, 0])) },
      worldShade: { value: lighting === "world" },
      daytime: lightConfig?.daytime ?? { value: NAMED_TIMES.noon },
      emission: { value: emission / 15 },
      blockLightTint: { value: lightConfig?.blockLightTint ?? tintVec(null, 0xFFD88C) },
      skyLightColor: { value: lightConfig?.skyLightColor ?? tintVec(null, 0x7A7AFF) },
      ambientColor: { value: lightConfig?.ambientColor ?? tintVec(null, 0x0A0A0A) },
      skyLightFactor: { value: lightConfig?.skyLightFactor ?? -1 },
      brightness: { value: lightConfig?.brightness ?? 0.5 },
      shadePos: { value: new THREE.Vector3(lightConfig?.cardinal?.up ?? 1, lightConfig?.cardinal?.south ?? 0.8, lightConfig?.cardinal?.east ?? 0.6) },
      shadeNeg: { value: new THREE.Vector3(lightConfig?.cardinal?.down ?? 0.5, lightConfig?.cardinal?.north ?? 0.8, lightConfig?.cardinal?.west ?? 0.6) },
      aoEnabled: { value: ao !== false },
      ...(volume ? volume.uniforms : {}),
    },
    vertexShader: `
      ${parseInt(THREE.REVISION) >= 159 ? "#include <batching_pars_vertex>" : ""}
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vWorldNormal;
      #ifdef FACE_ATTRS
        attribute vec2 faceData;
        varying vec2 vFaceData;
      #endif
      #ifdef LIGHT_VOLUME
        varying vec3 vWorldPos;
      #endif
      #include <clipping_planes_pars_vertex>
      void main() {
        vUv = uv;
        #ifdef FACE_ATTRS
          vFaceData = faceData;
        #endif
        ${parseInt(THREE.REVISION) >= 159 ? "#include <batching_vertex>" : ""}
        vec4 pos = vec4(position, 1.0);
        vec3 nrm = normal;
        #ifdef USE_BATCHING
          pos = batchingMatrix * pos;
          nrm = mat3(batchingMatrix) * nrm;
        #endif
        #ifdef USE_INSTANCING
          pos = instanceMatrix * pos;
          nrm = mat3(instanceMatrix) * nrm;
        #endif
        vNormal = normalize(normalMatrix * nrm);
        vWorldNormal = normalize(mat3(modelMatrix) * nrm);
        #ifdef LIGHT_VOLUME
          vWorldPos = (modelMatrix * pos).xyz;
        #endif
        vec4 mvPosition = modelViewMatrix * pos;
        #include <clipping_planes_vertex>
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      uniform vec3 light0;
      uniform vec3 light1;
      uniform float d0;
      uniform float d1;
      uniform float ambient;
      uniform bool shadeEnabled;
      uniform vec3 shadeOverride;
      uniform bool worldShade;
      uniform float daytime;
      uniform float emission;
      uniform vec3 blockLightTint;
      uniform vec3 skyLightColor;
      uniform vec3 ambientColor;
      uniform float skyLightFactor;
      uniform float brightness;
      uniform vec3 shadePos;
      uniform vec3 shadeNeg;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vWorldNormal;
      #ifdef FACE_ATTRS
        varying vec2 vFaceData;
      #endif
      #ifdef LIGHT_VOLUME
        varying vec3 vWorldPos;
        uniform vec3 lightVolOrigin;
        uniform vec3 lightVolSize;
        uniform sampler2D lightVol;
        uniform vec2 lightVolTex;
        uniform float lightVolCols;
        vec2 sampleLightVol(vec3 p) {
          p = clamp(p, vec3(0.0), lightVolSize);
          float y0 = floor(p.y);
          float y1 = min(y0 + 1.0, lightVolSize.y);
          vec2 tile = lightVolSize.xz + 1.0;
          vec2 xz = vec2(p.x, p.z) + 0.5;
          vec2 uv0 = vec2(mod(y0, lightVolCols) * tile.x, floor(y0 / lightVolCols) * tile.y) + xz;
          vec2 uv1 = vec2(mod(y1, lightVolCols) * tile.x, floor(y1 / lightVolCols) * tile.y) + xz;
          vec2 l0 = texture2D(lightVol, uv0 / lightVolTex).rg;
          vec2 l1 = texture2D(lightVol, uv1 / lightVolTex).rg;
          return mix(l0, l1, p.y - y0);
        }
        uniform bool aoEnabled;
        float aoShade(vec3 c) {
          c = clamp(c, vec3(0.0), lightVolSize - 1.0);
          vec2 tile = lightVolSize.xz + 1.0;
          vec2 uv = vec2(mod(c.y, lightVolCols) * tile.x, floor(c.y / lightVolCols) * tile.y) + c.xz + 0.5;
          return texture2D(lightVol, uv / lightVolTex).b > 0.5 ? 0.2 : 1.0;
        }
        float aoCorner(vec3 base, vec3 da, vec3 db, vec3 axis, float sa, float sb, float sc) {
          bool blockedA = aoShade(base + da + axis) < 0.5;
          bool blockedB = aoShade(base + db + axis) < 0.5;
          float corner = (blockedA && blockedB) ? sa : aoShade(base + da + db);
          return (sa + sb + corner + sc) * 0.25;
        }
      #endif
      #include <clipping_planes_pars_fragment>
      void main() {
        #include <clipping_planes_fragment>
        if (vUv.x < 0.0 || vUv.x > 1.0 || vUv.y < 0.0 || vUv.y > 1.0) discard;
        vec4 texColor = texture2D(map, vUv);
        if (texColor.a < 0.01) discard;
        #ifdef FACE_ATTRS
          float emissionV = vFaceData.x;
          float faceFlags = vFaceData.y;
          bool aoOn = faceFlags >= 15.5;
          float faceDir = faceFlags - (aoOn ? 16.0 : 0.0);
          bool shadeOn = faceDir >= 7.5;
          faceDir -= shadeOn ? 8.0 : 0.0;
          vec3 shadeDirV = vec3(0.0);
          if (faceDir > 4.5) shadeDirV = vec3(faceDir > 5.5 ? -1.0 : 1.0, 0.0, 0.0);
          else if (faceDir > 2.5) shadeDirV = vec3(0.0, 0.0, faceDir > 3.5 ? -1.0 : 1.0);
          else if (faceDir > 0.5) shadeDirV = vec3(0.0, faceDir > 1.5 ? -1.0 : 1.0, 0.0);
        #else
          float emissionV = emission;
          #ifdef LIGHT_VOLUME
            bool aoOn = aoEnabled;
          #else
            bool aoOn = true;
          #endif
          bool shadeOn = shadeEnabled;
          vec3 shadeDirV = shadeOverride;
        #endif
        float shade = 1.0;
        vec3 light = vec3(1.0);
        if (worldShade) {
          if (shadeOn) {
            bool hasOverride = dot(shadeDirV, shadeDirV) > 0.5;
            vec3 wn = hasOverride ? shadeDirV : vWorldNormal;
            vec3 n2 = wn * wn;
            shade = (n2.y * (wn.y >= 0.0 ? shadePos.x : shadeNeg.x)
              + n2.z * (wn.z >= 0.0 ? shadePos.y : shadeNeg.y)
              + n2.x * (wn.x >= 0.0 ? shadePos.z : shadeNeg.z)) / (n2.x + n2.y + n2.z);
          }
          float skyFactor;
          vec3 skyColor;
          if (skyLightFactor < 0.0) {
            float td = mod(daytime - 730.0, 24000.0) + 730.0;
            if (td < 11270.0) {
              skyFactor = 1.0;
              skyColor = vec3(1.0);
            } else if (td < 13140.0) {
              float k = (td - 11270.0) / 1870.0;
              skyFactor = mix(1.0, 0.24, k);
              skyColor = mix(vec3(1.0), skyLightColor, k);
            } else if (td < 22860.0) {
              skyFactor = 0.24;
              skyColor = skyLightColor;
            } else {
              float k = (td - 22860.0) / 1870.0;
              skyFactor = mix(0.24, 1.0, k);
              skyColor = mix(skyLightColor, vec3(1.0), k);
            }
          } else {
            skyFactor = skyLightFactor;
            skyColor = skyLightColor;
          }
          float ao = 1.0;
          #ifdef LIGHT_VOLUME
            vec3 sn = gl_FrontFacing ? vWorldNormal : -vWorldNormal;
            vec3 lp = vWorldPos / 16.0 + 0.5 + sn * 0.5 - lightVolOrigin;
            vec2 lv = sampleLightVol(lp);
            float blockLevel = max(lv.x, emissionV);
            float skyLevel = lv.y;
            if (aoOn && emissionV < 0.001) {
              vec3 an = abs(sn);
              vec3 axis; vec3 t1; vec3 t2;
              if (an.y >= an.x && an.y >= an.z) { axis = vec3(0.0, sign(sn.y), 0.0); t1 = vec3(1.0, 0.0, 0.0); t2 = vec3(0.0, 0.0, 1.0); }
              else if (an.x >= an.z) { axis = vec3(sign(sn.x), 0.0, 0.0); t1 = vec3(0.0, 1.0, 0.0); t2 = vec3(0.0, 0.0, 1.0); }
              else { axis = vec3(0.0, 0.0, sign(sn.z)); t1 = vec3(1.0, 0.0, 0.0); t2 = vec3(0.0, 1.0, 0.0); }
              vec3 P = vWorldPos / 16.0 + 0.5 - lightVolOrigin;
              vec3 base = floor(P - axis * 0.0117);
              float edge = fract(dot(P, abs(axis)));
              if (edge < 0.0117 || edge > 0.9883) base += axis;
              float sc = aoShade(base);
              float sA0 = aoShade(base - t1);
              float sA1 = aoShade(base + t1);
              float sB0 = aoShade(base - t2);
              float sB1 = aoShade(base + t2);
              float q00 = aoCorner(base, -t1, -t2, axis, sA0, sB0, sc);
              float q10 = aoCorner(base, t1, -t2, axis, sA1, sB0, sc);
              float q01 = aoCorner(base, -t1, t2, axis, sA0, sB1, sc);
              float q11 = aoCorner(base, t1, t2, axis, sA1, sB1, sc);
              float f1 = fract(dot(P, t1));
              float f2 = fract(dot(P, t2));
              ao = mix(mix(q00, q10, f1), mix(q01, q11, f1), f2);
            }
          #else
            float blockLevel = emissionV;
            float skyLevel = 1.0;
          #endif
          float skyBrightness = skyLevel / (4.0 - 3.0 * skyLevel) * skyFactor;
          float blockBrightness = blockLevel / (4.0 - 3.0 * blockLevel) * 1.4;
          vec3 blockColor = mix(blockLightTint, vec3(1.0), 0.9 * (2.0 * blockLevel - 1.0) * (2.0 * blockLevel - 1.0));
          light = clamp(ambientColor + skyColor * skyBrightness + blockColor * blockBrightness, 0.0, 1.0);
          float lmMax = max(light.r, max(light.g, light.b));
          if (lmMax > 0.0) {
            float lmInv = 1.0 - lmMax;
            vec3 lmScaled = light * ((1.0 - lmInv * lmInv * lmInv * lmInv) / lmMax);
            light = mix(light, lmScaled, brightness);
          }
          light *= ao;
        } else if (shadeOn) {
          mat3 v = mat3(viewMatrix);
          bool hasOverride = dot(shadeDirV, shadeDirV) > 0.5;
          vec3 n = hasOverride ? v * shadeDirV : vNormal;
          shade = min(1.0, ambient + d0 * max(0.0, dot(n, v * light0)) + d1 * max(0.0, dot(n, v * light1)));
        }
        gl_FragColor = vec4(texColor.rgb * shade * light, texColor.a);
      }
      //salt:${shaderSalt}`,
    transparent: texture?.userData?.translucent === true,
    depthWrite: texture?.userData?.translucent !== true,
    side: doubleSided === "back" ? THREE.BackSide : doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    clipping: true,
  })
}
