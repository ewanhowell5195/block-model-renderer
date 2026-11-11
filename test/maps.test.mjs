import test from "node:test"
import assert from "node:assert/strict"
import { createScene, prepareAssets, renderMapColors } from "../src/node.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const jar = await loadMojangJar()

const frame = (x, id) => ({ id: "item_frame", properties: { facing: "south", map: "true" }, pos: [x, 0, 0], nbt: { Item: { id: "minecraft:filled_map", components: { "minecraft:map_id": id } } } })
const frames = [frame(0, 7), frame(1, 7), frame(2, 9), frame(3, 9)]

test("mapArt runs once per map id, for canvases and for nothing alike", async () => {
  const assets = await prepareAssets([jar])
  const art = await renderMapColors(assets, new Uint8Array(16384).fill(34 * 4 + 2))
  const calls = []
  function mapArt(id) {
    calls.push(id)
    return id === 7 ? art : null
  }
  const handle = await createScene(assets, frames, { lighting: "item", optimize: false, mapArt })
  assert.deepEqual(calls, [7, 9])
  handle.dispose()
})

test("an error thrown by mapArt fails the scene and is not cached", async () => {
  const assets = await prepareAssets([jar], { cache: true })
  let calls = 0
  function mapArt() {
    calls++
    throw new Error("no world open")
  }
  await assert.rejects(createScene(assets, frames, { lighting: "item", optimize: false, mapArt }), /no world open/)
  await assert.rejects(createScene(assets, frames, { lighting: "item", optimize: false, mapArt }), /no world open/)
  assert.equal(calls, 2)
})

test("renderMapColors reads the map background once per prepared assets", async () => {
  let reads = 0
  function read(file) {
    if (file === "assets/minecraft/textures/map/map_background.png") reads++
    return null
  }
  const assets = await prepareAssets([{ read }])
  const colors = new Uint8Array(16384)
  await renderMapColors(assets, colors)
  const first = reads
  await renderMapColors(assets, colors)
  await renderMapColors(assets, colors)
  assert.ok(first > 0)
  assert.equal(reads, first)
})
