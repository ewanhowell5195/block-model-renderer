import test from "node:test"
import assert from "node:assert/strict"
import { createScene, prepareAssets, parseBlockstate, resolveModelData, loadModel, optimizeScene } from "../src/node.js"
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
