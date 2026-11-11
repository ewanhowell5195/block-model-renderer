import { platform, THREE, Canvas, loadImage, loadTexture, AXIS_VECTORS, UV_CENTER, parseJson, normalize, resolveNamespace, isBefore, isImage } from "./platform.js"
import { COLORS, parseColor, getPotionColor } from "./colors.js"
import { blockRules, colorTables, itemRules } from "./data.js"
import { fluidHeights } from "./fluids.js"
import { prepareAssets, readFile, readFileAll, readJsonText, overlaysStandalone, getMissingImage, getAtlasesContaining, remapPalette, readPaletteTexture } from "./assets.js"
import { resolveProfile } from "./profiles.js"
import { buildAnimation, lcmTicks } from "./animation.js"
import { classifyPngAlpha, hashBytes } from "./png.js"
import { modelLoaders, activeLoaders, shadings } from "./loaders.js"
import { mapArtFor, mapIdOf } from "./maps.js"
import { neighborLookup } from "./neighbors.js"
import { matchesComponentPredicate, sameValue } from "./predicates.js"

const LEGACY_ITEM_PROPS = { holder_type: "context_entity_type", shift_down: "extended_view" }

export const DISPLAYS = {
  block: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] },
  block_90: { rotation: [30, 315, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] },
  block_180: { rotation: [30, 45, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] },
  block_270: { rotation: [30, 135, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] },
  flat: { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [1, 1, 1] }
}

export const SKIP_BLOCKS = new Set(["air", "cave_air", "void_air", "moving_piston"])
export const TECHNICAL_BLOCKS = new Set(["barrier", "light", "structure_void"])
export const AIR_BLOCKS = new RegExp(`(^|:)(${Array.from(SKIP_BLOCKS).join("|")})$`)

const BOX_PLANES = [[2, 1, 0, -1, -1, 2, 1, 0, 1], [2, 1, 0, 1, -1, 2, 1, 0, -1], [0, 2, 1, 1, 1, 0, 2, 1, 1], [0, 2, 1, 1, -1, 0, 2, 1, -1], [0, 1, 2, 1, -1, 0, 1, 2, 1], [0, 1, 2, -1, -1, 0, 1, 2, -1]]

const pendingTextures = new WeakMap()

let _hiddenMaterial = null
function hiddenMaterial() {
  return _hiddenMaterial ??= new THREE.MeshBasicMaterial({ visible: false })
}

export const FACE_ORDER = ["east", "west", "up", "down", "south", "north"]
export const QUAD_CORNERS = [0, 2, 1, 2, 3, 1]
const BOX_SIGNS = new Float32Array(72), BOX_UVS = new Float32Array(48), BOX_INDEX = new Uint16Array(36)
for (let p = 0; p < 6; p++) {
  const [u, v, w, udir, vdir, , , , ds] = BOX_PLANES[p]
  for (let k = 0; k < 4; k++) {
    const j = (p * 4 + k) * 3
    BOX_SIGNS[j + u] = (k & 1 ? 1 : -1) * udir
    BOX_SIGNS[j + v] = (k & 2 ? 1 : -1) * vdir
    BOX_SIGNS[j + w] = ds
    BOX_UVS[(p * 4 + k) * 2] = k & 1
    BOX_UVS[(p * 4 + k) * 2 + 1] = k & 2 ? 0 : 1
  }
  for (let k = 0; k < 6; k++) BOX_INDEX[p * 6 + k] = p * 4 + QUAD_CORNERS[k]
}

export function fillBox(pos, po, nrm, no, W, H, D) {
  const hw = W / 2, hh = H / 2, hd = D / 2
  for (let j = 0; j < 72; j += 3) {
    pos[po + j] = BOX_SIGNS[j] * hw
    pos[po + j + 1] = BOX_SIGNS[j + 1] * hh
    pos[po + j + 2] = BOX_SIGNS[j + 2] * hd
  }
  for (let p = 0; p < 6; p++) {
    const axis = p >> 1, dim = axis === 0 ? W : axis === 1 ? H : D
    const n = (p & 1 ? -dim : dim) > 0 ? 1 : -1
    for (let j = no + p * 12 + axis, end = j + 12; j < end; j += 3) nrm[j] = n
  }
}

function boxGeometry(W, H, D) {
  const pos = new Float32Array(72), nrm = new Float32Array(72), uv = new Float32Array(48), idx = new Uint16Array(36)
  fillBox(pos, 0, nrm, 0, W, H, D)
  uv.set(BOX_UVS)
  idx.set(BOX_INDEX)
  const geometry = new THREE.BufferGeometry()
  for (let p = 0; p < 6; p++) geometry.addGroup(p * 6, 6, p)
  geometry.setIndex(new THREE.BufferAttribute(idx, 1))
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3))
  geometry.setAttribute("normal", new THREE.BufferAttribute(nrm, 3))
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2))
  return geometry
}

let _scratch = null
function scratch() {
  return _scratch ??= {
    v: new THREE.Vector3(),
    v2: new THREE.Vector2(),
    center: new THREE.Vector3(),
    pivot: new THREE.Vector3(),
    one: new THREE.Vector3(1, 1, 1),
    quat: new THREE.Quaternion(),
    q1: new THREE.Quaternion(),
    identity: new THREE.Quaternion(),
    xAxis: new THREE.Vector3(1, 0, 0),
    yAxis: new THREE.Vector3(0, 1, 0),
    zAxis: new THREE.Vector3(0, 0, 1),
    matrix: new THREE.Matrix4(),
    parent: new THREE.Matrix4(),
    local: new THREE.Matrix4(),
    normalMatrix: new THREE.Matrix3()
  }
}

const UV_QUAD = new Float64Array(8)
const NO_TEXTURE = Symbol()
const worldCullfaceTables = new Map()

function rotateUVQuad(angle) {
  if (!angle) return
  const rad = THREE.MathUtils.degToRad(angle), vec = scratch().v2
  for (let k = 0; k < 8; k += 2) {
    vec.set(UV_QUAD[k], UV_QUAD[k + 1]).rotateAround(UV_CENTER, rad)
    UV_QUAD[k] = vec.x
    UV_QUAD[k + 1] = vec.y
  }
}

function setUVQuad(ax, ay, bx, by, cx, cy, dx, dy) {
  UV_QUAD[0] = ax
  UV_QUAD[1] = ay
  UV_QUAD[2] = bx
  UV_QUAD[3] = by
  UV_QUAD[4] = cx
  UV_QUAD[5] = cy
  UV_QUAD[6] = dx
  UV_QUAD[7] = dy
}

export function elementRescale(rotation) {
  let rescaleAxis = rotation.axis
  let rescaleAngle = rotation.angle
  if (rescaleAngle === undefined) {
    for (const a of ["x", "y", "z"]) {
      if (rotation[a]) {
        rescaleAxis = a
        rescaleAngle = rotation[a]
        break
      }
    }
  }
  if (!rescaleAngle) return null
  const angle = Math.abs(rescaleAngle)
  const rescale = 1 / Math.cos(THREE.MathUtils.degToRad(angle > 45 ? 90 - angle : angle))
  const axis = rescaleAxis || "y"
  return [axis === "x" ? 1 : rescale, axis === "y" ? 1 : rescale, axis === "z" ? 1 : rescale]
}

function rotationAllowed(model, rotation) {
  const { axis, angle } = rotation
  if (!isNaN(angle) || axis) {
    if (isNaN(angle) || !axis) return false
  }
  if (model.version && !model.overridden) {
    const preMultiAxis = isBefore(model.version, "1.21.11")
    if (axis && preMultiAxis && (Math.abs(angle) > 45 || (isBefore(model.version, "1.21.6") && angle % 22.5 !== 0))) return false
    if (!axis && preMultiAxis) return false
  }
  return true
}

export function scaleBox(data, o, sx, sy, sz) {
  const s = scratch(), v = s.v
  s.matrix.makeScale(sx, sy, sz)
  for (let j = o, end = o + 72; j < end; j += 3) {
    v.set(data[j], data[j + 1], data[j + 2]).applyMatrix4(s.matrix)
    data[j] = v.x
    data[j + 1] = v.y
    data[j + 2] = v.z
  }
  s.normalMatrix.getNormalMatrix(s.matrix)
  for (let j = o + 72, end = o + 144; j < end; j += 12) {
    v.set(data[j], data[j + 1], data[j + 2]).applyNormalMatrix(s.normalMatrix)
    data[j] = v.x
    data[j + 1] = v.y
    data[j + 2] = v.z
  }
}

export function elementMatrix(model, element, W, H, D) {
  const s = scratch(), from = element.from, rotation = element.rotation
  s.center.set(from[0] + W / 2 - 8, from[1] + H / 2 - 8, from[2] + D / 2 - 8)
  if (element.part && !rotation) {
    s.pivot.set((element.pivot?.[0] ?? 8) - 8, (element.pivot?.[1] ?? 8) - 8, (element.pivot?.[2] ?? 8) - 8)
    s.center.sub(s.pivot)
    s.matrix.multiplyMatrices(s.parent.compose(s.pivot, s.identity, s.one), s.local.compose(s.center, s.identity, s.one))
    return true
  }
  if (!rotation) {
    s.matrix.compose(s.center, s.identity, s.one)
    return true
  }
  if (!rotationAllowed(model, rotation)) return false
  const { origin, axis, angle, x, y, z } = rotation
  s.pivot.set(origin[0] - 8, origin[1] - 8, origin[2] - 8)
  s.center.sub(s.pivot)
  s.quat.identity()
  if (axis) {
    s.quat.multiply(s.q1.setFromAxisAngle(AXIS_VECTORS[axis], THREE.MathUtils.degToRad(angle)))
  } else {
    s.quat.multiply(s.q1.setFromAxisAngle(s.zAxis, THREE.MathUtils.degToRad(z ?? 0)))
    s.quat.multiply(s.q1.setFromAxisAngle(s.yAxis, THREE.MathUtils.degToRad(y ?? 0)))
    s.quat.multiply(s.q1.setFromAxisAngle(s.xAxis, THREE.MathUtils.degToRad(x ?? 0)))
  }
  s.matrix.multiplyMatrices(s.parent.compose(s.pivot, s.quat, s.one), s.local.compose(s.center, s.identity, s.one))
  return true
}

export function transformBox(data, o, collision, translated) {
  const s = scratch(), v = s.v
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (let j = o, end = o + 72; j < end; j += 3) {
    v.set(data[j], data[j + 1], data[j + 2]).applyMatrix4(s.matrix)
    if (v.x < x0) x0 = v.x
    if (v.y < y0) y0 = v.y
    if (v.z < z0) z0 = v.z
    if (v.x > x1) x1 = v.x
    if (v.y > y1) y1 = v.y
    if (v.z > z1) z1 = v.z
    data[j] = v.x
    data[j + 1] = v.y
    data[j + 2] = v.z
  }
  if (x0 !== Infinity) collision.push([x0, y0, z0, x1, y1, z1])
  if (translated) return
  s.normalMatrix.getNormalMatrix(s.matrix)
  for (let j = o + 72, end = o + 144; j < end; j += 12) {
    v.set(data[j], data[j + 1], data[j + 2]).applyMatrix3(s.normalMatrix).normalize()
    data[j] = v.x
    data[j + 1] = v.y
    data[j + 2] = v.z
  }
}

