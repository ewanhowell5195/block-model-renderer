import test from "node:test"
import assert from "node:assert/strict"
import sharp from "sharp"
import { computeSceneLight, createScene, prepareAssets, createSharedAtlas, packScene, reviveScene, makeModelScene, renderModelScene, wasmStatus } from "../src/node.js"
import { THREE, platform } from "../src/core/platform.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const assets = await prepareAssets([await loadMojangJar()], { cache: true })

const PALETTE = [
  { id: "stone" }, { id: "glass" }, { id: "oak_leaves", properties: { persistent: "true" } },
  { id: "torch" }, { id: "dirt" }, { id: "oak_slab", properties: { type: "bottom" } },
  { id: "cobblestone_stairs", properties: { facing: "north", half: "bottom", shape: "straight" } },
  { id: "water", properties: { level: "0" } }, { id: "oak_fence" }, { id: "red_stained_glass" }, { id: "oak_planks" }
]

function randomBlocks(w, h, d, seed, density) {
  const blocks = []
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) for (let z = 0; z < d; z++) {
    const r = rnd()
    if (r < density) continue
    const e = PALETTE[(r * PALETTE.length) | 0]
    blocks.push({ id: e.id, properties: e.properties, pos: [x - 2, y + 3, z - 5] })
  }
  return blocks.length ? blocks : [{ id: "stone", pos: [0, 0, 0] }]
}

function scatter(seed, density) {
  return (x, y, z) => {
    let v = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791) ^ seed
    v = Math.imul(v ^ (v >>> 13), 1274126177)
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296 < density
  }
}

async function forced(neighbors, wasm, run) {
  globalThis.__BMR_AO_NEIGHBORS = neighbors
  if (!wasm) globalThis.__BMR_NO_WASM = true
  try {
    return await run()
  } finally {
    delete globalThis.__BMR_AO_NEIGHBORS
    delete globalThis.__BMR_NO_WASM
  }
}

const PLANES = [(u, v) => [0, u, v], (u, v) => [u, 0, v], (u, v) => [u, v, 0]]
const PLACES = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]

test("the kernels are live for the ambient occlusion checks", async () => {
  assert.equal(await wasmStatus(), true)
})

test("node keeps per-cell ambient occlusion unless forced", async () => {
  const handle = await createScene(assets, randomBlocks(4, 3, 4, 3, 0.3), { lighting: "world" })
  const u = handle.light.uniforms
  assert.equal(u.lightAo.value, u.lightVol.value)
  assert.ok(u.lightAoMask)
  assert.equal(u.lightAoCols, undefined)
  let materials = 0
  handle.group.traverse(o => {
    for (const m of [].concat(o.material ?? [])) {
      if (!m.defines || !("LIGHT_VOLUME" in m.defines)) continue
      materials++
      assert.equal("AO_NEIGHBORS" in m.defines, false)
    }
  })
  assert.ok(materials > 0)
  handle.dispose()
})

