import * as core from "./core.js"
import { setPlatform, zipEntryFromFiles, computeAnimationTimeline, collectAnimated, buildSchedules, evaluateAnimation } from "./core.js"
import { parseZip } from "./zip.js"

const config = {}

export function configure(opts) {
  if ("assetsUrl" in opts && opts.assetsUrl !== config.assetsUrl) {
    bundledZipPromise = null
    warnedBundled = false
  }
  Object.assign(config, opts)
}

export let THREE = null

export async function getThree() {
  await init()
  return THREE
}

let initPromise
function init() {
  return initPromise ??= (async () => {
    let three = config.THREE ?? config.three
    if (!three) {
      try {
        three = await import("three")
      } catch {}
    }
    if (!three) three = globalThis.THREE
    if (!three) {
      initPromise = null
      throw new Error('three not found. Install/bundle three, add an import map entry for "three", or pass it with configure({ three })')
    }
    THREE = three
    setPlatform(makePlatform())
  })()
}

async function loadImage(data) {
  const blob = data instanceof Blob ? data : new Blob([data])
  return createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" })
}

async function loadTexture(input) {
  let source = input
  if (typeof ImageBitmap !== "undefined" && input instanceof ImageBitmap) {
    const canvas = new OffscreenCanvas(input.width, input.height)
    canvas.getContext("2d").drawImage(input, 0, 0)
    source = canvas
  }
  const tex = new THREE.CanvasTexture(source)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function parseColor(input) {
  const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace)
  if (input instanceof THREE.Color) return { color: input, alpha: 1 }
  if (typeof input === "number") return { color: new THREE.Color(input), alpha: 1 }
  if (Array.isArray(input)) return { color: srgb(input[0], input[1], input[2]), alpha: input[3] ?? 1 }
  if (typeof input === "string") {
    const hex8 = input.match(/^#([0-9a-f]{8})$/i)
    if (hex8) return { color: new THREE.Color("#" + hex8[1].slice(0, 6)), alpha: parseInt(hex8[1].slice(6), 16) / 255 }
    const hex4 = input.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])$/i)
    if (hex4) return { color: new THREE.Color(`#${hex4[1]}${hex4[1]}${hex4[2]}${hex4[2]}${hex4[3]}${hex4[3]}`), alpha: parseInt(hex4[4] + hex4[4], 16) / 255 }
    const rgb = input.match(/^rgba?\(([^)]*)\)$/i)
    if (rgb) {
      const parts = rgb[1].split(",").map(s => s.trim())
      return { color: new THREE.Color(`rgb(${parts.slice(0, 3).join(",")})`), alpha: parts.length === 4 ? parseFloat(parts[3]) : 1 }
    }
    const hsl = input.match(/^hsla?\(([^)]*)\)$/i)
    if (hsl) {
      const parts = hsl[1].split(",").map(s => s.trim())
      return { color: new THREE.Color(`hsl(${parts.slice(0, 3).join(",")})`), alpha: parts.length === 4 ? parseFloat(parts[3]) : 1 }
    }
    return { color: new THREE.Color(input), alpha: 1 }
  }
  if (typeof input === "object") return { color: srgb(input.r ?? 0, input.g ?? 0, input.b ?? 0), alpha: input.a ?? 1 }
}

let sharedRenderer = null

function getRenderer(width, height) {
  if (!sharedRenderer) {
    const canvas = new OffscreenCanvas(width, height)
    canvas.addEventListener?.("webglcontextlost", e => e.preventDefault())
    canvas.addEventListener?.("webglcontextrestored", () => {
      for (const p of players) p._stale = true
    })
    sharedRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, premultipliedAlpha: true })
    sharedRenderer.outputColorSpace = THREE.LinearSRGBColorSpace
  }
  const size = sharedRenderer.getSize(new THREE.Vector2())
  if (size.x !== width || size.y !== height) sharedRenderer.setSize(width, height, false)
  return sharedRenderer
}

function renderScene(scene, camera, width, height, background) {
  const renderer = getRenderer(width, height)
  const parsed = background != null ? parseColor(background) : null
  if (parsed) renderer.setClearColor(parsed.color, parsed.alpha)
  else renderer.setClearColor(0x000000, 0)
  renderer.render(scene, camera)
  return renderer.domElement
}

