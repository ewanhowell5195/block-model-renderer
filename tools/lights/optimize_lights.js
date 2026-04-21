import getTHREE from "headless-three"
import { Canvas, Image, ImageData } from "skia-canvas"
import fs from "node:fs"

const { THREE } = await getTHREE({ Canvas, Image, ImageData })

const AXIS_VECTORS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }
const modelsDir = "pack/assets/minecraft/models/item"

const geoNormals = {
  east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
  south: [0, 0, 1], north: [0, 0, -1],
}

function getShaderNormal(faceName, elementRotation, displayRot) {
  const rootGroup = new THREE.Group()
  const displayGroup = new THREE.Group()
  const containerGroup = new THREE.Group()
  rootGroup.add(displayGroup)
  displayGroup.add(containerGroup)

  if (displayRot) {
    const delta = new THREE.Euler(
      THREE.MathUtils.degToRad(displayRot[0]),
      THREE.MathUtils.degToRad(displayRot[1]),
      THREE.MathUtils.degToRad(displayRot[2]),
      "XYZ"
    )
    displayGroup.quaternion.multiply(new THREE.Quaternion().setFromEuler(delta))
  }

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))

  if (elementRotation) {
    const rotGroup = new THREE.Group()
    if (elementRotation.axis) {
      rotGroup.rotateOnAxis(AXIS_VECTORS[elementRotation.axis], THREE.MathUtils.degToRad(elementRotation.angle))
    } else {
      rotGroup.rotateZ(THREE.MathUtils.degToRad(elementRotation.z ?? 0))
      rotGroup.rotateY(THREE.MathUtils.degToRad(elementRotation.y ?? 0))
      rotGroup.rotateX(THREE.MathUtils.degToRad(elementRotation.x ?? 0))
    }
    rotGroup.add(mesh)
    containerGroup.add(rotGroup)
  } else {
    containerGroup.add(mesh)
  }

  rootGroup.updateMatrixWorld(true)
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)
  const n = new THREE.Vector3(...geoNormals[faceName])
  n.applyMatrix3(normalMatrix).normalize()
  return [n.x, n.y, n.z]
}

const tests = [
  {
    name: "sphere",
    model: "light_test_base",
    faces: {
      middle:             { s: 131, f: 255 },
      up1:                { s: 185, f: 255 },
      up2:                { s: 229, f: 255 },
      up3:                { s: 255, f: 255 },
      down1:              { s: 102, f: 227 },
      down2:              { s: 102, f: 186 },
      down3:              { s: 102, f: 133 },
      left1:              { s: 154, f: 255 },
      left2:              { s: 207, f: 255 },
      left3:              { s: 245, f: 225 },
      right1:             { s: 123, f: 226 },
      right2:             { s: 111, f: 181 },
      right3:             { s: 102, f: 126 },
      upleftdiagonal:     { s: 255, f: 255 },
      uprightdiagonal:    { s: 213, f: 255 },
      downleftdiagonal:   { s: 126, f: 173 },
      downrightdiagonal:  { s: 102, f: 140 },
    }
  },
  {
    name: "cube",
    model: "light_test_base_cube",
    faces: {
      front: { face: "south", s: 131, f: 255 },
    }
  },
  {
    name: "cube_display",
    model: "light_test_base_cube_display",
    display: [30, -135, 0],
    faces: {
      top:   { face: "up",    s: 255, f: 255 },
      left:  { face: "east",  s: 165, f: 206 },
      right: { face: "north", s: 102, f: 158 },
    }
  },
]

const data = []

for (const test of tests) {
  const modelJson = JSON.parse(fs.readFileSync(modelsDir + "/" + test.model + ".json", "utf8"))

  for (const [name, info] of Object.entries(test.faces)) {
    let normal

    if (info.face) {
      normal = getShaderNormal(info.face, null, test.display)
    } else {
      const el = modelJson.elements.find(e => e.name === name)
      if (!el) { console.warn("Element not found:", name); continue }
      const faceName = Object.keys(el.faces)[0]
      normal = getShaderNormal(faceName, el.rotation, test.display)
    }

    data.push({ name: test.name + "/" + name, n: normal, s: info.s, f: info.f })
  }
}

