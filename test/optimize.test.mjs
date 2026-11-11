import test from "node:test"
import assert from "node:assert/strict"
import sharp from "sharp"
import { createScene, prepareAssets, parseBlockstate, resolveModelData, loadModel, optimizeScene, createSharedAtlas, makeModelScene, renderModelScene } from "../src/node.js"
import { THREE } from "../src/core/platform.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const assets = await prepareAssets([await loadMojangJar()], { cache: true })

async function build(id, lighting = "world") {
  const group = new THREE.Group()
  for (const model of await parseBlockstate(assets, id)) await loadModel(group, assets, await resolveModelData(assets, model), { lighting })
  return group
}

function meshesOf(handle) {
  const out = []
  handle.group.traverse(o => { if (o.isMesh) out.push(o) })
  return out
}

function geometryOf(handle) {
  return meshesOf(handle).filter(m => !m.isInstancedMesh && !m.isBatchedMesh).map(m => {
    const g = m.geometry, index = g.index.array, out = []
    for (const name of ["position", "normal", "uv", "color", "faceData"]) {
      const a = g.attributes[name]
      if (!a) continue
      for (let i = 0; i < index.length; i++) for (let k = 0; k < a.itemSize; k++) out.push(a.array[index[i] * a.itemSize + k])
    }
    return out
  })
}

test("dense and sparse scenes mesh the same with and without wasm", async () => {
  const dense = [], sparse = []
  for (let x = 0; x < 12; x++) for (let z = 0; z < 12; z++) {
    dense.push({ id: (x + z) % 5 ? "stone" : "glass", pos: [x, 0, z] })
    if ((x * 7 + z * 3) % 11 === 0) sparse.push({ id: x % 2 ? "stone" : "oak_planks", pos: [x * 37, (z * 5) % 9, z * 41] })
  }
  for (const blocks of [dense, sparse]) {
    const fast = await createScene(assets, blocks, { lighting: "world" })
    globalThis.__BMR_NO_WASM = true
    let slow
    try {
      slow = await createScene(assets, blocks, { lighting: "world" })
    } finally {
      delete globalThis.__BMR_NO_WASM
    }
    assert.equal(fast.tris, slow.tris)
    assert.deepEqual(geometryOf(fast), geometryOf(slow))
    fast.dispose()
    slow.dispose()
  }
})

test("merged quads are indexed four vertices to a quad", async () => {
  const blocks = []
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) blocks.push({ id: "oak_planks", pos: [x, 0, z] })
  const handle = await createScene(assets, blocks, { lighting: "world" })
  const [mesh] = meshesOf(handle)
  assert.equal(handle.tris, 12)
  assert.equal(mesh.geometry.index.count, 36)
  assert.equal(mesh.geometry.attributes.position.count, 24)
  assert.ok(mesh.geometry.attributes.normal.array instanceof Int8Array)
  handle.dispose()
})

test("materials that differ in opacity and blending stay separate meshes", async () => {
  const plain = await build("smooth_stone")
  const ghost = await build("smooth_stone")
  ghost.traverse(o => {
    if (!o.isMesh) return
    o.material = [].concat(o.material).map(m => {
      const c = m.clone()
      c.uniforms.opacity = { value: 0.3 }
      c.transparent = true
      c.depthWrite = false
      c.blending = THREE.AdditiveBlending
      return c
    })
  })
  for (const order of [[plain, ghost], [ghost, plain]]) {
    const handle = await optimizeScene(order.map((group, i) => ({ pos: [i * 3, 0, 0], group })))
    const meshes = meshesOf(handle)
    assert.equal(meshes.length, 2)
    const solid = meshes.find(m => !m.material.transparent), blended = meshes.find(m => m.material.transparent)
    assert.equal(solid.material.uniforms.opacity.value, 1)
    assert.equal(solid.material.depthWrite, true)
    assert.equal(blended.material.uniforms.opacity.value, 0.3)
    assert.equal(blended.material.depthWrite, false)
    assert.equal(blended.material.blending, THREE.AdditiveBlending)
    handle.dispose()
  }
})

test("the same block under two lighting setups keeps both materials", async () => {
  const day = await build("smooth_stone", "world")
  const nether = await build("smooth_stone", { brightness: 1, dimension: "the_nether" })
  const handle = await optimizeScene([{ pos: [0, 0, 0], group: day }, { pos: [1, 0, 0], group: nether }])
  const brightness = meshesOf(handle).map(m => m.material.uniforms.brightness.value).sort()
  assert.deepEqual(brightness, [0.5, 1])
  handle.dispose()
})