function disposeScene(scene) {
  scene.traverse(obj => {
    if (!obj.isMesh) return
    obj.geometry?.dispose()
    for (const mat of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      if (!mat) continue
      for (const uniform of Object.values(mat.uniforms ?? {})) {
        if (uniform?.value?.isTexture && !uniform.value.userData?.cached) uniform.value.dispose()
      }
      mat.dispose()
    }
  })
}

function getTargets(args, width, height) {
  const input = args?.canvas
  const list = Array.isArray(input) ? (input.length ? input : [undefined]) : [input]
  const targets = list.map(entry => {
    const spec = entry && typeof entry.getContext !== "function" ? entry : { canvas: entry }
    const x = spec.x ?? args?.x
    const y = spec.y ?? args?.y
    const placement = x !== undefined || y !== undefined
    const dw = spec.width ?? width
    const dh = spec.height ?? height
    const clear = spec.clear ?? args?.clear ?? !placement
    let canvas = spec.canvas
    if (!canvas) {
      canvas = typeof document !== "undefined" ? document.createElement("canvas") : new OffscreenCanvas(dw, dh)
      canvas.width = dw
      canvas.height = dh
    } else if (!placement && (canvas.width !== dw || canvas.height !== dh)) {
      canvas.width = dw
      canvas.height = dh
    }
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("The target canvas already has a non-2d context. Pass a fresh canvas, or use loadModel with your own renderer for live WebGL canvases")
    return { canvas, ctx, x: x ?? 0, y: y ?? 0, dw, dh, placement, clear }
  })
  targets.multi = Array.isArray(input)
  return targets
}

function targetCanvases(targets) {
  return targets.multi ? targets.map(t => t.canvas) : targets[0].canvas
}

function takeBitmap(canvas) {
  return canvas.transferToImageBitmap?.() ?? canvas
}

function blit(target, source, width, height, snapshot) {
  const { ctx, x, y, dw, dh, clear } = target
  if (snapshot) {
    ctx.clearRect(x, y, dw, dh)
    ctx.drawImage(snapshot, 0, 0, dw, dh, x, y, dw, dh)
  } else if (clear) {
    ctx.clearRect(x, y, dw, dh)
  }
  ctx.drawImage(source, 0, 0, width, height, x, y, dw, dh)
}

const players = new Set()
let epoch = typeof performance !== "undefined" ? performance.now() : 0
let clockPausedAt = null
const clockNow = () => (clockPausedAt ?? performance.now()) - epoch

export function pauseAnimations() {
  clockPausedAt ??= performance.now()
}

export function resumeAnimations() {
  if (clockPausedAt === null) return
  epoch += performance.now() - clockPausedAt
  clockPausedAt = null
}

let rafId = null

const FRAME_BUDGET_MS = 8
let queue = []
let queueTick = null

function schedulerLoop() {
  rafId = null
  const now = performance.now()
  const tick = clockNow() / 50
  const whole = Math.floor(tick)

  if (whole !== queueTick) {
    queueTick = whole
    const starved = new Set(queue)
    const fresh = []
    for (const p of players) {
      if (p.playing && p._visible && !starved.has(p)) fresh.push(p)
    }
    queue = queue.filter(p => p.playing && p._visible).concat(fresh)
  }

  const deadline = now + FRAME_BUDGET_MS
  while (queue.length && performance.now() < deadline) {
    queue.shift()._renderTick(tick)
  }

  let anyPlaying = false
  for (const p of players) {
    if (p.playing) {
      anyPlaying = true
      break
    }
  }
  if (anyPlaying) rafId = requestAnimationFrame(schedulerLoop)
}

function wakeScheduler() {
  rafId ??= requestAnimationFrame(schedulerLoop)
}

