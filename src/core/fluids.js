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

export async function fluidHeights(assets, type, getBlock) {
  const typeAt = (x, y, z) => {
    const c = getBlock(x, y, z)
    return c ? fluidTypeOf(c.id, c.properties) : null
  }
  const solidAt = async (x, z) => {
    const c = getBlock(x, 0, z)
    return !!c && await blockIsSolid(assets, c.id, c.properties)
  }
  const heightAt = async (x, z) => {
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
    const corner = async (a, b, dx, dz) => {
      if (a >= 1 || b >= 1) return 1
      let sum = 0, weight = 0
      const add = h => {
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
  const overlayAt = (dx, dz) => {
    const c = getBlock(dx, 0, dz)
    return !!c && OVERLAY_NEIGHBOR.test(c.id ?? "")
  }
  const overlay = {
    north: overlayAt(0, -1),
    south: overlayAt(0, 1),
    west: overlayAt(-1, 0),
    east: overlayAt(1, 0)
  }
  return { nw, ne, sw, se, full: self >= 1, angle, overlay }
}

const OVERLAY_NEIGHBOR = /(^|:)(\w*(glass|leaves)|(frosted_)?ice|slime_block|honey_block)$/
