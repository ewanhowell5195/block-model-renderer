import { Canvas, Image, ImageData, loadImage } from "skia-canvas"
import { fileURLToPath } from "node:url"
import getTHREE from "headless-three"
import createContext from "gl"
import sharp from "sharp"
import path from "node:path"
import fs from "node:fs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const { THREE, loadTexture, render } = (await getTHREE({ Canvas, Image, ImageData }))

async function getMissingImage(assets) {
  if (assets.__missingImage) return assets.__missingImage
  return assets.__missingImage = (async () => {
    const buf = await readFile("assets/minecraft/textures/~missing.png", assets)
    return loadImage(buf)
  })()
}

const OUTPUT_DEFAULTS = {
  jpeg: { mozjpeg: true },
  jpg: { mozjpeg: true },
  webp: { lossless: true }
}

const AXIS_VECTORS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }
const UV_CENTER = new THREE.Vector2(8, 8)
const X_CYCLE = { north: "up", up: "south", south: "down", down: "north" }
const Y_CYCLE = { north: "east", east: "south", south: "west", west: "north" }

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

const COLORMAP_BLOCKS = {}
for (const [map, blocks] of Object.entries(COLOURS.colormap)) {
  for (const block of blocks) COLORMAP_BLOCKS[block] = map
}
const FIXED_TINT_BLOCKS = {}
for (const [key, entry] of Object.entries(COLOURS.fixed)) {
  if (entry.blocks) {
    for (const block of entry.blocks) FIXED_TINT_BLOCKS[block] = entry.color
  } else {
    FIXED_TINT_BLOCKS[key] = entry.color
  }
}
const INDEXED_TINT_BLOCKS = {}
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

function parseColor(c) {
  if (typeof c === "string" && c.startsWith("#")) return c
  if (typeof c === "string") c = parseInt(c, 16)
  return "#" + (c >>> 0).toString(16).padStart(8, "0").slice(2)
}

