import test from "node:test"
import assert from "node:assert/strict"
import { prepareAssets, parseBlockstate, resolveModelData, loadModel, optimizeScene } from "../src/node.js"
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
