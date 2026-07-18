import { builtinRules, builtinColors } from "./data.js"

export const COLORS = builtinColors.tables

export const COLORMAP_BLOCKS = builtinColors.colormapBlocks
export const FIXED_TINT_BLOCKS = { ...COLORS.fixed }
export const INDEXED_TINT_BLOCKS = { ...COLORS.indexed }

export function isWaterloggable(block, rules = builtinRules) {
  return rules.waterloggable(block)
}

export function isWaterlogged(block, rules = builtinRules) {
  return rules.waterlogged(block)
}

export function parseColor(c) {
  if (typeof c === "string" && c.startsWith("#")) return c
  if (typeof c === "string") c = parseInt(c, 16)
  return "#" + (c >>> 0).toString(16).padStart(8, "0").slice(2)
}

export function getPotionColor(potionName, colors = builtinColors) {
  return colors.potionColor(potionName)
}
