import test from "node:test"
import assert from "node:assert/strict"
import * as lib from "../src/node.js"
import { prepareAssets, parseBlockstate, resolveModelData, fullyOccludes, getCullFaces, exportCache, importCache, disposeCache } from "../src/node.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const jar = await loadMojangJar()

async function resolveAll(assets, ids) {
  const out = []
  for (const id of ids) for (const model of await parseBlockstate(assets, id)) out.push(await resolveModelData(assets, model))
  return out
}

function refuseModelReads(assets) {
  for (const entry of assets) {
    const read = entry.read
    if (read) entry.read = file => {
      if (/\/(models|blockstates)\//.test(file)) throw new Error(`read ${file} from the pack`)
      return read.call(entry, file)
    }
  }
}

test("an imported cache resolves the same models without reading the pack", async () => {
  const ids = ["stone", "oak_stairs", "chest", "grass_block", "water", "not_a_block"]
  const source = await prepareAssets([jar], { cache: true })
  const expected = await resolveAll(source, ids)
  const exported = await exportCache(source)
  const data = JSON.parse(JSON.stringify({ files: exported.files, models: exported.models }))
  assert.ok(data.files.some(([path]) => path === "assets/minecraft/blockstates/stone.json"))
  assert.ok(data.models.length >= ids.length - 1)

  const target = await prepareAssets([jar], { cache: true })
  const added = await importCache(target, data)
  assert.equal(added, data.files.length + data.models.length)
  assert.equal(await importCache(target, data), 0)
  refuseModelReads(target)
  assert.deepEqual(await resolveAll(target, ids), expected)
  disposeCache(source)
  disposeCache(target)
})

test("exportCache and importCache carry the occlusion masks with the models", async () => {
  const source = await prepareAssets([jar], { cache: true })
  assert.equal(await fullyOccludes({ id: "stone", assets: source }), true)
  assert.equal(await fullyOccludes({ id: "oak_stairs", assets: source }), false)
  const cull = await getCullFaces({ id: "oak_stairs", neighbors: { down: "stone", east: "glass" }, assets: source })
  const data = structuredClone(await exportCache(source))
  assert.deepEqual(Object.keys(data), ["files", "models", "occlusion"])
  const stone = data.occlusion.find(([key]) => key === "stone")
  assert.ok(stone[1].up instanceof Uint16Array && stone[1].up.every(row => row === 0xffff))

  const target = await prepareAssets([jar], { cache: true })
  assert.equal(await importCache(target, data), data.files.length + data.models.length + data.occlusion.length)
  assert.equal(await importCache(target, data), 0)
  refuseModelReads(target)
  assert.equal(await fullyOccludes({ id: "stone", assets: target }), true)
  assert.deepEqual(await getCullFaces({ id: "oak_stairs", neighbors: { down: "stone", east: "glass" }, assets: target }), cull)
  assert.deepEqual(await exportCache(target), data)
  disposeCache(source)
  disposeCache(target)
})

test("assets without a cache take nothing from an import", async () => {
  const source = await prepareAssets([jar], { cache: true })
  await resolveAll(source, ["stone"])
  const plain = await prepareAssets([jar])
  assert.equal(await importCache(plain, await exportCache(source)), 0)
  assert.deepEqual(await exportCache(plain), { files: [], models: [], occlusion: [] })
  disposeCache(source)
})

test("the separate model and occlusion cache exports are gone", () => {
  for (const name of ["exportModelCache", "importModelCache", "exportOcclusionCache", "importOcclusionCache"]) assert.equal(name in lib, false, name)
})
