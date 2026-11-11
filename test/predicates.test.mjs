import test from "node:test"
import assert from "node:assert/strict"
import { prepareAssets, parseItemDefinition } from "../src/node.js"
import { loadMojangJar } from "../examples/node/mojang-jar.js"
import { matchesComponentPredicate as matches } from "../src/core/predicates.js"

test("a plain component id matches when the component is present", () => {
  assert.equal(matches({ dyed_color: 255 }, "minecraft:dyed_color"), true)
  assert.equal(matches({ "minecraft:dyed_color": 255 }, "dyed_color"), true)
  assert.equal(matches({ unbreakable: {} }, "unbreakable"), true)
  assert.equal(matches({ dyed_color: null }, "dyed_color"), false)
  assert.equal(matches({}, "dyed_color"), false)
  assert.equal(matches({}, "toString"), false)
  assert.equal(matches({ "mod:charge": 1 }, "mod:charge"), true)
  assert.equal(matches({ charge: 1 }, "mod:charge"), false)
})

test("number bounds take a bare number or a min and max", () => {
  const stack = { damage: 5, max_damage: 250 }
  assert.equal(matches(stack, "damage", { damage: 5 }), true)
  assert.equal(matches(stack, "damage", { damage: 4 }), false)
  assert.equal(matches(stack, "damage", { damage: { min: 1 } }), true)
  assert.equal(matches(stack, "damage", { damage: { min: 6 } }), false)
  assert.equal(matches(stack, "damage", { damage: { max: 5 } }), true)
  assert.equal(matches(stack, "damage", { damage: { max: 4 } }), false)
  assert.equal(matches(stack, "damage", { damage: { min: 5, max: 5 } }), true)
  assert.equal(matches(stack, "damage", { damage: { min: 6, max: 9 } }), false)
  assert.equal(matches(stack, "damage", { damage: {} }), true)
})

test("damage compares the damage and the remaining durability", () => {
  assert.equal(matches({ damage: 5, max_damage: 250 }, "minecraft:damage", {}), true)
  assert.equal(matches({ "minecraft:damage": 5, "minecraft:max_damage": 250 }, "damage", { durability: 245 }), true)
  assert.equal(matches({ damage: 5, max_damage: 250 }, "damage", { durability: { max: 10 } }), false)
  assert.equal(matches({ damage: 245, max_damage: 250 }, "damage", { durability: { max: 10 }, damage: { min: 200 } }), true)
  assert.equal(matches({ damage: 245, max_damage: 250 }, "damage", { durability: { max: 10 }, damage: { min: 246 } }), false)
  assert.equal(matches({ damage: 5 }, "damage", { durability: -5 }), true)
  assert.equal(matches({ damage: 5 }, "damage", { durability: { min: 0 } }), false)
  assert.equal(matches({ max_damage: 250 }, "damage", {}), false)
  assert.equal(matches({}, "damage", { damage: 0 }), false)
})

test("enchantments match by id, level, or just being enchanted", () => {
  const stack = { enchantments: { "minecraft:sharpness": 3, unbreaking: 1 } }
  assert.equal(matches(stack, "enchantments", []), true)
  assert.equal(matches(stack, "enchantments", [{}]), true)
  assert.equal(matches({ enchantments: {} }, "enchantments", []), true)
  assert.equal(matches({ enchantments: {} }, "enchantments", [{}]), false)
  assert.equal(matches({}, "enchantments", []), false)
  assert.equal(matches(stack, "enchantments", [{ enchantments: "sharpness" }]), true)
  assert.equal(matches(stack, "enchantments", [{ enchantments: "minecraft:unbreaking" }]), true)
  assert.equal(matches(stack, "enchantments", [{ enchantments: "minecraft:mending" }]), false)
  assert.equal(matches(stack, "enchantments", [{ enchantments: ["minecraft:mending", "minecraft:sharpness"] }]), true)
  assert.equal(matches(stack, "enchantments", [{ enchantments: "sharpness", levels: { min: 3 } }]), true)
  assert.equal(matches(stack, "enchantments", [{ enchantments: "sharpness", levels: { min: 4 } }]), false)
  assert.equal(matches(stack, "enchantments", [{ enchantments: ["sharpness", "unbreaking"], levels: 1 }]), true)
  assert.equal(matches(stack, "enchantments", [{ levels: 3 }]), true)
  assert.equal(matches(stack, "enchantments", [{ levels: 2 }]), false)
  assert.equal(matches(stack, "enchantments", [{ enchantments: "sharpness" }, { enchantments: "unbreaking", levels: 1 }]), true)
  assert.equal(matches(stack, "enchantments", [{ enchantments: "sharpness" }, { enchantments: "mending" }]), false)
})

