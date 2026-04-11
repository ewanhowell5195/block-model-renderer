import { Canvas, Image, ImageData, loadImage } from "skia-canvas"
import { fileURLToPath } from "node:url"
import getTHREE from "headless-three"
import path from "node:path"
import fs from "node:fs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const { THREE, loadTexture, render } = (await getTHREE({ Canvas, Image, ImageData }))

const missing = await loadImage(`${__dirname}/assets/fallbacks/assets/minecraft/textures/~missing.png`)

function parseTransformation(t) {
  if (!t) return null
  if (Array.isArray(t)) {
    return new THREE.Matrix4().fromArray(t)
  }
  const mat = new THREE.Matrix4()
  const T = new THREE.Matrix4().makeTranslation(...(t.translation || [0, 0, 0]))
  const L = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...(t.left_rotation || [0, 0, 0, 1])))
  const S = new THREE.Matrix4().makeScale(...(t.scale || [1, 1, 1]))
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

export async function fileExists(filePath, assets) {
  if (assets) {
    if (Array.isArray(assets)) {
      for (const folder of assets) {
        try {
          const joined = path.join(folder, filePath)
          await fs.promises.access(joined)
          return joined
        } catch {}
      }
      return false
    } else {
      filePath = path.join(assets, filePath)
    }
  }

  try {
    await fs.promises.access(filePath)
    return filePath
  } catch {
    return false
  }
}

export async function listDirectory(dir, assets) {
  const out = new Set()

  async function readDir(full) {
    try {
      const files = await fs.promises.readdir(full)
      for (const file of files) out.add(file)
    } catch {}
  }

  if (!assets) {
    await readDir(dir)
  } else if (Array.isArray(assets)) {
    for (const folder of assets) {
      await readDir(path.join(folder, dir))
    }
  } else {
    await readDir(path.join(assets, dir))
  }

  return Array.from(out)
}

async function readFile(file, assets) {
  if (assets) {
    if (Array.isArray(assets)) {
      for (const folder of assets) {
        const full = path.join(folder, file)
        try {
          await fs.promises.access(full)
          const buf = await fs.promises.readFile(full)
          buf.path = full
          return buf
        } catch {}
      }
      return
    }
    file = path.join(assets, file)
  }
  try {
    await fs.promises.access(file)
    const buf = await fs.promises.readFile(file)
    buf.path = file
    return buf
  } catch {
    return
  }
}

function getAssets(assets) {
  let arr
  if (Array.isArray(assets)) {
    arr = assets.slice()
  } else {
    arr = [assets]
  }
  const overridesPath = path.join(__dirname, "assets/overrides")
  const fallbacksPath = path.join(__dirname, "assets/fallbacks")
  const resolvedOverrides = path.resolve(overridesPath)
  const resolvedFallbacks = path.resolve(fallbacksPath)
  if (!arr.some(p => path.resolve(p) === resolvedOverrides)) {
    arr.unshift(overridesPath)
  }
  if (!arr.some(p => path.resolve(p) === resolvedFallbacks)) {
    arr.push(fallbacksPath)
  }
  return arr
}

export async function renderBlock(args = {}) {
  args.id ??= ""
  args.assets ??= []
  args.blockstates ??= {}
  args.display ??= {
    rotation: [30, 225, 0],
    scale: [0.625, 0.625, 0.625],
    type: "fallback",
    display: "gui"
  }

  const { scene, camera } = makeModelScene()

  const models = await parseBlockstate(args.assets, args.id, args.blockstates)

  for (const model of models) {
    const resolved = await resolveModelData(args.assets, model)
    await loadModel(scene, args.assets, resolved, args.display)
  }

  return renderModelScene(scene, camera)
}

export async function renderItem(args = {}) {
  args.id ??= ""
  args.assets ??= []
  args.properties ??= {}
  args.display ??= {}

  const { scene, camera } = makeModelScene()

  const models = await parseItemDefinition(args.assets, args.id, args.properties, args.display)

  for (const model of models) {
    const resolved = await resolveModelData(args.assets, model)
    await loadModel(scene, args.assets, resolved, args.display)
  }

  return renderModelScene(scene, camera)
}

export async function renderModel(args) {
  args.model ??= {}
  args.assets ??= []
  args.display ??= {
    rotation: [30, 225, 0],
    scale: [0.625, 0.625, 0.625],
    type: "fallback",
    display: "gui"
  }

  const { scene, camera } = makeModelScene()

  const resolved = await resolveModelData(args.assets, { model: args.model})
  await loadModel(scene, args.assets, resolved, args.display)

  return renderModelScene(scene, camera)
}

export function makeModelScene() {
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-8, 8, 8, -8, 0.01, 100)
  camera.position.set(0, 0, 30)
  camera.lookAt(0, 0, 0)

  return { scene, camera }
}

