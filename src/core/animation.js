import { THREE, Canvas, loadImage, parseJson } from "./platform.js"
import { readFile } from "./assets.js"
import { subUpload, subFlush } from "./subtex.js"

let _animRenderer = null
export function setAnimationRenderer(renderer) { _animRenderer = renderer }

function textureChannels(tex) {
  const regions = tex.userData.regions
  if (!regions) return [{ tex, frames: tex.userData.frames, times: tex.userData.times, interpolate: !!tex.userData.interpolate, region: null }]
  return regions.map(r => ({ tex, frames: r.frames, times: r.times, interpolate: !!r.interpolate, region: r }))
}

export function applyFrame(s, image) {
  if (s.region) {
    const { x, y, w, h } = s.region
    const ctx = s.tex.image.getContext("2d")
    ctx.clearRect(x - 1, y - 1, w + 2, h + 2)
    ctx.drawImage(image, x, y)
    ctx.drawImage(image, 0, 0, w, 1, x, y - 1, w, 1)
    ctx.drawImage(image, 0, h - 1, w, 1, x, y + h, w, 1)
    ctx.drawImage(image, 0, 0, 1, h, x - 1, y, 1, h)
    ctx.drawImage(image, w - 1, 0, 1, h, x + w, y, 1, h)
    if (_animRenderer) {
      try {
        const sub = new Canvas(w + 2, h + 2)
        sub.getContext("2d").drawImage(s.tex.image, x - 1, y - 1, w + 2, h + 2, 0, 0, w + 2, h + 2)
        if (subUpload(_animRenderer, s.tex, sub, x - 1, y - 1)) return
      } catch {}
    }
  } else {
    s.tex.image = image
  }
  s.tex.needsUpdate = true
}

export function computeAnimationTimeline(animatedTextures, maxFrameCount) {
  let schedules, totalDuration, events, frameCount
  for (let maxSubFrames = 8; maxSubFrames >= 1; maxSubFrames--) {
    schedules = animatedTextures.flatMap(textureChannels).map(ch => {
      let frames = ch.frames
      let times = ch.times ?? frames.map(() => 1)
      if (ch.interpolate) {
        const exp = expandInterpolated(frames, times, maxSubFrames)
        frames = exp.frames
        times = exp.times
      }
      const total = times.reduce((s, t) => s + t, 0)
      const boundaries = [0]
      let acc = 0
      for (const t of times) {
        acc += t
        boundaries.push(acc)
      }
      return { tex: ch.tex, region: ch.region, frames, times, total, boundaries }
    })
    totalDuration = schedules.reduce((acc, s) => {
      let a = acc, b = s.total
      while (b) [a, b] = [b, a % b]
      return (acc * s.total) / a
    }, 1)

    const cap = maxFrameCount + 1
    const eventSet = new Set()
    for (const s of schedules) {
      let added = 0
      outer: for (let loop = 0; loop * s.total < totalDuration; loop++) {
        for (let i = 0; i < s.boundaries.length - 1; i++) {
          const t = loop * s.total + s.boundaries[i]
          if (t >= totalDuration) break outer
          eventSet.add(t)
          if (++added >= cap) break outer
        }
      }
    }
    events = Array.from(eventSet).sort((a, b) => a - b).slice(0, cap)
    frameCount = events.length

    if (frameCount <= maxFrameCount) break
  }

  if (frameCount > maxFrameCount) {
    const longest = Math.max(...schedules.map(s => s.total))
    const cutoff = events[maxFrameCount]
    const snapped = Math.floor(cutoff / longest) * longest
    const idx = snapped > 0 ? events.indexOf(snapped) : -1
    if (idx > 0) {
      events = events.slice(0, idx)
      totalDuration = snapped
      frameCount = events.length
    } else {
      totalDuration = events[maxFrameCount]
      events = events.slice(0, maxFrameCount)
      frameCount = maxFrameCount
    }
  }

  const delay = []
  let delayAcc = 0
  let delayPrev = 0
  for (let f = 0; f < frameCount; f++) {
    const dur = (f + 1 < frameCount ? events[f + 1] : totalDuration) - events[f]
    delayAcc += dur * 50
    const rounded = Math.round(delayAcc)
    delay.push(rounded - delayPrev)
    delayPrev = rounded
  }

  return { schedules, events, totalDuration, frameCount, delay }
}

export function buildAnimation(image, meta) {
  const defaultSize = Math.min(image.width, image.height)
  const cropW = meta.width ?? defaultSize
  const cropH = meta.height ?? defaultSize

  const cols = Math.max(1, Math.floor(image.width / cropW))
  const rows = Math.max(1, Math.floor(image.height / cropH))
  const frameCount = cols * rows
  const stripFrames = []
  for (let i = 0; i < frameCount; i++) {
    const sx = (i % cols) * cropW
    const sy = Math.floor(i / cols) * cropH
    const canvas = new Canvas(cropW, cropH)
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    ctx.drawImage(image, sx, sy, cropW, cropH, 0, 0, cropW, cropH)
    stripFrames.push(canvas)
  }

  const defaultTime = meta.frametime ?? 1
  let playback
  let playbackTimes
  if (Array.isArray(meta.frames)) {
    playback = []
    playbackTimes = []
    for (const entry of meta.frames) {
      const index = typeof entry === "number" ? entry : entry.index
      const time = typeof entry === "number" ? defaultTime : (entry.time ?? defaultTime)
      const canvas = stripFrames[index]
      if (!canvas) continue
      playback.push(canvas)
      playbackTimes.push(time)
    }
  }
  if (!playback?.length) {
    playback = stripFrames
    playbackTimes = stripFrames.map(() => defaultTime)
  }

  return { image: playback[0], frames: playback, times: playbackTimes, interpolate: !!meta.interpolate, animated: playback.length > 1 }
}

