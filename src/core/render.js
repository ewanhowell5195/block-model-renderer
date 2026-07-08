import { platform, render, THREE } from "./platform.js"
import { prepareAssets, scopedCache } from "./assets.js"
import { parseBlockstate, parseItemDefinition, resolveModelData, loadModel } from "./models.js"
import { selfCulls } from "./culling.js"
import { occludingFaces, faceIsEmpty, faceCovered } from "./occlusion.js"
import { computeAnimationTimeline, collectAnimated } from "./animation.js"

const OPPOSITE = { down: "up", up: "down", north: "south", south: "north", east: "west", west: "east" }

async function buildBlockModel(assets, id, props, version) {
  const g = new THREE.Group()
  for (const model of await parseBlockstate(assets, id, { data: props ?? {}, ignoreAtlases: true, version })) {
    if (model.model === "~missing") return null
    await loadModel(g, assets, await resolveModelData(assets, model), { display: {}, animate: false })
  }
  return g
}

export async function getCullFaces({ id, blockstates, neighbors, assets, version } = {}) {
  assets = scopedCache(await prepareAssets(assets))
  const occCache = assets.cache.occlusion
  function stateKey(bid, props) {
    let key = bid
    if (props) for (const k of Object.keys(props).sort()) key += "," + k + "=" + props[k]
    return key
  }
  async function masksFor(bid, props) {
    const key = stateKey(bid, props)
    let m = occCache.get(key)
    if (m === undefined) {
      try {
        const g = await buildBlockModel(assets, bid, props, version)
        m = g ? occludingFaces(g, bid) : null
      } catch { m = null }
      occCache.set(key, m)
    }
    return m
  }
  async function selfMasksFor() {
    const key = "self\0" + stateKey(id, blockstates)
    let m = occCache.get(key)
    if (m === undefined) {
      try {
        const g = await buildBlockModel(assets, id, blockstates, version)
        m = g ? occludingFaces(g, null, true) : null
      } catch { m = null }
      occCache.set(key, m)
    }
    return m
  }
  let selfP
  const selfMasks = () => selfP ??= selfMasksFor()
  const cull = new Set()
  for (const dir in OPPOSITE) {
    const n = neighbors?.[dir]
    if (n == null || n === false) continue
    if (n === true) { cull.add(dir); continue }
    const nid = typeof n === "string" ? n : n.id
    if (typeof n === "object" && "occludes" in n) {
      if (n.occludes || selfCulls(id, nid, dir)) cull.add(dir)
      continue
    }
    if (!nid) continue
    if (selfCulls(id, nid, dir)) { cull.add(dir); continue }
    const sm = (await selfMasks())?.[dir]
    if (!sm || faceIsEmpty(sm)) continue
    const props = typeof n === "string" ? undefined : (({ id, ...rest }) => rest)(n)
    const nm = await masksFor(nid, props)
    if (nm && faceCovered(sm, nm[OPPOSITE[dir]])) cull.add(dir)
  }
  return cull
}

const OUTPUT_DEFAULTS = {
  jpeg: { mozjpeg: true },
  jpg: { mozjpeg: true },
  webp: { lossless: true }
}

export async function renderBlock(args = {}) {
  args.id ??= ""
  args.assets ??= []
  args.blockstates ??= {}
  args.display ??= {
    rotation: [30, 225, 0],
    scale: [0.625, 0.625, 0.625],
    type: "fallback",
    display: "gui"
  }

  args.assets = await prepareAssets(args.assets)
  const assets = scopedCache(args.assets)
  const { scene, camera } = makeModelScene()
  scene.userData.ephemeral = true

  const models = await parseBlockstate(assets, args.id, { data: args.blockstates, ignoreAtlases: args.ignoreAtlases, version: args.version })

  const cull = args.cull ?? (args.neighbors ? await getCullFaces({ id: args.id, blockstates: args.blockstates, neighbors: args.neighbors, assets, version: args.version }) : undefined)

  for (const model of models) {
    const resolved = await resolveModelData(assets, model)
    await loadModel(scene, assets, resolved, { display: args.display, cull, lighting: args.lighting, shaderScale: args.shaderScale })
  }

  return renderModelScene(scene, camera, args)
}