test("stored enchantments read their own component", () => {
  const book = { stored_enchantments: { "minecraft:mending": 1 } }
  assert.equal(matches(book, "minecraft:stored_enchantments", [{ enchantments: "minecraft:mending" }]), true)
  assert.equal(matches(book, "enchantments", [{ enchantments: "minecraft:mending" }]), false)
  assert.equal(matches({ enchantments: { mending: 1 } }, "stored_enchantments", []), false)
})

test("a tag in a holder set never matches", () => {
  assert.equal(matches({ enchantments: { sharpness: 3 } }, "enchantments", [{ enchantments: "#minecraft:on_melee" }]), false)
  assert.equal(matches({ potion_contents: "swiftness" }, "potion_contents", { potions: "#minecraft:fast" }), false)
  assert.equal(matches({ trim: { material: "gold", pattern: "coast" } }, "trim", { material: "#minecraft:shiny" }), false)
  assert.equal(matches({ jukebox_playable: "cat" }, "jukebox_playable", { song: "#minecraft:creeper_drop_music_discs" }), false)
  assert.equal(matches({ "villager/variant": "plains" }, "villager/variant", "#minecraft:warm"), false)
  assert.equal(matches({ bundle_contents: ["stone"] }, "bundle_contents", { items: { contains: [{ items: "#minecraft:planks" }] } }), false)
  assert.equal(matches({ bundle_contents: ["stone"] }, "bundle_contents", { items: { count: [{ test: { items: "#minecraft:planks" }, count: 0 }] } }), false)
  assert.equal(matches({ bundle_contents: [] }, "bundle_contents", { items: { count: [{ test: { items: "#minecraft:planks" }, count: 0 }] } }), true)
})

test("potion contents match the potion and the custom effects", () => {
  assert.equal(matches({ potion_contents: "minecraft:swiftness" }, "potion_contents", {}), true)
  assert.equal(matches({}, "potion_contents", {}), false)
  assert.equal(matches({ potion_contents: "minecraft:swiftness" }, "potion_contents", { potions: "swiftness" }), true)
  assert.equal(matches({ potion_contents: { potion: "swiftness" } }, "minecraft:potion_contents", { potions: ["minecraft:healing", "minecraft:swiftness"] }), true)
  assert.equal(matches({ potion_contents: { potion: "swiftness" } }, "potion_contents", { potions: "minecraft:healing" }), false)
  assert.equal(matches({ potion_contents: { custom_color: 255 } }, "potion_contents", { potions: "minecraft:healing" }), false)
  const custom = { potion_contents: { custom_effects: [{ id: "minecraft:speed", amplifier: 2, duration: 600 }, { id: "jump_boost", show_particles: false }] } }
  assert.equal(matches(custom, "potion_contents", { effects: { contains: [{ speed: {} }] } }), true)
  assert.equal(matches(custom, "potion_contents", { effects: { contains: [{ "minecraft:speed": { amplifier: { min: 2 }, duration: 600 } }] } }), true)
  assert.equal(matches(custom, "potion_contents", { effects: { contains: [{ speed: { amplifier: 1 } }] } }), false)
  assert.equal(matches(custom, "potion_contents", { effects: { contains: [{ slowness: {} }] } }), false)
  assert.equal(matches(custom, "potion_contents", { effects: { contains: [{ jump_boost: { amplifier: 0, ambient: false, visible: false } }] } }), true)
  assert.equal(matches(custom, "potion_contents", { effects: { contains: [{ speed: { visible: false } }] } }), false)
  assert.equal(matches(custom, "potion_contents", { effects: { size: 2 } }), true)
  assert.equal(matches({ potion_contents: { custom_color: 255 } }, "potion_contents", { effects: { size: 0 } }), true)
})

