import * as files from "./assets.js"
import * as animation from "./animation.js"
import * as lighting from "./lighting.js"
import * as models from "./models.js"
import * as pack from "./pack.js"
import * as render from "./render.js"
import * as scene from "./scene.js"

function renamed(name, args, old, now) {
  if (args?.[old] !== undefined) throw new Error(`${name}: "${old}" is now "${now}"`)
}

function assetsFirst(wrong, name, params) {
  if (wrong) throw new Error(`${name} takes assets first: ${name}(${params})`)
}

function pathFirst(assets, path) {
  return typeof assets === "string" && path != null && typeof path !== "string"
}

export async function readFile(assets, file, hint) {
  assetsFirst(pathFirst(assets, file), "readFile", "assets, path")
  return files.readFile(assets, file, hint)
}

export async function listDirectory(assets, dir) {
  assetsFirst(pathFirst(assets, dir), "listDirectory", "assets, dir")
  return files.listDirectory(assets, dir)
}

export async function readTexture(assets, path) {
  assetsFirst(pathFirst(assets, path), "readTexture", "assets, path")
  return animation.readTexture(assets, path)
}

export async function computeSceneLight(assets, blocks, options) {
  assetsFirst(blocks?.assets !== undefined || options?.assets !== undefined, "computeSceneLight", "assets, blocks, options")
  return lighting.computeSceneLight(assets, blocks, options)
}

export async function warmShaders(assets, renderer, args) {
  assetsFirst(typeof assets?.compile === "function", "warmShaders", "assets, renderer, args")
  return scene.warmShaders(assets, renderer, args)
}

export async function makeModelScene() {
  return render.makeModelScene()
}

export function reviveScene(payload, opts) {
  renamed("reviveScene", opts, "atlas", "sharedAtlas")
  return pack.reviveScene(payload, opts)
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
