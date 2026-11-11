import test from "node:test"
import assert from "node:assert/strict"
import { prepareAssets, parseBlockstate, resolveModelData, exportModelCache, importModelCache, disposeCache } from "../src/node.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const jar = await loadMojangJar()

async function resolveAll(assets, ids) {
  const out = []
  for (const id of ids) for (const model of await parseBlockstate(assets, id)) out.push(await resolveModelData(assets, model))
  return out
}

test("an imported model cache resolves the same models without reading the pack", async () => {
  const ids = ["stone", "oak_stairs", "chest", "grass_block", "water", "not_a_block"]
  const source = await prepareAssets([jar], { cache: true })
  const expected = await resolveAll(source, ids)
  const data = JSON.parse(JSON.stringify(await exportModelCache(source)))
  assert.ok(data.files.some(([path]) => path === "assets/minecraft/blockstates/stone.json"))
  assert.ok(data.models.length >= ids.length - 1)

  const target = await prepareAssets([jar], { cache: true })
  const added = await importModelCache(target, data)
  assert.equal(added, data.files.length + data.models.length)
  assert.equal(await importModelCache(target, data), 0)
  for (const entry of target) {
    const read = entry.read
    if (read) entry.read = file => {
      if (/\/(models|blockstates)\//.test(file)) throw new Error(`read ${file} from the pack`)
      return read.call(entry, file)
    }
  }
  assert.deepEqual(await resolveAll(target, ids), expected)
  disposeCache(source)
  disposeCache(target)
})

test("assets without a cache take nothing from an import", async () => {
  const source = await prepareAssets([jar], { cache: true })
  await resolveAll(source, ["stone"])
  const plain = await prepareAssets([jar])
  assert.equal(await importModelCache(plain, await exportModelCache(source)), 0)
  assert.deepEqual(await exportModelCache(plain), { files: [], models: [] })
  disposeCache(source)
})
