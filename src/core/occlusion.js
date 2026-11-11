import { THREE, Canvas, isImage } from "./platform.js"
import { builtinRules } from "./data.js"
import { readFile } from "./assets.js"
import { classifyPngAlpha } from "./png.js"
import { modelLoaders } from "./loaders.js"
import { FACE_ORDER, QUAD_CORNERS, fillBox, scaleBox, transformBox, elementRescale, elementMatrix, resolveTextureRef, texturePath } from "./models.js"

function emptyMask() { return new Uint16Array(16) }
const EMPTY_MASKS = () => ({ east: emptyMask(), west: emptyMask(), up: emptyMask(), down: emptyMask(), south: emptyMask(), north: emptyMask() })

export function faceIsEmpty(m) { for (let v = 0; v < 16; v++) if (m[v]) return false; return true }

export function faceCovered(self, neighbor) {
  for (let v = 0; v < 16; v++) if (self[v] & ~neighbor[v] & 0xffff) return false
  return true
}

const matMap = m => m.uniforms?.map?.value ?? m.map

let _canvas, _ctx
const opaqueCache = new WeakMap()
function isOpaque(tex) {
  let o = opaqueCache.get(tex); if (o !== undefined) return o
  if (tex?.userData?.opaque !== undefined) {
    opaqueCache.set(tex, tex.userData.opaque)
    return tex.userData.opaque
  }
  const img = tex?.image
  if (!img?.width) return false
  const w = img.width, h = img.height
  if (!_canvas) { _canvas = new Canvas(w, h); _ctx = _canvas.getContext("2d", { willReadFrequently: true }) }
  _canvas.width = w; _canvas.height = h
  _ctx.clearRect(0, 0, w, h); _ctx.drawImage(img, 0, 0)
  const d = _ctx.getImageData(0, 0, w, h).data
  o = true; for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { o = false; break }
  opaqueCache.set(tex, o); return o
}

const FACE_AXIS = { east: [0, 8], west: [0, -8], up: [1, 8], down: [1, -8], south: [2, 8], north: [2, -8] }
let _va, _vb, _vc

const snap = x => Math.round(x * 4096) / 4096
function rasterize(mask, ax, a, b, c) {
  const u = (ax + 1) % 3, v = (ax + 2) % 3
  const au = snap(a.getComponent(u) + 8), av = snap(a.getComponent(v) + 8)
  const bu = snap(b.getComponent(u) + 8), bv = snap(b.getComponent(v) + 8)
  const cu = snap(c.getComponent(u) + 8), cv = snap(c.getComponent(v) + 8)
  const u0 = Math.max(0, Math.floor(Math.min(au, bu, cu))), u1 = Math.min(16, Math.ceil(Math.max(au, bu, cu)))
  const v0 = Math.max(0, Math.floor(Math.min(av, bv, cv))), v1 = Math.min(16, Math.ceil(Math.max(av, bv, cv)))
  for (let py = v0; py < v1; py++) {
    const cy = py + 0.5
    for (let px = u0; px < u1; px++) {
      const cx = px + 0.5
      const e0 = (bu - au) * (cy - av) - (bv - av) * (cx - au)
      const e1 = (cu - bu) * (cy - bv) - (cv - bv) * (cx - bu)
      const e2 = (au - cu) * (cy - cv) - (av - cv) * (cx - cu)
      if ((e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0)) mask[py] |= (1 << px)
    }
  }
}

function addTriangle(masks, a, b, c) {
  for (const dir in FACE_AXIS) {
    const ax = FACE_AXIS[dir][0], plane = FACE_AXIS[dir][1]
    if (Math.abs(a.getComponent(ax) - plane) < 0.02 && Math.abs(b.getComponent(ax) - plane) < 0.02 && Math.abs(c.getComponent(ax) - plane) < 0.02) rasterize(masks[dir], ax, a, b, c)
  }
}

