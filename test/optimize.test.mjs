import test from "node:test"
import assert from "node:assert/strict"
import sharp from "sharp"
import { createScene, prepareAssets, parseBlockstate, resolveModelData, loadModel, optimizeScene, createSharedAtlas, makeModelScene, renderModelScene } from "../src/node.js"
import { THREE, platform } from "../src/core/platform.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const assets = await prepareAssets([await loadMojangJar()], { cache: true })

async function build(id, lighting = "world") {
  const group = new THREE.Group()
  for (const model of await parseBlockstate(assets, id)) await loadModel(assets, await resolveModelData(assets, model), { parent: group, lighting })
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
  const { scene, camera } = await makeModelScene()
  scene.add(handle.group)
  const { min, max } = handle.bounds ?? new THREE.Box3().setFromObject(handle.group)
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
      assert.ok(Number.isInteger(v * 8))
    }
    assert.equal(uv.getY(i) * 8 & 1, 0)
  }
  assert.equal(mesh.geometry.attributes.tileLookup, undefined)
  assert.ok(!("TILE_LOOKUP" in mesh.material.defines))
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

function differing(a, b) {
  let differ = 0
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 24 || Math.abs(a[i + 1] - b[i + 1]) > 24 || Math.abs(a[i + 2] - b[i + 2]) > 24 || Math.abs(a[i + 3] - b[i + 3]) > 24) differ++
  return differ
}

test("a block's random variants merge on a shared atlas and render like the plain build", async () => {
  const blocks = []
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) blocks.push({ id: "grass_block", pos: [x, 0, z] })
  const shared = createSharedAtlas()
  const tiled = await createScene(assets, blocks, { lighting: "world", sharedAtlas: shared })
  const baked = await createScene(assets, blocks, { lighting: "world" })
  const [mesh] = meshesOf(tiled)
  assert.equal(tiled.tris, 132)
  assert.ok(baked.tris > tiled.tris * 2)
  const normal = mesh.geometry.attributes.normal, index = mesh.geometry.index.array
  let up = 0, down = 0
  for (let i = 0; i < index.length; i += 6) {
    if (normal.getY(index[i]) > 0.5) up++
    if (normal.getY(index[i]) < -0.5) down++
  }
  assert.equal(up, 1)
  assert.equal(down, 1)
  assert.ok(mesh.geometry.attributes.tileLookup.array instanceof Uint16Array)
  assert.ok("TILE_LOOKUP" in mesh.material.defines)
  const lookup = mesh.material.uniforms.tileLookupMap.value, size = mesh.material.uniforms.tileLookupSize.value
  assert.ok(lookup.isDataTexture)
  assert.equal(size.x, lookup.image.width)
  assert.equal(size.y, lookup.image.height)
  assert.ok(size.x * size.y >= 128)
  const differ = differing(await shoot(tiled), await shoot(baked))
  assert.ok(differ < 256 * 256 * 0.005, `${differ} pixels differ`)
  let freed = 0
  lookup.addEventListener("dispose", () => freed++)
  tiled.dispose()
  assert.equal(freed, 1)
  baked.dispose()
  shared.dispose()
})

async function oriented(o) {
  const face = { texture: "#t", uv: o & 4 ? [16, 0, 0, 16] : [0, 0, 16, 16], rotation: (o & 3) * 90 }
  const group = new THREE.Group()
  await loadModel(assets, { type: "block", textures: { t: "minecraft:block/bookshelf" }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { down: face, up: face, north: face, south: face, west: face, east: face } }] }, { parent: group, lighting: "world" })
  return group
}

