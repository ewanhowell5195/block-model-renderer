import test from "node:test"
import assert from "node:assert/strict"
import { createScene } from "../src/node.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const jar = await loadMojangJar()

test("blockPalette is 16-bit while the palette fits", async () => {
  const blocks = [
    { id: "stone", pos: [0, 0, 0] },
    { id: "air", pos: [1, 0, 0] },
    { id: "glass", pos: [2, 0, 0] },
    { id: "stone", pos: [3, 0, 0] }
  ]
  const handle = await createScene([jar], blocks, { lighting: "item", optimize: false })
  assert.ok(handle.blockPalette instanceof Uint16Array)
  assert.deepEqual(Array.from(handle.blockPalette), [0, 0xFFFF, 1, 0])
  assert.deepEqual(handle.palette.map(p => p.id), ["stone", "glass"])
  handle.dispose()
})

test("blockPalette widens to 32-bit past 65535 states", async () => {
  const count = 70000
  const palette = [{ id: "air" }]
  const raw = new Int32Array((count + 1) * 4)
  raw.set([0, -1, 0, 0])
  for (let i = 0; i < count; i++) {
    palette.push({ id: "barrier", biome: { tint: "#" + i.toString(16).padStart(6, "0") } })
    raw.set([i + 1, i % 400, 0, Math.floor(i / 400)], (i + 1) * 4)
  }
  const handle = await createScene([jar], { palette, raw }, { lighting: "item", optimize: false })
  assert.ok(handle.blockPalette instanceof Uint32Array)
  assert.equal(handle.palette.length, count)
  assert.equal(handle.blockPalette[0], 0xFFFFFFFF)
  for (const i of [1, 2, 0xFFFF, 0x10000, 0x10001, count]) assert.equal(handle.blockPalette[i], i - 1)
  handle.dispose()
})

test("block nbt with BigInt longs keys and builds", async () => {
  const bees = anger => ({ bees: [{ entity_data: { anger_end_time: anger } }] })
  const frame = { Item: { id: "minecraft:compass", count: 1, components: { "minecraft:custom_data": { stamp: 123456789012345n } } } }
  const palette = [{ id: "beehive", properties: { facing: "north" } }, { id: "item_frame", properties: { facing: "north" } }]
  const raw = new Int32Array([0, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 1, 3, 0, 0])
  const blockNbt = new Map([[0, bees(-1n)], [1, bees(-1n)], [2, bees(5n)], [3, frame]])
  const handle = await createScene([jar], { palette, raw, blockNbt }, { lighting: "item" })
  assert.equal(handle.palette.length, 3)
  assert.equal(handle.blockPalette[0], handle.blockPalette[1])
  assert.notEqual(handle.blockPalette[0], handle.blockPalette[2])
  handle.dispose()
  const listed = await createScene([jar], [{ id: "item_frame", properties: { facing: "north" }, pos: [0, 0, 0], nbt: frame }], { lighting: "item", optimize: false })
  assert.ok(listed.drawCalls > 1)
  listed.dispose()
})