export async function renderModelScene(scene, camera, outputPath, w = 1024, h = 1024) {
  return render({ scene, camera, width: w, height: h, path: outputPath, colorSpace: THREE.LinearSRGBColorSpace })
}

function resolveNamespace(str) {
  const parts = str.split(":")
  if (parts.length === 2) {
    return { namespace: parts[0], item: parts[1] }
  } else {
    return { namespace: "minecraft", item: str }
  }
}

const DEFAULT_BLOCKSTATES = {
  facing: "north",
  half: "bottom",
  attachment: "floor",
  up: true,
  shape: ["straight", "north_south"],
  age: [7, 6, 5, 4, 3, 2, 1, 0],
  tilt: "none",
  bottom: false,
  north: false,
  east: false,
  south: false,
  west: false,
  axis: "y",
  face: "wall",
  orientation: "north_up",
  side_chain: "unconnected",
  powered: false,
  segment_amount: 4,
  flower_amount: 4,
  rotation: 8
}

const UNIQUE_DEFAULT_BLOCKSTATES = {
  "*_mushroom_block|mushroom_stem": {
    north: true,
    east: true,
    south: true,
    west: true,
    up: true,
    down: true
  },
  fire: {
    up: false
  },
  "*_stairs|*_glazed_terracotta|cocoa": {
    facing: "south"
  },
  "*_amethyst_bud|amethyst_cluster|barrel|end_rod|*lightning_rod|*piston*|*shulker_box": {
    facing: "up"
  },
  "*campfire|redstone_torch|redstone_wall_torch": {
    lit: true
  },
  "glow_lichen|sculk_vein|resin_clump": {
    up: false,
    down: true
  },
  grindstone: {
    face: "floor"
  },
  vine: {
    up: false,
    south: true
  },
  pale_moss_carpet: {
    bottom: true
  },
  hopper: {
    facing: "down"
  },
  brewing_stand: {
    has_bottle_0: false,
    has_bottle_1: false,
    has_bottle_2: false
  },
  redstone_wire: {
    north: "side",
    south: "side",
    east: "side",
    west: "side",
    power: 0
  },
  "*cauldron": {
    level: 3
  },
  "*_bed": {
    part: "foot",
    facing: "south"
  },
  chiseled_bookshelf: {
    slot_0_occupied: false,
    slot_1_occupied: false,
    slot_2_occupied: false,
    slot_3_occupied: false,
    slot_4_occupied: false,
    slot_5_occupied: false
  },
  "*_leaves": {
    persistent: false,
    distance: 1
  }
}

function getUniqueDefault(blockstate) {
  if (UNIQUE_DEFAULT_BLOCKSTATES[blockstate]) return UNIQUE_DEFAULT_BLOCKSTATES[blockstate]

  for (const key in UNIQUE_DEFAULT_BLOCKSTATES) {
    const patterns = key.split("|").map(pattern =>
      new RegExp("^" + pattern.replace(/\*/g, ".*") + "$")
    )

    if (patterns.some(regex => regex.test(blockstate))) {
      return UNIQUE_DEFAULT_BLOCKSTATES[key]
    }
  }

  return {}
}

const GRASS_BLOCKS = [
  "bush",
  "fern",
  "grass_block",
  "large_fern",
  "pink_petals",
  "potted_fern",
  "short_grass",
  "sugar_cane",
  "tall_grass",
  "wildflowers"
]
const FOLIAGE_BLOCKS = [
  "acacia_leaves",
  "dark_oak_leaves",
  "jungle_leaves",
  "mangrove_leaves",
  "oak_leaves",
  "vine"
]
const DRY_FOLIAGE_BLOCKS = [
  "leaf_litter"
]
const WATER_BLOCKS = [
  "bubble_column",
  "water_cauldron",
  "water"
]

