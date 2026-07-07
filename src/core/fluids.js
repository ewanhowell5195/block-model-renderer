import { canOcclude } from "./culling.js"


const strip = id => (id ?? "").replace(/^minecraft:/, "")
const TYPE = { water: "water", flowing_water: "water", lava: "lava", flowing_lava: "lava" }

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

export function fluidHeights(type, getBlock) {
  const typeAt = (x, y, z) => {
    const c = getBlock(x, y, z)
    return c ? fluidTypeOf(c.id, c.properties) : null
  }
  const heightAt = (x, z) => {
    const c = getBlock(x, 0, z)
    if (c && fluidTypeOf(c.id, c.properties) === type) {
      return typeAt(x, 1, z) === type ? 1 : ownHeight(c.id, c.properties)
    }
    return c && canOcclude(strip(c.id)) ? -1 : 0
  }
  const self = heightAt(0, 0)
  let nw = 1, ne = 1, sw = 1, se = 1
  if (self < 1) {
    const n = heightAt(0, -1), s = heightAt(0, 1), w = heightAt(-1, 0), e = heightAt(1, 0)
    const corner = (a, b, dx, dz) => {
      if (a >= 1 || b >= 1) return 1
      let sum = 0, weight = 0
      const add = h => {
        if (h >= 0.8) { sum += h * 10; weight += 10 }
        else if (h >= 0) { sum += h; weight++ }
      }
      if (a > 0 || b > 0) {
        const d = heightAt(dx, dz)
        if (d >= 1) return 1
        add(d)
      }
      add(self)
      add(a)
      add(b)
      return sum / weight
    }
    nw = corner(n, w, -1, -1)
    ne = corner(n, e, 1, -1)
    sw = corner(s, w, -1, 1)
    se = corner(s, e, 1, 1)
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
    else if (!c || !canOcclude(strip(c.id))) {
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
  return { nw, ne, sw, se, full: self >= 1, angle }
}