function getPotionColor(potionName) {
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

async function loadFolderFilter(folder) {
  try {
    const data = await fs.promises.readFile(path.join(folder, "pack.mcmeta"), "utf8")
    const parsed = JSON.parse(data)
    const patterns = parsed?.filter?.block ?? []
    return patterns.map(p => ({
      namespaceRegex: p.namespace ? new RegExp(p.namespace) : null,
      pathRegex: p.path ? new RegExp(p.path) : null
    }))
  } catch {
    return []
  }
}

function splitResourcePath(filePath) {
  const parts = filePath.split("/")
  if ((parts[0] === "assets" || parts[0] === "data") && parts.length > 2) {
    return { namespace: parts[1], path: parts.slice(2).join("/") }
  }
  return { namespace: "minecraft", path: filePath }
}

async function isBlocked(entry, filePath) {
  if (!entry) return
  if (typeof entry.filter === "function") return !!(await entry.filter(filePath))
  if (Array.isArray(entry.filter) && entry.filter.length) {
    const { namespace, path: rest } = splitResourcePath(filePath)
    for (const p of entry.filter) {
      const nsMatch = !p.namespaceRegex || p.namespaceRegex.test(namespace)
      const pathMatch = !p.pathRegex || p.pathRegex.test(rest)
      if (nsMatch && pathMatch) return true
    }
  }
}

async function isFilteredByHigher(entries, index, filePath) {
  for (let j = 0; j < index; j++) {
    if (await isBlocked(entries[j], filePath)) return true
  }
}

export async function prepareAssets(assets) {
  if (Array.isArray(assets) && assets.prepared) return assets

  let arr
  if (Array.isArray(assets)) arr = assets.slice()
  else if (assets) arr = [assets]
  else arr = []

  const overridesPath = path.join(__dirname, "assets/overrides")
  const fallbacksPath = path.join(__dirname, "assets/fallbacks")
  const resolvedOverrides = path.resolve(overridesPath)
  const resolvedFallbacks = path.resolve(fallbacksPath)
  const hasFolder = (resolved) => arr.some(p => typeof p === "string" && path.resolve(p) === resolved)
  if (!hasFolder(resolvedOverrides)) arr.unshift(overridesPath)
  if (!hasFolder(resolvedFallbacks)) arr.push(fallbacksPath)

  const prepared = await Promise.all(arr.map(async entry => {
    if (typeof entry === "string") {
      return { path: entry, filter: await loadFolderFilter(entry) }
    }
    return entry
  }))
  prepared.prepared = true
  await loadAtlases(prepared)
  return prepared
}

async function readEntryText(entry, file) {
  if (entry.path) {
    try { return await fs.promises.readFile(path.join(entry.path, file), "utf8") } catch { return null }
  }
  if (entry.read) {
    try {
      const d = await entry.read(file)
      if (d === undefined || d === null || d === false) return null
      return Buffer.isBuffer(d) ? d.toString("utf8") : d
    } catch { return null }
  }
  return null
}

async function loadAtlases(assets) {
  const namespaces = await listDirectory("assets", assets)
  const atlasesByNs = new Map()
  for (const ns of namespaces) {
    const files = await listDirectory(`assets/${ns}/atlases`, assets)
    const ids = files.filter(f => f.endsWith(".json")).map(f => f.slice(0, -5))
    if (ids.length) atlasesByNs.set(ns, ids)
  }

  for (let i = 0; i < assets.length; i++) {
    const entry = assets[i]
    const byAtlas = new Map()
    for (const [ns, ids] of atlasesByNs) {
      for (const id of ids) {
        const text = await readEntryText(entry, `assets/${ns}/atlases/${id}.json`)
        if (!text) continue
        let parsed
        try { parsed = JSON.parse(text) } catch { continue }
        if (!Array.isArray(parsed?.sources)) continue
        let arr = byAtlas.get(id)
        if (!arr) byAtlas.set(id, arr = [])
        arr.push(...parsed.sources)
      }
    }
    entry.atlasSources = byAtlas

    const sprites = new Map()
    for (const [, sources] of byAtlas) {
      for (const src of sources) {
        const type = normalize(src.type ?? "")
        if (type === "unstitch") applyUnstitchSource(src, sprites, assets)
        else if (type === "paletted_permutations") applyPalettedPermutationsSource(src, sprites, assets)
        else if (type === "filter") applyFilterSource(src, sprites)
        else if (type === "directory") applyDirectorySource(src, sprites, entry)
        else if (type === "single") applySingleSource(src, sprites, entry)
      }
    }
    entry.virtualSprites = sprites
  }
}

function layerDisk(sprites, filePath, fn) {
  const prev = sprites.get(filePath)
  sprites.set(filePath, prev ? memoizeAsync(async () => (await fn()) ?? (await prev())) : fn)
}

function makeEntryReader(entry, diskPath) {
  return memoizeAsync(async () => {
    if (entry.path) {
      try { return await fs.promises.readFile(path.join(entry.path, diskPath)) } catch { return null }
    }
    if (entry.read) {
      try {
        const data = await entry.read(diskPath)
        if (data === undefined || data === null || data === false) return null
        return Buffer.isBuffer(data) ? data : Buffer.from(data)
      } catch { return null }
    }
    return null
  })
}

function memoizeAsync(fn) {
  let promise
  return () => (promise ??= Promise.resolve().then(fn))
}

function spritePathOf(id) {
  const { namespace, item } = resolveNamespace(normalize(id))
  return `assets/${namespace}/textures/${item}.png`
}

async function getMissingTexturePng(assets) {
  return await readFile("assets/minecraft/textures/~missing.png", assets)
}

function applyUnstitchSource(src, sprites, assets) {
  if (!src.resource || !Array.isArray(src.regions)) return
  const divisorX = src.divisor_x ?? 1
  const divisorY = src.divisor_y ?? 1
  const srcPath = spritePathOf(src.resource)
  for (const region of src.regions) {
    if (!region?.sprite) continue
    const outPath = spritePathOf(region.sprite)
    const generator = memoizeAsync(async () => {
      const srcBuf = await readFile(srcPath, assets)
      if (!srcBuf) return await getMissingTexturePng(assets)
      try {
        const meta = await sharp(srcBuf).metadata()
        const xScale = meta.width / divisorX
        const yScale = meta.height / divisorY
        const left = Math.floor(region.x * xScale)
        const top = Math.floor(region.y * yScale)
        const width = Math.floor(region.width * xScale)
        const height = Math.floor(region.height * yScale)
        return await sharp(srcBuf).extract({ left, top, width, height }).png().toBuffer()
      } catch {
        return await getMissingTexturePng(assets)
      }
    })
    sprites.set(outPath, generator)
  }
}

function applyPalettedPermutationsSource(src, sprites, assets) {
  if (!src.palette_key) return
  const separator = src.separator ?? "_"
  const keyPath = spritePathOf(src.palette_key)
  const textures = src.textures ?? []
  const permutations = src.permutations ?? {}

  for (const tex of textures) {
    const basePath = spritePathOf(tex)
    const { namespace: texNs, item: texItem } = resolveNamespace(normalize(tex))
    for (const [suffix, palId] of Object.entries(permutations)) {
      const palPath = spritePathOf(palId)
      const outPath = `assets/${texNs}/textures/${texItem}${separator}${suffix}.png`
      const generator = memoizeAsync(async () => {
        const [baseBuf, keyBuf, palBuf] = await Promise.all([
          readFile(basePath, assets),
          readFile(keyPath, assets),
          readFile(palPath, assets)
        ])
        if (!baseBuf || !keyBuf || !palBuf) return await getMissingTexturePng(assets)
        try {
          const key = await sharp(keyBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
          const pal = await sharp(palBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
          const base = await sharp(baseBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })

          const keyCount = key.info.width * key.info.height
          const palCount = pal.info.width * pal.info.height
          if (keyCount !== palCount) return await getMissingTexturePng(assets)

          const map = new Map()
          for (let p = 0; p < keyCount; p++) {
            const ka = key.data[p * 4 + 3]
            if (ka === 0) continue
            const rgb = (key.data[p * 4] << 16) | (key.data[p * 4 + 1] << 8) | key.data[p * 4 + 2]
            map.set(rgb, {
              r: pal.data[p * 4],
              g: pal.data[p * 4 + 1],
              b: pal.data[p * 4 + 2],
              a: pal.data[p * 4 + 3]
            })
          }

          const out = Buffer.from(base.data)
          const px = base.info.width * base.info.height
          for (let p = 0; p < px; p++) {
            const a = out[p * 4 + 3]
            if (a === 0) continue
            const rgb = (out[p * 4] << 16) | (out[p * 4 + 1] << 8) | out[p * 4 + 2]
            const rep = map.get(rgb)
            if (rep) {
              out[p * 4] = rep.r
              out[p * 4 + 1] = rep.g
              out[p * 4 + 2] = rep.b
              out[p * 4 + 3] = Math.floor((a * rep.a) / 255)
            }
          }

          return await sharp(out, { raw: { width: base.info.width, height: base.info.height, channels: 4 } }).png().toBuffer()
        } catch {
          return await getMissingTexturePng(assets)
        }
      })
      sprites.set(outPath, generator)
    }
  }
}

function applyDirectorySource(src, sprites, entry) {
  const source = (src.source ?? "").replace(/\/$/, "")
  const prefix = src.prefix ?? ""
  for (const filePath of sprites.keys()) {
    const m = filePath.match(/^assets\/([^/]+)\/textures\/(.+)\.png$/)
    if (!m) continue
    const [, ns, spriteId] = m
    if (!spriteId.startsWith(prefix)) continue
    const rel = spriteId.slice(prefix.length)
    const diskPath = `assets/${ns}/textures/${source ? source + "/" : ""}${rel}.png`
    layerDisk(sprites, filePath, makeEntryReader(entry, diskPath))
  }
}

function applySingleSource(src, sprites, entry) {
  const resource = normalize(src.resource ?? "")
  if (!resource) return
  const spriteRef = normalize(src.sprite ?? src.resource)
  const outPath = spritePathOf(spriteRef)
  const diskPath = spritePathOf(resource)
  layerDisk(sprites, outPath, makeEntryReader(entry, diskPath))
}

function applyFilterSource(src, sprites) {
  const pattern = src.pattern ?? {}
  const nsRe = pattern.namespace ? new RegExp(pattern.namespace) : null
  const pathRe = pattern.path ? new RegExp(pattern.path) : null
  for (const filePath of sprites.keys()) {
    const m = filePath.match(/^assets\/([^/]+)\/textures\/(.+)\.png$/)
    if (!m) continue
    const [, ns, p] = m
    if ((!nsRe || nsRe.test(ns)) && (!pathRe || pathRe.test(p))) {
      sprites.delete(filePath)
    }
  }
}

function sourceEmitsSprite(src, decomposed, assets) {
  const type = normalize(src.type ?? "")
  const { namespace, spriteId } = decomposed
  if (type === "single") {
    const spriteRef = normalize(src.sprite ?? src.resource ?? "")
    if (!spriteRef) return
    const { namespace: ns, item } = resolveNamespace(spriteRef)
    return ns === namespace && item === spriteId
  }
  if (type === "unstitch") {
    if (!Array.isArray(src.regions)) return
    for (const region of src.regions) {
      if (!region?.sprite) continue
      const { namespace: ns, item } = resolveNamespace(normalize(region.sprite))
      if (ns === namespace && item === spriteId) return true
    }
    return
  }
  if (type === "paletted_permutations") {
    const separator = src.separator ?? "_"
    const textures = src.textures ?? []
    const permutations = src.permutations ?? {}
    for (const tex of textures) {
      const { namespace: ns, item } = resolveNamespace(normalize(tex))
      if (ns !== namespace) continue
      for (const suffix of Object.keys(permutations)) {
        if (`${item}${separator}${suffix}` === spriteId) return true
      }
    }
    return
  }
  if (type === "directory") {
    const source = (src.source ?? "").replace(/\/$/, "")
    const prefix = src.prefix ?? ""
    if (!spriteId.startsWith(prefix)) return
    const rel = spriteId.slice(prefix.length)
    const diskPath = `assets/${namespace}/textures/${source ? source + "/" : ""}${rel}.png`
    return readFile(diskPath, assets).then(buf => !!buf)
  }
}

function filterMatchesSprite(src, decomposed) {
  const pattern = src.pattern ?? {}
  const nsRe = pattern.namespace ? new RegExp(pattern.namespace) : null
  const pathRe = pattern.path ? new RegExp(pattern.path) : null
  if (nsRe && !nsRe.test(decomposed.namespace)) return
  if (pathRe && !pathRe.test(decomposed.spriteId)) return
  return true
}

async function isSpriteInAtlas(atlasId, spritePath, assets) {
  const m = spritePath.match(/^assets\/([^/]+)\/textures\/(.+)\.png$/)
  if (!m) return
  const decomposed = { namespace: m[1], spriteId: m[2] }
  let present = false
  for (let i = assets.length - 1; i >= 0; i--) {
    const entry = assets[i]
    const sources = entry.atlasSources?.get(atlasId)
    if (!sources) continue
    for (const src of sources) {
      const type = normalize(src.type ?? "")
      if (type === "filter") {
        if (filterMatchesSprite(src, decomposed)) present = false
      } else {
        const emits = sourceEmitsSprite(src, decomposed, assets)
        if ((typeof emits?.then === "function" ? await emits : emits)) present = true
      }
    }
  }
  return present
}

async function getAtlasesContaining(spritePath, assets) {
  const atlases = new Set()
  const ids = new Set()
  for (const entry of assets) {
    if (entry.atlasSources) for (const id of entry.atlasSources.keys()) ids.add(id)
  }
  await Promise.all(Array.from(ids, async id => {
    if (await isSpriteInAtlas(id, spritePath, assets)) atlases.add(id)
  }))
  return atlases
}

export async function listDirectory(dir, assets) {
  assets = await prepareAssets(assets)
  const out = new Set()
  for (let i = 0; i < assets.length; i++) {
    const entry = assets[i]
    let files = []
    if (entry.path) {
      try { files = await fs.promises.readdir(path.join(entry.path, dir)) } catch {}
    } else if (entry.list) {
      files = (await entry.list(dir)) ?? []
    }
    for (const f of files) {
      if (await isFilteredByHigher(assets, i, `${dir}/${f}`)) continue
      out.add(f)
    }
    if (entry.virtualSprites) {
      const prefix = `${dir}/`
      for (const filePath of entry.virtualSprites.keys()) {
        if (!filePath.startsWith(prefix)) continue
        const rest = filePath.slice(prefix.length)
        if (rest.includes("/")) continue
        if (await isFilteredByHigher(assets, i, filePath)) continue
        out.add(rest)
      }
    }
  }
  return Array.from(out)
}

export async function readFile(file, assets, hint) {
  assets = await prepareAssets(assets)
  const range = hint !== undefined ? [hint] : assets.map((_, i) => i)
  for (const i of range) {
    const entry = assets[i]
    if (await isFilteredByHigher(assets, i, file)) continue

    const resolver = entry.virtualSprites?.get(file)
    if (resolver) {
      const data = await resolver()
      if (data) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
        buf.path = file
        buf.hintIndex = i
        return buf
      }
    }

    if (entry.path) {
      try {
        const buf = await fs.promises.readFile(path.join(entry.path, file))
        buf.path = file
        buf.hintIndex = i
        return buf
      } catch {}
    } else if (entry.read) {
      try {
        const data = await entry.read(file)
        if (data !== undefined && data !== null && data !== false) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
          buf.path = file
          buf.hintIndex = i
          return buf
        }
      } catch {}
    }
  }
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

  args.assets = await prepareAssets(args.assets)
  const { scene, camera } = makeModelScene()

  const models = await parseBlockstate(args.assets, args.id, { data: args.blockstates, ignoreAtlases: args.ignoreAtlases })

  for (const model of models) {
    const resolved = await resolveModelData(args.assets, model)
    await loadModel(scene, args.assets, resolved, { display: args.display })
  }

  return renderModelScene(scene, camera, args)
}

