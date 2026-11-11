import test from "node:test"
import assert from "node:assert/strict"
import { prepareAssets, disposeCache, fullyOccludes, getCullFaces, ModelLoader } from "../src/node.js"
import { occlusionModels, buildOcclusionModel } from "../src/core/models.js"
import { occludingFaces, plainOcclusion } from "../src/core/occlusion.js"
import { blockRules } from "../src/core/data.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const jar = await loadMojangJar()

const FULL = new Uint16Array(16).fill(0xffff)
const EMPTY = new Uint16Array(16)

async function fromData(assets, rules, id, props) {
  return plainOcclusion(assets, await occlusionModels(assets, id, props), id, rules)
}

async function fromBuild(assets, rules, id, props) {
  const g = await buildOcclusionModel(assets, await occlusionModels(assets, id, props))
  return { neighbor: occludingFaces(g, id, false, rules), self: occludingFaces(g, null, true) }
}

test("occlusion masks from model data match the built model", async () => {
  const assets = await prepareAssets([jar], { cache: true })
  const rules = await blockRules(assets)
  const states = [
    ["stone"],
    ["grass_block"],
    ["glass"],
    ["oak_leaves"],
    ["ice"],
    ["oak_log", { axis: "x" }],
    ["oak_slab", { type: "top" }],
    ["oak_slab", { type: "double" }],
    ["oak_stairs", { facing: "east", half: "top", shape: "inner_left" }],
    ["oak_stairs", { facing: "south", half: "bottom", shape: "outer_right" }],
    ["oak_fence", { north: "true", east: "true" }],
    ["cobblestone_wall", { up: "true", north: "tall", west: "low" }],
    ["oak_trapdoor", { facing: "west", half: "top", open: "true" }],
    ["oak_door", { facing: "north", half: "lower", hinge: "left", open: "false" }],
    ["farmland", { moisture: "7" }],
    ["anvil", { facing: "east" }],
    ["hopper", { facing: "down" }],
    ["poppy"],
    ["torch"]
  ]
  for (const [id, props] of states) {
    const data = await fromData(assets, rules, id, props)
    assert.ok(data, `${id} is read from its model data`)
    assert.deepEqual(data, await fromBuild(assets, rules, id, props), id)
  }
  const stone = await fromData(assets, rules, "stone")
  const glass = await fromData(assets, rules, "glass")
  const slab = await fromData(assets, rules, "oak_slab", { type: "top" })
  for (const dir of ["east", "west", "up", "down", "south", "north"]) {
    assert.deepEqual(stone.neighbor[dir], FULL)
    assert.deepEqual(glass.neighbor[dir], EMPTY)
    assert.deepEqual(glass.self[dir], FULL)
  }
  assert.deepEqual(slab.neighbor.up, FULL)
  assert.deepEqual(slab.neighbor.down, EMPTY)
  assert.deepEqual(Array.from(slab.neighbor.north), Array.from({ length: 16 }, (_, row) => row < 8 ? 0 : 0xffff))
  disposeCache(assets)
})

test("models that are not plain boxes fall back to the built model", async () => {
  const assets = await prepareAssets([jar], { cache: true })
  const rules = await blockRules(assets)
  for (const [id, props] of [["chest"], ["water"], ["white_banner"], ["wall_torch"], ["oak_slab", { type: "bottom", waterlogged: "true" }]]) {
    assert.equal(await fromData(assets, rules, id, props), undefined, id)
  }
  assert.equal(await occlusionModels(assets, "not_a_block"), null)
  assert.equal(await fullyOccludes({ id: "chest", assets }), false)
  assert.equal(await fullyOccludes({ id: "not_a_block", assets }), false)
  assert.deepEqual(await getCullFaces({ id: "oak_slab", properties: { type: "bottom", waterlogged: "true" }, neighbors: { down: "stone", up: "stone" }, assets }), new Set(["down"]))
  disposeCache(assets)
})

test("a model claimed by a loader falls back to the built model", async () => {
  const assets = await prepareAssets([jar], { cache: true })
  const rules = await blockRules(assets)
  assert.ok(await fromData(assets, rules, "oak_planks"))
  const loader = ModelLoader.register({
    name: "test-occlusion",
    match: model => /block\/oak_planks$/.test(model.textures?.all ?? ""),
    async build() {}
  })
  try {
    assert.equal(await fromData(assets, rules, "oak_planks"), undefined)
    assert.ok(await fromData(assets, rules, "stone"))
    assert.equal(await fullyOccludes({ id: "oak_planks", assets }), true)
  } finally {
    ModelLoader.remove(loader)
  }
  disposeCache(assets)
})
