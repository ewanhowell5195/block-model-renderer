# Models

Model-level behavior and data: posing a model with display transforms, inspecting what a blockstate resolves to, and the tint tables.

## Display transforms

The `display` option controls how the model is rotated, translated, and scaled before rendering. The render functions and [`loadModel`](api.md) both take it. It takes one of three forms:

**String**: name of a context in the model's `display` block (`"gui"`, `"fixed"`, `"ground"`, `"firstperson_righthand"`, etc.). The renderer uses that context's transform from the model.

```js
display: "firstperson_righthand"
```

**Plain transform**: an object with `rotation`, `translation`, and/or `scale`. Applied directly, ignoring anything the model defines.

```js
display: { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] }
```

**Fallback transform**: add `type: "fallback"` to a plain transform to first try the model's own `display` for a named context (`display: "gui"` by default), falling back to the object's own `rotation`/`translation`/`scale` if the model doesn't define that context.

```js
// Use the model's "gui" transform if it defines one, otherwise use this one
display: {
  type: "fallback",
  rotation: [30, 225, 0],
  scale: [0.625, 0.625, 0.625]
}

// Use the model's "firstperson_righthand" transform if it defines one, otherwise use this one
display: {
  type: "fallback",
  display: "firstperson_righthand",
  rotation: [30, 225, 0],
  scale: [0.625, 0.625, 0.625]
}
```

