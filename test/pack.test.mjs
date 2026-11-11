import test from "node:test"
import assert from "node:assert/strict"
import { createScene, prepareAssets, createSharedAtlas, packScene, reviveScene, sortTranslucent } from "../src/node.js"
import { THREE } from "../src/core/platform.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const assets = await prepareAssets([await loadMojangJar()], { cache: true })

test("a revived scene with release keeps what translucent sorting needs", async () => {
  const blocks = []
  for (let x = 0; x < 6; x++) {
    blocks.push({ id: "stone", pos: [x, 0, 0] })
    if (x % 2 === 0) blocks.push({ id: x % 4 === 0 ? "red_stained_glass" : "blue_stained_glass", pos: [x, 1, 0] })
  }
  const shared = createSharedAtlas()
  const handle = await createScene(assets, blocks, { lighting: "world", sharedAtlas: shared, batchDynamics: false })
  const { payload } = await packScene(handle, { sharedAtlas: shared })
  const tile = reviveScene(payload, { atlas: shared, release: true })
  const meshes = []
  tile.group.traverse(o => { if (o.isMesh) meshes.push(o) })
  for (const mesh of meshes) {
    for (const attr of Object.values(mesh.geometry.attributes)) attr.onUploadCallback()
    mesh.geometry.index.onUploadCallback()
  }
  const translucent = meshes.filter(m => m.material.transparent), opaque = meshes.filter(m => !m.material.transparent)
  assert.ok(translucent.length > 0 && opaque.length > 0)
  for (const mesh of opaque) assert.equal(mesh.geometry.attributes.position.array, null)
  for (const mesh of translucent) {
    assert.ok(mesh.geometry.attributes.position.array)
    assert.ok(mesh.geometry.index.array)
  }
  const camera = new THREE.PerspectiveCamera()
  camera.position.set(-200, 24, 8)
  camera.updateMatrixWorld(true)
  const sorter = sortTranslucent(tile.group)
  sorter.sort(camera)
  const first = translucent[0], index = first.geometry.index.array, pos = first.geometry.attributes.position
  assert.ok(pos.getX(index[0]) > pos.getX(index[index.length - 1]))
  sorter.detach()
  tile.dispose()
  handle.dispose()
  shared.dispose()
})
