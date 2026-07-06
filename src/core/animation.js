import { Canvas } from "./platform.js"

export function computeAnimationTimeline(animatedTextures, maxFrameCount) {
  let schedules, totalDuration, events, frameCount
  for (let maxSubFrames = 8; maxSubFrames >= 1; maxSubFrames--) {
    schedules = animatedTextures.map(tex => {
      let frames = tex.userData.frames
      let times = tex.userData.times ?? frames.map(() => 1)
      if (tex.userData.interpolate) {
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
      return { tex, frames, times, total, boundaries }
    })
    totalDuration = schedules.reduce((acc, s) => {
      let a = acc, b = s.total
      while (b) [a, b] = [b, a % b]
      return (acc * s.total) / a
    }, 1)

    const eventSet = new Set()
    for (const s of schedules) {
      for (let loop = 0; loop * s.total < totalDuration; loop++) {
        for (const b of s.boundaries) {
          const t = loop * s.total + b
          if (t < totalDuration) eventSet.add(t)
        }
      }
    }
    events = Array.from(eventSet).sort((a, b) => a - b)
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

function applyTint(img, tint) {
  const canvas = new Canvas(img.width, img.height)
  const ctx = canvas.getContext("2d")
  ctx.drawImage(img, 0, 0)
  ctx.globalCompositeOperation = "multiply"
  ctx.fillStyle = COLOURS.dye[tint] ?? tint
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
      if (tex?.userData?.frames && !textures.includes(tex)) textures.push(tex)
    }
  })
  return { textures, shaders }
}

export function buildSchedules(textures) {
  return textures.map(tex => {
    const frames = tex.userData.frames
    const times = tex.userData.times ?? frames.map(() => 1)
    const boundaries = [0]
    let acc = 0
    for (const t of times) boundaries.push(acc += t)
    return { tex, frames, times, total: acc, boundaries, interpolate: !!tex.userData.interpolate, lastKey: null }
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
      s.tex.image = s.interpolate
        ? interpolateFrames(s.frames[idx], s.frames[(idx + 1) % s.frames.length], ratio)
        : s.frames[idx]
      s.tex.needsUpdate = true
      changed = true
    }
  }
  return changed
}

export function interpolateFrames(a, b, ratio) {
  const canvas = new Canvas(a.width, a.height)
  const ctx = canvas.getContext("2d")
  const da = a.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, a.width, a.height).data
  const db = b.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, b.width, b.height).data
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
