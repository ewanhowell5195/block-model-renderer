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
const SIDES = [["north", 0, -1], ["south", 0, 1], ["west", -1, 0], ["east", 1, 0]]

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

const vertexShader = `
  attribute float shade;
  uniform vec4 cloudColor;
  uniform float fogEnd;
  uniform vec3 fogCenter;
  varying vec4 vColor;
  void main() {
    #ifdef USE_INSTANCING
      vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    #else
      vec4 world = modelMatrix * vec4(position, 1.0);
    #endif
    float fog = clamp(distance(world.xyz, fogCenter) / fogEnd, 0.0, 1.0);
    vColor = vec4(cloudColor.rgb * shade, cloudColor.a * (1.0 - fog));
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

function cloudMaterial(uniforms, side, depth) {
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader: `
      varying vec4 vColor;
      void main() {
        if (vColor.a <= 0.0) discard;
        gl_FragColor = vColor;
      }
    `,
    depthFunc: THREE.LessEqualDepth,
    side
  })
  if (depth) {
    material.colorWrite = false
    material.depthWrite = true
    material.blending = THREE.NoBlending
  } else {
    material.depthWrite = false
    material.blending = THREE.CustomBlending
    material.blendSrc = THREE.SrcAlphaFactor
    material.blendDst = THREE.OneMinusSrcAlphaFactor
    material.blendSrcAlpha = THREE.OneFactor
    material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor
  }
  return material
}

const flatCorners = corners => Float32Array.from(corners.flatMap(c => [c[0] * CELL * UNIT, c[1] * THICKNESS * UNIT, c[2] * CELL * UNIT]))
const OUTSIDE = Object.fromEntries(DIRECTIONS.map(dir => [dir, flatCorners(FACES[dir].corners)]))
const INTERIOR = DIRECTIONS.map(dir => [flatCorners(FACES[dir].corners.slice().reverse()), FACES[dir].shade])

function buildGeometry(cells, eachCell) {
  const { filled, width, height } = cells
  const at = (x, z) => filled[floorMod(x, width) + floorMod(z, height) * width]
  function walk(emit) {
    for (let z = 0; z < height; z++) {
      for (let x = 0; x < width; x++) if (filled[x + z * width]) eachCell(x, z, at, emit)
    }
  }
  let quads = 0
  walk(() => quads++)
  const position = new Float32Array(quads * 12)
  const shade = new Float32Array(quads * 4)
  const index = new Uint32Array(quads * 6)
  let q = 0
  walk((x, z, corners, value) => {
    const px = x * CELL * UNIT, pz = z * CELL * UNIT, v = q * 12, base = q * 4, i = q * 6
    for (let k = 0; k < 12; k += 3) {
      position[v + k] = px + corners[k]
      position[v + k + 1] = corners[k + 1]
      position[v + k + 2] = pz + corners[k + 2]
    }
    shade.fill(value, base, base + 4)
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

function fancyShell(x, z, at, emit) {
  emit(x, z, OUTSIDE.up, FACES.up.shade)
  emit(x, z, OUTSIDE.down, FACES.down.shade)
  for (const [dir, dx, dz] of SIDES) if (!at(x + dx, z + dz)) emit(x, z, OUTSIDE[dir], FACES[dir].shade)
}

function fancyInterior(x, z, at, emit) {
  for (const [corners, shade] of INTERIOR) emit(x, z, corners, shade)
}

function flatSheet(x, z, at, emit) {
  emit(x, z, OUTSIDE.down, FACES.up.shade)
}

export async function createClouds(assets, args = {}) {
  assets = await prepareAssets(assets)
  const daytime = args.daytime && typeof args.daytime === "object" && "value" in args.daytime
    ? args.daytime
    : { value: parseDaytime(args.daytime) }
  const cells = await cloudCells(assets)
  const range = Math.max(1, Number(args.range) || DEFAULT_RANGE)
  const reach = Math.ceil(range * 16 / CELL) * CELL
  const base = tintVec(args.color ?? 0xFFFFFF)
  let alpha = Number(args.alpha ?? 0.8)
  const cloudColor = new THREE.Vector4(base.x, base.y, base.z, alpha)
  const uniforms = {
    cloudColor: { value: cloudColor },
    fogEnd: { value: Math.min(range * 16, FOG_END) * UNIT },
    fogCenter: { value: new THREE.Vector3() }
  }
  const tint = new THREE.Vector3()

  let height = Number(args.height ?? DEFAULT_HEIGHT)
  let origin = toOrigin(args.origin)
  let offsetX = Number(args.offset?.[0]) || 0, offsetZ = Number(args.offset?.[1]) || 0
  let time = Number(args.time) || 0
  let ticking = args.tick !== false
  let fancy = args.fancy !== false
  let last = -1
  let anchor = toAnchor(args.anchor)

  const group = new THREE.Group()
  group.name = "clouds"
  group.userData.daytime = daytime
  const layer = new THREE.Group()
  group.add(layer)

  const periodX = (cells?.width ?? 1) * CELL, periodZ = (cells?.height ?? 1) * CELL
  const tilesX = Math.ceil(2 * reach / periodX) + 1, tilesZ = Math.ceil(2 * reach / periodZ) + 1
  const tileMatrices = new THREE.InstancedBufferAttribute(new Float32Array(tilesX * tilesZ * 16), 16)
  const geometries = {}
  const geometry = kind => {
    if (!cells) return new THREE.BufferGeometry()
    geometries[kind] ??= buildGeometry(cells, { shell: fancyShell, interior: fancyInterior, flat: flatSheet }[kind])
    return geometries[kind]
  }
  const side = () => fancy ? THREE.FrontSide : THREE.DoubleSide
  function pass(depth, order) {
    const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), cloudMaterial(uniforms, side(), depth), tilesX * tilesZ)
    mesh.instanceMatrix = tileMatrices
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.renderOrder = order
    mesh.userData.sky = true
    layer.add(mesh)
    return mesh
  }
  const shellDepth = pass(true, 1000)
  const interiorDepth = pass(true, 1000.1)
  const shellColor = pass(false, 1000.2)
  const interiorColor = pass(false, 1000.3)
  const passes = [shellDepth, interiorDepth, shellColor, interiorColor]
  const interiors = [interiorDepth, interiorColor]
  const shells = [shellDepth, shellColor]
  shellDepth.userData.prepare = view => anchor ? update() : update(view)
  shellDepth.onBeforeRender = (renderer, scene, view) => sync(view)

  function applyFancy() {
    for (const mesh of shells) mesh.geometry = geometry(fancy ? "shell" : "flat")
    for (const mesh of passes) mesh.material.side = side()
    if (fancy) for (const mesh of interiors) mesh.geometry = geometry("interior")
  }
  applyFancy()

  const cameraPos = new THREE.Vector3()
  const tileMatrix = new THREE.Matrix4()
  let tileKey = "", tiles = 0

  function placeTiles(cloudX, cloudZ) {
    const x0 = Math.floor((cloudX - reach) / periodX), x1 = Math.floor((cloudX + reach) / periodX)
    const z0 = Math.floor((cloudZ - reach) / periodZ), z1 = Math.floor((cloudZ + reach) / periodZ)
    const key = x0 + "," + x1 + "," + z0 + "," + z1
    if (key === tileKey) return
    tileKey = key
    tiles = 0
    for (let tx = x0; tx <= x1; tx++) {
      for (let tz = z0; tz <= z1; tz++) tileMatrices.set(tileMatrix.makeTranslation(tx * periodX * UNIT, 0, tz * periodZ * UNIT).elements, tiles++ * 16)
    }
    tileMatrices.needsUpdate = true
  }

  function update(target) {
    if (target !== undefined) anchor = toAnchor(target)
    anchor?.object?.updateMatrixWorld(true)
    sync(null)
  }

  function sync(view) {
    if (!cells) return
    if (anchor?.object) cameraPos.setFromMatrixPosition(anchor.object.matrixWorld)
    else if (anchor) cameraPos.copy(anchor.pos)
    else if (view) cameraPos.setFromMatrixPosition(view.matrixWorld)
    else return
    uniforms.fogCenter.value.copy(cameraPos)
    const now = performance.now()
    if (ticking && last >= 0) time += (now - last) / 50
    last = now
    if (group.parent) group.parent.worldToLocal(cameraPos)
    const camX = cameraPos.x / UNIT, camY = cameraPos.y / UNIT, camZ = cameraPos.z / UNIT
    const drift = floorMod(time, cells.width * TICKS_PER_CELL) * BLOCKS_PER_TICK
    const cloudX = floorMod(camX + origin[0] + 0.5 + offsetX + drift, periodX)
    const cloudZ = floorMod(camZ + origin[2] + 0.5 + offsetZ + Z_OFFSET, periodZ)
    placeTiles(cloudX, cloudZ)
    const bottom = height - origin[1] - 0.5
    layer.position.set((camX - cloudX) * UNIT, bottom * UNIT, (camZ - cloudZ) * UNIT)
    const inside = fancy && camY >= bottom && camY <= bottom + THICKNESS
    for (const mesh of shells) mesh.count = tiles
    for (const mesh of interiors) mesh.count = inside ? tiles : 0
    curveAt(COLOR_CURVE, daytime.value, tint)
    cloudColor.set(base.x * tint.x, base.y * tint.y, base.z * tint.z, alpha)
    group.updateMatrixWorld(true)
  }

  function setVisible() {
    for (const mesh of shells) mesh.visible = !!cells && alpha > 0
    for (const mesh of interiors) mesh.visible = !!cells && alpha > 0 && fancy
  }
  setVisible()

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
      setVisible()
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
      applyFancy()
      setVisible()
    },
    dispose() {
      for (const g of Object.values(geometries)) g.dispose()
      for (const mesh of passes) mesh.material.dispose()
      group.removeFromParent()
    }
  }
}