export async function parseBlockstate(assets, blockstate, data = {}) {
  assets = getAssets(assets)

  const { namespace, item } = resolveNamespace(blockstate)

  const buf = await readFile(`assets/${namespace}/blockstates/${item}.json`, assets)

  if (!buf) {
    return [{ type: "block", model: "~missing" }]
  }

  const json = JSON.parse(buf)

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
          const raw = data[k] ?? getUniqueDefault(blockstate)[k] ?? DEFAULT_BLOCKSTATES[k]
          const actuals = Array.isArray(raw) ? raw.map(e => e.toString()) : [raw?.toString()]
          const index = actuals.indexOf(v)
          if (index === -1) return acc
          return acc + (actuals.length - index)
        }, 0)
      }

      const entry = Array.isArray(value) ? value[0] : value
      return { score, model: entry }
    }).filter(e => e.model)

    if (scored.length > 0) {
      scored.sort((a, b) => b.score - a.score)
      models.push(scored[0].model)
    }
  } else if (json.multipart) {
    const ranges = new Set
    
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
          const raw = data[k] ?? getUniqueDefault(blockstate)[k] ?? DEFAULT_BLOCKSTATES[k]
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
        const apply = Array.isArray(part.apply) ? part.apply[0] : part.apply
        if (apply?.model) models.push(apply)
      })
  }

  for (const model of models) {
    if (json.allow_invalid_rotations) {
      model.allow_invalid_rotations = true
    } else if (model.x && model.x % 90 !== 0 || model.y && model.y % 90 !== 0 || model.z && model.z % 90 !== 0) {
      return ["~missing.json"]
    }

    model.type = "block"

    if (GRASS_BLOCKS.includes(item)) {
      model.tints = [await getColorMapTint(assets, "grass", 0.5, 1)]
      if (item === "pink_petals" || item === "wildflowers") {
        model.tints = ["#FFFFFF", model.tints[0]]
      }
    } else if (FOLIAGE_BLOCKS.includes(item)) {
      model.tints = [await getColorMapTint(assets, "foliage", 0.5, 1)]
    } else if (DRY_FOLIAGE_BLOCKS.includes(item)) {
      model.tints = [await getColorMapTint(assets, "dry_foliage", 0.5, 1)]
    } else if (WATER_BLOCKS.includes(item)) {
      model.tints = ["#3F76E4"]
    } else switch (item) {
      case "birch_leaves":
        model.tints = ["#80A755"]
        break;
      case "spruce_leaves":
        model.tints = ["#619961"]
        break;
      case "lily_pad":
        model.tints = ["#208030"]
        break;
      case "melon_stem":
      case "pumpkin_stem":
        model.tints = [[
          "#00FF00",
          "#20F704",
          "#40EF08",
          "#60E70C",
          "#80DF10",
          "#A0D714",
          "#C0CF18",
          "#E0C71C"
        ][data.age ?? 7]]
        break;
      case "attached_melon_stem":
      case "attached_pumpkin_stem":
        model.tints = ["#E0C71C"]
        break;
      case "redstone_wire":
        model.tints = [[
          "#4B0000",
          "#6F0000",
          "#790000",
          "#820000",
          "#8C0000",
          "#970000",
          "#A10000",
          "#AB0000",
          "#B50000",
          "#BF0000",
          "#CA0000",
          "#D30000",
          "#DD0000",
          "#E70600",
          "#F11B00",
          "#FC3100"
        ][data.power ?? 0]]
        break;
    }

    if (item === "end_portal" || item == "end_gateway") {
      model.shader = {
        type: "end_portal",
        layers: item === "end_portal" ? 15 : 16
      }
    }
  }

  return models
}

function normalize(val) {
  return String(val).replace(/^minecraft:/, "")
}

async function getColorMapTint(assets, mapName, temperature, downfall) {
  if (isNaN(temperature) || isNaN(downfall)) return "#FF00FF"

  const filePath = await fileExists(`assets/minecraft/textures/colormap/${mapName}.png`, assets)
  if (!filePath) return "#FFFFFF"

  const image = await loadImage(filePath)
  const canvas = new Canvas(256, 256)
  const ctx = canvas.getContext("2d")

  if (image.width !== 256 || image.height !== 256) return "#FF00FF"
  ctx.drawImage(image, 0, 0)

  const x = Math.round((1 - temperature) * 255)
  const y = Math.round((1 - downfall * temperature) * 255)

  if (x < 0 || x > 255 || y < 0 || y > 255) return "#FF00FF"

  const { data } = ctx.getImageData(x, y, 1, 1)
  const [r, g, b] = data
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase()
}

