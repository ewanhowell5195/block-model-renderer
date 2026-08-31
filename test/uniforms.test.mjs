import test from "node:test"
import assert from "node:assert/strict"
import { createScene, prepareAssets } from "../src/node.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"
const assets = await prepareAssets([await loadMojangJar()], { cache: true })
const mk = (n, seed) => {
  const P = [{ id: "stone" }, { id: "oak_planks" }, { id: "glass" }, { id: "water", properties: { level: "0" } }, { id: "torch" }, { id: "glowstone" }]
  const b = []; let s = seed
  const r = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) {
    const v = r(); if (v < 0.4) continue
    const e = P[(v * P.length) | 0]; b.push({ id: e.id, properties: e.properties, pos: [x, y, z] })
  } return b
}
const stray = h => {
  const own = h.light?.uniforms?.lightVol?.value
  let checked = 0, wrong = 0
  h.group.traverse(o => {
    for (const m of [].concat(o.material ?? [])) {
      const u = m?.uniforms?.lightVol
      if (!u) continue
      checked++
      if (u.value !== own) wrong++
    }
  })
  return { checked, wrong }
}

test("scenes do not share light volumes", async () => {
  const a1 = await createScene(assets, mk(12, 1), { lighting: "world" })
  const b1 = await createScene(assets, mk(12, 2), { lighting: "world" })
  const a2 = await createScene(assets, mk(12, 1), { lighting: "world" })
  try {
    for (const [label, h] of [["A", a1], ["B", b1], ["A again", a2]]) {
      const r = stray(h)
      assert.ok(r.checked > 0, `${label} had no light bound materials to check`)
      assert.equal(r.wrong, 0, `${label} pointed at another scene's light volume`)
    }
  } finally {
    for (const h of [a1, b1, a2]) h.dispose()
  }
})
