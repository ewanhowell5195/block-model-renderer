import test from "node:test"
import assert from "node:assert/strict"
import { wasmReady, greedyMeshFast } from "../src/core/fast.js"

await wasmReady()

test("the wasm kernels load", () => {
  assert.notEqual(greedyMeshFast(Int32Array.from([0, 0, 0]), 1), null, "wasm module did not load")
})

// the js reference, copied from optimize.js so both walks can be compared
const GR_M = 1 << 25, GR_W = 67108864
const packCell = (i, j) => (j + GR_M) * GR_W + (i + GR_M)
function greedyRects(cellSet) {
  const done = new Set(), rects = []
  const coords = Float64Array.from(cellSet).sort()
  for (const v of coords) {
    if (done.has(v)) continue
    const im = v % GR_W, i0 = im - GR_M, j0 = (v - im) / GR_W - GR_M
    let a1 = i0
    while (cellSet.has(v + (a1 - i0 + 1)) && !done.has(v + (a1 - i0 + 1))) a1++
    let b1 = j0, grow = true
    while (grow) {
      const rowBase = v + (b1 + 1 - j0) * GR_W
      for (let x = 0; x <= a1 - i0; x++) { const c = rowBase + x; if (!cellSet.has(c) || done.has(c)) { grow = false; break } }
      if (grow) b1++
    }
    for (let y = 0; y <= b1 - j0; y++) for (let x = 0; x <= a1 - i0; x++) done.add(v + y * GR_W + x)
    rects.push([i0, a1, j0, b1])
  }
  return rects
}
function greedyMeshJs(triples, gridCount) {
  const per = []
  for (let g = 0; g < gridCount; g++) per.push(null)
  for (let i = 0; i < triples.length; i += 3) {
    const g = triples[i]
    if (g < 0 || g >= gridCount) continue
    ;(per[g] ??= new Set()).add(packCell(triples[i + 1], triples[i + 2]))
  }
  const out = []
  for (let g = 0; g < gridCount; g++) {
    if (!per[g]) continue
    for (const [i0, i1, j0, j1] of greedyRects(per[g])) out.push(g, i0, i1, j0, j1)
  }
  return Int32Array.from(out)
}

let seed = 1
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff

test("greedy meshing matches the js walk on random grids", () => {
  let cases = 0
  for (let t = 0; t < 400; t++) {
    const grids = 1 + ((rnd() * 6) | 0)
    const span = 1 + ((rnd() * 14) | 0)
    const density = 0.15 + rnd() * 0.8
    const off = ((rnd() * 200) | 0) - 100     // negative coordinates too
    const trip = []
    for (let g = 0; g < grids; g++) {
      for (let a = 0; a < span; a++) for (let b = 0; b < span; b++) {
        if (rnd() < density) trip.push(g, a + off, b - off)
      }
      // duplicates, which the js Set collapsed
      if (rnd() < 0.3 && trip.length) { const i = ((rnd() * (trip.length / 3)) | 0) * 3; trip.push(trip[i], trip[i + 1], trip[i + 2]) }
    }
    const arr = Int32Array.from(trip)
    assert.deepEqual(Array.from(greedyMeshFast(arr, grids)), Array.from(greedyMeshJs(arr, grids)), `case ${t}`)
    cases++
  }
  assert.equal(cases, 400)
})

test("greedy meshing matches on empty and degenerate input", () => {
  for (const [trip, n] of [[[], 0], [[], 3], [[0, 0, 0], 1], [[2, 5, 5], 3]]) {
    const arr = Int32Array.from(trip)
    assert.deepEqual(Array.from(greedyMeshFast(arr, n)), Array.from(greedyMeshJs(arr, n)), `${JSON.stringify(trip)} / ${n}`)
  }
})

test("greedy meshing matches when the cells are too far apart to sit in a dense grid", () => {
  // forces the sparse walk, which needs its own ordering to line up
  const trip = []
  for (let a = 0; a < 40; a++) for (let b = 0; b < 40; b++) {
    trip.push(0, a * 200003, b * 199999)
  }
  for (let a = 0; a < 8; a++) trip.push(0, a, a)
  const arr = Int32Array.from(trip)
  assert.deepEqual(Array.from(greedyMeshFast(arr, 1)), Array.from(greedyMeshJs(arr, 1)))
})
