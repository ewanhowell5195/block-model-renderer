import { renderItem, prepareAssets } from "../../index.js"
import { loadMojangJar } from "./mojang-jar.js"
import fs from "node:fs"

const assets = await prepareAssets([
  await loadMojangJar()
])

const outputDir = `${import.meta.dirname}/renders/banners`
fs.mkdirSync(outputDir, { recursive: true })

const banners = {
  creeper: { base: "lime_banner", patterns: [
    { pattern: "creeper", color: "black" }
  ] },
  union: { base: "blue_banner", patterns: [
    { pattern: "stripe_downright", color: "white" },
    { pattern: "stripe_downleft", color: "white" },
    { pattern: "cross", color: "red" },
    { pattern: "stripe_center", color: "white" },
    { pattern: "stripe_middle", color: "white" },
    { pattern: "straight_cross", color: "red" }
  ] },
  fox: { base: "white_banner", patterns: [
    { pattern: "rhombus", color: "black" },
    { pattern: "curly_border", color: "orange" },
    { pattern: "circle", color: "orange" },
    { pattern: "creeper", color: "orange" },
    { pattern: "triangle_top", color: "orange" },
    { pattern: "triangles_top", color: "orange" }
  ] },
  sunset: { base: "orange_banner", patterns: [
    { pattern: "gradient", color: "red" },
    { pattern: "flower", color: "orange" },
    { pattern: "circle", color: "yellow" },
    { pattern: "triangle_bottom", color: "brown" },
    { pattern: "triangles_bottom", color: "green" }
  ] }
}

const shields = {
  crusader: { base: "white", patterns: [
    { pattern: "straight_cross", color: "red" }
  ] },
  pirate: { base: "black", patterns: [
    { pattern: "skull", color: "white" },
    { pattern: "bricks", color: "gray" }
  ] },
  creeper: { base: "lime", patterns: [
    { pattern: "creeper", color: "black" }
  ] },
  thing: { base: "purple", patterns: [
    { pattern: "mojang", color: "yellow" },
    { pattern: "border", color: "magenta" }
  ] }
}

for (const [name, { base, patterns }] of Object.entries(banners)) {
  await renderItem({
    id: base,
    assets,
    components: { "minecraft:banner_patterns": patterns },
    width: 256,
    height: 256,
    path: `${outputDir}/${name}_banner.png`
  })
  console.log("Done banner", name)
}

for (const [name, { base, patterns }] of Object.entries(shields)) {
  await renderItem({
    id: "shield",
    assets,
    components: {
      "minecraft:base_color": base,
      "minecraft:banner_patterns": patterns
    },
    width: 256,
    height: 256,
    path: `${outputDir}/${name}_shield.png`
  })
  console.log("Done shield", name)
}
