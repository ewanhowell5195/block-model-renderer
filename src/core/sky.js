import { THREE, Canvas, loadImage, normalize, isBefore } from "./platform.js"
import { prepareAssets, readFile } from "./assets.js"
import { parseDaytime, makeThreeTexture, tintVec } from "./models.js"

const DAY = 24000
const SKY_RADIUS = 512
const SKY_HEIGHT = 16
const BACKDROP_RADIUS = 640
const CELESTIAL_HEIGHT = 100
const SUN_SIZE = 30
const MOON_SIZE = 20
const FADE_TICKS = [13500, 14000]
const GLOW_RADIUS = 120
const GLOW_DEPTH = 40
const GLOW_STEPS = 16
const STAR_COUNT = 1500
const STAR_DISTANCE = 100
const STAR_SEED = 10842n
const END_SKY_SIZE = 200
const END_SKY_TILES = 16
const END_SKY_TINT = 0x282828

const MOON_PHASES = ["full_moon", "waning_gibbous", "third_quarter", "waning_crescent", "new_moon", "waxing_crescent", "first_quarter", "waxing_gibbous"]

const FOG_CURVE = [[133, 0xFFFFFF], [11867, 0xFFFFFF], [13670, 0x0C0C16], [22330, 0x161616]]

const DIMENSIONS = {
  overworld: { skybox: "overworld", skyColor: 0x78A7FF, fogColor: 0xC0D8FF },
  the_nether: { skybox: "none", skyColor: 0x000000, fogColor: 0x330808 },
  the_end: { skybox: "end", skyColor: 0x000000, fogColor: 0x181318 }
}

const clamp = (v, min, max) => v < min ? min : v > max ? max : v

function javaRandom(seed) {
  let s = (seed ^ 0x5DEECE66Dn) & 0xFFFFFFFFFFFFn
  const next = bits => {
    s = (s * 0x5DEECE66Dn + 0xBn) & 0xFFFFFFFFFFFFn
    return Number(BigInt.asIntN(32, s >> BigInt(48 - bits)))
  }
  return {
    nextFloat: () => next(24) * 5.9604645e-8,
    nextDouble: () => (next(26) * 134217728 + next(27)) * 1.110223e-16
  }
}

function celestialAngle(tick) {
  let d = tick / DAY - 0.25
  d -= Math.floor(d)
  return (d * 2 + (0.5 - Math.cos(d * Math.PI) / 2)) / 3
}

const altitudeAt = tick => Math.cos(celestialAngle(tick) * Math.PI * 2)
const [FADE_FULL, FADE_GONE] = FADE_TICKS.map(altitudeAt)

function horizonFade(height) {
  const t = clamp((height - FADE_GONE) / (FADE_FULL - FADE_GONE), 0, 1)
  return t * t * (3 - 2 * t)
}

function curveAt(curve, tick, out) {
  const t = ((tick % DAY) + DAY) % DAY
  let i = curve.length - 1
  if (t >= curve[0][0]) {
    i = 0
    while (i + 1 < curve.length && t >= curve[i + 1][0]) i++
  }
  const [from, a] = curve[i]
  const [to, b] = curve[(i + 1) % curve.length]
  let span = to - from
  if (span <= 0) span += DAY
  let at = t - from
  if (at < 0) at += DAY
  const k = span ? clamp(at / span, 0, 1) : 0
  const channel = shift => {
    const c0 = ((a >> shift) & 255) / 255
    const c1 = ((b >> shift) & 255) / 255
    return c0 + (c1 - c0) * k
  }
  return out.set(channel(16), channel(8), channel(0))
}

function sunriseColor(angle, out) {
  const c = Math.cos(angle)
  if (c < -0.4 || c > 0.4) return 0
  const f = c / 0.4 * 0.5 + 0.5
  let alpha = 1 - (1 - Math.sin(f * Math.PI)) * 0.99
  alpha *= alpha
  out.set(f * 0.3 + 0.7, f * f * 0.7 + 0.2, 0.2)
  return alpha
}

function starBrightness(angle) {
  const b = clamp(1 - (Math.cos(angle) * 2 + 0.25), 0, 1)
  return b * b * 0.5
}

const OVERLAY_BLEND = () => [THREE.SrcAlphaFactor, THREE.OneFactor, THREE.ZeroFactor, THREE.OneFactor]
const TRANSLUCENT_BLEND = () => [THREE.SrcAlphaFactor, THREE.OneMinusSrcAlphaFactor, THREE.OneFactor, THREE.OneMinusSrcAlphaFactor]

function skyMaterial(config, blend) {
  const material = new THREE.ShaderMaterial({
    ...config,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false
  })
  if (blend) {
    const [src, dst, srcAlpha, dstAlpha] = blend()
    material.blending = THREE.CustomBlending
    material.blendSrc = src
    material.blendDst = dst
    material.blendSrcAlpha = srcAlpha
    material.blendDstAlpha = dstAlpha
  }
  return material
}

