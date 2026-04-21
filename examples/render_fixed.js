import { renderModel } from "../index.js"
import fs from "node:fs"

const packRoot = "C:/Users/ewanh/AppData/Roaming/.minecraft/resourcepacks/26.2-snapshot-3"

fs.mkdirSync(`${import.meta.dirname}/renders/fixed`, { recursive: true })

await renderModel({
  assets: {
    async read(filePath) {
      return fs.promises.readFile(`${packRoot}/${filePath}`)
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
