import { platform, THREE, loadTexture } from "./platform.js"
import { prepareAssets, scopedCache, getMissingImage, MASK_DIRS } from "./assets.js"
import { sortObjectOnce } from "./sorting.js"
import { parseBlockstate, parseItemDefinition, resolveModelData, loadModel, AIR_BLOCKS, applyShaderSalt, bumpShaderSalt, restoreShaderSalt, shaderSaltNow, buildOcclusionModel, occlusionStateKey, DYNAMIC_LOOPS, dynamicFrame, setDynamicClock, freezeDynamics } from "./models.js"
import { selfCulls } from "./culling.js"
import { occludingFaces, faceIsEmpty, faceCovered } from "./occlusion.js"
import { computeAnimationTimeline, lcmTicks, collectAnimated, applyFrame, applyTint, readTexture } from "./animation.js"
import { blockRules } from "./data.js"
import { faceNeighbors } from "./neighbors.js"

const OPPOSITE = { down: "up", up: "down", north: "south", south: "north", east: "west", west: "east" }

const verifiedPrograms = new WeakSet()

function buffersEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function verifyPrograms(frameRenderer, scene, camera) {
  if (frameRenderer.programs().every(p => verifiedPrograms.has(p))) return
  const salt = shaderSaltNow()
  let prev = frameRenderer.readPixels()
  for (let attempt = 0; attempt < 3; attempt++) {
    bumpShaderSalt(scene)
    frameRenderer.renderFrame(scene, camera)
    const cur = frameRenderer.readPixels()
    const agreed = buffersEqual(prev, cur)
    prev = cur
    if (agreed) {
      if (attempt === 0) restoreShaderSalt(scene, salt)
      break
    }
  }
  for (const p of frameRenderer.programs()) verifiedPrograms.add(p)
}


async function occlusionMasks(assets, rules, id, props, version, defaults) {
  const cache = assets.cache.occlusion
  const key = occlusionStateKey(id, props, defaults)
  let neighbor = cache.get(key), self = cache.get("self\0" + key)
  if (neighbor === undefined || self === undefined) {
    try {
      const g = await buildOcclusionModel(assets, id, props, version, defaults)
      if (neighbor === undefined) neighbor = g ? occludingFaces(g, id, false, rules) : null
      if (self === undefined) self = g ? occludingFaces(g, null, true) : null
    } catch {
      neighbor ??= null
      self ??= null
    }
    cache.set(key, neighbor)
    cache.set("self\0" + key, self)
  }
  return { neighbor, self }
}

export async function getCullFaces({ id, properties, neighbors, assets, version, defaults } = {}) {
  if (!id) throw new Error("getCullFaces requires the id option")
  if (AIR_BLOCKS.test(id)) return new Set()
  if (assets == null || assets.length === 0) throw new Error("getCullFaces requires the assets option")
  if (typeof neighbors === "function") neighbors = faceNeighbors(neighbors)
  assets = scopedCache(await prepareAssets(assets))
  defaults ??= assets.defaults
  const rules = await blockRules(assets)
  let selfP
  const selfMasks = () => selfP ??= occlusionMasks(assets, rules, id, properties, version, defaults).then(m => m.self)
  const cull = new Set()
  for (const dir in OPPOSITE) {
    const n = neighbors?.[dir]
    if (n == null || n === false) continue
    if (n === true) { cull.add(dir); continue }
    const nid = typeof n === "string" ? n : n.id
    const props = typeof n === "string" ? undefined : (({ id, ...rest }) => rest)(n)
    if (typeof n === "object" && "occludes" in n) {
      if (n.occludes || selfCulls(id, nid, dir, properties, props, rules)) cull.add(dir)
      continue
    }
    if (!nid) continue
    if (selfCulls(id, nid, dir, properties, props, rules)) { cull.add(dir); continue }
    const sm = (await selfMasks())?.[dir]
    if (!sm || faceIsEmpty(sm)) continue
    const nm = AIR_BLOCKS.test(nid) ? null : (await occlusionMasks(assets, rules, nid, props, version, defaults)).neighbor
    if (nm && faceCovered(sm, nm[OPPOSITE[dir]])) cull.add(dir)
  }
  return cull
}

