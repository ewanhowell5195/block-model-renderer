import { THREE } from "./platform.js"

const BUCKETS = 2048
const FRAME_TRIS = 50000
const SEEN_FRAMES = 8

const schedules = new WeakMap()

function scheduleFor(renderer) {
  let schedule = schedules.get(renderer)
  if (!schedule) schedules.set(renderer, schedule = { frame: -1, budget: 0, waiting: new Set() })
  return schedule
}

function claimSort(schedule, state, frame) {
  if (schedule.frame !== frame) {
    schedule.frame = frame
    schedule.budget = FRAME_TRIS
  }
  state.seen = frame
  schedule.waiting.add(state)
  if (schedule.budget < FRAME_TRIS && state.tris > schedule.budget) return false
  for (const other of schedule.waiting) {
    if (frame - other.seen > SEEN_FRAMES) schedule.waiting.delete(other)
    else if (other.since < state.since) return false
  }
  schedule.budget -= state.tris
  schedule.waiting.delete(state)
  return true
}

function translucentRanges(mesh) {
  const geo = mesh.geometry
  const mats = [].concat(mesh.material)
  const total = geo.index ? geo.index.count : geo.attributes.position.count
  if (!geo.groups.length) {
    return mats[0]?.transparent && mats[0].visible !== false ? [{ start: 0, count: total }] : []
  }
  const ranges = []
  const seen = new Set()
  for (const g of geo.groups) {
    const m = mats[g.materialIndex]
    if (!m?.transparent || m.visible === false) continue
    const count = Math.min(g.count, total - g.start)
    if (count < 6) continue
    const key = g.start + ":" + count
    if (seen.has(key)) continue
    seen.add(key)
    ranges.push({ start: g.start, count })
  }
  return ranges
}

function makeSorter(mesh) {
  const geo = mesh.geometry
  const ranges = translucentRanges(mesh)
  if (!ranges.length) return null
  if (!geo.index) {
    const count = geo.attributes.position.count
    const seq = new Uint32Array(count)
    for (let i = 0; i < count; i++) seq[i] = i
    geo.setIndex(new THREE.BufferAttribute(seq, 1))
  }
  const pos = geo.attributes.position
  let maxTris = 0, tris = 0
  for (const r of ranges) {
    r.tris = (r.count / 3) | 0
    r.orig = geo.index.array.slice(r.start, r.start + r.tris * 3)
    r.cent = new Float32Array(r.tris * 3)
    for (let t = 0; t < r.tris; t++) {
      let cx = 0, cy = 0, cz = 0
      for (let k = 0; k < 3; k++) {
        const a = r.orig[t * 3 + k]
        cx += pos.getX(a)
        cy += pos.getY(a)
        cz += pos.getZ(a)
      }
      r.cent[t * 3] = cx / 3
      r.cent[t * 3 + 1] = cy / 3
      r.cent[t * 3 + 2] = cz / 3
    }
    if (r.tris > maxTris) maxTris = r.tris
    tris += r.tris
  }
  const depths = new Float32Array(maxTris)
  const slot = new Uint32Array(maxTris)
  const buckets = new Uint32Array(BUCKETS + 1)
  const camLocal = new THREE.Vector3()
  const inv = new THREE.Matrix4()

  function sortNow(camera) {
    camera.updateWorldMatrix(true, false)
    mesh.updateWorldMatrix(true, false)
    inv.copy(mesh.matrixWorld).invert()
    camLocal.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv)
    const idx = geo.index.array
    for (const r of ranges) {
      let min = Infinity, max = 0
      for (let t = 0; t < r.tris; t++) {
        const dx = r.cent[t * 3] - camLocal.x, dy = r.cent[t * 3 + 1] - camLocal.y, dz = r.cent[t * 3 + 2] - camLocal.z
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        depths[t] = d
        if (d < min) min = d
        if (d > max) max = d
      }
      const scale = max > min ? BUCKETS / (max - min) : 0
      buckets.fill(0)
      for (let t = 0; t < r.tris; t++) {
        const b = BUCKETS - 1 - Math.min(BUCKETS - 1, ((depths[t] - min) * scale) | 0)
        slot[t] = b
        buckets[b + 1]++
      }
      for (let b = 1; b <= BUCKETS; b++) buckets[b] += buckets[b - 1]
      for (let t = 0; t < r.tris; t++) {
        const i = r.start + buckets[slot[t]]++ * 3
        idx[i] = r.orig[t * 3]
        idx[i + 1] = r.orig[t * 3 + 1]
        idx[i + 2] = r.orig[t * 3 + 2]
      }
    }
    geo.index.needsUpdate = true
    return camLocal
  }

  return { mesh, tris, sortNow }
}

export function collectSorters(object) {
  const sorters = []
  object.traverse(o => {
    if (!o.isMesh) return
    const s = makeSorter(o)
    if (s) sorters.push(s)
  })
  return sorters
}

export function sortObjectOnce(object, camera) {
  for (const s of collectSorters(object)) s.sortNow(camera)
}

export function createTranslucentSorter(object, opts = {}) {
  if (!object) throw new Error("createTranslucentSorter requires an object to sort")
  const resort = opts.resortDistance ?? 16
  const resortSq = resort * resort
  const sorters = collectSorters(object)
  const attached = []
  for (const s of sorters) {
    const prev = s.mesh.onBeforeRender
    const lastCam = new THREE.Vector3(Infinity, Infinity, Infinity)
    const probe = new THREE.Vector3()
    const inv = new THREE.Matrix4()
    const state = { tris: s.tris, since: -1, seen: -1 }
    let pending = true
    s.mesh.onBeforeRender = function (renderer, scene, camera, ...rest) {
      prev?.call(this, renderer, scene, camera, ...rest)
      inv.copy(s.mesh.matrixWorld).invert()
      probe.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv)
      const frame = renderer.info.render.frame
      if (!pending && probe.distanceToSquared(lastCam) > resortSq) {
        pending = true
        state.since = frame
      }
      if (!pending || !claimSort(scheduleFor(renderer), state, frame)) return
      pending = false
      lastCam.copy(s.sortNow(camera))
    }
    attached.push({ mesh: s.mesh, prev })
  }
  return {
    sort(camera) {
      for (const s of sorters) s.sortNow(camera)
    },
    detach() {
      for (const a of attached) a.mesh.onBeforeRender = a.prev ?? null
    }
  }
}