export async function renderItem(args = {}) {
  args.id ??= ""
  args.assets ??= []
  args.components ??= {}
  args.display ??= {
    type: "fallback",
    display: "gui"
  }

  args.assets = await prepareAssets(args.assets)
  const { scene, camera } = makeModelScene()

  const models = await parseItemDefinition(args.assets, args.id, { data: args.components, display: args.display, ignoreAtlases: args.ignoreAtlases })

  for (const model of models) {
    const resolved = await resolveModelData(args.assets, model)
    await loadModel(scene, args.assets, resolved, { display: args.display })
  }

  return renderModelScene(scene, camera, args)
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

  args.assets = await prepareAssets(args.assets)
  const { scene, camera } = makeModelScene()

  const resolved = await resolveModelData(args.assets, { model: args.model})
  await loadModel(scene, args.assets, resolved, { display: args.display })

  return renderModelScene(scene, camera, args)
}

function resolveAnimatedFormat(animated, format) {
  if (!animated) return null
  if (animated === true) return format === "gif" ? "gif" : "webp"
  return animated
}

function adjustPathForFormat(filePath, format, explicitFormat) {
  if (!filePath || explicitFormat) return filePath
  const formatExt = format === "jpeg" ? "jpg" : format
  const parsed = path.parse(filePath)
  if (parsed.ext.slice(1).toLowerCase() === formatExt) return filePath
  return path.format({ ...parsed, base: undefined, ext: "." + formatExt })
}

