import test from "node:test"
import assert from "node:assert/strict"
import { getThree, makeModelScene, createScene } from "../src/node.js"
import { THREE as platformThree } from "../src/core/platform.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

test("getThree resolves the three.js instance scenes are built with", async () => {
  const pending = getThree()
  assert.ok(pending instanceof Promise)
  const THREE = await pending
  assert.equal(THREE, platformThree)
  const handle = await createScene([await loadMojangJar()], [{ id: "stone", pos: [0, 0, 0] }])
  assert.ok(handle.group instanceof THREE.Group)
  handle.dispose()
})

test("makeModelScene resolves a scene and camera", async () => {
  const pending = makeModelScene()
  assert.ok(pending instanceof Promise)
  const { scene, camera } = await pending
  const THREE = await getThree()
  assert.ok(scene instanceof THREE.Scene)
  assert.ok(camera instanceof THREE.OrthographicCamera)
  assert.equal(camera.fitAspect, true)
})
