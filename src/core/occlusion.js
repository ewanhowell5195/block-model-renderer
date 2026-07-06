import { THREE, Canvas } from "./platform.js"
import { canOcclude } from "./culling.js"

function emptyMask() { return new Uint16Array(16) }
const EMPTY_MASKS = () => ({ east: emptyMask(), west: emptyMask(), up: emptyMask(), down: emptyMask(), south: emptyMask(), north: emptyMask() })

export function faceIsEmpty(m) { for (let v = 0; v < 16; v++) if (m[v]) return false; return true }

export function faceCovered(self, neighbour) {
  for (let v = 0; v < 16; v++) if (self[v] & ~neighbour[v] & 0xffff) return false
  return true
}

const matMap = m => m.uniforms?.map?.value ?? m.map

let _canvas, _ctx
const opaqueCache = new WeakMap()
function isOpaque(tex) {
  let o = opaqueCache.get(tex); if (o !== undefined) return o
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

export function occludingFaces(model, id) {
  const masks = EMPTY_MASKS()
  if (id != null && !canOcclude(id)) return masks
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
      if (!mat || mat.visible === false || !isOpaque(matMap(mat))) continue
      for (let i = g.start, end = g.start + g.count; i + 2 < end; i += 3) {
        _va.fromBufferAttribute(pos, idx.getX(i)).applyMatrix4(o.matrixWorld)
        _vb.fromBufferAttribute(pos, idx.getX(i + 1)).applyMatrix4(o.matrixWorld)
        _vc.fromBufferAttribute(pos, idx.getX(i + 2)).applyMatrix4(o.matrixWorld)
        for (const dir in FACE_AXIS) {
          const ax = FACE_AXIS[dir][0], b = FACE_AXIS[dir][1]
          if (Math.abs(_va.getComponent(ax) - b) < 0.02 && Math.abs(_vb.getComponent(ax) - b) < 0.02 && Math.abs(_vc.getComponent(ax) - b) < 0.02)
            rasterize(masks[dir], ax, _va, _vb, _vc)
        }
      }
    }
  })
  return masks
}
