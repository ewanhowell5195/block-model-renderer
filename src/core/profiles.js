import { platform, loadImage } from "./platform.js"

const DEFAULT_SKINS = ["alex", "ari", "efe", "kai", "makena", "noor", "steve", "sunny", "zuri"]
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

const profileCache = new Map()
const textureCache = new Map()

function proxied(url, proxy) {
  if (typeof proxy === "string") return proxy + url
  if (typeof proxy === "function") return proxy(url) || url
  return url
}

function cached(cache, key, load) {
  if (!cache.has(key)) {
    cache.set(key, load().catch(() => null).then(value => {
      if (value == null) cache.delete(key)
      return value
    }))
  }
  return cache.get(key)
}

function uuidString(id) {
  if (Array.isArray(id) && id.length === 4) return id.map(n => (n >>> 0).toString(16).padStart(8, "0")).join("")
  if (typeof id === "string" && UUID_RE.test(id)) return id.replace(/-/g, "").toLowerCase()
  return null
}

function defaultSkin(uuid) {
  if (!uuid) return { texture: "entity/player/wide/steve", model: "wide" }
  const most = BigInt.asIntN(64, BigInt("0x" + uuid.slice(0, 16)))
  const least = BigInt.asIntN(64, BigInt("0x" + uuid.slice(16)))
  const hilo = most ^ least
  const hash = Number(BigInt.asIntN(32, hilo >> 32n) ^ BigInt.asIntN(32, hilo))
  const index = ((hash % 18) + 18) % 18
  const model = index < 9 ? "slim" : "wide"
  return { texture: `entity/player/${model}/${DEFAULT_SKINS[index % 9]}`, model }
}

function texturesValue(properties) {
  if (Array.isArray(properties)) return properties.find(p => p?.name === "textures")?.value
  const list = properties?.textures
  if (!Array.isArray(list)) return null
  const first = list[0]
  return typeof first === "string" ? first : first?.Value ?? first?.value
}

function decodeTextures(properties) {
  const value = texturesValue(properties)
  if (!value) return null
  try {
    const json = JSON.parse(typeof atob === "function" ? new TextDecoder().decode(Uint8Array.from(atob(value), c => c.charCodeAt(0))) : Buffer.from(value, "base64").toString("utf8"))
    return json.textures ?? null
  } catch {
    return null
  }
}

async function fetchJson(url, proxy) {
  const res = await fetch(proxied(url, proxy))
  return res.ok ? await res.json() : null
}

function lookupProfile(key, proxy) {
  return cached(profileCache, key, async () => {
    let uuid = uuidString(key)
    if (!uuid) uuid = uuidString((await fetchJson(`https://api.minecraftservices.com/minecraft/profile/lookup/name/${encodeURIComponent(key)}`, proxy))?.id)
    return uuid ? await fetchJson(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`, proxy) : null
  })
}

function httpsUrl(url) {
  return typeof url === "string" ? url.replace(/^http:\/\//, "https://") : null
}

function fetchImage(url, legacySkin, proxy) {
  return cached(textureCache, `${url}\0${legacySkin}`, async () => {
    const res = await fetch(proxied(url, proxy))
    if (!res.ok) return null
    let bytes = new Uint8Array(await res.arrayBuffer())
    if (legacySkin) bytes = await processSkin(bytes)
    return bytes ? await loadImage(bytes) : null
  })
}

async function processSkin(bytes) {
  const raw = await platform.decodeToRaw(bytes)
  if (raw.width !== 64 || (raw.height !== 32 && raw.height !== 64)) return null
  const legacy = raw.height === 32
  const data = new Uint8Array(64 * 64 * 4)
  data.set(raw.data.subarray(0, 64 * raw.height * 4))
  function copyRect(x, y, dx, dy, w, h) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const src = ((y + j) * 64 + x + i) * 4
        const dst = ((y + dy + j) * 64 + x + dx + w - 1 - i) * 4
        data.copyWithin(dst, src, src + 4)
      }
    }
  }
  function setNoAlpha(x0, y0, x1, y1) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[(y * 64 + x) * 4 + 3] = 255
  }
  if (legacy) {
    copyRect(4, 16, 16, 32, 4, 4)
    copyRect(8, 16, 16, 32, 4, 4)
    copyRect(0, 20, 24, 32, 4, 12)
    copyRect(4, 20, 16, 32, 4, 12)
    copyRect(8, 20, 8, 32, 4, 12)
    copyRect(12, 20, 16, 32, 4, 12)
    copyRect(44, 16, -8, 32, 4, 4)
    copyRect(48, 16, -8, 32, 4, 4)
    copyRect(40, 20, 0, 32, 4, 12)
    copyRect(44, 20, -8, 32, 4, 12)
    copyRect(48, 20, -16, 32, 4, 12)
    copyRect(52, 20, -8, 32, 4, 12)
  }
  setNoAlpha(0, 0, 32, 16)
  if (legacy) {
    let opaque = true
    for (let y = 0; y < 32 && opaque; y++) for (let x = 32; x < 64; x++) if (data[(y * 64 + x) * 4 + 3] < 128) { opaque = false; break }
    if (opaque) for (let y = 0; y < 32; y++) for (let x = 32; x < 64; x++) data[(y * 64 + x) * 4 + 3] = 0
  }
  setNoAlpha(0, 16, 64, 32)
  setNoAlpha(16, 48, 48, 64)
  return await platform.encodeRawToPng({ data, width: 64, height: 64 })
}

export async function resolveProfile(assets, profile) {
  if (profile == null) return null
  const proxy = assets?.proxy
  const spec = typeof profile === "string" ? { name: profile } : profile
  let uuid = uuidString(spec.id ?? spec.Id)
  let name = typeof (spec.name ?? spec.Name) === "string" ? spec.name ?? spec.Name : null
  let textures = decodeTextures(spec.properties ?? spec.Properties)
  if (!textures && (uuid || name)) {
    const found = await lookupProfile(uuid ?? name.toLowerCase(), proxy)
    if (found) {
      uuid = uuidString(found.id) ?? uuid
      name = found.name ?? name
      textures = decodeTextures(found.properties)
    }
  }
  const fallback = defaultSkin(uuid)
  const skinUrl = httpsUrl(textures?.SKIN?.url)
  const capeUrl = httpsUrl(textures?.CAPE?.url)
  const model = spec.model ?? (skinUrl ? (textures.SKIN.metadata?.model === "slim" ? "slim" : "wide") : fallback.model)
  const [skinImage, capeImage] = await Promise.all([
    skinUrl && !spec.texture ? fetchImage(skinUrl, true, proxy) : null,
    capeUrl && !spec.cape ? fetchImage(capeUrl, false, proxy) : null
  ])
  return {
    name,
    id: uuid,
    model,
    skin: skinImage ? { image: skinImage } : { texture: spec.texture ?? fallback.texture },
    cape: capeImage ? { image: capeImage } : spec.cape ? { texture: spec.cape } : null
  }
}
