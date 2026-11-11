import test from "node:test"
import assert from "node:assert/strict"
import { prepareAssets, parseItemDefinition } from "../src/node.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const assets = await prepareAssets([await loadMojangJar()], { cache: true })

async function crossbow(components) {
  const [model] = await parseItemDefinition(assets, "crossbow", { components })
  return model.model ?? model
}

test("a crossbow picks its model from what it is charged with", async () => {
  assert.equal(await crossbow({}), "minecraft:item/crossbow")
  assert.equal(await crossbow({ charged_projectiles: [] }), "minecraft:item/crossbow")
  assert.equal(await crossbow({ charged_projectiles: [{ id: "minecraft:arrow", count: 1 }] }), "minecraft:item/crossbow_arrow")
  assert.equal(await crossbow({ charged_projectiles: ["spectral_arrow"] }), "minecraft:item/crossbow_arrow")
  assert.equal(await crossbow({ "minecraft:charged_projectiles": [{ id: "minecraft:arrow" }, { id: "minecraft:firework_rocket" }] }), "minecraft:item/crossbow_firework")
})