test("custom data matches a partial compound", () => {
  const stack = { custom_data: { kind: "relic", tier: 3, flags: { glowing: true, cursed: false }, tags: ["old", "rare"], points: [1, 2, 3] } }
  assert.equal(matches(stack, "custom_data", {}), true)
  assert.equal(matches({}, "minecraft:custom_data", {}), true)
  assert.equal(matches({}, "custom_data", { kind: "relic" }), false)
  assert.equal(matches(stack, "custom_data", { kind: "relic" }), true)
  assert.equal(matches({ "minecraft:custom_data": { kind: "relic" } }, "custom_data", { kind: "relic" }), true)
  assert.equal(matches(stack, "custom_data", { kind: "junk" }), false)
  assert.equal(matches(stack, "custom_data", { kind: "relic", tier: 3, missing: 1 }), false)
  assert.equal(matches(stack, "custom_data", { flags: { glowing: true } }), true)
  assert.equal(matches(stack, "custom_data", { flags: { glowing: 1 } }), true)
  assert.equal(matches(stack, "custom_data", { flags: { cursed: true } }), false)
  assert.equal(matches(stack, "custom_data", { flags: "glowing" }), false)
  assert.equal(matches(stack, "custom_data", { tags: ["rare"] }), true)
  assert.equal(matches(stack, "custom_data", { tags: ["rare", "new"] }), false)
  assert.equal(matches(stack, "custom_data", { tags: [] }), false)
  assert.equal(matches(stack, "custom_data", { points: [3, 1] }), true)
  assert.equal(matches(stack, "custom_data", { points: [3, 3, 3, 3] }), false)
  assert.equal(matches(stack, "custom_data", { tier: "3" }), false)
})

test("custom data accepts SNBT strings on either side", () => {
  const stack = { custom_data: { kind: "relic", tier: 3, flags: { glowing: true }, tags: ["old", "rare"], ratio: 0.5 } }
  assert.equal(matches(stack, "custom_data", "{kind:relic}"), true)
  assert.equal(matches(stack, "custom_data", "{ kind: \"relic\", tier: 3 }"), true)
  assert.equal(matches(stack, "custom_data", "{kind:'relic',tier:3b,}"), true)
  assert.equal(matches(stack, "custom_data", "{tier:4}"), false)
  assert.equal(matches(stack, "custom_data", "{flags:{glowing:true}}"), true)
  assert.equal(matches(stack, "custom_data", "{flags:{glowing:1b}}"), true)
  assert.equal(matches(stack, "custom_data", "{flags:{glowing:1}}"), false)
  assert.equal(matches(stack, "custom_data", "{tags:[rare]}"), true)
  assert.equal(matches(stack, "custom_data", "{ratio:0.5f}"), true)
  assert.equal(matches(stack, "custom_data", "{ratio:5e-1}"), true)
  assert.equal(matches(stack, "custom_data", "{kind:\"rel\\x69c\"}"), true)
  const typed = { custom_data: "{tier:3,weight:1.5f,ids:[I;1,2,3],name:\"A \\\"B\\\"\"}" }
  assert.equal(matches(typed, "custom_data", "{tier:3}"), true)
  assert.equal(matches(typed, "custom_data", "{tier:3b}"), false)
  assert.equal(matches(typed, "custom_data", { tier: 3 }), true)
  assert.equal(matches(typed, "custom_data", "{weight:1.5f}"), true)
  assert.equal(matches(typed, "custom_data", "{weight:1.5d}"), false)
  assert.equal(matches(typed, "custom_data", "{ids:[I;1,2,3]}"), true)
  assert.equal(matches(typed, "custom_data", "{ids:[I;1,2]}"), false)
  assert.equal(matches(typed, "custom_data", "{ids:[L;1,2,3]}"), false)
  assert.equal(matches(typed, "custom_data", { ids: [1, 2, 3] }), false)
  assert.equal(matches(typed, "custom_data", { name: "A \"B\"" }), true)
})

