import { renderItem, prepareAssets } from "../../index.js"
import { loadMojangJar } from "./mojang-jar.js"
import fs from "node:fs"

const assets = await prepareAssets([
  await loadMojangJar()
])

const outputDir = `${import.meta.dirname}/renders/banners`
fs.mkdirSync(outputDir, { recursive: true })

// Each design renders as both a banner and a shield: the base color plus a
// stack of banner_patterns, dyed per layer, the way the game builds them
const designs = {
  creeper: { color: "lime", patterns: [
    { pattern: "creeper", color: "black" }
  ] },
  union: { color: "blue", patterns: [
    { pattern: "stripe_downright", color: "white" },
    { pattern: "stripe_downleft", color: "white" },
    { pattern: "cross", color: "red" },
    { pattern: "stripe_center", color: "white" },
    { pattern: "stripe_middle", color: "white" },
    { pattern: "straight_cross", color: "red" }
  ] },
  fox: { color: "white", patterns: [
    { pattern: "rhombus", color: "black" },
    { pattern: "curly_border", color: "orange" },
    { pattern: "circle", color: "orange" },
    { pattern: "creeper", color: "orange" },
    { pattern: "triangle_top", color: "orange" },
    { pattern: "triangles_top", color: "orange" }
  ] },
  sunset: { color: "orange", patterns: [
    { pattern: "gradient", color: "red" },
    { pattern: "flower", color: "orange" },
    { pattern: "circle", color: "yellow" },
    { pattern: "triangle_bottom", color: "brown" },
    { pattern: "triangles_bottom", color: "green" }
  ] }
}

for (const [name, { color, patterns }] of Object.entries(designs)) {
  await renderItem({
    id: `${color}_banner`,
    assets,
    components: { "minecraft:banner_patterns": patterns },
    width: 256,
    height: 256,
    path: `${outputDir}/${name}_banner.png`
  })
  await renderItem({
    id: "shield",
    assets,
    components: {
      "minecraft:base_color": color,
      "minecraft:banner_patterns": patterns
    },
    width: 256,
    height: 256,
    path: `${outputDir}/${name}_shield.png`
  })
  console.log("Done", name)
}
