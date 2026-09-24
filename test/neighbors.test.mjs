import test from "node:test"
import assert from "node:assert/strict"
import { createScene, renderBlock, ModelLoader } from "../src/node.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const jar = await loadMojangJar()

function planksLoader() {
  const seen = { builds: [], keys: [] }
  const loader = ModelLoader.register({
    name: "test-neighbors",
    match: model => /block\/oak_planks$/.test(model.textures?.all ?? ""),
    variantKey(model, block) {
      const key = block.neighbors([0, 1, 0])?.id === "oak_planks" ? "covered" : "open"
      seen.keys.push([block.pos, key])
      return key
    },
    async build({ block }) {
      if (!block) return
      seen.builds.push({ pos: block.pos, above: block.neighbors([0, 1, 0]), both: block.neighbors([[0, 1, 0], [0, -1, 0]]) })
    }
  })
  return { seen, loader }
}

test("createScene gives loaders a neighbour lookup and splits templates by variantKey", async () => {
  const { seen, loader } = planksLoader()
  try {
    const blocks = [
      { id: "oak_planks", pos: [0, 0, 0] },
      { id: "oak_planks", pos: [0, 1, 0] },
      { id: "oak_planks", pos: [0, 2, 0] },
      { id: "oak_planks", pos: [5, 0, 0] }
    ]
    const handle = await createScene([jar], blocks, { lighting: "item", origin: [100, 0, 0] })
    assert.equal(seen.keys.length, 4)
    assert.deepEqual(seen.keys.map(k => k[1]).sort(), ["covered", "covered", "open", "open"])
    assert.deepEqual(seen.keys[0][0], [100, 0, 0])
    assert.equal(seen.builds.length, 2)
    const covered = seen.builds.find(b => b.above)
    assert.equal(covered.above.id, "oak_planks")
    assert.equal(covered.both.length, 2)
    assert.equal(covered.both[0].id, "oak_planks")
    assert.equal(seen.builds.find(b => !b.above).both[0], null)
    handle.dispose()
  } finally {
    ModelLoader.remove(loader)
  }
})

test("renderBlock passes its neighbors function through to loaders", async () => {
  const { seen, loader } = planksLoader()
  try {
    const neighbors = ([dx, dy, dz]) => dx === 0 && dy === 1 && dz === 0 ? { id: "oak_planks" } : null
    await renderBlock({ id: "oak_planks", assets: [jar], neighbors, pos: [3, 4, 5], width: 32, height: 32 })
    assert.equal(seen.builds.length, 1)
    assert.deepEqual(seen.builds[0].pos, [3, 4, 5])
    assert.equal(seen.builds[0].above.id, "oak_planks")
    assert.deepEqual(seen.builds[0].both, [{ id: "oak_planks" }, null])
  } finally {
    ModelLoader.remove(loader)
  }
})
