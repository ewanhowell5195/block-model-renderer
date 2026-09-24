# Fluids

Water and lava render like any other block: [`renderBlock({ id: "water", assets })`](standard-api.md#renderblockargs) just works, and waterloggable blocks given `{ waterlogged: true }` in their `blockstates` gain the water layer automatically. A standalone render uses the still texture at the game's resting height.

In the world a fluid's shape depends on its surroundings: each surface corner averages with the neighboring fluid columns, rising to full height against taller fluid and dipping where the fluid falls away, a flowing surface angles its texture along the flow, sides pressed against glass or leaves switch to the overlay texture, and faces shared with the same fluid disappear. To get all of that, give [`loadModel`](scenes.md#loadmodelscene-assets-model-args) the surrounding blocks:

```js
import { parseBlockstate, resolveModelData, loadModel } from "block-model-renderer"

const around = new Map([
  ["0,0,0", { id: "water", level: "2" }],
  ["0,0,-1", { id: "water" }],
  ["1,0,-1", { id: "water" }],
  ["1,0,0", { id: "water", level: "4" }],
  ["0,1,-1", { id: "water" }],
  ["-1,0,0", { id: "stone" }],
  ["0,0,1", { id: "glass" }]
])

for (const model of await parseBlockstate(assets, "water", { data: { level: "2" } })) {
  const data = await resolveModelData(assets, model)
  await loadModel(scene, assets, data, {
    lighting: "world",
    neighbors: ([x, y, z]) => around.get(`${x},${y},${z}`) ?? null
  })
}
```

`neighbors` is the same lookup [`renderBlock`](standard-api.md#renderblockargs) takes for culling: called with an offset `[x, y, z]`, it returns `{ id, ...properties }` for the block there, or `null` for air. Non-fluid models ignore it. [`renderBlock`](standard-api.md#renderblockargs) forwards its `neighbors` here automatically, so a fluid rendered through it gets both culling and surface shaping from the one function.

The surface reads every offset within one block:

| Offsets | Used for |
|---|---|
| `[0, 0, 0]` | The fluid block itself; its `level` property sets its own height. Returning `null` counts it as the still fluid |
| `[±1, 0, 0]`, `[0, 0, ±1]` | Corner averaging, hiding shared faces, overlays, and flow direction |
| `[±1, 0, ±1]` | Corner averaging with the diagonal columns |
| `y` of `1` | Fluid above a column makes that column full height |
| `y` of `-1` | Falling fluid below: hides the bottom face and pulls the flow |

That's the whole API for a single block. The two helpers below only matter when you render fluids at scale, scanning a structure or world for fluid cells and reusing surface shapes across models and blocks; skip them otherwise.

## `fluidTypeOf(id, properties?)`

The fluid a block contributes: `"water"` for water (including any blockstate with `waterlogged: true`, and blocks that are always water-filled per [`isWaterlogged`](models.md#iswaterloggedid): kelp, seagrass, bubble columns), `"lava"` for lava, `null` for everything else. Flowing variants count as their fluid.

Use it when walking blocks to decide which cells need fluid handling at all, instead of reimplementing those rules; the return value is also the `type` to pass to [`fluidHeights`](#fluidheightsassets-type-neighbors).

```js
import { fluidTypeOf } from "block-model-renderer"

fluidTypeOf("water")                               // "water"
fluidTypeOf("flowing_lava")                        // "lava"
fluidTypeOf("oak_stairs", { waterlogged: "true" }) // "water"
fluidTypeOf("kelp")                                // "water": always water-filled
fluidTypeOf("stone")                               // null
```

## `fluidHeights(assets, type, neighbors)`

The vanilla surface calculation as a standalone helper: exactly what [`loadModel`](scenes.md#loadmodelscene-assets-model-args) computes internally from `neighbors`.

Use it to compute a block's surface shape once and share it: a waterlogged block is several models needing the same shape (pass the result to each [`loadModel`](scenes.md#loadmodelscene-assets-model-args) as its `fluidHeights` arg), and across a scene, cells with identical results can share one built model instead of rebuilding geometry per block.

```js
import { parseBlockstate, resolveModelData, loadModel, fluidTypeOf, fluidHeights } from "block-model-renderer"

const type = fluidTypeOf("oak_fence", { waterlogged: "true" }) // "water"
const water = new Set(["0,0,-1", "1,0,-1", "1,0,0"])
const heights = await fluidHeights(assets, type, ([x, y, z]) => water.has(`${x},${y},${z}`) ? { id: "water" } : null)

// a waterlogged fence resolves to two models, the fence and its water layer:
// both share the one precomputed shape
for (const model of await parseBlockstate(assets, "oak_fence", { data: { waterlogged: "true" } })) {
  const data = await resolveModelData(assets, model)
  await loadModel(scene, assets, data, { lighting: "world", fluidHeights: heights })
}
```

| Argument | Description |
|---|---|
| `assets` | The assets source (neighbor solidity is read from their models) |
| `type` | `"water"` or `"lava"`, or `null` for a non-fluid (this is [`fluidTypeOf`](#fluidtypeofid-properties)'s return, passed straight through) |
| `neighbors` | The surrounding blocks, as the offset lookup shown above |

Returns an object you can pass to [`loadModel`](scenes.md#loadmodelscene-assets-model-args) as its `fluidHeights` arg (or `null` when `type` was `null`):

| Field | Description |
|---|---|
| `nw`, `ne`, `sw`, `se` | Corner heights from `0` to `1`, the vanilla corner-averaging formula |
| `full` | The block above is the same fluid, so this one renders as a full cube |
| `angle` | Flow direction in radians for the flowing texture, or `null` when still |
| `overlay` | `{ north, south, west, east }` booleans: sides that use the `water_overlay` texture (pressed against a block with a full face there, like glass or leaves) |
| `same` | All six directions: `true` where the neighbor is the same fluid, and the shared face is hidden |
