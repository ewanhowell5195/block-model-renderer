// Tests the generated data and the code that consumes it, and (when a JDK is
// available) re-runs the generator in --check mode to prove it reproduces the
// committed JSON. Plain Node, no test framework.

import assert from "node:assert/strict"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { canOcclude, selfCulls } from "../../src/core/culling.js"
import { isWaterloggable, COLORS, getPotionColor, COLORMAP_BLOCKS, FIXED_TINT_BLOCKS, INDEXED_TINT_BLOCKS } from "../../src/core/colors.js"
import blocks from "../../src/core/data/blocks.json" with { type: "json" }
import colors from "../../src/core/data/colors.json" with { type: "json" }

const here = path.dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
function test(name, fn) {
  try { fn(); pass++; console.log("ok  ", name) }
  catch (e) { fail++; console.error("FAIL", name, "\n     ", e.message) }
}

test("blocks.json structure (compressed rules)", () => {
  for (const k of ["waterloggable", "nonOccluding", "selfCullAll", "selfCullY"]) {
    const r = blocks[k]
    assert.ok(Array.isArray(r.suffix) && Array.isArray(r.exact), `${k} has suffix/exact arrays`)
    for (const s of [...r.suffix, ...r.exact, ...(r.except ?? [])]) assert.match(s, /^_?[a-z0-9_]+$/, `token: ${s}`)
  }
  assert.ok(blocks.nonOccluding.suffix.length + blocks.nonOccluding.exact.length >= 8)
})

