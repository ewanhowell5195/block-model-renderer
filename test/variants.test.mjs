import test from "node:test"
import assert from "node:assert/strict"
import { createScene, parseBlockstate } from "../src/node.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const jar = await loadMojangJar()

async function grassRotation(args) {
  const [model] = await parseBlockstate([jar], "grass_block", { data: { snowy: "false" }, ...args })
  return model.y ?? 0
}

test("pos picks weighted variants the way the game does", async () => {
  const picks = [[[0, 63, 0], 180], [[0, 63, 1], 270], [[0, 63, -1], 90], [[0, 63, -16], 0], [[0, 63, -1000], 270], [[1, 63, 0], 90]]
  for (const [pos, rotation] of picks) assert.equal(await grassRotation({ pos }), rotation, String(pos))
})

test("createScene shares a template between blocks the game gives the same variant", async () => {
  const blocks = [[0, 3, 1], [0, 3, 2], [0, 3, 0], [0, 3, -15], [1, 3, 1]].map(pos => ({ id: "grass_block", properties: { snowy: "false" }, pos }))
  const handle = await createScene([jar], blocks, { lighting: "item", optimize: false, keepTemplates: true, origin: [0, 60, -1] })
  const t = Array.from(handle.blockTemplate)
  assert.equal(new Set(t.slice(0, 4)).size, 4)
  assert.equal(t[4], t[2])
  handle.dispose()
})

test("seed takes priority over pos, and neither takes the first variant", async () => {
  assert.equal(await grassRotation({}), 0)
  assert.equal(await grassRotation({ seed: 5, pos: [0, 63, 0] }), await grassRotation({ seed: 5 }))
})