function tileVertex(mesh, v) {
  const { uv, tileRect, tileLookup } = mesh.geometry.attributes
  let span = [Math.floor(uv.getX(v)), Math.floor(uv.getY(v))]
  const bits = [Math.round((uv.getX(v) - span[0]) * 8), Math.round((uv.getY(v) - span[1]) * 8)]
  let corner = [bits[0] >> 2, bits[1] >> 2]
  if (bits[0] & 2) {
    span = [span[1], span[0]]
    corner = [corner[1], corner[0]]
  }
  return {
    span,
    turn: bits[1] & 1 ? 8 : (bits[0] & 3) + (bits[1] & 2) * 2,
    lookup: bits[1] & 1 ? [tileLookup.getX(v), tileLookup.getY(v)] : null,
    at: [Math.abs(corner[0] - (bits[0] & 1)) * span[0], Math.abs(corner[1] - (bits[1] >> 1 & 1)) * span[1]],
    size: [tileRect.getZ(v), tileRect.getW(v)]
  }
}

function tileTexel(mesh, vert, at) {
  let within = at.map((v, k) => v >= vert.span[k] ? 1 : v - Math.floor(v))
  if (vert.lookup) {
    const map = mesh.material.uniforms.tileLookupMap.value.image, cell = at.map((v, k) => Math.min(Math.floor(v), vert.span[k] - 1))
    const turn = map.data[((vert.lookup[1] + cell[1]) * map.width + vert.lookup[0] + cell[0]) * (map.data.length / map.width / map.height)]
    if (turn & 1) within = [within[1], within[0]]
    within = [Math.abs(within[0] - (turn >> 1 & 1)), Math.abs(within[1] - (turn >> 2))]
  }
  return [Math.floor(within[0] * vert.size[0]), vert.size[1] - 1 - Math.floor(within[1] * vert.size[1])]
}

function mergedTexel(mesh, point, axis, sign, turns) {
  const { position, normal } = mesh.geometry.attributes, index = mesh.geometry.index.array, a = (axis + 1) % 3, b = (axis + 2) % 3
  for (let i = 0; i < index.length; i += 6) {
    const corners = Array.from(new Set(index.slice(i, i + 6)))
    if (normal.getComponent(corners[0], axis) * sign < 0.5 || position.getComponent(corners[0], axis) !== point[axis]) continue
    const as = corners.map(v => position.getComponent(v, a)), bs = corners.map(v => position.getComponent(v, b))
    const a0 = Math.min(...as), a1 = Math.max(...as), b0 = Math.min(...bs), b1 = Math.max(...bs)
    if (point[a] < a0 || point[a] > a1 || point[b] < b0 || point[b] > b1) continue
    const verts = corners.map(v => tileVertex(mesh, v)), s = (point[a] - a0) / (a1 - a0), t = (point[b] - b0) / (b1 - b0), at = [0, 0]
    corners.forEach((v, k) => {
      const weight = (as[k] === a1 ? s : 1 - s) * (bs[k] === b1 ? t : 1 - t)
      at[0] += verts[k].at[0] * weight
      at[1] += verts[k].at[1] * weight
    })
    turns.add(verts[0].turn)
    return tileTexel(mesh, verts[0], at)
  }
  return null
}

function templateTexel(group, pos, point, axis, sign) {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), weight = new THREE.Vector3()
  const local = new THREE.Vector3(point[0] - pos[0] * 16, point[1] - pos[1] * 16, point[2] - pos[2] * 16)
  let texel = null
  group.updateMatrixWorld(true)
  group.traverse(o => {
    if (!o.isMesh) return
    const { position, normal, uv } = o.geometry.attributes, index = o.geometry.index.array
    for (let i = 0; i < index.length; i += 3) {
      const [ia, ib, ic] = index.slice(i, i + 3)
      a.fromBufferAttribute(position, ia).applyMatrix4(o.matrixWorld)
      b.fromBufferAttribute(position, ib).applyMatrix4(o.matrixWorld)
      c.fromBufferAttribute(position, ic).applyMatrix4(o.matrixWorld)
      n.fromBufferAttribute(normal, ia).transformDirection(o.matrixWorld)
      if (n.getComponent(axis) * sign < 0.5 || Math.abs(a.getComponent(axis) - local.getComponent(axis)) > 1e-4) continue
      THREE.Triangle.getBarycoord(local, a, b, c, weight)
      if (Math.min(weight.x, weight.y, weight.z) < 0) continue
      const u = uv.getX(ia) * weight.x + uv.getX(ib) * weight.y + uv.getX(ic) * weight.z, v = uv.getY(ia) * weight.x + uv.getY(ib) * weight.y + uv.getY(ic) * weight.z
      texel = [Math.floor(u * 16), Math.floor((1 - v) * 16)]
    }
  })
  return texel
}

