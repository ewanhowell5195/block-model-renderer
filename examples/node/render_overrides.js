import { renderBlock, renderItem, listDirectory, parseBlockstate, parseItemDefinition, resolveModelData, prepareAssets, SKIP_BLOCKS } from "block-model-renderer"
import { loadMojangJar } from "./mojang-jar.js"
import fs from "node:fs"
import path from "node:path"

const assets = await prepareAssets([
  await loadMojangJar()
])
const outputDir = `${import.meta.dirname}/renders/overrides`
const chunkSize = 32

fs.rmSync(outputDir, { recursive: true, force: true })
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

async function anyOverridden(models) {
  for (const model of models) {
    const resolved = await resolveModelData(assets, model)
    if (resolved.overridden || !resolved.elements) return true
  }
  return false
}

async function handleBlock(file) {
  const modelId = path.basename(file, ".json")
  if (SKIP_BLOCKS.has(modelId)) return
  if (!await anyOverridden(await parseBlockstate(assets, modelId))) return
  await renderBlock({
    id: modelId,
    assets,
    lighting: "world",
    width: 300,
    height: 300,
    animated: true,
    path: `${outputDir}/blocks/${modelId}.png`
  })
  console.log("Done block", modelId)
}

async function handleItem(file) {
  const modelId = path.basename(file, ".json")
  if (!await anyOverridden(await parseItemDefinition(assets, modelId, { display: "gui" }))) return
  await renderItem({
    id: modelId,
    assets,
    width: 300,
    height: 300,
    animated: true,
    path: `${outputDir}/items/${modelId}.png`
  })
  console.log("Done item", modelId)
}

await processChunk(blockstateFiles, handleBlock)
await processChunk(itemFiles, handleItem)
