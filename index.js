import { makeModelScene, renderModelScene, parseBlockstate, parseItemDefinition, resolveModelData, loadModel } from "./blockmodel-utils.js"
import fs from "node:fs"

const assets = [
  "C:/Users/ewanh/AppData/Roaming/.minecraft/resourcepacks/26.1"
]
const model = "player_head"
const type = "block"
const display = {
  rotation: [30, 225, 0],
  scale: [0.625, 0.625, 0.625],
  type: "fallback",
  display: "gui"
}
const data = {}

const { scene, camera } = makeModelScene()

let models
if (type === "block") {
  models = await parseBlockstate(assets, model, data)
} else {
  models = await parseItemDefinition(assets, model, data, display)
}

for (const model of models) {
  const resolved = await resolveModelData(assets, model)
  await loadModel(scene, assets, resolved, display)
}

const render = await renderModelScene(scene, camera)

fs.writeFileSync("model.png", render)