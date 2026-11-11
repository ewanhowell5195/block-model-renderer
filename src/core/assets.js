import { platform, loadImage, toBytes, isImage, parseJson, textDecoder, normalize, resolveNamespace, isBefore } from "./platform.js"
import { parseZip, parseZipSlices, zipEntryData } from "../zip.js"
import fallbackData from "./data/fallbacks.json" with { type: "json" }
import defaultBlockstatesData from "./data/default_blockstates.json" with { type: "json" }
import preferredBlockstatesData from "./data/default_blockstates_preferred.json" with { type: "json" }

export async function getMissingImage(assets) {
  if (assets.__missingImage) return assets.__missingImage
  return assets.__missingImage = (async () => {
    const buf = await readFile(assets, "assets/block-model-renderer/textures/missing.png")
    return loadImage(buf)
  })()
}

export async function zipEntryFromFiles(files, prefix = "") {
  const index = new Map()
  const indexed = new Set()
  let rootNames = null
  function childrenOf(dir) {
    if (dir === "") {
      if (!rootNames) {
        rootNames = new Set()
        for (const filePath of files.keys()) {
          if (prefix && !filePath.startsWith(prefix)) continue
          const rest = filePath.slice(prefix.length)
          const cut = rest.indexOf("/")
          rootNames.add(cut === -1 ? rest : rest.slice(0, cut))
        }
      }
      return rootNames
    }
    const cut = dir.indexOf("/")
    const top = cut === -1 ? dir : dir.slice(0, cut)
    if (!indexed.has(top)) {
      indexed.add(top)
      const under = prefix + top + "/"
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(under)) continue
        const parts = filePath.slice(prefix.length).split("/")
        let parent = parts[0]
        for (let i = 1; i < parts.length; i++) {
          let children = index.get(parent)
          if (!children) index.set(parent, children = new Set())
          children.add(parts[i])
          parent = `${parent}/${parts[i]}`
        }
      }
    }
    return index.get(dir)
  }

  const entry = {
    zip: true,
    async read(file) {
      const f = files.get(prefix + file)
      if (!f) return null
      if (f.content) return f.content
      const data = f.data ?? await zipEntryData(f)
      return f.content = f.method === 0 ? data : await platform.inflateRaw(data)
    },
    list(dir) {
      return Array.from(childrenOf(dir) ?? [])
    }
  }

  const mcmeta = await entry.read("pack.mcmeta")
  entry.filter = mcmeta ? parsePackFilter(mcmeta) : []
  return entry
}

const LARGE_BLOB = 256 * 1048576

export async function zipAssets(input) {
  let files
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    if (input.size > LARGE_BLOB) {
      files = await parseZipSlices(async (start, end) => new Uint8Array(await input.slice(start, end).arrayBuffer()), input.size)
    } else {
      files = parseZip(new Uint8Array(await input.arrayBuffer()))
    }
  } else {
    files = parseZip(toBytes(input))
  }
  return finishZipAssets(files)
}

export async function zipAssetsFromSlices(slice, size) {
  return finishZipAssets(await parseZipSlices(slice, size))
}

async function finishZipAssets(files) {
  let prefix = ""
  if (!files.has("pack.mcmeta")) {
    const roots = new Set()
    for (const p of files.keys()) roots.add(p.split("/")[0])
    if (!roots.has("assets") && !roots.has("data")) {
      let depth = Infinity
      for (const p of files.keys()) {
        if (!p.endsWith("/pack.mcmeta")) continue
        const d = p.split("/").length
        if (d < depth) {
          depth = d
          prefix = p.slice(0, -"pack.mcmeta".length)
        }
      }
      if (!prefix && roots.size === 1) {
        const [only] = roots
        for (const p of files.keys()) {
          if (p.startsWith(`${only}/assets/`)) {
            prefix = `${only}/`
            break
          }
        }
      }
    }
  }

  return zipEntryFromFiles(files, prefix)
}

function isBinaryEntry(entry) {
  return entry instanceof Uint8Array || entry instanceof ArrayBuffer
    || (typeof Blob !== "undefined" && entry instanceof Blob)
}

