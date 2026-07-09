import { normalize, matchId } from "./platform.js"
import colorData from "./data/colors.json" with { type: "json" }
import blocks from "./data/blocks.json" with { type: "json" }

export const COLORS = {
  colormap: {
    grass: ["bush", "fern", "grass_block", "large_fern", "pink_petals", "potted_fern", "short_grass", "sugar_cane", "tall_grass", "wildflowers"],
    foliage: ["acacia_leaves", "dark_oak_leaves", "jungle_leaves", "mangrove_leaves", "oak_leaves", "vine"],
    dry_foliage: ["leaf_litter"]
  },
  fixed: colorData.fixed,
  indexed: colorData.indexed,
  tintindex: colorData.tintindex,
  dye: colorData.dye,
  effects: colorData.effects,
  potions: colorData.potions,
  team: colorData.team
}

export const COLORMAP_BLOCKS = {}
for (const [map, blocks] of Object.entries(COLORS.colormap)) {
  for (const block of blocks) COLORMAP_BLOCKS[block] = map
}
export const FIXED_TINT_BLOCKS = { ...COLORS.fixed }
export const INDEXED_TINT_BLOCKS = { ...COLORS.indexed }

const WATERLOGGABLE = {
  suffix: blocks.waterloggable.suffix,
  exact: new Set(blocks.waterloggable.exact),
  except: blocks.waterloggable.except && new Set(blocks.waterloggable.except)
}

export function isWaterloggable(block) {
  if (!block) return false
  return matchId(normalize(block), WATERLOGGABLE)
}

export function parseColor(c) {
  if (typeof c === "string" && c.startsWith("#")) return c
  if (typeof c === "string") c = parseInt(c, 16)
  return "#" + (c >>> 0).toString(16).padStart(8, "0").slice(2)
}

export function getPotionColor(potionName) {
  const name = normalize(potionName)
  const effects = COLORS.potions[name]
  if (!effects || effects.length === 0) {
    const direct = COLORS.effects[name]
    return direct !== undefined ? parseColor(direct) : null
  }
  let r = 0, g = 0, b = 0, total = 0
  for (const entry of effects) {
    const [effect, amp] = Array.isArray(entry) ? entry : [entry, 0]
    const hex = COLORS.effects[effect]
    if (hex === undefined) continue
    const color = parseInt(hex.slice(1), 16)
    const weight = amp + 1
    r += weight * ((color >> 16) & 0xFF)
    g += weight * ((color >> 8) & 0xFF)
    b += weight * (color & 0xFF)
    total += weight
  }
  if (total === 0) return null
  return "#" + (((Math.round(r / total) << 16) | (Math.round(g / total) << 8) | Math.round(b / total)) >>> 0).toString(16).padStart(6, "0")
}