export function occludingFaces(model, id, geometric, rules = builtinRules) {
  const masks = EMPTY_MASKS()
  if (!geometric && id != null && !rules.canOcclude(id)) return masks
  if (!_va) { _va = new THREE.Vector3(); _vb = new THREE.Vector3(); _vc = new THREE.Vector3() }
  model.updateMatrixWorld(true)
  model.traverse(o => {
    if (!o.isMesh) return
    const geo = o.geometry, pos = geo.attributes.position, idx = geo.index
    if (!pos || !idx) return
    const array = Array.isArray(o.material)
    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: idx.count, materialIndex: 0 }]
    for (const g of groups) {
      const mat = array ? o.material[g.materialIndex ?? 0] : o.material
      if (!mat || mat.visible === false || (!geometric && !isOpaque(matMap(mat)))) continue
      for (let i = g.start, end = g.start + g.count; i + 2 < end; i += 3) {
        _va.fromBufferAttribute(pos, idx.getX(i)).applyMatrix4(o.matrixWorld)
        _vb.fromBufferAttribute(pos, idx.getX(i + 1)).applyMatrix4(o.matrixWorld)
        _vc.fromBufferAttribute(pos, idx.getX(i + 2)).applyMatrix4(o.matrixWorld)
        addTriangle(masks, _va, _vb, _vc)
      }
    }
  })
  return masks
}

const NOT_PLAIN = ["texture_images", "billboard", "double_sided", "dynamic", "fluid", "generated", "glint", "offset", "outline", "scale", "shader", "shelf_align", "transformation", "translation"]
const quarterTurn = v => v == null || (Number.isFinite(v) && v % 90 === 0)

function plainModel(model, assets) {
  if (!model || typeof model !== "object" || !model.ignore_atlas_restrictions) return false
  if (model.version ? typeof model.version !== "string" : assets.version) return false
  for (const key of NOT_PLAIN) if (model[key]) return false
  if (!quarterTurn(model.x) || !quarterTurn(model.y) || !quarterTurn(model.z)) return false
  return !modelLoaders.some(l => (l.replaceElements || l.build) && l.match?.(model))
}

const finite3 = v => Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])
const finiteOrUnset = v => v === undefined || Number.isFinite(v)

function plainRotation(rotation) {
  const { origin, axis, angle, x, y, z } = rotation
  if (!finite3(origin)) return false
  if (axis != null || angle !== undefined) return (axis === "x" || axis === "y" || axis === "z") && Number.isFinite(angle)
  return finiteOrUnset(x) && finiteOrUnset(y) && finiteOrUnset(z)
}

function plainElement(element, merged) {
  if (!element || typeof element !== "object" || element.part) return false
  if (element.rotation && !(merged && plainRotation(element.rotation))) return false
  return finite3(element.from) && finite3(element.to)
}

const modelWorlds = new Map()
function modelWorld(model) {
  const x = model.x ?? 0, y = model.y ?? 0, z = model.z ?? 0
  const key = `${x},${y},${z}`
  let world = modelWorlds.get(key)
  if (!world) {
    const parent = new THREE.Group(), root = new THREE.Group(), display = new THREE.Group(), container = new THREE.Group(), mesh = new THREE.Object3D()
    parent.add(root)
    root.add(display)
    display.add(container)
    container.add(mesh)
    if (x || y || z) container.rotation.set(THREE.MathUtils.degToRad(-x), THREE.MathUtils.degToRad(-y), THREE.MathUtils.degToRad(z), "ZYX")
    parent.updateMatrixWorld(true)
    world = { container: container.matrixWorld, merged: mesh.matrixWorld }
    if (modelWorlds.size < 64) modelWorlds.set(key, world)
  }
  return world
}

let _box = null
function boxScratch() {
  return _box ??= { data: new Float32Array(144), collision: [], quad: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], center: new THREE.Vector3(), identity: new THREE.Quaternion(), one: new THREE.Vector3(1, 1, 1), local: new THREE.Matrix4(), world: new THREE.Matrix4() }
}