function flatMaterial(tint) {
  return skyMaterial({
    uniforms: { tint: { value: tint } },
    vertexShader: `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 tint;
      void main() {
        gl_FragColor = vec4(tint, 1.0);
      }
    `
  })
}

function discMaterial(skyColor, fogColor) {
  return skyMaterial({
    uniforms: { skyColor: { value: skyColor }, fogColor: { value: fogColor } },
    vertexShader: `
      varying float vDist;
      void main() {
        vDist = length(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 skyColor;
      uniform vec3 fogColor;
      varying float vDist;
      void main() {
        gl_FragColor = vec4(mix(skyColor, fogColor, clamp(vDist / ${SKY_RADIUS.toFixed(1)}, 0.0, 1.0)), 1.0);
      }
    `
  })
}

function glowMaterial(tint) {
  return skyMaterial({
    uniforms: { tint: { value: tint } },
    vertexShader: `
      attribute float fade;
      varying float vFade;
      void main() {
        vFade = fade;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec4 tint;
      varying float vFade;
      void main() {
        gl_FragColor = vec4(tint.rgb, tint.w * vFade);
      }
    `
  }, TRANSLUCENT_BLEND)
}

function celestialMaterial(map, fade) {
  return skyMaterial({
    uniforms: { map: { value: map }, fade },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      uniform float fade;
      varying vec2 vUv;
      void main() {
        vec4 texel = texture2D(map, vUv);
        gl_FragColor = vec4(texel.rgb, texel.a * fade);
      }
    `
  }, OVERLAY_BLEND)
}

function starMaterial(brightness) {
  return skyMaterial({
    uniforms: { brightness },
    vertexShader: `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float brightness;
      void main() {
        gl_FragColor = vec4(vec3(brightness), brightness);
      }
    `
  }, OVERLAY_BLEND)
}

function endSkyMaterial(map) {
  return skyMaterial({
    uniforms: { map: { value: map }, tint: { value: tintVec(END_SKY_TINT) } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      uniform vec3 tint;
      varying vec2 vUv;
      void main() {
        gl_FragColor = texture2D(map, vUv) * vec4(tint, 1.0);
      }
    `
  }, TRANSLUCENT_BLEND)
}

function discGeometry() {
  const position = [0, SKY_HEIGHT, 0]
  const index = []
  for (let a = -180; a <= 180; a += 45) {
    const rad = a * Math.PI / 180
    position.push(SKY_RADIUS * Math.cos(rad), SKY_HEIGHT, SKY_RADIUS * Math.sin(rad))
  }
  for (let i = 1; i < position.length / 3 - 1; i++) index.push(0, i, i + 1)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3))
  geometry.setIndex(index)
  return geometry
}

function glowGeometry() {
  const position = [0, CELESTIAL_HEIGHT, 0]
  const fade = [1]
  const index = []
  for (let i = 0; i <= GLOW_STEPS; i++) {
    const rad = i * Math.PI * 2 / GLOW_STEPS
    position.push(Math.sin(rad) * GLOW_RADIUS, Math.cos(rad) * GLOW_RADIUS, -Math.cos(rad) * GLOW_DEPTH)
    fade.push(0)
  }
  for (let i = 1; i < fade.length - 1; i++) index.push(0, i, i + 1)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3))
  geometry.setAttribute("fade", new THREE.Float32BufferAttribute(fade, 1))
  geometry.setIndex(index)
  return geometry
}

function celestialGeometry(size, uv) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -size, CELESTIAL_HEIGHT, -size,
    size, CELESTIAL_HEIGHT, -size,
    size, CELESTIAL_HEIGHT, size,
    -size, CELESTIAL_HEIGHT, size
  ], 3))
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2))
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  return geometry
}

function moonUv(phase) {
  const col = phase % 4
  const row = Math.floor(phase / 4) % 2
  const u0 = col / 4
  const u1 = (col + 1) / 4
  const v0 = 1 - row / 2
  const v1 = 1 - (row + 1) / 2
  return [u1, v1, u0, v1, u0, v0, u1, v0]
}