export function parsePackFilter(data) {
  try {
    const parsed = parseJson(data)
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

export function overridesRole(name) {
  const m = /^(forced|additional)(?:_(\d+(?:\.\d+)*))?$/.exec(name)
  if (!m) return null
  let versionBefore = null
  if (m[2]) {
    const parts = m[2].split(".")
    parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1)
    versionBefore = parts.join(".")
  }
  return { role: m[1], versionBefore }
}

function entryActive(entry, assets) {
  if (!entry.versionBefore) return true
  return !!assets.version && isBefore(assets.version, entry.versionBefore)
}

export function overlaysStandalone(version) {
  return !!version && isBefore(version, "1.13")
}

function entryVisible(entry, assets, file) {
  if (!entryActive(entry, assets)) return false
  if (entry.overrideRole === "additional" && file.startsWith("assets/minecraft/") && !file.startsWith("assets/minecraft/atlases")) return false
  return true
}

export async function readJsonText(file, assets, overlay) {
  const files = assets.cache ? (assets.cache.jsonText ??= new Map()) : null
  const key = overlay ? "\0" + file : file
  let hit = files?.get(key)
  if (hit === undefined) {
    const buf = await (overlay ? readOverlayFile(file, assets) : readFile(assets, file))
    hit = buf ? { text: typeof buf === "string" ? buf : textDecoder.decode(buf), hintIndex: buf.hintIndex } : null
    files?.set(key, hit)
  }
  return hit
}

export async function readOverlayFile(file, assets) {
  assets = await prepareAssets(assets)
  for (let i = 0; i < assets.length; i++) {
    const entry = assets[i]
    if (entry.overrideRole !== "additional" || !entry.read) continue
    if (!entryActive(entry, assets)) continue
    try {
      const data = await entry.read(file)
      if (data !== undefined && data !== null && data !== false) {
        const buf = toBytes(data)
        buf.path = file
        buf.hintIndex = i
        return buf
      }
    } catch {}
  }
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
    if (!entryActive(entries[j], entries)) continue
    if (await isBlocked(entries[j], filePath)) return true
  }
}

let builtinFiles
function builtinFallbackFiles() {
  return builtinFiles ??= (async () => {
    const files = new Map()
    const enc = new TextEncoder()
    const fallbacks = {
      ...fallbackData,
      "assets/block-model-renderer/default_blockstates.json": defaultBlockstatesData,
      "assets/block-model-renderer/default_blockstates_preferred.json": preferredBlockstatesData
    }
    for (const [p, json] of Object.entries(fallbacks)) files.set(p, { content: enc.encode(JSON.stringify(json)) })
    const M = [248, 0, 248, 255], K = [0, 0, 0, 255]
    const png = await platform.encodeRawToPng({ data: new Uint8Array([...M, ...K, ...K, ...M]), width: 2, height: 2 })
    files.set("assets/block-model-renderer/textures/missing.png", { content: toBytes(png) })
    return files
  })()
}

export async function prepareAssets(assets, opts) {
  if (assets == null || assets.length === 0) throw new Error("prepareAssets requires assets")
  if (Array.isArray(assets) && assets.prepared) {
    if (opts?.version && opts.version !== assets.version) assets = await versionView(assets, opts.version)
    if (opts?.cache && !assets.cache) assets.cache = makeCache()
    if (opts?.translucency) assets.translucency = opts.translucency
    if (opts?.defaults) assets.defaults = opts.defaults
    if (opts?.ignoreAtlases !== undefined) assets.ignoreAtlases = !!opts.ignoreAtlases
    if (opts?.proxy !== undefined) assets.proxy = opts.proxy
    return assets
  }

  let arr
  if (Array.isArray(assets)) arr = assets.slice()
  else if (assets) arr = [assets]
  else arr = []

  const prepared = await Promise.all(arr.map(async entry => {
    if (typeof entry === "string" || isBinaryEntry(entry)) {
      return platform.prepareEntry(entry)
    }
    return entry
  }))
  await platform.addBundledEntries(prepared)
  prepared.push(await zipEntryFromFiles(await builtinFallbackFiles()))
  prepared.prepared = true
  prepared.atlasMembership = new Map()
  prepared.tables = {}
  if (opts?.cache) prepared.cache = makeCache()
  if (opts?.translucency) prepared.translucency = opts.translucency
  if (opts?.version) prepared.version = opts.version
  if (opts?.defaults) prepared.defaults = opts.defaults
  if (opts?.ignoreAtlases) prepared.ignoreAtlases = true
  if (opts?.proxy !== undefined) prepared.proxy = opts.proxy
  await loadAtlases(prepared)
  return prepared
}

function versionView(assets, version) {
  const root = assets.root ?? assets
  if (version === root.version) return root
  const views = root.views ??= { pending: new Map(), ready: [] }
  let view = views.pending.get(version)
  if (!view) views.pending.set(version, view = buildView(root, version))
  return view
}