test("SNBT that cannot be read never matches", () => {
  const stack = { custom_data: { tier: 3 } }
  assert.equal(matches(stack, "custom_data", "{tier:3"), false)
  assert.equal(matches(stack, "custom_data", "{tier:0x3}"), false)
  assert.equal(matches(stack, "custom_data", "{tier:03}"), false)
  assert.equal(matches(stack, "custom_data", "{tier:3} extra"), false)
  assert.equal(matches(stack, "custom_data", "[3]"), false)
  assert.equal(matches(stack, "custom_data", "{flag:bool(1)}"), false)
  assert.equal(matches({ custom_data: "{tier:" }, "custom_data", {}), false)
})

test("collection predicates combine contains, count and size", () => {
  const bundle = { bundle_contents: [{ id: "minecraft:stone", count: 3 }, "minecraft:dirt", { id: "dirt", count: 16 }] }
  assert.equal(matches(bundle, "bundle_contents", {}), true)
  assert.equal(matches({}, "bundle_contents", {}), false)
  assert.equal(matches(bundle, "bundle_contents", { items: {} }), true)
  assert.equal(matches(bundle, "bundle_contents", { items: { contains: [] } }), true)
  assert.equal(matches(bundle, "bundle_contents", { items: { contains: [{ items: "stone" }] } }), true)
  assert.equal(matches(bundle, "bundle_contents", { items: { contains: [{ items: "minecraft:sand" }] } }), false)
  assert.equal(matches(bundle, "bundle_contents", { items: { contains: [{ items: ["sand", "stone"] }, { items: "minecraft:dirt", count: { min: 10 } }] } }), true)
  assert.equal(matches(bundle, "bundle_contents", { items: { contains: [{ items: "stone" }, { items: "sand" }] } }), false)
  assert.equal(matches(bundle, "bundle_contents", { items: { contains: [{ count: 1 }, { count: { max: 3 } }] } }), true)
  assert.equal(matches(bundle, "bundle_contents", { items: { count: [{ test: { items: "dirt" }, count: 2 }] } }), true)
  assert.equal(matches(bundle, "bundle_contents", { items: { count: [{ test: { items: "dirt" }, count: { min: 3 } }] } }), false)
  assert.equal(matches(bundle, "bundle_contents", { items: { count: [{ test: { items: "dirt" }, count: 2 }, { test: { items: "sand" }, count: 0 }] } }), true)
  assert.equal(matches(bundle, "bundle_contents", { items: { count: [{ test: { items: "dirt" }, count: 2 }, { test: { items: "stone" }, count: 0 }] } }), false)
  assert.equal(matches(bundle, "bundle_contents", { items: { size: 3 } }), true)
  assert.equal(matches(bundle, "bundle_contents", { items: { size: { max: 2 } } }), false)
  assert.equal(matches(bundle, "bundle_contents", { items: { contains: [{ items: "stone" }], count: [{ test: {}, count: 3 }], size: { min: 4 } } }), false)
  assert.equal(matches({ bundle_contents: [] }, "bundle_contents", { items: { contains: [{}] } }), false)
  assert.equal(matches({ bundle_contents: [] }, "bundle_contents", { items: { size: 0 } }), true)
})

