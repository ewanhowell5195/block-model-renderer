import { normalize, matchId } from "./platform.js"
import blocks from "./data/blocks.json" with { type: "json" }

const RULES = blocks.lightEmission.map(r => ({
  value: r.value,
  suffix: r.suffix,
  exact: new Set(r.exact),
  except: r.except && new Set(r.except)
}))

export function getLightEmission(block, properties, resolveDefault) {
  if (!block) return 0
  const id = normalize(block)
  const entry = RULES.find(r => matchId(id, r))?.value
  if (entry == null) return 0
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
