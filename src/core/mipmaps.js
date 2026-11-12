import { platform, THREE, Canvas } from "./platform.js"

export const MAX_MIPMAPS = 4
export const MIP_INSET = 1 / 64
const STRATEGIES = new Set(["auto", "mean", "cutout", "strict_cutout", "dark_cutout"])

const toLinear = x => x >= 0.04045 ? ((x + 0.055) / 1.055) ** 2.4 : x / 12.92
const toSrgb = x => x >= 0.0031308 ? 1.055 * x ** (1 / 2.4) - 0.055 : 12.92 * x
const SRGB_TO_LINEAR = Uint16Array.from({ length: 256 }, (_, i) => Math.round(toLinear(i / 255) * 1023))
const LINEAR_TO_SRGB = Uint8Array.from({ length: 1024 }, (_, i) => Math.round(toSrgb(i / 1023) * 255))
const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

export function mipLevels(value, owner) {
  const levels = value ?? 0
  if (!Number.isInteger(levels) || levels < 0 || levels > MAX_MIPMAPS) throw new Error(`${owner}: mipmaps must be a whole number of levels from 0 to ${MAX_MIPMAPS}, got ${value}`)
  if (levels && platform.mipmaps === false) throw new Error(`${owner}: mipmaps need WebGL2, which Node rendering doesn't have`)
  return levels
}

export function mipSettings(meta, path) {
  const section = meta?.texture ?? {}
  const strategy = STRATEGIES.has(section.mipmap_strategy) ? section.mipmap_strategy : "auto"
  const bias = typeof section.alpha_cutoff_bias === "number" ? section.alpha_cutoff_bias : 0
  return { strategy, bias, item: /\/textures\/item\//.test(path) }
}

export function alignUp(n, levels) {
  const step = 1 << levels
  return Math.ceil(n / step) * step
}

export function readPixels(image) {
  const known = platform.imagePixels?.(image)
  if (known) return known
  if (image.data && image.width && image.height) return image.data
  const ctx = typeof image.getContext === "function" ? image.getContext("2d", { willReadFrequently: true }) : null
  if (ctx) return ctx.getImageData(0, 0, image.width, image.height).data
  const canvas = new Canvas(image.width, image.height)
  const drawn = canvas.getContext("2d", { willReadFrequently: true })
  drawn.drawImage(image, 0, 0)
  return drawn.getImageData(0, 0, image.width, image.height).data
}

export function extrudeCell(pixels, w, h, cw, ch) {
  const out = new Uint8ClampedArray(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    const sy = Math.min(y, h - 1), row = y * cw * 4
    out.set(pixels.subarray(sy * w * 4, (sy + 1) * w * 4), row)
    const last = pixels.subarray((sy * w + w - 1) * 4, (sy * w + w) * 4)
    for (let x = w; x < cw; x++) out.set(last, row + x * 4)
  }
  return out
}

export function blit(level, page, pageWidth, x, y) {
  for (let row = 0; row < level.height; row++) page.set(level.data.subarray(row * level.width * 4, (row + 1) * level.width * 4), ((y + row) * pageWidth + x) * 4)
}

function hasTransparent(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] === 0) return true
  return false
}

function solidify(data, width, height) {
  const nearest = new Int32Array(width * height).fill(-1)
  const distance = new Int32Array(width * height).fill(2147483647)
  const queue = []
  for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) {
    const p = x + y * width
    if (data[p * 4 + 3] === 0) continue
    distance[p] = 0
    nearest[p] = p
    queue.push(p)
  }
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head], x = p % width, y = (p - x) / width
    for (const [dx, dy] of DIRECTIONS) {
      const nx = x + dx, ny = y + dy, n = nx + ny * width
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || distance[n] <= distance[p] + 1) continue
      distance[n] = distance[p] + 1
      nearest[n] = nearest[p]
      queue.push(n)
    }
  }
  for (let p = 0; p < width * height; p++) {
    if (data[p * 4 + 3] !== 0) continue
    const from = nearest[p]
    for (let c = 0; c < 3; c++) data[p * 4 + c] = from < 0 ? 0 : data[from * 4 + c]
  }
}

function fillDark(data) {
  let darkest = -1, least = Infinity
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    const brightness = data[i] + data[i + 1] + data[i + 2]
    if (brightness < least) {
      least = brightness
      darkest = i
    }
  }
  const dark = [0, 1, 2].map(c => darkest < 0 ? 191 : Math.floor(3 * data[darkest + c] / 4))
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 0) data.set(dark, i)
}