export async function parseItemDefinition(assets, itemId, data = {}, display = "gui") {
  assets = getAssets(assets)

  const { namespace, item } = resolveNamespace(itemId)

  const buf = await readFile(`assets/${namespace}/items/${item}.json`, assets)

  if (!buf) {
    return [{ type: "model", model: "~missing" }]
  }
  
  const json = JSON.parse(buf)

  const models = await resolveItemModel(json.model, data, display)
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    if (model.tints) {
      const tints = []
      for (const tint of model.tints) {
        const type = normalize(tint.type)
        if (type === "grass") {
          tints.push(await getColorMapTint(assets, "grass", tint.temperature, tint.downfall))
        } else if (tint.value || tint.default) {
          tints.push("#" + ((tint.value ?? tint.default) >>> 0).toString(16).padStart(8, "0").slice(2))
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

function resolveItemModel(def, data, display, accTransform) {
  const normalizedData = {}
  for (const key in data) normalizedData[normalize(key)] = data[key]
  data = normalizedData
  while (def) {
    const type = normalize(def.type)
    const currentTransform = composeTransformations(accTransform, parseTransformation(def.transformation))

    if (type === "special") {
      const model = {
        model: def.base
      }
      model.special = def.model
      model.special.type = normalize(model.special.type)
      if (currentTransform) model.transformation = currentTransform
      return [model]
    }

    if (type === "composite") {
      const result = []
      for (const model of def.models) {
        const nested = resolveItemModel(model, data, display, currentTransform)
        result.push(...nested)
      }
      return result
    }

    if (type === "select") {
      const prop = normalize(def.property)
      let value = normalize(data[prop] ?? "")
      if (!value && prop === "display_context") {
        value = typeof display === "string" ? display : display.display
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
      const prop = normalize(def.property)
      const value = normalize(data[prop])
      const isTruthy = value === "true"
      def = isTruthy ? def.on_true : def.on_false
      accTransform = currentTransform
      continue
    }

    if (type === "range_dispatch") {
      const prop = normalize(def.property)
      const num = parseFloat(data[prop] ?? 0)
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
      if (currentTransform) def = { ...def, transformation: currentTransform }
      return [def]
    }

    return []
  }
  return []
}

async function loadMinecraftTexture(path, assets) {
  const resolved = await fileExists(path, assets)
  if (!resolved) return missing

  const image = await loadImage(resolved)

  let meta
  try {
    meta = JSON.parse(await readFile(resolved + ".mcmeta")).animation ?? {}
  } catch {
    return image
  }

  const frameWidth = meta.width
  const frameHeight = meta.height

  const cropW =
    frameWidth ??
    (frameHeight
      ? image.width
      : Math.min(image.width, image.height))

  const cropH =
    frameHeight ??
    (frameWidth
      ? image.height
      : Math.min(image.width, image.height))

  const canvas = new Canvas(cropW, cropH)
  const ctx = canvas.getContext("2d")
  ctx.drawImage(image, 0, 0, cropW, cropH, 0, 0, cropW, cropH)

  return canvas
}

export async function resolveModelData(assets, model) {
  assets = getAssets(assets)

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

        const overridesPath = path.normalize(path.join(__dirname, "assets/overrides")) + path.sep
        const filePath = path.normalize(buf.path)

        if (filePath.startsWith(overridesPath)) {
          merged.overridden = true
        }

        json = JSON.parse(buf)
      }

      stack.push(json)

      if (!json.parent || json.parent.startsWith("builtin")) break

      const parentId = json.parent.replace(/^minecraft:/, "")
      const resolved = resolveNamespace(parentId)
      currentNamespace = resolved.namespace
      currentItem = resolved.item
    }
  } catch {
    stack = [JSON.parse(await readFile("assets/minecraft/models/~missing.json", assets))]
    merged.model = "~missing.json"
  }

  if (merged.special) {
    const resolved = await resolveSpecialModel(assets, merged.special, merged.model)
    if (resolved) {
      stack.push(resolved.model)
      merged.y = 180
      if (resolved.rotation) {
        merged.x = resolved.rotation[0]
        merged.y += resolved.rotation[1]
        merged.z = resolved.rotation[2]
      }
      if (resolved.offset) {
        merged.offset = resolved.offset
      }
    }
    delete merged.special
  }

  for (const layer of stack) {
    for (const key in layer) {
      if (key === "textures") {
        merged.textures ??= {}
        for (const [key, value] of Object.entries(layer.textures)) {
          if (!(key in merged.textures)) {
            merged.textures[key] = value
          }
        }
      } else if (key === "display") {
        if (merged.type === "block") continue
        merged.display ??= {}
        for (const [key, value] of Object.entries(layer.display)) {
          if (!(key in merged.display)) {
            merged.display[key] = value
          }
        }
      } else if (!merged[key]) {
        merged[key] = layer[key]
      }
    }
  }

  function handleNestedTexture(key) {
    if (typeof merged.textures[key] !== "string") {
      merged.textures[key] = merged.textures[key].sprite
      if (!merged.textures[key] || merged.textures[key].startsWith("#")) {
        delete merged.textures[key]
      }
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

  if (normalize(stack[stack.length - 1].parent) === "builtin/generated" && !merged.elements) {
    merged.elements = []
    for (const [key, texRef] of Object.entries(merged.textures)) {
      const match = key.match(/^layer(\d+)$/)
      if (match) {
        const tintIndex = Number(match[1])
        const texId = "#" + key
        const { namespace, item } = resolveNamespace(texRef)
        const image = await loadMinecraftTexture(`assets/${namespace}/textures/${item}.png`, assets)
        const width = image.width
        const height = image.height
        const depth = 16 / Math.max(width, height)
        const elements = []
        const canvas = new Canvas(width, height)
        const ctx = canvas.getContext("2d")
        ctx.drawImage(image, 0, 0, width, height)
        const imageData = ctx.getImageData(0, 0, width, height).data
        
        function isOpaque(x, y) {
          if (x < 0 || x >= width || y < 0 || y >= height) return false
          const i = (y * width + x) * 4
          return imageData[i + 3] >= 1
        }

        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4
            const alpha = imageData[i + 3]
            if (alpha === 0) continue
            
            const x1 = x * depth
            const y1 = 16 - (y + 1) * depth
            const x2 = x1 + depth
            const y2 = y1 + depth
            
            const u1 = x / width * 16
            const v1 = y / height * 16
            const u2 = (x + 1) / width * 16
            const v2 = (y + 1) / height * 16
            
            const faces = {}
            
            if (!isOpaque(x, y - 1)) faces.up = { texture: texId, uv: [u1, v1, u2, v2], tintindex: tintIndex }
            if (!isOpaque(x, y + 1)) faces.down = { texture: texId, uv: [u1, v1, u2, v2], tintindex: tintIndex }
            if (!isOpaque(x - 1, y)) faces.west = { texture: texId, uv: [u1, v1, u2, v2], tintindex: tintIndex }
            if (!isOpaque(x + 1, y)) faces.east = { texture: texId, uv: [u1, v1, u2, v2], tintindex: tintIndex }
            
            faces.north = { texture: texId, uv: [u1, v1, u2, v2], tintindex: tintIndex }
            faces.south = { texture: texId, uv: [u1, v1, u2, v2], tintindex: tintIndex }
            
            merged.elements.push({
              from: [x1, y1, 8 - depth / 2],
              to: [x2, y2, 8 + depth / 2],
              faces: faces
            })
          }
        }
      }
    }
  }

  delete merged.parent
  delete merged.model

  return merged
}

const COLOURS = {
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
}

async function resolveSpecialModel(assets, data, base) {
  if (data.type === "head") {
    data.type = `${data.kind}_${data.kind.includes("skeleton") ? "skull" : "head"}`
  }
  const basePath = base ? "~" + resolveNamespace(base).item : null
  let modelPath
  if (basePath && await fileExists(`assets/minecraft/models/${basePath}.json`, assets)) {
    modelPath = basePath
  } else if (await fileExists(`assets/minecraft/models/~item/${data.type}.json`, assets)) {
    modelPath = `~item/${data.type}`
  } else {
    return
  }
  const model = await resolveModelData(assets, modelPath)
  let offset, rotation
  if (data.type === "banner") {
    model.tints = [COLOURS[data.color]]
  } else if (data.type === "bed") {
    model.textures = {
      bed: `entity/bed/${normalize(data.texture)}`
    }
    rotation = [0, 180, 0]
  } else if (data.type === "chest") {
    model.textures = {
      chest: `entity/chest/${normalize(data.texture)}`
    }
  } else if (data.type === "shulker_box") {
    model.textures = {
      shulker_box: `entity/shulker/${normalize(data.texture)}`
    }
  } else if (data.type === "copper_golem_statue") {
    model.textures = {
      golem: `${normalize(data.texture).slice(9).slice(0, -4)}`
    }
    offset = [0, -3.8]
    rotation = [180, 180, 0]
  }
  return {
    model,
    offset,
    rotation
  }
}

async function makeThreeTexture(img) {
  const texture = await loadTexture(img)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.needsUpdate = true
  return texture
}

export async function loadModel(scene, assets, model, display = "gui") {
  assets = getAssets(assets)

  const textureCache = new Map()

  function resolveTexturePath(id) {
    const { namespace, item } = resolveNamespace(id)
    return `assets/${namespace}/textures/${item}.png`
  }

  async function loadModelTexture(id, tint) {
    if (textureCache.has(id)) return textureCache.get(id)

    let image
    if (id) {
      const path = resolveTexturePath(id)
      image = await loadMinecraftTexture(path, assets)
    } else {
      image = missing
    }

    if (tint) {
      const canvas = new Canvas(image.width, image.height)
      const ctx = canvas.getContext("2d")
      ctx.drawImage(image, 0, 0)
      ctx.globalCompositeOperation = "multiply"
      ctx.fillStyle = COLOURS[tint] ?? tint
      ctx.fillRect(0, 0, image.width, image.height)
      ctx.globalCompositeOperation = "destination-in"
      ctx.drawImage(image, 0, 0)
      image = canvas
    }

    const texture = await makeThreeTexture(image)

    textureCache.set(id, texture)
    return texture
  }

  let settings
  if (typeof display === "object") {
    if (display.type === "fallback" && model.display?.[display.display]) {
      settings = model.display[display.display]
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

  let faceNormals = {
    west:   new THREE.Vector3(-1, 0, 0),
    east:   new THREE.Vector3(1, 0, 0),
    up:     new THREE.Vector3(0, 1, 0),
    down:   new THREE.Vector3(0, -1, 0),
    south:  new THREE.Vector3(0, 0, 1),
    north:  new THREE.Vector3(0, 0, -1)
  }

  const zRot = ((model?.z ?? 0) % 360 + 360) % 360
  for (let i = 0; i < zRot / 90; i++) {
    faceNormals = {
      north: faceNormals.north,
      south: faceNormals.south,
      up: faceNormals.east,
      east: faceNormals.down,
      down: faceNormals.west,
      west: faceNormals.up
    }
  }

  const yRot = ((model?.y ?? 0) % 360 + 360) % 360
  for (let i = 0; i < yRot / 90; i++) {
    faceNormals = {
      up: faceNormals.up,
      down: faceNormals.down,
      north: faceNormals.east,
      east: faceNormals.south,
      south: faceNormals.west,
      west: faceNormals.north
    }
  }

  const xRot = ((model?.x ?? 0) % 360 + 360) % 360
  for (let i = 0; i < xRot / 90; i++) {
    faceNormals = {
      east: faceNormals.east,
      west: faceNormals.west,
      up: faceNormals.north,
      north: faceNormals.down,
      down: faceNormals.south,
      south: faceNormals.up
    }
  }

  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(rotation[0]),
    THREE.MathUtils.degToRad(rotation[1]),
    THREE.MathUtils.degToRad(rotation[2]),
    "YXZ"
  )

  const rotated = Object.fromEntries(
    Object.entries(faceNormals).map(([face, vec]) => [
      face,
      vec.clone().applyEuler(euler)
    ])
  )

  const faceMapping = Object.fromEntries(
   Object.entries(rotated).map(([face, vec]) => {
     const abs = [Math.abs(vec.x), Math.abs(vec.y), Math.abs(vec.z)]
     const max = abs.indexOf(Math.max(...abs))
     return [face, 
       max === 0 ? (vec.x > 0 ? "east" : "west") :
       max === 1 ? (vec.y > 0 ? "up" : "down") :
                   (vec.z > 0 ? "south" : "north")
     ]
   })
  )

  const upColour = [0.988, 0.988, 0.988]
  const downColour = [0.471, 0.471, 0.471]

  const cols = [0.471, 0.494, 0.686, 0.851, 0.988]

  let getFaceColour
  if (model.gui_light === "front") {
    getFaceColour = faceName => {
      const newFace = faceMapping[faceName]

      if (newFace === "up") return upColour
      if (newFace === "down") return downColour

      const normal = rotated[faceName]

      let t = Math.max(0, normal.dot(new THREE.Vector3(0, 0, 1)))

      if (normal.x < 0) {
        t = Math.min(1, (t + 1.2) / 2)
      }
      const linear = Math.asin(t) * 2 / Math.PI

      const scaled = linear * (cols.length - 1)
      const i = Math.floor(scaled)
      const f = scaled - i

      const start = cols[i] ?? cols[cols.length - 1]
      const end = cols[i + 1] ?? cols[cols.length - 1]
      const v = start + (end - start) * f

      return [v, v, v]
    }
  } else {
    getFaceColour = faceName => {
      const newFace = faceMapping[faceName]
      
      if (newFace === "up") return upColour
      if (newFace === "down") return downColour
      
      const normal = rotated[faceName]

      const t = Math.max(0, normal.dot(new THREE.Vector3(-1, 0, 0)))
      const linear = Math.asin(t) * 2 / Math.PI

      const scaled = linear * (cols.length - 1)
      const i = Math.floor(scaled)
      const f = scaled - i

      const start = cols[i] ?? cols[cols.length - 1]
      const end = cols[i + 1] ?? cols[cols.length - 1]
      const v = start + (end - start) * f

      return [v, v, v]
    }
  }

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

  if (model.offset) {
    rootGroup.position.set(...model.offset)
  }

  for (const element of model.elements || []) {
    const from = new THREE.Vector3().fromArray(element.from)
    const to = new THREE.Vector3().fromArray(element.to)
    const size = new THREE.Vector3().subVectors(to, from)

    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z)

    if (element.rotation?.rescale) {
      const angle = Math.abs(element.rotation.angle)
      const rescale = 1 / Math.cos(THREE.MathUtils.degToRad(angle > 45 ? 90 - angle : angle))
      const scale = new THREE.Vector3(rescale, rescale, rescale)
      scale[element.rotation.axis || "y"] = 1
      geometry.scale(scale.x, scale.y, scale.z)
    }

    const faceOrder = ["east", "west", "up", "down", "south", "north"]

    const colorCount = geometry.attributes.position.count
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colorCount * 3), 3))

    for (let i = 0; i < faceOrder.length; i++) {
      const faceName = faceOrder[i]
      const face = element.faces?.[faceName]
      if (!face) continue
      let [u1, v1, u2, v2] = face.uv || []
      if (!face.uv) {
        const [fx, fy, fz] = element.from
        const [tx, ty, tz] = element.to
        if (faceName === "up") {
          u1 = fx
          u2 = tx
          v2 = tz
          v1 = fz
        } else if (faceName === "down") {
          u1 = fx
          u2 = tx
          v2 = 16 - fz
          v1 = 16 - tz
        } else if (faceName === "north") {
          u1 = 16 - tx
          u2 = 16 - fx
          v1 = 16 - ty
          v2 = 16 - fy
        } else if (faceName === "south") {
          u1 = fx
          u2 = tx
          v1 = 16 - ty
          v2 = 16 - fy
        } else if (faceName === "east") {
          u1 = 16 - tz
          u2 = 16 - fz
          v1 = 16 - ty
          v2 = 16 - fy
        } else if (faceName === "west") {
          u1 = fz
          u2 = tz
          v1 = 16 - ty
          v2 = 16 - fy
        }
      }

      let uv = [
        [u1, v1],
        [u2, v1],
        [u1, v2],
        [u2, v2]
      ]

      let rot = face.rotation ?? 0
      if (rot === 90) uv = [uv[2], uv[0], uv[3], uv[1]]
      else if (rot === 180) uv = [uv[3], uv[2], uv[1], uv[0]]
      else if (rot === 270) uv = [uv[1], uv[3], uv[0], uv[2]]

      if (model?.uvlock) {
        let newDirection = faceName
        let x = 0, y = 0
        let angle

        if (model.x) {
          x = ((model.x % 360) + 360) % 360
          angle = 0

          switch (faceName) {
            case "east":
              angle = model.x
              break
            case "west":
              angle = -model.x
              break
            case "north":
              if (x === 90) {
                newDirection = "up"
                angle = 180
              } else if (x === 180) {
                angle = 180
                newDirection = "south"
              } else if (x === 270) {
                angle = 180
                newDirection = "down"
              }
              break
            case "south":
              if (x === 90) {
                newDirection = "down"
              } else if (x === 180) {
                newDirection = "north"
                angle = 180
              } else if (x === 270) {
                newDirection = "up"
              }
              break
            case "up":
              if (x === 90) {
                newDirection = "north"
                angle = 180
              } else if (x === 180) {
                newDirection = "down"
              } else if (x === 270) {
                newDirection = "south"
              }
              break
            case "down":
              if (x === 90) {
                newDirection = "south"
              } else if (x === 180) {
                newDirection = "up"
              } else if (x === 270) {
                angle = 180
                newDirection = "north"
              }
          }

          const center = new THREE.Vector2(8, 8)
          const rad = THREE.MathUtils.degToRad(angle)
          uv = uv.map(([u, v]) => {
            const vec = new THREE.Vector2(u, v)
            vec.rotateAround(center, rad)
            return [vec.x, vec.y]
          })
        }

        if (model.y) {
          y = ((model.y % 360) + 360) % 360

          if (y === 90) {
            if (newDirection === "north") newDirection = "east"
            else if (newDirection === "east") newDirection = "south"
            else if (newDirection === "south") newDirection = "west"
            else if (newDirection === "west") newDirection = "north"
          } else if (y === 180) {
            if (newDirection === "north") newDirection = "south"
            else if (newDirection === "south") newDirection = "north"
            else if (newDirection === "east") newDirection = "west"
            else if (newDirection === "west") newDirection = "east"
          } else if (y === 270) {
            if (newDirection === "north") newDirection = "west"
            else if (newDirection === "west") newDirection = "south"
            else if (newDirection === "south") newDirection = "east"
            else if (newDirection === "east") newDirection = "north"
          }

          if (newDirection === "up" || newDirection === "down") {
            if ((newDirection === "up") ^ !!(x % 180)) {
              angle = model.y
            } else {
              angle = -model.y
            }
            const center = new THREE.Vector2(8, 8)
            const rad = THREE.MathUtils.degToRad(angle)
            uv = uv.map(([u, v]) => {
              const vec = new THREE.Vector2(u, v)
              vec.rotateAround(center, rad)
              return [vec.x, vec.y]
            })
          }
        }

        if (model.z) {
          const z = ((model.z % 360) + 360) % 360
          angle = 0

          switch (newDirection) {
            case "north":
              angle = -model.z
              break
            case "south":
              angle = model.z
              break
            case "up":
              if (z === 90) {
                angle = 90
              } else if (z === 180) {
                angle = 180
              } else if (z === 270) {
                angle = -90
              }
              break
            case "down":
              if (z === 90) {
                angle = 90
              } else if (z === 180) {
                angle = 180
              } else if (z === 270) {
                angle = -90
              }
              break
            case "east":
              if (z === 90) {
                angle = 90
              } else if (z === 180) {
                angle = 180
              } else if (z === 270) {
                angle = -90
              }
              break
            case "west":
              if (z === 90) {
                angle = 90
              } else if (z === 180) {
                angle = 180
              } else if (z === 270) {
                angle = -90
              }
              break
          }

          const center = new THREE.Vector2(8, 8)
          const rad = THREE.MathUtils.degToRad(angle)
          uv = uv.map(([u, v]) => {
            const vec = new THREE.Vector2(u, v)
            vec.rotateAround(center, rad)
            return [vec.x, vec.y]
          })
        }
      }

      geometry.attributes.uv.array.set(uv.flatMap(([u, v]) => [u / 16, 1 - v / 16]), i * 8)

      let colour
      if (element.shade === false) {
        colour = [1, 1, 1]
      } else {
        colour = getFaceColour(faceName)
      }

      for (let j = 0; j < 4; j++) {
        const vertexIndex = (i * 4 + j) * 3
        geometry.attributes.color.array[vertexIndex] = colour[0]
        geometry.attributes.color.array[vertexIndex + 1] = colour[1]
        geometry.attributes.color.array[vertexIndex + 2] = colour[2]
      }
    }
    geometry.attributes.uv.needsUpdate = true
    geometry.attributes.color.needsUpdate = true

    const materials = []
    for (const faceName of faceOrder) {
      const face = element.faces?.[faceName]
      if (!face || !face.texture) {
        materials.push(new THREE.MeshBasicMaterial({ visible: false }))
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

      materials.push(await makeMaterial(await loadModelTexture(texRef, tint), assets, model.shader))
    }

    const mesh = new THREE.Mesh(geometry, materials)
    mesh.position.set(
      from.x + size.x / 2 - 8,
      from.y + size.y / 2 - 8,
      from.z + size.z / 2 - 8
    )

    if (element.rotation) {
      let { origin, axis, angle, x, y, z } = element.rotation
      if (!isNaN(angle) || axis) {
        if (isNaN(angle) || !axis) {
          await loadModel(scene, assets, await resolveModelData(assets, "~missing"), display)
          return
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
        const axisVec = new THREE.Vector3(
          axis === "x" ? 1 : 0,
          axis === "y" ? 1 : 0,
          axis === "z" ? 1 : 0
        )
        rotGroup.rotateOnAxis(axisVec, THREE.MathUtils.degToRad(angle))
      } else {
        rotGroup.rotateZ(THREE.MathUtils.degToRad(-(z ?? 0)))
        rotGroup.rotateY(THREE.MathUtils.degToRad(-(y ?? 0)))
        rotGroup.rotateX(THREE.MathUtils.degToRad(x ?? 0))
      }

      containerGroup.add(rotGroup)
    } else {
      containerGroup.add(mesh)
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
        settings.translation[0],
        settings.translation[1],
        settings.translation[2]
      )
    }
    if (settings.scale) {
      displayGroup.scale.set(
        settings.scale[0],
        settings.scale[1],
        settings.scale[2]
      )
    }
  }

  if (model.transformation) {
    const mat = model.transformation instanceof THREE.Matrix4
      ? model.transformation
      : parseTransformation(model.transformation)
    if (mat) rootGroup.applyMatrix4(mat)
  }

  scene.add(rootGroup)
}