test("container items are matched with their own components", () => {
  const sword = { id: "minecraft:diamond_sword", components: { "minecraft:damage": 10, "minecraft:max_damage": 1561, "minecraft:enchantments": { "minecraft:sharpness": 5 }, "minecraft:custom_name": "Edge", "!minecraft:repair_cost": {} } }
  const box = { container: [{ slot: 0, item: sword }, { slot: 5, item: { id: "minecraft:arrow", count: 64 } }] }
  assert.equal(matches(box, "container", {}), true)
  assert.equal(matches({}, "container", {}), false)
  assert.equal(matches(box, "minecraft:container", { items: { size: 2 } }), true)
  assert.equal(matches(box, "container", { items: { contains: [{ items: "arrow", count: 64 }] } }), true)
  assert.equal(matches(box, "container", { items: { contains: [{ items: "arrow", count: { max: 32 } }] } }), false)
  assert.equal(matches(box, "container", { items: { contains: [{ predicates: { "minecraft:damage": { damage: { min: 1 } } } }] } }), true)
  assert.equal(matches(box, "container", { items: { contains: [{ items: "diamond_sword", predicates: { enchantments: [{ enchantments: "sharpness", levels: 5 }], damage: { durability: { min: 1000 } } } }] } }), true)
  assert.equal(matches(box, "container", { items: { contains: [{ items: "arrow", predicates: { damage: {} } }] } }), false)
  assert.equal(matches(box, "container", { items: { contains: [{ predicates: { "minecraft:custom_name": {} } }] } }), true)
  assert.equal(matches(box, "container", { items: { contains: [{ predicates: { repair_cost: {} } }] } }), false)
  assert.equal(matches(box, "container", { items: { contains: [{ components: { "minecraft:damage": 10, custom_name: "Edge" } }] } }), true)
  assert.equal(matches(box, "container", { items: { contains: [{ components: { enchantments: { sharpness: 5 } } }] } }), true)
  assert.equal(matches(box, "container", { items: { contains: [{ components: { enchantments: { sharpness: 4 } } }] } }), false)
  assert.equal(matches(box, "container", { items: { contains: [{ components: { enchantments: {} } }] } }), false)
  assert.equal(matches(box, "container", { items: { contains: [{ components: { unbreakable: {} } }] } }), false)
  assert.equal(matches({ container: [{ slot: 2, item: "stone" }, { slot: 2, item: "dirt" }] }, "container", { items: { size: 1, contains: [{ items: "dirt" }] } }), true)
})

test("firework predicates match the shape and flags", () => {
  const star = { firework_explosion: { shape: "star", colors: [255], has_trail: true } }
  assert.equal(matches(star, "firework_explosion", {}), true)
  assert.equal(matches({}, "firework_explosion", {}), false)
  assert.equal(matches(star, "firework_explosion", { shape: "star", has_trail: true, has_twinkle: false }), true)
  assert.equal(matches(star, "firework_explosion", { shape: "burst" }), false)
  assert.equal(matches(star, "firework_explosion", { has_twinkle: true }), false)
  assert.equal(matches(star, "firework_explosion", { has_trail: false }), false)
  const rocket = { fireworks: { flight_duration: 2, explosions: [{ shape: "small_ball" }, { shape: "creeper", has_twinkle: true }] } }
  assert.equal(matches(rocket, "fireworks", {}), true)
  assert.equal(matches({}, "fireworks", {}), false)
  assert.equal(matches(rocket, "minecraft:fireworks", { flight_duration: { min: 2 } }), true)
  assert.equal(matches(rocket, "fireworks", { flight_duration: 3 }), false)
  assert.equal(matches({ fireworks: {} }, "fireworks", { flight_duration: 0 }), true)
  assert.equal(matches(rocket, "fireworks", { explosions: { contains: [{ shape: "creeper", has_twinkle: true }], size: 2 } }), true)
  assert.equal(matches(rocket, "fireworks", { explosions: { contains: [{ shape: "star" }] } }), false)
  assert.equal(matches(rocket, "fireworks", { explosions: { count: [{ test: { has_trail: false }, count: 2 }] } }), true)
})