function makePlayer({ scene, camera, width, height, animatedTextures, args, targets }) {
  const schedules = buildSchedules(animatedTextures)

  const snapshots = targets.map(target => {
    if (!target.placement || target.clear) return null
    const snapshot = new OffscreenCanvas(target.dw, target.dh)
    snapshot.getContext("2d").drawImage(target.canvas, target.x, target.y, target.dw, target.dh, 0, 0, target.dw, target.dh)
    return snapshot
  })

  const gameTimeMats = collectAnimated(scene).shaders

  const evaluate = tickTime => evaluateAnimation(schedules, gameTimeMats, tickTime)

  function draw() {
    const prof = globalThis.__BMR_PROF
      ? (globalThis.__bmrProf ??= { evaluate: 0, render: 0, blit: 0, cached: 0, draws: 0 })
      : null
    let t0 = prof ? performance.now() : 0

    let source = null
    let cacheKey
    if (resolveCacheEnabled()) {
      frameCache ??= new Map()
      cacheKey = schedules.map(s => s.lastKey).join(",")
      source = frameCache.get(cacheKey)
    }
    if (source) {
      if (prof) prof.cached++
    } else {
      source = takeBitmap(renderScene(scene, camera, width, height, args?.background))
      if (cacheKey !== undefined) frameCache.set(cacheKey, source)
    }
    const t1 = prof ? performance.now() : 0

    for (let i = 0; i < targets.length; i++) {
      blit(targets[i], source, width, height, snapshots[i])
    }
    if (cacheKey === undefined) source.close?.()

    if (prof) {
      prof.render += t1 - t0
      prof.blit += performance.now() - t1
      prof.draws++
    }
  }

  let timeline = null
  let framesMeta = null
  const getTimeline = () => timeline ??= computeAnimationTimeline(animatedTextures, args?.maxAnimationFrames ?? 4096)

  const CACHE_DROP_MS = 10000
  const cacheMode = args?.cache ?? "auto"
  const cacheBudget = args?.cacheBudget ?? 4194304
  let cacheEnabled = cacheMode === true ? true : cacheMode === false ? false : null
  let frameCache = null
  let dropTimer = null

  function resolveCacheEnabled() {
    if (cacheEnabled !== null) return cacheEnabled
    if (gameTimeMats.length || !schedules.length) return cacheEnabled = false
    return cacheEnabled = getTimeline().frameCount * width * height * 4 <= cacheBudget
  }

  function clearCache() {
    if (!frameCache) return
    for (const bitmap of frameCache.values()) bitmap.close?.()
    frameCache = null
  }

  function updateCacheTimer() {
    const active = player.playing && player._visible
    if (active) {
      clearTimeout(dropTimer)
      dropTimer = null
    } else if (frameCache && !dropTimer) {
      dropTimer = setTimeout(() => {
        dropTimer = null
        clearCache()
      }, CACHE_DROP_MS)
    }
  }

  const player = {
    canvas: targetCanvases(targets),
    animated: schedules.length > 0 || gameTimeMats.length > 0,
    playing: false,
    _visible: true,
    _lastTick: null,
    _stale: false,

    get frames() {
      if (!schedules.length) return []
      const tl = getTimeline()
      return framesMeta ??= tl.events.map((t, i) => ({ time: Math.round(t * 50), duration: tl.delay[i] }))
    },
    get duration() {
      if (!schedules.length) return 0
      return Math.round(getTimeline().totalDuration * 50)
    },

    play() {
      if (this.playing || this._disposed || !this.animated) return
      this.playing = true
      this._lastTick = null
      updateCacheTimer()
      wakeScheduler()
    },
    pause() {
      this.playing = false
      updateCacheTimer()
    },
    renderTime(ms) {
      if (this._disposed || !this.animated) return
      evaluate(ms / 50)
      draw()
    },
    renderFrame(index) {
      const frames = this.frames
      if (!frames.length) return
      const i = ((index % frames.length) + frames.length) % frames.length
      this.renderTime(frames[i].time)
    },
    dispose() {
      if (this._disposed) return
      this._disposed = true
      this.playing = false
      players.delete(this)
      observer?.disconnect()
      clearTimeout(dropTimer)
      clearCache()
      disposeScene(scene)
    },

    _renderTick(tickTime) {
      const tick = Math.floor(tickTime)
      if (tick === this._lastTick && !this._stale) return
      this._lastTick = tick
      const t0 = globalThis.__BMR_PROF ? performance.now() : 0
      const changed = evaluate(tick)
      if (t0) (globalThis.__bmrProf ??= { evaluate: 0, render: 0, blit: 0, draws: 0 }).evaluate += performance.now() - t0
      if (changed || this._stale) draw()
      this._stale = false
    }
  }

  let observer = null
  const observable = typeof HTMLCanvasElement !== "undefined"
    ? targets.filter(t => t.canvas instanceof HTMLCanvasElement)
    : []
  if (args?.pauseOffscreen !== false && typeof IntersectionObserver !== "undefined" && observable.length) {
    const visible = new Set()
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target)
        else visible.delete(entry.target)
      }
      player._visible = visible.size > 0
      if (player._visible) player._lastTick = null
      updateCacheTimer()
    })
    for (const canvas of new Set(observable.map(t => t.canvas))) observer.observe(canvas)
  }

  if (player.animated) {
    evaluate(Math.floor(clockNow() / 50))
    draw()
    players.add(player)
    player.play()
  } else {
    draw()
    if (scene.userData.ephemeral) disposeScene(scene)
    player._disposed = true
  }

  return player
}