test("the neighbour texture holds every cell's clamped neighbours on both kernels", async () => {
  let seed = 777, borderBits = 0
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let t = 0; t < 24; t++) {
    const blocks = randomBlocks(1 + ((rnd() * 6) | 0), 1 + ((rnd() * 6) | 0), 1 + ((rnd() * 6) | 0), 1 + ((rnd() * 1e6) | 0), 0.1 + rnd() * 0.8)
    const opts = t % 3 ? { externalOcclusion: scatter((rnd() * 1e6) | 0, rnd()) } : {}
    const classic = await forced(false, true, () => computeSceneLight(assets, blocks, opts))
    const fast = await forced(true, true, () => computeSceneLight(assets, blocks, opts))
    const slow = await forced(true, false, () => computeSceneLight(assets, blocks, opts))
    const [w, h, d] = classic.size
    const cu = classic.uniforms, nu = fast.uniforms
    const cells = cu.lightAo.value.image.data, cellCols = cu.lightVolCols.value, cellTexW = cu.lightVolTex.value.x
    const near = nu.lightAo.value.image.data, cols = nu.lightAoCols.value, texW = nu.lightAoTex.value.x
    assert.equal(nu.lightAoMask, undefined)
    assert.equal(nu.lightAo.value.magFilter, THREE.NearestFilter)
    assert.equal(nu.lightAo.value.minFilter, THREE.NearestFilter)
    assert.equal(near.length, texW * nu.lightAoTex.value.y * 4)
    assert.deepEqual(slow.uniforms.lightAo.value.image.data, near, `case ${t}: kernels differ`)
    assert.deepEqual([slow.uniforms.lightAoCols.value, slow.uniforms.lightAoTex.value.toArray()], [cols, nu.lightAoTex.value.toArray()])
    assert.deepEqual(nu.lightVol.value.image.data, cu.lightVol.value.image.data)
    const clamp = (v, n) => v < 0 ? 0 : v >= n ? n - 1 : v
    const occluder = (x, y, z) => {
      const cy = clamp(y, h)
      return cells[((Math.floor(cy / cellCols) * (d + 1) + clamp(z, d)) * cellTexW + (cy % cellCols) * (w + 1) + clamp(x, w)) * 4 + 2] > 127 ? 1 : 0
    }
    for (let y = -1; y <= h; y++) for (let z = -1; z <= d; z++) for (let x = -1; x <= w; x++) {
      const ti = ((Math.floor((y + 1) / cols) * (d + 2) + z + 1) * texW + ((y + 1) % cols) * (w + 2) + x + 1) * 4
      const border = x < 1 || y < 1 || z < 1 || x > w - 2 || y > h - 2 || z > d - 2
      if (near[ti + 3] !== occluder(x, y, z) * 255) assert.fail(`case ${t}: centre of ${x},${y},${z}`)
      for (let ch = 0; ch < 3; ch++) for (let b = 0; b < 8; b++) {
        const [dx, dy, dz] = PLANES[ch](...PLACES[b])
        const want = occluder(x + dx, y + dy, z + dz)
        if (border) borderBits += want
        if (((near[ti + ch] >> b) & 1) !== want) assert.fail(`case ${t}: channel ${ch} bit ${b} of ${x},${y},${z}`)
      }
    }
    for (const light of [classic, fast, slow]) light.dispose()
  }
  assert.ok(borderBits > 1000)
})

function nearestAo(handle) {
  const u = handle.light.uniforms.lightAo, image = u.value.image
  const texture = new THREE.DataTexture(image.data, image.width, image.height)
  texture.minFilter = texture.magFilter = THREE.NearestFilter
  texture.needsUpdate = true
  u.value = texture
  return texture
}

const VIEWS = [["ortho", -0.785, 0.524, 1], ["ortho", 2.513, 1.047, 2.5], ["ortho", 4.1, -0.45, 1.3], ["persp", 0.9, 0.35, 0.6], ["persp", 3.6, 0.9, 0.25]]

async function shoot(handle, drift = [0, 0, 0]) {
  const { scene, camera } = await makeModelScene()
  scene.add(handle.group)
  const { min, max } = handle.bounds
  const centre = new THREE.Vector3(3.5, -9.25, 21)
  handle.group.position.set(-(min.x + max.x) / 2, -(min.y + max.y) / 2, -(min.z + max.z) / 2).add(centre)
  handle.group.updateMatrixWorld(true)
  handle.light.setOffset(handle.group.position.x + drift[0], handle.group.position.y + drift[1], handle.group.position.z + drift[2])
  const full = Math.max(24, Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2)
  const cameras = { ortho: camera, persp: new THREE.PerspectiveCamera(55, 1, 0.5, 4000) }
  const frames = []
  for (const [kind, yaw, pitch, zoom] of VIEWS) {
    const cam = cameras[kind], distance = kind === "ortho" ? full * 2 : full * 2.2 * zoom
    cam.position.set(Math.sin(yaw) * Math.cos(pitch) * distance, Math.sin(pitch) * distance, Math.cos(yaw) * Math.cos(pitch) * distance).add(centre)
    cam.lookAt(centre)
    if (kind === "ortho") Object.assign(cam, { left: -full / zoom, right: full / zoom, top: full / zoom, bottom: -full / zoom, near: 0.01, far: distance * 3 })
    cam.updateProjectionMatrix()
    handle.sortTranslucent?.(cam)
    frames.push(await sharp(await renderModelScene(scene, cam, { width: 192, height: 192 })).ensureAlpha().raw().toBuffer())
  }
  scene.remove(handle.group)
  return frames
}

function differing(a, b) {
  let n = 0
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++
  return n
}

const SCENES = [
  ["mixed", randomBlocks(9, 7, 9, 4242, 0.45), {}, [0, 0, 0]],
  ["unmerged", randomBlocks(6, 5, 6, 99, 0.6), { optimize: false }, [0, 0, 0]],
  ["cube adrift", randomBlocks(4, 4, 4, 5, 0), { externalOcclusion: scatter(31, 0.4) }, [9, 23, -17]]
]