export async function fullyOccludes({ id, properties, assets, version, defaults } = {}) {
  if (!id || AIR_BLOCKS.test(id)) return false
  if (assets == null || assets.length === 0) throw new Error("fullyOccludes requires the assets option")
  assets = scopedCache(await prepareAssets(assets))
  defaults ??= assets.defaults
  const m = (await occlusionMasks(assets, await blockRules(assets), id, properties, version, defaults)).neighbor
  if (!m) return false
  for (const dir of MASK_DIRS) {
    const mask = m[dir]
    if (!mask) return false
    for (let v = 0; v < 16; v++) if (mask[v] !== 0xffff) return false
  }
  return true
}

const OUTPUT_DEFAULTS = {
  jpeg: { mozjpeg: true },
  jpg: { mozjpeg: true },
  webp: { lossless: true }
}

export async function renderBlock(args = {}) {
  if (!args.id) throw new Error("renderBlock requires the id option")
  if (args.assets == null || args.assets.length === 0) throw new Error("renderBlock requires the assets option")
  args.properties ??= {}
  args.display ??= {
    rotation: [30, 135, 0],
    scale: [0.625, 0.625, 0.625],
    rotateFlat: true
  }

  args.assets = await prepareAssets(args.assets)
  const assets = scopedCache(args.assets)
  const { scene, camera } = makeModelScene()
  scene.userData.ephemeral = true

  const models = await parseBlockstate(assets, args.id, { properties: args.properties, nbt: args.nbt, mapArt: args.mapArt, seed: args.seed, pos: args.pos, randomOffset: args.randomOffset, biome: args.biome })

  const cull = args.cull ?? (args.neighbors ? await getCullFaces({ id: args.id, properties: args.properties, neighbors: faceNeighbors(args.neighbors), assets }) : undefined)

  const block = { id: args.id, properties: args.properties, pos: args.pos ?? null }
  for (const model of models) {
    const resolved = await resolveModelData(assets, model)
    await loadModel(assets, resolved, { parent: scene, display: args.display, cull, block, neighbors: args.neighbors, lighting: args.lighting, shaderScale: args.shaderScale, emission: args.emission })
  }

  scene.traverse(o => { if (o.userData.dynamic === "enchanting_book") o.userData.range = 0 })

  return renderModelScene(scene, camera, args)
}

export async function renderItem(args = {}) {
  if (!args.id) throw new Error("renderItem requires the id option")
  if (args.assets == null || args.assets.length === 0) throw new Error("renderItem requires the assets option")
  args.components ??= {}
  args.display ??= {
    type: "fallback",
    display: "gui"
  }

  args.assets = await prepareAssets(args.assets)
  const assets = scopedCache(args.assets)
  const { scene, camera } = makeModelScene()
  scene.userData.ephemeral = true

  const models = await parseItemDefinition(assets, args.id, { components: args.components, display: args.display })

  for (const model of models) {
    const resolved = await resolveModelData(assets, model)
    await loadModel(assets, resolved, { parent: scene, display: args.display, cull: args.cull, lighting: args.lighting, shaderScale: args.shaderScale, emission: args.emission })
  }

  return renderModelScene(scene, camera, args)
}

export async function renderTexture(args = {}) {
  if (!args.texture) throw new Error("renderTexture requires the texture option")
  if (args.assets == null || args.assets.length === 0) throw new Error("renderTexture requires the assets option")

  args.assets = await prepareAssets(args.assets)
  const texture = await readTexture(args.assets, args.texture)
  let frames = texture?.frames
  if (args.tint && frames) frames = frames.map(f => applyTint(f, args.tint))
  const frame = frames ? frames[0] : await getMissingImage(args.assets)
  if (args.canvas == null) {
    args.width ??= frame.width
    args.height ??= frame.height
  }
  const size = platform.resolveRenderSize?.(args)
  const width = size?.width ?? args.width ?? frame.width
  const height = size?.height ?? args.height ?? frame.height

  const { scene, camera } = makeModelScene()
  scene.userData.ephemeral = true

  const tex = await loadTexture(frame)
  tex.colorSpace = THREE.NoColorSpace
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  if (texture?.animated) {
    tex.userData.frames = frames
    tex.userData.times = texture.times
    tex.userData.interpolate = texture.interpolate
  }

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(16 * (width / height), 16),
    new THREE.ShaderMaterial({
      uniforms: { map: { value: tex } },
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = texture2D(map, vUv); }",
      transparent: true
    })
  )
  scene.add(mesh)

  return renderModelScene(scene, camera, args)
}