test("colors.json structure", () => {
  assert.equal(Object.keys(colors.dye).length, 16)
  assert.equal(Object.keys(colors.team).length, 16)
  assert.ok(Object.keys(colors.effects).length > 30)
  for (const map of [colors.dye, colors.team, colors.effects])
    for (const v of Object.values(map)) assert.match(v, /^#[0-9A-Fa-f]{6}$/, `hex: ${v}`)
  assert.deepEqual(colors.colormap.dry_foliage, ["leaf_litter"])
  for (const b of ["grass_block", "sugar_cane", "pink_petals"]) assert.ok(colors.colormap.grass.includes(b), `grass has ${b}`)
  for (const b of ["oak_leaves", "vine"]) assert.ok(colors.colormap.foliage.includes(b), `foliage has ${b}`)
  const cmAll = [...colors.colormap.grass, ...colors.colormap.foliage, ...colors.colormap.dry_foliage]
  for (const w of ["water", "bubble_column", "water_cauldron"]) assert.ok(!cmAll.includes(w), `${w} not a colormap block`)
  for (const v of Object.values(colors.tintindex)) assert.ok(Number.isInteger(v) && v > 0, `tintindex ${v}`)
  assert.equal(colors.tintindex.pink_petals, 1)
  for (const v of Object.values(colors.fixed)) assert.match(v, /^#[0-9A-Fa-f]{6}$/, `fixed hex: ${v}`)
  assert.equal(colors.fixed.lily_pad, "#208030")
  assert.equal(colors.fixed.water, "#3F76E4")
  const rs = colors.indexed.redstone_wire
  assert.equal(rs.property, "power")
  assert.equal(rs.colors.length, 16)
  assert.equal(rs.colors[0], "#4C0000")
  assert.equal(colors.indexed.melon_stem.property, "age")
  assert.equal(colors.indexed.melon_stem.default, 7)
  assert.equal(colors.indexed.melon_stem.colors[7], "#E0C71C")
  assert.ok(Object.keys(colors.potions).length > 20)
  assert.deepEqual(colors.potions.swiftness, ["speed"])
  assert.deepEqual(colors.potions.turtle_master, [["slowness", 3], ["resistance", 2]])
  assert.ok(!("poison" in colors.potions), "potions whose name is an effect are omitted (direct fallback)")
})

test("canOcclude matches the game", () => {
  assert.equal(canOcclude("stone"), true)
  assert.equal(canOcclude("glass"), false)
  assert.equal(canOcclude("copper_grate"), false)
  assert.equal(canOcclude("minecraft:oak_leaves"), false)
  assert.equal(canOcclude("water"), false)
  assert.equal(canOcclude("piston_head"), true)
  assert.equal(canOcclude("ice"), false)
  assert.equal(canOcclude("powder_snow"), false)
  // one full face is enough to need the override (a trapdoor/door covers a side)
  assert.equal(canOcclude("oak_door"), false)
  assert.equal(canOcclude("oak_trapdoor"), false)
  assert.equal(canOcclude("ladder"), false)
  // no full face -> report as occluding and rely on geometry
  assert.equal(canOcclude("poppy"), true)
  assert.equal(canOcclude("tall_grass"), true)
  assert.equal(canOcclude("skeleton_skull"), true)
  assert.equal(canOcclude("iron_bars"), true)
})

test("selfCulls matches the game", () => {
  assert.equal(selfCulls("glass", "glass", "north"), true)
  assert.equal(selfCulls("copper_grate", "copper_grate", "up"), true)
  assert.equal(selfCulls("copper_grate", "exposed_copper_grate", "up"), false)
  assert.equal(selfCulls("mangrove_roots", "mangrove_roots", "up"), true)
  assert.equal(selfCulls("mangrove_roots", "mangrove_roots", "north"), false)
  // bars/panes self-cull vertically (behaviour-derived; the class-based list missed these)
  assert.equal(selfCulls("iron_bars", "iron_bars", "up"), true)
  assert.equal(selfCulls("iron_bars", "iron_bars", "north"), false)
  assert.equal(selfCulls("glass_pane", "glass_pane", "up"), true)
  assert.equal(selfCulls("dirt_path", "dirt_path", "north"), false)
  assert.equal(selfCulls("ice", "ice", "up"), true)
  // packed_ice is excepted from the "ice" suffix (solid, not half-transparent)
  assert.equal(selfCulls("packed_ice", "packed_ice", "up"), false)
  assert.equal(selfCulls("water", "water", "up"), true)
  assert.equal(selfCulls("water", "lava", "up"), false)
  assert.equal(selfCulls("stone", "stone", "north"), false)
})

test("isWaterloggable matches the game", () => {
  assert.equal(isWaterloggable("oak_stairs"), true)
  assert.equal(isWaterloggable("minecraft:oak_fence"), true)
  assert.equal(isWaterloggable("copper_grate"), true)
  assert.equal(isWaterloggable("stone"), false)
})

test("COLORS wired to generated data", () => {
  assert.equal(COLORS.dye.white, "#F9FFFE")
  assert.equal(COLORS.dye.blue, "#3C44AA")
  assert.equal(COLORS.team.black, "#000000")
  assert.equal(COLORS.effects.speed, "#33EBFF")
  assert.equal(COLORS.tintindex.wildflowers, 1)
  assert.equal(COLORMAP_BLOCKS.grass_block, "grass")
  assert.equal(COLORMAP_BLOCKS.oak_leaves, "foliage")
  assert.equal(COLORMAP_BLOCKS.leaf_litter, "dry_foliage")
  assert.equal(COLORS.fixed.birch_leaves, "#80A755")
  assert.equal(FIXED_TINT_BLOCKS.water, "#3F76E4")
  assert.equal(FIXED_TINT_BLOCKS.lily_pad, "#208030")
  assert.equal(INDEXED_TINT_BLOCKS.redstone_wire.colors[0], "#4C0000")
  assert.equal(INDEXED_TINT_BLOCKS.melon_stem.colors[7], "#E0C71C")
  assert.match(getPotionColor("turtle_master"), /^#[0-9a-f]{6}$/)          // blended multi-effect
  assert.equal(getPotionColor("swiftness").toLowerCase(), COLORS.effects.speed.toLowerCase())  // single effect
  assert.match(getPotionColor("poison"), /^#[0-9A-Fa-f]{6}$/)              // direct fallback
})

const javac = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "javac") : "javac"
const hasJdk = spawnSync(javac, ["-version"]).status === 0
if (hasJdk) {
  const version = /minecraft (\S+)/.exec(blocks._generated)?.[1]
  test(`generator reproduces committed data (--check ${version})`, () => {
    execFileSync("node", [path.join(here, "generate.js"), "--check", version], { stdio: "inherit" })
  })
} else {
  console.log("skip  generator --check (no javac on PATH / JAVA_HOME)")
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