function starGeometry() {
  const random = javaRandom(STAR_SEED)
  const position = []
  const index = []
  const center = new THREE.Vector3()
  const corner = new THREE.Vector3()
  const origin = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const basis = new THREE.Matrix4()
  const spin = new THREE.Matrix4()
  const corners = [[1, -1], [1, 1], [-1, 1], [-1, -1]]
  for (let i = 0; i < STAR_COUNT; i++) {
    const x = random.nextFloat() * 2 - 1
    const y = random.nextFloat() * 2 - 1
    const z = random.nextFloat() * 2 - 1
    const size = 0.15 + random.nextFloat() * 0.1
    const lengthSq = x * x + y * y + z * z
    if (lengthSq <= 0.010000001 || lengthSq >= 1) continue
    const angle = random.nextDouble() * Math.PI * 2
    center.set(x, y, z).normalize().multiplyScalar(STAR_DISTANCE)
    basis.identity().lookAt(origin, center, up).multiply(spin.makeRotationZ(-angle))
    const base = position.length / 3
    for (const [cx, cy] of corners) {
      corner.set(cx * size, cy * size, 0).applyMatrix4(basis).add(center)
      position.push(corner.x, corner.y, corner.z)
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3))
  geometry.setIndex(index)
  return geometry
}

async function firstImage(paths, assets) {
  for (const path of paths) {
    const buf = await readFile(path, assets)
    if (buf) return loadImage(buf)
  }
  return null
}

async function sunTexture(assets, modern) {
  const celestial = "assets/minecraft/textures/environment/celestial/sun.png"
  const legacy = "assets/minecraft/textures/environment/sun.png"
  const image = await firstImage(modern ? [celestial, legacy] : [legacy, celestial], assets)
  return image ? makeThreeTexture(image) : null
}

async function moonTexture(assets, modern) {
  const phases = modern
    ? await Promise.all(MOON_PHASES.map(name => readFile(`assets/minecraft/textures/environment/celestial/moon/${name}.png`, assets)))
    : []
  if (!phases[0]) {
    const image = await firstImage(["assets/minecraft/textures/environment/moon_phases.png"], assets)
    return image ? makeThreeTexture(image) : null
  }
  const images = await Promise.all(phases.map(buf => buf ? loadImage(buf) : null))
  const { width, height } = images[0]
  const canvas = new Canvas(width * 4, height * 2)
  const ctx = canvas.getContext("2d")
  for (let i = 0; i < images.length; i++) {
    if (images[i]) ctx.drawImage(images[i], (i % 4) * width, Math.floor(i / 4) * height, width, height)
  }
  return makeThreeTexture(canvas)
}

async function endSkyTexture(assets) {
  const image = await firstImage(["assets/minecraft/textures/environment/end_sky.png"], assets)
  if (!image) return null
  const texture = await makeThreeTexture(image)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  return texture
}