export function makeModelScene() {
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-8, 8, 8, -8, 0.01, 100)
  camera.position.set(0, 0, 30)
  camera.lookAt(0, 0, 0)
  camera.fitAspect = true

  return { scene, camera }
}

function fitCameraToAspect(camera, aspect) {
  if (!camera.fitAspect) return
  if (camera.isOrthographicCamera) {
    const halfH = (camera.top - camera.bottom) / 2
    const cx = (camera.left + camera.right) / 2
    const halfW = halfH * aspect
    camera.left = cx - halfW
    camera.right = cx + halfW
  } else if (camera.isPerspectiveCamera) {
    camera.aspect = aspect
  } else return
  camera.updateProjectionMatrix()
}

export async function renderModelScene(scene, camera, args) {
  const baseWidth = args?.width ?? 256
  const baseHeight = args?.height ?? 256

  fitCameraToAspect(camera, baseWidth / baseHeight)

  const animatedTextures = []
  if (args?.animated) {
    scene.traverse(obj => {
      if (!obj.isMesh) return
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
      for (const mat of mats) {
        const tex = mat?.uniforms?.map?.value
        if (tex?.userData?.frames && !animatedTextures.includes(tex)) {
          animatedTextures.push(tex)
        }
      }
    })
  }

  const hasAnimation = animatedTextures.length > 0
  const animFormat = hasAnimation ? resolveAnimatedFormat(args?.animated, args?.format) : null
  const finalFormat = args?.format ?? animFormat
  const finalPath = animFormat ? adjustPathForFormat(args?.path, animFormat, args?.format) : args?.path

  if (!hasAnimation) {
    const buffer = await render({
      scene,
      camera,
      width: baseWidth,
      height: baseHeight,
      path: finalPath,
      format: finalFormat,
      output: args?.output ?? OUTPUT_DEFAULTS[finalFormat],
      background: args?.background,
      colorSpace: THREE.LinearSRGBColorSpace
    })
    return args?.animated ? { buffer, format: "png" } : buffer
  }

  const width = args?.animatedWidth ?? baseWidth
  const height = args?.animatedHeight ?? baseHeight

  fitCameraToAspect(camera, width / height)

  const sharpPixelLimit = 268402689
  const hardFrameCap = Math.floor(sharpPixelLimit / (width * height))
  const maxFrameCount = Math.min(hardFrameCap, args?.maxAnimationFrames ?? 4096)

  let schedules, totalDuration, events, frameCount
  for (let maxSubFrames = 8; maxSubFrames >= 1; maxSubFrames--) {
    schedules = animatedTextures.map(tex => {
      let frames = tex.userData.frames
      let times = tex.userData.times ?? frames.map(() => 1)
      if (tex.userData.interpolate) {
        const exp = expandInterpolated(frames, times, maxSubFrames)
        frames = exp.frames
        times = exp.times
      }
      const total = times.reduce((s, t) => s + t, 0)
      const boundaries = [0]
      let acc = 0
      for (const t of times) {
        acc += t
        boundaries.push(acc)
      }
      return { tex, frames, times, total, boundaries }
    })
    totalDuration = schedules.reduce((acc, s) => {
      let a = acc, b = s.total
      while (b) [a, b] = [b, a % b]
      return (acc * s.total) / a
    }, 1)

    const eventSet = new Set()
    for (const s of schedules) {
      for (let loop = 0; loop * s.total < totalDuration; loop++) {
        for (const b of s.boundaries) {
          const t = loop * s.total + b
          if (t < totalDuration) eventSet.add(t)
        }
      }
    }
    events = Array.from(eventSet).sort((a, b) => a - b)
    frameCount = events.length

    if (frameCount <= maxFrameCount) break
  }

  if (frameCount > maxFrameCount) {
    const longest = Math.max(...schedules.map(s => s.total))
    const cutoff = events[maxFrameCount]
    const snapped = Math.floor(cutoff / longest) * longest
    const idx = snapped > 0 ? events.indexOf(snapped) : -1
    if (idx > 0) {
      events = events.slice(0, idx)
      totalDuration = snapped
      frameCount = events.length
    } else {
      totalDuration = events[maxFrameCount]
      events = events.slice(0, maxFrameCount)
      frameCount = maxFrameCount
    }
  }

  const delay = []
  let delayAcc = 0
  let delayPrev = 0
  for (let f = 0; f < frameCount; f++) {
    const dur = (f + 1 < frameCount ? events[f + 1] : totalDuration) - events[f]
    delayAcc += dur * 50
    const rounded = Math.round(delayAcc)
    delay.push(rounded - delayPrev)
    delayPrev = rounded
  }

  const glCtx = createContext(width, height)
  const renderer = new THREE.WebGLRenderer({ context: glCtx })
  renderer.setSize(width, height)
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace
  if (args?.background != null) {
    const parsed = THREE.headless.parseColor(args.background)
    if (parsed) renderer.setClearColor(parsed.color, parsed.alpha)
  }

  camera.projectionMatrix.elements[5] *= -1
  const gl = renderer.getContext()
  const currentFrontFace = gl.getParameter(gl.FRONT_FACE)
  gl.frontFace(currentFrontFace === gl.CCW ? gl.CW : gl.CCW)

  const stacked = Buffer.alloc(width * height * 4 * frameCount)

  for (let f = 0; f < frameCount; f++) {
    const t = events[f]
    for (const s of schedules) {
      const localT = t % s.total
      let frameIdx = 0
      for (let i = 0; i < s.boundaries.length - 1; i++) {
        if (localT >= s.boundaries[i] && localT < s.boundaries[i + 1]) {
          frameIdx = i
          break
        }
      }
      s.tex.image = s.frames[frameIdx]
      s.tex.needsUpdate = true
    }

    renderer.render(scene, camera)

    const pixels = new Uint8Array(width * height * 4)
    glCtx.readPixels(0, 0, width, height, glCtx.RGBA, glCtx.UNSIGNED_BYTE, pixels)
    Buffer.from(pixels.buffer).copy(stacked, f * width * height * 4)
  }

  gl.frontFace(currentFrontFace)
  camera.projectionMatrix.elements[5] *= -1
  renderer.dispose()
  glCtx.getExtension("STACKGL_destroy_context")?.destroy()

  const MAX_DELAY = 65535
  const frameSize = width * height * 4
  const splitChunks = []
  const splitDelay = []
  for (let f = 0; f < frameCount; f++) {
    const slice = stacked.subarray(f * frameSize, (f + 1) * frameSize)
    let remaining = delay[f]
    while (remaining > MAX_DELAY) {
      splitChunks.push(slice)
      splitDelay.push(MAX_DELAY)
      remaining -= MAX_DELAY
    }
    splitChunks.push(slice)
    splitDelay.push(remaining)
  }
  const finalBuf = splitChunks.length === frameCount ? stacked : Buffer.concat(splitChunks)
  const finalFrameCount = splitDelay.length

  let image = sharp(finalBuf, {
    raw: { width, height: height * finalFrameCount, channels: 4, premultiplied: true, pages: finalFrameCount, pageHeight: height },
  })
  image = image[animFormat === "webp" ? "webp" : "gif"]({ loop: 0, delay: splitDelay, ...(args?.animatedOutput ?? OUTPUT_DEFAULTS[animFormat]) })
  const buffer = await image.toBuffer()
  if (finalPath) await fs.promises.writeFile(finalPath, buffer)
  return { buffer, format: animFormat }
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
  half: ["bottom", "lower"],
  attachment: "floor",
  shape: ["straight", "north_south"],
  age: [7, 6, 5, 4, 3, 2, 1, 0],
  tilt: "none",
  north: false,
  east: false,
  south: false,
  west: false,
  axis: "y",
  face: "wall",
  orientation: "north_up",
  powered: false,
  segment_amount: 4,
  flower_amount: 4,
  rotation: 8,
  lit: false
}

