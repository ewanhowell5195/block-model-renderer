import test from "node:test"
import assert from "node:assert/strict"
import { prepareAssets, renderBlock, parseBlockstate, parseItemDefinition, getCullFaces } from "../src/node.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const jar = await loadMojangJar()
const assets = await prepareAssets([jar], { cache: true })

test("the old names for block properties and item components throw", async () => {
  await assert.rejects(renderBlock({ id: "oak_log", assets, blockstates: { axis: "x" } }), { message: 'renderBlock: "blockstates" is now "properties"' })
  await assert.rejects(getCullFaces({ id: "oak_log", assets, blockstates: { axis: "x" } }), { message: 'getCullFaces: "blockstates" is now "properties"' })
  await assert.rejects(parseBlockstate(assets, "oak_log", { data: { axis: "x" } }), { message: 'parseBlockstate: "data" is now "properties"' })
  await assert.rejects(parseItemDefinition(assets, "bow", { data: {} }), { message: 'parseItemDefinition: "data" is now "components"' })
})

test("properties and components pick the block state and the item model", async () => {
  const [x] = await parseBlockstate(assets, "oak_log", { properties: { axis: "x" } })
  const [y] = await parseBlockstate(assets, "oak_log", { properties: { axis: "y" } })
  assert.notDeepEqual(x, y)
  const [trimmed] = await parseItemDefinition(assets, "iron_chestplate", { components: { trim: { material: "gold" } } })
  assert.equal(trimmed.model, "minecraft:item/iron_chestplate_gold_trim")
})
