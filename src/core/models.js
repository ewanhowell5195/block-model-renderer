import { THREE, Canvas, loadImage, loadTexture, AXIS_VECTORS, UV_CENTER, parseJson, normalize, resolveNamespace, isBefore } from "./platform.js"
import { COLORS, COLORMAP_BLOCKS, FIXED_TINT_BLOCKS, INDEXED_TINT_BLOCKS, isWaterloggable, isWaterlogged, parseColor, getPotionColor } from "./colors.js"
import { getLightEmission } from "./emission.js"
import { fluidHeights } from "./fluids.js"
import { prepareAssets, readFile, readFileAll, getMissingImage, getAtlasesContaining } from "./assets.js"
import { buildAnimation } from "./animation.js"
import { modelLoaders, activeLoaders } from "./loaders.js"

const LEGACY_ITEM_PROPS = { holder_type: "context_entity_type", shift_down: "extended_view" }

export const AIR_BLOCKS = /(^|:)(air|cave_air|void_air)$/

const X_CYCLE = { north: "up", up: "south", south: "down", down: "north" }
const Y_CYCLE = { north: "east", east: "south", south: "west", west: "north" }

const CULL_VECS = {
  east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
  south: [0, 0, 1], north: [0, 0, -1], top: [0, 1, 0], bottom: [0, -1, 0]
}

const SHADE_DIR_VECS = {
  east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
  south: [0, 0, 1], north: [0, 0, -1]
}

const NAMED_TIMES = { day: 1000, noon: 6000, sunset: 12000, night: 13000, midnight: 18000, sunrise: 23000 }

function parseDaytime(v) {
  if (v == null) return NAMED_TIMES.noon
  if (typeof v === "number") return ((v % 24000) + 24000) % 24000
  return NAMED_TIMES[String(v).toLowerCase()] ?? NAMED_TIMES.noon
}

function parseTransformation(t) {
  if (!t) return null
  if (Array.isArray(t)) {
    return new THREE.Matrix4().fromArray(t)
  }
  const mat = new THREE.Matrix4()
  const [tx, ty, tz] = t.translation || [0, 0, 0]
  const T = new THREE.Matrix4().makeTranslation(tx * 16, ty * 16, tz * 16)
  const L = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...(t.left_rotation || [0, 0, 0, 1])))
  const rawScale = t.scale || [1, 1, 1]
  const S = new THREE.Matrix4().makeScale(...rawScale.map(s => s === 0 ? 0.001 : s))
  const R = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...(t.right_rotation || [0, 0, 0, 1])))
  mat.multiply(T).multiply(L).multiply(S).multiply(R)
  return mat
}

function composeTransformations(parent, child) {
  if (!parent && !child) return null
  if (!parent) return child
  if (!child) return parent
  return new THREE.Matrix4().copy(parent).multiply(child)
}

export async function defaultBlockstates(assets) {
  return assets.defaultBlockstates ??= (async () => {
    const properties = {}
    const rules = []
    for (const buf of await readFileAll("assets/block-model-renderer/default_blockstates.json", assets)) {
      let json
      try { json = parseJson(buf) } catch { continue }
      for (const [key, value] of Object.entries(json.properties ?? {})) {
        if (!(key in properties)) properties[key] = value
      }
      for (const rule of json.blocks ?? []) {
        if (!rule?.match || !rule.defaults) continue
        rules.push({
          patterns: rule.match.split("|").map(pattern => new RegExp("^" + pattern.replace(/\*/g, ".*") + "$")),
          value: rule.defaults
        })
      }
    }
    const matched = new Map()
    function unique(block) {
      let hit = matched.get(block)
      if (hit === undefined) {
        hit = rules.find(rule => rule.patterns.some(regex => regex.test(block)))?.value ?? {}
        matched.set(block, hit)
      }
      return hit
    }
    return { properties, unique }
  })()
}

function getMultipartDefaults(multipart) {
  const first = {}
  function walk(when) {
    if (!when) return
    if (when.OR)  { walk(when.OR[0]); return }
    if (when.AND) { for (const s of when.AND) walk(s); return }
    for (const [k, v] of Object.entries(when)) {
      if (!(k in first)) first[k] = String(v).split("|")[0]
    }
  }
  for (const part of multipart) walk(part.when)
  return first
}

