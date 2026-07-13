import { normalize, matchId } from "./platform.js"
import blocks from "./data/blocks.json" with { type: "json" }

const makeRules = list => (list ?? []).map(r => ({
  value: r.value,
  suffix: r.suffix,
  exact: new Set(r.exact),
  except: r.except && new Set(r.except)
}))

const EMISSION = makeRules(blocks.lightEmission)
const SHAPE_OCCLUSION = makeRules(blocks.shapeLightOcclusion)

function ruleValue(rules, block, properties, resolveDefault) {
  if (!block) return null
  const id = normalize(block)
  const entry = rules.find(r => matchId(id, r))?.value
  if (entry == null) return null
  if (typeof entry === "number") return entry
  const value = k => {
    const v = properties?.[k] ?? resolveDefault?.(k)
    return v == null ? null : String(v)
  }
  for (const [match, level] of entry.cases) {
    if (Object.entries(match).every(([k, v]) => value(k) === v)) return level
  }
  return entry.default
}

export function getLightEmission(block, properties, resolveDefault) {
  return ruleValue(EMISSION, block, properties, resolveDefault) ?? 0
}

export function usesShapeLightOcclusion(block, properties, resolveDefault) {
  return ruleValue(SHAPE_OCCLUSION, block, properties, resolveDefault) === 1
}
