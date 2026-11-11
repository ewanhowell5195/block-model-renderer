import test from "node:test"
import assert from "node:assert/strict"
import { prepareAssets, renderBlock, parseBlockstate, parseItemDefinition, resolveModelData, loadModel, getCullFaces, readFile, listDirectory, readTexture, computeSceneLight, warmShaders, getThree } from "../src/node.js"
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

test("calls that put assets after the path, the blocks or the renderer throw", async () => {
  await assert.rejects(readFile("assets/minecraft/blockstates/stone.json", assets), { message: "readFile takes assets first: readFile(assets, path)" })
  await assert.rejects(listDirectory("assets/minecraft/blockstates", assets), { message: "listDirectory takes assets first: listDirectory(assets, dir)" })
  await assert.rejects(readTexture("assets/minecraft/textures/block/stone.png", assets), { message: "readTexture takes assets first: readTexture(assets, path)" })
  await assert.rejects(computeSceneLight([{ id: "torch", pos: [0, 0, 0] }], { assets }), { message: "computeSceneLight takes assets first: computeSceneLight(assets, blocks, options)" })
  await assert.rejects(warmShaders({ compile() {}, info: { programs: [] } }, assets), { message: "warmShaders takes assets first: warmShaders(assets, renderer, args)" })
})

test("assets come first when reading files, textures and light", async () => {
  const file = await readFile(assets, "assets/minecraft/blockstates/stone.json")
  assert.equal(file.path, "assets/minecraft/blockstates/stone.json")
  assert.ok((await listDirectory(assets, "assets/minecraft/blockstates")).includes("stone.json"))
  const texture = await readTexture(assets, "assets/minecraft/textures/block/stone.png")
  assert.equal(texture.image.width, 16)
  const light = await computeSceneLight(assets, [{ id: "torch", pos: [0, 0, 0] }])
  assert.equal(light.lightAt(0, 0, 0).block, 14)
  light.dispose()
})

test("loadModel returns the group and adds it to the parent option", async () => {
  const THREE = await getThree()
  const [reference] = await parseBlockstate(assets, "stone")
  const model = await resolveModelData(assets, reference)
  const alone = await loadModel(assets, model)
  assert.ok(alone instanceof THREE.Group)
  assert.equal(alone.parent, null)
  const parent = new THREE.Group()
  const first = await loadModel(assets, model, { parent, lighting: "world" })
  const second = await loadModel(assets, model, { parent, lighting: "world" })
  assert.equal(parent.children.length, 2)
  assert.equal(parent.children[0], first)
  assert.equal(parent.children[1], second)
  assert.ok(parent.userData.daytime)
  await assert.rejects(loadModel(parent, assets, model), { message: "loadModel takes assets first: loadModel(assets, model, { parent })" })
  await assert.rejects(loadModel(null, assets, model), { message: "loadModel takes assets first: loadModel(assets, model, { parent })" })
})
