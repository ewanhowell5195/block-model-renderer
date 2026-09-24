import { THREE, Canvas, loadImage } from "./platform.js"
import { prepareAssets, readFile } from "./assets.js"
import { parseDaytime, tintVec } from "./models.js"
import { curveAt } from "./sky.js"

const UNIT = 16
const CELL = 12
const THICKNESS = 4
const BLOCKS_PER_TICK = 0.030000001
const TICKS_PER_CELL = 400
const Z_OFFSET = 3.96
const DEFAULT_HEIGHT = 192.33
const DEFAULT_RANGE = 128
const FOG_END = 2048
const EMPTY_ALPHA = 10
const REBUILD_CELLS = 4
const COLOR_CURVE = [[133, 0xFFFFFF], [11867, 0xFFFFFF], [13670, 0x191926], [22330, 0x191926]]

const FACES = {
  down: { shade: 0.7, corners: [[1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 0, 0]] },
  up: { shade: 1.0, corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  north: { shade: 0.8, corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
  south: { shade: 0.8, corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
  west: { shade: 0.9, corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  east: { shade: 0.9, corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] }
}
const DIRECTIONS = Object.keys(FACES)

const floorMod = (a, n) => ((a % n) + n) % n

function toAnchor(value) {
  if (value == null) return null
  if (value.isObject3D) return { object: value }
  const pos = Array.isArray(value) ? new THREE.Vector3(value[0], value[1], value[2]) : new THREE.Vector3(value.x ?? 0, value.y ?? 0, value.z ?? 0)
  return { pos }
}

const toOrigin = value => [Number(value?.[0]) || 0, Number(value?.[1]) || 0, Number(value?.[2]) || 0]

async function cloudCells(assets) {
  const buf = await readFile("assets/minecraft/textures/environment/clouds.png", assets)
  if (!buf) return null
  const image = await loadImage(buf)
  const { width, height } = image
  const canvas = new Canvas(width, height)
  const ctx = canvas.getContext("2d")
  ctx.drawImage(image, 0, 0)
  const data = ctx.getImageData(0, 0, width, height).data
  const filled = new Uint8Array(width * height)
  for (let i = 0; i < filled.length; i++) filled[i] = data[i * 4 + 3] >= EMPTY_ALPHA ? 1 : 0
  return { filled, width, height }
}

function cloudMaterial(cloudColor, fogEnd, fogCenter, fancy) {
  return new THREE.ShaderMaterial({
    uniforms: { cloudColor: { value: cloudColor }, fogEnd, fogCenter },
    vertexShader: `
      attribute float shade;
      uniform vec4 cloudColor;
      uniform float fogEnd;
      uniform vec3 fogCenter;
      varying vec4 vColor;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        float fog = clamp(distance(world.xyz, fogCenter) / fogEnd, 0.0, 1.0);
        vColor = vec4(cloudColor.rgb * shade, cloudColor.a * (1.0 - fog));
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      varying vec4 vColor;
      void main() {
        gl_FragColor = vColor;
      }
    `,
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    depthWrite: true,
    side: fancy ? THREE.FrontSide : THREE.DoubleSide
  })
}

function buildGeometry(cells, cellX, cellZ, radius, fancy, inner) {
  const { filled, width, height } = cells
  const at = (x, z) => filled[floorMod(x, width) + floorMod(z, height) * width]
  function walk(emit) {
    function cell(rx, rz) {
      const x = cellX + rx, z = cellZ + rz
      if (!at(x, z)) return
      if (!fancy) return emit(rx, rz, "down", false, FACES.up.shade)
      emit(rx, rz, "up", false)
      emit(rx, rz, "down", false)
      if (!at(x, z - 1)) emit(rx, rz, "north", false)
      if (!at(x, z + 1)) emit(rx, rz, "south", false)
      if (!at(x - 1, z)) emit(rx, rz, "west", false)
      if (!at(x + 1, z)) emit(rx, rz, "east", false)
      if (Math.abs(rx) <= inner && Math.abs(rz) <= inner) for (const dir of DIRECTIONS) emit(rx, rz, dir, true)
    }
    for (let ring = 0; ring <= 2 * radius; ring++) {
      for (let rx = -ring; rx <= ring; rx++) {
        const rz = ring - Math.abs(rx)
        if (rz < 0 || rz > radius || rx * rx + rz * rz > radius * radius) continue
        if (rz !== 0) cell(rx, -rz)
        cell(rx, rz)
      }
    }
  }
  let quads = 0
  walk(() => quads++)
  const position = new Float32Array(quads * 12)
  const shade = new Float32Array(quads * 4)
  const index = new Uint32Array(quads * 6)
  let q = 0
  walk((rx, rz, dir, inside, value) => {
    const face = FACES[dir]
    const base = q * 4
    for (let k = 0; k < 4; k++) {
      const c = face.corners[inside ? 3 - k : k]
      const v = (base + k) * 3
      position[v] = (rx + c[0]) * CELL * UNIT
      position[v + 1] = c[1] * THICKNESS * UNIT
      position[v + 2] = (rz + c[2]) * CELL * UNIT
      shade[base + k] = value ?? face.shade
    }
    const i = q * 6
    index[i] = base
    index[i + 1] = base + 1
    index[i + 2] = base + 2
    index[i + 3] = base
    index[i + 4] = base + 2
    index[i + 5] = base + 3
    q++
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3))
  geometry.setAttribute("shade", new THREE.BufferAttribute(shade, 1))
  geometry.setIndex(new THREE.BufferAttribute(index, 1))
  return geometry
}

export async function createClouds(assets, args = {}) {
  assets = await prepareAssets(assets)
  const daytime = args.daytime && typeof args.daytime === "object" && "value" in args.daytime
    ? args.daytime
    : { value: parseDaytime(args.daytime) }
  const cells = await cloudCells(assets)
  const range = Math.max(1, Number(args.range) || DEFAULT_RANGE)
  const radius = Math.ceil(range * 16 / CELL)
  const base = tintVec(args.color ?? 0xFFFFFF)
  let alpha = Number(args.alpha ?? 0.8)
  const cloudColor = new THREE.Vector4(base.x, base.y, base.z, alpha)
  const fogEnd = { value: Math.min(range * 16, FOG_END) * UNIT }
  const fogCenter = { value: new THREE.Vector3() }
  const tint = new THREE.Vector3()

  let height = Number(args.height ?? DEFAULT_HEIGHT)
  let origin = toOrigin(args.origin)
  let offsetX = Number(args.offset?.[0]) || 0, offsetZ = Number(args.offset?.[1]) || 0
  let time = Number(args.time) || 0
  let ticking = args.tick !== false
  let fancy = args.fancy !== false
  let last = -1
  let anchor = toAnchor(args.anchor)
  let builtX = null, builtZ = null, builtFancy = null
  let retired = null

  const group = new THREE.Group()
  group.name = "clouds"
  group.userData.daytime = daytime
  const material = cloudMaterial(cloudColor, fogEnd, fogCenter, fancy)
  const empty = new THREE.BufferGeometry()
  empty.setAttribute("position", new THREE.Float32BufferAttribute([], 3))
  empty.setAttribute("shade", new THREE.Float32BufferAttribute([], 1))
  empty.setIndex([])
  const mesh = new THREE.Mesh(empty, material)
  mesh.frustumCulled = false
  mesh.userData.sky = true
  mesh.userData.prepare = view => anchor ? update() : update(view)
  mesh.renderOrder = 1000
  mesh.visible = !!cells && alpha > 0
  mesh.onBeforeRender = (renderer, scene, view) => sync(view)
  mesh.onAfterRender = commit
  group.add(mesh)

  const cameraPos = new THREE.Vector3()
  let pending = null

  function commit() {
    if (!pending) return
    retired?.dispose()
    retired = mesh.geometry
    mesh.geometry = pending.geometry
    builtX = pending.x
    builtZ = pending.z
    builtFancy = pending.fancy
    pending = null
  }

  function update(target) {
    if (target !== undefined) anchor = toAnchor(target)
    anchor?.object?.updateMatrixWorld(true)
    sync(null)
    if (pending) {
      commit()
      sync(null)
    }
  }

  function sync(view) {
    if (anchor?.object) cameraPos.setFromMatrixPosition(anchor.object.matrixWorld)
    else if (anchor) cameraPos.copy(anchor.pos)
    else if (view) cameraPos.setFromMatrixPosition(view.matrixWorld)
    else return
    fogCenter.value.copy(cameraPos)
    const now = performance.now()
    if (ticking && last >= 0) time += (now - last) / 50
    last = now
    if (group.parent) group.parent.worldToLocal(cameraPos)
    const camX = cameraPos.x / UNIT, camZ = cameraPos.z / UNIT
    const period = cells.width * TICKS_PER_CELL
    const cloudX = camX + origin[0] + 0.5 + offsetX + floorMod(time, period) * BLOCKS_PER_TICK
    const cloudZ = camZ + origin[2] + 0.5 + offsetZ + Z_OFFSET
    const cellX = Math.floor(cloudX / CELL), cellZ = Math.floor(cloudZ / CELL)
    const stale = builtX === null || Math.abs(cellX - builtX) > REBUILD_CELLS || Math.abs(cellZ - builtZ) > REBUILD_CELLS || fancy !== builtFancy
    if (stale && !pending) pending = { x: cellX, z: cellZ, fancy, geometry: buildGeometry(cells, cellX, cellZ, radius, fancy, REBUILD_CELLS + 1) }
    const ox = builtX ?? pending.x, oz = builtZ ?? pending.z
    mesh.position.set((camX - cloudX + ox * CELL) * UNIT, (height - origin[1] - 0.5) * UNIT, (camZ - cloudZ + oz * CELL) * UNIT)
    curveAt(COLOR_CURVE, daytime.value, tint)
    cloudColor.set(base.x * tint.x, base.y * tint.y, base.z * tint.z, alpha)
    group.updateMatrixWorld(true)
  }

  if (anchor && cells) update()

  return {
    group,
    daytime,
    update,
    get anchor() {
      return anchor?.object ?? anchor?.pos ?? null
    },
    set anchor(value) {
      update(value)
    },
    get height() {
      return height
    },
    set height(value) {
      height = Number(value) || 0
    },
    get origin() {
      return origin.slice()
    },
    set origin(value) {
      origin = toOrigin(value)
    },
    get offset() {
      return [offsetX, offsetZ]
    },
    set offset(value) {
      offsetX = Number(value?.[0]) || 0
      offsetZ = Number(value?.[1]) || 0
    },
    get alpha() {
      return alpha
    },
    set alpha(value) {
      alpha = Math.max(0, Math.min(1, Number(value) || 0))
      mesh.visible = !!cells && alpha > 0
    },
    get time() {
      return time
    },
    set time(value) {
      time = Number(value) || 0
    },
    get tick() {
      return ticking
    },
    set tick(value) {
      ticking = !!value
    },
    get fancy() {
      return fancy
    },
    set fancy(value) {
      fancy = !!value
      material.side = fancy ? THREE.FrontSide : THREE.DoubleSide
    },
    dispose() {
      try { pending?.geometry.dispose() } catch {}
      try { retired?.dispose() } catch {}
      try { mesh.geometry.dispose() } catch {}
      try { material.dispose() } catch {}
      group.removeFromParent()
    }
  }
}