Translation values are clamped to ±80 and scale to ±4, like the game. Mirrored scales (an odd number of negative components) render inside out from 1.15 onwards (MC-176864), which is what unversioned renders do too; see [Legacy Minecraft versions](versions.md#legacy-minecraft-versions) for the pre-1.15 behavior.

## `isWaterloggable(id)`

Checks whether the renderer recognizes a block id as waterloggable. When `true`, passing `{ waterlogged: true }` in the blockstate properties to [`renderBlock`](api.md) or [`parseBlockstate`](api.md) will add a water layer to the returned model. When `false`, the `waterlogged` property has no effect.

| Argument | Description |
|---|---|
| `id` | The block id (e.g. `"oak_stairs"`, `"minecraft:lantern"`). Namespace optional |

Returns `true` if the block is waterloggable, `false` otherwise.

```js
import { isWaterloggable } from "block-model-renderer"

isWaterloggable("oak_stairs") // true
isWaterloggable("stone")      // false
```

## `isWaterlogged(id)`

Checks whether a block id is inherently water-filled: blocks that always contain water in game without carrying a `waterlogged` property (kelp, seagrass, bubble columns). [`renderBlock`](api.md) and [`parseBlockstate`](api.md) add the water layer to these automatically, and [`fluidTypeOf`](fluids.md#fluidtypeofid-properties) counts them as water cells.

| Argument | Description |
|---|---|
| `id` | The block id (e.g. `"kelp"`, `"minecraft:bubble_column"`). Namespace optional |

Returns `true` if the block is always water-filled, `false` otherwise.

```js
import { isWaterlogged } from "block-model-renderer"

isWaterlogged("kelp")          // true
isWaterlogged("bubble_column") // true
isWaterlogged("oak_stairs")    // false: waterloggable, but not always water
```

## `getLightEmission(id, properties?, resolveDefault?)`

The light level (0-15) a block emits, straight from the game's per-blockstate data. Uniform emitters (glowstone, torches, lava) return their level for any state; state-dependent emitters (lit furnaces and campfires, candle counts, the light block's `level`) read the deciding properties from `properties`.

| Argument | Description |
|---|---|
| `id` | The block id (e.g. `"glowstone"`, `"minecraft:redstone_lamp"`). Namespace optional |
| `properties` | Blockstate properties object. Only the properties the emission depends on matter |
| `resolveDefault` | Optional `key => value` fallback for properties missing from `properties` |

Returns the emission level, `0` for non-emitting blocks.

```js
import { getLightEmission } from "block-model-renderer"

getLightEmission("glowstone")                                // 15
getLightEmission("redstone_lamp", { lit: "true" })           // 15
getLightEmission("candle", { candles: 3, lit: true })        // 9
getLightEmission("stone")                                    // 0
```

The renderer applies this automatically: rendering a block that glows in game (via `renderBlock` or a `loadModel` call with `args.block`) floors every element's [`light_emission`](rendering.md#lighting-modes) at the block's own level, so glowstone stays bright at a dark [`daytime`](rendering.md#lighting-modes) without the model needing `light_emission`. Missing properties resolve through the same `default_blockstates` data the model picker uses, so a bare `campfire` glows lit, matching the model it renders.

## `isCrossModel(models)`

Checks whether resolved model data is a cross model (flowers, saplings, cobwebs: flat planes rotated 45° around Y). Takes one resolved model or an array of them and returns `true` when every element sits on the diagonal. Cross models render edge-on at the standard gui angle, so rotate the display 45° when this hits:

```js
import { parseBlockstate, resolveModelData, isCrossModel } from "block-model-renderer"

const resolved = []
for (const model of await parseBlockstate(assets, "fern")) {
  resolved.push(await resolveModelData(assets, model))
}

await renderBlock({
  id: "fern",
  assets,
  path: "fern.png",
  display: {
    rotation: [30, isCrossModel(resolved) ? 180 : 225, 0],
    scale: [0.625, 0.625, 0.625]
  }
})
```

## `getBiomeTint(assets, map, biome?)`

Resolves the tint color the renderer would use for a colormap-tinted block, as a hex string. `map` is the colormap name: `"grass"`, `"foliage"`, or `"dry_foliage"` (which blocks sample which map is listed in [`COLORS`](#colors)`.colormap`). `biome` takes the same value as the `biome` render option: one `{ temperature, downfall, tint, combine, weight }` object, or an array of them to blend. Omit it for the default climate sample (temperature `0.5`, downfall `1`).

```js
import { getBiomeTint } from "block-model-renderer"

await getBiomeTint(assets, "grass")                                          // "#7CBD6C"
await getBiomeTint(assets, "grass", { temperature: 2, downfall: 0 })         // "#BFB755" (savanna)
await getBiomeTint(assets, "foliage", { tint: "#df6827" })                   // "#DF6827" (fixed override)
```

## `COLORS`

The color tables the renderer tints with, exported as one object for lookups in your own tooling (or careful tweaking; it's the live data):

| Key | Contents |
|---|---|
| `colormap` | Block-id lists grouped by which biome colormap image they sample: `grass`, `foliage`, or `dry_foliage`. Their tint is read from the colormap texture rather than being a fixed value |
| `fixed` | Blocks with a flat hex tint instead of a colormap, block id to hex string (water and bubble columns, birch/spruce leaves, lily pads, attached stems) |
| `indexed` | Tint ramps keyed off a blockstate property, block id to `{ property, default, colors }`; `colors[value]` is picked for the block's `property` (stem `age`, redstone wire `power`), falling back to `default` |
| `tintindex` | Blocks whose colormap tint applies to a `tintindex` other than the default `0`; the value is that index (e.g. `pink_petals: 1`) |
| `dye` | The 16 dye colors, dye name to hex string |
| `effects` | Each status effect's particle color as a hex string, used when tinting from a `potion` |
| `potions` | Each potion id to the effect(s) it draws color from (`["speed"]`, or weighted `[["slowness", 3], ["resistance", 2]]`). Their `effects` colors are averaged into the one potion tint |
| `team` | The 16 team/formatting colors, name to hex string, used by the `team` tint source |

The shape, abbreviated:

```js
{
  colormap: {
    grass: ["grass_block", "fern", "short_grass", ...],
    foliage: ["oak_leaves", "jungle_leaves", "vine", ...],
    dry_foliage: ["leaf_litter"]
  },
  fixed: {
    water: "#3F76E4",
    bubble_column: "#3F76E4",
    birch_leaves: "#80A755",
    spruce_leaves: "#619961",
    ...
  },
  indexed: {
    melon_stem: { property: "age", default: 7, colors: ["#00FF00", "#20F704", ..., "#E0C71C"] },  // one per age value
    redstone_wire: { property: "power", default: 0, colors: [...] }
  },
  tintindex: { pink_petals: 1, wildflowers: 1 },
  dye: { black: "#1D1D21", light_blue: "#3AB3DA", ... },
  effects: { speed: "#33EBFF", poison: "#87A363", ... },
  potions: {
    swiftness: ["speed"],                                 // draws its color from one effect
    long_swiftness: ["speed"],
    turtle_master: [["slowness", 3], ["resistance", 2]],  // [effect, amplifier] pairs, averaged
    ...
  },
  team: { red: "#FF5555", dark_blue: "#0000AA", ... }
}
```

```js
import { COLORS } from "block-model-renderer"

COLORS.dye.light_blue // "#3AB3DA"
```
