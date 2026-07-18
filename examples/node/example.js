import {
  renderBlock, renderItem, renderModel, prepareAssets, readFile,
  makeModelScene, renderModelScene,
  parseBlockstate, parseItemDefinition, resolveModelData, loadModel
} from "../../index.js"
import { loadMojangJar } from "./mojang-jar.js"
import fs from "node:fs"
import sharp from "sharp"

const vanillaJar = await loadMojangJar()
const assets = await prepareAssets(vanillaJar)

const outDir = `${import.meta.dirname}/renders/example`
fs.mkdirSync(outDir, { recursive: true })

// A basic block render
await renderBlock({
  id: "stone",
  assets,
  path: `${outDir}/block_stone.png`
})

// A block with blockstate properties (log rotated on the X axis)
await renderBlock({
  id: "oak_log",
  blockstates: { axis: "x" },
  assets,
  path: `${outDir}/block_oak_log_x.png`
})

// A block with a colored background
await renderBlock({
  id: "grass_block",
  assets,
  background: "#88CCEE",
  path: `${outDir}/block_grass_background.png`
})

// An item
await renderItem({
  id: "diamond_sword",
  assets,
  path: `${outDir}/item_diamond_sword.png`
})

// An item with components (bow fully drawn)
await renderItem({
  id: "bow",
  components: { using_item: true, use_duration: 20 },
  assets,
  path: `${outDir}/item_bow_drawn.png`
})

// An item with a dyed component (leather armour)
await renderItem({
  id: "leather_helmet",
  components: { dyed_color: "#FF3366" },
  assets,
  path: `${outDir}/item_leather_helmet_dyed.png`
})

// Animated output as WebP (fire has animated textures)
await renderBlock({
  id: "fire",
  assets,
  animated: true,
  path: `${outDir}/block_fire_animated.webp`
})

// Animated output as GIF
await renderBlock({
  id: "magma_block",
  assets,
  animated: "gif",
  path: `${outDir}/block_magma_animated.gif`
})

// A larger render
await renderBlock({
  id: "crafting_table",
  assets,
  width: 1024,
  height: 1024,
  path: `${outDir}/block_crafting_table_large.png`
})

// A custom model JSON (a single torch element)
await renderModel({
  assets,
  model: {
    textures: { torch: "block/redstone_torch" },
    elements: [
      {
        from: [7, 0, 7], to: [9, 10, 9],
        shade: false,
        faces: {
          up:    { uv: [7,  6, 9,  8], texture: "#torch" },
          north: { uv: [7,  6, 9, 16], texture: "#torch" },
          east:  { uv: [7,  6, 9, 16], texture: "#torch" },
        }
      },
      {
        from: [6.5, 10.5, 6.5], to: [9.5, 7.5, 9.5],
        shade: false,
        faces: {
          south: { uv: [7, 5, 8, 6], texture: "#torch" },
          west:  { uv: [7, 5, 8, 6], texture: "#torch" },
          up:    { uv: [7, 5, 8, 6], texture: "#torch" }
        }
      }
    ]
  },
  path: `${outDir}/custom_torch.png`
})

// Virtual asset handler: tint the real stone texture blue at read time. No files
// hit disk, layer it above the real pack and it intercepts just that one path.
const virtualOverride = {
  async read(filePath) {
    if (filePath === "assets/minecraft/textures/block/stone.png") {
      const src = sharp(Buffer.from(await readFile(filePath, assets)))
      const { width, height } = await src.metadata()
      return src.composite([{
        input: { create: { width, height, channels: 4, background: { r: 40, g: 90, b: 255, alpha: 1 } } },
        blend: "multiply"
      }]).png().toBuffer()
    }
    return null
  },
  list() { return [] }
}

await renderBlock({
  id: "stone",
  assets: [virtualOverride, vanillaJar],
  path: `${outDir}/virtual_blue_stone.png`
})

// Simple advanced API: the low-level pipeline for a single block
{
  const { scene, camera } = makeModelScene()
  const display = { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625], type: "fallback", display: "gui" }
  const models = await parseBlockstate(assets, "oak_planks")
  for (const model of models) {
    const resolved = await resolveModelData(assets, model)
    await loadModel(scene, assets, resolved, { display })
  }
  const buf = await renderModelScene(scene, camera)
  fs.writeFileSync(`${outDir}/advanced_simple_scene.png`, buf)
}

// Advanced API: build a scene manually and combine multiple models into one render
{
  const { scene, camera } = makeModelScene()
  const display = { rotation: [30, 225, 0], scale: [0.44, 0.44, 0.44], type: "fallback", display: "gui" }
  for (const [id, x] of [["diamond_block", -16], ["gold_block", 0], ["emerald_block", 16]]) {
    const models = await parseBlockstate(assets, id)
    for (const model of models) {
      const resolved = await resolveModelData(assets, model)
      resolved.translation = [x, 0, 0]
      await loadModel(scene, assets, resolved, { display })
    }
  }
  const buf = await renderModelScene(scene, camera, { width: 318, height: 256 })
  fs.writeFileSync(`${outDir}/advanced_combined_scene.png`, buf)
}

console.log(`Rendered ${fs.readdirSync(outDir).length} images to ${outDir}`)
