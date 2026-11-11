import test from "node:test"
import assert from "node:assert/strict"
import { sortTranslucent } from "../src/node.js"
import { THREE } from "../src/core/platform.js"

function quads(centers, perCenter = 1) {
  const position = [], index = []
  for (const x of centers) {
    for (let n = 0; n < perCenter; n++) {
      const v = position.length / 3
      position.push(x - 8, -8, 0, x + 8, -8, 0, x + 8, 8, 0, x - 8, 8, 0)
      index.push(v, v + 1, v + 2, v, v + 2, v + 3)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(position), 3))
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1))
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true }))
}

function cameraAt(x, y, z) {
  const camera = new THREE.PerspectiveCamera()
  camera.position.set(x, y, z)
  camera.updateMatrixWorld(true)
  return camera
}

test("near faces keep their order when one face is far away", () => {
  const centers = [0, 32, 3040]
  const mesh = quads(centers)
  const group = new THREE.Group().add(mesh)
  sortTranslucent(group).sort(cameraAt(-48, 0, 0))
  const index = mesh.geometry.index.array, pos = mesh.geometry.attributes.position
  const order = []
  for (let t = 0; t < index.length; t += 3) {
    const cx = (pos.getX(index[t]) + pos.getX(index[t + 1]) + pos.getX(index[t + 2])) / 3
    order.push(centers.findIndex(c => Math.abs(c - cx) < 16))
  }
  assert.deepEqual(order, [2, 2, 1, 1, 0, 0])
})

test("every pending mesh gets sorted while the camera keeps moving", () => {
  const meshes = [0, 400, 800, 1200, 1600, 2000].map(x => quads([x], 30000))
  const group = new THREE.Group()
  for (const mesh of meshes) group.add(mesh)
  group.updateMatrixWorld(true)
  const sorter = sortTranslucent(group, { resortDistance: 16 })
  const renderer = { info: { render: { frame: 0 } } }
  const farFirst = meshes.slice().reverse()
  for (let frame = 0; frame < meshes.length; frame++) {
    renderer.info.render.frame = frame
    const camera = cameraAt(-100, 0, frame * 40)
    for (const mesh of farFirst) mesh.onBeforeRender(renderer, null, camera)
  }
  assert.deepEqual(meshes.map(mesh => mesh.geometry.index.version), [1, 1, 1, 1, 1, 1])
  sorter.detach()
})

test("small meshes share a frame", () => {
  const meshes = [0, 400, 800].map(x => quads([x], 4))
  const group = new THREE.Group()
  for (const mesh of meshes) group.add(mesh)
  group.updateMatrixWorld(true)
  const sorter = sortTranslucent(group)
  const renderer = { info: { render: { frame: 0 } } }
  const camera = cameraAt(-100, 0, 0)
  for (const mesh of meshes) mesh.onBeforeRender(renderer, null, camera)
  assert.deepEqual(meshes.map(mesh => mesh.geometry.index.version), [1, 1, 1])
  sorter.detach()
})