function wall(ids, width, height) {
  const blocks = []
  ids.forEach((id, i) => { for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) blocks.push({ id, pos: [x, y, i * 2] }) })
  return blocks
}

async function shoot(handle) {
  const { scene, camera } = makeModelScene()
  scene.add(handle.group)
  const { min, max } = handle.bounds
  handle.group.position.set(-(min.x + max.x) / 2, -(min.y + max.y) / 2, -(min.z + max.z) / 2)
  handle.light?.setOffset(handle.group.position)
  const radius = Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2
  camera.position.set(radius * 0.72, radius * 0.93, radius * 1.61)
  camera.lookAt(0, 0, 0)
  Object.assign(camera, { left: -radius, right: radius, top: radius, bottom: -radius, near: 0.01, far: radius * 6 })
  camera.updateProjectionMatrix()
  const png = await renderModelScene(scene, camera, { width: 256, height: 256 })
  return sharp(png).ensureAlpha().raw().toBuffer()
}

test("scenes on a shared atlas merge repeated faces and repeat them in the shader", async () => {
  const blocks = []
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) blocks.push({ id: "oak_planks", pos: [x, 0, z] })
  const shared = createSharedAtlas()
  const handle = await createScene(assets, blocks, { lighting: "world", sharedAtlas: shared })
  const [mesh] = meshesOf(handle)
  assert.equal(handle.tris, 12)
  assert.ok("TILED" in mesh.material.defines)
  assert.equal(mesh.material.uniforms.atlasSize.value.x, shared.size)
  assert.equal(mesh.material.uniforms.atlasSize.value.y, shared.size)
  const rect = mesh.geometry.attributes.tileRect, uv = mesh.geometry.attributes.uv
  assert.equal(rect.count, 24)
  for (let i = 0; i < rect.count; i++) {
    assert.equal(rect.getZ(i), 16)
    assert.equal(rect.getW(i), 16)
    for (const v of [uv.getX(i), uv.getY(i)]) {
      assert.ok(Math.floor(v) === 1 || Math.floor(v) === 8)
      assert.ok(v % 1 === 0 || v % 1 === 0.5)
    }
  }
  handle.dispose()
  shared.dispose()
})

test("a shared atlas mesh that merging would not shrink keeps plain faces", async () => {
  const blocks = ["bricks", "bookshelf", "furnace", "tnt", "melon", "pumpkin"].map((id, i) => ({ id, pos: [i * 3, 0, 0] }))
  blocks.push({ id: "oak_planks", pos: [0, 0, 4] }, { id: "oak_planks", pos: [1, 0, 4] })
  const shared = createSharedAtlas()
  const handle = await createScene(assets, blocks, { lighting: "world", sharedAtlas: shared })
  assert.equal(handle.tris, 92)
  for (const mesh of meshesOf(handle)) {
    assert.equal(mesh.geometry.attributes.tileRect, undefined)
    assert.ok(!("TILED" in mesh.material.defines))
    assert.ok(mesh.geometry.attributes.uv.array.every(v => v >= 0 && v <= 1))
  }
  handle.dispose()
  shared.dispose()
})

test("faces repeated in the shader render like faces merged onto tiled textures", async () => {
  const blocks = wall(["bricks", "bookshelf", "crafting_table", "lime_stained_glass", "oak_stairs", "smooth_stone_slab"], 7, 4)
  const shared = createSharedAtlas()
  const tiled = await createScene(assets, blocks, { lighting: "world", sharedAtlas: shared })
  const baked = await createScene(assets, blocks, { lighting: "world" })
  assert.ok(meshesOf(tiled).some(m => m.geometry.attributes.tileRect))
  assert.equal(tiled.tris, baked.tris)
  const a = await shoot(tiled), b = await shoot(baked)
  let differ = 0
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 24 || Math.abs(a[i + 1] - b[i + 1]) > 24 || Math.abs(a[i + 2] - b[i + 2]) > 24 || Math.abs(a[i + 3] - b[i + 3]) > 24) differ++
  assert.ok(differ < a.length / 4 * 0.005, `${differ} pixels differ`)
  tiled.dispose()
  baked.dispose()
  shared.dispose()
})
