import { platform, loadImage, toBytes, parseJson, textDecoder, normalize, resolveNamespace } from "./platform.js"
import { parseZip } from "../zip.js"
import fallbackData from "./data/fallbacks.json" with { type: "json" }

export async function getMissingImage(assets) {
  if (assets.__missingImage) return assets.__missingImage
  return assets.__missingImage = (async () => {
    const buf = await readFile("assets/block-model-renderer/textures/missing.png", assets)
    return loadImage(buf)
  })()
}

export async function zipEntryFromFiles(files, prefix = "") {
  const index = new Map()
  for (const filePath of files.keys()) {
    if (prefix && !filePath.startsWith(prefix)) continue
    const parts = filePath.slice(prefix.length).split("/")
    let dir = ""
    for (let i = 0; i < parts.length; i++) {
      let children = index.get(dir)
      if (!children) index.set(dir, children = new Set())
      children.add(parts[i])
      dir = dir ? `${dir}/${parts[i]}` : parts[i]
    }
  }

  const entry = {
    zip: true,
    async read(file) {
      const f = files.get(prefix + file)
      if (!f) return null
      if (f.content) return f.content
      return f.content = f.method === 0 ? f.data : await platform.inflateRaw(f.data)
    },
    list(dir) {
      return Array.from(index.get(dir) ?? [])
    }
  }

  const mcmeta = await entry.read("pack.mcmeta")
  entry.filter = mcmeta ? parsePackFilter(mcmeta) : []
  return entry
}

export async function zipAssets(input) {
  let bytes
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    bytes = new Uint8Array(await input.arrayBuffer())
  } else {
    bytes = toBytes(input)
  }
  const files = parseZip(bytes)

  let prefix = ""
  const roots = new Set()
  for (const p of files.keys()) roots.add(p.split("/")[0])
  if (!roots.has("assets") && roots.size === 1) {
    const [only] = roots
    for (const p of files.keys()) {
      if (p.startsWith(`${only}/assets/`)) {
        prefix = `${only}/`
        break
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

let builtinFiles
function builtinFallbackFiles() {
  return builtinFiles ??= (async () => {
    const files = new Map()
    const enc = new TextEncoder()
    for (const [p, json] of Object.entries(fallbackData)) files.set(p, { content: enc.encode(JSON.stringify(json)) })
    const M = [248, 0, 248, 255], K = [0, 0, 0, 255]
    const png = await platform.encodeRawToPng({ data: new Uint8Array([...M, ...K, ...K, ...M]), width: 2, height: 2 })
    files.set("assets/block-model-renderer/textures/missing.png", { content: toBytes(png) })
    return files
  })()
}

export async function prepareAssets(assets, opts) {
  if (assets == null || assets.length === 0) throw new Error("prepareAssets requires assets")
  if (Array.isArray(assets) && assets.prepared) {
    if (opts?.cache && !assets.cache) assets.cache = makeCache()
    if (opts?.translucency) assets.translucency = opts.translucency
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
  if (opts?.cache) prepared.cache = makeCache()
  if (opts?.translucency) prepared.translucency = opts.translucency
  await loadAtlases(prepared)
  return prepared
}

function makeCache() {
  return { textures: new Map(), models: new Map(), occlusion: new Map() }
}

export function scopedCache(assets) {
  if (assets.cache) return assets
  const scoped = Object.assign([], assets)
  scoped.cache = Object.assign(makeCache(), { ephemeral: true })
  return scoped
}

export function disposeCache(assets) {
  const c = Array.isArray(assets) ? assets.cache : null
  if (!c) return
  for (const t of c.textures.values()) { try { t?.dispose?.() } catch {} }
  c.textures.clear()
  c.models.clear()
  c.occlusion.clear()
}

export async function readFileAll(file, assets) {
  assets = await prepareAssets(assets)
  const found = []
  for (let i = 0; i < assets.length; i++) {
    const entry = assets[i]
    if (!entry.read) continue
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
  return await readFile("assets/block-model-renderer/textures/missing.png", assets)
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
          const key = await platform.decodeToRaw(keyBuf)
          const pal = await platform.decodeToRaw(palBuf)
          const base = await platform.decodeToRaw(baseBuf)

          const keyCount = key.width * key.height
          const palCount = pal.width * pal.height
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

          const out = new Uint8Array(base.data)
          const px = base.width * base.height
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

          return await platform.encodeRawToPng({ data: out, width: base.width, height: base.height })
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

export async function getAtlasesContaining(spritePath, assets) {
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
  if (!dir) throw new Error("listDirectory requires a directory")
  if (assets == null || assets.length === 0) throw new Error("listDirectory requires assets")
  assets = await prepareAssets(assets)
  const out = new Set()
  for (let i = 0; i < assets.length; i++) {
    const entry = assets[i]
    let files = []
    if (entry.list) {
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
  if (!file) throw new Error("readFile requires a file path")
  if (assets == null || assets.length === 0) throw new Error("readFile requires assets")
  assets = await prepareAssets(assets)
  const range = hint !== undefined ? [hint] : assets.map((_, i) => i)
  for (const i of range) {
    const entry = assets[i]
    if (await isFilteredByHigher(assets, i, file)) continue

    const resolver = entry.virtualSprites?.get(file)
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
          const buf = toBytes(data)
          buf.path = file
          buf.hintIndex = i
          return buf
        }
      } catch {}
    }
  }
}
