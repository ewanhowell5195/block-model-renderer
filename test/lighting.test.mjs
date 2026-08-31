import test from "node:test"
import assert from "node:assert/strict"
import { computeSceneLight, wasmStatus } from "../src/node.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"
import crypto from "node:crypto"

const jar = await loadMojangJar()

const PALETTE = [
  { id: "stone" }, { id: "glass" }, { id: "oak_leaves", properties: { persistent: "true" } },
  { id: "torch" }, { id: "glowstone" }, { id: "oak_slab", properties: { type: "bottom" } },
  { id: "cobblestone_stairs", properties: { facing: "north", half: "bottom", shape: "straight" } },
  { id: "water", properties: { level: "0" } }, { id: "oak_fence" }, { id: "sea_lantern" },
  { id: "oak_trapdoor", properties: { facing: "north", half: "bottom", open: "false" } }
]

function build(w, h, d, seed0, density) {
  const blocks = []
  let seed = seed0
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) for (let z = 0; z < d; z++) {
    const r = rnd()
    if (r < density) continue
    const e = PALETTE[(r * PALETTE.length) | 0]
    blocks.push({ id: e.id, properties: e.properties, pos: [x, y, z] })
  }
  return blocks
}

const hash = a => crypto.createHash("sha256").update(Buffer.from(a.buffer ?? a, a.byteOffset ?? 0, a.byteLength ?? a.length)).digest("hex").slice(0, 20)

const cases = [
  ["dense", 14, 12, 14, 7, 0.15, {}],
  ["sparse", 16, 14, 16, 99, 0.7, {}],
  ["mixed", 12, 16, 12, 4242, 0.45, {}],
  ["nether", 12, 12, 12, 31337, 0.4, { dimension: "the_nether" }],
  ["thin", 20, 3, 20, 5, 0.5, {}],
  ["column", 3, 24, 3, 88, 0.35, {}]
]

test("the light kernel is live", async () => {
  assert.equal(await wasmStatus(), true, "wasm module did not load")
})

for (const [name, w, h, d, seed, density, extra] of cases) {
  test(`light volume matches the js walk: ${name}`, async () => {
    const blocks = build(w, h, d, seed, density)
    delete globalThis.__BMR_NO_WASM
    const fast = await computeSceneLight(blocks, { assets: [jar], ...extra })
    globalThis.__BMR_NO_WASM = 1
    const slow = await computeSceneLight(blocks, { assets: [jar], ...extra })
    delete globalThis.__BMR_NO_WASM
    try {
      assert.equal(hash(fast.blockLight), hash(slow.blockLight), "block light")
      assert.equal(hash(fast.skyLight), hash(slow.skyLight), "sky light")
      assert.equal(hash(fast.uniforms.lightVol.value.image.data), hash(slow.uniforms.lightVol.value.image.data), "volume texture")
    } finally {
      fast.dispose()
      slow.dispose()
    }
  })
}
