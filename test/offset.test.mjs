import test from "node:test"
import assert from "node:assert/strict"
import { createScene } from "../src/node.js"
import { randomOffset } from "../src/core/scene.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const jar = await loadMojangJar()

function gameSeed(x, z) {
  const xi = BigInt.asIntN(32, BigInt(x) * 3129871n)
  let seed = BigInt.asIntN(64, xi ^ (BigInt(z) * 116129781n))
  seed = BigInt.asIntN(64, seed * seed * 42317861n + seed * 11n)
  return seed >> 16n
}

function gameOffset(x, z, horizontal, vertical) {
  const seed = gameSeed(x, z)
  const bits = shift => Number((seed >> shift) & 15n)
  const clamp = v => Math.max(-horizontal, Math.min(horizontal, v))
  return [
    clamp((Math.fround(bits(0n) / 15) - 0.5) * 0.5),
    vertical ? (Math.fround(bits(4n) / 15) - 1) * Math.fround(vertical) : 0,
    clamp((Math.fround(bits(8n) / 15) - 0.5) * 0.5)
  ]
}

test("random offsets match the game's 64-bit position seed", () => {
  const coords = [0, 1, -1, 15, -16, 1000, -1000, 90037, 36983, -30000000, 29999999]
  for (const x of coords) for (const z of coords) {
    assert.deepEqual(randomOffset(x, z, 0.25, 0.2), gameOffset(x, z, 0.25, 0.2), `${x}, ${z}`)
    assert.deepEqual(randomOffset(x, z, 0.125, 0), gameOffset(x, z, 0.125, 0), `${x}, ${z}`)
  }
})

function templateShift(handle, index) {
  const group = handle.templates[handle.blockTemplate[index]].group
  const shift = group.children.length === 1 && group.children[0].isGroup ? group.children[0].position : null
  return shift ? [shift.x / 16, shift.y / 16, shift.z / 16] : [0, 0, 0]
}

test("randomOffset shifts offset blocks by their world position", async () => {
  const blocks = [{ id: "short_grass", pos: [3, 0, -7] }, { id: "stone", pos: [4, 0, -7] }, { id: "pointed_dripstone", pos: [5, 0, -7] }]
  const off = await createScene([jar], blocks, { lighting: "item", optimize: false, keepTemplates: true })
  assert.deepEqual(templateShift(off, 0), [0, 0, 0])
  off.dispose()

  const on = await createScene([jar], blocks, { lighting: "item", optimize: false, keepTemplates: true, randomOffset: true })
  assert.deepEqual(templateShift(on, 0), gameOffset(3, -7, 0.25, 0.2))
  assert.deepEqual(templateShift(on, 1), [0, 0, 0])
  assert.deepEqual(templateShift(on, 2), gameOffset(5, -7, 0.125, 0))
  on.dispose()

  const shifted = await createScene([jar], blocks, { lighting: "item", optimize: false, keepTemplates: true, randomOffset: { origin: [100, 200] } })
  assert.deepEqual(templateShift(shifted, 0), gameOffset(103, 193, 0.25, 0.2))
  shifted.dispose()
})