function seededRandom(seed) {
  let a = seed | 0
  return () => {
    a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function pickWeighted(value, rand) {
  if (!Array.isArray(value)) return value
  if (!rand || value.length <= 1) return value[0]
  let total = 0
  for (const entry of value) total += entry.weight ?? 1
  let r = rand() * total
  for (const entry of value) {
    r -= entry.weight ?? 1
    if (r < 0) return entry
  }
  return value[value.length - 1]
}

export async function parseBlockstate(assets, blockstate, args) {
  if (!blockstate) throw new Error("parseBlockstate requires a blockstate id")
  if (AIR_BLOCKS.test(blockstate)) return []
  if (assets == null || assets.length === 0) throw new Error("parseBlockstate requires assets")
  const data = args?.data ?? {}
  const rand = args?.seed != null ? seededRandom(args.seed) : null
  assets = await prepareAssets(assets, args?.version ? { version: args.version } : undefined)
  const defaults = await defaultBlockstates(assets)

  const { namespace, item: block } = resolveNamespace(blockstate)

  const buf = await readFile(`assets/${namespace}/blockstates/${block}.json`, assets)

  if (!buf) {
    if (isWaterlogged(block)) return [waterPart()]
    const m = { type: "block", model: "block-model-renderer:missing" }
    if (args?.ignoreAtlases) m.ignore_atlas_restrictions = true
    if (args?.version) m.version = args.version
    return [m]
  }

  const json = parseJson(buf)

  const models = []

  if (json.variants) {
    const variants = Object.entries(json.variants)

    const scored = variants.map(([key, value]) => {
      let score = 0
      if (key === "") {
        score = 0.1
      } else {
        const parts = key.split(",").map(s => s.trim())
        score = parts.reduce((acc, part) => {
          const [k, v] = part.split("=")
          const raw = data[k] ?? defaults.unique(blockstate)[k] ?? defaults.properties[k]
          const actuals = Array.isArray(raw) ? raw.map(e => e.toString()) : [raw?.toString()]
          const index = actuals.indexOf(v)
          if (index === -1) return acc
          return acc + (actuals.length - index)
        }, 0)
      }

      return { score, value }
    }).filter(e => Array.isArray(e.value) ? e.value.length : e.value)

    if (scored.length > 0) {
      scored.sort((a, b) => b.score - a.score)
      models.push(pickWeighted(scored[0].value, rand))
    }
  } else if (json.multipart) {
    const ranges = new Set
    const multipartDefaults = getMultipartDefaults(json.multipart)

    const scoredParts = json.multipart.map((part, index) => {
      const when = part.when
      if (!when) return { score: 0, values: [], part, index, match: true }

      const conds = when.OR ?? when.AND ?? [when]
      const isOr = !!when.OR

      let score = 0
      let match = isOr ? false : true

      const values = {}

      for (const cond of conds) {
        const matches = Object.entries(cond).every(([k, v]) => {
          const allowed = v.toString().split("|")
          const raw = data[k] ?? defaults.unique(blockstate)[k] ?? defaults.properties[k] ?? multipartDefaults[k]
          let actuals
          if (Array.isArray(raw)) {
            actuals = raw.map(e => e.toString())
            ranges.add(k)
          } else {
            actuals = [raw?.toString()]
          }
          const matchIndex = actuals.findIndex(val => allowed.includes(val ?? "none"))
          if (matchIndex !== -1) score += actuals.length - matchIndex
          return matchIndex !== -1
        })

        if (matches) {
          for (const key in cond) {
            values[key] = cond[key]
          }
        }

        if (isOr && matches) {
          match = true
          break
        }
        if (!isOr && !matches) {
          match = false
          break
        }
      }

      return { score, values: Object.entries(values), part, index, match }
    }).filter(p => p.match)

    const usedKeyValues = {}

    scoredParts
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .forEach(({ values, part }) => {
        if (values.some(([k, v]) => usedKeyValues[k] && usedKeyValues[k] !== v)) return
        for (const [key, value] of values) {
          if (ranges.has(key)) {
            usedKeyValues[key] = value
          }
        }
        const apply = pickWeighted(part.apply, rand)
        if (apply?.model) models.push(apply)
      })
  }

  for (const model of models) {
    if (args?.version && isBefore(args.version, "1.21.11")) delete model.z
    if (json.allow_invalid_rotations) {
      model.allow_invalid_rotations = true
    } else if (model.x && model.x % 90 !== 0 || model.y && model.y % 90 !== 0 || model.z && model.z % 90 !== 0) {
      return ["block-model-renderer:missing.json"]
    }

    model.type = "block"
    if (args?.ignoreAtlases) model.ignore_atlas_restrictions = true
    if (args?.version) model.version = args.version
    if (args?.version && isBefore(args.version, "1.13")) {
      const i = model.model.indexOf(":") + 1
      if (!model.model.slice(i).includes("/")) {
        model.model = model.model.slice(0, i) + "block/" + model.model.slice(i)
      }
    }

    if (COLORMAP_BLOCKS[block]) {
      const tint = await getBiomeTint(assets, COLORMAP_BLOCKS[block], args?.biome)
      const index = COLORS.tintindex[block] ?? 0
      model.tints = []
      for (let t = 0; t <= index; t++) model.tints.push(t === index ? tint : "#FFFFFF")
    } else if (FIXED_TINT_BLOCKS[block]) {
      model.tints = [FIXED_TINT_BLOCKS[block]]
    } else if (INDEXED_TINT_BLOCKS[block]) {
      const entry = INDEXED_TINT_BLOCKS[block]
      model.tints = [entry.colors[data[entry.property]] ?? entry.colors[entry.default]]
    }

    if (block === "end_portal" || block == "end_gateway") {
      model.shader = {
        type: "end_portal",
        layers: block === "end_portal" ? 15 : 16
      }
    }

    if (block === "water" || block === "flowing_water") model.fluid = "water"
    else if (block === "lava" || block === "flowing_lava") model.fluid = "lava"
  }

  if (((data?.waterlogged === true || data?.waterlogged === "true") && isWaterloggable(block)) || isWaterlogged(block)) {
    models.push(waterPart())
  }

  return models
}

function waterPart() {
  return {
    model: "minecraft:block/water",
    type: "block",
    fluid: "water",
    tints: ["#3F76E4"],
    scale: [0.999, 0.999, 0.999]
  }
}

export async function getBiomeTint(assets, mapName, biome) {
  const entries = biome == null ? [{}] : Array.isArray(biome) ? biome : [biome]
  if (!entries.length) entries.push({})
  const toInt = t => typeof t === "number" ? t : parseInt(String(t).replace("#", ""), 16)
  let r = 0, g = 0, b = 0, total = 0
  for (const entry of entries) {
    let v
    if (entry.tint !== undefined && !entry.combine) {
      v = toInt(entry.tint)
    } else {
      const hex = await getColorMapTint(assets, mapName, entry.temperature ?? 0.5, entry.downfall ?? 1)
      v = parseInt(hex.slice(1), 16)
      if (entry.tint !== undefined) v = ((v & 0xFEFEFE) + toInt(entry.tint)) >> 1
    }
    const w = entry.weight ?? 1
    r += ((v >> 16) & 255) * w
    g += ((v >> 8) & 255) * w
    b += (v & 255) * w
    total += w
  }
  const c = (Math.round(r / total) << 16 | Math.round(g / total) << 8 | Math.round(b / total)) >>> 0
  return "#" + c.toString(16).padStart(6, "0").toUpperCase()
}

async function getColorMapTint(assets, mapName, temperature, downfall) {
  if (isNaN(temperature) || isNaN(downfall)) return "#FF00FF"
  temperature = Math.min(1, Math.max(0, temperature))
  downfall = Math.min(1, Math.max(0, downfall))

  const buf = await readFile(`assets/minecraft/textures/colormap/${mapName}.png`, assets)
  if (!buf) return "#FFFFFF"

  const image = await loadImage(buf)
  const canvas = new Canvas(256, 256)
  const ctx = canvas.getContext("2d", { willReadFrequently: true })

  if (image.width !== 256 || image.height !== 256) return "#FF00FF"
  ctx.drawImage(image, 0, 0)

  const x = Math.round((1 - temperature) * 255)
  const y = Math.round((1 - downfall * temperature) * 255)

  if (x < 0 || x > 255 || y < 0 || y > 255) return "#FF00FF"

  const { data } = ctx.getImageData(x, y, 1, 1)
  const [r, g, b] = data
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase()
}

export async function parseItemDefinition(assets, itemId, args) {
  if (!itemId) throw new Error("parseItemDefinition requires an item id")
  if (assets == null || assets.length === 0) throw new Error("parseItemDefinition requires assets")
  const data = { ...(args?.data ?? {}) }
  if (data.custom_model_data != null && typeof data.custom_model_data !== "object") {
    data.custom_model_data = { floats: [Number(data.custom_model_data)] }
  }
  if (data.dyed_color != null && typeof data.dyed_color === "object" && "rgb" in data.dyed_color) {
    data.dyed_color = data.dyed_color.rgb
  }
  const display = args?.display ?? "gui"
  assets = await prepareAssets(assets, args?.version ? { version: args.version } : undefined)

  const { namespace, item } = resolveNamespace(itemId)

  const buf = await readFile(`assets/${namespace}/items/${item}.json`, assets)

  if (!buf) {
    const legacy = (!args?.version || isBefore(args.version, "1.21.4")) && await readFile(`assets/${namespace}/models/item/${item}.json`, assets)
    const m = { type: "item", model: legacy ? `${namespace}:item/${item}` : "block-model-renderer:missing" }
    if (args?.ignoreAtlases) m.ignore_atlas_restrictions = true
    if (args?.version) m.version = args.version
    return [m]
  }

  const json = parseJson(buf)

  const normalizedData = {}
  for (const key in data) normalizedData[normalize(key)] = data[key]
  const models = await resolveItemModel(assets, json.model, normalizedData, display, undefined, args?.version)
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    model.type = "item"
    if (args?.ignoreAtlases) model.ignore_atlas_restrictions = true
    if (args?.version) model.version = args.version
    if (model.tints) {
      const tints = []
      for (const tint of model.tints) {
        if (typeof tint === "string") {
          tints.push(tint)
          continue
        }
        const type = normalize(tint.type)
        if (type === "team" && normalizedData["team"] !== undefined) {
          const teamColor = COLORS.team[normalize(normalizedData["team"])]
          tints.push(teamColor !== undefined ? parseColor(teamColor) : parseColor(tint.default ?? 16777215))
        } else if (type === "dye" && normalizedData["dyed_color"] !== undefined) {
          tints.push(parseColor(normalizedData["dyed_color"]))
        } else if (type === "map_color" && normalizedData["map_color"] !== undefined) {
          tints.push(parseColor(normalizedData["map_color"]))
        } else if (type === "potion" && normalizedData["potion_contents"]?.potion) {
          const color = getPotionColor(normalizedData["potion_contents"].potion)
          tints.push(color ?? parseColor(tint.default ?? -13083194))
        } else if (type === "custom_model_data" && normalizedData["custom_model_data"]?.colors) {
          const c = normalizedData["custom_model_data"].colors[tint.index ?? 0]
          if (c !== undefined) {
            tints.push(parseColor(c))
          } else {
            tints.push(tint.default !== undefined ? parseColor(tint.default) : "#FFFFFF")
          }
        } else if (type === "firework" && normalizedData["firework_explosion"]?.colors?.length) {
          const colors = normalizedData["firework_explosion"].colors.map(c => {
            const hex = parseColor(c)
            const v = parseInt(hex.slice(1), 16)
            return [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]
          })
          const r = Math.round(colors.reduce((s, c) => s + c[0], 0) / colors.length)
          const g = Math.round(colors.reduce((s, c) => s + c[1], 0) / colors.length)
          const b = Math.round(colors.reduce((s, c) => s + c[2], 0) / colors.length)
          tints.push("#" + ((r << 16 | g << 8 | b) >>> 0).toString(16).padStart(6, "0"))
        } else if (type === "grass" || type === "foliage" || type === "dry_foliage") {
          tints.push(await getColorMapTint(assets, type, tint.temperature, tint.downfall))
        } else if (tint.value !== undefined || tint.default !== undefined) {
          const color = tint.value ?? tint.default
          if (Array.isArray(color)) {
            tints.push("#" + color.map(c => Math.round(c * 255).toString(16).padStart(2, "0")).join(""))
          } else {
            tints.push(parseColor(color))
          }
        } else {
          tints.push("#FFFFFF")
        }
      }
      model.tints = tints
    } else if (Object.keys(model).length === 1) {
      models[i] = model.model
    }
  }
  return models
}

async function resolveItemModel(assets, def, data, display, accTransform, version) {
  while (def) {
    const type = normalize(def.type)
    const currentTransform = composeTransformations(accTransform, parseTransformation(def.transformation))

    if (type === "special") {
      const model = {
        model: def.base
      }
      model.special = def.model
      model.special.type = normalize(model.special.type)
      if (currentTransform) model.transformation = currentTransform.elements
      return [model]
    }

    if (type === "composite") {
      const result = []
      for (const model of def.models) {
        const nested = await resolveItemModel(assets, model, data, display, currentTransform, version)
        result.push(...nested)
      }
      return result
    }

    if (type === "select") {
      const prop = (version ? null : LEGACY_ITEM_PROPS[normalize(def.property)]) ?? normalize(def.property)
      let raw
      if (prop === "custom_model_data") raw = data["custom_model_data"]?.strings?.[def.index ?? 0]
      else if (prop === "component") raw = data[normalize(def.component)]
      else if (prop === "block_state") raw = data.block_state?.[def.block_state_property]
      else if (prop === "charge") {
        const projectiles = data.charged_projectiles ?? []
        if (!projectiles.length) raw = "none"
        else if (projectiles.some(p => normalize(typeof p === "string" ? p : p?.id ?? "") === "firework_rocket")) raw = "rocket"
        else raw = "arrow"
      }
      else if (prop === "trim_material") raw = data.trim?.material ?? data.trim_material
      else raw = data[prop]
      let value = normalize(raw ?? "")
      if (!value && prop === "display_context") {
        value = typeof display === "string" ? display : display.display
      } else if (!value && prop === "local_time" && def.pattern) {
        const now = new Date()
        const pad = n => String(n).padStart(2, "0")
        value = def.pattern.replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|EE|E|HH|H|hh|h|mm|m|ss|s|a|Z|z|w|W|D|u|G/g, m => {
          switch (m) {
            case "yyyy": return now.getFullYear()
            case "yy": return String(now.getFullYear()).slice(-2)
            case "MMMM": return now.toLocaleString("en", { month: "long" })
            case "MMM": return now.toLocaleString("en", { month: "short" })
            case "MM": return pad(now.getMonth() + 1)
            case "M": return now.getMonth() + 1
            case "dd": return pad(now.getDate())
            case "d": return now.getDate()
            case "EEEE": return now.toLocaleString("en", { weekday: "long" })
            case "EEE": case "EE": case "E": return now.toLocaleString("en", { weekday: "short" })
            case "HH": return pad(now.getHours())
            case "H": return now.getHours()
            case "hh": return pad(now.getHours() % 12 || 12)
            case "h": return now.getHours() % 12 || 12
            case "mm": return pad(now.getMinutes())
            case "m": return now.getMinutes()
            case "ss": return pad(now.getSeconds())
            case "s": return now.getSeconds()
            case "a": return now.getHours() < 12 ? "AM" : "PM"
            case "Z": case "z": { const o = -now.getTimezoneOffset(); return (o >= 0 ? "+" : "-") + pad(Math.floor(Math.abs(o) / 60)) + pad(Math.abs(o) % 60) }
            case "w": { const d = new Date(now.getFullYear(), 0, 1); return Math.ceil(((now - d) / 86400000 + d.getDay() + 1) / 7) }
            case "W": return Math.ceil(now.getDate() / 7)
            case "D": return Math.ceil((now - new Date(now.getFullYear(), 0, 1)) / 86400000) + 1
            case "u": return now.getDay() || 7
            case "G": return "AD"
            default: return m
          }
        })
      }
      const matched = def.cases.find(c => {
        const when = c.when
        if (Array.isArray(when)) return when.map(normalize).includes(value)
        return normalize(when) === value
      })
      def = matched?.model || def.fallback
      accTransform = currentTransform
      continue
    }

    if (type === "condition") {
      const prop = (version ? null : LEGACY_ITEM_PROPS[normalize(def.property)]) ?? normalize(def.property)
      let isTruthy
      if (prop === "custom_model_data") {
        const v = data["custom_model_data"]?.flags?.[def.index ?? 0]
        isTruthy = v === true || v === "true"
      } else if (prop === "has_component") {
        const component = normalize(def.component ?? "")
        isTruthy = component in data && data[component] !== undefined && data[component] !== null
      } else {
        const v = normalize(data[prop])
        isTruthy = v === true || v === "true"
      }
      def = isTruthy ? def.on_true : def.on_false
      accTransform = currentTransform
      continue
    }

    if (type === "range_dispatch") {
      const prop = (version ? null : LEGACY_ITEM_PROPS[normalize(def.property)]) ?? normalize(def.property)
      const defaultValue = prop === "count" ? 1 : 0
      const num = parseFloat(prop === "custom_model_data" ? data["custom_model_data"]?.floats?.[def.index ?? 0] ?? defaultValue : data[prop] ?? defaultValue)
      const scaled = (def.scale ?? 1) * num
      const entries = def.entries || []
      let chosen = def.fallback
      for (const entry of entries) {
        if (scaled >= entry.threshold) chosen = entry.model
      }
      def = chosen
      accTransform = currentTransform
      continue
    }

    if (type === "model") {
      if (currentTransform) def = { ...def, transformation: currentTransform.elements }
      return [def]
    }

    if (type === "bundle/selected_item") {
      const selectedItem = data["bundle/selected_item"]
      if (!selectedItem) return []
      return await parseItemDefinition(assets, selectedItem, { display })
    }

    return []
  }
  return []
}