export async function renderModel(args = {}) {
  if (!args.model) throw new Error("renderModel requires the model option")
  if (args.assets == null || args.assets.length === 0) throw new Error("renderModel requires the assets option")
  args.display ??= "gui"

  args.assets = await prepareAssets(args.assets)
  const { scene, camera } = makeModelScene()
  scene.userData.ephemeral = true

  const resolved = await resolveModelData(args.assets, { model: args.model})
  await loadModel(args.assets, resolved, { parent: scene, display: args.display, cull: args.cull, lighting: args.lighting, shaderScale: args.shaderScale, emission: args.emission })

  return renderModelScene(scene, camera, args)
}

function resolveAnimatedFormat(animated, format) {
  if (!animated) return null
  if (animated === true) return format === "gif" ? "gif" : "webp"
  return animated
}

function adjustPathForFormat(filePath, format, explicitFormat) {
  if (!filePath || explicitFormat) return filePath
  const formatExt = format === "jpeg" ? "jpg" : format
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
  const dot = filePath.lastIndexOf(".")
  if (dot <= slash) return filePath + "." + formatExt
  if (filePath.slice(dot + 1).toLowerCase() === formatExt) return filePath
  return filePath.slice(0, dot) + "." + formatExt
}

export function makeModelScene() {
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-8, 8, 8, -8, 0.01, 100)
  camera.position.set(0, 0, 30)
  camera.lookAt(0, 0, 0)
  camera.fitAspect = true

  return { scene, camera }
}

function fitCameraToAspect(camera, aspect) {
  if (!camera.fitAspect) return
  if (camera.isOrthographicCamera) {
    const halfH = (camera.top - camera.bottom) / 2
    const cx = (camera.left + camera.right) / 2
    const halfW = halfH * aspect
    camera.left = cx - halfW
    camera.right = cx + halfW
  } else if (camera.isPerspectiveCamera) {
    camera.aspect = aspect
  } else return
  camera.updateProjectionMatrix()
}

