import { normalize, matchId } from "./platform.js"
import colorData from "./data/colors.json" with { type: "json" }
import blocks from "./data/blocks.json" with { type: "json" }

export const COLORS = {
  colormap: {
    grass: ["bush", "fern", "grass_block", "large_fern", "pink_petals", "potted_fern", "short_grass", "sugar_cane", "tall_grass", "wildflowers"],
    foliage: ["acacia_leaves", "dark_oak_leaves", "jungle_leaves", "mangrove_leaves", "oak_leaves", "vine"],
    dry_foliage: ["leaf_litter"]
  },
  fixed: {
    water: { blocks: ["bubble_column", "water_cauldron", "water"], color: "#3F76E4" },
    birch_leaves: { color: "#80A755" },
    spruce_leaves: { color: "#619961" },
    lily_pad: { color: "#208030" },
    attached_melon_stem: { color: "#E0C71C" },
    attached_pumpkin_stem: { color: "#E0C71C" }
  },
  indexed: {
    stem: {
      blocks: ["melon_stem", "pumpkin_stem"],
      property: "age",
      default: 7,
      colors: ["#00FF00", "#20F704", "#40EF08", "#60E70C", "#80DF10", "#A0D714", "#C0CF18", "#E0C71C"]
    },
    redstone: {
      blocks: ["redstone_wire"],
      property: "power",
      default: 0,
      colors: ["#4B0000", "#6F0000", "#790000", "#820000", "#8C0000", "#970000", "#A10000", "#AB0000", "#B50000", "#BF0000", "#CA0000", "#D30000", "#DD0000", "#E70600", "#F11B00", "#FC3100"]
    }
  },
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
export const FIXED_TINT_BLOCKS = {}
for (const [key, entry] of Object.entries(COLORS.fixed)) {
  if (entry.blocks) {
    for (const block of entry.blocks) FIXED_TINT_BLOCKS[block] = entry.color
  } else {
    FIXED_TINT_BLOCKS[key] = entry.color
  }
}
export const INDEXED_TINT_BLOCKS = {}
for (const entry of Object.values(COLORS.indexed)) {
  for (const block of entry.blocks) INDEXED_TINT_BLOCKS[block] = entry
}

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