async function buildView(root, version) {
  const view = Object.assign([], root)
  view.root = root
  view.version = version
  view.atlasMembership = new Map()
  view.tables = {}
  if (root.cache) view.cache = makeCache()
  await loadAtlases(view)
  root.views.ready.push(view)
  return view
}

function makeCache() {
  return { textures: new Map(), models: new Map(), occlusion: new Map() }
}

export function scopedCache(assets) {
  if (assets.cache) return assets
  const scoped = Object.assign([], assets)
  scoped.root = assets.root ?? assets
  scoped.cache = Object.assign(makeCache(), { ephemeral: true })
  return scoped
}

export function disposeCache(assets) {
  if (!Array.isArray(assets)) return
  if (!assets.root) for (const view of assets.views?.ready ?? []) disposeCache(view)
  const c = assets.cache
  if (!c) return
  for (const t of c.textures.values()) { try { t?.dispose?.() } catch {} }
  for (const v of Object.values(c)) if (v instanceof Map) v.clear()
}

export const MASK_DIRS = ["east", "west", "up", "down", "south", "north"]

export async function exportCache(assets) {
  assets = await prepareAssets(assets)
  const cache = assets.cache
  const occlusion = []
  for (const [key, masks] of cache?.occlusion ?? []) {
    if (!masks) { occlusion.push([key, null]); continue }
    const packed = {}
    for (const dir of MASK_DIRS) packed[dir] = masks[dir]
    occlusion.push([key, packed])
  }
  return { files: Array.from(cache?.jsonText ?? []), models: Array.from(cache?.models ?? []), occlusion }
}

export async function importCache(assets, data) {
  assets = await prepareAssets(assets)
  const cache = assets.cache
  if (!cache || !data) return 0
  const files = cache.jsonText ??= new Map()
  let added = 0
  for (const [key, file] of data.files ?? []) {
    if (typeof key !== "string" || files.has(key) || (file !== null && typeof file?.text !== "string")) continue
    files.set(key, file)
    added++
  }
  for (const [key, model] of data.models ?? []) {
    if (typeof key !== "string" || cache.models.has(key) || model == null || typeof model !== "object") continue
    cache.models.set(key, model)
    added++
  }
  for (const [key, packed] of Array.isArray(data.occlusion) ? data.occlusion : []) {
    if (typeof key !== "string" || cache.occlusion.has(key)) continue
    if (packed == null) { cache.occlusion.set(key, null); added++; continue }
    if (!MASK_DIRS.every(dir => packed[dir] instanceof Uint16Array && packed[dir].length === 16)) continue
    const masks = {}
    for (const dir of MASK_DIRS) masks[dir] = packed[dir]
    cache.occlusion.set(key, masks)
    added++
  }
  return added
}

export async function readFileAll(file, assets) {
  assets = await prepareAssets(assets)
  const found = []
  for (let i = 0; i < assets.length; i++) {
    const entry = assets[i]
    if (!entry.read) continue
    if (!entryVisible(entry, assets, file)) continue
    if (await isFilteredByHigher(assets, i, file)) continue
    try {
      const data = await entry.read(file)
      if (data !== undefined && data !== null && data !== false) found.push(toBytes(data))
    } catch {}
  }
  return found
}

async function readEntryText(entry, file) {
  if (!entry.read) return null
  try {
    const d = await entry.read(file)
    if (d === undefined || d === null || d === false) return null
    return typeof d === "string" ? d : textDecoder.decode(toBytes(d))
  } catch { return null }
}

async function loadAtlases(assets) {
  const atlasData = assets.atlasData = new Map()
  const namespaces = await listDirectory(assets, "assets")
  const atlasesByNs = new Map()
  for (const ns of namespaces) {
    const files = await listDirectory(assets, `assets/${ns}/atlases`)
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
    const sprites = new Map()
    atlasData.set(entry, { sources: byAtlas, sprites })
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
  }
}

async function walkTextureDir(dir, assets, out, rel = "", depth = 0) {
  if (depth > 4) return out
  const names = await listDirectory(assets, dir)
  for (const name of names) {
    if (name.endsWith(".png")) out.push(rel + name)
    else if (!name.includes(".")) await walkTextureDir(`${dir}/${name}`, assets, out, `${rel}${name}/`, depth + 1)
  }
  return out
}