for (const wasm of [true, false]) {
  for (const [name, blocks, opts, drift] of SCENES) {
    test(`the neighbour texture shades every pixel like per-cell reads: ${name}, ${wasm ? "wasm" : "js"}`, async () => {
      const classic = await forced(false, wasm, () => createScene(assets, blocks, { lighting: "world", ...opts }))
      const near = await forced(true, wasm, () => createScene(assets, blocks, { lighting: "world", ...opts }))
      const exact = nearestAo(classic)
      let materials = 0
      near.group.traverse(o => {
        for (const m of [].concat(o.material ?? [])) {
          if (!m.defines || !("LIGHT_VOLUME" in m.defines)) continue
          materials++
          assert.ok("AO_NEIGHBORS" in m.defines)
          assert.equal(m.uniforms.lightAo, near.light.uniforms.lightAo)
          assert.equal(m.uniforms.lightAoCols, near.light.uniforms.lightAoCols)
        }
      })
      assert.ok(materials > 0)
      const want = await shoot(classic, drift), got = await shoot(near, drift)
      for (let i = 0; i < VIEWS.length; i++) assert.equal(differing(want[i], got[i]), 0, `view ${i}`)
      near.lightSwitches.ambientOcclusion.value = false
      const flat = await shoot(near, drift)
      assert.ok(differing(flat[0], got[0]) > 50)
      exact.dispose()
      classic.dispose()
      near.dispose()
    })
  }
}

test("a neighbour texture survives packScene, reviveScene and release", async () => {
  const blocks = randomBlocks(6, 5, 6, 4242, 0.45).filter(b => b.id !== "water" && b.id !== "red_stained_glass")
  const shared = createSharedAtlas()
  const built = await forced(true, true, () => createScene(assets, blocks, { lighting: "world", sharedAtlas: shared }))
  const released = await forced(true, true, () => createScene(assets, blocks, { lighting: "world", sharedAtlas: shared, release: true }))
  const { payload } = await packScene(built, { sharedAtlas: shared })
  const tile = reviveScene(payload, { sharedAtlas: shared })
  tile.bounds = built.bounds
  const source = built.light.uniforms.lightAo.value, revived = tile.light.uniforms.lightAo.value
  assert.deepEqual(Object.keys(tile.light.uniforms).sort(), Object.keys(built.light.uniforms).sort())
  assert.notEqual(revived, source)
  assert.equal(revived.magFilter, THREE.NearestFilter)
  assert.equal(revived.format, THREE.RGBAFormat)
  assert.deepEqual(revived.image.data, source.image.data)
  assert.equal(tile.light.uniforms.lightAoCols.value, built.light.uniforms.lightAoCols.value)
  assert.deepEqual(tile.light.uniforms.lightAoTex.value.toArray(), built.light.uniforms.lightAoTex.value.toArray())
  for (const mesh of tile.group.children) {
    for (const m of [].concat(mesh.material)) {
      assert.ok("AO_NEIGHBORS" in m.defines)
      for (const k of ["lightAo", "lightAoTex", "lightAoCols"]) assert.equal(m.uniforms[k], tile.light.uniforms[k])
    }
  }
  const want = await shoot(built)
  const fromTile = await shoot(tile), fromReleased = await shoot(released)
  for (let i = 0; i < VIEWS.length; i++) {
    assert.equal(differing(want[i], fromTile[i]), 0, `revived view ${i}`)
    assert.equal(differing(want[i], fromReleased[i]), 0, `released view ${i}`)
  }
  const freed = released.light.uniforms.lightAo.value.image
  assert.equal(freed.data, null)
  assert.equal(freed.width, source.image.width)
  assert.equal(released.light.blockLight, null)
  assert.ok(source.image.data)
  tile.dispose()
  built.dispose()
  released.dispose()
  shared.dispose()
})

test("the neighbour texture counts toward the texture limit", async () => {
  const max = platform.maxTextureSize()
  const blocks = [{ id: "stone", pos: [0, 0, 0] }, { id: "stone", pos: [max - 4, 0, 0] }]
  const classic = await forced(false, true, () => computeSceneLight(assets, blocks))
  assert.equal(classic.uniforms.lightVolTex.value.x, max)
  classic.dispose()
  await assert.rejects(forced(true, true, () => computeSceneLight(assets, blocks)), new RegExp(`${max - 3}x1x1.*needs a ${max + 1}x\\d+ texture.*light: false`))
})
