import test from "node:test"
import assert from "node:assert/strict"
import { createSky, createFog } from "../src/node.js"

const assets = [{ read: () => null }]

test("a custom dimension object colours the sky's fog", async () => {
  const dimension = { fogColor: 0x102030, skyColor: 0x405060 }
  const sky = await createSky(assets, { dimension, fog: 8 })
  const own = createFog(8, dimension).uniforms, overworld = createFog(8).uniforms
  assert.deepEqual(sky.fog.uniforms.fogBase.value.toArray(), own.fogBase.value.toArray())
  assert.deepEqual(sky.fog.uniforms.skyBase.value.toArray(), own.skyBase.value.toArray())
  assert.notDeepEqual(sky.fog.uniforms.fogBase.value.toArray(), overworld.fogBase.value.toArray())
})

test("named dimensions keep their own fog", async () => {
  for (const dimension of [undefined, "overworld", "minecraft:the_nether", "the_end"]) {
    const sky = await createSky(assets, { dimension, fog: 8 })
    const own = createFog(8, dimension).uniforms
    assert.deepEqual(sky.fog.uniforms.fogBase.value.toArray(), own.fogBase.value.toArray())
    assert.equal(sky.fog.uniforms.fogSunrise.value, own.fogSunrise.value)
  }
})
