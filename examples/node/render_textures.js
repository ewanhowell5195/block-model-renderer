import { renderTexture, prepareAssets } from "../../index.js"
import fs from "node:fs"

const assets = await prepareAssets([
  "C:/Users/ewanh/AppData/Roaming/.minecraft/resourcepacks/26.3-snapshot-3"
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
  "block/stonecutter_saw",
  "gui/sprites/tooltip/background"
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