test("book predicates match pages and metadata", () => {
  const quill = { writable_book_content: { pages: ["first", { raw: "second", filtered: "*" }] } }
  assert.equal(matches(quill, "writable_book_content", {}), true)
  assert.equal(matches({}, "writable_book_content", {}), false)
  assert.equal(matches(quill, "writable_book_content", { pages: { contains: ["second"], size: 2 } }), true)
  assert.equal(matches(quill, "writable_book_content", { pages: { contains: ["*"] } }), false)
  assert.equal(matches({ writable_book_content: {} }, "writable_book_content", { pages: { size: 0 } }), true)
  const book = { written_book_content: { title: { raw: "Notes" }, author: "Steve", generation: 1, pages: ["one", { text: "two", bold: true }, { raw: { text: "three" } }] } }
  assert.equal(matches(book, "written_book_content", {}), true)
  assert.equal(matches({}, "written_book_content", {}), false)
  assert.equal(matches(book, "written_book_content", { title: "Notes", author: "Steve", generation: { min: 1 }, resolved: false }), true)
  assert.equal(matches(book, "written_book_content", { author: "Alex" }), false)
  assert.equal(matches(book, "written_book_content", { title: "Other" }), false)
  assert.equal(matches(book, "written_book_content", { generation: 0 }), false)
  assert.equal(matches(book, "written_book_content", { resolved: true }), false)
  assert.equal(matches({ written_book_content: { title: "Notes", author: "Steve" } }, "written_book_content", { title: "Notes", generation: 0 }), true)
  assert.equal(matches(book, "written_book_content", { pages: { contains: ["one", { text: "three" }, { bold: true, text: "two" }] } }), true)
  assert.equal(matches(book, "written_book_content", { pages: { contains: [{ text: "one" }] } }), true)
  assert.equal(matches(book, "written_book_content", { pages: { contains: ["two"] } }), false)
})

test("attribute modifiers match each given field", () => {
  const stack = { attribute_modifiers: [{ type: "minecraft:attack_damage", id: "minecraft:base_attack_damage", amount: 6.5, operation: "add_value", slot: "mainhand" }, { type: "scale", id: "mod:grow", amount: 0.25, operation: "add_multiplied_base" }] }
  assert.equal(matches(stack, "attribute_modifiers", {}), true)
  assert.equal(matches({}, "attribute_modifiers", {}), false)
  assert.equal(matches(stack, "attribute_modifiers", { modifiers: { size: 2 } }), true)
  assert.equal(matches(stack, "attribute_modifiers", { modifiers: { contains: [{ attribute: "attack_damage", id: "base_attack_damage", amount: { min: 6, max: 7 }, operation: "add_value", slot: "mainhand" }] } }), true)
  assert.equal(matches(stack, "attribute_modifiers", { modifiers: { contains: [{ attribute: ["minecraft:scale", "minecraft:armor"], slot: "any" }] } }), true)
  assert.equal(matches(stack, "attribute_modifiers", { modifiers: { contains: [{ attribute: "minecraft:armor" }] } }), false)
  assert.equal(matches(stack, "attribute_modifiers", { modifiers: { contains: [{ id: "grow" }] } }), false)
  assert.equal(matches(stack, "attribute_modifiers", { modifiers: { contains: [{ id: "mod:grow", amount: 0.25 }] } }), true)
  assert.equal(matches(stack, "attribute_modifiers", { modifiers: { contains: [{ amount: { min: 7 } }] } }), false)
  assert.equal(matches(stack, "attribute_modifiers", { modifiers: { contains: [{ attribute: "scale", operation: "add_value" }] } }), false)
  assert.equal(matches(stack, "attribute_modifiers", { modifiers: { contains: [{ attribute: "attack_damage", slot: "offhand" }] } }), false)
})