async function loadMinecraftTexture(path, assets, type) {
  if (type === "block" || type === "item") {
    const atlases = await getAtlasesContaining(path, assets)
    const allowed = type === "block" ? ["blocks"] : ["blocks", "items"]
    if (!allowed.some(a => atlases.has(a))) return { image: await getMissingImage(assets) }
  }

  const buf = await readFile(path, assets)
  if (!buf) return { image: await getMissingImage(assets) }

  const image = await loadImage(buf)

  let meta
  try {
    meta = parseJson(await readFile(path + ".mcmeta", assets, buf.hintIndex)).animation ?? {}
  } catch {
    return { image }
  }

  return buildAnimation(image, meta)
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

function imageIsTranslucent(img, cutoff) {
  const min = cutoff?.min ?? 5
  const max = cutoff?.max ?? 240
  const canvas = new Canvas(img.width, img.height)
  const ctx = canvas.getContext("2d")
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, img.width, img.height).data
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > min && data[i] < max) return true
  }
  return false
}

export function isCrossModel(models) {
  const elements = (Array.isArray(models) ? models : [models]).flatMap(m => m?.elements ?? [])
  return elements.length > 0 && elements.every(el => {
    const r = el.rotation
    if (!r) return false
    const y = r.axis ? (r.axis === "y" ? r.angle : null) : (r.x || r.z ? null : r.y ?? null)
    return y != null && (((y % 90) + 90) % 90) === 45
  })
}

export async function resolveModelData(assets, model) {
  if (model == null) throw new Error("resolveModelData requires a model")
  if (assets == null || assets.length === 0) throw new Error("resolveModelData requires assets")
  assets = await prepareAssets(assets)

  const modelCache = assets.cache?.models
  const cacheKey = modelCache ? (typeof model === "string" ? model : JSON.stringify(model)) : null
  if (cacheKey && modelCache.has(cacheKey)) return structuredClone(modelCache.get(cacheKey))

  let merged = {}

  let type
  if (typeof model === "object") {
    merged = structuredClone(model)
    model = model.model
  }

  let currentNamespace, currentItem
  if (typeof model === "object") {
    currentItem = model
  } else {
    ({ namespace: currentNamespace, item: currentItem } = resolveNamespace(model))
  }

  let stack = []
  let currentPath

  try {
    if (!merged.allow_invalid_rotations && (merged.x && merged.x % 90 !== 0 || merged.y && merged.y % 90 !== 0 || merged.z && merged.z % 90 !== 0)) {
      delete merged.x
      delete merged.y
      delete merged.z
      throw new Error
    }
    while (true) {
      let json
      if (typeof currentItem === "object") {
        json = currentItem
      } else {
        const buf = await readFile(`assets/${currentNamespace}/models/${currentItem}.json`, assets)

        const sourceEntry = assets[buf.hintIndex]
        if (sourceEntry?.bundledOverrides) {
          merged.overridden = true
        }

        json = parseJson(buf)
      }

      stack.push(json)

      if (!json.parent || json.parent.startsWith("builtin")) break

      const parentId = json.parent.replace(/^minecraft:/, "")
      const resolved = resolveNamespace(parentId)
      currentNamespace = resolved.namespace
      currentItem = resolved.item
    }
  } catch {
    stack = [parseJson(await readFile("assets/block-model-renderer/models/missing.json", assets))]
    merged.model = "block-model-renderer:missing.json"
  }

  if (merged.special) {
    const resolved = await resolveSpecialModel(assets, merged.special, merged.model)
    if (resolved) {
      stack.push(resolved.model)
      if (resolved.rotation) {
        merged.x = resolved.rotation[0]
        merged.y = resolved.rotation[1]
        merged.z = resolved.rotation[2]
      }
      if (resolved.translation) {
        merged.translation = resolved.translation
      }
      if (resolved.scale) {
        merged.scale = resolved.scale
      }
    }
    delete merged.special
  }

  const collected = new Map()
  for (const layer of stack) {
    for (const key in layer) {
      let values = collected.get(key)
      if (!values) collected.set(key, values = [])
      values.push(layer[key])
    }
  }

  const modelType = merged.type ?? collected.get("type")?.find(v => v)
  const loaderOwned = new Set()
  for (const [key, values] of collected) {
    let value
    for (const loader of activeLoaders()) {
      value = await loader.mergeKey?.(key, values, merged, stack)
      if (value !== undefined) break
    }
    if (value !== undefined) {
      merged[key] = value
      loaderOwned.add(key)
    } else if (key === "textures") {
      merged.textures ??= {}
      for (const layerTextures of values) {
        for (const [slot, tex] of Object.entries(layerTextures)) {
          if (!(slot in merged.textures)) {
            merged.textures[slot] = tex
          }
        }
      }
    } else if (key === "display") {
      if (modelType === "block") continue
      merged.display ??= {}
      for (const layerDisplay of values) {
        for (const [slot, entry] of Object.entries(layerDisplay)) {
          if (!(slot in merged.display)) {
            merged.display[slot] = entry
          }
        }
      }
    } else if (!merged[key]) {
      merged[key] = values.find(v => v) ?? values[values.length - 1]
    }
  }

  function handleNestedTexture(key) {
    const v = merged.textures[key]
    if (v == null || typeof v === "string") return
    merged.textures[key] = v.sprite
    if (!merged.textures[key] || merged.textures[key].startsWith("#")) {
      delete merged.textures[key]
    }
  }

  for (const key in merged.textures) {
    handleNestedTexture(key)
    let value = merged.textures[key]
    while (value?.startsWith("#")) {
      const ref = value.slice(1)
      handleNestedTexture(ref)
      if (value === merged.textures[key]) {
        delete merged.textures[key]
        break
      }
      value = merged.textures[ref]
    }
    merged.textures[key] = value

    if (!merged.textures[key]) {
      delete merged.textures[key]
    }
  }

  if (merged.display) {
    convertLegacyDisplay(merged)
  }

  if (normalize(stack[stack.length - 1].parent) === "builtin/generated") {
    if (!merged.gui_light) {
      merged.gui_light = "front"
    }

    if (!merged.elements) {
      merged.generated = true
      merged.elements = []
      for (const [key, texRef] of Object.entries(merged.textures)) {
        const match = key.match(/^layer(\d+)$/)
        if (match) {
          const tintIndex = Number(match[1])
          const texId = "#" + key
          const { namespace, item } = resolveNamespace(texRef)
          const loaded = await loadMinecraftTexture(`assets/${namespace}/textures/${item}.png`, assets)
          const image = loaded.image
          const width = image.width
          const height = image.height
          const depth = 16 / Math.max(width, height)
          const sourceFrames = loaded.frames ?? [image]
          const probe = new Canvas(width, height)
          const pctx = probe.getContext("2d", { willReadFrequently: true })
          const frameMasks = sourceFrames.map(frame => {
            pctx.clearRect(0, 0, width, height)
            pctx.drawImage(frame, 0, 0, width, height)
            const fdata = pctx.getImageData(0, 0, width, height).data
            const mask = new Uint8Array(width * height)
            for (let p = 0; p < width * height; p++) {
              if (fdata[p * 4 + 3] >= 1) mask[p] = 1
            }
            return mask
          })

          function isOpaque(mask, x, y) {
            if (x < 0 || x >= width || y < 0 || y >= height) return
            return mask[y * width + x] === 1
          }

          function isEdge(x, y, dx, dy) {
            return frameMasks.some(mask => isOpaque(mask, x, y) && !isOpaque(mask, x + dx, y + dy))
          }

          merged.elements.push({
            from: [0, 16 - height * depth, 8 - depth / 2],
            to: [width * depth, 16, 8 + depth / 2],
            faces: {
              north: { texture: texId, uv: [16, 0, 0, 16], tintindex: tintIndex },
              south: { texture: texId, uv: [0, 0, 16, 16], tintindex: tintIndex }
            }
          })

          const addRun = (face, x1, y1, x2, y2, u1, v1, u2, v2) => merged.elements.push({
            from: [x1, y1, 8 - depth / 2],
            to: [x2, y2, 8 + depth / 2],
            faces: { [face]: { texture: texId, uv: [u1, v1, u2, v2], tintindex: tintIndex } }
          })

          for (let y = 0; y < height; y++) {
            for (const [face, dy] of [["up", -1], ["down", 1]]) {
              let start = -1
              for (let x = 0; x <= width; x++) {
                const edge = x < width && isEdge(x, y, 0, dy)
                if (edge && start === -1) start = x
                else if (!edge && start !== -1) {
                  addRun(face, start * depth, 16 - (y + 1) * depth, x * depth, 16 - y * depth,
                    start / width * 16, y / height * 16, x / width * 16, (y + 1) / height * 16)
                  start = -1
                }
              }
            }
          }

          for (let x = 0; x < width; x++) {
            for (const [face, dx] of [["west", -1], ["east", 1]]) {
              let start = -1
              for (let y = 0; y <= height; y++) {
                const edge = y < height && isEdge(x, y, dx, 0)
                if (edge && start === -1) start = y
                else if (!edge && start !== -1) {
                  addRun(face, x * depth, 16 - y * depth, (x + 1) * depth, 16 - start * depth,
                    x / width * 16, start / height * 16, (x + 1) / width * 16, y / height * 16)
                  start = -1
                }
              }
            }
          }
        }
      }
    }
  }

  if (!loaderOwned.has("parent")) delete merged.parent
  if (!loaderOwned.has("model")) delete merged.model
  if (merged.type === "block") delete merged.display

  if (cacheKey) modelCache.set(cacheKey, structuredClone(merged))
  return merged
}

