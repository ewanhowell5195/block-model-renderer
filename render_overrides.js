import { listDirectory, makeModelScene, renderModelScene, parseBlockstate, parseItemDefinition, resolveModelData, loadModel } from "./blockmodel-utils.js"
import fs from "node:fs"
import path from "node:path"

const assets = [
  "C:/Users/ewanh/AppData/Roaming/.minecraft/resourcepacks/26.1"
]
const outputDir = "renders/overrides"
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

const skip = file => ["air.json", "cave_air.json", "void_air.json"].includes(file)

async function handleBlock(file) {
  if (skip(file)) return
  const modelId = path.basename(file, ".json")
  const { scene, camera } = makeModelScene()
  const models = await parseBlockstate(assets, modelId, {})
  let override
  for (const model of models) {
    const resolved = await resolveModelData(assets, model)
    if (resolved.overridden || !resolved.elements) override = true
    await loadModel(scene, assets, resolved, blockDisplay)
  }
  if (!override) return
  const buffer = await renderModelScene(scene, camera)
  fs.writeFileSync(`${outputDir}/blocks/${modelId}.png`, buffer)
  console.log("Done block", modelId)
}

async function handleItem(file) {
  if (skip(file)) return
  const modelId = path.basename(file, ".json")
  const { scene, camera } = makeModelScene()
  const models = await parseItemDefinition(assets, modelId, {}, itemDisplay)
  let override
  for (const model of models) {
    const resolved = await resolveModelData(assets, model)
    if (resolved.overridden || !resolved.elements) override = true
    await loadModel(scene, assets, resolved, itemDisplay)
  }
  if (!override) return
  const buffer = await renderModelScene(scene, camera)
  fs.writeFileSync(`${outputDir}/items/${modelId}.png`, buffer)
  console.log("Done item", modelId)
}

await processChunk(blockstateFiles, handleBlock)
await processChunk(itemFiles, handleItem)