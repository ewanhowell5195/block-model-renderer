import { normalize, matchId } from "./platform.js"

export const COLOURS = {
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
    speed: 3402751, slowness: 9154528, haste: 14270531, mining_fatigue: 4866583,
    strength: 16762624, instant_health: 16262179, instant_damage: 11101546,
    jump_boost: 16646020, nausea: 5578058, regeneration: 13458603,
    resistance: 9520880, fire_resistance: 16750848, water_breathing: 10017472,
    invisibility: 16185078, blindness: 2039587, night_vision: 12779366,
    hunger: 5797459, weakness: 4738376, poison: 8889187, wither: 7561558,
    health_boost: 16284963, absorption: 2445989, saturation: 16262179,
    glowing: 9740385, levitation: 13565951, luck: 5882118, unluck: 12624973,
    slow_falling: 15978425, conduit_power: 1950417, dolphins_grace: 8954814,
    bad_omen: 745784, hero_of_the_village: 4521796, darkness: 2696993,
    trial_omen: 1484454, raid_omen: 14565464, wind_charged: 12438015,
    weaving: 7891290, oozing: 10092451, infested: 9214860,
    breath_of_the_nautilus: 65518
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
    black: 0, dark_blue: 170, dark_green: 43520, dark_aqua: 43690,
    dark_red: 11141120, dark_purple: 11141290, gold: 16755200, gray: 11184810,
    dark_gray: 5592405, blue: 5592575, green: 5635925, aqua: 5636095,
    red: 16733525, light_purple: 16733695, yellow: 16777045, white: 16777215
  }
}

export const COLORMAP_BLOCKS = {}
for (const [map, blocks] of Object.entries(COLOURS.colormap)) {
  for (const block of blocks) COLORMAP_BLOCKS[block] = map
}
export const FIXED_TINT_BLOCKS = {}
for (const [key, entry] of Object.entries(COLOURS.fixed)) {
  if (entry.blocks) {
    for (const block of entry.blocks) FIXED_TINT_BLOCKS[block] = entry.color
  } else {
    FIXED_TINT_BLOCKS[key] = entry.color
  }
}
export const INDEXED_TINT_BLOCKS = {}
for (const entry of Object.values(COLOURS.indexed)) {
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
  const effects = COLOURS.potions[name]
  if (!effects || effects.length === 0) {
    const direct = COLOURS.effects[name]
    return direct !== undefined ? parseColor(direct) : null
  }
  let r = 0, g = 0, b = 0, total = 0
  for (const entry of effects) {
    const [effect, amp] = Array.isArray(entry) ? entry : [entry, 0]
    const color = COLOURS.effects[effect]
    if (color === undefined) continue
    const weight = amp + 1
    r += weight * ((color >> 16) & 0xFF)
    g += weight * ((color >> 8) & 0xFF)
    b += weight * (color & 0xFF)
    total += weight
  }
  if (total === 0) return null
  return "#" + (((Math.round(r / total) << 16) | (Math.round(g / total) << 8) | Math.round(b / total)) >>> 0).toString(16).padStart(6, "0")
}
