import { Canvas, loadImage } from "./platform.js"
import { prepareAssets, readFile } from "./assets.js"

const MAP_BASE = [null,
  [127, 178, 56], [247, 233, 163], [199, 199, 199], [255, 0, 0], [160, 160, 255], [167, 167, 167],
  [0, 124, 0], [255, 255, 255], [164, 168, 184], [151, 109, 77], [112, 112, 112], [64, 64, 255],
  [143, 119, 72], [255, 252, 245], [216, 127, 51], [178, 76, 216], [102, 153, 216], [229, 229, 51],
  [127, 204, 25], [242, 127, 165], [76, 76, 76], [153, 153, 153], [76, 127, 153], [127, 63, 178],
  [51, 76, 178], [102, 76, 51], [102, 127, 51], [153, 51, 51], [25, 25, 25], [250, 238, 77],
  [92, 219, 213], [74, 128, 255], [0, 217, 58], [129, 86, 49], [112, 2, 0], [209, 177, 161],
  [159, 82, 36], [149, 87, 108], [112, 108, 138], [186, 133, 36], [103, 117, 53], [160, 77, 78],
  [57, 41, 35], [135, 107, 98], [87, 92, 92], [122, 73, 88], [76, 62, 92], [76, 50, 35],
  [76, 82, 42], [142, 60, 46], [37, 22, 16], [189, 48, 49], [148, 63, 97], [92, 25, 29],
  [22, 126, 134], [58, 142, 140], [86, 44, 62], [20, 180, 133], [100, 100, 100], [216, 175, 147],
  [127, 167, 150]
]
const MAP_SHADE = [180, 220, 255, 135]

export const MAP_COLORS = { base: MAP_BASE, shade: MAP_SHADE }

export function mapIdOf(item) {
  const n = Number(item?.components?.["minecraft:map_id"] ?? item?.tag?.map)
  return Number.isFinite(n) ? n : null
}

export async function renderMapColors(assets, colors) {
  if (colors == null || colors.length < 16384) throw new Error("renderMapColors requires the 16384 map color bytes")
  assets = await prepareAssets(assets)
  const canvas = new Canvas(128, 128)
  const ctx = canvas.getContext("2d")
  try {
    const bytes = await readFile("assets/minecraft/textures/map/map_background.png", assets)
    if (bytes) ctx.drawImage(await loadImage(bytes), 0, 0, 128, 128)
  } catch {}
  const img = ctx.createImageData(128, 128)
  let any = false
  for (let i = 0; i < 16384; i++) {
    const c = colors[i] & 0xff
    const base = MAP_BASE[c >> 2]
    if (!base) continue
    const m = MAP_SHADE[c & 3]
    const o = i * 4
    img.data[o] = base[0] * m / 255 | 0
    img.data[o + 1] = base[1] * m / 255 | 0
    img.data[o + 2] = base[2] * m / 255 | 0
    img.data[o + 3] = 255
    any = true
  }
  if (any) {
    const overlay = new Canvas(128, 128)
    overlay.getContext("2d").putImageData(img, 0, 0)
    ctx.drawImage(overlay, 0, 0)
  }
  return canvas
}

export async function mapArtFor(assets, id, mapArt, info) {
  if (!mapArt) return null
  const cache = id != null && assets.cache ? (assets.cache.maps ??= new Map()) : null
  if (cache?.has(id)) return cache.get(id)
  let art = null
  try {
    const raw = await mapArt(id, info)
    if (raw) {
      const w = raw.width || 128, h = raw.height || 128
      art = new Canvas(w, h)
      art.getContext("2d").drawImage(raw, 0, 0, w, h)
    }
  } catch {}
  if (art) cache?.set(id, art)
  return art
}

export function disposeMapArt(assets) {
  const maps = Array.isArray(assets) ? assets.cache?.maps : null
  if (!maps) return
  maps.clear()
}
