import test from "node:test"
import assert from "node:assert/strict"
import { prepareAssets, renderBlock, renderItem, parseBlockstate, parseItemDefinition, resolveModelData, loadModel, readFile, listDirectory, readTexture, computeSceneLight, createScene, getThree } from "../src/node.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const jar = await loadMojangJar()
const assets = await prepareAssets([jar], { cache: true })

test("properties and components pick the block state and the item model", async () => {
  const [x] = await parseBlockstate(assets, "oak_log", { properties: { axis: "x" } })
  const [y] = await parseBlockstate(assets, "oak_log", { properties: { axis: "y" } })
  assert.notDeepEqual(x, y)
  const [trimmed] = await parseItemDefinition(assets, "iron_chestplate", { components: { trim: { material: "gold" } } })
  assert.equal(trimmed.model, "minecraft:item/iron_chestplate_gold_trim")
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
})

test("prepareAssets carries version and defaults into every call", async () => {
  const pinned = await prepareAssets([jar], { version: "1.21.4", defaults: "game" })
  const [stone] = await parseBlockstate(pinned, "stone")
  assert.equal(stone.version, "1.21.4")
  const [item] = await parseItemDefinition(pinned, "stone")
  assert.equal(item.version, "1.21.4")
  const [gameStairs] = await parseBlockstate(pinned, "oak_stairs")
  const [preferredStairs] = await parseBlockstate(assets, "oak_stairs")
  assert.equal(preferredStairs.version, undefined)
  assert.notEqual(gameStairs.y ?? 0, preferredStairs.y ?? 0)
})

test("ignoreAtlases on prepareAssets lifts the atlas rules for blocks, items and scenes", async () => {
  const pack = { read: file => file === "assets/minecraft/models/block/stone.json" ? JSON.stringify({ parent: "block/cube_all", textures: { all: "painting/kebab" } }) : null }
  const strict = await prepareAssets([pack, jar])
  const loose = await prepareAssets([pack, jar], { ignoreAtlases: true })
  assert.equal((await parseBlockstate(strict, "stone"))[0].ignore_atlas_restrictions, undefined)
  assert.equal((await parseBlockstate(loose, "stone"))[0].ignore_atlas_restrictions, true)
  assert.equal((await parseItemDefinition(loose, "stone"))[0].ignore_atlas_restrictions, true)
  const size = { width: 32, height: 32 }
  assert.notDeepEqual(await renderBlock({ id: "stone", assets: loose, ...size }), await renderBlock({ id: "stone", assets: strict, ...size }))
  assert.notDeepEqual(await renderItem({ id: "stone", assets: loose, ...size }), await renderItem({ id: "stone", assets: strict, ...size }))
  const widths = []
  for (const source of [strict, loose]) {
    const handle = await createScene(source, [{ id: "stone", pos: [0, 0, 0] }], { lighting: "item", optimize: false })
    handle.group.traverse(o => { if (o.isMesh) widths.push([].concat(o.material)[0].uniforms.map.value.image.width) })
    handle.dispose()
  }
  assert.deepEqual(widths, [2, 16])
})

test("prepared assets refuse a second version instead of ignoring it", async () => {
  const pinned = await prepareAssets([jar], { version: "1.21.4" })
  assert.equal(await prepareAssets(pinned, { version: "1.21.4" }), pinned)
  await assert.rejects(prepareAssets(pinned, { version: "1.20.1" }), { message: "these assets are prepared for version 1.21.4; prepare the sources again to use version 1.20.1" })
  await assert.rejects(prepareAssets(assets, { version: "1.20.1" }), /cached assets resolve versioned behavior at prepare time/)
  const loose = await prepareAssets([jar])
  assert.equal((await prepareAssets(loose, { version: "1.20.1" })).version, "1.20.1")
})