export async function createSky(assets, args = {}) {
  assets = await prepareAssets(assets)
  const version = args.version ?? assets.version
  const modern = !version || !isBefore(version, "1.21.11")
  const dimension = args.dimension && typeof args.dimension === "object"
    ? { ...DIMENSIONS.overworld, ...args.dimension }
    : DIMENSIONS[normalize(args.dimension ?? "overworld")] ?? DIMENSIONS.overworld
  const daytime = args.daytime && typeof args.daytime === "object" && "value" in args.daytime
    ? args.daytime
    : { value: parseDaytime(args.daytime) }

  const baseSky = tintVec(args.skyColor ?? dimension.skyColor)
  const baseFog = tintVec(args.fogColor ?? dimension.fogColor)
  const skyColor = baseSky.clone()
  const fogColor = baseFog.clone()
  const glowTint = new THREE.Vector4(1, 1, 1, 0)
  const brightness = { value: 0 }
  const fading = args.horizonFade === true
  const sunFade = { value: 1 }
  const moonFade = { value: 1 }

  const group = new THREE.Group()
  group.name = "sky"
  group.userData.daytime = daytime

  const meshes = []
  const textures = []

  function place(parent, geometry, material, order) {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.userData.sky = true
    mesh.renderOrder = order
    mesh.frustumCulled = false
    mesh.onBeforeRender = onBeforeRender
    parent.add(mesh)
    meshes.push(mesh)
    return mesh
  }

  let phase = clamp(Math.floor(args.moonPhase ?? 0), 0, 7)
  let skyAngle = Number(args.angle) || 0
  let sun = null
  let moon = null
  let glow = null
  let glowSpin = null
  let glowFan = null
  let stars = null
  let celestial = null
  let sunPivot = null
  let moonPivot = null
  let starPivot = null

  if (dimension.skybox === "end") {
    const texture = await endSkyTexture(assets)
    if (texture) {
      textures.push(texture)
      const geometry = new THREE.BoxGeometry(END_SKY_SIZE, END_SKY_SIZE, END_SKY_SIZE)
      const uv = geometry.attributes.uv
      for (let i = 0; i < uv.array.length; i++) uv.array[i] *= END_SKY_TILES
      place(group, geometry, endSkyMaterial(texture), -1000)
    }
  } else {
    place(group, new THREE.SphereGeometry(BACKDROP_RADIUS, 16, 12), flatMaterial(fogColor), -1000)
  }

  if (dimension.skybox === "overworld") {
    place(group, discGeometry(), discMaterial(skyColor, fogColor), -999)

    glow = new THREE.Group()
    glow.rotation.x = Math.PI / 2
    glowSpin = new THREE.Group()
    glow.add(glowSpin)
    group.add(glow)
    glowFan = place(glowSpin, glowGeometry(), glowMaterial(glowTint), -998)

    celestial = new THREE.Group()
    celestial.rotation.set(skyAngle * Math.PI / 180, -Math.PI / 2, 0)
    group.add(celestial)

    sunPivot = new THREE.Group()
    moonPivot = new THREE.Group()
    starPivot = new THREE.Group()
    celestial.add(sunPivot, moonPivot, starPivot)

    const sunMap = await sunTexture(assets, modern)
    if (sunMap) {
      textures.push(sunMap)
      sun = place(sunPivot, celestialGeometry(SUN_SIZE, [0, 1, 1, 1, 1, 0, 0, 0]), celestialMaterial(sunMap, sunFade), -997)
    }

    const moonMap = await moonTexture(assets, modern)
    if (moonMap) {
      textures.push(moonMap)
      moon = place(moonPivot, celestialGeometry(MOON_SIZE, moonUv(phase)), celestialMaterial(moonMap, moonFade), -996)
    }

    stars = place(starPivot, starGeometry(), starMaterial(brightness), -995)
  }

  const cameraPos = new THREE.Vector3()
  const cameraDir = new THREE.Vector3()
  const parentScale = new THREE.Vector3()
  const fogTint = new THREE.Vector3()
  const glowRgb = new THREE.Vector3()
  let frame = -1
  let camera = null

  function onBeforeRender(renderer, scene, view) {
    const now = renderer.info.render.frame
    if (now === frame && view === camera) return
    frame = now
    camera = view
    sync(view)
  }

  function sync(view) {
    const distance = args.distance ?? (Number.isFinite(view.far) ? view.far * 0.9 : BACKDROP_RADIUS)
    let scale = distance / BACKDROP_RADIUS
    cameraPos.setFromMatrixPosition(view.matrixWorld)
    if (group.parent) {
      group.parent.worldToLocal(cameraPos)
      parentScale.setFromMatrixScale(group.parent.matrixWorld)
      if (parentScale.x > 0) scale /= parentScale.x
    }
    group.position.copy(cameraPos)
    group.scale.setScalar(scale)

    if (dimension.skybox === "overworld") {
      const tick = daytime.value
      const angle = celestialAngle(tick) * Math.PI * 2
      skyColor.copy(baseSky).multiplyScalar(clamp(Math.cos(angle) * 2 + 0.5, 0, 1))
      fogColor.copy(baseFog).multiply(curveAt(FOG_CURVE, tick, fogTint))

      const alpha = sunriseColor(angle, glowRgb)
      if (alpha > 0) {
        const facing = view.getWorldDirection(cameraDir).x * (Math.sin(angle) > 0 ? -1 : 1)
        if (facing > 0) fogColor.lerp(glowRgb, clamp(facing * alpha, 0, 1))
      }
      glow.visible = alpha > 0.001
      if (glow.visible) {
        glowSpin.rotation.z = (Math.sin(angle) < 0 ? Math.PI : 0) + Math.PI / 2
        glowFan.scale.z = alpha
        glowTint.set(glowRgb.x, glowRgb.y, glowRgb.z, alpha)
      }
      sunPivot.rotation.x = angle
      moonPivot.rotation.x = angle + Math.PI
      starPivot.rotation.x = angle
      brightness.value = starBrightness(angle)
      stars.visible = brightness.value > 0
      if (fading) {
        const height = Math.cos(angle)
        sunFade.value = horizonFade(height)
        moonFade.value = horizonFade(-height)
        if (sun) sun.visible = sunFade.value > 0
        if (moon) moon.visible = moonFade.value > 0
      }
    }

    group.updateMatrixWorld(true)
  }

  return {
    group,
    daytime,
    get moonPhase() {
      return phase
    },
    set moonPhase(value) {
      phase = clamp(Math.floor(value) || 0, 0, 7)
      if (!moon) return
      moon.geometry.attributes.uv.array.set(moonUv(phase))
      moon.geometry.attributes.uv.needsUpdate = true
    },
    get angle() {
      return skyAngle
    },
    set angle(value) {
      skyAngle = Number(value) || 0
      if (celestial) celestial.rotation.x = skyAngle * Math.PI / 180
    },
    dispose() {
      for (const mesh of meshes) {
        try { mesh.geometry.dispose() } catch {}
        try { mesh.material.dispose() } catch {}
      }
      for (const texture of textures) {
        try { texture.dispose() } catch {}
      }
      meshes.length = 0
      textures.length = 0
      group.removeFromParent()
    }
  }
}
