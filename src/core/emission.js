import { builtinRules } from "./data.js"

export function getLightEmission(block, properties, resolveDefault, rules = builtinRules) {
  return rules.emission(block, properties, resolveDefault)
}

export function usesShapeLightOcclusion(block, properties, resolveDefault, rules = builtinRules) {
  return rules.shapeOcclusion(block, properties, resolveDefault)
}
