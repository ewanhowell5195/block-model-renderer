import { renderModel, zipAssets } from "../../index.js"
import { loadMojangJar } from "./mojang-jar.js"
import fs from "node:fs"

const jar = await zipAssets(await fs.promises.readFile(await loadMojangJar()))

fs.mkdirSync(`${import.meta.dirname}/renders/fixed`, { recursive: true })

await renderModel({
  assets: {
    async read(filePath) {
      return jar.read(filePath)
    }
  },
  model: {
    textures: {
      side: "block/oak_log",
      end: "block/oak_log_top"
    },
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: {
          up:    { texture: "#end" },
          down:  { texture: "#end" },
          north: { texture: "#side" },
          south: { texture: "#side" },
          east:  { texture: "#side" },
          west:  { texture: "#side" }
        }
      }
    ]
  },
  path: `${import.meta.dirname}/renders/fixed/oak_log.png`
})