test("merged faces of every orientation sample the texels their blocks do", async () => {
  const templates = []
  for (let o = 0; o < 8; o++) templates.push(await oriented(o))
  const placements = []
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) placements.push({ pos: [x, 0, z], group: templates[(x + z * 4) * 3 & 7] })
  for (let o = 0; o < 8; o++) for (let k = 0; k < 2; k++) placements.push({ pos: [k + (o & 1) * 3, 2, (o >> 1) * 2], group: templates[o] })
  const shared = createSharedAtlas(), webgl2 = platform.webgl2
  const tiled = await optimizeScene(placements, { sharedAtlas: shared })
  const baked = await optimizeScene(placements)
  const [mesh] = meshesOf(tiled)
  assert.ok(mesh.geometry.attributes.tileLookup)
  assert.deepEqual([tiled.tris, baked.tris], [164, 320])
  const box = new THREE.Box3().setFromObject(templates[0]), lo = box.min.toArray(), hi = box.max.toArray()
  const turns = new Set()
  for (const { pos, group } of placements) for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) for (const [s, t] of [[0.2, 0.7], [0.55, 0.1], [0.9, 0.45]]) {
    const point = [0, 1, 2].map(k => pos[k] * 16 + (k === axis ? sign > 0 ? hi[k] : lo[k] : lo[k] + (hi[k] - lo[k]) * (k === (axis + 1) % 3 ? s : t)))
    const expected = templateTexel(group, pos, point, axis, sign)
    assert.ok(expected)
    assert.deepEqual(mergedTexel(mesh, point, axis, sign, turns), expected, `face ${sign * (axis + 1)} of the block at ${pos}`)
  }
  assert.equal(turns.size, 9)
  const data = mesh.material.uniforms.tileLookupMap.value.image.data
  assert.equal(mesh.material.uniforms.tileLookupMap.value.format, THREE.RGBAFormat)
  assert.equal(new Set(data.filter((v, i) => i % 4 === 0)).size, 8)
  const differ = differing(await shoot(tiled), await shoot(baked))
  assert.ok(differ < 256 * 256 * 0.005, `${differ} pixels differ`)
  tiled.dispose()
  baked.dispose()
  platform.webgl2 = () => true
  let single
  try {
    single = await optimizeScene(placements, { sharedAtlas: shared })
  } finally {
    platform.webgl2 = webgl2
  }
  const [packed] = meshesOf(single), lookup = packed.material.uniforms.tileLookupMap.value
  assert.equal(lookup.format, THREE.RedFormat)
  assert.equal(lookup.image.data.length, lookup.image.width * lookup.image.height)
  assert.deepEqual(lookup.image.data, data.filter((v, i) => i % 4 === 0))
  for (const { pos, group } of placements) {
    const point = [pos[0] * 16 + lo[0] + 3.2, pos[1] * 16 + hi[1], pos[2] * 16 + lo[2] + 11.2]
    assert.deepEqual(mergedTexel(packed, point, 1, 1, turns), templateTexel(group, pos, point, 1, 1))
  }
  single.dispose()
  shared.dispose()
})

const MOVING = [{ id: "white_banner", pos: [0, 0, 0] }, { id: "chest", pos: [2, 0, 0] }, { id: "bell", pos: [4, 0, 0] }, { id: "stone", pos: [1, 0, 1] }]

test("a still shows moving block entity parts posed on its first frame", async () => {
  const warm = await createScene(assets, MOVING, { lighting: "world" })
  await shoot(warm)
  const handle = await createScene(assets, MOVING, { lighting: "world" })
  const first = await shoot(handle), second = await shoot(handle)
  assert.ok(first.equals(second))
  warm.dispose()
  handle.dispose()
})
