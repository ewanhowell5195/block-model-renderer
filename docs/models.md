# Models

Model-level behaviour and data: posing a model with display transforms, inspecting what a blockstate resolves to, and the tint tables.

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

Translation values are clamped to ±80 and scale to ±4, like the game. Mirrored scales (an odd number of negative components) render inside out from 1.15 onwards (MC-176864), which is what unversioned renders do too; see [Legacy Minecraft versions](versions.md#legacy-minecraft-versions) for the pre-1.15 behaviour.

## `isWaterloggable(id)`

Checks whether the renderer recognises a block id as waterloggable. When `true`, passing `{ waterlogged: true }` in the blockstate properties to [`renderBlock`](api.md) or [`parseBlockstate`](api.md) will add a water layer to the returned model. When `false`, the `waterlogged` property has no effect.

| Argument | Description |
|---|---|
| `id` | The block id (e.g. `"oak_stairs"`, `"minecraft:lantern"`). Namespace optional |

Returns `true` if the block is waterloggable, `false` otherwise.

```js
import { isWaterloggable } from "block-model-renderer"

isWaterloggable("oak_stairs") // true
isWaterloggable("stone")      // false
```

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

## `COLORS`

The colour tables the renderer tints with, exported as one object for lookups in your own tooling (or careful tweaking; it's the live data):

| Key | Contents |
|---|---|
| `colormap` | Block-id lists grouped by which biome colormap image they sample: `grass`, `foliage`, or `dry_foliage`. Their tint is read from the colormap texture rather than being a fixed value |
| `fixed` | Blocks with a hardcoded hex tint instead of a colormap. Each entry is `{ color }`, optionally with a `blocks` list of ids that share it (water, birch/spruce leaves, lily pads, attached stems) |
| `indexed` | Tint ramps selected by a blockstate property: `{ blocks, property, default, colors }` picks `colors[value]` for the block's `property` (stem `age`, redstone wire `power`), falling back to `default` |
| `tintindex` | Blocks whose colormap tint applies to a `tintindex` other than the default `0`; the value is that index (e.g. `pink_petals: 1`) |
| `dye` | The 16 dye colours, dye name to hex string |
| `effects` | Each status effect's particle colour as a hex string, used when tinting from a `potion` |
| `potions` | Each potion id to the effect(s) it draws colour from (`["speed"]`, or weighted `[["slowness", 3], ["resistance", 2]]`). Their `effects` colours are averaged into the one potion tint |
| `team` | The 16 team/formatting colours, name to hex string, used by the `team` tint source |

The shape, abbreviated:

```js
{
  colormap: {
    grass: ["grass_block", "fern", "short_grass", ...],
    foliage: ["oak_leaves", "jungle_leaves", "vine", ...],
    dry_foliage: ["leaf_litter"]
  },
  fixed: {
    water: { blocks: ["water", "bubble_column", "water_cauldron"], color: "#3F76E4" },
    birch_leaves: { color: "#80A755" },
    spruce_leaves: { color: "#619961" },
    ...
  },
  indexed: {
    stem: {
      blocks: ["melon_stem", "pumpkin_stem"],
      property: "age",
      default: 7,
      colors: ["#00FF00", "#20F704", ..., "#E0C71C"]  // one per age value
    },
    redstone: { blocks: ["redstone_wire"], property: "power", default: 0, colors: [...] }
  },
  tintindex: { pink_petals: 1, wildflowers: 1 },
  dye: { black: "#1d1d21", light_blue: "#3ab3da", ... },
  effects: { speed: "#33EBFF", poison: "#87A363", ... },
  potions: {
    swiftness: ["speed"],                                 // draws its colour from one effect
    long_swiftness: ["speed"],
    turtle_master: [["slowness", 3], ["resistance", 2]],  // [effect, amplifier] pairs, averaged
    ...
  },
  team: { red: "#FF5555", dark_blue: "#0000AA", ... }
}
```

```js
import { COLORS } from "block-model-renderer"

COLORS.dye.light_blue // "#3ab3da"
```
