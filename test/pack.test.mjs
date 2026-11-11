import test from "node:test"
import assert from "node:assert/strict"
import * as lib from "../src/node.js"
import { createScene, prepareAssets, createSharedAtlas, packScene, reviveScene, createTranslucentSorter, readTexture } from "../src/node.js"
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
  const tile = reviveScene(payload, { sharedAtlas: shared, release: true })
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
  const sorter = createTranslucentSorter(tile.group)
  sorter.sort(camera)
  const first = translucent[0], index = first.geometry.index.array, pos = first.geometry.attributes.position
  assert.ok(pos.getX(index[0]) > pos.getX(index[index.length - 1]))
  sorter.detach()
  tile.dispose()
  handle.dispose()
  shared.dispose()
})

test("a revived scene keeps the faces it repeats in the shader", async () => {
  const blocks = []
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) blocks.push({ id: "oak_planks", pos: [x, 0, z] })
  const shared = createSharedAtlas()
  const handle = await createScene(assets, blocks, { lighting: "world", sharedAtlas: shared })
  const { payload } = await packScene(handle, { sharedAtlas: shared })
  const tile = reviveScene(payload, { sharedAtlas: shared })
  const [mesh] = tile.group.children
  assert.equal(mesh.geometry.index.count, 36)
  assert.ok(mesh.geometry.attributes.tileRect.array instanceof Uint16Array)
  assert.ok("TILED" in mesh.material.defines)
  assert.equal(mesh.material.uniforms.atlasSize.value.x, shared.size)
  assert.equal(mesh.material.uniforms.atlasSize.value.y, shared.size)
  tile.dispose()
  handle.dispose()
  shared.dispose()
})

test("a revived scene keeps the lookup its merged variants read their orientation from", async () => {
  const blocks = []
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) blocks.push({ id: "stone", pos: [x, 0, z] })
  const shared = createSharedAtlas()
  const handle = await createScene(assets, blocks, { lighting: "world", sharedAtlas: shared })
  let built
  handle.group.traverse(o => { if (o.isMesh) built = o })
  const { payload } = await packScene(handle, { sharedAtlas: shared })
  const tile = reviveScene(payload, { sharedAtlas: shared })
  const [mesh] = tile.group.children
  assert.equal(mesh.geometry.index.count, 36)
  assert.ok(mesh.geometry.attributes.tileLookup.array instanceof Uint16Array)
  assert.deepEqual(mesh.geometry.attributes.tileLookup.array, built.geometry.attributes.tileLookup.array)
  assert.ok("TILE_LOOKUP" in mesh.material.defines)
  const lookup = mesh.material.uniforms.tileLookupMap.value, source = built.material.uniforms.tileLookupMap.value
  assert.ok(lookup.isDataTexture)
  assert.notEqual(lookup, source)
  assert.equal(lookup.format, source.format)
  assert.equal(lookup.magFilter, THREE.NearestFilter)
  assert.equal(lookup.image.width, source.image.width)
  assert.equal(lookup.image.height, source.image.height)
  assert.deepEqual(lookup.image.data, source.image.data)
  assert.ok(lookup.image.data.some(v => v > 0))
  assert.equal(mesh.material.uniforms.tileLookupSize.value.x, source.image.width)
  assert.equal(mesh.material.uniforms.tileLookupSize.value.y, source.image.height)
  let freed = 0
  lookup.addEventListener("dispose", () => freed++)
  tile.dispose()
  assert.equal(freed, 1)
  handle.dispose()
  shared.dispose()
})

test("a shared atlas stitches, shares its layout and takes textures through its own methods", async () => {
  const shared = createSharedAtlas()
  assert.equal(await shared.stitch(assets, { atlases: ["blocks"] }), shared)
  const layout = shared.exportLayout()
  assert.equal(layout.size, shared.size)
  assert.ok(layout.pages >= 1)
  assert.ok(layout.rects.length > 500)

  const adopter = createSharedAtlas()
  assert.equal(adopter.adoptLayout(structuredClone(layout)), adopter)
  assert.equal(adopter.frozen, true)
  assert.deepEqual(adopter.exportLayout(), layout)

  const { image } = await readTexture(assets, "assets/minecraft/textures/item/apple.png")
  const added = await shared.insert([{ key: "test:apple", image }])
  assert.equal(added.pages, shared.exportLayout().pages)
  assert.equal(added.rects.length, 1)
  assert.equal(added.rects[0][0], "test:apple")
  assert.equal(added.rects[0][1].w, 16)
  assert.equal(shared.exportLayout().rects.length, layout.rects.length + 1)
  assert.deepEqual((await shared.insert([{ key: "test:apple", image }])).rects, added.rects)

  assert.equal(await createSharedAtlas().stitch(assets, { shouldCancel: () => true }), null)
  for (const name of ["stitchSharedAtlas", "exportSharedAtlasLayout", "adoptSharedAtlasLayout", "insertSharedTextures"]) assert.equal(name in lib, false, name)
  shared.dispose()
  adopter.dispose()
})

test("reviveScene refuses the old atlas option", () => {
  const shared = createSharedAtlas()
  assert.throws(() => reviveScene({ textures: [], materials: [], meshes: [] }, { atlas: shared }), { message: 'reviveScene: "atlas" is now "sharedAtlas"' })
  shared.dispose()
})

test("a revived scene's light takes an offset like a built scene's", async () => {
  const shared = createSharedAtlas()
  const handle = await createScene(assets, [{ id: "stone", pos: [4, 2, -3] }, { id: "torch", pos: [4, 3, -3] }], { sharedAtlas: shared })
  const { payload } = await packScene(handle, { sharedAtlas: shared })
  const tile = reviveScene(payload, { sharedAtlas: shared })
  const built = handle.light.uniforms.lightVolOrigin.value, revived = tile.light.uniforms.lightVolOrigin.value
  assert.notEqual(revived, built)
  const xyz = v => [v.x, v.y, v.z]
  const carried = xyz(revived)
  assert.deepEqual(carried, handle.light.origin)
  for (const mesh of tile.group.children) assert.equal(mesh.material.uniforms.lightVolOrigin, tile.light.uniforms.lightVolOrigin)
  for (const offset of [[32, -16, 8], [new THREE.Vector3(32, -16, 8)], [{ x: 32, y: -16, z: 8 }], [[32, -16, 8]]]) {
    tile.light.setOffset()
    assert.deepEqual(xyz(revived), carried)
    tile.light.setOffset(...offset)
    handle.light.setOffset(...offset)
    assert.deepEqual(xyz(revived), [carried[0] + 2, carried[1] - 1, carried[2] + 0.5])
    assert.deepEqual(xyz(revived), xyz(built))
  }
  tile.dispose()
  handle.dispose()
  shared.dispose()
})