let bundledZipPromise
let warnedBundled = false
function loadBundledZip() {
  return bundledZipPromise ??= (async () => {
    const url = config.assetsUrl ?? new URL("../assets.zip", import.meta.url)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Failed to fetch bundled assets.zip from ${url} (${res.status}). If it lives elsewhere, set configure({ assetsUrl })`)
    return parseZip(new Uint8Array(await res.arrayBuffer()))
  })().catch(e => {
    bundledZipPromise = null
    throw e
  })
}

async function encodePng(canvas) {
  const blob = await canvas.convertToBlob({ type: "image/png" })
  return new Uint8Array(await blob.arrayBuffer())
}

let maxTexSize = null
function makePlatform() {
  return {
    THREE,
    loadTexture,
    loadImage,
    Canvas: OffscreenCanvas,
    inflateRaw,

    maxTextureSize() {
      if (maxTexSize) return maxTexSize
      const gl = new OffscreenCanvas(1, 1).getContext("webgl2") ?? new OffscreenCanvas(1, 1).getContext("webgl")
      maxTexSize = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 8192
      gl?.getExtension("WEBGL_lose_context")?.loseContext()
      return maxTexSize
    },


    prepareEntry(entry) {
      if (typeof entry === "string") {
        throw new Error("String asset paths are not available on web. Pass a zip (Uint8Array/ArrayBuffer/Blob) or a virtual handler")
      }
      return core.zipAssets(entry)
    },

    async addBundledEntries(arr) {
      if (config.assetsUrl === false) return
      let files
      try {
        files = await loadBundledZip()
      } catch (e) {
        if (!warnedBundled) {
          warnedBundled = true
          console.warn(`block-model-renderer: continuing without the bundled assets.zip: block entities won't render, and biome tints and the end sky fall back to flat colors (${e.message}). Set configure({ assetsUrl }) to point at assets.zip, or to false to opt out`)
        }
        return
      }
      const overrides = await zipEntryFromFiles(files, "overrides/")
      overrides.bundledOverrides = true
      arr.unshift(overrides)
      arr.push(await zipEntryFromFiles(files, "fallbacks/"))
    },

    resolveRenderSize(args) {
      let first = Array.isArray(args?.canvas) ? args.canvas[0] : args?.canvas
      if (first && typeof first.getContext !== "function") first = first.canvas
      return {
        width: args?.width ?? (first ? first.width : 256),
        height: args?.height ?? (first ? first.height : 256)
      }
    },

    presentScene({ scene, camera, width, height, animatedTextures, args }) {
      const targets = getTargets(args, width, height)
      if (args?.animated) {
        return makePlayer({ scene, camera, width, height, animatedTextures, args, targets })
      }
      const source = takeBitmap(renderScene(scene, camera, width, height, args?.background))
      for (const target of targets) blit(target, source, width, height)
      source.close?.()
      if (scene.userData.ephemeral) disposeScene(scene)
      return targetCanvases(targets)
    },

    async getImageSize(data) {
      const img = await loadImage(data)
      const size = { width: img.width, height: img.height }
      img.close?.()
      return size
    },

    async cropToPng(data, { left, top, width, height }) {
      const img = await loadImage(data)
      const canvas = new OffscreenCanvas(width, height)
      canvas.getContext("2d").drawImage(img, left, top, width, height, 0, 0, width, height)
      img.close?.()
      return encodePng(canvas)
    },

    async decodeToRaw(data) {
      const img = await loadImage(data)
      const canvas = new OffscreenCanvas(img.width, img.height)
      const ctx = canvas.getContext("2d", { willReadFrequently: true })
      ctx.drawImage(img, 0, 0)
      const imageData = ctx.getImageData(0, 0, img.width, img.height)
      img.close?.()
      return { data: new Uint8Array(imageData.data.buffer), width: imageData.width, height: imageData.height }
    },

    async encodeRawToPng({ data, width, height }) {
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext("2d")
      ctx.putImageData(new ImageData(new Uint8ClampedArray(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length), width, height), 0, 0)
      return encodePng(canvas)
    },

    writeFile() {
      throw new Error("The path option is not available on web - renders return canvases")
    }
  }
}

