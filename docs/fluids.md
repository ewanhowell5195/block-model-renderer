# Fluids

Water and lava render like any other block: [`renderBlock({ id: "water", assets })`](api.md) just works, and waterloggable blocks given `{ waterlogged: true }` in their `blockstates` gain the water layer automatically. A standalone render uses the still texture at the game's resting height.

In the world a fluid's shape depends on its surroundings: each surface corner averages with the neighbouring fluid columns, rising to full height against taller fluid and dipping where the fluid falls away, a flowing surface angles its texture along the flow, sides pressed against glass or leaves switch to the overlay texture, and faces shared with the same fluid disappear. To get all of that, give [`loadModel`](api.md) the surrounding blocks:

```js
import { parseBlockstate, resolveModelData, loadModel } from "block-model-renderer"

for (const model of await parseBlockstate(assets, "water", { data: { level: "2" } })) {
  const data = await resolveModelData(assets, model)
  await loadModel(scene, assets, data, {
    lighting: "world",
    neighbors: {
      self: { id: "water", level: "2" },
      north: "water",
      north_east: "water",
      east: { id: "water", level: "4" },
      up_north: "water",
      west: "stone",
      south: "glass"
    }
  })
}
```

The object uses the same per-direction values as [`renderBlock`](api.md)'s culling `neighbors` (a block id string, or `{ id, ...properties }`), extended with diagonal and vertical keys since the surface shape needs them. Anything missing counts as air. Non-fluid models ignore it. [`renderBlock`](api.md) forwards its `neighbors` here automatically, so a fluid rendered through it gets both culling and surface shaping from the one object.

| Key | Used for |
|---|---|
| `self` | The fluid block itself; its `level` property sets its own height. Optional: when omitted, the block counts as the still fluid |
| `north`, `south`, `east`, `west` | Corner averaging, hiding shared faces, overlays, and flow direction |
| `north_east`, `north_west`, `south_east`, `south_west` | Corner averaging with the diagonal columns |
| `up`, plus `up_north` ... `up_south_west` | Fluid above a column makes that column full height |
| `down`, plus `down_north` ... `down_west` | Falling fluid below: hides the bottom face and pulls the flow |

Compound keys order as vertical, then north/south, then east/west (`up_north_east`, `down_west`).

That's the whole API for a single block. The two helpers below only matter when you render fluids at scale, scanning a structure or world for fluid cells and reusing surface shapes across models and blocks; skip them otherwise.

## `fluidTypeOf(id, properties?)`

The fluid a block contributes: `"water"` for water (including any blockstate with `waterlogged: true`), `"lava"` for lava, `null` for everything else. Flowing variants count as their fluid.

Use it when walking blocks to decide which cells need fluid handling at all, instead of reimplementing those rules; the return value is also the `type` to pass to [`fluidHeights`](api.md).

```js
import { fluidTypeOf } from "block-model-renderer"

fluidTypeOf("water")                               // "water"
fluidTypeOf("flowing_lava")                        // "lava"
fluidTypeOf("oak_stairs", { waterlogged: "true" }) // "water"
fluidTypeOf("stone")                               // null
```

## `fluidHeights(assets, type, neighbors)`

The vanilla surface calculation as a standalone helper: exactly what [`loadModel`](api.md) computes internally from `neighbors`.

Use it to compute a block's surface shape once and share it: a waterlogged block is several models needing the same shape (pass the result to each [`loadModel`](api.md) as [`fluidHeights`](api.md)), and across a scene, cells with identical results can share one built model instead of rebuilding geometry per block.

```js
import { parseBlockstate, resolveModelData, loadModel, fluidTypeOf, fluidHeights } from "block-model-renderer"

const type = fluidTypeOf("oak_fence", { waterlogged: "true" }) // "water"
const heights = await fluidHeights(assets, type, { north: "water", north_east: "water", east: "water" })

// a waterlogged fence resolves to two models, the fence and its water layer:
// both share the one precomputed shape
for (const model of await parseBlockstate(assets, "oak_fence", { data: { waterlogged: "true" } })) {
  const data = await resolveModelData(assets, model)
  await loadModel(scene, assets, data, { lighting: "world", fluidHeights: heights })
}
```

| Argument | Description |
|---|---|
| `assets` | The assets source (neighbour solidity is read from their models) |
| `type` | `"water"` or `"lava"`, or `null` for a non-fluid (this is [`fluidTypeOf`](api.md)'s return, passed straight through) |
| `neighbors` | The surrounding blocks, in the same direction-keyed form shown above |

Returns an object you can pass to [`loadModel`](api.md) as [`fluidHeights`](api.md) (or `null` when `type` was `null`):

| Field | Description |
|---|---|
| `nw`, `ne`, `sw`, `se` | Corner heights from `0` to `1`, the vanilla corner-averaging formula |
| `full` | The block above is the same fluid, so this one renders as a full cube |
| `angle` | Flow direction in radians for the flowing texture, or `null` when still |
| `overlay` | `{ north, south, west, east }` booleans: sides that use the `water_overlay` texture (pressed against a block with a full face there, like glass or leaves) |
| `same` | All six directions: `true` where the neighbour is the same fluid, and the shared face is hidden |