test("trim, jukebox and villager predicates match ids", () => {
  const armor = { trim: { material: "minecraft:gold", pattern: "coast" } }
  assert.equal(matches(armor, "trim", {}), true)
  assert.equal(matches({}, "trim", {}), false)
  assert.equal(matches(armor, "minecraft:trim", { material: "gold", pattern: "minecraft:coast" }), true)
  assert.equal(matches(armor, "trim", { material: ["minecraft:iron", "minecraft:gold"] }), true)
  assert.equal(matches(armor, "trim", { material: "iron" }), false)
  assert.equal(matches(armor, "trim", { material: "gold", pattern: "spire" }), false)
  assert.equal(matches({ trim: { material: { asset_name: "gold" }, pattern: "coast" } }, "trim", { material: "gold" }), false)
  assert.equal(matches({ jukebox_playable: "minecraft:cat" }, "jukebox_playable", {}), true)
  assert.equal(matches({}, "jukebox_playable", {}), false)
  assert.equal(matches({ jukebox_playable: "minecraft:cat" }, "jukebox_playable", { song: "cat" }), true)
  assert.equal(matches({ jukebox_playable: "cat" }, "minecraft:jukebox_playable", { song: ["minecraft:13", "minecraft:cat"] }), true)
  assert.equal(matches({ jukebox_playable: "cat" }, "jukebox_playable", { song: "minecraft:13" }), false)
  assert.equal(matches({ "minecraft:villager/variant": "minecraft:desert" }, "villager/variant", "desert"), true)
  assert.equal(matches({ "villager/variant": "desert" }, "minecraft:villager/variant", ["minecraft:plains", "minecraft:desert"]), true)
  assert.equal(matches({ "villager/variant": "desert" }, "villager/variant", "minecraft:plains"), false)
  assert.equal(matches({}, "villager/variant", "desert"), false)
})

test("an item definition picks its model from a component condition", async () => {
  const definition = {
    model: {
      type: "minecraft:condition",
      property: "minecraft:component",
      predicate: "minecraft:damage",
      value: { damage: { min: 1 } },
      on_true: {
        type: "minecraft:condition",
        property: "minecraft:component",
        predicate: "minecraft:enchantments",
        value: [{ enchantments: "minecraft:mending" }],
        on_true: { type: "minecraft:model", model: "minecraft:item/emerald" },
        on_false: { type: "minecraft:model", model: "minecraft:item/coal" }
      },
      on_false: {
        type: "minecraft:condition",
        property: "minecraft:component",
        predicate: "minecraft:custom_name",
        on_true: { type: "minecraft:model", model: "minecraft:item/name_tag" },
        on_false: { type: "minecraft:model", model: "minecraft:item/diamond" }
      }
    }
  }
  const pack = {
    read: file => file === "assets/minecraft/items/predicate_probe.json" ? JSON.stringify(definition) : null,
    list: () => []
  }
  const assets = await prepareAssets([pack, await loadMojangJar()])

  async function probe(components) {
    const [model] = await parseItemDefinition(assets, "predicate_probe", { components })
    return model.model ?? model
  }

  assert.equal(await probe(undefined), "minecraft:item/diamond")
  assert.equal(await probe({ damage: 0 }), "minecraft:item/diamond")
  assert.equal(await probe({ custom_name: "Shiny" }), "minecraft:item/name_tag")
  assert.equal(await probe({ "minecraft:custom_name": "Shiny", "minecraft:damage": 0 }), "minecraft:item/name_tag")
  assert.equal(await probe({ damage: 12, max_damage: 250 }), "minecraft:item/coal")
  assert.equal(await probe({ "minecraft:damage": 12, "minecraft:enchantments": { "minecraft:mending": 1 } }), "minecraft:item/emerald")
  assert.equal(await probe({ damage: 12, enchantments: { unbreaking: 3 } }), "minecraft:item/coal")
})