async function resolveSpecialModel(assets, data, base) {
  const originalType = data.type

  if (data.type === "head") {
    data.type = `${data.kind}_${data.kind.includes("skeleton") ? "skull" : "head"}`
  }

  let modelPath
  if (originalType === "chest" && data.chest_type && data.chest_type !== "single") {
    modelPath = `block-model-renderer:block/chest/_template_chest_${data.chest_type}`
  } else if (originalType === "copper_golem_statue" && data.pose && data.pose !== "standing") {
    modelPath = `block-model-renderer:block/copper_golem_statue/_template_copper_golem_statue_${data.pose}`
  } else {
    const baseItem = base ? resolveNamespace(base).item : null
    if (baseItem && await readFile(`assets/block-model-renderer/models/${baseItem}.json`, assets)) {
      modelPath = `block-model-renderer:${baseItem}`
    } else if (await readFile(`assets/block-model-renderer/models/item/${data.type}.json`, assets)) {
      modelPath = `block-model-renderer:item/${data.type}`
    } else {
      return
    }
  }

  const model = await resolveModelData(assets, modelPath)
  let translation, rotation, scale

  switch (originalType) {
    case "banner":
      translation = [-8, -20, -8]
      rotation = [0, 0, 180]
      scale = [1.5, 1.5, 1.5]
      model.tints = [COLORS.dye[data.color]]
      break
    case "chest": {
      rotation = [0, 180, 0]
      const chestType = data.chest_type ?? "single"
      const suffix = chestType !== "single" ? `_${chestType}` : ""
      model.textures = { chest: `entity/chest/${normalize(data.texture)}${suffix}` }
      if (data.openness) {
        const lidAngle = data.openness * 90
        for (const el of model.elements ?? []) {
          if (el.type === "lid") el.rotation.angle = lidAngle
        }
      }
      break
    }
    case "shulker_box":
      translation = [-8, 8, -8]
      rotation = [0, 0, 180]
      model.textures = { shulker_box: `entity/shulker/${normalize(data.texture)}` }
      if (data.openness) {
        const lift = data.openness * 8
        for (const el of model.elements ?? []) {
          if (el.type === "lid") {
            el.from = [el.from[0], el.from[1] + lift, el.from[2]]
            el.to = [el.to[0], el.to[1] + lift, el.to[2]]
            el.rotation.angle = data.openness * 270
          }
        }
      }
      break
    case "end_cube":
      model.shader = { type: "end_portal", layers: data.effect === "gateway" ? 16 : 15 }
      break
    case "copper_golem_statue":
      translation = [0, 8, -16]
      model.textures = { golem: `${normalize(data.texture).slice(9).slice(0, -4)}` }
      break
    case "conduit":
      translation = [-8, -8, -8]
      rotation = [0, 180, 0]
      break
    case "head":
    case "player_head":
      translation = [-8, -16, -8]
      rotation = [0, 0, 180]
      break
    case "decorated_pot":
      rotation = [0, 180, 0]
      break
  }
  return {
    model,
    translation,
    rotation,
    scale
  }
}

async function makeThreeTexture(img) {
  const texture = await loadTexture(img)
  texture.userData ??= {}
  texture.colorSpace = THREE.NoColorSpace
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  return texture
}

function bakeMirroredScale(displayGroup, solid) {
  const sign = new THREE.Matrix4().makeScale(
    Math.sign(displayGroup.scale.x),
    Math.sign(displayGroup.scale.y),
    Math.sign(displayGroup.scale.z)
  )
  displayGroup.updateWorldMatrix(false, true)
  const invDisp = displayGroup.matrixWorld.clone().invert()
  const v = new THREE.Vector3()
  displayGroup.traverse(o => {
    if (!o.isMesh) return
    const rel = invDisp.clone().multiply(o.matrixWorld)
    const bake = rel.clone().invert().multiply(sign).multiply(rel)
    const nm = new THREE.Matrix3().getNormalMatrix(bake)
    const pos = o.geometry.attributes.position
    const nrm = o.geometry.attributes.normal
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(bake)
      pos.setXYZ(i, v.x, v.y, v.z)
      if (nrm) {
        v.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize()
        nrm.setXYZ(i, v.x, v.y, v.z)
      }
    }
    pos.needsUpdate = true
    if (nrm) nrm.needsUpdate = true
    if (solid && o.geometry.index) {
      const idx = o.geometry.index
      for (let i = 0; i + 2 < idx.count; i += 3) {
        const a = idx.getX(i)
        idx.setX(i, idx.getX(i + 2))
        idx.setX(i + 2, a)
      }
      idx.needsUpdate = true
    }
  })
  displayGroup.scale.set(
    Math.abs(displayGroup.scale.x),
    Math.abs(displayGroup.scale.y),
    Math.abs(displayGroup.scale.z)
  )
}

function convertLegacyDisplay(merged) {
  const d = merged.display
  if (d.gui && merged.version && isBefore(merged.version, "1.9")) {
    const g = d.gui
    const r = g.rotation ?? [0, 0, 0]
    const t = g.translation ?? [0, 0, 0]
    const s = g.scale ?? [1, 1, 1]
    d.gui = {
      rotation: [30 - r[0], 225 - r[1], r[2]],
      translation: t,
      scale: [0.625 * s[0], 0.625 * s[1], 0.625 * s[2]]
    }
  }
  const legacyNames = !merged.version || isBefore(merged.version, "1.9")
  if (legacyNames && d.thirdperson && !d.thirdperson_righthand) {
    const o = d.thirdperson
    const converted = { ...o }
    if (o.rotation) {
      const e = new THREE.Euler(
        THREE.MathUtils.degToRad(o.rotation[0]),
        THREE.MathUtils.degToRad(o.rotation[1]),
        THREE.MathUtils.degToRad(o.rotation[2]),
        "XYZ"
      )
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
        .multiply(new THREE.Quaternion().setFromEuler(e))
      const out = new THREE.Euler().setFromQuaternion(q, "XYZ")
      converted.rotation = [out.x, out.y, out.z].map(r => Math.round(THREE.MathUtils.radToDeg(r) * 100) / 100)
    }
    if (o.translation) {
      converted.translation = [o.translation[0], -o.translation[2], o.translation[1]]
    }
    d.thirdperson_righthand = converted
    delete d.thirdperson
  }
  if (legacyNames && d.firstperson && !d.firstperson_righthand) {
    d.firstperson_righthand = { ...d.firstperson }
    delete d.firstperson
  }
}