export async function renderModelScene(scene, camera, args) {
  if (!scene) throw new Error("renderModelScene requires a scene")
  if (!camera) throw new Error("renderModelScene requires a camera")
  scene.updateMatrixWorld(true)
  const v = new THREE.Vector3()
  scene.traverse(obj => {
    obj.userData.prepare?.(camera)
    if ((obj.isMesh || obj.isLineSegments) && !obj.userData.sky) {
      const positions = obj.geometry.attributes.position
      let maxZ = -Infinity
      if (positions.array) {
        for (let i = 0; i < positions.count; i++) {
          v.fromBufferAttribute(positions, i).applyMatrix4(obj.matrixWorld)
          if (v.z > maxZ) maxZ = v.z
        }
      } else {
        const b = obj.geometry.boundingBox
        for (let i = 0; i < 8; i++) {
          v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(obj.matrixWorld)
          if (v.z > maxZ) maxZ = v.z
        }
      }
      obj.renderOrder = maxZ
    }
  })
  sortObjectOnce(scene, camera)

  const size = platform.resolveRenderSize?.(args)
  const baseWidth = size?.width ?? args?.width ?? 256
  const baseHeight = size?.height ?? args?.height ?? 256

  fitCameraToAspect(camera, baseWidth / baseHeight)

  const collected = args?.animated ? collectAnimated(scene) : null
  const animatedTextures = collected?.textures ?? []

  if (platform.presentScene) {
    return platform.presentScene({ scene, camera, width: baseWidth, height: baseHeight, animatedTextures, args })
  }

  let dynamicLoop = 0
  if (collected) {
    for (const d of collected.dynamics) {
      const loop = DYNAMIC_LOOPS[d.userData.dynamic] ?? d.userData.loop
      if (loop) dynamicLoop = dynamicLoop ? lcmTicks(dynamicLoop, loop) : loop
    }
    if (collected.shaders.length) dynamicLoop = Infinity
  }

  const hasAnimation = animatedTextures.length > 0 || dynamicLoop > 0
  const animFormat = hasAnimation ? resolveAnimatedFormat(args?.animated, args?.format) : null
  const finalFormat = args?.format ?? animFormat
  const finalPath = animFormat ? adjustPathForFormat(args?.path, animFormat, args?.format === animFormat) : args?.path

  if (!hasAnimation) {
    const still = platform.createFrameRenderer({ width: baseWidth, height: baseHeight, background: args?.background, camera })
    applyShaderSalt(scene)
    freezeDynamics(true)
    let data
    try {
      still.renderFrame(scene, camera)
      verifyPrograms(still, scene, camera)
      data = still.readPixels()
    } finally {
      freezeDynamics(false)
    }
    if (scene.userData.ephemeral) still.release(scene)
    const buffer = await platform.encodeStill({ data, width: baseWidth, height: baseHeight, format: finalFormat, output: args?.output ?? OUTPUT_DEFAULTS[finalFormat] })
    if (finalPath) await platform.writeFile(finalPath, buffer)
    return args?.animated ? { buffer, format: finalFormat ?? "png" } : buffer
  }

  const width = args?.animatedWidth ?? baseWidth
  const height = args?.animatedHeight ?? baseHeight

  fitCameraToAspect(camera, width / height)

  const pixelLimit = platform.maxAnimationPixels ?? Infinity
  const hardFrameCap = Math.floor(pixelLimit / (width * height))
  const maxFrameCount = Math.min(hardFrameCap, args?.maxAnimationFrames ?? 4096)
  const excerptFrames = args?.maxAnimationFrames != null ? maxFrameCount : Math.min(maxFrameCount, 300)

  const { schedules, events, frameCount, delay } = computeAnimationTimeline(animatedTextures, maxFrameCount, dynamicLoop, excerptFrames)

  let advanceDynamics = null
  if (dynamicLoop) {
    let dynTime = 0
    let fakeFrame = 1e9
    const fake = { info: { render: { frame: 0 } } }
    setDynamicClock(() => dynTime)
    scene.updateMatrixWorld(true)
    camera.updateMatrixWorld(true)
    const tick = () => {
      fake.info.render.frame = ++fakeFrame
      for (const d of collected.dynamics) dynamicFrame(d, fake, camera)
    }
    tick()
    advanceDynamics = to => {
      while (dynTime < to) {
        dynTime = Math.min(dynTime + 200, to)
        tick()
      }
    }
    advanceDynamics(1000)
  }

  const frameRenderer = platform.createFrameRenderer({ width, height, background: args?.background, camera })
  applyShaderSalt(scene)

  const stacked = new Uint8Array(width * height * 4 * frameCount)

  try {
    for (let f = 0; f < frameCount; f++) {
      const t = events[f]
      for (const s of schedules) {
        const localT = t % s.total
        let frameIdx = 0
        for (let i = 0; i < s.boundaries.length - 1; i++) {
          if (localT >= s.boundaries[i] && localT < s.boundaries[i + 1]) {
            frameIdx = i
            break
          }
        }
        applyFrame(s, s.frames[frameIdx])
      }
      advanceDynamics?.(1000 + t * 50)
      for (const mat of collected.shaders) mat.uniforms.GameTime.value = (t % 24000) / 24000

      frameRenderer.renderFrame(scene, camera)
      if (f === 0) verifyPrograms(frameRenderer, scene, camera)
      stacked.set(frameRenderer.readPixels(), f * width * height * 4)
    }
  } finally {
    if (dynamicLoop) setDynamicClock(null)
  }

  if (scene.userData.ephemeral) frameRenderer.release(scene)

  const MAX_DELAY = 65535
  const frameSize = width * height * 4
  const splitChunks = []
  const splitDelay = []
  for (let f = 0; f < frameCount; f++) {
    const slice = stacked.subarray(f * frameSize, (f + 1) * frameSize)
    let remaining = delay[f]
    while (remaining > MAX_DELAY) {
      splitChunks.push(slice)
      splitDelay.push(MAX_DELAY)
      remaining -= MAX_DELAY
    }
    splitChunks.push(slice)
    splitDelay.push(remaining)
  }
  let finalBuf
  if (splitChunks.length === frameCount) {
    finalBuf = stacked
  } else {
    finalBuf = new Uint8Array(frameSize * splitChunks.length)
    for (let i = 0; i < splitChunks.length; i++) finalBuf.set(splitChunks[i], i * frameSize)
  }
  const finalFrameCount = splitDelay.length

  const buffer = await platform.encodeAnimated({
    data: finalBuf,
    width,
    height,
    pages: finalFrameCount,
    format: animFormat,
    delay: splitDelay,
    output: args?.animatedOutput ?? (animFormat === "webp" ? { lossless: true, effort: 2 } : OUTPUT_DEFAULTS[animFormat])
  })
  if (finalPath) await platform.writeFile(finalPath, buffer)
  return { buffer, format: animFormat }
}
