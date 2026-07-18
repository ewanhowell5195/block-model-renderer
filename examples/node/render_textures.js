import { renderTexture, prepareAssets } from "../../index.js"
import { loadMojangJar } from "./mojang-jar.js"
import fs from "node:fs"

const assets = await prepareAssets([
  await loadMojangJar()
])
const outputDir = `${import.meta.dirname}/renders/textures`

fs.mkdirSync(outputDir, { recursive: true })

const textures = [
  "block/magma",
  "block/water_still",
  "block/lava_still",
  "block/lava_flow",
  "block/fire_0",
  "block/seagrass",
  "block/prismarine",
  "block/sea_lantern",
  "block/stonecutter_saw"
]

for (const texture of textures) {
  const name = texture.split("/").pop()
  await renderTexture({
    texture: `assets/minecraft/textures/${texture}.png`,
    assets,
    width: 64,
    height: 64,
    animated: true,
    path: `${outputDir}/${name}.png`
  })
  console.log("Done texture", name)
}