function shouldIgnoreAtlases(model) {
  return model.ignore_atlas_restrictions || (model.version && isBefore(model.version, "1.21.11"))
}

async function modelPassesAtlasRules(model, assets) {
  if (model.type !== "block" && model.type !== "item") return true
  if (shouldIgnoreAtlases(model)) return true
  const textures = model.textures ?? {}
  const usedSlots = new Set()
  for (const el of model.elements ?? []) {
    for (const face of Object.values(el.faces ?? {})) {
      if (typeof face?.texture === "string" && face.texture.startsWith("#")) {
        usedSlots.add(face.texture.slice(1))
      }
    }
  }
  const entries = []
  for (const slot of usedSlots) {
    const value = textures[slot]
    if (typeof value !== "string" || !value || value.startsWith("#")) continue
    const { namespace, item } = resolveNamespace(value)
    entries.push(`assets/${namespace}/textures/${item}.png`)
  }
  if (!entries.length) return true

  const memberships = await Promise.all(entries.map(p => getAtlasesContaining(p, assets)))

  let anyInItems = false
  let anyBlocksOnly = false
  for (const atlases of memberships) {
    if (atlases.size === 0) continue
    if (model.type === "block") {
      if (!(atlases.size === 1 && atlases.has("blocks"))) return
    } else {
      for (const a of atlases) if (a !== "blocks" && a !== "items") return
      if (atlases.has("items")) anyInItems = true
      else anyBlocksOnly = true
    }
  }
  if (model.type === "item" && anyInItems && anyBlocksOnly) return
  return true
}