const UNIQUE_DEFAULT_BLOCKSTATES = {
  "*_mushroom_block|mushroom_stem": {
    north: true,
    east: true,
    south: true,
    west: true
  },
  "*_stairs|*_glazed_terracotta|cocoa|repeater|comparator": {
    facing: "south"
  },
  "*_amethyst_bud|amethyst_cluster|barrel|end_rod|*lightning_rod|*piston*|*shulker_box": {
    facing: "up"
  },
  "*campfire|redstone_torch|redstone_wall_torch": {
    lit: true
  },
  "glow_lichen|sculk_vein|resin_clump|chorus_plant": {
    up: false,
    down: true
  },
  grindstone: {
    face: "floor"
  },
  vine: {
    south: true
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
  },
  "bamboo": {
    "leaves": "none"
  },
  "light": {
    level: 15
  }
}

const UNIQUE_DEFAULT_PATTERNS = Object.entries(UNIQUE_DEFAULT_BLOCKSTATES).map(([key, value]) => ({
  patterns: key.split("|").map(pattern => new RegExp("^" + pattern.replace(/\*/g, ".*") + "$")),
  value
}))

function getMultipartDefaults(multipart) {
  const first = {}
  const walk = when => {
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

function getUniqueDefault(blockstate) {
  if (UNIQUE_DEFAULT_BLOCKSTATES[blockstate]) return UNIQUE_DEFAULT_BLOCKSTATES[blockstate]
  for (const { patterns, value } of UNIQUE_DEFAULT_PATTERNS) {
    if (patterns.some(regex => regex.test(blockstate))) return value
  }
  return {}
}

export async function parseBlockstate(assets, blockstate, args) {
  const data = args?.data ?? {}
  assets = await prepareAssets(assets)

  const { namespace, item: block } = resolveNamespace(blockstate)

  const buf = await readFile(`assets/${namespace}/blockstates/${block}.json`, assets)

  if (!buf) {
    return [{ type: "block", model: "~missing", ...(args?.ignoreAtlases && { ignore_atlas_restrictions: true }) }]
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
          const raw = data[k] ?? getUniqueDefault(blockstate)[k] ?? DEFAULT_BLOCKSTATES[k] ?? multipartDefaults[k]
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
    if (args?.ignoreAtlases) model.ignore_atlas_restrictions = true

    if (COLORMAP_BLOCKS[block]) {
      const tint = await getColorMapTint(assets, COLORMAP_BLOCKS[block], 0.5, 1)
      const index = COLOURS.tintindex[block] ?? 0
      model.tints = []
      for (let t = 0; t <= index; t++) model.tints.push(t === index ? tint : "#FFFFFF")
    } else if (FIXED_TINT_BLOCKS[block]) {
      model.tints = [FIXED_TINT_BLOCKS[block]]
    } else if (INDEXED_TINT_BLOCKS[block]) {
      const entry = INDEXED_TINT_BLOCKS[block]
      model.tints = [entry.colors[data[entry.property] ?? entry.default]]
    }

    if (block === "end_portal" || block == "end_gateway") {
      model.shader = {
        type: "end_portal",
        layers: block === "end_portal" ? 15 : 16
      }
    }
  }

  if (data?.waterlogged && (WATERLOGGABLE_EXACT.has(block) || WATERLOGGABLE_SUFFIXES.some(s => block.endsWith(s)))) {
    models.push({
      model: "minecraft:block/water",
      type: "block",
      tints: ["#3F76E4"],
      scale: [0.999, 0.999, 0.999]
    })
  }

  return models
}

function normalize(val) {
  return String(val).replace(/^minecraft:/, "")
}

async function getColorMapTint(assets, mapName, temperature, downfall) {
  if (isNaN(temperature) || isNaN(downfall)) return "#FF00FF"

  const buf = await readFile(`assets/minecraft/textures/colormap/${mapName}.png`, assets)
  if (!buf) return "#FFFFFF"

  const image = await loadImage(buf)
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

export async function parseItemDefinition(assets, itemId, args) {
  const data = args?.data ?? {}
  const display = args?.display ?? "gui"
  assets = await prepareAssets(assets)

  const { namespace, item } = resolveNamespace(itemId)

  const buf = await readFile(`assets/${namespace}/items/${item}.json`, assets)

  if (!buf) {
    return [{ type: "item", model: "~missing", ...(args?.ignoreAtlases && { ignore_atlas_restrictions: true }) }]
  }

  const json = JSON.parse(buf)

  const normalizedData = {}
  for (const key in data) normalizedData[normalize(key)] = data[key]
  const models = await resolveItemModel(assets, json.model, normalizedData, display)
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    model.type = "item"
    if (args?.ignoreAtlases) model.ignore_atlas_restrictions = true
    if (model.tints) {
      const tints = []
      for (const tint of model.tints) {
        if (typeof tint === "string") {
          tints.push(tint)
          continue
        }
        const type = normalize(tint.type)
        if (type === "team" && data["team"] !== undefined) {
          const teamColor = COLOURS.team[normalize(data["team"])]
          tints.push(teamColor !== undefined ? parseColor(teamColor) : parseColor(tint.default ?? 16777215))
        } else if (type === "dye" && data["dyed_color"] !== undefined) {
          tints.push(parseColor(data["dyed_color"]))
        } else if (type === "map_color" && data["map_color"] !== undefined) {
          tints.push(parseColor(data["map_color"]))
        } else if (type === "potion" && data["potion_contents"]?.potion) {
          const color = getPotionColor(data["potion_contents"].potion)
          tints.push(color ?? parseColor(tint.default ?? -13083194))
        } else if (type === "custom_model_data" && data["custom_model_data"]?.colors) {
          const c = data["custom_model_data"].colors[tint.index ?? 0]
          if (c !== undefined) {
            tints.push(parseColor(c))
          } else {
            tints.push(tint.default !== undefined ? parseColor(tint.default) : "#FFFFFF")
          }
        } else if (type === "firework" && data["firework_explosion"]?.colors?.length) {
          const colors = data["firework_explosion"].colors.map(c => {
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

async function resolveItemModel(assets, def, data, display, accTransform) {
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
        const nested = await resolveItemModel(assets, model, data, display, currentTransform)
        result.push(...nested)
      }
      return result
    }

    if (type === "select") {
      const prop = normalize(def.property)
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
      const prop = normalize(def.property)
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
      const prop = normalize(def.property)
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
    meta = JSON.parse(await readFile(path + ".mcmeta", assets, buf.hintIndex)).animation ?? {}
  } catch {
    return { image }
  }

  return buildAnimation(image, meta)
}

function buildAnimation(image, meta) {
  const defaultSize = Math.min(image.width, image.height)
  const cropW = meta.width ?? defaultSize
  const cropH = meta.height ?? defaultSize

  const cols = Math.max(1, Math.floor(image.width / cropW))
  const rows = Math.max(1, Math.floor(image.height / cropH))
  const frameCount = cols * rows
  const stripFrames = []
  for (let i = 0; i < frameCount; i++) {
    const sx = (i % cols) * cropW
    const sy = Math.floor(i / cols) * cropH
    const canvas = new Canvas(cropW, cropH)
    const ctx = canvas.getContext("2d")
    ctx.drawImage(image, sx, sy, cropW, cropH, 0, 0, cropW, cropH)
    stripFrames.push(canvas)
  }

  const defaultTime = meta.frametime ?? 1
  let playback
  let playbackTimes
  if (Array.isArray(meta.frames)) {
    playback = []
    playbackTimes = []
    for (const entry of meta.frames) {
      const index = typeof entry === "number" ? entry : entry.index
      const time = typeof entry === "number" ? defaultTime : (entry.time ?? defaultTime)
      const canvas = stripFrames[index]
      if (!canvas) continue
      playback.push(canvas)
      playbackTimes.push(time)
    }
  }
  if (!playback?.length) {
    playback = stripFrames
    playbackTimes = stripFrames.map(() => defaultTime)
  }

  return { image: playback[0], frames: playback, times: playbackTimes, interpolate: !!meta.interpolate, animated: playback.length > 1 }
}

function applyTint(img, tint) {
  const canvas = new Canvas(img.width, img.height)
  const ctx = canvas.getContext("2d")
  ctx.drawImage(img, 0, 0)
  ctx.globalCompositeOperation = "multiply"
  ctx.fillStyle = COLOURS.dye[tint] ?? tint
  ctx.fillRect(0, 0, img.width, img.height)
  ctx.globalCompositeOperation = "destination-in"
  ctx.drawImage(img, 0, 0)
  return canvas
}

function expandInterpolated(frames, times, maxSubFrames) {
  const expanded = []
  const expandedTimes = []
  for (let i = 0; i < frames.length; i++) {
    const a = frames[i]
    const b = frames[(i + 1) % frames.length]
    const time = times[i]
    const steps = Math.min(time, maxSubFrames)
    const subTime = time / steps
    for (let t = 0; t < steps; t++) {
      expanded.push(interpolateFrames(a, b, t / steps))
      expandedTimes.push(subTime)
    }
  }
  return { frames: expanded, times: expandedTimes }
}

function interpolateFrames(a, b, ratio) {
  const canvas = new Canvas(a.width, a.height)
  const ctx = canvas.getContext("2d")
  const da = a.getContext("2d").getImageData(0, 0, a.width, a.height).data
  const db = b.getContext("2d").getImageData(0, 0, b.width, b.height).data
  const out = ctx.createImageData(a.width, a.height)
  const inv = 1 - ratio
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i]     = Math.round(da[i]     * inv + db[i]     * ratio)
    out.data[i + 1] = Math.round(da[i + 1] * inv + db[i + 1] * ratio)
    out.data[i + 2] = Math.round(da[i + 2] * inv + db[i + 2] * ratio)
    out.data[i + 3] = da[i + 3]
  }
  ctx.putImageData(out, 0, 0)
  return canvas
}

export async function resolveModelData(assets, model) {
  assets = await prepareAssets(assets)

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

        const overridesPath = path.resolve(path.join(__dirname, "assets/overrides"))
        const sourceEntry = assets[buf.hintIndex]
        if (sourceEntry?.path && path.resolve(sourceEntry.path) === overridesPath) {
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

  if (normalize(stack[stack.length - 1].parent) === "builtin/generated") {
    if (!merged.gui_light) {
      merged.gui_light = "front"
    }

    if (!merged.elements) {
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
          const elements = []
          const alphaMask = new Uint8Array(width * height)
          const sourceFrames = loaded.frames ?? [image]
          const probe = new Canvas(width, height)
          const pctx = probe.getContext("2d")
          for (const frame of sourceFrames) {
            pctx.clearRect(0, 0, width, height)
            pctx.drawImage(frame, 0, 0, width, height)
            const fdata = pctx.getImageData(0, 0, width, height).data
            for (let p = 0; p < width * height; p++) {
              if (fdata[p * 4 + 3] >= 1) alphaMask[p] = 1
            }
          }

          function isOpaque(x, y) {
            if (x < 0 || x >= width || y < 0 || y >= height) return
            return alphaMask[y * width + x] === 1
          }

          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              if (!isOpaque(x, y)) continue
              
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
  }

  delete merged.parent
  delete merged.model

  return merged
}


async function resolveSpecialModel(assets, data, base) {
  const originalType = data.type

  if (data.type === "head") {
    data.type = `${data.kind}_${data.kind.includes("skeleton") ? "skull" : "head"}`
  } else if (data.type === "standing_sign" && data.attachement) {
    data.type = `standing_sign_${data.attachement}`
  } else if (data.type === "hanging_sign" && data.attachment) {
    data.type = `hanging_sign_${data.attachment}`
  }

  let modelPath
  if (originalType === "chest" && data.chest_type && data.chest_type !== "single") {
    modelPath = `~block/chest/_template_chest_${data.chest_type}`
  } else if (originalType === "copper_golem_statue" && data.pose && data.pose !== "standing") {
    modelPath = `~block/copper_golem_statue/_template_copper_golem_statue_${data.pose}`
  } else {
    const basePath = base ? "~" + resolveNamespace(base).item : null
    if (basePath && await readFile(`assets/minecraft/models/${basePath}.json`, assets)) {
      modelPath = basePath
    } else if (await readFile(`assets/minecraft/models/~item/${data.type}.json`, assets)) {
      modelPath = `~item/${data.type}`
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
      model.tints = [COLOURS.dye[data.color]]
      break
    case "standing_sign":
      model.textures = { sign: data.texture ? normalize(data.texture) : `entity/signs/${normalize(data.wood_type)}` }
      break
    case "hanging_sign":
      model.textures = { sign: data.texture ? normalize(data.texture) : `entity/signs/hanging/${normalize(data.wood_type)}` }
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
  texture.colorSpace = THREE.NoColorSpace
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  return texture
}

async function modelPassesAtlasRules(model, assets) {
  if (model.type !== "block" && model.type !== "item") return true
  if (model.ignore_atlas_restrictions) return true
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
  const display = args?.display ?? "gui"
  assets = await prepareAssets(assets)

  if (!(await modelPassesAtlasRules(model, assets))) {
    const missing = await resolveModelData(assets, { model: "~missing" })
    for (const k of Object.keys(model)) delete model[k]
    Object.assign(model, missing)
  }

  const textureCache = new Map()

  function resolveTexturePath(id) {
    const { namespace, item } = resolveNamespace(id)
    return `assets/${namespace}/textures/${item}.png`
  }

  async function loadModelTexture(id, tint) {
    const cacheKey = `${id ?? ""}\0${tint ?? ""}`
    if (textureCache.has(cacheKey)) return textureCache.get(cacheKey)

    let loaded
    if (id) {
      const path = resolveTexturePath(id)
      loaded = await loadMinecraftTexture(path, assets, model.ignore_atlas_restrictions ? undefined : model.type)
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
    if (loaded.animated && frames) {
      texture.userData.frames = frames
      texture.userData.times = loaded.times
      texture.userData.interpolate = loaded.interpolate
    }

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

  if (model.translation) {
    containerGroup.position.set(...model.translation)
  }

  if (model.scale) {
    containerGroup.scale.set(...model.scale)
  }

  for (const element of model.elements || []) {
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

    for (let i = 0; i < faceOrder.length; i++) {
      const faceName = faceOrder[i]
      const face = element.faces?.[faceName]
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

        const rotateUV = angle => {
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

      materials.push(await makeMaterial(await loadModelTexture(texRef, tint), assets, model.shader, model.double_sided, element.shade !== false, lightConfig))
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
          await loadModel(scene, assets, await resolveModelData(assets, "~missing"), { display })
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
        rotGroup.rotateOnAxis(AXIS_VECTORS[axis], THREE.MathUtils.degToRad(angle))
      } else {
        rotGroup.rotateZ(THREE.MathUtils.degToRad(z ?? 0))
        rotGroup.rotateY(THREE.MathUtils.degToRad(y ?? 0))
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
    if (mat) {
      const wrapped = new THREE.Matrix4()
        .makeTranslation(-8, -8, -8)
        .multiply(mat)
        .multiply(new THREE.Matrix4().makeTranslation(8, 8, 8))
      containerGroup.applyMatrix4(wrapped)
    }
  }

  scene.add(rootGroup)

  rootGroup.updateMatrixWorld(true)
  rootGroup.traverse(obj => {
    if (obj.isMesh) {
      const positions = obj.geometry.attributes.position
      let maxZ = -Infinity
      const v = new THREE.Vector3()
      for (let i = 0; i < positions.count; i++) {
        v.fromBufferAttribute(positions, i)
        v.applyMatrix4(obj.matrixWorld)
        if (v.z > maxZ) maxZ = v.z
      }
      obj.renderOrder = maxZ
    }
  })
}

async function makeMaterial(texture, assets, shader, doubleSided, shadeEnabled, lightConfig) {
  if (shader?.type === "end_portal") {
    const skyBuf = await readFile(`assets/minecraft/textures/environment/end_sky.png`, assets)
    return new THREE.ShaderMaterial({
      uniforms: {
        GameTime: {
          value: 0.727
        },
        Sampler0: {
          value: await makeThreeTexture(await loadImage(skyBuf))
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
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      light0: { value: new THREE.Vector3(...(lightConfig?.light0 ?? [0, 0, 1])) },
      light1: { value: new THREE.Vector3(...(lightConfig?.light1 ?? [0, 1, 0])) },
      d0: { value: lightConfig?.d0 ?? 0.6 },
      d1: { value: lightConfig?.d1 ?? 0.6 },
      ambient: { value: lightConfig?.ambient ?? 0.4 },
      shadeEnabled: { value: shadeEnabled !== false },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vNormal;
      void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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
      varying vec2 vUv;
      varying vec3 vNormal;
      void main() {
        if (vUv.x < 0.0 || vUv.x > 1.0 || vUv.y < 0.0 || vUv.y > 1.0) discard;
        vec4 texColor = texture2D(map, vUv);
        if (texColor.a < 0.01) discard;
        float shade = 1.0;
        if (shadeEnabled) {
          shade = min(1.0, ambient + d0 * max(0.0, dot(vNormal, light0)) + d1 * max(0.0, dot(vNormal, light1)));
        }
        gl_FragColor = vec4(texColor.rgb * shade, texColor.a);
      }
    `,
    transparent: true,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  })
}