import { normalize } from "./platform.js"
import blocks from "./data/blocks.json" with { type: "json" }

export function getLightEmission(block, properties, resolveDefault) {
  if (!block) return 0
  const entry = blocks.lightEmission[normalize(block)]
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