export async function loadModel(scene, assets, model, args) {
  if (model == null) throw new Error("loadModel requires a model")
  if (assets == null || assets.length === 0) throw new Error("loadModel requires assets")
  const display = args?.display ?? "gui"
  const lighting = args?.lighting
  const light = lighting === "world" ? args?.light : null
  const daytime = scene?.userData?.daytime ?? { value: parseDaytime(args?.daytime) }
  if (scene) scene.userData.daytime = daytime
  const block = args?.block ? { ...args.block, neighbors: args?.neighbors ?? null } : null
  if (args?.version && !model.version) model.version = args.version
  assets = await prepareAssets(assets, args?.version ? { version: args.version } : undefined)

  let blockEmission = 0
  if (block?.id) {
    const blockId = normalize(block.id)
    const defaults = await defaultBlockstates(assets)
    blockEmission = getLightEmission(blockId, block.properties, k => {
      const raw = defaults.unique(blockId)[k] ?? defaults.properties[k]
      return Array.isArray(raw) ? raw[0] : raw
    })
  }

  if (!(await modelPassesAtlasRules(model, assets))) {
    const missing = await resolveModelData(assets, { model: "block-model-renderer:missing" })
    for (const k of Object.keys(model)) delete model[k]
    Object.assign(model, missing)
  }

  const textureCache = assets.cache?.textures ?? new Map()
  const materialCache = new Map()

  function resolveTexturePath(id) {
    const { namespace, item } = resolveNamespace(id)
    return `assets/${namespace}/textures/${item}.png`
  }

  async function loadModelTexture(id, tint) {
    const atlas = shouldIgnoreAtlases(model) ? "" : (model.type ?? "")
    const srgb = lighting === "scene" || lighting === "off" ? "\0srgb" : ""
    const cacheKey = `${id ?? ""}\0${tint ?? ""}\0${atlas}${srgb}`
    if (textureCache.has(cacheKey)) return textureCache.get(cacheKey)

    let loaded
    if (id) {
      const path = resolveTexturePath(id)
      loaded = await loadMinecraftTexture(path, assets, shouldIgnoreAtlases(model) ? undefined : model.type)
    } else {
      loaded = { image: await getMissingImage(assets) }
    }

    let image = loaded.image
    let frames = loaded.frames
    if (tint) {
      image = applyTint(image, tint)
      if (frames) frames = frames.map(f => applyTint(f, tint))
    }

    const texture = await makeThreeTexture(image)
    texture.userData.translucent = imageIsTranslucent(image, assets.translucency)
    if (loaded.animated && frames) {
      texture.userData.frames = frames
      texture.userData.times = loaded.times
      texture.userData.interpolate = loaded.interpolate
    }

    if (assets.cache && !assets.cache.ephemeral) texture.userData.cached = true
    textureCache.set(cacheKey, texture)
    return texture
  }

  let settings
  if (typeof display === "object") {
    if (display.type === "fallback" && model.display?.[display.display ?? "gui"]) {
      settings = model.display[display.display ?? "gui"]
    } else {
      settings = structuredClone(display)
    }
  } else {
    settings = model.display?.[display]
  }

  if (model.ignore_rotations) {
    delete settings.rotation
  }

  let rotation = [0, 0, 0]
  if (settings?.rotation) {
    rotation = settings.rotation
  }
  rotation = rotation.map(e => e + 0.00001)

  const isFront = model.gui_light === "front"
  const lightConfig = isFront ? {
    light0: [-0.2006, 0.9749, 0.0969], d0: 0.6422,
    light1: [-0.2209, 0.1706, 0.9603], d1: 0.5997,
    ambient: 0.3968
  } : {
    light0: [-0.1046, 0.9761, 0.1904], d0: 0.5943,
    light1: [-0.9317, 0.2644, -0.2488], d1: 0.5992,
    ambient: 0.4001
  }
  lightConfig.daytime = daytime
  lightConfig.light = light
  lightConfig.blockLightTint = tintVec(args?.blockLightTint, 0xFFD88C)
  lightConfig.nightSkyTint = tintVec(args?.nightSkyTint, 0x7A7AFF)

  const rootGroup = new THREE.Group()
  const displayGroup = new THREE.Group()
  const containerGroup = new THREE.Group()
  rootGroup.add(displayGroup)
  displayGroup.add(containerGroup)

  if (model.x || model.y || model.z) {
    const x = THREE.MathUtils.degToRad(-(model?.x ?? 0))
    const y = THREE.MathUtils.degToRad(-(model?.y ?? 0))
    const z = THREE.MathUtils.degToRad(model?.z ?? 0)
    containerGroup.rotation.set(x, y, z, "ZYX")
  }

  const cull = args?.cull instanceof Set ? args.cull
    : args?.cull ? new Set(Object.keys(args.cull).filter(k => args.cull[k])) : null
  const cullEuler = new THREE.Euler(
    THREE.MathUtils.degToRad(-(model?.x ?? 0)),
    THREE.MathUtils.degToRad(-(model?.y ?? 0)),
    THREE.MathUtils.degToRad(model?.z ?? 0), "ZYX")
  function worldCullface(dir) {
    const v = CULL_VECS[dir]
    if (!v) return null
    const w = new THREE.Vector3(v[0], v[1], v[2]).applyEuler(cullEuler)
    const ax = Math.abs(w.x), ay = Math.abs(w.y), az = Math.abs(w.z)
    if (ax >= ay && ax >= az) return w.x > 0 ? "east" : "west"
    if (ay >= az) return w.y > 0 ? "up" : "down"
    return w.z > 0 ? "south" : "north"
  }

  if (model.translation) {
    containerGroup.position.set(...model.translation)
  }

  if (model.scale) {
    containerGroup.scale.set(...model.scale)
  }

  async function applyFluidHeights(mesh, heights) {
    const geo = mesh.geometry
    const pos = geo.attributes.position, uv = geo.attributes.uv
    const H = { nw: heights.nw, ne: heights.ne, sw: heights.sw, se: heights.se }
    const cornerOf = i => (pos.getZ(i) < 0 ? (pos.getX(i) < 0 ? "nw" : "ne") : (pos.getX(i) < 0 ? "sw" : "se"))
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0) pos.setY(i, H[cornerOf(i)] * 16 - 7)
    }
    pos.needsUpdate = true
    for (const start of [0, 4, 16, 20]) {
      for (let i = start; i < start + 4; i++) {
        uv.setY(i, pos.getY(i) > -6.99 ? 1 - (1 - H[cornerOf(i)]) * 0.5 : 0.5)
      }
    }
    if (model.fluid === "water" && heights.overlay) {
      for (const [face, mi] of [["east", 0], ["west", 1], ["south", 4], ["north", 5]]) {
        if (!heights.overlay[face] || mesh.material[mi].visible === false) continue
        const tint = model.tints?.[0]
        const mkey = `minecraft:block/water_overlay\0${tint ?? ""}\0false`
        let material = materialCache.get(mkey)
        if (!material) {
          material = await makeMaterial(await loadModelTexture("minecraft:block/water_overlay", tint), assets, model.shader, false, true, lightConfig, lighting)
          materialCache.set(mkey, material)
        }
        mesh.material[mi] = material
        mesh.material[mi + 6] = new THREE.MeshBasicMaterial({ visible: false })
      }
    }
    const vertIdx = {}
    for (let i = 8; i < 12; i++) vertIdx[cornerOf(i)] = i
    const order = [vertIdx.nw, vertIdx.sw, vertIdx.se, vertIdx.nw, vertIdx.se, vertIdx.ne]
    for (let k = 0; k < 6; k++) geo.index.setX(geo.groups[2].start + k, order[k])
    geo.index.needsUpdate = true
    if (heights.angle != null) {
      let texRef = "#flow"
      while (texRef && texRef.startsWith("#")) texRef = model.textures?.[texRef.slice(1)]
      const tint = model.tints?.[0]
      for (const [idx, side] of [[2, false], [8, "back"]]) {
        const mkey = `${texRef ?? ""}\0${tint ?? ""}\0${side}\0flow`
        let material = materialCache.get(mkey)
        if (!material) {
          material = await makeMaterial(await loadModelTexture(texRef, tint), assets, model.shader, side, true, lightConfig, lighting)
          materialCache.set(mkey, material)
        }
        mesh.material[idx] = material
      }
      const c = Math.cos(heights.angle) * 0.25, s = Math.sin(heights.angle) * 0.25
      const flowUV = {
        nw: [0.5 - c - s, 0.5 - c + s],
        sw: [0.5 - c + s, 0.5 + c + s],
        se: [0.5 + c + s, 0.5 + c - s],
        ne: [0.5 + c - s, 0.5 - c - s]
      }
      for (const [corner, [fu, fv]] of Object.entries(flowUV)) uv.setXY(vertIdx[corner], fu, 1 - fv)
    }
    uv.needsUpdate = true
    if (heights.same) {
      const hidden = new THREE.MeshBasicMaterial({ visible: false })
      const FACE_INDEX = { east: 0, west: 1, up: 2, down: 3, south: 4, north: 5 }
      for (const dir in FACE_INDEX) {
        if (heights.same[dir]) {
          mesh.material[FACE_INDEX[dir]] = hidden
          mesh.material[FACE_INDEX[dir] + 6] = hidden
        }
      }
    }
    if (!heights.full) {
      mesh.userData.cullface[2] = null
      mesh.userData.cullface[8] = null
    }
  }

  async function buildElement(element, target) {
    const from = new THREE.Vector3().fromArray(element.from)
    const to = new THREE.Vector3().fromArray(element.to)
    const size = new THREE.Vector3().subVectors(to, from)
    size.x ||= 0.001
    size.y ||= 0.001
    size.z ||= 0.001

    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z)

    if (element.rotation?.rescale) {
      let rescaleAxis = element.rotation.axis
      let rescaleAngle = element.rotation.angle
      if (rescaleAngle === undefined) {
        for (const a of ["x", "y", "z"]) {
          if (element.rotation[a]) {
            rescaleAxis = a
            rescaleAngle = element.rotation[a]
            break
          }
        }
      }
      if (rescaleAngle) {
        const angle = Math.abs(rescaleAngle)
        const rescale = 1 / Math.cos(THREE.MathUtils.degToRad(angle > 45 ? 90 - angle : angle))
        const scale = new THREE.Vector3(rescale, rescale, rescale)
        scale[rescaleAxis || "y"] = 1
        geometry.scale(scale.x, scale.y, scale.z)
      }
    }

    const faceOrder = ["east", "west", "up", "down", "south", "north"]

    const cullDirs = new Array(6).fill(null)

    for (let i = 0; i < faceOrder.length; i++) {
      const faceName = faceOrder[i]
      const face = element.faces?.[faceName]
      if (face?.cullface != null && face.cullface !== "") cullDirs[i] = worldCullface(face.cullface)
      if (!face) continue
      let [u1, v1, u2, v2] = face.uv || []
      if (!face.uv) {
        const [fx, fy, fz] = element.from
        const [tx, ty, tz] = element.to
        switch (faceName) {
          case "up":    u1 = fx; u2 = tx; v1 = fz; v2 = tz; break
          case "down":  u1 = fx; u2 = tx; v1 = 16 - tz; v2 = 16 - fz; break
          case "north": u1 = 16 - tx; u2 = 16 - fx; v1 = 16 - ty; v2 = 16 - fy; break
          case "south": u1 = fx; u2 = tx; v1 = 16 - ty; v2 = 16 - fy; break
          case "east":  u1 = 16 - tz; u2 = 16 - fz; v1 = 16 - ty; v2 = 16 - fy; break
          case "west":  u1 = fz; u2 = tz; v1 = 16 - ty; v2 = 16 - fy; break
        }
      }

      let uv = [
        [u1, v1],
        [u2, v1],
        [u1, v2],
        [u2, v2]
      ]

      const rot = face.rotation ?? 0
      if (rot === 90) uv = [uv[2], uv[0], uv[3], uv[1]]
      else if (rot === 180) uv = [uv[3], uv[2], uv[1], uv[0]]
      else if (rot === 270) uv = [uv[1], uv[3], uv[0], uv[2]]

      if (model?.uvlock) {
        let dir = faceName
        let x = ((model.x ?? 0) % 360 + 360) % 360

        function rotateUV(angle) {
          if (!angle) return
          const rad = THREE.MathUtils.degToRad(angle)
          uv = uv.map(([u, v]) => {
            const vec = new THREE.Vector2(u, v)
            vec.rotateAround(UV_CENTER, rad)
            return [vec.x, vec.y]
          })
        }

        if (x) {
          switch (faceName) {
            case "east":  rotateUV(model.x); break
            case "west":  rotateUV(-model.x); break
            case "north": rotateUV(180); break
            case "south": rotateUV(x === 180 ? 180 : 0); break
            case "up":    rotateUV(x === 90 ? 180 : 0); break
            case "down":  rotateUV(x === 270 ? 180 : 0); break
          }
          for (let i = 0; i < x / 90; i++) dir = X_CYCLE[dir] ?? dir
        }

        if (model.y) {
          const y = ((model.y % 360) + 360) % 360
          for (let i = 0; i < y / 90; i++) dir = Y_CYCLE[dir] ?? dir

          if (dir === "up" || dir === "down") {
            rotateUV((dir === "up") ^ !!(x % 180) ? model.y : -model.y)
          }
        }

        if (model.z) {
          rotateUV(dir === "north" ? -model.z : dir === "south" ? model.z : model.z)
        }
      }

      geometry.attributes.uv.array.set(uv.flatMap(([u, v]) => [u / 16, 1 - v / 16]), i * 8)
    }
    geometry.attributes.uv.needsUpdate = true

    async function faceMaterials(back) {
      const out = []
      for (let i = 0; i < faceOrder.length; i++) {
        const faceName = faceOrder[i]
        const face = element.faces?.[faceName]
        if (!face || !face.texture || (cull && cullDirs[i] && cull.has(cullDirs[i]) && !(model.fluid && faceName === "up"))) {
          out.push(new THREE.MeshBasicMaterial({ visible: false }))
          continue
        }

        let texRef = face.texture
        if (texRef && !texRef.startsWith("#")) texRef = "#" + texRef

        let tint
        if (model.tints) {
          tint = model.tints[face.tintindex]
        }

        while (texRef && texRef.startsWith("#")) {
          texRef = model.textures?.[texRef.slice(1)]
        }

        const legacyShade = !model.version || isBefore(model.version, "26.3")
        const modernShade = !model.version || !isBefore(model.version, "26.3")
        let shadeDir = null
        if (model.type !== "item") {
          if (modernShade && SHADE_DIR_VECS[element.shade_direction_override]) shadeDir = element.shade_direction_override
          else if (legacyShade && element.shade === false) shadeDir = "up"
        }
        const side = back ? "back" : false
        const emission = Math.max(blockEmission, !model.version || !isBefore(model.version, "1.21.2") ? Math.max(0, Math.min(15, element.light_emission ?? 0)) : 0)
        const mkey = `${texRef ?? ""}\0${tint ?? ""}\0${shadeDir ?? ""}\0${side}\0${emission}`
        let material = materialCache.get(mkey)
        if (!material) {
          material = await makeMaterial(await loadModelTexture(texRef, tint), assets, model.shader, side, true, lightConfig, lighting, shadeDir, emission)
          if (args?.shaderScale && material.uniforms?.Scale) material.uniforms.Scale.value = args.shaderScale
          materialCache.set(mkey, material)
        }
        out.push(material)
      }
      return out
    }

    const materials = await faceMaterials(false)
    if (model.double_sided) {
      materials.push(...await faceMaterials("back"))
      const groups = geometry.groups.map(g => ({ ...g }))
      geometry.clearGroups()
      for (const g of groups) geometry.addGroup(g.start, g.count, g.materialIndex + 6)
      for (const g of groups) geometry.addGroup(g.start, g.count, g.materialIndex)
      cullDirs.push(...cullDirs)
    }

    const mesh = new THREE.Mesh(geometry, materials)
    mesh.userData.cullface = cullDirs
    mesh.position.set(
      from.x + size.x / 2 - 8,
      from.y + size.y / 2 - 8,
      from.z + size.z / 2 - 8
    )

    const fh = args?.fluidHeights ?? (model.fluid && args?.neighbors ? await fluidHeights(assets, model.fluid, args.neighbors) : null)
    if (model.fluid && fh) await applyFluidHeights(mesh, fh)

    if (element.rotation) {
      let { origin, axis, angle, x, y, z } = element.rotation
      if (!isNaN(angle) || axis) {
        if (isNaN(angle) || !axis) {
          return false
        }
      }
      if (model.version) {
        const preMultiAxis = isBefore(model.version, "1.21.11")
        if (axis && preMultiAxis && (Math.abs(angle) > 45 || (isBefore(model.version, "1.21.6") && angle % 22.5 !== 0))) {
          return false
        }
        if (!axis && preMultiAxis) {
          return false
        }
      }

      const pivot = new THREE.Vector3(
        origin[0] - 8,
        origin[1] - 8,
        origin[2] - 8
      )

      const rotGroup = new THREE.Group()
      rotGroup.position.copy(pivot)

      mesh.position.sub(pivot)
      rotGroup.add(mesh)

      if (axis) {
        rotGroup.rotateOnAxis(AXIS_VECTORS[axis], THREE.MathUtils.degToRad(angle))
      } else {
        rotGroup.rotateZ(THREE.MathUtils.degToRad(z ?? 0))
        rotGroup.rotateY(THREE.MathUtils.degToRad(y ?? 0))
        rotGroup.rotateX(THREE.MathUtils.degToRad(x ?? 0))
      }

      target.add(rotGroup)
    } else {
      target.add(mesh)
    }
    return true
  }

  const replaceElements = modelLoaders.some(l => l.replaceElements && l.match?.(model))
  for (const element of replaceElements ? [] : model.elements || []) {
    if (!(await buildElement(element, containerGroup))) {
      return await loadModel(scene, assets, await resolveModelData(assets, "block-model-renderer:missing"), { display })
    }
  }

  function mergeElementMeshes(group) {
    const buckets = new Map()
    const vert = new THREE.Vector3()
    const norm = new THREE.Vector3()
    const matrix = new THREE.Matrix4()
    const normalMatrix = new THREE.Matrix3()
    const collision = []
    for (const child of Array.from(group.children)) {
      const mesh = child.isMesh ? child : child.children.length === 1 && child.children[0].isMesh ? child.children[0] : null
      if (!mesh) continue
      child.updateMatrix()
      if (mesh === child) {
        matrix.copy(child.matrix)
      } else {
        mesh.updateMatrix()
        matrix.multiplyMatrices(child.matrix, mesh.matrix)
      }
      normalMatrix.getNormalMatrix(matrix)
      const geo = mesh.geometry
      const pos = geo.attributes.position
      const nrm = geo.attributes.normal
      const uv = geo.attributes.uv
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
      for (let i = 0; i < pos.count; i++) {
        vert.fromBufferAttribute(pos, i).applyMatrix4(matrix)
        if (vert.x < x0) x0 = vert.x
        if (vert.y < y0) y0 = vert.y
        if (vert.z < z0) z0 = vert.z
        if (vert.x > x1) x1 = vert.x
        if (vert.y > y1) y1 = vert.y
        if (vert.z > z1) z1 = vert.z
      }
      if (x0 !== Infinity) collision.push([x0, y0, z0, x1, y1, z1])
      for (const group of geo.groups) {
        const material = mesh.material[group.materialIndex]
        if (!material || material.visible === false) continue
        const dir = mesh.userData.cullface?.[group.materialIndex] ?? null
        let dirs = buckets.get(material)
        if (!dirs) buckets.set(material, dirs = new Map())
        let acc = dirs.get(dir)
        if (!acc) dirs.set(dir, acc = { positions: [], normals: [], uvs: [] })
        for (let i = group.start; i < group.start + group.count; i++) {
          const a = geo.index.getX(i)
          vert.fromBufferAttribute(pos, a).applyMatrix4(matrix)
          norm.fromBufferAttribute(nrm, a).applyMatrix3(normalMatrix).normalize()
          acc.positions.push(vert.x, vert.y, vert.z)
          acc.normals.push(norm.x, norm.y, norm.z)
          acc.uvs.push(uv.getX(a), uv.getY(a))
        }
      }
      group.remove(child)
      geo.dispose()
    }
    group.userData.collision = collision
    for (const [material, dirs] of buckets) {
      for (const [dir, acc] of dirs) {
        const geo = new THREE.BufferGeometry()
        geo.setAttribute("position", new THREE.Float32BufferAttribute(acc.positions, 3))
        geo.setAttribute("normal", new THREE.Float32BufferAttribute(acc.normals, 3))
        geo.setAttribute("uv", new THREE.Float32BufferAttribute(acc.uvs, 2))
        geo.setIndex(Array.from(Array(acc.positions.length / 3).keys()))
        const mesh = new THREE.Mesh(geo, material)
        mesh.userData.cullface = [dir]
        group.add(mesh)
      }
    }
  }

  if (!model.fluid && (model.elements?.length ?? 0) > 1) mergeElementMeshes(containerGroup)

  for (const loader of activeLoaders()) {
    if (loader.build && loader.match?.(model)) {
      await loader.build({
        group: containerGroup,
        model,
        assets,
        args,
        block,
        helpers: {
          THREE,
          lighting,
          daytime,
          readFile: (path, hint) => readFile(path, assets, hint),
          loadTexture: (id, tint) => loadModelTexture(id, tint),
          buildElements: async (elements = []) => {
            const g = new THREE.Group()
            for (const element of elements) await buildElement(element, g)
            if (!model.fluid && elements.length > 1) mergeElementMeshes(g)
            return g
          },
          resolveTexture: ref => {
            let t = ref
            while (typeof t === "string" && t.startsWith("#")) t = model.textures?.[t.slice(1)]
            return t
          },
          createMaterial: async (id, opts = {}) => {
            const shadeDir = SHADE_DIR_VECS[opts.shade_direction] ? opts.shade_direction : null
            const emission = Math.max(0, blockEmission, Math.min(15, opts.light_emission ?? 0))
            const key = `loader\0${id}\0${opts.tint ?? ""}\0${opts.shade !== false}\0${shadeDir ?? ""}\0${!!opts.double_sided}\0${opts.shader ? JSON.stringify(opts.shader) : ""}\0${emission}`
            let material = materialCache.get(key)
            if (!material) {
              material = await makeMaterial(await loadModelTexture(id, opts.tint), assets, opts.shader, opts.double_sided, opts.shade !== false, lightConfig, lighting, shadeDir, emission)
              materialCache.set(key, material)
            }
            return material
          }
        }
      })
    }
  }

  if (settings) {
    if (settings.rotation) {
      const delta = new THREE.Euler(
        THREE.MathUtils.degToRad(settings.rotation[0]),
        THREE.MathUtils.degToRad(settings.rotation[1]),
        THREE.MathUtils.degToRad(settings.rotation[2]),
        displayGroup.rotation.order
      )
      displayGroup.quaternion.multiply(new THREE.Quaternion().setFromEuler(delta))
    }
    if (settings.translation) {
      displayGroup.position.set(
        Math.max(-80, Math.min(80, settings.translation[0])),
        Math.max(-80, Math.min(80, settings.translation[1])),
        Math.max(-80, Math.min(80, settings.translation[2]))
      )
    }
    if (settings.scale) {
      displayGroup.scale.set(
        Math.max(-4, Math.min(4, settings.scale[0])),
        Math.max(-4, Math.min(4, settings.scale[1])),
        Math.max(-4, Math.min(4, settings.scale[2]))
      )
    }
  }

  if (model.transformation) {
    const mat = model.transformation instanceof THREE.Matrix4
      ? model.transformation
      : parseTransformation(model.transformation)
    if (mat) {
      const wrapped = new THREE.Matrix4()
        .makeTranslation(-8, -8, -8)
        .multiply(mat)
        .multiply(new THREE.Matrix4().makeTranslation(8, 8, 8))
      containerGroup.applyMatrix4(wrapped)
    }
  }

  if (displayGroup.scale.x * displayGroup.scale.y * displayGroup.scale.z < 0) {
    bakeMirroredScale(displayGroup, model.version && isBefore(model.version, "1.15"))
  }

  if (scene) scene.add(rootGroup)

  return rootGroup
}

