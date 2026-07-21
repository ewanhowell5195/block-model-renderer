import { normalize, matchId, parseJson } from "./platform.js"
import { readFileAll } from "./assets.js"
import baseWaterlogging from "./data/waterlogging.json" with { type: "json" }
import baseCulling from "./data/culling.json" with { type: "json" }
import baseLighting from "./data/lighting.json" with { type: "json" }
import baseColors from "./data/colors.json" with { type: "json" }

const ruleSet = r => ({ suffix: r.suffix ?? [], exact: new Set(r.exact), except: r.except && new Set(r.except) })

const isFluid = id => /(^|_)(water|lava)$/.test(id)
const fluidFamily = id => id.includes("lava") ? "lava" : "water"
const OPPOSITE = { north: "south", south: "north", east: "west", west: "east" }

function ruleValue(rules, block, properties, resolveDefault) {
  if (!block) return null
  const id = normalize(block)
  const entry = rules.find(r => matchId(id, r))?.value
  if (entry == null) return null
  if (typeof entry === "number") return entry
  const value = k => {
    const v = properties?.[k] ?? resolveDefault?.(k)
    return v == null ? null : String(v)
  }
  for (const [match, level] of entry.cases) {
    if (Object.entries(match).every(([k, v]) => value(k) === v)) return level
  }
  return entry.default
}

export function buildBlockRules({ waterlogging = [], culling = [], lighting = [] }) {
  const sources = { waterloggable: waterlogging, waterlogged: waterlogging, nonOccluding: culling, selfCullAll: culling, selfCullY: culling }
  const lists = {}
  for (const [key, layers] of Object.entries(sources)) {
    lists[key] = layers.filter(l => l?.[key]).map(l => ruleSet(l[key]))
  }
  const valued = {}
  for (const key of ["lightEmission", "shapeLightOcclusion"]) {
    valued[key] = lighting.flatMap(l => (l?.[key] ?? []).map(r => ({ value: r.value, ...ruleSet(r) })))
  }
  const matches = (key, id) => lists[key].some(r => matchId(id, r))
  return {
    waterloggable(block) {
      if (!block) return false
      return matches("waterloggable", normalize(block))
    },
    waterlogged(block) {
      if (!block) return false
      return matches("waterlogged", normalize(block))
    },
    canOcclude(block) {
      block = normalize(block)
      return !isFluid(block) && !matches("nonOccluding", block) && !/(^|_)item_frame$/.test(block)
    },
    selfCulls(block, neighbor, direction, properties, neighborProperties) {
      if (!block || !neighbor) return false
      block = normalize(block); neighbor = normalize(neighbor)
      if (isFluid(block) && isFluid(neighbor)) return fluidFamily(block) === fluidFamily(neighbor)
      if (block !== neighbor) return false
      if (matches("selfCullAll", block)) return true
      if (matches("selfCullY", block)) {
        if (direction === "up" || direction === "down") return true
        if (String(properties?.[direction]) === "true" && String(neighborProperties?.[OPPOSITE[direction]]) === "true") return true
      }
      return false
    },
    emission(block, properties, resolveDefault) {
      return ruleValue(valued.lightEmission, block, properties, resolveDefault) ?? 0
    },
    shapeOcclusion(block, properties, resolveDefault) {
      return ruleValue(valued.shapeLightOcclusion, block, properties, resolveDefault) === 1
    }
  }
}

export function buildColorTables(layers) {
  const tables = {}
  for (const key of ["colormap", "fixed", "indexed", "tintindex", "dye", "effects", "potions", "team"]) {
    if (layers.length === 1) {
      tables[key] = layers[0]?.[key] ?? {}
      continue
    }
    tables[key] = {}
    for (let i = layers.length - 1; i >= 0; i--) {
      Object.assign(tables[key], layers[i]?.[key])
    }
  }
  const colormapBlocks = {}
  for (let i = layers.length - 1; i >= 0; i--) {
    for (const [map, blocks] of Object.entries(layers[i]?.colormap ?? {})) {
      for (const block of blocks) colormapBlocks[block] = map
    }
  }
  if (layers.length > 1) {
    for (const [map, blocks] of Object.entries(tables.colormap)) {
      tables.colormap[map] = blocks.filter(b => colormapBlocks[b] === map)
    }
  }
  return {
    tables,
    colormapBlocks,
    potionColor(potionName) {
      const name = normalize(potionName)
      const effects = tables.potions[name]
      if (!effects || effects.length === 0) {
        const direct = tables.effects[name]
        return direct !== undefined ? parseColorHex(direct) : null
      }
      let r = 0, g = 0, b = 0, total = 0
      for (const entry of effects) {
        const [effect, amp] = Array.isArray(entry) ? entry : [entry, 0]
        const hex = tables.effects[effect]
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
  }
}

function parseColorHex(c) {
  if (typeof c === "string" && c.startsWith("#")) return c
  if (typeof c === "string") c = parseInt(c, 16)
  return "#" + (c >>> 0).toString(16).padStart(8, "0").slice(2)
}

async function readLayers(file, assets, base) {
  const layers = []
  for (const buf of await readFileAll(file, assets)) {
    try { layers.push(parseJson(buf)) } catch {}
  }
  layers.push(base)
  return layers
}

export const builtinRules = buildBlockRules({ waterlogging: [baseWaterlogging], culling: [baseCulling], lighting: [baseLighting] })
export const builtinColors = buildColorTables([baseColors])

export async function blockRules(assets) {
  return assets.blockRules ??= (async () => {
    const [waterlogging, culling, lighting] = await Promise.all([
      readLayers("assets/block-model-renderer/waterlogging.json", assets, baseWaterlogging),
      readLayers("assets/block-model-renderer/culling.json", assets, baseCulling),
      readLayers("assets/block-model-renderer/lighting.json", assets, baseLighting)
    ])
    if (waterlogging.length === 1 && culling.length === 1 && lighting.length === 1) return builtinRules
    return buildBlockRules({ waterlogging, culling, lighting })
  })()
}

export async function colorTables(assets) {
  return assets.colorTables ??= (async () => {
    const layers = await readLayers("assets/block-model-renderer/colors.json", assets, baseColors)
    return layers.length === 1 ? builtinColors : buildColorTables(layers)
  })()
}
