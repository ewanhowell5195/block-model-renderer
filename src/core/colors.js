import { normalize, matchId } from "./platform.js"

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
  tintindex: {
    pink_petals: 1,
    wildflowers: 1
  },
  dye: {
    black: "#1d1d21",
    blue: "#3c44aa",
    brown: "#835432",
    cyan: "#169c9c",
    gray: "#474f52",
    green: "#5e7c16",
    light_blue: "#3ab3da",
    light_gray: "#9d9d97",
    lime: "#80c71f",
    magenta: "#c74ebd",
    orange: "#f9801d",
    pink: "#f38baa",
    purple: "#8932b8",
    red: "#b02e26",
    white: "#f9fffe",
    yellow: "#fed83d"
  },
  effects: {
    speed: "#33EBFF", slowness: "#8BAFE0", haste: "#D9C043",
    mining_fatigue: "#4A4217", strength: "#FFC700", instant_health: "#F82423",
    instant_damage: "#A9656A", jump_boost: "#FDFF84", nausea: "#551D4A",
    regeneration: "#CD5CAB", resistance: "#9146F0", fire_resistance: "#FF9900",
    water_breathing: "#98DAC0", invisibility: "#F6F6F6", blindness: "#1F1F23",
    night_vision: "#C2FF66", hunger: "#587653", weakness: "#484D48",
    poison: "#87A363", wither: "#736156", health_boost: "#F87D23",
    absorption: "#2552A5", saturation: "#F82423", glowing: "#94A061",
    levitation: "#CEFFFF", luck: "#59C106", unluck: "#C0A44D",
    slow_falling: "#F3CFB9", conduit_power: "#1DC2D1", dolphins_grace: "#88A3BE",
    bad_omen: "#0B6138", hero_of_the_village: "#44FF44", darkness: "#292721",
    trial_omen: "#16A6A6", raid_omen: "#DE4058", wind_charged: "#BDC9FF",
    weaving: "#78695A", oozing: "#99FFA3", infested: "#8C9B8C",
    breath_of_the_nautilus: "#00FFEE"
  },
  potions: {
    long_night_vision: ["night_vision"], long_invisibility: ["invisibility"],
    leaping: ["jump_boost"], long_leaping: ["jump_boost"], strong_leaping: ["jump_boost"],
    long_fire_resistance: ["fire_resistance"],
    swiftness: ["speed"], long_swiftness: ["speed"], strong_swiftness: ["speed"],
    long_slowness: ["slowness"], strong_slowness: ["slowness"],
    turtle_master: [["slowness", 3], ["resistance", 2]],
    long_turtle_master: [["slowness", 3], ["resistance", 2]],
    strong_turtle_master: [["slowness", 5], ["resistance", 3]],
    long_water_breathing: ["water_breathing"],
    healing: ["instant_health"], strong_healing: ["instant_health"],
    harming: ["instant_damage"], strong_harming: ["instant_damage"],
    long_poison: ["poison"], strong_poison: ["poison"],
    long_regeneration: ["regeneration"], strong_regeneration: ["regeneration"],
    long_strength: ["strength"], strong_strength: ["strength"],
    long_weakness: ["weakness"],
    long_slow_falling: ["slow_falling"]
  },
  team: {
    black: "#000000", dark_blue: "#0000AA", dark_green: "#00AA00", dark_aqua: "#00AAAA",
    dark_red: "#AA0000", dark_purple: "#AA00AA", gold: "#FFAA00", gray: "#AAAAAA",
    dark_gray: "#555555", blue: "#5555FF", green: "#55FF55", aqua: "#55FFFF",
    red: "#FF5555", light_purple: "#FF55FF", yellow: "#FFFF55", white: "#FFFFFF"
  }
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

const WATERLOGGABLE_SUFFIXES = [
  "_slab", "_stairs", "_wall", "_trapdoor", "_fence", "_shelf", "_leaves",
  "_bars", "_chain", "_grate", "_golem_statue", "copper_lantern",
  "sign", "candle", "glass_pane", "_coral", "_coral_fan", "_coral_wall_fan",
  "rail", "chest", "lightning_rod",
  "amethyst_bud", "dripleaf", "campfire", "sculk_sensor"
]

const WATERLOGGABLE_EXACT = new Set([
  "amethyst_cluster", "barrier", "big_dripleaf_stem", "conduit", "decorated_pot",
  "dried_ghast", "glow_lichen", "hanging_roots", "heavy_core", "ladder", "lantern",
  "light", "mangrove_propagule", "mangrove_roots", "pointed_dripstone",
  "resin_clump", "scaffolding", "sculk_shrieker", "sculk_vein", "sea_pickle",
  "soul_lantern", "sulfur_spike"
])

export function isWaterloggable(block) {
  if (!block) return false
  return matchId(normalize(block), { exact: WATERLOGGABLE_EXACT, suffix: WATERLOGGABLE_SUFFIXES })
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
