import test from "node:test"
import assert from "node:assert/strict"
import { createScene, parseBlockstate } from "../src/node.js"
import { randomOffset } from "../src/core/models.js"
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

function assertNear(actual, expected, tolerance) {
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(actual[i] - expected[i]) < tolerance, `${actual} vs ${expected}`)
}

async function sceneMin(block, args) {
  const handle = await createScene([jar], [block], { lighting: "item", ...args })
  const min = handle.bounds.min.toArray()
  handle.dispose()
  return min
}

test("randomOffset shifts offset blocks by their world position", async () => {
  const blocks = [{ id: "short_grass", pos: [3, 0, -7] }, { id: "stone", pos: [4, 0, -7] }, { id: "pointed_dripstone", pos: [5, 0, -7] }, { id: "short_grass", pos: [3, 0, -8] }]
  const on = await createScene([jar], blocks, { lighting: "item", optimize: false, keepTemplates: true, randomOffset: true })
  const offsets = i => Array.from(on.blockOffset.subarray(i * 3, i * 3 + 3))
  assertNear(offsets(0), gameOffset(3, -7, 0.25, 0.2), 1e-6)
  assertNear(offsets(1), [0, 0, 0], 1e-9)
  assertNear(offsets(2), gameOffset(5, -7, 0.125, 0), 1e-6)
  assert.equal(on.blockTemplate[0], on.blockTemplate[3])
  assertNear(on.group.children[0].position.toArray().map(v => v / 16), [3, 0, -7].map((v, i) => v + gameOffset(3, -7, 0.25, 0.2)[i]), 1e-9)
  on.dispose()

  const shifted = await createScene([jar], blocks, { lighting: "item", optimize: false, keepTemplates: true, origin: [100, 64, 200] })
  assert.equal(shifted.blockOffset, null)
  shifted.dispose()
  const moved = await createScene([jar], blocks, { lighting: "item", optimize: false, keepTemplates: true, origin: [100, 64, 200], randomOffset: true })
  assertNear(Array.from(moved.blockOffset.subarray(0, 3)), gameOffset(103, 193, 0.25, 0.2), 1e-6)
  moved.dispose()
})

test("optimized scenes place offset blocks at their offset", async () => {
  const grass = { id: "short_grass", pos: [3, 0, -7] }
  const plain = await sceneMin(grass, {})
  const shifted = await sceneMin(grass, { randomOffset: true })
  const expected = gameOffset(3, -7, 0.25, 0.2).map((v, i) => plain[i] + v * 16)
  assertNear(shifted, expected, 1e-3)
})

test("parseBlockstate attaches the offset to a block's models but not its water", async () => {
  const plain = await parseBlockstate([jar], "short_grass", { pos: [3, 0, -7] })
  assert.ok(plain.every(m => !m.offset))
  const grass = await parseBlockstate([jar], "short_grass", { pos: [3, 0, -7], randomOffset: true })
  assert.ok(grass.length)
  for (const m of grass) assert.deepEqual(m.offset, gameOffset(3, -7, 0.25, 0.2))
  const stone = await parseBlockstate([jar], "stone", { pos: [3, 0, -7], randomOffset: true })
  assert.ok(stone.every(m => !m.offset))
  const dripstone = await parseBlockstate([jar], "pointed_dripstone", { data: { waterlogged: "true" }, pos: [5, 0, -7], randomOffset: true })
  assert.deepEqual(dripstone.filter(m => m.offset).length, dripstone.length - 1)
  assert.ok(dripstone.find(m => m.fluid) && !dripstone.find(m => m.fluid).offset)
})
