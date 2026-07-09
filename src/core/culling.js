import { normalize, matchId } from "./platform.js"
import blocks from "./data/blocks.json" with { type: "json" }

const rule = r => ({ suffix: r.suffix, exact: new Set(r.exact), except: r.except && new Set(r.except) })
const NON_OCCLUDING = rule(blocks.nonOccluding)
const SELF_CULL_ALL = rule(blocks.selfCullAll)
const SELF_CULL_Y = rule(blocks.selfCullY)

const isFluid = id => /(^|_)(water|lava)$/.test(id)
const fluidFamily = id => id.includes("lava") ? "lava" : "water"

export function canOcclude(block) {
  block = normalize(block)
  return !isFluid(block) && !matchId(block, NON_OCCLUDING)
}

export function selfCulls(block, neighbor, direction) {
  if (!block || !neighbor) return false
  block = normalize(block); neighbor = normalize(neighbor)
  if (isFluid(block) && isFluid(neighbor)) return fluidFamily(block) === fluidFamily(neighbor)
  if (block !== neighbor) return false
  if (matchId(block, SELF_CULL_ALL)) return true
  if (matchId(block, SELF_CULL_Y) && (direction === "up" || direction === "down")) return true
  return false
}
