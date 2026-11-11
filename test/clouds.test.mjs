import test from "node:test"
import assert from "node:assert/strict"
import sharp from "sharp"
import { createClouds, makeModelScene, renderModelScene } from "../src/node.js"

const CELL = 12 * 16
const THICKNESS = 4 * 16

async function cloudPack(rows) {
  const width = rows[0].length, height = rows.length
  const data = Buffer.alloc(width * height * 4)
  rows.forEach((row, z) => Array.from(row).forEach((cell, x) => data.fill(cell === "#" ? 255 : 0, (x + z * width) * 4, (x + z * width + 1) * 4)))
  const png = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer()
  return { read: file => file === "assets/minecraft/textures/environment/clouds.png" ? png : null }
}

function randomRows(size, density, seed) {
  let state = seed
  function next() {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  return Array.from({ length: size }, () => Array.from({ length: size }, () => next() < density ? "#" : ".").join(""))
}

function meshes(clouds) {
  const found = []
  clouds.group.traverse(obj => {
    if (obj.isMesh) found.push(obj)
  })
  return found
}

function measure(geometry, rows) {
  const pos = geometry.attributes.position.array, index = geometry.index.array
  const spanX = rows[0].length * CELL, spanZ = rows.length * CELL
  const key = i => (pos[i * 3] % spanX) + "," + pos[i * 3 + 1] + "," + (pos[i * 3 + 2] % spanZ)
  const edges = new Map()
  let area = 0
  for (let t = 0; t < index.length; t += 3) {
    const corners = [index[t], index[t + 1], index[t + 2]]
    const [a, b, c] = corners.map(i => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]])
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const twice = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
    assert.ok(twice > 0, "no degenerate triangles")
    area += twice / 2
    corners.forEach((p, n) => {
      const pair = [key(p), key(corners[(n + 1) % 3])].sort().join("|")
      edges.set(pair, (edges.get(pair) ?? 0) + 1)
    })
  }
  return { area, triangles: index.length / 3, open: Array.from(edges.values()).filter(count => count % 2).length }
}

function expected(rows) {
  const height = rows.length, width = rows[0].length
  const at = (x, z) => rows[(z + height) % height][(x + width) % width] === "#"
  let cells = 0, sides = 0
  for (let z = 0; z < height; z++) {
    for (let x = 0; x < width; x++) {
      if (!at(x, z)) continue
      cells++
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!at(x + dx, z + dz)) sides++
    }
  }
  return { cells, sides }
}

const PATTERNS = {
  full: ["####", "####", "####", "####"],
  band: ["........", "########", "########", "........"],
  ring: ["......", ".####.", ".#..#.", ".#..#.", ".####.", "......"],
  diagonal: ["#...", ".#..", "..#.", "...#"],
  seams: ["##....##", "#......#", "........", "...##...", "#......#", "##.##.##"],
  sparse: randomRows(24, 0.3, 7),
  half: randomRows(24, 0.5, 11),
  dense: randomRows(24, 0.8, 23)
}

for (const [name, rows] of Object.entries(PATTERNS)) {
  test(`cloud shell is closed and covers every cell: ${name}`, async () => {
    const clouds = await createClouds([await cloudPack(rows)], { tick: false })
    const { cells, sides } = expected(rows)
    const shell = measure(meshes(clouds)[0].geometry, rows)
    assert.equal(shell.open, 0)
    assert.equal(shell.area, cells * 2 * CELL * CELL + sides * CELL * THICKNESS)
    assert.ok(shell.triangles <= (cells * 2 + sides) * 2)
    clouds.fancy = false
    const sheet = measure(meshes(clouds)[0].geometry, rows)
    assert.equal(sheet.area, cells * CELL * CELL)
    assert.ok(sheet.triangles <= cells * 2)
  })
}

test("cloud interior is built when the anchor first enters the layer", async () => {
  const clouds = await createClouds([await cloudPack(PATTERNS.ring)], { tick: false, height: 100 })
  const interior = meshes(clouds)[1]
  clouds.update([0, 90 * 16, 0])
  assert.equal(interior.geometry.index.count, 0)
  clouds.update([0, 101 * 16, 0])
  assert.equal(interior.geometry.index.count, expected(PATTERNS.ring).cells * 36)
  assert.ok(interior.count > 0)
})

test("fast clouds and a pack with no cloud texture render", async () => {
  for (const [assets, args] of [[[await cloudPack(PATTERNS.ring)], { fancy: false }], [[{ read: () => null }], {}]]) {
    const clouds = await createClouds(assets, args)
    const { scene, camera } = makeModelScene()
    scene.add(clouds.group)
    await renderModelScene(scene, camera, { width: 16, height: 16 })
  }
})
