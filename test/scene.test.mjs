import test from "node:test"
import assert from "node:assert/strict"
import { createScene, prepareAssets, disposeCache, warmShaders, createSharedAtlas } from "../src/node.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const jar = await loadMojangJar()

test("warmShaders compiles single blocks, and merged runs with and without variants on a shared atlas", async () => {
  const assets = await prepareAssets([jar], { cache: true })
  const compiled = []
  const renderer = {
    info: { programs: [] },
    compile(group) {
      let meshes = 0, tiled = false, plainOpaque = false, lookup = false
      group.traverse(o => {
        if (!o.isMesh) return
        meshes++
        if (!o.geometry.attributes.tileRect) return
        tiled = true
        if ("TILE_LOOKUP" in o.material.defines) lookup = true
        else if (!o.material.transparent && o.material.side === 0) plainOpaque = true
      })
      compiled.push({ meshes, tiled, plainOpaque, lookup })
    }
  }
  const plain = await warmShaders(assets, renderer)
  assert.equal(compiled.length, 1)
  assert.ok(compiled[0].meshes > 4)
  assert.equal(compiled[0].tiled, false)
  plain.dispose()
  const shared = createSharedAtlas()
  const warmed = await warmShaders(assets, renderer, { sharedAtlas: shared })
  assert.deepEqual(compiled.slice(1).map(c => c.tiled), [false, true, true])
  assert.deepEqual(compiled.slice(2).map(c => [c.plainOpaque, c.lookup]), [[true, false], [false, true]])
  assert.equal(warmed.programs, 0)
  warmed.dispose()
  shared.dispose()
  disposeCache(assets)
})

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

test("equal properties in separate objects share a palette entry", async () => {
  const axes = ["y", "y", "x", "y", "x", "z"]
  const shared = { x: { axis: "x" }, y: { axis: "y" }, z: { axis: "z" } }
  const fresh = axes.map((axis, i) => ({ id: "oak_log", properties: { axis }, pos: [i, 0, 0] }))
  const reused = axes.map((axis, i) => ({ id: "oak_log", properties: shared[axis], pos: [i, 0, 0] }))
  fresh.push({ id: "birch_log", properties: { axis: "y" }, pos: [6, 0, 0] }, { id: "oak_log", pos: [7, 0, 0] }, { id: "oak_log", properties: {}, pos: [8, 0, 0] })
  reused.push({ id: "birch_log", properties: shared.y, pos: [6, 0, 0] }, { id: "oak_log", pos: [7, 0, 0] }, { id: "oak_log", properties: {}, pos: [8, 0, 0] })
  const a = await createScene([jar], fresh, { lighting: "item" })
  const b = await createScene([jar], reused, { lighting: "item" })
  assert.deepEqual(Array.from(a.blockPalette), [0, 0, 1, 0, 1, 2, 3, 4, 5])
  assert.deepEqual(Array.from(b.blockPalette), Array.from(a.blockPalette))
  assert.deepEqual(a.palette.map(p => p.properties), b.palette.map(p => p.properties))
  assert.equal(a.tris, b.tris)
  a.dispose()
  b.dispose()
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

test("scenes spread past the dense cell grid still cull between neighbours", async () => {
  const cube = (ox, oz) => {
    const out = []
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) out.push({ id: "stone", pos: [ox + x, y, oz + z] })
    return out
  }
  const a = await createScene([jar], cube(0, 0), { lighting: "item" })
  const b = await createScene([jar], cube(3000, 3000), { lighting: "item" })
  const both = await createScene([jar], cube(0, 0).concat(cube(3000, 3000)), { lighting: "item" })
  assert.equal(both.tris, a.tris + b.tris)
  for (const handle of [a, b, both]) handle.dispose()
})

test("sparse scenes far from the origin keep every cell", async () => {
  const cube = (ox, oz) => {
    const out = []
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) for (let z = 0; z < 8; z++) out.push({ id: "diamond_block", pos: [ox + x, y, oz + z] })
    return out
  }
  for (const [x, z] of [[2000000, 0], [-20000000, 20000000]]) {
    const far = await createScene([jar], cube(x, z).concat(cube(x + 3000, z + 3000)), { lighting: "item" })
    assert.equal(far.tris, 24)
    far.dispose()
  }
})

test("buried cells are skipped without changing the geometry", async () => {
  const ids = ["stone", "grass_block", "dirt", "glass", "oak_stairs"]
  const blocks = []
  for (let x = 0; x < 7; x++) for (let y = 0; y < 7; y++) for (let z = 0; z < 7; z++) {
    const id = x === 3 && z === 3 && y > 1 ? ids[3 + (y & 1)] : ids[(x * 5 + y * 3 + z) % 3]
    blocks.push({ id, pos: [x, y, z] })
  }
  const skipped = await createScene([jar], blocks, { lighting: "item" })
  const kept = await createScene([jar], blocks, { lighting: "item", keepTemplates: true })
  const walled = await createScene([jar], blocks, { lighting: "item", externalOcclusion: () => true })
  assert.ok(skipped.tris > 0)
  assert.equal(skipped.tris, kept.tris)
  assert.equal(skipped.drawCalls, kept.drawCalls)
  assert.ok(walled.tris > 0 && walled.tris < skipped.tris)
  assert.equal(kept.blockTemplate.indexOf(0xFFFFFFFF), -1)
  skipped.dispose()
  kept.dispose()
  walled.dispose()
})

test("the scene handle carries the daytime, fog and light switches its materials share", async () => {
  const blocks = [{ id: "stone", pos: [0, 0, 0] }, { id: "torch", pos: [0, 1, 0] }]
  const world = await createScene([jar], blocks, { lighting: { daytime: 18000 } })
  assert.equal(world.daytime.value, 18000)
  assert.equal(world.daytime, world.group.userData.daytime)
  assert.ok(world.fog.uniforms)
  assert.equal(world.fog, world.group.userData.fog)
  assert.equal(world.lightSwitches, world.group.userData.lightSwitches)
  let bound = 0
  world.group.traverse(o => {
    for (const m of [].concat(o.material ?? [])) {
      if (!m.uniforms?.daytime) continue
      bound++
      assert.equal(m.uniforms.daytime, world.daytime)
    }
  })
  assert.ok(bound > 0)
  world.dispose()
  const item = await createScene([jar], blocks, { lighting: "item" })
  assert.equal(item.fog, null)
  assert.equal(item.lightSwitches, item.group.userData.lightSwitches)
  item.dispose()
})

test("disposeCache empties every cross-call cache and rebuilds the same scene", async () => {
  const assets = await prepareAssets([jar], { cache: true })
  const blocks = [{ id: "stone", pos: [0, 0, 0] }, { id: "grass_block", pos: [1, 0, 0] }, { id: "water", properties: { level: "0" }, pos: [0, 1, 0] }, { id: "oak_stairs", pos: [1, 1, 0] }]
  const first = await createScene(assets, blocks, { lighting: "item" })
  const tris = first.tris
  first.dispose()
  assert.ok(assets.cache.cullMasks.size > 0)
  disposeCache(assets)
  for (const [k, v] of Object.entries(assets.cache)) if (v instanceof Map) assert.equal(v.size, 0, k)
  const again = await createScene(assets, blocks, { lighting: "item" })
  assert.equal(again.tris, tris)
  again.dispose()
})
