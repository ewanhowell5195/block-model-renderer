# Models

Model-level behavior and data: posing a model with display transforms, inspecting what a blockstate resolves to, and the tint tables.

## Display transforms

The `display` option controls how the model is rotated, translated, and scaled before rendering. The render functions and [`loadModel`](scenes.md#loadmodelscene-assets-model-args) both take it.

It takes a **string**, naming a context in the model's own `display` block (`"gui"`, `"fixed"`, `"ground"`, `"firstperson_righthand"`, etc.), or an **object**:

| Property | Description |
|---|---|
| `display` | The context to take from the model. When `type: "fallback"` is set, defaults to `gui`, otherwise defaults to no display settings |
| `rotation`, `translation`, `scale` | Transform values. When used with `display`, each one replaces that display type. With `type: "fallback"` they are used only when the model has nothing matching its `display` context |
| `type` | `"fallback"` only use the defined `rotation`, `translation`, `scale` when the model is missing the specified `display` context |
| `generated` | When `false`, the fallback doesn't apply to generated models (`"parent": "builtin/generated"`) |
| `rotateFlat` | `true` turns [flat models](#isflatmodelmodels) (crosses, crops) 45°. Useful for diagonal camera angles, where they would otherwise appear flat. Applies to whichever transform is used, from the model or from here. Only when the transform leaves one of the model's planes edge-on to the camera, so angles that already show every plane are left as they are |

```js
display: "gui"                                            // the model's gui display
display: { display: "gui" }                               // the same thing
display: { scale: [2, 1, 2] }                             // these exact settings
display: { display: "gui", scale: [2, 1, 2] }             // the model's gui, with this scale instead
display: { display: "gui", type: "fallback", ... }        // the model's gui, or these settings if it has none
display: { type: "fallback", generated: false, ...DISPLAYS.block }  // as above, but never on item sprites
```

A model that doesn't define the named context, with nothing to fall back to, renders untransformed. That is what the game does: a missing context is `NO_TRANSFORM` (no rotation, no translation, scale 1), and the isometric look of blocks in an inventory comes from vanilla's `block/block` declaring a `gui` transform, not from any built-in default. [`DISPLAYS`](#displays) provides that transform for models that don't carry one.

Translation values are clamped to ±80 and scale to ±4, like the game. Mirrored scales (an odd number of negative components) render inside out from 1.15 onwards (MC-176864), which is what unversioned renders do too; see [Legacy Minecraft versions](versions.md#legacy-minecraft-versions) for the pre-1.15 behavior.

## `DISPLAYS`

Ready-made transforms for the `display` option, for posing models that don't carry a transform of their own.

| Preset | Description |
|---|---|
| `DISPLAYS.block` | Vanilla `block/block`'s gui transform: rotation `[30, 225, 0]`, scale `0.625`. The isometric inventory look |
| `DISPLAYS.block_90` | The same pose turned 90° around Y: rotation `[30, 315, 0]` |
| `DISPLAYS.block_180` | Turned 180°: rotation `[30, 45, 0]` |
| `DISPLAYS.block_270` | Turned 270°: rotation `[30, 135, 0]` |
| `DISPLAYS.flat` | No rotation or translation, scale 1. Face-on |

The numbered block presets show the other sides of a model at the same isometric angle, for directional blocks whose front doesn't face the default view.

```js
import { renderModel, DISPLAYS } from "block-model-renderer"

// a model with no gui transform of its own, posed like an inventory block
await renderModel({ model, assets, display: { type: "fallback", ...DISPLAYS.block } })
```

## `isWaterloggable(id)`

Checks whether the renderer recognizes a block id as waterloggable. When `true`, passing `{ waterlogged: true }` in the blockstate properties to [`renderBlock`](standard-api.md#renderblockargs) or [`parseBlockstate`](scenes.md#parseblockstateassets-id-args) will add a water layer to the returned model. When `false`, the `waterlogged` property has no effect.

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

Checks whether a block id is inherently water-filled: blocks that always contain water in game without carrying a `waterlogged` property (kelp, seagrass, bubble columns). [`renderBlock`](standard-api.md#renderblockargs) and [`parseBlockstate`](scenes.md#parseblockstateassets-id-args) add the water layer to these automatically, and [`fluidTypeOf`](fluids.md#fluidtypeofid-properties) counts them as water cells.

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

The light level (0-15) a block emits, straight from the game's per-blockstate data. Uniform emitters (glowstone, torches, lava) return their level for any state; state-dependent emitters (lit furnaces and campfires, candle counts, the light block's `level`) read the deciding properties from `properties`. Packs can extend or override the underlying data through [`lighting.json`](extending.md#block-data-and-colors); this helper reports the built-in data.

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

The renderer applies this automatically: rendering a block that glows in game (via `renderBlock` or a `loadModel` call with `args.block`) floors every element's [`light_emission`](rendering.md#lighting-modes) at the block's own level (unless an explicit `emission` option overrides it), so glowstone stays bright at a dark [`daytime`](rendering.md#lighting-modes) without the model needing `light_emission`. Missing properties resolve through the same `default_blockstates` data the model picker uses, so a bare `campfire` glows lit, matching the model it renders.

## `isFlatModel(models)`

Checks whether resolved model data is built entirely from flat planes: crosses (flowers, saplings, cobwebs) and crops. Takes one resolved model or an array of them, and returns `true` when there are two or more elements, every one is a flat vertical plane rotated only around Y, and their faces all sit 90° apart. The angle itself doesn't matter, so off-axis planes count as long as they stay square to each other.

A model like this always has a plane edge-on to the camera from some angles, showing nothing. [`rotateFlat`](#display-transforms) handles that for you, or check it yourself:

```js
import { parseBlockstate, resolveModelData, isFlatModel } from "block-model-renderer"

const resolved = []
for (const model of await parseBlockstate(assets, "fern")) {
  resolved.push(await resolveModelData(assets, model))
}

await renderBlock({
  id: "fern",
  assets,
  path: "fern.png",
  display: {
    rotation: [30, isFlatModel(resolved) ? 180 : 225, 0],
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

## `SKIP_BLOCKS` and `TECHNICAL_BLOCKS`

Two `Set`s of block ids for tooling that iterates every block:

- `SKIP_BLOCKS`: ids that resolve to no models and render nothing: `air`, `cave_air`, `void_air`, and `moving_piston`. Skip these when batch-rendering
- `TECHNICAL_BLOCKS`: ids that are invisible in game but render with placeholder icon models here: `barrier`, `light`, `structure_void`. Skip them too for game-accurate output, or keep them where the icons are useful, like an editor view. [`createScene`](scenes.md#createsceneassets-blocks-args) hides them by default; its `technical: true` option builds the icons

The ids are bare, without a namespace.

```js
import { SKIP_BLOCKS, TECHNICAL_BLOCKS } from "block-model-renderer"

for (const id of allBlockIds) {
  const bare = id.replace("minecraft:", "")
  if (SKIP_BLOCKS.has(bare) || TECHNICAL_BLOCKS.has(bare)) continue
  await renderBlock({ id, assets, path: `${id}.png` })
}
```

## `COLORS`

The color tables the renderer tints with, exported as one object for lookups in your own tooling (or careful tweaking; it's the live data). Packs can override the tables per entry by shipping their own [`colors.json`](extending.md#block-data-and-colors); this export always reports the built-in data.

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