export async function listAtlasSprites(assets, ids = ["blocks", "items"]) {
  assets = await prepareAssets(assets)
  const sprites = new Set()
  const namespaces = await listDirectory(assets, "assets")
  for (const entry of assets) {
    for (const id of ids) {
      for (const src of assets.atlasData.get(entry)?.sources.get(id) ?? []) {
        const type = normalize(src.type ?? "")
        if (type === "directory") {
          const source = (src.source ?? "").replace(/\/$/, "")
          for (const ns of namespaces) {
            const base = `assets/${ns}/textures/${source}`
            for (const rel of await walkTextureDir(base, assets, [])) sprites.add(`${base}/${rel}`)
          }
        } else if (type === "single") {
          if (src.resource) sprites.add(spritePathOf(normalize(src.sprite ?? src.resource)))
        } else if (type === "unstitch") {
          for (const region of src.regions ?? []) if (region?.sprite) sprites.add(spritePathOf(region.sprite))
        } else if (type === "paletted_permutations") {
          const separator = src.separator ?? "_"
          for (const tex of src.textures ?? []) {
            const { namespace, item } = resolveNamespace(normalize(tex))
            for (const suffix of Object.keys(src.permutations ?? {})) {
              sprites.add(`assets/${namespace}/textures/${item}${separator}${suffix}.png`)
            }
          }
        } else if (type === "filter") {
          const pattern = src.pattern ?? {}
          const nsRe = pattern.namespace ? new RegExp(pattern.namespace) : null
          const pathRe = pattern.path ? new RegExp(pattern.path) : null
          for (const filePath of Array.from(sprites)) {
            const m = filePath.match(/^assets\/([^/]+)\/textures\/(.+)\.png$/)
            if (!m) continue
            if ((!nsRe || nsRe.test(m[1])) && (!pathRe || pathRe.test(m[2]))) sprites.delete(filePath)
          }
        }
      }
    }
  }
  return Array.from(sprites).sort()
}

function layerDisk(sprites, filePath, fn) {
  const prev = sprites.get(filePath)
  sprites.set(filePath, prev ? memoizeAsync(async () => (await fn()) ?? (await prev())) : fn)
}

function makeEntryReader(entry, diskPath) {
  return memoizeAsync(async () => {
    if (!entry.read) return null
    try {
      const data = await entry.read(diskPath)
      if (data === undefined || data === null || data === false) return null
      return toBytes(data)
    } catch { return null }
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
  return await readFile(assets, "assets/block-model-renderer/textures/missing.png")
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
      const srcBuf = await readFile(assets, srcPath)
      if (!srcBuf) return await getMissingTexturePng(assets)
      try {
        const meta = await platform.getImageSize(srcBuf)
        const xScale = meta.width / divisorX
        const yScale = meta.height / divisorY
        const left = Math.floor(region.x * xScale)
        const top = Math.floor(region.y * yScale)
        const width = Math.floor(region.width * xScale)
        const height = Math.floor(region.height * yScale)
        return await platform.cropToPng(srcBuf, { left, top, width, height })
      } catch {
        return await getMissingTexturePng(assets)
      }
    })
    sprites.set(outPath, generator)
  }
}

export async function remapPalette(baseBuf, keyBuf, palBuf) {
  const key = await platform.decodeToRaw(keyBuf)
  const pal = await platform.decodeToRaw(palBuf)
  const base = await platform.decodeToRaw(baseBuf)

  const keyCount = key.width * key.height
  if (keyCount !== pal.width * pal.height) return null

  const map = new Map()
  for (let p = 0; p < keyCount; p++) {
    if (key.data[p * 4 + 3] === 0) continue
    const rgb = (key.data[p * 4] << 16) | (key.data[p * 4 + 1] << 8) | key.data[p * 4 + 2]
    map.set(rgb, p * 4)
  }

  const out = new Uint8Array(base.data)
  const px = base.width * base.height
  for (let p = 0; p < px; p++) {
    const a = out[p * 4 + 3]
    if (a === 0) continue
    const rep = map.get((out[p * 4] << 16) | (out[p * 4 + 1] << 8) | out[p * 4 + 2])
    if (rep == null) continue
    out[p * 4] = pal.data[rep]
    out[p * 4 + 1] = pal.data[rep + 1]
    out[p * 4 + 2] = pal.data[rep + 2]
    out[p * 4 + 3] = Math.floor((a * pal.data[rep + 3]) / 255)
  }

  return await platform.encodeRawToPng({ data: out, width: base.width, height: base.height })
}