function meanLinear(data, a, b, c, d, out, at) {
  out[at + 3] = Math.floor((data[a + 3] + data[b + 3] + data[c + 3] + data[d + 3]) / 4)
  for (let n = 0; n < 3; n++) out[at + n] = LINEAR_TO_SRGB[Math.floor((SRGB_TO_LINEAR[data[a + n]] + SRGB_TO_LINEAR[data[b + n]] + SRGB_TO_LINEAR[data[c + n]] + SRGB_TO_LINEAR[data[d + n]]) / 4)]
}

function darkBlend(data, a, b, c, d, out, at) {
  const total = [0, 0, 0, 0]
  for (const i of [a, b, c, d]) {
    if (data[i + 3] === 0) continue
    for (let n = 0; n < 4; n++) total[n] += SRGB_TO_LINEAR[data[i + n]] / 1023
  }
  for (let n = 0; n < 4; n++) out[at + n] = LINEAR_TO_SRGB[Math.floor(total[n] / 4 * 1023)]
}

function coverage(data, width, height, ref, scale) {
  let covered = 0
  for (let y = 0; y < height - 1; y++) for (let x = 0; x < width - 1; x++) {
    const at = (x, y) => Math.min(Math.max(data[(y * width + x) * 4 + 3] / 255 * scale, 0), 1)
    const a00 = at(x, y), a10 = at(x + 1, y), a01 = at(x, y + 1), a11 = at(x + 1, y + 1)
    let texel = 0
    for (let sy = 0; sy < 4; sy++) {
      const fy = (sy + 0.5) / 4
      for (let sx = 0; sx < 4; sx++) {
        const fx = (sx + 0.5) / 4
        if (a00 * (1 - fx) * (1 - fy) + a10 * fx * (1 - fy) + a01 * (1 - fx) * fy + a11 * fx * fy > ref) texel++
      }
    }
    covered += texel / 16
  }
  return covered / ((width - 1) * (height - 1))
}

function scaleToCoverage(level, desired, ref, bias) {
  let low = 0, high = 4, scale = 1, best = 1, bestError = Infinity
  for (let i = 0; i < 5; i++) {
    const current = coverage(level.data, level.width, level.height, ref, scale)
    const error = Math.abs(current - desired)
    if (error < bestError) {
      bestError = error
      best = scale
    }
    if (current < desired) low = scale
    else if (current > desired) high = scale
    else break
    scale = (low + high) / 2
  }
  for (let i = 3; i < level.data.length; i += 4) level.data[i] = Math.floor(Math.min(Math.max(level.data[i] / 255 * best + bias + 0.025, 0), 1) * 255)
}

export function spriteMips(pixels, width, height, levels, mip = {}) {
  let strategy = mip.strategy ?? "auto"
  if (strategy === "auto") strategy = hasTransparent(pixels) ? "cutout" : "mean"
  const cutout = strategy === "cutout" || strategy === "strict_cutout" || strategy === "dark_cutout"
  if (!mip.item) {
    if (strategy === "cutout" || strategy === "strict_cutout") solidify(pixels, width, height)
    else if (strategy === "dark_cutout") fillDark(pixels)
  }
  const ref = strategy === "strict_cutout" ? 0.3 : 0.5
  const original = cutout ? coverage(pixels, width, height, ref, 1) : 0
  const blend = strategy === "dark_cutout" ? darkBlend : meanLinear
  const chain = [{ data: pixels, width, height }]
  for (let k = 1; k <= levels; k++) {
    const last = chain[k - 1], w = last.width
    const level = { data: new Uint8ClampedArray(w * last.height), width: w / 2, height: last.height / 2 }
    for (let y = 0; y < level.height; y++) for (let x = 0; x < level.width; x++) {
      const a = (y * 2 * w + x * 2) * 4
      blend(last.data, a, a + 4, a + w * 4, a + w * 4 + 4, level.data, (y * level.width + x) * 4)
    }
    if (cutout) scaleToCoverage(level, original, ref, mip.bias ?? 0)
    chain.push(level)
  }
  return chain
}

export function toImageData(level) {
  return new (platform.ImageData ?? ImageData)(level.data, level.width, level.height)
}

export function useMipmaps(texture, images) {
  texture.mipmaps = images
  texture.minFilter = THREE.NearestMipmapLinearFilter
  texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
}
