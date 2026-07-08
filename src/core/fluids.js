import { parseBlockstate, resolveModelData } from "./models.js"


const strip = id => (id ?? "").replace(/^minecraft:/, "")
const TYPE = { water: "water", flowing_water: "water", lava: "lava", flowing_lava: "lava" }

async function blockIsSolid(assets, id, properties) {
  const cache = assets?.cache ? (assets.cache.fluidSolidity ??= new Map()) : null
  const key = id + "|" + JSON.stringify(properties ?? null)
  if (cache?.has(key)) return cache.get(key)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  let any3d = false
  try {
    for (const model of await parseBlockstate(assets, id, { data: properties ?? {}, ignoreAtlases: true })) {
      if (model.fluid) continue
      const data = await resolveModelData(assets, model)
      for (const el of data?.elements ?? []) {
        if (el.from[0] !== el.to[0] && el.from[1] !== el.to[1] && el.from[2] !== el.to[2]) any3d = true
        for (let i = 0; i < 3; i++) {
          lo[i] = Math.min(lo[i], el.from[i], el.to[i])
          hi[i] = Math.max(hi[i], el.from[i], el.to[i])
        }
      }
    }
  } catch {}
  const solid = any3d && ((hi[0] - lo[0] + hi[1] - lo[1] + hi[2] - lo[2]) / 48 >= 0.7291666666666666 || hi[1] - lo[1] >= 16)
  cache?.set(key, solid)
  return solid
}

export function fluidTypeOf(id, properties) {
  const t = TYPE[strip(id)]
  if (t) return t
  if (properties?.waterlogged === true || properties?.waterlogged === "true") return "water"
  return null
}

function ownHeight(id, properties) {
  if (!TYPE[strip(id)]) return 8 / 9
  const level = parseInt(properties?.level ?? 0) || 0
  return (level >= 1 && level <= 7 ? 8 - level : 8) / 9
}

function cellKey(x, y, z) {
  if (!x && !y && !z) return "self"
  let k = y === 1 ? "up" : y === -1 ? "down" : ""
  if (z === -1) k += (k ? "_" : "") + "north"
  else if (z === 1) k += (k ? "_" : "") + "south"
  if (x === -1) k += (k ? "_" : "") + "west"
  else if (x === 1) k += (k ? "_" : "") + "east"
  return k
}

export async function fluidHeights(assets, type, neighbors) {
  function getBlock(x, y, z) {
    const v = neighbors?.[cellKey(x, y, z)] ?? (!x && !y && !z ? type : null)
    if (!v) return null
    if (typeof v === "string") return { id: v }
    const { id, ...properties } = v
    return { id, properties }
  }
  function typeAt(x, y, z) {
    const c = getBlock(x, y, z)
    return c ? fluidTypeOf(c.id, c.properties) : null
  }
  async function solidAt(x, z) {
    const c = getBlock(x, 0, z)
    return !!c && await blockIsSolid(assets, c.id, c.properties)
  }
  async function heightAt(x, z) {
    const c = getBlock(x, 0, z)
    if (c && fluidTypeOf(c.id, c.properties) === type) {
      return typeAt(x, 1, z) === type ? 1 : ownHeight(c.id, c.properties)
    }
    return await solidAt(x, z) ? -1 : 0
  }
  const self = await heightAt(0, 0)
  let nw = 1, ne = 1, sw = 1, se = 1
  if (self < 1) {
    const n = await heightAt(0, -1), s = await heightAt(0, 1), w = await heightAt(-1, 0), e = await heightAt(1, 0)
    async function corner(a, b, dx, dz) {
      if (a >= 1 || b >= 1) return 1
      let sum = 0, weight = 0
      function add(h) {
        if (h >= 0.8) { sum += h * 10; weight += 10 }
        else if (h >= 0) { sum += h; weight++ }
      }
      if (a > 0 || b > 0) {
        const d = await heightAt(dx, dz)
        if (d >= 1) return 1
        add(d)
      }
      add(self)
      add(a)
      add(b)
      return sum / weight
    }
    nw = await corner(n, w, -1, -1)
    ne = await corner(n, e, 1, -1)
    sw = await corner(s, w, -1, 1)
    se = await corner(s, e, 1, 1)
  }
  const selfCell = getBlock(0, 0, 0)
  const selfOwn = selfCell ? ownHeight(selfCell.id, selfCell.properties) : 8 / 9
  let fx = 0, fz = 0
  for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const c = getBlock(dx, 0, dz)
    const t = c ? fluidTypeOf(c.id, c.properties) : null
    let dist = 0
    if (t === type) dist = selfOwn - ownHeight(c.id, c.properties)
    else if (t) continue
    else if (!c || !await blockIsSolid(assets, c.id, c.properties)) {
      const below = getBlock(dx, -1, dz)
      if (below && fluidTypeOf(below.id, below.properties) === type) {
        dist = selfOwn - (ownHeight(below.id, below.properties) - 8 / 9)
      }
    }
    if (dist) {
      fx += dx * dist
      fz += dz * dist
    }
  }
  const angle = fx || fz ? Math.atan2(fz, fx) - Math.PI / 2 : null
  async function overlayAt(dx, dz) {
    const c = getBlock(dx, 0, dz)
    if (!c || fluidTypeOf(c.id, c.properties)) return false
    const dir = dx === 1 ? "west" : dx === -1 ? "east" : dz === 1 ? "north" : "south"
    return faceIsFullToward(assets, c.id, c.properties, dir)
  }
  const overlay = {
    north: await overlayAt(0, -1),
    south: await overlayAt(0, 1),
    west: await overlayAt(-1, 0),
    east: await overlayAt(1, 0)
  }
  const same = {
    north: typeAt(0, 0, -1) === type,
    south: typeAt(0, 0, 1) === type,
    west: typeAt(-1, 0, 0) === type,
    east: typeAt(1, 0, 0) === type,
    up: typeAt(0, 1, 0) === type,
    down: typeAt(0, -1, 0) === type
  }
  return { nw, ne, sw, se, full: self >= 1, angle, overlay, same }
}

const FACE_AXES = { west: [0, 0], east: [0, 16], north: [2, 0], south: [2, 16] }
async function faceIsFullToward(assets, id, properties, dir) {
  const cache = assets?.cache ? (assets.cache.fluidFullFaces ??= new Map()) : null
  const key = id + "|" + JSON.stringify(properties ?? null) + "|" + dir
  if (cache?.has(key)) return cache.get(key)
  const [axis, bound] = FACE_AXES[dir]
  const [t1, t2] = [0, 1, 2].filter(a => a !== axis)
  let full = false
  try {
    outer: for (const model of await parseBlockstate(assets, id, { data: properties ?? {}, ignoreAtlases: true })) {
      if (model.fluid) continue
      const data = await resolveModelData(assets, model)
      for (const el of data?.elements ?? []) {
        const touches = bound === 0 ? Math.min(el.from[axis], el.to[axis]) <= 0 : Math.max(el.from[axis], el.to[axis]) >= 16
        if (touches
          && Math.min(el.from[t1], el.to[t1]) <= 0 && Math.max(el.from[t1], el.to[t1]) >= 16
          && Math.min(el.from[t2], el.to[t2]) <= 0 && Math.max(el.from[t2], el.to[t2]) >= 16) {
          full = true
          break outer
        }
      }
    }
  } catch {}
  cache?.set(key, full)
  return full
}