function wrap(name) {
  return async (...args) => {
    await init()
    return core[name](...args)
  }
}

export const renderBlock = wrap("renderBlock")
export const renderItem = wrap("renderItem")
export const renderModel = wrap("renderModel")
export const prepareAssets = wrap("prepareAssets")
export const readFile = wrap("readFile")
export const listDirectory = wrap("listDirectory")
export const parseBlockstate = wrap("parseBlockstate")
export const parseItemDefinition = wrap("parseItemDefinition")
export const resolveModelData = wrap("resolveModelData")
export const renderModelScene = wrap("renderModelScene")
export const getCullFaces = wrap("getCullFaces")
export const computeSceneLight = wrap("computeSceneLight")
export const getBiomeTint = wrap("getBiomeTint")
export const renderTexture = wrap("renderTexture")

export async function readTexture(path, assets, opts) {
  await init()
  const texture = await core.readTexture(path, assets)
  if (!texture) return texture
  if (texture.animated && opts?.onChange) {
    texture.current = texture.frameAt(clockNow() / 50)
    const sub = {
      playing: true,
      _visible: true,
      animated: true,
      play() {},
      pause() {},
      _renderTick(tick) {
        const frame = texture.frameAt(tick)
        if (frame === texture.current) return
        texture.current = frame
        opts.onChange(frame)
      }
    }
    players.add(sub)
    wakeScheduler()
    texture.stop = () => players.delete(sub)
  }
  return texture
}

export async function loadModel(scene, assets, model, args) {
  await init()
  const group = await core.loadModel(scene, assets, model, args)
  if (args?.animate !== false) attachAutoAnimation(group)
  return group
}

export async function createScene(assets, blocks, args) {
  await init()
  const handle = await core.createScene(assets, blocks, args)
  if (handle && args?.animate !== false) attachAutoAnimation(handle.group)
  return handle
}

function attachAutoAnimation(root) {
  const { textures, shaders } = collectAnimated(root)
  if (!textures.length && !shaders.length) return
  const schedules = buildSchedules(textures)
  root.traverse(obj => {
    if (obj.isMesh) obj.onBeforeRender = () => evaluateAnimation(schedules, shaders, clockNow() / 50)
  })
}
export const zipAssets = wrap("zipAssets")
export { parseZip } from "./zip.js"

export async function makeModelScene() {
  await init()
  return core.makeModelScene()
}

export function createAnimator(root) {
  if (!root) throw new Error("createAnimator requires an object to animate")
  const { textures, shaders } = collectAnimated(root)
  const schedules = buildSchedules(textures)
  return {
    get animated() { return schedules.length > 0 || shaders.length > 0 },
    update(timeMs) {
      const tick = (timeMs ?? clockNow()) / 50
      return evaluateAnimation(schedules, shaders, tick)
    }
  }
}

export { COLORS, isWaterloggable, isWaterlogged, getLightEmission, isCrossModel, disposeCache, fluidHeights, fluidTypeOf, ModelLoader, optimizeScene, sortTranslucent, LIGHT_DIMENSIONS } from "./core.js"