async function makeMaterial(texture, assets, shader) {
  if (shader?.type === "end_portal") {
    const skyPath = await fileExists(`assets/minecraft/textures/environment/end_sky.png`, assets)
    return new THREE.ShaderMaterial({
      uniforms: {
        GameTime: {
          value: 0.727
        },
        Sampler0: {
          value: await makeThreeTexture(await loadImage(skyPath))
        },
        Sampler1: {
          value: texture
        }
      },
      vertexShader: `
        varying vec4 texProj0;

        vec4 projection_from_position(vec4 position) {
          vec4 projection = position * 0.5;
          projection.xy = vec2(projection.x + projection.w, projection.y + projection.w);
          projection.zw = position.zw;
          return projection;
        }

        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

          texProj0 = projection_from_position(gl_Position);
        }
      `,
      fragmentShader: `
        varying vec4 texProj0;

        uniform float GameTime;
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
          vec3 color = texture2DProj(Sampler0, texProj0).rgb * getColor(0);
          for (int i = 0; i < ${shader.layers ?? 15}; i++) {
            color += texture2DProj(Sampler1, texProj0 * vec4(1.0, 16.0 / 9.0, 1.0, 1.0) * end_portal_layer(float(i + 1))).rgb * getColor(i);
          }
          gl_FragColor = vec4(color, 1.0);
        }
      `
    })
  }
  return new THREE.MeshBasicMaterial({
    map: texture,
    vertexColors: true,
    transparent: true,
    alphaTest: 0.01
  })
}