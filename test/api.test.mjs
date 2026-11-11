import test from "node:test"
import assert from "node:assert/strict"
import { prepareAssets, disposeCache, renderBlock, renderItem, parseBlockstate, parseItemDefinition, resolveModelData, loadModel, readFile, listDirectory, readTexture, computeSceneLight, createScene, getThree } from "../src/node.js"
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

test("a version on prepared assets gives a view that shares the packs", async () => {
  const base = await prepareAssets([jar], { cache: true })
  const view = await prepareAssets(base, { version: "1.20.1" })
  assert.notEqual(view, base)
  assert.equal(view.version, "1.20.1")
  assert.equal(base.version, undefined)
  assert.equal(view.length, base.length)
  for (let i = 0; i < base.length; i++) assert.equal(view[i], base[i])
  assert.notEqual(view.cache, base.cache)
  assert.equal(await prepareAssets(base, { version: "1.20.1" }), view)
  assert.equal(await prepareAssets(view, { version: "1.20.1" }), view)
  const other = await prepareAssets(base, { version: "1.8.9" })
  assert.equal(other.version, "1.8.9")
  assert.notEqual(other, view)
  assert.equal((await prepareAssets([jar])).cache, undefined)
  assert.equal((await prepareAssets(await prepareAssets([jar]), { version: "1.20.1" })).cache, undefined)
})

test("assets that have a version give views for other versions and keep their own", async () => {
  const pinned = await prepareAssets([jar], { version: "1.21.4", cache: true })
  assert.equal(await prepareAssets(pinned, { version: "1.21.4" }), pinned)
  const moved = await prepareAssets(pinned, { version: "1.20.1" })
  assert.equal(moved.version, "1.20.1")
  assert.equal(pinned.version, "1.21.4")
  assert.equal(await prepareAssets(moved, { version: "1.21.4" }), pinned)
  const again = await prepareAssets(moved, { version: "1.8.9" })
  assert.equal(await prepareAssets(pinned, { version: "1.8.9" }), again)
  const size = { width: 32, height: 32 }
  const direct = await prepareAssets([jar], { version: "1.8.9", cache: true })
  for (const id of ["white_bed", "oak_stairs"]) {
    assert.deepEqual(await renderBlock({ id, assets: pinned, version: "1.8.9", ...size }), await renderBlock({ id, assets: direct, ...size }), id)
  }
  const [own] = await parseBlockstate(pinned, "oak_stairs")
  assert.equal(own.version, "1.21.4")
})

test("a version given per call renders like assets prepared for that version", async () => {
  const base = await prepareAssets([jar], { cache: true })
  const size = { width: 32, height: 32 }
  for (const version of ["1.8.9", "1.21.4"]) {
    const direct = await prepareAssets([jar], { version, cache: true })
    for (const id of ["oak_stairs", "white_bed", "chest", "cactus"]) {
      assert.deepEqual(await renderBlock({ id, assets: base, version, ...size }), await renderBlock({ id, assets: direct, ...size }), `${id} in ${version}`)
    }
    assert.deepEqual(await renderItem({ id: "bow", assets: base, version, ...size }), await renderItem({ id: "bow", assets: direct, ...size }))
    const [viaCall] = await parseBlockstate(base, "oak_stairs", { version })
    assert.equal(viaCall.version, version)
    const handle = await createScene(base, [{ id: "oak_stairs", pos: [0, 0, 0] }], { version, lighting: "item" })
    const pinned = await createScene(direct, [{ id: "oak_stairs", pos: [0, 0, 0] }], { lighting: "item" })
    assert.equal(handle.tris, pinned.tris)
    handle.dispose()
    pinned.dispose()
  }
  const [plain] = await parseBlockstate(base, "oak_stairs")
  assert.equal(plain.version, undefined)
  assert.equal(base.version, undefined)
})

test("disposeCache on the prepared assets empties the caches of their version views", async () => {
  const base = await prepareAssets([jar], { cache: true })
  await renderBlock({ id: "stone", assets: base, version: "1.20.1", width: 16, height: 16 })
  const view = await prepareAssets(base, { version: "1.20.1" })
  assert.ok(view.cache.models.size > 0)
  disposeCache(base)
  assert.equal(view.cache.models.size, 0)
})

test("a version id that is not a release leaves the assets unversioned", async () => {
  for (const version of ["24w14a", "23w13a_or_b", "1.RV-Pre1", "3D Shareware v1.34", "b1.7.3", "fabric-loader-0.16.10-1.21.4"]) {
    assert.equal((await prepareAssets([jar], { version })).version, undefined, version)
    const [model] = await parseBlockstate(assets, "stone", { version })
    assert.equal(model.version, undefined, version)
  }
  for (const version of ["1.16.2-pre1", "1.14 Pre-Release 1", "26.3-snapshot-5"]) {
    assert.equal((await prepareAssets([jar], { version })).version, version)
  }
  const [cactus] = await parseBlockstate(assets, "cactus", { version: "1.14 Pre-Release 1" })
  assert.equal(cactus.model, "minecraft:block/cactus")
})