function addBox(model, world, merged, element, faceMasks) {
  const s = boxScratch(), data = s.data, quad = s.quad, from = element.from, to = element.to
  const W = (to[0] - from[0]) || 0.001, H = (to[1] - from[1]) || 0.001, D = (to[2] - from[2]) || 0.001
  fillBox(data, 0, data, 72, W, H, D)
  let matrix = world.merged
  if (merged) {
    const rescale = element.rotation?.rescale ? elementRescale(element.rotation) : null
    if (rescale) scaleBox(data, 0, rescale[0], rescale[1], rescale[2])
    if (!elementMatrix(model, element, W, H, D)) return false
    transformBox(data, 0, s.collision, true)
    s.collision.length = 0
  } else {
    matrix = s.world.multiplyMatrices(world.container, s.local.compose(s.center.set(from[0] + W / 2 - 8, from[1] + H / 2 - 8, from[2] + D / 2 - 8), s.identity, s.one))
  }
  for (let p = 0; p < 6; p++) {
    const masks = faceMasks[p]
    if (!masks) continue
    for (let k = 0, j = p * 12; k < 4; k++, j += 3) quad[k].set(data[j], data[j + 1], data[j + 2]).applyMatrix4(matrix)
    addTriangle(masks, quad[QUAD_CORNERS[0]], quad[QUAD_CORNERS[1]], quad[QUAD_CORNERS[2]])
    addTriangle(masks, quad[QUAD_CORNERS[3]], quad[QUAD_CORNERS[4]], quad[QUAD_CORNERS[5]])
  }
  return true
}

async function textureOpaque(assets, path, known) {
  const buf = await readFile(assets, path)
  const cls = buf && !isImage(buf) ? await classifyPngAlpha(buf, assets.translucency).catch(() => null) : null
  const opaque = cls ? cls.opaque : null
  known.set(path, opaque)
  return opaque
}

export async function plainOcclusion(assets, models, id, rules = builtinRules) {
  const occludes = id == null || rules.canOcclude(id)
  const known = assets.cache ? (assets.cache.opacity ??= new Map()) : new Map()
  const solid = EMPTY_MASKS(), clear = EMPTY_MASKS()
  const faceMasks = [null, null, null, null, null, null]
  for (const model of models) {
    if (!plainModel(model, assets)) return
    const elements = model.elements || []
    if (!Array.isArray(elements)) return
    const world = modelWorld(model), merged = elements.length > 1, refs = new Map()
    for (const element of elements) {
      if (!plainElement(element, merged)) return
      const faces = element.faces
      let visible = false
      for (let i = 0; i < 6; i++) {
        const face = faces?.[FACE_ORDER[i]]
        faceMasks[i] = null
        if (!face) continue
        if (face.uv && !Array.isArray(face.uv)) return
        if (!face.texture) continue
        let masks = refs.get(face.texture)
        if (masks === undefined) {
          if (typeof face.texture !== "string") return
          const ref = resolveTextureRef(model.textures, face.texture.startsWith("#") ? face.texture : "#" + face.texture)
          if (typeof ref !== "string" || !ref) return
          masks = clear
          if (occludes) {
            const path = texturePath(ref)
            let opaque = known.get(path)
            if (opaque === undefined) opaque = await textureOpaque(assets, path, known)
            if (opaque === null) return
            if (opaque) masks = solid
          }
          refs.set(face.texture, masks)
        }
        faceMasks[i] = masks
        visible = true
      }
      if ((visible || element.rotation) && !addBox(model, world, merged, element, faceMasks)) return
    }
  }
  const self = EMPTY_MASKS()
  for (const dir in self) for (let v = 0; v < 16; v++) self[dir][v] = solid[dir][v] | clear[dir][v]
  return { neighbor: solid, self }
}
