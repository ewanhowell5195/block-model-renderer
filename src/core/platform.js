export let platform, THREE, loadTexture, render, Canvas, loadImage
export let AXIS_VECTORS, UV_CENTER

export function setPlatform(p) {
  platform = p
  ;({ THREE, loadTexture, render, Canvas, loadImage } = p)
  AXIS_VECTORS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }
  UV_CENTER = new THREE.Vector2(8, 8)
}

export const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

export function toBytes(data) {
  if (data instanceof Uint8Array) return data
  if (typeof data === "string") return textEncoder.encode(data)
  return new Uint8Array(data)
}

export function isBefore(version, target) {
  const parse = s => s.split("-")[0].split(".").map(n => +n || 0)
  const a = parse(version), b = parse(target)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0, bv = b[i] ?? 0
    if (av !== bv) return av < bv
  }
  return false
}

export function parseJson(data) {
  return JSON.parse(typeof data === "string" ? data : textDecoder.decode(data))
}

export function resolveNamespace(str) {
  const parts = str.split(":")
  if (parts.length === 2) {
    return { namespace: parts[0], item: parts[1] }
  } else {
    return { namespace: "minecraft", item: str }
  }
}

export function normalize(val) {
  return String(val).replace(/^minecraft:/, "")
}

export function matchId(id, { exact, suffix, except } = {}) {
  if (except?.has(id)) return false
  if (exact?.has(id)) return true
  if (suffix) for (const s of suffix) if (id.endsWith(s)) return true
  return false
}
