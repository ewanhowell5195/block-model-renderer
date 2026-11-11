import * as models from "./models.js"
import * as render from "./render.js"

function renamed(name, args, old, now) {
  if (args?.[old] !== undefined) throw new Error(`${name}: "${old}" is now "${now}"`)
}

export async function renderBlock(args) {
  renamed("renderBlock", args, "blockstates", "properties")
  return render.renderBlock(args)
}

export async function getCullFaces(args) {
  renamed("getCullFaces", args, "blockstates", "properties")
  return render.getCullFaces(args)
}

export async function parseBlockstate(assets, blockstate, args) {
  renamed("parseBlockstate", args, "data", "properties")
  return models.parseBlockstate(assets, blockstate, args)
}

export async function parseItemDefinition(assets, itemId, args) {
  renamed("parseItemDefinition", args, "data", "components")
  return models.parseItemDefinition(assets, itemId, args)
}
