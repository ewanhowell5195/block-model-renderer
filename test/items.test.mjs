import test from "node:test"
import assert from "node:assert/strict"
import { prepareAssets, parseItemDefinition } from "../src/node.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"

const assets = await prepareAssets([await loadMojangJar()], { cache: true })

async function crossbow(components) {
  const [model] = await parseItemDefinition(assets, "crossbow", { components })
  return model.model ?? model
}

async function probe(definition, components) {
  const pack = {
    read: file => file === "assets/minecraft/items/probe.json" ? JSON.stringify({ model: definition }) : null,
    list: () => []
  }
  const [model] = await parseItemDefinition(await prepareAssets([pack, await loadMojangJar()]), "probe", { components })
  return model.model ?? model
}

const emerald = { type: "minecraft:model", model: "minecraft:item/emerald" }
const coal = { type: "minecraft:model", model: "minecraft:item/coal" }

test("a component select compares object values by content", async () => {
  const definition = {
    type: "minecraft:select",
    property: "minecraft:component",
    component: "minecraft:trim",
    cases: [
      { when: { material: "minecraft:gold", pattern: "minecraft:coast" }, model: emerald },
      { when: [{ material: "minecraft:iron", pattern: "minecraft:coast" }, { material: "minecraft:iron", pattern: "minecraft:wild" }], model: { type: "minecraft:model", model: "minecraft:item/iron_ingot" } }
    ],
    fallback: coal
  }
  assert.equal(await probe(definition, { trim: { pattern: "coast", material: "gold" } }), "minecraft:item/emerald")
  assert.equal(await probe(definition, { trim: { material: "iron", pattern: "minecraft:wild" } }), "minecraft:item/iron_ingot")
  assert.equal(await probe(definition, { trim: { material: "diamond", pattern: "coast" } }), "minecraft:item/coal")
  assert.equal(await probe(definition, {}), "minecraft:item/coal")
})

test("has_component only counts components the caller passed", async () => {
  const definition = { type: "minecraft:condition", property: "minecraft:has_component", component: "toString", on_true: emerald, on_false: coal }
  assert.equal(await probe(definition, {}), "minecraft:item/coal")
  assert.equal(await probe({ ...definition, component: "minecraft:unbreakable" }, { unbreakable: {} }), "minecraft:item/emerald")
})

test("a crossbow picks its model from what it is charged with", async () => {
  assert.equal(await crossbow({}), "minecraft:item/crossbow")
  assert.equal(await crossbow({ charged_projectiles: [] }), "minecraft:item/crossbow")
  assert.equal(await crossbow({ charged_projectiles: [{ id: "minecraft:arrow", count: 1 }] }), "minecraft:item/crossbow_arrow")
  assert.equal(await crossbow({ charged_projectiles: ["spectral_arrow"] }), "minecraft:item/crossbow_arrow")
  assert.equal(await crossbow({ "minecraft:charged_projectiles": [{ id: "minecraft:arrow" }, { id: "minecraft:firework_rocket" }] }), "minecraft:item/crossbow_firework")
})