function tintVec(input, fallback) {
  if (input == null) input = fallback
  if (Array.isArray(input)) return new THREE.Vector3(input[0], input[1], input[2])
  if (input?.isColor) return new THREE.Vector3(input.r, input.g, input.b)
  if (typeof input === "string") input = parseInt(input.replace(/^#/, ""), 16)
  return new THREE.Vector3(((input >> 16) & 255) / 255, ((input >> 8) & 255) / 255, (input & 255) / 255)
}

async function makeMaterial(texture, assets, shader, doubleSided, shadeEnabled, lightConfig, lighting, shadeDir, emission = 0) {
  if ((lighting === "scene" || lighting === "off") && shader?.type !== "end_portal") {
    texture.colorSpace = THREE.SRGBColorSpace
    texture.needsUpdate = true
    const side = doubleSided === "back" ? THREE.BackSide : doubleSided ? THREE.DoubleSide : THREE.FrontSide
    if (lighting === "scene") {
      const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0, alphaTest: 0.5, side })
      if (emission > 0) {
        mat.emissive = new THREE.Color(0xffffff)
        mat.emissiveMap = texture
        mat.emissiveIntensity = emission / 15
      }
      return mat
    }
    return new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5, side })
  }
  if (shader?.type === "end_portal") {
    const skyBuf = await readFile(`assets/minecraft/textures/environment/end_sky.png`, assets)
    const skyTexture = await makeThreeTexture(skyBuf ? await loadImage(skyBuf) : new Canvas(1, 1))
    for (const t of [skyTexture, texture]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.needsUpdate = true
    }
    return new THREE.ShaderMaterial({
      uniforms: {
        GameTime: {
          value: 0.727
        },
        Scale: {
          value: 1
        },
        Aspect: {
          value: 1
        },
        Sampler0: {
          value: skyTexture
        },
        Sampler1: {
          value: texture
        }
      },
      vertexShader: `
        varying vec4 texProj0;
        #include <clipping_planes_pars_vertex>

        vec4 projection_from_position(vec4 position) {
          vec4 projection = position * 0.5;
          projection.xy = vec2(projection.x + projection.w, projection.y + projection.w);
          projection.zw = position.zw;
          return projection;
        }

        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          #include <clipping_planes_vertex>
          gl_Position = projectionMatrix * mvPosition;

          texProj0 = projection_from_position(gl_Position);
        }
      `,
      fragmentShader: `
        varying vec4 texProj0;
        #include <clipping_planes_pars_fragment>

        uniform float GameTime;
        uniform float Scale;
        uniform float Aspect;
        uniform sampler2D Sampler0;
        uniform sampler2D Sampler1;

        mat2 mat2_rotate_z(float radians) {
          return mat2(
            cos(radians), -sin(radians),
            sin(radians), cos(radians)
          );
        }

        vec3 getColor(int i) {
          if (i == 0) return vec3(0.022087, 0.098399, 0.110818);
          if (i == 1) return vec3(0.011892, 0.095924, 0.089485);
          if (i == 2) return vec3(0.027636, 0.101689, 0.100326);
          if (i == 3) return vec3(0.046564, 0.109883, 0.114838);
          if (i == 4) return vec3(0.064901, 0.117696, 0.097189);
          if (i == 5) return vec3(0.063761, 0.086895, 0.123646);
          if (i == 6) return vec3(0.084817, 0.111994, 0.166380);
          if (i == 7) return vec3(0.097489, 0.154120, 0.091064);
          if (i == 8) return vec3(0.106152, 0.131144, 0.195191);
          if (i == 9) return vec3(0.097721, 0.110188, 0.187229);
          if (i == 10) return vec3(0.133516, 0.138278, 0.148582);
          if (i == 11) return vec3(0.070006, 0.243332, 0.235792);
          if (i == 12) return vec3(0.196766, 0.142899, 0.214696);
          if (i == 13) return vec3(0.047281, 0.315338, 0.321970);
          if (i == 14) return vec3(0.204675, 0.390010, 0.302066);
          return vec3(0.080955, 0.314821, 0.661491);
        }

        const mat4 SCALE_TRANSLATE = mat4(
          0.5, 0.0, 0.0, 0.25,
          0.0, 0.5, 0.0, 0.25,
          0.0, 0.0, 1.0, 0.0,
          0.0, 0.0, 0.0, 1.0
        );

        mat4 end_portal_layer(float layer) {
          mat4 translate = mat4(
            0.25, 0.0, 0.0, 17.0 / layer,
            0.0, 0.25, 0.0, (2.0 + layer / 1.5) * (GameTime * 1.5),
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0
          );

          mat2 rotate = mat2_rotate_z(radians((layer * layer * 4321.0 + layer * 9.0) * 2.0));

          mat2 scale = mat2((4.5 - layer / 4.0) * 2.0);

          return mat4(scale * rotate) * translate * SCALE_TRANSLATE;
        }

        void main() {
          #include <clipping_planes_fragment>
          vec3 color = texture2DProj(Sampler0, texProj0 * vec4(Scale * Aspect, Scale, 1.0, 1.0)).rgb * getColor(0);
          for (int i = 0; i < ${shader.layers ?? 15}; i++) {
            color += texture2DProj(Sampler1, texProj0 * vec4(Scale * Aspect, Scale * 16.0 / 9.0, 1.0, 1.0) * end_portal_layer(float(i + 1))).rgb * getColor(i);
          }
          gl_FragColor = vec4(color, 1.0);
        }
      `,
      clipping: true
    })
  }
  const volume = lightConfig?.light?.uniforms ? lightConfig.light : null
  return new THREE.ShaderMaterial({
    defines: volume ? { LIGHT_VOLUME: "" } : {},
    uniforms: {
      map: { value: texture },
      light0: { value: new THREE.Vector3(...(lightConfig?.light0 ?? [0, 0, 1])) },
      light1: { value: new THREE.Vector3(...(lightConfig?.light1 ?? [0, 1, 0])) },
      d0: { value: lightConfig?.d0 ?? 0.6 },
      d1: { value: lightConfig?.d1 ?? 0.6 },
      ambient: { value: lightConfig?.ambient ?? 0.4 },
      shadeEnabled: { value: shadeEnabled !== false },
      shadeOverride: { value: new THREE.Vector3(...(SHADE_DIR_VECS[shadeDir] ?? [0, 0, 0])) },
      worldShade: { value: lighting === "world" },
      daytime: lightConfig?.daytime ?? { value: NAMED_TIMES.noon },
      emission: { value: emission / 15 },
      blockLightTint: { value: lightConfig?.blockLightTint ?? tintVec(null, 0xFFD88C) },
      nightSkyTint: { value: lightConfig?.nightSkyTint ?? tintVec(null, 0x7A7AFF) },
      ...(volume ? volume.uniforms : {}),
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vWorldNormal;
      #ifdef LIGHT_VOLUME
        varying vec3 vWorldPos;
      #endif
      #include <clipping_planes_pars_vertex>
      void main() {
        vUv = uv;
        vec4 pos = vec4(position, 1.0);
        vec3 nrm = normal;
        #ifdef USE_INSTANCING
          pos = instanceMatrix * pos;
          nrm = mat3(instanceMatrix) * nrm;
        #endif
        vNormal = normalize(normalMatrix * nrm);
        vWorldNormal = normalize(mat3(modelMatrix) * nrm);
        #ifdef LIGHT_VOLUME
          vWorldPos = (modelMatrix * pos).xyz;
        #endif
        vec4 mvPosition = modelViewMatrix * pos;
        #include <clipping_planes_vertex>
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      uniform vec3 light0;
      uniform vec3 light1;
      uniform float d0;
      uniform float d1;
      uniform float ambient;
      uniform bool shadeEnabled;
      uniform vec3 shadeOverride;
      uniform bool worldShade;
      uniform float daytime;
      uniform float emission;
      uniform vec3 blockLightTint;
      uniform vec3 nightSkyTint;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vWorldNormal;
      #ifdef LIGHT_VOLUME
        varying vec3 vWorldPos;
        uniform vec3 lightVolOrigin;
        uniform vec3 lightVolSize;
        uniform sampler2D lightVol;
        uniform vec2 lightVolTex;
        uniform float lightVolCols;
        vec2 sampleLightVol(vec3 p) {
          p = clamp(p, vec3(0.0), lightVolSize);
          float y0 = floor(p.y);
          float y1 = min(y0 + 1.0, lightVolSize.y);
          vec2 tile = lightVolSize.xz + 1.0;
          vec2 xz = vec2(p.x, p.z) + 0.5;
          vec2 uv0 = vec2(mod(y0, lightVolCols) * tile.x, floor(y0 / lightVolCols) * tile.y) + xz;
          vec2 uv1 = vec2(mod(y1, lightVolCols) * tile.x, floor(y1 / lightVolCols) * tile.y) + xz;
          vec2 l0 = texture2D(lightVol, uv0 / lightVolTex).rg;
          vec2 l1 = texture2D(lightVol, uv1 / lightVolTex).rg;
          return mix(l0, l1, p.y - y0);
        }
      #endif
      #include <clipping_planes_pars_fragment>
      void main() {
        #include <clipping_planes_fragment>
        if (vUv.x < 0.0 || vUv.x > 1.0 || vUv.y < 0.0 || vUv.y > 1.0) discard;
        vec4 texColor = texture2D(map, vUv);
        if (texColor.a < 0.01) discard;
        float shade = 1.0;
        vec3 light = vec3(1.0);
        if (worldShade) {
          if (shadeEnabled) {
            bool hasOverride = dot(shadeOverride, shadeOverride) > 0.5;
            vec3 wn = hasOverride ? shadeOverride : vWorldNormal;
            vec3 n2 = wn * wn;
            shade = (n2.y * (wn.y >= 0.0 ? 1.0 : 0.5) + n2.z * 0.8 + n2.x * 0.6) / (n2.x + n2.y + n2.z);
          }
          float td = mod(daytime - 730.0, 24000.0) + 730.0;
          float skyFactor;
          vec3 skyColor;
          if (td < 11270.0) {
            skyFactor = 1.0;
            skyColor = vec3(1.0);
          } else if (td < 13140.0) {
            float k = (td - 11270.0) / 1870.0;
            skyFactor = mix(1.0, 0.24, k);
            skyColor = mix(vec3(1.0), nightSkyTint, k);
          } else if (td < 22860.0) {
            skyFactor = 0.24;
            skyColor = nightSkyTint;
          } else {
            float k = (td - 22860.0) / 1870.0;
            skyFactor = mix(0.24, 1.0, k);
            skyColor = mix(nightSkyTint, vec3(1.0), k);
          }
          #ifdef LIGHT_VOLUME
            vec3 sn = gl_FrontFacing ? vWorldNormal : -vWorldNormal;
            vec3 lp = vWorldPos / 16.0 + 0.5 + sn * 0.5 - lightVolOrigin;
            vec2 lv = sampleLightVol(lp);
            float blockLevel = max(lv.x, emission);
            float skyLevel = lv.y;
          #else
            float blockLevel = emission;
            float skyLevel = 1.0;
          #endif
          float skyBrightness = skyLevel / (4.0 - 3.0 * skyLevel) * skyFactor;
          float blockBrightness = blockLevel / (4.0 - 3.0 * blockLevel) * 1.4;
          vec3 blockColor = mix(blockLightTint, vec3(1.0), 0.9 * (2.0 * blockLevel - 1.0) * (2.0 * blockLevel - 1.0));
          light = clamp(skyColor * skyBrightness + blockColor * blockBrightness, 0.0, 1.0);
        } else if (shadeEnabled) {
          mat3 v = mat3(viewMatrix);
          bool hasOverride = dot(shadeOverride, shadeOverride) > 0.5;
          vec3 n = hasOverride ? v * shadeOverride : vNormal;
          shade = min(1.0, ambient + d0 * max(0.0, dot(n, v * light0)) + d1 * max(0.0, dot(n, v * light1)));
        }
        gl_FragColor = vec4(texColor.rgb * shade * light, texColor.a);
      }
    `,
    transparent: texture?.userData?.translucent === true,
    depthWrite: texture?.userData?.translucent !== true,
    side: doubleSided === "back" ? THREE.BackSide : doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    clipping: true,
  })
}