export function readPaletteTexture(id, assets) {
  const { namespace, item } = resolveNamespace(normalize(id))
  const modern = `assets/${namespace}/textures/palettes/${item}.png`
  const legacy = `assets/${namespace}/textures/${item}.png`
  if (assets.version) return readFile(assets, isBefore(assets.version, "26.3") ? legacy : modern)
  return readFile(assets, modern).then(buf => buf ?? readFile(assets, legacy))
}

function applyPalettedPermutationsSource(src, sprites, assets) {
  if (!src.palette_key) return
  const separator = src.separator ?? "_"
  const textures = src.textures ?? []
  const permutations = src.permutations ?? {}

  for (const tex of textures) {
    const basePath = spritePathOf(tex)
    const { namespace: texNs, item: texItem } = resolveNamespace(normalize(tex))
    for (const [suffix, palId] of Object.entries(permutations)) {
      const outPath = `assets/${texNs}/textures/${texItem}${separator}${suffix}.png`
      const generator = memoizeAsync(async () => {
        const [baseBuf, keyBuf, palBuf] = await Promise.all([
          readFile(assets, basePath),
          readPaletteTexture(src.palette_key, assets),
          readPaletteTexture(palId, assets)
        ])
        if (!baseBuf || !keyBuf || !palBuf) return await getMissingTexturePng(assets)
        try {
          return await remapPalette(baseBuf, keyBuf, palBuf) ?? await getMissingTexturePng(assets)
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
    return readFile(assets, diskPath).then(buf => !!buf)
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
    const sources = assets.atlasData?.get(entry)?.sources.get(atlasId)
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

export function getAtlasesContaining(spritePath, assets) {
  const memo = assets.atlasMembership
  if (!memo) return findAtlasesContaining(spritePath, assets)
  const key = (assets.version ?? "") + "\0" + spritePath
  let hit = memo.get(key)
  if (!hit) memo.set(key, hit = findAtlasesContaining(spritePath, assets))
  return hit
}

async function findAtlasesContaining(spritePath, assets) {
  const atlases = new Set()
  const ids = new Set()
  for (const entry of assets) {
    for (const id of assets.atlasData?.get(entry)?.sources.keys() ?? []) ids.add(id)
  }
  await Promise.all(Array.from(ids, async id => {
    if (await isSpriteInAtlas(id, spritePath, assets)) atlases.add(id)
  }))
  return atlases
}

export async function listDirectory(assets, dir) {
  if (!dir) throw new Error("listDirectory requires a directory")
  if (assets == null || assets.length === 0) throw new Error("listDirectory requires assets")
  assets = await prepareAssets(assets)
  const standalone = overlaysStandalone(assets.version)
  const out = new Set()
  for (let i = 0; i < assets.length; i++) {
    const entry = assets[i]
    if (!entryActive(entry, assets)) continue
    let files = []
    if (entry.list) {
      files = (await entry.list(dir)) ?? []
    }
    for (const f of files) {
      if (!standalone && !entryVisible(entry, assets, `${dir}/${f}`)) continue
      if (await isFilteredByHigher(assets, i, `${dir}/${f}`)) continue
      out.add(f)
    }
    const sprites = assets.atlasData?.get(entry)?.sprites
    if (sprites) {
      const prefix = `${dir}/`
      for (const filePath of sprites.keys()) {
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

export async function readFile(assets, file, hint) {
  if (!file) throw new Error("readFile requires a file path")
  if (assets == null || assets.length === 0) throw new Error("readFile requires assets")
  assets = await prepareAssets(assets)
  const range = hint !== undefined ? [hint] : assets.map((_, i) => i)
  for (const i of range) {
    const entry = assets[i]
    if (!entryVisible(entry, assets, file)) continue
    if (await isFilteredByHigher(assets, i, file)) continue

    const resolver = assets.atlasData?.get(entry)?.sprites.get(file)
    if (resolver) {
      const data = await resolver()
      if (data) {
        const buf = toBytes(data)
        buf.path = file
        buf.hintIndex = i
        return buf
      }
    }

    if (entry.read) {
      try {
        const data = await entry.read(file)
        if (data !== undefined && data !== null && data !== false) {
          const buf = isImage(data) ? data : toBytes(data)
          buf.path = file
          buf.hintIndex = i
          return buf
        }
      } catch {}
    }
  }
  if (hint === undefined && overlaysStandalone(assets.version)) return readOverlayFile(file, assets)
}