export async function renderItem(args = {}) {
  args.id ??= ""
  args.assets ??= []
  args.components ??= {}
  args.display ??= {
    type: "fallback",
    display: "gui"
  }

  args.assets = await prepareAssets(args.assets)
  const assets = scopedCache(args.assets)
  const { scene, camera } = makeModelScene()
  scene.userData.ephemeral = true

  const models = await parseItemDefinition(assets, args.id, { data: args.components, display: args.display, ignoreAtlases: args.ignoreAtlases, version: args.version })

  for (const model of models) {
    const resolved = await resolveModelData(assets, model)
    await loadModel(scene, assets, resolved, { display: args.display, cull: args.cull, lighting: args.lighting, shaderScale: args.shaderScale })
  }

  return renderModelScene(scene, camera, args)
}

export async function renderModel(args) {
  args.model ??= {}
  args.assets ??= []
  args.display ??= {
    rotation: [30, 225, 0],
    scale: [0.625, 0.625, 0.625],
    type: "fallback",
    display: "gui"
  }

  args.assets = await prepareAssets(args.assets)
  const { scene, camera } = makeModelScene()
  scene.userData.ephemeral = true

  const resolved = await resolveModelData(args.assets, { model: args.model})
  await loadModel(scene, args.assets, resolved, { display: args.display, cull: args.cull, lighting: args.lighting, shaderScale: args.shaderScale })

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
  const size = platform.resolveRenderSize?.(args)
  const baseWidth = size?.width ?? args?.width ?? 256
  const baseHeight = size?.height ?? args?.height ?? 256

  fitCameraToAspect(camera, baseWidth / baseHeight)

  const animatedTextures = args?.animated ? collectAnimated(scene).textures : []

  if (platform.presentScene) {
    return platform.presentScene({ scene, camera, width: baseWidth, height: baseHeight, animatedTextures, args })
  }

  const hasAnimation = animatedTextures.length > 0
  const animFormat = hasAnimation ? resolveAnimatedFormat(args?.animated, args?.format) : null
  const finalFormat = args?.format ?? animFormat
  const finalPath = animFormat ? adjustPathForFormat(args?.path, animFormat, args?.format) : args?.path

  if (!hasAnimation) {
    const buffer = await render({
      scene,
      camera,
      width: baseWidth,
      height: baseHeight,
      path: finalPath,
      format: finalFormat,
      output: args?.output ?? OUTPUT_DEFAULTS[finalFormat],
      background: args?.background,
      colorSpace: THREE.LinearSRGBColorSpace
    })
    return args?.animated ? { buffer, format: "png" } : buffer
  }

  const width = args?.animatedWidth ?? baseWidth
  const height = args?.animatedHeight ?? baseHeight

  fitCameraToAspect(camera, width / height)

  const pixelLimit = platform.maxAnimationPixels ?? Infinity
  const hardFrameCap = Math.floor(pixelLimit / (width * height))
  const maxFrameCount = Math.min(hardFrameCap, args?.maxAnimationFrames ?? 4096)

  const { schedules, events, frameCount, delay } = computeAnimationTimeline(animatedTextures, maxFrameCount)

  const frameRenderer = platform.createFrameRenderer({ width, height, background: args?.background, camera })

  const stacked = new Uint8Array(width * height * 4 * frameCount)

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
      s.tex.image = s.frames[frameIdx]
      s.tex.needsUpdate = true
    }

    frameRenderer.renderFrame(scene, camera)
    stacked.set(frameRenderer.readPixels(), f * width * height * 4)
  }

  frameRenderer.dispose()

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
    output: args?.animatedOutput ?? OUTPUT_DEFAULTS[animFormat]
  })
  if (finalPath) await platform.writeFile(finalPath, buffer)
  return { buffer, format: animFormat }
}
