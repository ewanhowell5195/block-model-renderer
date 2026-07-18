import { builtinRules } from "./data.js"

export function canOcclude(block, rules = builtinRules) {
  return rules.canOcclude(block)
}

export function selfCulls(block, neighbor, direction, properties, neighborProperties, rules = builtinRules) {
  return rules.selfCulls(block, neighbor, direction, properties, neighborProperties)
}