console.log("Data points: " + data.length)
for (const d of data) {
  console.log("  " + d.name.padEnd(30) + " n=(" + d.n.map(v => v.toFixed(4)).join(", ") + ") s=" + d.s + " f=" + d.f)
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
function norm(v) { const l = Math.sqrt(dot(v, v)); return v.map(c => c / l) }

const RANDOM_ITERS = 500_000_000
const REFINE_ITERS = 500_000

function optimize(mode) {
  let bestL0, bestL1, bestA, bestD0, bestD1, bestErr = Infinity

  function mse(l0, l1, a, d0, d1) {
    let err = 0
    for (const d of data) {
      const v = Math.min(1, a + d0 * Math.max(0, dot(d.n, l0)) + d1 * Math.max(0, dot(d.n, l1)))
      err += (v - d[mode] / 255) ** 2
    }
    return err / data.length
  }

  const start = Date.now()
  for (let i = 0; i < RANDOM_ITERS; i++) {
    const l0 = norm([Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1])
    const l1 = norm([Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1])
    const a = Math.random() * 0.6
    const d0 = 0.1 + Math.random() * 1.2
    const d1 = 0.1 + Math.random() * 1.2
    const err = mse(l0, l1, a, d0, d1)
    if (err < bestErr) { bestErr = err; bestL0 = l0; bestL1 = l1; bestA = a; bestD0 = d0; bestD1 = d1 }
  }
  console.log("  Random phase: " + ((Date.now() - start) / 1000).toFixed(1) + "s, MSE=" + bestErr.toFixed(10))

  const refineStart = Date.now()
  for (let step = 0.1; step > 0.000001; step *= 0.7) {
    for (let iter = 0; iter < REFINE_ITERS; iter++) {
      const l0 = norm(bestL0.map(v => v + (Math.random() - 0.5) * step))
      const l1 = norm(bestL1.map(v => v + (Math.random() - 0.5) * step))
      const a = Math.max(0, bestA + (Math.random() - 0.5) * step)
      const d0 = Math.max(0, bestD0 + (Math.random() - 0.5) * step)
      const d1 = Math.max(0, bestD1 + (Math.random() - 0.5) * step)
      const err = mse(l0, l1, a, d0, d1)
      if (err < bestErr) { bestErr = err; bestL0 = l0; bestL1 = l1; bestA = a; bestD0 = d0; bestD1 = d1 }
    }
  }
  console.log("  Refine phase: " + ((Date.now() - refineStart) / 1000).toFixed(1) + "s, MSE=" + bestErr.toFixed(12))

  return { l0: bestL0, l1: bestL1, a: bestA, d0: bestD0, d1: bestD1, err: bestErr }
}

for (const mode of ["s", "f"]) {
  const label = mode === "s" ? "SIDE" : "FRONT"
  console.log("\n=== " + label + " ===")
  const r = optimize(mode)
  console.log("  L0:", r.l0.map(v => v.toFixed(4)))
  console.log("  L1:", r.l1.map(v => v.toFixed(4)))
  console.log("  ambient:", r.a.toFixed(4), "d0:", r.d0.toFixed(4), "d1:", r.d1.toFixed(4))
  for (const d of data) {
    const v = Math.min(1, r.a + r.d0 * Math.max(0, dot(d.n, r.l0)) + r.d1 * Math.max(0, dot(d.n, r.l1)))
    const diff = Math.round(v * 255) - d[mode]
    if (diff !== 0) console.log("  " + d.name.padEnd(30) + " exp=" + String(d[mode]).padStart(3) + " got=" + String(Math.round(v * 255)).padStart(3) + " diff=" + diff)
  }
}