export async function readTexture(path, assets) {
  const buf = await readFile(path, assets)
  if (!buf) return null
  const image = await loadImage(buf)
  let meta = null
  try { meta = parseJson(await readFile(path + ".mcmeta", assets, buf.hintIndex)) } catch {}
  const anim = meta?.animation ? buildAnimation(image, meta.animation) : { image, frames: [image], times: [1], interpolate: false, animated: false }
  const boundaries = [0]
  let total = 0
  for (const t of anim.times) boundaries.push(total += t)
  let lastKey = null, lastFrame = anim.frames[0]
  return {
    ...anim,
    meta,
    current: anim.frames[0],
    stop() {},
    frameAt(tick) {
      if (!anim.animated) return anim.frames[0]
      const t = Math.floor(((tick % total) + total) % total)
      let idx = 0
      for (let i = 0; i < boundaries.length - 1; i++) {
        if (t >= boundaries[i] && t < boundaries[i + 1]) {
          idx = i
          break
        }
      }
      const ratio = anim.interpolate ? (t - boundaries[idx]) / anim.times[idx] : 0
      const key = idx + ":" + Math.round(ratio * 1000)
      if (key !== lastKey) {
        lastKey = key
        lastFrame = anim.interpolate
          ? interpolateFrames(anim.frames[idx], anim.frames[(idx + 1) % anim.frames.length], ratio)
          : anim.frames[idx]
      }
      return lastFrame
    }
  }
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

function expandInterpolated(frames, times, maxSubFrames) {
  const expanded = []
  const expandedTimes = []
  for (let i = 0; i < frames.length; i++) {
    const a = frames[i]
    const b = frames[(i + 1) % frames.length]
    const time = times[i]
    const steps = Math.min(time, maxSubFrames)
    const subTime = time / steps
    for (let t = 0; t < steps; t++) {
      expanded.push(interpolateFrames(a, b, t / steps))
      expandedTimes.push(subTime)
    }
  }
  return { frames: expanded, times: expandedTimes }
}

export function collectAnimated(root) {
  const textures = []
  const shaders = []
  root.traverse(obj => {
    if (!obj.isMesh) return
    for (const mat of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      if (!mat) continue
      if (mat.uniforms?.GameTime && !shaders.includes(mat)) shaders.push(mat)
      const tex = mat.uniforms?.map?.value ?? mat.map
      if ((tex?.userData?.frames || tex?.userData?.regions) && !textures.includes(tex)) textures.push(tex)
    }
  })
  return { textures, shaders }
}

export function buildSchedules(textures) {
  return textures.flatMap(textureChannels).map(ch => {
    const frames = ch.frames
    const times = ch.times ?? frames.map(() => 1)
    const boundaries = [0]
    let acc = 0
    for (const t of times) boundaries.push(acc += t)
    return { tex: ch.tex, region: ch.region, frames, times, total: acc, boundaries, interpolate: ch.interpolate, lastKey: null }
  })
}

export function evaluateAnimation(schedules, shaders, tickTime) {
  let changed = false
  for (const mat of shaders) {
    const value = (((tickTime % 24000) + 24000) % 24000) / 24000
    if (mat.uniforms.GameTime.value !== value) {
      mat.uniforms.GameTime.value = value
      changed = true
    }
  }
  const textureTick = Math.floor(tickTime)
  for (const s of schedules) {
    const localT = ((textureTick % s.total) + s.total) % s.total
    let idx = 0
    for (let i = 0; i < s.boundaries.length - 1; i++) {
      if (localT >= s.boundaries[i] && localT < s.boundaries[i + 1]) {
        idx = i
        break
      }
    }
    let key
    let ratio = 0
    if (s.interpolate) {
      ratio = (localT - s.boundaries[idx]) / s.times[idx]
      key = `${idx}:${Math.round(ratio * 1000)}`
    } else {
      key = String(idx)
    }
    if (key !== s.lastKey) {
      s.lastKey = key
      applyFrame(s, s.interpolate
        ? interpolateFrames(s.frames[idx], s.frames[(idx + 1) % s.frames.length], ratio)
        : s.frames[idx])
      changed = true
    }
  }
  if (changed && _animRenderer) subFlush(_animRenderer)
  return changed
}

const _framePixels = new WeakMap()
function framePixels(c) {
  let d = _framePixels.get(c)
  if (!d) {
    d = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data
    _framePixels.set(c, d)
  }
  return d
}

export function interpolateFrames(a, b, ratio) {
  const canvas = new Canvas(a.width, a.height)
  const ctx = canvas.getContext("2d")
  const da = framePixels(a)
  const db = framePixels(b)
  const out = ctx.createImageData(a.width, a.height)
  const inv = 1 - ratio
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i]     = Math.round(da[i]     * inv + db[i]     * ratio)
    out.data[i + 1] = Math.round(da[i + 1] * inv + db[i + 1] * ratio)
    out.data[i + 2] = Math.round(da[i + 2] * inv + db[i + 2] * ratio)
    out.data[i + 3] = da[i + 3]
  }
  ctx.putImageData(out, 0, 0)
  return canvas
}
