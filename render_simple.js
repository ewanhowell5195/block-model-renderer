import { renderBlock, renderItem, renderModel } from "./blockmodel-utils.js"
import fs from "node:fs"

const assets = "C:/Users/ewanh/AppData/Roaming/.minecraft/resourcepacks/26.1"

// Render from blockstate

const block = await renderBlock({
  id: "cactus",
  assets
})

fs.writeFileSync("renders/simple/block.png", block)

// Render from item definition

const item = await renderItem({
  id: "mace",
  assets
})

fs.writeFileSync("renders/simple/item.png", item)


// Render model json

const model = await renderModel({
  model: {
    textures: {
      torch: "block/redstone_torch"
    },
    elements: [
      {
        from: [7, 0, 7],
        to: [9, 10, 9],
        shade: false,
        faces: {
          up:    { uv: [7,  6, 9,  8], texture: "#torch" },
          north: { uv: [7,  6, 9, 16], texture: "#torch" },
          east:  { uv: [7,  6, 9, 16], texture: "#torch" },
        }
      },
      {
        from: [6.5, 10.5, 6.5],
        to: [9.5, 7.5, 9.5],
        shade: false,
        faces: {
          south: { "uv": [7, 5, 8, 6], texture: "#torch" },
          west:  { "uv": [7, 5, 8, 6], texture: "#torch" },
          up:    { "uv": [7, 5, 8, 6], texture: "#torch" }
        }
      }
    ]
  },
  assets
})

fs.writeFileSync("renders/simple/model.png", model)