function addMergedMeshes(target, buckets, data, tints) {
  for (const [material, dirs] of buckets) {
    for (const [dir, faces] of dirs) {
      const count = faces.length * 6
      const position = new THREE.Float32BufferAttribute(count * 3, 3), normal = new THREE.Float32BufferAttribute(count * 3, 3), uv = new THREE.Float32BufferAttribute(count * 2, 2)
      const color = new THREE.BufferAttribute(new Uint8Array(count * 3), 3, true)
      const index = count > 65535 ? new THREE.Uint32BufferAttribute(count, 1) : new THREE.Uint16BufferAttribute(count, 1)
      const positions = position.array, normals = normal.array, uvs = uv.array, colors = color.array, indices = index.array
      let n = 0
      for (let f = 0; f < faces.length; f++) {
        const face = faces[f], p = face % 6, base = (face - p) * 32
        const pv = base + p * 12, nv = base + 72 + p * 12, tv = base + 144 + p * 8, cv = face * 3
        for (let k = 0; k < 6; k++, n++) {
          const corner = QUAD_CORNERS[k], a = pv + corner * 3, b = tv + corner * 2
          positions[n * 3] = data[a]
          positions[n * 3 + 1] = data[a + 1]
          positions[n * 3 + 2] = data[a + 2]
          normals[n * 3] = data[nv]
          normals[n * 3 + 1] = data[nv + 1]
          normals[n * 3 + 2] = data[nv + 2]
          uvs[n * 2] = data[b]
          uvs[n * 2 + 1] = data[b + 1]
          colors[n * 3] = tints[cv]
          colors[n * 3 + 1] = tints[cv + 1]
          colors[n * 3 + 2] = tints[cv + 2]
          indices[n] = n
        }
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute("position", position)
      geo.setAttribute("normal", normal)
      geo.setAttribute("uv", uv)
      geo.setAttribute("color", color)
      geo.setIndex(index)
      const mesh = new THREE.Mesh(geo, material)
      mesh.userData.cullface = [dir]
      target.add(mesh)
    }
  }
}

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

const AUTO_DYNAMICS = new Set(["banner", "dragon_head", "piglin_head", "enchanting_book", "loader"])
export const DYNAMIC_LOOPS = { banner: 100, dragon_head: 10, piglin_head: 50, enchanting_book: 314 }

export function isAutoDynamic(obj) {
  if (!AUTO_DYNAMICS.has(obj.userData?.dynamic)) return false
  const s = dynamicStates.get(obj)
  return !s || s.auto
}

export function poseSpecial(root, data = {}) {
  const kind = root?.userData?.dynamic
  if (!kind) return
  const s = dynState(root)
  if (AUTO_DYNAMICS.has(kind)) {
    s.auto = false
    s.held = Number(data.ticks) || 0
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

export function resumeSpecial(root) {
  const kind = root?.userData?.dynamic
  if (!AUTO_DYNAMICS.has(kind)) return
  const s = dynState(root)
  if (s.auto) return
  s.auto = true
  s.t0 = null
  s.from = kind === "loader" ? s.held ?? 0 : 0
  if (kind === "banner") s.seed = undefined
  if (s.book) s.book.last = null
}

// three's Object3D.copy json round trips userData for every object, which
// dominates instancing. per instance state lives in WeakMaps keyed by the
// root, so children can share theirs
export function cloneInstance(s, root) {
  const d = cloneNode(s, root)
  if (root) rebindSkins(s, d)
  return d
}

function cloneNode(s, root) {
  const d = s.isSkinnedMesh ? new THREE.SkinnedMesh(s.geometry, s.material)
    : s.isMesh ? new THREE.Mesh(s.geometry, s.material)
    : s.isLineSegments ? new THREE.LineSegments(s.geometry, s.material)
    : s.isBone ? new THREE.Bone()
    : new THREE.Group()
  d.name = s.name
  d.userData = root || s.isBone ? { ...s.userData } : s.userData
  d.visible = s.visible
  d.renderOrder = s.renderOrder
  d.matrixAutoUpdate = s.matrixAutoUpdate
  d.position.copy(s.position)
  d.quaternion.copy(s.quaternion)
  d.scale.copy(s.scale)
  d.matrix.copy(s.matrix)
  d.matrixWorldNeedsUpdate = true
  d.onBeforeRender = s.onBeforeRender
  for (const ch of s.children) d.add(cloneNode(ch, false))
  return d
}

export function rebindSkins(s, d) {
  const from = [], to = []
  s.traverse(o => from.push(o))
  d.traverse(o => to.push(o))
  let bones
  for (let i = 0; i < from.length; i++) {
    if (!from[i].isSkinnedMesh) continue
    bones ??= new Map(from.map((o, j) => [o, to[j]]))
    const skeleton = from[i].skeleton
    to[i].bind(new THREE.Skeleton(skeleton.bones.map(b => bones.get(b) ?? b), skeleton.boneInverses), from[i].bindMatrix)
  }
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

let dynClock = null
export function setDynamicClock(fn) { dynClock = fn }
let dynFrozen = false
export function freezeDynamics(frozen) { dynFrozen = frozen }
const dynNow = () => dynClock ? dynClock() : typeof performance !== "undefined" ? performance.now() : Date.now()

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
  if (s.frame === frame || dynFrozen && s.frame !== -1) return s.moved
  s.frame = frame
  const now = dynNow()
  const kind = root.userData.dynamic
  let moved
  if (kind === "banner") moved = bannerFrame(root, s, now)
  else if (kind === "bell") moved = bellFrame(root, s, now)
  else if (kind === "decorated_pot") moved = potFrame(root, s, now)
  else if (kind === "dragon_head" || kind === "piglin_head") moved = headFrame(root, s, now)
  else if (kind === "enchanting_book") moved = bookFrame(root, s, camera, now)
  else if (kind === "loader") moved = loaderFrame(root, s, now, camera)
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

function loaderFrame(root, s, now, camera) {
  if (!s.auto) return
  s.t0 ??= now - (s.from ?? 0) * 50
  applyDynamicPose(root, { ticks: (now - s.t0) / 50, camera })
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
    b = s.book = { time: 0, rot, oRot: rot, tRot: rot, open: 0, oOpen: 0, flip: 0, oFlip: 0, flipT: 0, flipA: 0, acc: 0, last: null, space: null }
  }
  if (b.last === null) b.last = now
  b.acc = Math.min(b.acc + (now - b.last), 250)
  b.last = now
  if (!b.space) {
    root.traverse(o => { if (!b.space && o.name?.startsWith("part:")) b.space = o.parent })
    b.space ??= root
  }
  _dcam ??= new THREE.Vector3()
  const cam = _dcam.setFromMatrixPosition(camera.matrixWorld)
  b.space.worldToLocal(cam)
  const range = (root.userData.range ?? 3) * 16
  while (b.acc >= 50) {
    b.acc -= 50
    bookTick(b, cam, range)
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

function bookTick(b, cam, range) {
  b.oOpen = b.open
  b.oRot = b.rot
  if (cam.x * cam.x + cam.y * cam.y + cam.z * cam.z < range * range - 0.001) {
    b.tRot = Math.atan2(cam.z, cam.x)
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
  if (kind === "loader") {
    for (const a of root.userData.loaderAnimations ?? []) a.animate(root, data.ticks ?? 0, data.camera)
    return
  }
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
  overworld: { skyLightFactor: "overworld", skyLightColor: 0x7A7AFF, ambientColor: 0x0A0A0A, blockLightTint: 0xFFD88C, cardinalLight: "default", hasSkyLight: true, fogColor: 0xC0D8FF, skyColor: 0x78A7FF },
  the_nether: { skyLightFactor: 0, skyLightColor: 0x7A7AFF, ambientColor: 0x302821, blockLightTint: 0xFFD88C, cardinalLight: "nether", hasSkyLight: false, fogColor: 0x330808, skyColor: 0x000000 },
  the_end: { skyLightFactor: 0, skyLightColor: 0xAC60CD, ambientColor: 0x3F473F, blockLightTint: 0xFFD88C, cardinalLight: "default", hasSkyLight: true, fogColor: 0x181318, skyColor: 0x000000 }
}

export const FOG_CURVE = [[133, 0xFFFFFF], [11867, 0xFFFFFF], [13670, 0x0C0C16], [22330, 0x161616]]

const PIXEL_GLOW = -2

export function fogSkyMix(renderDistance) {
  if (!(renderDistance > 0)) return 0
  const factor = 0.25 + 0.75 * Math.max(0, Math.min(1, Math.min(32, renderDistance) / 32))
  return 1 - Math.pow(factor, 0.25)
}

const glslColor = hex => `vec3(${(((hex >> 16) & 255) / 255).toFixed(4)}, ${(((hex >> 8) & 255) / 255).toFixed(4)}, ${((hex & 255) / 255).toFixed(4)})`

const FOG_GLSL = (() => {
  const [[t0], [t1], [t2, c2], [t3, c3]] = FOG_CURVE
  return `
      vec3 fogCurve(float t) {
        if (t >= ${t0.toFixed(1)} && t < ${t1.toFixed(1)}) return vec3(1.0);
        if (t >= ${t1.toFixed(1)} && t < ${t2.toFixed(1)}) return mix(vec3(1.0), ${glslColor(c2)}, (t - ${t1.toFixed(1)}) / ${(t2 - t1).toFixed(1)});
        if (t >= ${t2.toFixed(1)} && t < ${t3.toFixed(1)}) return mix(${glslColor(c2)}, ${glslColor(c3)}, (t - ${t2.toFixed(1)}) / ${(t3 - t2).toFixed(1)});
        float at = t >= ${t3.toFixed(1)} ? t - ${t3.toFixed(1)} : t + ${(24000 - t3).toFixed(1)};
        return mix(${glslColor(c3)}, vec3(1.0), at / ${(24000 - t3 + t0).toFixed(1)});
      }
      float celestialAngle(float tick) {
        float d = tick / 24000.0 - 0.25;
        d -= floor(d);
        return (d * 2.0 + (0.5 - cos(d * 3.14159265) / 2.0)) / 3.0;
      }
      float fogValue(float dist, float start, float end) {
        if (dist <= start) return 0.0;
        if (dist >= end) return 1.0;
        return (dist - start) / (end - start);
      }
      vec3 fogColorAt(vec3 dir) {
        if (!fogSunrise) return mix(fogBase, skyBase, fogSkyMix);
        float tick = mod(daytime, 24000.0);
        vec3 c = fogBase * fogCurve(tick);
        float angle = celestialAngle(tick) * 6.28318531;
        float cs = cos(angle);
        if (cs >= -0.4 && cs <= 0.4) {
          float f = cs / 0.4 * 0.5 + 0.5;
          float a = 1.0 - (1.0 - sin(f * 3.14159265)) * 0.99;
          a *= a;
          vec3 glow = vec3(f * 0.3 + 0.7, f * f * 0.7 + 0.2, 0.2);
          float toward = sin(angle) > 0.0 ? -1.0 : 1.0;
          float facing = fogGlow >= 0.0 ? fogGlow : (fogGlow < -1.5 ? dir.x : -viewMatrix[0][2]) * toward;
          if (facing > 0.0) c = mix(c, glow, clamp(facing * a, 0.0, 1.0));
        }
        return mix(c, skyBase * clamp(cs * 2.0 + 0.5, 0.0, 1.0), fogSkyMix);
      }`
})()

export function createFog(config, dimension) {
  const d = dimension && typeof dimension === "object" ? { ...LIGHT_DIMENSIONS.overworld, ...dimension } : LIGHT_DIMENSIONS[normalize(dimension ?? "overworld")] ?? LIGHT_DIMENSIONS.overworld
  return makeFog(config, d)
}

export function makeFog(config, dim) {
  if (config?.uniforms) return config
  const cfg = config && typeof config === "object" ? config : { distance: config }
  const uniforms = {
    fogStart: { value: 0 },
    fogEnd: { value: 1024 },
    fogNear: { value: 0 },
    fogFar: { value: 0 },
    fogBase: { value: tintVec(cfg.color ?? dim?.fogColor, 0xC0D8FF) },
    skyBase: { value: tintVec(dim?.skyColor, 0x78A7FF) },
    fogSkyMix: { value: 0 },
    fogCenter: { value: new THREE.Vector3() },
    fogFromCamera: { value: true },
    fogSunrise: { value: dim?.skyLightFactor === "overworld" },
    fogGlow: { value: -1 }
  }
  let distance = 0
  let anchor = null
  const fog = {
    uniforms,
    get distance() {
      return distance
    },
    set distance(chunks) {
      distance = Number(chunks) > 0 ? Number(chunks) : 0
      const blocks = distance * 16
      uniforms.fogNear.value = blocks - Math.max(4, Math.min(64, blocks / 10))
      uniforms.fogFar.value = distance > 0 ? blocks : 0
      uniforms.fogSkyMix.value = fogSkyMix(distance)
    },
    get color() {
      return uniforms.fogBase.value
    },
    set color(value) {
      uniforms.fogBase.value.copy(tintVec(value, 0xC0D8FF))
    },
    get sunriseGlow() {
      const glow = uniforms.fogGlow.value
      return glow === PIXEL_GLOW ? "pixel" : glow < 0 ? null : glow
    },
    set sunriseGlow(value) {
      uniforms.fogGlow.value = value === "pixel" ? PIXEL_GLOW : value == null || value === "camera" ? -1 : Math.max(0, Math.min(1, Number(value) || 0))
    },
    get anchor() {
      return anchor
    },
    set anchor(value) {
      if (value == null) anchor = null
      else if (value.isObject3D || value.isVector3) anchor = value
      else anchor = Array.isArray(value) ? new THREE.Vector3(value[0], value[1], value[2]) : new THREE.Vector3(value.x ?? 0, value.y ?? 0, value.z ?? 0)
      uniforms.fogFromCamera.value = !anchor
      fog.update()
    },
    update() {
      if (!anchor) return
      if (anchor.isObject3D) {
        anchor.updateMatrixWorld(true)
        uniforms.fogCenter.value.setFromMatrixPosition(anchor.matrixWorld)
      } else uniforms.fogCenter.value.copy(anchor)
    }
  }
  fog.distance = cfg.distance
  fog.sunriseGlow = cfg.sunriseGlow
  if (cfg.anchor != null) fog.anchor = cfg.anchor
  return fog
}

export function resolveWorldLighting(param) {
  const o = param && typeof param === "object" ? param : {}
  const d = o.dimension
  const dim = typeof d === "object" && d
    ? { ...LIGHT_DIMENSIONS.overworld, ...d }
    : LIGHT_DIMENSIONS[d] ?? LIGHT_DIMENSIONS.overworld
  const c = dim.cardinalLight
  const cardinal = typeof c === "object" && c ? { ...CARDINAL_LIGHTS.default, ...c } : CARDINAL_LIGHTS[c] ?? CARDINAL_LIGHTS.default
  return { dim, cardinal, daytime: o.daytime, brightness: Math.max(0, Math.min(1, o.brightness ?? 0.5)), light: o.light, rotateShade: o.rotateShade !== false, fog: o.fog }
}

export function parseDaytime(v) {
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

async function defaultBlockstateLayer(assets, file) {
  const properties = {}
  const rules = []
  for (const buf of await readFileAll(file, assets)) {
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
  return { properties, rules }
}

function defaultBlockstateTable(layers) {
  const properties = {}
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.properties)) {
      if (!(key in properties)) properties[key] = value
    }
  }
  const matched = new Map()
  function unique(block) {
    let hit = matched.get(block)
    if (hit === undefined) {
      hit = {}
      for (const layer of layers) {
        const rule = layer.rules.find(entry => entry.patterns.some(regex => regex.test(block)))
        if (!rule) continue
        for (const key in rule.value) if (!(key in hit)) hit[key] = rule.value[key]
      }
      matched.set(block, hit)
    }
    return hit
  }
  return { properties, unique }
}

export async function defaultBlockstates(assets, mode) {
  const tables = await ((assets.tables ?? assets).defaultBlockstates ??= (async () => {
    const base = await defaultBlockstateLayer(assets, "assets/block-model-renderer/default_blockstates.json")
    const preferred = await defaultBlockstateLayer(assets, "assets/block-model-renderer/default_blockstates_preferred.json")
    return { game: defaultBlockstateTable([base]), preferred: defaultBlockstateTable([preferred, base]) }
  })())
  return mode === "game" ? tables.game : tables.preferred
}

export function resolveTextureRef(textures, ref) {
  let first, seen
  while (typeof ref === "string" && ref.startsWith("#") && ref !== first && !seen?.has(ref)) {
    if (first === undefined) first = ref
    else (seen ??= new Set()).add(ref)
    ref = textures?.[ref.slice(1)]
  }
  return typeof ref === "string" && ref.startsWith("#") ? undefined : ref
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

const posHash = (x, y, z) => {
  const h = Math.imul(x, 3129871) ^ Math.imul(z, 116129781) ^ y
  return (Math.imul(Math.imul(h, h), 42317861) + Math.imul(h, 11) | 0) >>> 16
}

export function randomOffset(x, z, horizontal, vertical) {
  const h = posHash(x, 0, z)
  const step = bits => Math.fround(bits / 15)
  const spread = bits => Math.max(-horizontal, Math.min(horizontal, (step(bits) - 0.5) * 0.5))
  return [spread(h & 15), vertical ? (step((h >> 4) & 15) - 1) * Math.fround(vertical) : 0, spread((h >> 8) & 15)]
}

let limb0 = 0, limb1 = 0, limb2 = 0, limb3 = 0

function mulLimbs(a0, a1, a2, a3, b0, b1, b2, b3) {
  const c0 = a0 * b0
  let c1 = (c0 >>> 16) + a1 * b0
  let c2 = c1 >>> 16
  c1 = (c1 & 0xFFFF) + a0 * b1
  c2 += (c1 >>> 16) + a2 * b0
  let c3 = c2 >>> 16
  c2 = (c2 & 0xFFFF) + a1 * b1
  c3 += c2 >>> 16
  c2 = (c2 & 0xFFFF) + a0 * b2
  c3 += (c2 >>> 16) + a3 * b0 + a2 * b1 + a1 * b2 + a0 * b3
  limb0 = c0 & 0xFFFF
  limb1 = c1 & 0xFFFF
  limb2 = c2 & 0xFFFF
  limb3 = c3 & 0xFFFF
}

let seedHigh = 0, seedLow = 0

function positionSeed(x, y, z) {
  const xi = Math.imul(x, 3129871)
  const zs = z < 0 ? 0xFFFF : 0
  mulLimbs(z & 0xFFFF, z >>> 16, zs, zs, 116129781 & 0xFFFF, 116129781 >>> 16, 0, 0)
  const sign = (xi < 0 ? 0xFFFF : 0) ^ (y < 0 ? 0xFFFF : 0)
  const s0 = limb0 ^ xi & 0xFFFF ^ y & 0xFFFF
  const s1 = limb1 ^ xi >>> 16 ^ y >>> 16
  const s2 = limb2 ^ sign
  const s3 = limb3 ^ sign
  mulLimbs(s0, s1, s2, s3, 42317861 & 0xFFFF, 42317861 >>> 16, 0, 0)
  let t0 = limb0 + 11, t1 = limb1, t2 = limb2, t3 = limb3
  if (t0 > 0xFFFF) {
    t0 &= 0xFFFF
    if (++t1 > 0xFFFF) {
      t1 = 0
      if (++t2 > 0xFFFF) {
        t2 = 0
        t3 = t3 + 1 & 0xFFFF
      }
    }
  }
  mulLimbs(s0, s1, s2, s3, t0, t1, t2, t3)
  seedLow = (limb1 | limb2 << 16) >>> 0
  seedHigh = limb3 << 16 >> 16
}

let lcgHigh = 0, lcgLow = 0

function lcgSeed(high, low) {
  const l = (low ^ 0xDEECE66D) >>> 0
  lcgLow = l & 0xFFFFFF
  lcgHigh = l >>> 24 | ((high ^ 5) & 0xFFFF) << 8
}

function lcgNext(bits) {
  const low = lcgLow * 0xECE66D + 11
  const carry = Math.floor(low / 16777216)
  lcgHigh = (lcgHigh * 0xECE66D + lcgLow * 0x5DE + carry) % 16777216
  lcgLow = low - carry * 16777216
  return (lcgHigh * 2 ** (bits - 24) + (lcgLow >>> 48 - bits)) | 0
}

function lcgNextInt(bound) {
  if ((bound & bound - 1) === 0) return Math.floor(bound * lcgNext(31) / 2147483648)
  let sample, modulo
  do {
    sample = lcgNext(31)
    modulo = sample % bound
  } while ((sample - modulo + bound - 1 | 0) < 0)
  return modulo
}

function lcgNextLong() {
  const upper = lcgNext(32)
  const lower = lcgNext(32)
  seedHigh = (upper + (lower >> 31)) | 0
  seedLow = lower >>> 0
}

export function rollPicks(rolls, x, y, z) {
  positionSeed(x + rolls.shift[0], y + rolls.shift[1], z + rolls.shift[2])
  const high = seedHigh, low = seedLow
  let partHigh = 0, partLow = 0, partSeeded = false
  let key = 0
  for (const list of rolls.lists) {
    if (!list.part) lcgSeed(high, low)
    else {
      if (!partSeeded) {
        lcgSeed(high, low)
        lcgNextLong()
        partHigh = seedHigh
        partLow = seedLow
        partSeeded = true
      }
      lcgSeed(partHigh, partLow)
    }
    let r = lcgNextInt(list.total)
    let i = 0
    while (i < list.weights.length - 1 && (r -= list.weights[i]) >= 0) i++
    key = key * list.weights.length + i
  }
  return key
}

const BED_HEAD = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }

function seededRandom(seed) {
  let a = seed | 0
  return () => {
    a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function pickWeighted(value, roll) {
  if (!Array.isArray(value)) return value
  if (!roll || value.length <= 1) return value[0]
  let total = 0
  for (const entry of value) total += entry.weight ?? 1
  let r = roll(total)
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
  let data = args?.properties ?? {}
  assets = await prepareAssets(assets, args?.version ? { version: args.version } : undefined)
  const version = args?.version ?? assets.version
  const ignoreAtlases = args?.ignoreAtlases ?? assets.ignoreAtlases
  const defaultsMode = args?.defaults ?? assets.defaults
  const defaults = await defaultBlockstates(assets, defaultsMode)
  const rules = await blockRules(assets)
  const colors = await colorTables(assets)

  const { namespace, item: block } = resolveNamespace(blockstate)
  const defaultsId = normalize(blockstate)
  const stateValue = defaultsMode === "game"
    ? key => data[key] ?? defaults.unique(defaultsId)[key] ?? defaults.properties[key]
    : key => data[key]

  let variantRoll = null
  let partRoll = null
  const rolls = args?.rolls
  if (args?.seed != null) {
    const rand = seededRandom(args.seed)
    variantRoll = partRoll = total => rand() * total
  } else if (args?.pos || rolls) {
    const own = key => data[key] ?? defaults.unique(defaultsId)[key]
    const head = own("part") === "foot" ? BED_HEAD[own("facing") ?? defaults.properties.facing] : null
    const shift = [head ? head[0] : 0, own("half") === "upper" ? -1 : 0, head ? head[1] : 0]
    if (rolls) {
      rolls.shift = shift
      rolls.lists = []
    }
    if (args.pos) {
      positionSeed(args.pos[0] + shift[0], args.pos[1] + shift[1], args.pos[2] + shift[2])
      const high = seedHigh, low = seedLow
      lcgSeed(high, low)
      lcgNextLong()
      const partHigh = seedHigh, partLow = seedLow
      variantRoll = total => {
        lcgSeed(high, low)
        return lcgNextInt(total)
      }
      partRoll = total => {
        lcgSeed(partHigh, partLow)
        return lcgNextInt(total)
      }
    }
  }
  function recordRoll(value, part) {
    if (!rolls?.lists || !Array.isArray(value) || value.length <= 1) return
    const weights = value.map(e => e.weight ?? 1)
    rolls.lists.push({ part, weights, total: weights.reduce((a, b) => a + b, 0) })
  }

  let frameMapArt = null
  if (args?.nbt && /^(glow_)?item_frame$/.test(block) && /(^|:)filled_map$/.test(args.nbt.Item?.id ?? "")) {
    frameMapArt = await mapArtFor(assets, mapIdOf(args.nbt.Item), args.mapArt, { pos: args.pos, facing: data.facing ?? "north", nbt: args.nbt })
    if (!frameMapArt) data = { ...data, map: "false" }
  }

  let buf = await readJsonText(`assets/${namespace}/blockstates/${block}.json`, assets)
  const overlayBuf = await readJsonText(`assets/${namespace}/blockstates/${block}.json`, assets, true)
  if (buf && assets[buf.hintIndex]?.overrideRole === "additional") buf = null

  if (!buf && (!overlayBuf || !overlaysStandalone(version))) {
    if (rules.waterlogged(block)) return [waterPart(colors, args?.biome)]
    const m = { type: "block", model: "block-model-renderer:missing" }
    if (ignoreAtlases) m.ignore_atlas_restrictions = true
    if (version) m.version = version
    return [m]
  }

  const models = []
  let invalid = false
  let multipartFirst = null
  let multipartGroup = null
  if (buf) collectStateModels(parseJson(buf.text))
  if (overlayBuf) collectStateModels(parseJson(overlayBuf.text))
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
            const raw = data[k] ?? defaults.unique(defaultsId)[k] ?? defaults.properties[k]
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
        recordRoll(scored[0].value, false)
        models.push(pickWeighted(scored[0].value, variantRoll))
      }
    } else if (json.multipart) {
      const ranges = new Set
      const multipartDefaults = getMultipartDefaults(json.multipart)

      function evalWhen(when) {
        const group = when.OR ?? when.AND
        const isOr = !!when.OR
        let score = 0
        let match = !isOr
        const values = {}
        if (!group) {
          match = Object.entries(when).every(([k, v]) => {
            const allowed = v.toString().split("|")
            const raw = data[k] ?? defaults.unique(defaultsId)[k] ?? defaults.properties[k] ?? multipartDefaults[k]
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
          if (match) Object.assign(values, when)
          return { score, match, values }
        }
        for (const cond of group) {
          const result = evalWhen(cond)
          score += result.score
          if (result.match) Object.assign(values, result.values)
          if (isOr === result.match) {
            match = result.match
            break
          }
        }
        return { score, match, values }
      }

      const scoredParts = json.multipart.map((part, index) => {
        if (!part.when) return { score: 0, values: [], part, index, match: true }
        const { score, match, values } = evalWhen(part.when)
        return { score, values: Object.entries(values), part, index, match }
      }).filter(p => p.match)

      const usedKeyValues = {}
      let firstIndex = Infinity

      scoredParts
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .forEach(({ values, part, index }) => {
          if (values.some(([k, v]) => usedKeyValues[k] && usedKeyValues[k] !== v)) return
          for (const [key, value] of values) {
            if (ranges.has(key)) {
              usedKeyValues[key] = value
            }
          }
          recordRoll(part.apply, true)
          const apply = pickWeighted(part.apply, partRoll)
          if (!apply?.model) return
          models.push(apply)
          if (index < firstIndex) {
            firstIndex = index
            multipartFirst = apply
          }
        })
      if (models.length - start > 1) multipartGroup = models.slice(start)
    }

    for (const model of models.slice(start)) {
      if (json.light_emission != null) model.light_emission ??= json.light_emission
      if (version && isBefore(version, "1.21.11")) delete model.z
      if (json.allow_invalid_rotations) {
        model.allow_invalid_rotations = true
      } else if (model.x && model.x % 90 !== 0 || model.y && model.y % 90 !== 0 || model.z && model.z % 90 !== 0) {
        invalid = true
      }
    }
  }

  for (const model of models) {
    model.type = "block"
    if (ignoreAtlases) model.ignore_atlas_restrictions = true
    if (version) model.version = version
    if (version && isBefore(version, "1.13")) {
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
      model.tints = [WATER_BLOCKS.has(block) ? waterTint(args?.biome, colors.tables.fixed[block]) : colors.tables.fixed[block]]
    } else if (colors.tables.indexed[block]) {
      const entry = colors.tables.indexed[block]
      model.tints = [entry.colors[stateValue(entry.property)] ?? entry.colors[entry.default]]
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

  if (multipartGroup) {
    const ao = (await resolveModelData(assets, multipartFirst)).ambientocclusion !== false
    for (const model of multipartGroup) model.ambientocclusion = ao
  }

  if (args?.randomOffset && args.pos) {
    const limits = rules.offset(blockstate)
    if (limits) {
      const offset = randomOffset(args.pos[0], args.pos[2], limits[0], limits[1])
      for (const m of models) if (m && typeof m === "object") m.offset = offset
    }
  }

  const waterlogged = stateValue("waterlogged")
  if (((waterlogged === true || waterlogged === "true") && rules.waterloggable(block)) || rules.waterlogged(block)) {
    for (const m of models) if (m && typeof m === "object") m.waterlogged = true
    models.push(waterPart(colors, args?.biome))
  }

  if (args?.nbt) {
    const profile = args.nbt.profile ?? args.nbt.SkullOwner
    if (/^player_(wall_)?head$/.test(block) && profile != null) {
      for (const m of models) if (m && typeof m === "object") await applyProfile(assets, m, profile)
    }
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

async function applyProfile(assets, model, profile) {
  const resolved = await resolveProfile(assets, profile)
  if (!resolved) return
  if (resolved.skin.image) {
    const key = `block-model-renderer:profile/${resolved.id ?? resolved.name ?? "skin"}`
    model.texture_images = { ...model.texture_images, [key]: resolved.skin.image }
    model.textures = { ...model.textures, head: key }
  } else {
    model.textures = { ...model.textures, head: resolved.skin.texture }
  }
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
  const version = args.version ?? assets.version
  const context = block.endsWith("shelf") ? "on_shelf" : "fixed"
  const glintRules = await itemRules(assets)
  const itemArgs = id => ({
    version,
    ignoreAtlases: args.ignoreAtlases,
    components: id.components ?? {},
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
      if (block === "glow_item_frame") entry.light_emission = 15
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
      if (block === "glow_item_frame") entry.light_emission = 15
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

const WATER_BLOCKS = new Set(["water", "water_cauldron", "bubble_column"])

function waterPart(colors, biome) {
  return {
    model: "block-model-renderer:block/water",
    type: "block",
    fluid: "water",
    tints: [waterTint(biome, colors?.tables.fixed.water ?? "#3F76E4")],
    scale: [0.999, 0.999, 0.999]
  }
}

const tintInt = t => typeof t === "number" ? t : parseInt(String(t).replace("#", ""), 16)

function waterTint(biome, fallback) {
  const entries = biome == null ? [] : Array.isArray(biome) ? biome : [biome]
  let r = 0, g = 0, b = 0, total = 0
  for (const entry of entries) {
    if (entry.water === undefined) continue
    const v = tintInt(entry.water)
    const w = entry.weight ?? 1
    r += ((v >> 16) & 255) * w
    g += ((v >> 8) & 255) * w
    b += (v & 255) * w
    total += w
  }
  if (!total) return fallback
  const c = (Math.round(r / total) << 16 | Math.round(g / total) << 8 | Math.round(b / total)) >>> 0
  return "#" + c.toString(16).padStart(6, "0").toUpperCase()
}

export async function getBiomeTint(assets, mapName, biome) {
  if (mapName === "water") return waterTint(biome, (await colorTables(assets)).tables.fixed.water ?? "#3F76E4")
  const entries = biome == null ? [{}] : Array.isArray(biome) ? biome : [biome]
  if (!entries.length) entries.push({})
  const toInt = tintInt
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

function colormapPixels(assets, mapName) {
  const store = assets.cache && !assets.cache.ephemeral ? assets.cache : assets.tables ?? assets.cache
  const cache = store ? (store.colormapPixels ??= new Map()) : null
  let pixels = cache?.get(mapName)
  if (!pixels) {
    pixels = readFile(assets, `assets/minecraft/textures/colormap/${mapName}.png`).then(buf => buf ? platform.decodeToRaw(buf) : null)
    cache?.set(mapName, pixels)
  }
  return pixels
}

async function getColorMapTint(assets, mapName, temperature, downfall) {
  if (isNaN(temperature) || isNaN(downfall)) return "#FF00FF"
  temperature = Math.min(1, Math.max(0, temperature))
  downfall = Math.min(1, Math.max(0, downfall))

  const map = await colormapPixels(assets, mapName)
  if (!map) return "#FFFFFF"
  if (map.width !== 256 || map.height !== 256) return "#FF00FF"

  const x = Math.floor((1 - temperature) * 255)
  const y = Math.floor((1 - downfall * temperature) * 255)

  if (x < 0 || x > 255 || y < 0 || y > 255) return "#FF00FF"

  const i = (y * 256 + x) * 4
  const r = map.data[i], g = map.data[i + 1], b = map.data[i + 2]
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase()
}

const DEFAULT_SPECIAL_TRANSFORMS = {
  banner: { scale: [0.6666667, -0.6666667, -0.6666667], translation: [0.5, 0, 0.5] },
  head: { left_rotation: [1, 0, 0, 0], translation: [0.5, 0, 0.5] },
  player_head: { left_rotation: [1, 0, 0, 0], translation: [0.5, 0, 0.5] },
  conduit: { translation: [0.5, 0.5, 0.5] },
  shulker_box: { left_rotation: [1, 0, 0, 0], scale: [0.9995, 0.9995, 0.9995], translation: [0.5, 1.4995, 0.5] },
  shield: { scale: [1, -1, -1] }
}

const LEGACY_SPECIAL_ITEMS = {
  chest: { type: "chest", texture: "normal" },
  trapped_chest: { type: "chest", texture: "trapped" },
  ender_chest: { type: "chest", texture: "ender" },
  banner: { type: "banner", color: "white" },
  bed: { type: "bed", texture: "red" },
  skull: { type: "head", kind: "skeleton" },
  skeleton_skull: { type: "head", kind: "skeleton" },
  wither_skeleton_skull: { type: "head", kind: "wither_skeleton" },
  zombie_head: { type: "head", kind: "zombie" },
  creeper_head: { type: "head", kind: "creeper" },
  dragon_head: { type: "head", kind: "dragon" },
  piglin_head: { type: "head", kind: "piglin" },
  player_head: { type: "head", kind: "player" },
  shield: { type: "shield" },
  conduit: { type: "conduit" },
  decorated_pot: { type: "decorated_pot" },
  shulker_box: version => ({ type: "shulker_box", texture: version && isBefore(version, "1.13") ? "shulker_purple" : "shulker" }),
  silver_shulker_box: { type: "shulker_box", texture: "shulker_silver" }
}

for (const color of ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"]) {
  LEGACY_SPECIAL_ITEMS[`${color}_banner`] = { type: "banner", color }
  LEGACY_SPECIAL_ITEMS[`${color}_bed`] = { type: "bed", texture: color }
  LEGACY_SPECIAL_ITEMS[`${color}_shulker_box`] = { type: "shulker_box", texture: `shulker_${color}` }
}

async function legacyEntityModel(assets, namespace, item) {
  let ns = namespace
  let path = `item/${item}`
  for (let i = 0; i < 8; i++) {
    const buf = await readFile(assets, `assets/${ns}/models/${path}.json`)
    if (!buf) return false
    let parent
    try {
      parent = parseJson(buf).parent
    } catch {
      return false
    }
    if (!parent) return false
    if (parent.startsWith("builtin")) return parent === "builtin/entity"
    const resolved = resolveNamespace(parent.replace(/^minecraft:/, ""))
    ns = resolved.namespace
    path = resolved.item
  }
  return false
}

export async function parseItemDefinition(assets, itemId, args) {
  if (!itemId) throw new Error("parseItemDefinition requires an item id")
  if (assets == null || assets.length === 0) throw new Error("parseItemDefinition requires assets")
  const data = { ...(args?.components ?? {}) }
  if (data.custom_model_data != null && typeof data.custom_model_data !== "object") {
    data.custom_model_data = { floats: [Number(data.custom_model_data)] }
  }
  if (data.dyed_color != null && typeof data.dyed_color === "object" && "rgb" in data.dyed_color) {
    data.dyed_color = data.dyed_color.rgb
  }
  const display = args?.display ?? "gui"
  assets = await prepareAssets(assets, args?.version ? { version: args.version } : undefined)
  const version = args?.version ?? assets.version
  const ignoreAtlases = args?.ignoreAtlases ?? assets.ignoreAtlases

  const { namespace, item } = resolveNamespace(itemId)
  const glint = !!(args?.glint || itemHasFoil({ id: itemId, components: data }, await itemRules(assets)))

  const buf = await readFile(assets, `assets/${namespace}/items/${item}.json`)

  if (!buf) {
    const legacy = (!version || isBefore(version, "1.21.4")) && await readFile(assets, `assets/${namespace}/models/item/${item}.json`)
    const m = { type: "item", model: legacy ? `${namespace}:item/${item}` : "block-model-renderer:missing" }
    const special = legacy && namespace === "minecraft" && LEGACY_SPECIAL_ITEMS[item]
    if (special && await legacyEntityModel(assets, namespace, item)) {
      m.special = { ...(typeof special === "function" ? special(version) : special) }
      const dflt = DEFAULT_SPECIAL_TRANSFORMS[m.special.type]
      if (dflt) m.transformation = parseTransformation(dflt).elements
    }
    if (ignoreAtlases) m.ignore_atlas_restrictions = true
    if (version) m.version = version
    if (glint) m.glint = true
    return [m]
  }

  const json = parseJson(buf)

  const normalizedData = {}
  for (const key in data) normalizedData[normalize(key)] = data[key]
  const itemColors = await colorTables(assets)
  const models = await resolveItemModel(assets, json.model, normalizedData, display, undefined, version)
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    model.type = "item"
    if (ignoreAtlases) model.ignore_atlas_restrictions = true
    if (version) model.version = version
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
      if (data.profile != null) model.special.profile = data.profile
      if (data["base_color"] != null) model.special.base_color = data["base_color"]
      let transform = currentTransform
      if (!def.transformation && !accTransform) {
        const dflt = DEFAULT_SPECIAL_TRANSFORMS[model.special.type]
        if (dflt) transform = parseTransformation(dflt)
      }
      if (transform) model.transformation = transform.elements
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
      else if (prop === "charge_type") {
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
      const structured = prop === "component" && raw !== null && typeof raw === "object"
      const matched = def.cases.find(c => {
        const when = c.when
        if (structured) return sameValue(when, raw) || (Array.isArray(when) && when.some(entry => sameValue(entry, raw)))
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
        isTruthy = Object.hasOwn(data, component) && data[component] !== undefined && data[component] !== null
      } else if (prop === "component") {
        isTruthy = matchesComponentPredicate(data, def.predicate, def.value)
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
      const entries = (def.entries || []).slice().sort((a, b) => a.threshold - b.threshold)
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

async function loadMinecraftTexture(path, assets, type, drawn) {
  if (type === "block" || type === "item") {
    const atlases = await getAtlasesContaining(path, assets)
    const allowed = type === "block" ? ["blocks"] : ["blocks", "items"]
    if (!allowed.some(a => atlases.has(a))) return { image: await getMissingImage(assets) }
  }

  const buf = await readFile(assets, path)
  if (!buf) return { image: await getMissingImage(assets) }

  const image = (drawn || isImage(buf) ? null : await platform.loadPixelImage?.(buf)) ?? await loadImage(buf)
  const cls = isImage(buf) ? null : await classifyPngAlpha(buf, assets.translucency, platform.imagePixels?.(image)).catch(() => null)
  const srcHash = isImage(buf) ? null : hashBytes(buf)

  const metaBuf = await readFile(assets, path + ".mcmeta", buf.hintIndex)
  if (!metaBuf) return { image, cls, srcHash }
  let meta
  try {
    meta = parseJson(metaBuf).animation ?? {}
  } catch {
    return { image, cls, srcHash }
  }

  return { ...buildAnimation(image, meta), cls, srcHash }
}

async function loadPalettedTexture(path, palette, assets) {
  const buf = await readFile(assets, path)
  if (!buf) return { image: await getMissingImage(assets) }
  let basePalette
  try {
    basePalette = parseJson(await readFile(assets, path + ".mcmeta", buf.hintIndex)).palette?.base_palette
  } catch {}
  if (!basePalette) return { image: await loadImage(buf) }
  const [keyBuf, palBuf] = await Promise.all([readPaletteTexture(basePalette, assets), readPaletteTexture(palette, assets)])
  const remapped = keyBuf && palBuf ? await remapPalette(buf, keyBuf, palBuf).catch(() => null) : null
  return { image: remapped ? await loadImage(remapped) : await getMissingImage(assets) }
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

const _tintRGB = new Map()
function tintRGB(tint) {
  let c = _tintRGB.get(tint)
  if (!c && typeof tint === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(tint)) {
    const h = tint.length === 4 ? tint[1] + tint[1] + tint[2] + tint[2] + tint[3] + tint[3] : tint.slice(1)
    const n = parseInt(h, 16)
    _tintRGB.set(tint, c = [n >> 16, (n >> 8) & 255, n & 255])
  }
  if (!c) {
    const cv = new Canvas(1, 1)
    const ctx = cv.getContext("2d", { willReadFrequently: true })
    ctx.fillStyle = COLORS.dye[tint] ?? tint
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    c = [d[0], d[1], d[2]]
    _tintRGB.set(tint, c)
  }
  return c
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

export function flatPlaneYaws(models) {
  const elements = (Array.isArray(models) ? models : [models]).flatMap(m => m?.elements ?? [])
  if (elements.length < 2) return null
  const yaws = new Set()
  for (const el of elements) {
    const r = el.rotation
    let y = 0
    if (r) {
      y = r.axis ? (r.axis === "y" ? r.angle : null) : (r.x || r.z ? null : r.y ?? 0)
      if (y == null) return null
    }
    if (el.to[1] - el.from[1] === 0) return null
    const flatX = el.to[0] - el.from[0] === 0
    const flatZ = el.to[2] - el.from[2] === 0
    if (flatX === flatZ) return null
    yaws.add(((((flatX ? 90 : 0) + y) % 180) + 180) % 180)
  }
  if (yaws.size < 2) return null
  const list = Array.from(yaws)
  return list.every(v => ((((v - list[0]) % 90) + 90) % 90) === 0) ? list : null
}

export function isFlatModel(models) {
  return flatPlaneYaws(models) !== null
}

export function cloneData(v) {
  if (v === null || typeof v !== "object") return v
  if (Array.isArray(v)) {
    const n = v.length, a = new Array(n)
    for (let i = 0; i < n; i++) a[i] = cloneData(v[i])
    return a
  }
  if (ArrayBuffer.isView(v)) return v.slice()
  const o = {}
  for (const k in v) o[k] = cloneData(v[k])
  return o
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
  if (cacheKey && modelCache.has(cacheKey)) return cloneData(modelCache.get(cacheKey))

  let merged = {}

  let type
  if (typeof model === "object") {
    merged = cloneData(model)
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
        const file = await readJsonText(`assets/${currentNamespace}/models/${currentItem}.json`, assets)

        const sourceEntry = assets[file.hintIndex]
        if (sourceEntry?.bundledOverrides) {
          merged.overridden = true
        }

        json = parseJson(file.text)
      }

      stack.push(json)

      if (!json.parent || json.parent.startsWith("builtin")) break

      const parentId = json.parent.replace(/^minecraft:/, "")
      const resolved = resolveNamespace(parentId)
      currentNamespace = resolved.namespace
      currentItem = resolved.item
    }
  } catch {
    stack = [parseJson((await readJsonText("assets/block-model-renderer/models/missing.json", assets)).text)]
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
    } else if (key === "ambientocclusion") {
      merged.ambientocclusion ??= values.find(v => v != null)
    } else if (key === "display") {
      if (modelType === "block") continue
      merged.display ??= {}
      for (const layerDisplay of values) {
        const filled = { ...layerDisplay }
        if (filled.thirdperson_righthand && !filled.thirdperson_lefthand) filled.thirdperson_lefthand = filled.thirdperson_righthand
        if (filled.firstperson_righthand && !filled.firstperson_lefthand) filled.firstperson_lefthand = filled.firstperson_righthand
        for (const [slot, entry] of Object.entries(filled)) {
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
    if (!merged.textures[key]) delete merged.textures[key]
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
      for (const key of Object.keys(merged.textures ?? {})) {
        const match = key.match(/^layer(\d+)$/)
        const texRef = match && resolveTextureRef(merged.textures, merged.textures[key])
        if (texRef) {
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
    merged.elements = cloneData(merged.elements)
    applyPatternLayers(merged, { patterns: merged.banner_patterns }, dye, "banner", el => Object.values(el.faces ?? {}).some(f => f.texture === "#tinted"))
    delete merged.banner_patterns
  }

  if (!loaderOwned.has("parent")) delete merged.parent
  if (!loaderOwned.has("model")) delete merged.model
  if (merged.type === "block") delete merged.display

  if (cacheKey) modelCache.set(cacheKey, cloneData(merged))
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
      const clone = cloneData(el)
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
    modelPath = data.part
      ? `block-model-renderer:block/bed/_template_bed_${normalize(data.part)}`
      : "block-model-renderer:block/bed/_template_bed"
  } else {
    const baseItem = base ? resolveNamespace(base).item : null
    if (baseItem && await readFile(assets, `assets/block-model-renderer/models/${baseItem}.json`)) {
      modelPath = `block-model-renderer:${baseItem}`
    } else if (await readFile(assets, `assets/block-model-renderer/models/item/${data.type}.json`)) {
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
      if (data.part) {
        rotation = [-90, 180, 0]
        translation = [0, 0, -7]
      }
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
      if (data.profile != null && data.type === "player_head") await applyProfile(assets, model, data.profile)
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

export async function makeThreeTexture(img) {
  const texture = await loadTexture(img)
  texture.userData ??= {}
  texture.colorSpace = THREE.NoColorSpace
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  return texture
}

export async function loadSpriteTexture(path, assets) {
  const loaded = await loadMinecraftTexture(path, assets)
  if (!loaded?.image) return null
  const texture = await makeThreeTexture(loaded.image)
  if (loaded.cls) {
    texture.userData.translucent = loaded.cls.translucent
    texture.userData.opaque = loaded.cls.opaque
  }
  if (loaded.srcHash != null) texture.userData.srcHash = loaded.srcHash + "_" + loaded.image.width + "x" + loaded.image.height
  if (loaded.animated && loaded.frames) {
    texture.userData.frames = loaded.frames
    texture.userData.times = loaded.times
    texture.userData.interpolate = loaded.interpolate
    texture.userData.order = loaded.order
    texture.userData.name = path.replace(/^assets\/([^/]+)\/textures\//, "$1:").replace(/\.png$/, "")
  }
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

const settledAtlases = new WeakMap()

function settledAtlasSets(assets) {
  const memo = assets.atlasMembership
  if (!memo) return null
  let versions = settledAtlases.get(memo)
  if (!versions) settledAtlases.set(memo, versions = new Map())
  const version = assets.version ?? ""
  let sets = versions.get(version)
  if (!sets) versions.set(version, sets = new Map())
  return sets
}

export function texturePath(id) {
  const { namespace, item } = resolveNamespace(id)
  return `assets/${namespace}/textures/${item}.png`
}

function atlasMembershipsPass(model, memberships) {
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

function modelPassesAtlasRules(model, assets) {
  if (model.type !== "block" && model.type !== "item") return true
  if (shouldIgnoreAtlases(model)) return true
  const textures = model.textures ?? {}
  const usedSlots = new Set(), usedRefs = new Set()
  for (const el of model.elements ?? []) {
    for (const face of Object.values(el.faces ?? {})) {
      const ref = face?.texture
      if (typeof ref === "string" && ref.startsWith("#") && !usedRefs.has(ref)) {
        usedRefs.add(ref)
        usedSlots.add(ref.slice(1))
      }
    }
  }
  const values = []
  for (const slot of usedSlots) {
    const value = resolveTextureRef(textures, textures[slot])
    if (typeof value !== "string" || !value) continue
    values.push(value)
  }
  if (!values.length) return true

  const sets = settledAtlasSets(assets)
  const known = sets ? values.map(value => sets.get(value)) : null
  if (known && !known.includes(undefined)) return atlasMembershipsPass(model, known)
  return Promise.all(values.map(value => getAtlasesContaining(texturePath(value), assets))).then(memberships => {
    if (sets) for (let i = 0; i < values.length; i++) sets.set(values[i], memberships[i])
    return atlasMembershipsPass(model, memberships)
  })
}

export async function loadModel(assets, model, args) {
  if (model == null) throw new Error("loadModel requires a model")
  if (assets == null || assets.length === 0) throw new Error("loadModel requires assets")
  const parent = args?.parent
  const display = args?.display ?? "gui"
  const lightingArg = args?.lighting
  const lighting = lightingArg && typeof lightingArg === "object" ? "world" : lightingArg
  const world = lighting === "world" ? resolveWorldLighting(lightingArg) : null
  const light = world?.light && typeof world.light === "object" ? world.light : null
  const daytime = parent?.userData?.daytime ?? { value: parseDaytime(world?.daytime) }
  if (parent) parent.userData.daytime = daytime
  const fog = parent?.userData?.fog ?? (world?.fog?.uniforms ? world.fog : makeFog(world?.fog, world?.dim))
  if (parent) parent.userData.fog = fog
  const lightSwitches = parent?.userData?.lightSwitches ?? makeLightSwitches()
  if (parent) parent.userData.lightSwitches = lightSwitches
  const block = args?.block ? { ...args.block, neighbors: args.neighbors ? neighborLookup(args.neighbors) : args.block.neighbors ?? neighborLookup() } : null
  if (args?.version || !Array.isArray(assets) || !assets.prepared) assets = await prepareAssets(assets, args?.version ? { version: args.version } : undefined)
  if (!model.version && (args?.version ?? assets.version)) model.version = args?.version ?? assets.version

  let blockEmission = 0
  if (args?.emission != null) {
    blockEmission = Math.max(0, Math.min(15, args.emission))
  } else {
    if (block?.id) {
      const blockId = normalize(block.id)
      const defaults = await defaultBlockstates(assets, args?.defaults ?? assets.defaults)
      blockEmission = (await blockRules(assets)).emission(blockId, block.properties, k => {
        const raw = defaults.unique(blockId)[k] ?? defaults.properties[k]
        return Array.isArray(raw) ? raw[0] : raw
      })
    }
    if (model.light_emission != null) blockEmission = Math.max(blockEmission, Math.max(0, Math.min(15, model.light_emission)))
  }

  let passesAtlasRules = modelPassesAtlasRules(model, assets)
  if (passesAtlasRules instanceof Promise) passesAtlasRules = await passesAtlasRules
  if (!passesAtlasRules) {
    const missing = await resolveModelData(assets, { model: "block-model-renderer:missing" })
    for (const k of Object.keys(model)) delete model[k]
    Object.assign(model, missing)
  }

  const textureCache = assets.cache?.textures ?? new Map()
  let texturesLoading = pendingTextures.get(textureCache)
  if (!texturesLoading) pendingTextures.set(textureCache, texturesLoading = new Map())
  const materialCache = new Map()

  function resolveTexturePath(id) {
    const { namespace, item } = resolveNamespace(id)
    return `assets/${namespace}/textures/${item}.png`
  }

  function loadModelTexture(id, tint, source = {}) {
    const direct = source.image ?? (id != null ? model.texture_images?.[id] : undefined)
    const atlas = shouldIgnoreAtlases(model) ? "" : (model.type ?? "")
    const srgb = lighting === "scene" ? "\0srgb" : ""
    const cacheKey = `${id ?? ""}\0${tint ?? ""}\0${atlas}${srgb}${source.palette ? `\0${source.palette}` : ""}`
    if (direct) return buildModelTexture(id, tint, source, direct, cacheKey)
    if (textureCache.has(cacheKey)) return textureCache.get(cacheKey)
    let loading = texturesLoading.get(cacheKey)
    if (!loading) texturesLoading.set(cacheKey, loading = buildModelTexture(id, tint, source, direct, cacheKey).finally(() => texturesLoading.delete(cacheKey)))
    return loading
  }

  async function buildModelTexture(id, tint, source, direct, cacheKey) {
    let loaded
    if (direct) {
      loaded = { image: direct }
    } else if (id && source.palette) {
      loaded = await loadPalettedTexture(resolveTexturePath(id), source.palette, assets)
    } else if (id) {
      const path = resolveTexturePath(id)
      loaded = await loadMinecraftTexture(path, assets, shouldIgnoreAtlases(model) ? undefined : model.type, lighting === "scene")
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
    if (loaded.cls) {
      texture.userData.translucent = loaded.cls.translucent
      texture.userData.opaque = loaded.cls.opaque
    } else {
      texture.userData.translucent = imageIsTranslucent(image, assets.translucency)
    }
    if (loaded.srcHash != null) texture.userData.srcHash = (tint ? loaded.srcHash + "t" + tint : loaded.srcHash) + "_" + image.width + "x" + image.height
    if (loaded.animated && frames) {
      texture.userData.frames = frames
      texture.userData.times = loaded.times
      texture.userData.interpolate = loaded.interpolate
      texture.userData.order = loaded.order
      if (id != null) {
        const { namespace, item } = resolveNamespace(id)
        texture.userData.name = `${namespace}:${item}`
      }
    }

    if (direct) return texture
    if (assets.cache && !assets.cache.ephemeral) texture.userData.cached = true
    textureCache.set(cacheKey, texture)
    return texture
  }

  let settings
  const context = typeof display === "object" ? display.display ?? (display.type === "fallback" ? "gui" : null) : display
  if (typeof display === "object") {
    const own = context ? model.display?.[context] : null
    if (!context) {
      settings = cloneSettings(display)
    } else if (display.type === "fallback") {
      const withheld = display.generated === false && model.generated
      settings = own ? cloneSettings(own) : withheld ? {} : cloneSettings(display)
    } else {
      settings = { ...own, ...display }
    }
    delete settings.type
    delete settings.display
    delete settings.generated
    delete settings.rotateFlat
    leftHandFix(settings, context)

    const flatYaws = display.rotateFlat && settings.rotation && !model.waterlogged ? flatPlaneYaws(model) : null
    if (flatYaws) {
      const [x, y, z] = settings.rotation
      const euler = new THREE.Euler(THREE.MathUtils.degToRad(x), THREE.MathUtils.degToRad(y), THREE.MathUtils.degToRad(z))
      const edgeOn = flatYaws.some(angle => {
        const a = THREE.MathUtils.degToRad(angle)
        return Math.abs(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)).applyEuler(euler).z) < 0.01
      })
      if (edgeOn) {
        settings.rotation = [x, y - 45, z]
      }
    }
  } else {
    settings = leftHandFix(cloneSettings(model.display?.[display] ?? {}), context)
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
  lightConfig.nether = world?.dim.cardinalLight === "nether"
  lightConfig.fog = fog
  lightConfig.switches = lightSwitches
  if (world && world.rotateShade && settings?.rotation) {
    const [x, y, z] = settings.rotation
    const euler = new THREE.Euler(THREE.MathUtils.degToRad(x), THREE.MathUtils.degToRad(y), THREE.MathUtils.degToRad(z))
    lightConfig.shadeMat = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(euler)).invert()
  }

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
  const cullRotation = `${model?.x ?? 0},${model?.y ?? 0},${model?.z ?? 0}`
  let worldCullfaces = worldCullfaceTables.get(cullRotation)
  if (!worldCullfaces) {
    worldCullfaces = new Map()
    if (worldCullfaceTables.size < 256) worldCullfaceTables.set(cullRotation, worldCullfaces)
  }
  function worldCullface(dir) {
    let out = worldCullfaces.get(dir)
    if (out !== undefined) return out
    const v = CULL_VECS[dir]
    if (!v) {
      out = null
    } else {
      const w = scratch().v.set(v[0], v[1], v[2]).applyEuler(cullEuler)
      const ax = Math.abs(w.x), ay = Math.abs(w.y), az = Math.abs(w.z)
      if (ax >= ay && ax >= az) out = w.x > 0 ? "east" : "west"
      else if (ay >= az) out = w.y > 0 ? "up" : "down"
      else out = w.z > 0 ? "south" : "north"
    }
    if (worldCullfaces.size < 64) worldCullfaces.set(dir, out)
    return out
  }

  if (model.translation) {
    containerGroup.position.set(...model.translation)
  }
  if (model.offset) {
    containerGroup.position.x += model.offset[0] * 16
    containerGroup.position.y += model.offset[1] * 16
    containerGroup.position.z += model.offset[2] * 16
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
        const mkey = "minecraft:block/water_overlay\0false"
        let material = materialCache.get(mkey)
        if (!material) {
          material = await makeMaterial(await loadModelTexture("minecraft:block/water_overlay"), assets, model.shader, false, true, lightConfig, lighting, undefined, 0, false)
          materialCache.set(mkey, material)
        }
        mesh.material[mi] = material
        mesh.material[mi + 6] = hiddenMaterial()
      }
    }
    const vertIdx = {}
    for (let i = 8; i < 12; i++) vertIdx[cornerOf(i)] = i
    const order = [vertIdx.nw, vertIdx.sw, vertIdx.se, vertIdx.nw, vertIdx.se, vertIdx.ne]
    for (let k = 0; k < 6; k++) geo.index.setX(geo.groups[2].start + k, order[k])
    geo.index.needsUpdate = true
    if (heights.angle != null) {
      const texRef = resolveTextureRef(model.textures, "#flow")
      for (const [idx, side] of [[2, false], [8, "back"]]) {
        const mkey = `${texRef ?? ""}\0${side}\0flow`
        let material = materialCache.get(mkey)
        if (!material) {
          material = await makeMaterial(await loadModelTexture(texRef), assets, model.shader, side, true, lightConfig, lighting, undefined, 0, false)
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
      const hidden = hiddenMaterial()
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

  function elementFaces(element, uv, o, cullDirs) {
    const faces = element.faces
    for (let i = 0; i < 6; i++) {
      const faceName = FACE_ORDER[i]
      const face = faces?.[faceName]
      if (face?.cullface != null && face.cullface !== "" && !model.transformation) cullDirs[i] = worldCullface(face.cullface)
      if (!face) continue
      let u1, v1, u2, v2
      if (Array.isArray(face.uv)) {
        u1 = face.uv[0]
        v1 = face.uv[1]
        u2 = face.uv[2]
        v2 = face.uv[3]
      } else if (face.uv) {
        [u1, v1, u2, v2] = face.uv
      } else {
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

      const rot = face.rotation ?? 0
      if (rot === 90) setUVQuad(u1, v2, u1, v1, u2, v2, u2, v1)
      else if (rot === 180) setUVQuad(u2, v2, u1, v2, u2, v1, u1, v1)
      else if (rot === 270) setUVQuad(u2, v1, u2, v2, u1, v1, u1, v2)
      else setUVQuad(u1, v1, u2, v1, u1, v2, u2, v2)

      if (model?.uvlock) {
        let dir = faceName
        const x = ((model.x ?? 0) % 360 + 360) % 360

        if (x) {
          switch (faceName) {
            case "east":  rotateUVQuad(model.x); break
            case "west":  rotateUVQuad(-model.x); break
            case "north": rotateUVQuad(180); break
            case "south": rotateUVQuad(x === 180 ? 180 : 0); break
            case "up":    rotateUVQuad(x === 90 ? 180 : 0); break
            case "down":  rotateUVQuad(x === 270 ? 180 : 0); break
          }
          for (let n = 0; n < x / 90; n++) dir = X_CYCLE[dir] ?? dir
        }

        if (model.y) {
          const y = ((model.y % 360) + 360) % 360
          for (let n = 0; n < y / 90; n++) dir = Y_CYCLE[dir] ?? dir

          if (dir === "up" || dir === "down") {
            rotateUVQuad((dir === "up") ^ !!(x % 180) ? model.y : -model.y)
          }
        }

        if (model.z) {
          rotateUVQuad(dir === "north" ? -model.z : dir === "south" ? model.z : model.z)
        }
      }

      for (let k = 0, j = o + i * 8; k < 8; k += 2) {
        uv[j + k] = UV_QUAD[k] / 16
        uv[j + k + 1] = 1 - UV_QUAD[k + 1] / 16
      }
    }
  }

  function writeTint(tint, out, o, verts) {
    let [r, g, b] = tintRGB(tint)
    if (lighting === "scene") {
      const lin = new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace)
      r = Math.round(lin.r * 255)
      g = Math.round(lin.g * 255)
      b = Math.round(lin.b * 255)
    }
    for (const end = o + verts * 3; o < end; o += 3) {
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
    }
  }

  async function buildElements(elements, target, merge, strict) {
    let list = elements
    if (!Array.isArray(list)) {
      list = []
      for (const element of elements) list.push(element)
    }
    const data = merge ? new Float32Array(list.length * 192) : null
    const tints = merge ? new Uint8Array(list.length * 18).fill(255) : null
    const collision = [], buckets = new Map(), texRefs = new Map()
    const faceTints = [undefined, undefined, undefined, undefined, undefined, undefined]
    const mergedDirs = [null, null, null, null, null, null], mergedMaterials = []
    const ao = model.ambientocclusion !== false && blockEmission === 0
    let versioned = false, legacyShade = false, modernShade = false, elementEmission = false
    for (let e = 0; e < list.length; e++) {
      const element = list[e]
      const from = element.from, to = element.to
      const W = (to[0] - from[0]) || 0.001, H = (to[1] - from[1]) || 0.001, D = (to[2] - from[2]) || 0.001
      const rescale = element.rotation?.rescale ? elementRescale(element.rotation) : null
      const geometry = merge ? null : boxGeometry(W, H, D)
      const cullDirs = merge ? mergedDirs : [null, null, null, null, null, null]
      const materials = merge ? mergedMaterials : []
      if (merge) {
        const o = e * 192
        fillBox(data, o, data, o + 72, W, H, D)
        if (rescale) scaleBox(data, o, rescale[0], rescale[1], rescale[2])
        data.set(BOX_UVS, o + 144)
        for (let i = 0; i < 6; i++) cullDirs[i] = null
        elementFaces(element, data, o + 144, cullDirs)
      } else {
        if (rescale) geometry.scale(rescale[0], rescale[1], rescale[2])
        elementFaces(element, geometry.attributes.uv.array, 0, cullDirs)
        geometry.attributes.uv.needsUpdate = true
      }

      const faces = element.faces
      let shadeDir = null, emission = 0, described = false, sides = 1, tinted = false
      for (let s = 0; s < 2; s++) {
        if (s === 1) {
          if (!model.double_sided) break
          sides = 2
        }
        const side = s ? "back" : false
        let suffix = null, lastRef = NO_TEXTURE, lastMaterial = null
        for (let i = 0; i < 6; i++) {
          const faceName = FACE_ORDER[i]
          const face = faces?.[faceName]
          if (!face || !face.texture || (cull && cullDirs[i] && cull.has(cullDirs[i]) && !(model.fluid && faceName === "up"))) {
            materials[s * 6 + i] = hiddenMaterial()
            continue
          }

          if (!s && model.tints) {
            if (!tinted) faceTints.fill(undefined)
            faceTints[i] = model.tints[face.tintindex]
            tinted = true
          }

          let texRef = texRefs.get(face.texture)
          if (texRef === undefined) {
            texRef = face.texture
            if (texRef && !texRef.startsWith("#")) texRef = "#" + texRef
            texRef = resolveTextureRef(model.textures, texRef)
            texRefs.set(face.texture, texRef)
          }

          if (texRef !== lastRef) {
            if (suffix === null) {
              if (!described) {
                if (!versioned) {
                  legacyShade = !model.version || isBefore(model.version, "26.3")
                  modernShade = !model.version || !isBefore(model.version, "26.3")
                  elementEmission = !model.version || !isBefore(model.version, "1.21.2")
                  versioned = true
                }
                if (model.type !== "item") {
                  if (modernShade && SHADE_DIR_VECS[element.shade_direction_override]) shadeDir = element.shade_direction_override
                  else if (legacyShade && element.shade === false) shadeDir = "up"
                }
                emission = Math.max(blockEmission, elementEmission ? Math.max(0, Math.min(15, element.light_emission ?? 0)) : 0)
                described = true
              }
              suffix = `\0${shadeDir ?? ""}\0${side}\0${emission}\0${ao}`
            }
            const mkey = `${texRef ?? ""}${suffix}`
            let material = materialCache.get(mkey)
            if (!material) {
              let texture = loadModelTexture(texRef)
              if (texture instanceof Promise) texture = await texture
              material = makeMaterial(texture, assets, model.shader, side, true, lightConfig, lighting, shadeDir, emission, ao)
              if (material instanceof Promise) material = await material
              if (args?.shaderScale && material.uniforms?.Scale) material.uniforms.Scale.value = args.shaderScale
              materialCache.set(mkey, material)
            }
            lastRef = texRef
            lastMaterial = material
          }
          materials[s * 6 + i] = lastMaterial
        }
      }

      if (merge) {
        for (let i = 0; tinted && i < 6; i++) {
          if (faceTints[i] != null) writeTint(faceTints[i], tints, (e * 6 + i) * 3, 1)
        }
        if (!elementMatrix(model, element, W, H, D)) {
          if (strict) return false
          continue
        }
        transformBox(data, e * 192, collision, !element.rotation && !element.part)
        for (let s = sides - 1; s >= 0; s--) {
          for (let p = 0; p < 6; p++) {
            const material = materials[s * 6 + p]
            if (!material || material.visible === false) continue
            const dir = cullDirs[p] ?? null
            let dirs = buckets.get(material)
            if (!dirs) buckets.set(material, dirs = new Map())
            let quads = dirs.get(dir)
            if (!quads) dirs.set(dir, quads = [])
            quads.push(e * 6 + p)
          }
        }
        continue
      }

      if (sides === 2) {
        geometry.clearGroups()
        for (let p = 0; p < 6; p++) geometry.addGroup(p * 6, 6, p + 6)
        for (let p = 0; p < 6; p++) geometry.addGroup(p * 6, 6, p)
        cullDirs.push(...cullDirs)
      }

      const tintAttr = new Uint8Array(geometry.attributes.position.count * 3).fill(255)
      for (let i = 0; tinted && i < 6; i++) {
        if (faceTints[i] != null) writeTint(faceTints[i], tintAttr, i * 12, 4)
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(tintAttr, 3, true))

      const mesh = new THREE.Mesh(geometry, materials)
      mesh.userData.cullface = cullDirs
      mesh.userData.element = element
      mesh.position.set(
        from[0] + W / 2 - 8,
        from[1] + H / 2 - 8,
        from[2] + D / 2 - 8
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
        continue
      }

      if (element.rotation) {
        if (!rotationAllowed(model, element.rotation)) {
          if (strict) return false
          continue
        }
        const { origin, axis, angle, x, y, z } = element.rotation

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
    }
    if (merge) {
      target.userData.collision = collision
      addMergedMeshes(target, buckets, data, tints)
    }
    return true
  }

  const replaceElements = modelLoaders.some(l => l.replaceElements && l.match?.(model))
  const mergeElements = args?.mergeElements !== false && !model.fluid && (model.elements?.length ?? 0) > 1 && !(model.dynamic && model.elements?.some(e => e?.part))
  if (!(await buildElements(replaceElements ? [] : model.elements || [], containerGroup, mergeElements, true))) {
    return await loadModel(assets, await resolveModelData(assets, "block-model-renderer:missing"), { ...args, display })
  }

  const loaderAnimations = []
  for (const loader of activeLoaders()) {
    if (loader.build && loader.match?.(model)) {
      const built = await loader.build({
        group: containerGroup,
        model,
        assets,
        args,
        block,
        helpers: {
          THREE,
          lighting,
          daytime,
          readFile: (path, hint) => readFile(assets, path, hint),
          loadTexture: async (id, tint) => loadModelTexture(id, tint),
          resolveProfile: profile => resolveProfile(assets, profile),
          buildElements: async (elements = []) => {
            const g = new THREE.Group()
            await buildElements(elements, g, args?.mergeElements !== false && !model.fluid && elements.length > 1, false)
            return g
          },
          buildBlock: async (id, properties = {}) => {
            const g = new THREE.Group()
            Object.assign(g.userData, { daytime, fog, lightSwitches })
            const blockArgs = { parent: g, lighting: args?.lighting, shaderScale: args?.shaderScale, emission: args?.emission, defaults: args?.defaults, block: { id, properties, pos: null } }
            for (const m of await parseBlockstate(assets, id, { properties, defaults: args?.defaults, version: args?.version })) {
              await loadModel(assets, await resolveModelData(assets, m), blockArgs)
            }
            return g
          },
          buildItem: async (id, context = "none", components = {}) => {
            const g = new THREE.Group()
            Object.assign(g.userData, { daytime, fog, lightSwitches })
            const display = { type: "fallback", display: context }
            for (const m of await parseItemDefinition(assets, id, { components, display, version: args?.version })) {
              await loadModel(assets, await resolveModelData(assets, m), { parent: g, display, lighting: args?.lighting, shaderScale: args?.shaderScale, emission: args?.emission, defaults: args?.defaults })
            }
            return g
          },
          resolveTexture: ref => resolveTextureRef(model.textures, ref),
          createMaterial: async (id, opts = {}) => {
            const shadeDir = SHADE_DIR_VECS[opts.shade_direction] ? opts.shade_direction : null
            const emission = Math.max(0, blockEmission, Math.min(15, opts.light_emission ?? 0))
            const ao = opts.ao !== false && blockEmission === 0
            const opacity = Math.max(0, Math.min(1, opts.opacity ?? 1))
            const shading = opts.shading == null ? null : shadings.get(opts.shading)
            if (opts.shading != null && !shading) throw new Error(`Unknown shading ${JSON.stringify(opts.shading)}, register it with ModelLoader.registerShading`)
            const key = `loader\0${id}\0${opts.tint ?? ""}\0${opts.shade !== false}\0${shadeDir ?? ""}\0${!!opts.double_sided}\0${opts.shader ? JSON.stringify(opts.shader) : ""}\0${emission}\0${ao}\0${opacity}\0${opts.alpha ?? ""}\0${opts.blending ?? ""}\0${opts.palette ?? ""}\0${opts.shading ?? ""}`
            const translucent = opts.alpha === "translucent" ? true : opts.alpha === "cutout" ? false : undefined
            function applyBlending(material) {
              if (opts.blending !== "additive") return material
              material.blending = THREE.AdditiveBlending
              material.transparent = true
              material.depthWrite = false
              return material
            }
            const source = { image: opts.image, palette: opts.palette }
            if (opts.texture_offset) {
              const uvOffset = new THREE.Vector2()
              const material = await makeMaterial(await loadModelTexture(id, opts.tint, source), assets, opts.shader, opts.double_sided, opts.shade !== false, lightConfig, lighting, shadeDir, emission, ao, opacity, translucent, uvOffset, shading)
              material.userData.uvOffset = uvOffset
              return applyBlending(material)
            }
            let material = opts.image ? null : materialCache.get(key)
            if (!material) {
              material = applyBlending(await makeMaterial(await loadModelTexture(id, opts.tint, source), assets, opts.shader, opts.double_sided, opts.shade !== false, lightConfig, lighting, shadeDir, emission, ao, opacity, translucent, null, shading))
              if (!opts.image) materialCache.set(key, material)
            }
            return material
          }
        }
      })
      if (typeof built?.animate === "function") loaderAnimations.push(built)
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

  if (model.outline) {
    const from = model.outline.from ?? [7.2, 7.2, 7.2]
    const to = model.outline.to ?? [8.8, 8.8, 8.8]
    const box = new THREE.BoxGeometry(to[0] - from[0], to[1] - from[1], to[2] - from[2])
    const edges = new THREE.EdgesGeometry(box)
    box.dispose()
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
      color: new THREE.Color(model.outline.color ?? "#ffffff"),
      transparent: (model.outline.opacity ?? 1) < 1,
      opacity: model.outline.opacity ?? 1
    }))
    line.position.set((from[0] + to[0]) / 2 - 8, (from[1] + to[1]) / 2 - 8, (from[2] + to[2]) / 2 - 8)
    line.userData.outline = true
    containerGroup.add(line)
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
            return hiddenMaterial()
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
  } else if (loaderAnimations.length) {
    rootGroup.userData.dynamic = "loader"
    rootGroup.userData.loaderAnimations = loaderAnimations
    rootGroup.userData.loop = loaderAnimations.reduce((acc, a) => a.loop > 0 ? acc ? lcmTicks(acc, a.loop) : a.loop : acc, 0)
    initDynamic(rootGroup)
    applyDynamicPose(rootGroup, {})
  }

  rootGroup.userData.model = model
  if (parent) parent.add(rootGroup)

  return rootGroup
}

let shaderSalt = 0

export function shaderSaltNow() {
  return shaderSalt
}

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

export function restoreShaderSalt(scene, salt) {
  shaderSalt = salt
  patchShaderSalt(scene)
}

export function tintVec(input, fallback) {
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
  const buf = await readFile(assets, "assets/minecraft/textures/misc/enchanted_glint_item.png")
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
        vec2 uvEdge = fwidth(vUv) * 0.5;
        if (vUv.x < -uvEdge.x || vUv.x > 1.0 + uvEdge.x || vUv.y < -uvEdge.y || vUv.y > 1.0 + uvEdge.y) discard;
        if (texture2D(map, vUv).a < 0.5) discard;
        float ticks = GameTime * 24000.0;
        vec2 offset = vec2(-fract(ticks / 550.0), fract(ticks / 150.0));
        vec2 uvGlint = mat2(0.9848078, 0.1736482, -0.1736482, 0.9848078) * (vUv * 0.25) + offset;
        gl_FragColor = vec4(texture2D(glintMap, uvGlint).rgb * 0.75, 1.0);
      }
    `,
    clipping: true,
    extensions: { derivatives: true },
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

function sharedUniformsOf(source) {
  if (!source?.isObject3D) return source?.uniforms ?? null
  let found = null
  source.traverse(o => {
    if (found || !o.material) return
    for (const m of [].concat(o.material)) {
      if (m?.uniforms?.worldShade) {
        found = m.uniforms
        break
      }
    }
  })
  return found
}

export function rebindUniforms(target, source) {
  const shared = sharedUniformsOf(source)
  if (!shared) return target
  function bind(m) {
    if (!m?.uniforms?.worldShade) return
    for (const k of REBIND_UNIFORMS) if (shared[k]) m.uniforms[k] = shared[k]
    if (shared.lightVol && (m.defines?.LIGHT_VOLUME === undefined || (m.defines.AO_NEIGHBORS !== undefined) !== !!shared.lightAoCols)) {
      const { AO_NEIGHBORS, ...defines } = m.defines ?? {}
      m.defines = { ...defines, ...lightDefines(shared) }
      m.needsUpdate = true
    }
  }
  if (target?.isObject3D) target.traverse(o => { if (o.material) for (const m of [].concat(o.material)) bind(m) })
  else for (const m of [].concat(target ?? [])) bind(m)
  return target
}

export function makeLightSwitches() {
  return { shading: { value: true }, ambientOcclusion: { value: true }, fullbright: { value: false } }
}

function lightDefines(uniforms) {
  return uniforms.lightAoCols ? { LIGHT_VOLUME: "", AO_NEIGHBORS: "" } : { LIGHT_VOLUME: "" }
}

export const REBIND_UNIFORMS = ["daytime", ...Object.keys(makeLightSwitches()), "lightVol","lightAo", "lightAoMask", "lightAoTex", "lightAoCols", "lightVolOrigin", "lightVolSize", "lightVolTex", "lightVolCols", "fogStart", "fogEnd", "fogNear", "fogFar", "fogBase", "skyBase", "fogSkyMix", "fogCenter", "fogFromCamera", "fogSunrise", "fogGlow"]

export function occlusionStateKey(id, props, defaults) {
  let key = defaults === "game" ? id + "\0game" : id
  if (props) for (const k of Object.keys(props).sort()) key += "," + k + "=" + props[k]
  return key
}

export async function occlusionModels(assets, id, props, version, defaults) {
  const models = await parseBlockstate(assets, id, { properties: props ?? {}, ignoreAtlases: true, version, defaults })
  if (models.some(model => model.model === "block-model-renderer:missing")) return null
  const resolved = []
  for (const model of models) resolved.push(await resolveModelData(assets, model))
  return resolved
}

export async function buildOcclusionModel(assets, models, defaults) {
  const g = new THREE.Group()
  for (const model of models) await loadModel(assets, model, { parent: g, display: {}, animate: false, defaults })
  return g
}

function cloneSettings(settings) {
  if (settings !== null && typeof settings === "object" && Object.getPrototypeOf(settings) === Object.prototype && Object.keys(settings).length === 0) return {}
  return structuredClone(settings)
}

function leftHandFix(settings, context) {
  if (context !== "thirdperson_lefthand" && context !== "firstperson_lefthand") return settings
  if (settings.translation) settings.translation = [-settings.translation[0], settings.translation[1], settings.translation[2]]
  if (settings.rotation) settings.rotation = [settings.rotation[0], -settings.rotation[1], -settings.rotation[2]]
  return settings
}

let _vertexSource = null, _vertexRevision = null, _fragmentSource = null, _fragmentSalt = null

function setVertexSource(source) {
  _vertexRevision = THREE.REVISION
  _vertexSource = source
  return source
}

function setFragmentSource(source) {
  _fragmentSalt = shaderSalt
  _fragmentSource = source
  return source
}

function unitVector(v, flipY = false) {
  return new THREE.Vector3(v[0], flipY ? -v[1] : v[1], v[2]).normalize()
}

async function endPortalMaterial(texture, assets, shader) {
  const skyBuf = await readFile(assets, `assets/minecraft/textures/environment/end_sky.png`)
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

function makeMaterial(texture, assets, shader, doubleSided, shadeEnabled, lightConfig, lighting, shadeDir, emission = 0, ao = true, opacity = 1, translucent, uvOffset = null, shading = null) {
  const levelLights = shading?.[lightConfig?.nether ? "nether" : "level"]
  const gui = shading ? { light0: unitVector(shading.ui.lights[0], true), light1: unitVector(shading.ui.lights[1], true), d0: shading.ui.power, d1: shading.ui.power, ambient: shading.ui.ambient } : { light0: new THREE.Vector3(...(lightConfig?.light0 ?? [0, 0, 1])), light1: new THREE.Vector3(...(lightConfig?.light1 ?? [0, 1, 0])), d0: lightConfig?.d0 ?? 0.6, d1: lightConfig?.d1 ?? 0.6, ambient: lightConfig?.ambient ?? 0.4 }
  if (uvOffset && lighting === "scene") {
    texture = texture.clone()
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.offset = uvOffset
    texture.needsUpdate = true
  }
  const blend = (translucent ?? texture?.userData?.translucent === true) || opacity < 1
  if (lighting === "scene" && shader?.type !== "end_portal") {
    if (texture.colorSpace !== THREE.SRGBColorSpace) {
      texture.colorSpace = THREE.SRGBColorSpace
      texture.needsUpdate = true
    }
    const side = doubleSided === "back" ? THREE.BackSide : doubleSided ? THREE.DoubleSide : THREE.FrontSide
    const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0, alphaTest: translucent === false ? 0.1 : 0.01, side, vertexColors: true, opacity, transparent: blend, depthWrite: !blend || translucent === true })
    if (emission > 0) {
      mat.emissive = new THREE.Color(0xffffff)
      mat.emissiveMap = texture
      mat.emissiveIntensity = emission / 15
    }
    return mat
  }
  if (shader?.type === "end_portal") return endPortalMaterial(texture, assets, shader)
  const volume = lightConfig?.light?.uniforms ? lightConfig.light : null
  const material = new THREE.ShaderMaterial({
    defines: Object.assign(volume ? lightDefines(volume.uniforms) : {}, translucent === false ? { CUTOUT: "" } : {}, uvOffset ? { UV_OFFSET: "" } : {}),
    uniforms: {
      map: { value: texture },
      light0: { value: gui.light0 },
      light1: { value: gui.light1 },
      d0: { value: gui.d0 },
      d1: { value: gui.d1 },
      ambient: { value: gui.ambient },
      diffuseOn: { value: !!levelLights },
      diffuse0: { value: levelLights ? unitVector(levelLights.lights[0]) : new THREE.Vector3() },
      diffuse1: { value: levelLights ? unitVector(levelLights.lights[1]) : new THREE.Vector3() },
      diffuseMix: { value: new THREE.Vector2(levelLights?.power ?? 0, levelLights?.ambient ?? 0) },
      shadeEnabled: { value: shadeEnabled !== false && lighting !== "off" },
      shadeOverride: { value: new THREE.Vector3(...(SHADE_DIR_VECS[shadeDir] ?? [0, 0, 0])) },
      worldShade: { value: lighting === "world" },
      ...(lightConfig?.switches ?? makeLightSwitches()),
      daytime: lightConfig?.daytime ?? { value: NAMED_TIMES.noon },
      emission: { value: emission / 15 },
      blockLightTint: { value: lightConfig?.blockLightTint ?? tintVec(null, 0xFFD88C) },
      skyLightColor: { value: lightConfig?.skyLightColor ?? tintVec(null, 0x7A7AFF) },
      ambientColor: { value: lightConfig?.ambientColor ?? tintVec(null, 0x0A0A0A) },
      skyLightFactor: { value: lightConfig?.skyLightFactor ?? -1 },
      brightness: { value: lightConfig?.brightness ?? 0.5 },
      shadePos: { value: new THREE.Vector3(lightConfig?.cardinal?.up ?? 1, lightConfig?.cardinal?.south ?? 0.8, lightConfig?.cardinal?.east ?? 0.6) },
      shadeNeg: { value: new THREE.Vector3(lightConfig?.cardinal?.down ?? 0.5, lightConfig?.cardinal?.north ?? 0.8, lightConfig?.cardinal?.west ?? 0.6) },
      shadeMat: { value: lightConfig?.shadeMat ?? new THREE.Matrix3() },
      aoEnabled: { value: ao !== false && !shading },
      opacity: { value: opacity },
      uvOffset: { value: uvOffset ?? new THREE.Vector2() },
      ...(lightConfig?.fog?.uniforms ?? makeFog(0).uniforms),
      ...(volume ? volume.uniforms : {}),
    },
    vertexShader: _vertexRevision === THREE.REVISION ? _vertexSource : setVertexSource(`
      ${parseInt(THREE.REVISION) >= 159 ? "#include <batching_pars_vertex>" : ""}
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vWorldNormal;
      varying vec3 vFogPos;
      attribute vec3 color;
      varying vec3 vTint;
      #ifdef FACE_ATTRS
        attribute vec2 faceData;
        varying vec2 vFaceData;
      #endif
      #ifdef TILED
        attribute vec4 tileRect;
        varying vec4 vTileRect;
        varying vec2 vTileSpan;
        #ifdef TILE_LOOKUP
          attribute vec2 tileLookup;
          varying vec2 vTileLookup;
        #endif
      #endif
      #ifdef LIGHT_VOLUME
        uniform vec3 lightVolOrigin;
        varying vec3 vLightPos;
      #endif
      #include <clipping_planes_pars_vertex>
      #include <skinning_pars_vertex>
      void main() {
        vUv = uv;
        vTint = color;
        #ifdef FACE_ATTRS
          vFaceData = faceData;
        #endif
        #ifdef TILED
          vTileRect = tileRect;
          vTileSpan = vec2(0.0);
          #ifdef TILE_LOOKUP
            vTileLookup = vec2(-1.0);
          #endif
          if (tileRect.z > 0.5) {
            vec2 tileSpan = floor(uv);
            vec2 tileBits = floor((uv - tileSpan) * 8.0 + 0.5);
            vec2 tileCorner = step(3.5, tileBits);
            tileBits -= tileCorner * 4.0;
            vec2 tileTurn = step(1.5, tileBits);
            tileBits -= tileTurn * 2.0;
            #ifdef TILE_LOOKUP
              if (tileBits.y > 0.5) vTileLookup = tileLookup;
            #endif
            if (tileTurn.x > 0.5) {
              tileSpan = tileSpan.yx;
              tileCorner = tileCorner.yx;
            }
            vTileSpan = tileSpan;
            vUv = abs(tileCorner - vec2(tileBits.x, tileTurn.y)) * tileSpan;
          }
        #endif
        ${parseInt(THREE.REVISION) >= 159 ? "#include <batching_vertex>" : ""}
        vec4 pos = vec4(position, 1.0);
        vec3 nrm = normal;
        #ifdef USE_SKINNING
          mat4 skinMatrix = skinWeight.x * getBoneMatrix(skinIndex.x) + skinWeight.y * getBoneMatrix(skinIndex.y) + skinWeight.z * getBoneMatrix(skinIndex.z) + skinWeight.w * getBoneMatrix(skinIndex.w);
          skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
          pos = skinMatrix * pos;
          nrm = mat3(skinMatrix) * nrm;
        #endif
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
        vFogPos = (modelMatrix * pos).xyz;
        #ifdef LIGHT_VOLUME
          vLightPos = (modelMatrix * pos).xyz / 16.0 + 0.5 - lightVolOrigin;
        #endif
        vec4 mvPosition = modelViewMatrix * pos;
        #include <clipping_planes_vertex>
        gl_Position = projectionMatrix * mvPosition;
      }
    `),
    fragmentShader: _fragmentSalt === shaderSalt ? _fragmentSource : setFragmentSource(`
      uniform sampler2D map;
      uniform float opacity;
      uniform vec2 uvOffset;
      uniform vec3 light0;
      uniform vec3 light1;
      uniform float d0;
      uniform float d1;
      uniform float ambient;
      uniform bool shadeEnabled;
      uniform vec3 shadeOverride;
      uniform bool worldShade;
      uniform bool shading;
      uniform bool ambientOcclusion;
      uniform bool fullbright;
      uniform float daytime;
      uniform float emission;
      uniform vec3 blockLightTint;
      uniform vec3 skyLightColor;
      uniform vec3 ambientColor;
      uniform float skyLightFactor;
      uniform float brightness;
      uniform vec3 shadePos;
      uniform vec3 shadeNeg;
      uniform mat3 shadeMat;
      uniform bool diffuseOn;
      uniform vec3 diffuse0;
      uniform vec3 diffuse1;
      uniform vec2 diffuseMix;
      uniform float fogStart;
      uniform float fogEnd;
      uniform float fogNear;
      uniform float fogFar;
      uniform vec3 fogBase;
      uniform vec3 skyBase;
      uniform float fogSkyMix;
      uniform vec3 fogCenter;
      uniform bool fogFromCamera;
      uniform bool fogSunrise;
      uniform float fogGlow;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vWorldNormal;
      varying vec3 vFogPos;
      varying vec3 vTint;
      ${FOG_GLSL}
      #ifdef FACE_ATTRS
        varying vec2 vFaceData;
      #endif
      #ifdef TILED
        uniform vec2 atlasSize;
        varying vec4 vTileRect;
        varying vec2 vTileSpan;
        #ifdef TILE_LOOKUP
          uniform sampler2D tileLookupMap;
          uniform vec2 tileLookupSize;
          varying vec2 vTileLookup;
        #endif
      #endif
      #ifdef LIGHT_VOLUME
        varying vec3 vLightPos;
        uniform vec3 lightVolOrigin;
        uniform vec3 lightVolSize;
        uniform sampler2D lightVol;
        uniform sampler2D lightAo;
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
        #ifdef AO_NEIGHBORS
          uniform vec2 lightAoTex;
          uniform float lightAoCols;
          vec4 aoNeighbors(vec3 c) {
            c = clamp(c, vec3(-1.0), lightVolSize) + 1.0;
            vec2 tile = lightVolSize.xz + 2.0;
            vec2 uv = vec2(mod(c.y, lightAoCols) * tile.x, floor(c.y / lightAoCols) * tile.y) + c.xz + 0.5;
            return floor(texture2D(lightAo, uv / lightAoTex) * 255.0 + 0.5);
          }
          float aoShade(float bits, float place) {
            return mod(floor(bits / place), 2.0) > 0.5 ? 0.2 : 1.0;
          }
          float aoCorner(float edgeA, float edgeB, float sa, float sb, float diagonal, float sc) {
            float corner = (edgeA < 0.5 && edgeB < 0.5) ? sa : diagonal;
            return (sa + sb + corner + sc) * 0.25;
          }
        #else
          uniform vec4 lightAoMask;
          float aoShade(vec3 c) {
            c = clamp(c, vec3(0.0), lightVolSize - 1.0);
            vec2 tile = lightVolSize.xz + 1.0;
            vec2 uv = vec2(mod(c.y, lightVolCols) * tile.x, floor(c.y / lightVolCols) * tile.y) + c.xz + 0.5;
            return dot(texture2D(lightAo, uv / lightVolTex), lightAoMask) > 0.5 ? 0.2 : 1.0;
          }
          float aoCorner(vec3 base, vec3 da, vec3 db, vec3 axis, float sa, float sb, float sc) {
            bool blockedA = aoShade(base + da + axis) < 0.5;
            bool blockedB = aoShade(base + db + axis) < 0.5;
            float corner = (blockedA && blockedB) ? sa : aoShade(base + da + db);
            return (sa + sb + corner + sc) * 0.25;
          }
        #endif
      #endif
      #include <clipping_planes_pars_fragment>
      void main() {
        #include <clipping_planes_fragment>
        #ifdef UV_OFFSET
          vec2 texUv = fract(vUv + uvOffset);
        #else
          vec2 texUv = vUv;
        #endif
        vec2 uvEdge = fwidth(texUv) * 0.5;
        #ifdef TILED
          if (vTileSpan.x > 0.5) {
            vec4 tile = floor(vTileRect + 0.5);
            vec2 span = floor(vTileSpan + 0.5);
            vec2 at = clamp(texUv, vec2(0.0), span);
            vec2 within = mix(fract(at), vec2(1.0), step(span, at));
            #ifdef TILE_LOOKUP
              if (vTileLookup.x > -0.5) {
                float turn = texture2D(tileLookupMap, (floor(vTileLookup + 0.5) + min(floor(at), span - 1.0) + 0.5) / tileLookupSize).r;
                turn = floor(turn * 255.0 + 0.5);
                vec2 flip = vec2(0.0, step(3.5, turn));
                turn -= flip.y * 4.0;
                flip.x = step(1.5, turn);
                if (turn - flip.x * 2.0 > 0.5) within = within.yx;
                within = abs(within - flip);
              }
            #endif
            vec2 px = clamp(within * tile.zw, vec2(0.015625), tile.zw - 0.015625);
            texUv = vec2(tile.x + px.x, atlasSize.y - tile.y - tile.w + px.y) / atlasSize;
            uvEdge = vec2(0.0);
          }
        #endif
        if (texUv.x < -uvEdge.x || texUv.x > 1.0 + uvEdge.x || texUv.y < -uvEdge.y || texUv.y > 1.0 + uvEdge.y) discard;
        vec4 texColor = texture2D(map, texUv);
        #ifdef CUTOUT
          if (texColor.a < 0.1) discard;
          texColor.a = 1.0;
        #endif
        if (texColor.a < 0.01) discard;
        #ifdef FACE_ATTRS
          float emissionV = vFaceData.x / 15.0;
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
        shadeOn = shadeOn && shading;
        aoOn = aoOn && ambientOcclusion;
        float shade = 1.0;
        vec3 light = vec3(1.0);
        if (worldShade) {
          if (shadeOn) {
            bool hasOverride = dot(shadeDirV, shadeDirV) > 0.5;
            vec3 wn = hasOverride ? shadeDirV : shadeMat * vWorldNormal;
            if (diffuseOn) {
              vec3 dn = normalize(wn);
              shade = min(1.0, (max(0.0, dot(diffuse0, dn)) + max(0.0, dot(diffuse1, dn))) * diffuseMix.x + diffuseMix.y);
            } else {
              vec3 n2 = wn * wn;
              shade = (n2.y * (wn.y >= 0.0 ? shadePos.x : shadeNeg.x)
                + n2.z * (wn.z >= 0.0 ? shadePos.y : shadeNeg.y)
                + n2.x * (wn.x >= 0.0 ? shadePos.z : shadeNeg.z)) / (n2.x + n2.y + n2.z);
            }
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
            vec3 lp = vLightPos + sn * 0.5;
            vec2 lv = sampleLightVol(lp);
            float blockLevel = max(lv.x, emissionV);
            float skyLevel = lv.y;
            if (aoOn) {
              vec3 an = abs(sn);
              vec3 axis; vec3 t1; vec3 t2;
              if (an.y >= an.x && an.y >= an.z) { axis = vec3(0.0, sign(sn.y), 0.0); t1 = vec3(1.0, 0.0, 0.0); t2 = vec3(0.0, 0.0, 1.0); }
              else if (an.x >= an.z) { axis = vec3(sign(sn.x), 0.0, 0.0); t1 = vec3(0.0, 1.0, 0.0); t2 = vec3(0.0, 0.0, 1.0); }
              else { axis = vec3(0.0, 0.0, sign(sn.z)); t1 = vec3(1.0, 0.0, 0.0); t2 = vec3(0.0, 1.0, 0.0); }
              vec3 P = vLightPos;
              vec3 base = floor(P - axis * 0.0117);
              float edge = fract(dot(P, abs(axis)));
              if (edge < 0.0117 || edge > 0.9883) base += axis;
              #ifdef AO_NEIGHBORS
                vec4 nb = aoNeighbors(base);
                vec3 planes = t1.y > 0.5 ? nb.rbg : t2.y > 0.5 ? nb.bgr : nb.gbr;
                float side = axis.x + axis.y + axis.z;
                vec2 along = side < -0.5 ? vec2(1.0, 4.0) : side > 0.5 ? vec2(32.0, 128.0) : vec2(8.0, 16.0);
                vec2 across = side < -0.5 ? vec2(1.0, 32.0) : side > 0.5 ? vec2(4.0, 128.0) : vec2(2.0, 64.0);
                vec2 placeA = t1.y > 0.5 ? across : along;
                vec2 placeB = t2.y > 0.5 ? along : across;
                float sc = nb.a > 127.5 ? 0.2 : 1.0;
                float sA0 = aoShade(planes.x, 8.0);
                float sA1 = aoShade(planes.x, 16.0);
                float sB0 = aoShade(planes.x, 2.0);
                float sB1 = aoShade(planes.x, 64.0);
                float eA0 = aoShade(planes.y, placeA.x);
                float eA1 = aoShade(planes.y, placeA.y);
                float eB0 = aoShade(planes.z, placeB.x);
                float eB1 = aoShade(planes.z, placeB.y);
                float q00 = aoCorner(eA0, eB0, sA0, sB0, aoShade(planes.x, 1.0), sc);
                float q10 = aoCorner(eA1, eB0, sA1, sB0, aoShade(planes.x, 4.0), sc);
                float q01 = aoCorner(eA0, eB1, sA0, sB1, aoShade(planes.x, 32.0), sc);
                float q11 = aoCorner(eA1, eB1, sA1, sB1, aoShade(planes.x, 128.0), sc);
              #else
                float sc = aoShade(base);
                float sA0 = aoShade(base - t1);
                float sA1 = aoShade(base + t1);
                float sB0 = aoShade(base - t2);
                float sB1 = aoShade(base + t2);
                float q00 = aoCorner(base, -t1, -t2, axis, sA0, sB0, sc);
                float q10 = aoCorner(base, t1, -t2, axis, sA1, sB0, sc);
                float q01 = aoCorner(base, -t1, t2, axis, sA0, sB1, sc);
                float q11 = aoCorner(base, t1, t2, axis, sA1, sB1, sc);
              #endif
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
          if (fullbright) light = vec3(1.0);
          light *= ao;
        } else if (shadeOn) {
          mat3 v = mat3(viewMatrix);
          bool hasOverride = dot(shadeDirV, shadeDirV) > 0.5;
          vec3 n = hasOverride ? v * shadeDirV : vNormal;
          shade = min(1.0, ambient + d0 * max(0.0, dot(n, v * light0)) + d1 * max(0.0, dot(n, v * light1)));
        }
        vec3 rgb = texColor.rgb * vTint * shade * light;
        if (worldShade && fogFar > 0.0) {
          vec3 rel = vFogPos - (fogFromCamera ? cameraPosition : fogCenter);
          float sph = length(rel) / 16.0;
          float cyl = max(length(rel.xz), abs(rel.y)) / 16.0;
          float f = max(fogValue(sph, fogStart, fogEnd), fogValue(cyl, fogNear, fogFar));
          if (f > 0.0) rgb = mix(rgb, fogColorAt(normalize(rel)), f);
        }
        gl_FragColor = vec4(rgb, texColor.a * opacity);
      }
      //salt:${shaderSalt}`),
    transparent: blend,
    depthWrite: !blend || translucent === true,
    side: doubleSided === "back" ? THREE.BackSide : doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    clipping: true,
    extensions: { derivatives: true }
  })
  if (!uvOffset) material.userData.atlasTiling = true
  return material
}
