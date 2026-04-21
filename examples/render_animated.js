import { listDirectory, readFile, makeModelScene, renderModelScene, parseBlockstate, parseItemDefinition, resolveModelData, loadModel, prepareAssets } from "../index.js"
import fs from "node:fs"
import path from "node:path"

const assets = await prepareAssets([
  "C:/Users/ewanh/AppData/Roaming/.minecraft/resourcepacks/26.2-snapshot-3"
])
const outputDir = `${import.meta.dirname}/renders/animated`
const blockDisplay = {
  rotation: [30, 225, 0],
  scale: [0.625, 0.625, 0.625]
}
const itemDisplay = "gui"
const chunkSize = 32

fs.mkdirSync(path.join(outputDir, "blocks"), { recursive: true })
fs.mkdirSync(path.join(outputDir, "items"), { recursive: true })

const blockstateFiles = await listDirectory("assets/minecraft/blockstates", assets).then(arr => arr.filter(f => f.endsWith(".json")))
const itemFiles = await listDirectory("assets/minecraft/items", assets).then(arr => arr.filter(f => f.endsWith(".json")))

async function processChunk(files, handler) {
  for (let i = 0; i < files.length; i += chunkSize) {
    const chunk = files.slice(i, i + chunkSize)
    await Promise.all(chunk.map(handler))
  }
}

async function hasAnimatedTexture(resolved) {
  if (!resolved?.textures) return false
  for (const value of Object.values(resolved.textures)) {
    if (typeof value !== "string" || value.startsWith("#")) continue
    const base = `assets/minecraft/textures/${value.replace(/^minecraft:/, "")}.png`
    const png = await readFile(base, assets)
    if (!png) continue
    const mcmeta = await readFile(`${base}.mcmeta`, assets, png.hintIndex)
    if (!mcmeta) continue
    try {
      const meta = JSON.parse(mcmeta)
      if (meta.animation) return true
    } catch {}
  }
  return false
}

async function handleBlock(file) {
  const modelId = path.basename(file, ".json")
  const models = await parseBlockstate(assets, modelId)
  let animated = false
  const resolvedModels = []
  for (const model of models) {
    const resolved = await resolveModelData(assets, model)
    resolvedModels.push(resolved)
    if (await hasAnimatedTexture(resolved)) animated = true
  }
  if (!animated) return

  const { scene, camera } = makeModelScene()
  for (const resolved of resolvedModels) {
    await loadModel(scene, assets, resolved, { display: blockDisplay })
  }
  await renderModelScene(scene, camera, { path: `${outputDir}/blocks/${modelId}.png`, animated: true })
  console.log("Done block", modelId)
}

async function handleItem(file) {
  const modelId = path.basename(file, ".json")
  const models = await parseItemDefinition(assets, modelId, { display: itemDisplay })
  let animated = false
  const resolvedModels = []
  for (const model of models) {
    const resolved = await resolveModelData(assets, model)
    resolvedModels.push(resolved)
    if (await hasAnimatedTexture(resolved)) animated = true
  }
  if (!animated) return

  const { scene, camera } = makeModelScene()
  for (const resolved of resolvedModels) {
    await loadModel(scene, assets, resolved, { display: itemDisplay })
  }
  await renderModelScene(scene, camera, { path: `${outputDir}/items/${modelId}.png`, animated: true })
  console.log("Done item", modelId)
}

await processChunk(blockstateFiles, handleBlock)
await processChunk(itemFiles, handleItem)
