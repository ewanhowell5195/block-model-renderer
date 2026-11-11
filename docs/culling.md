# Culling hidden faces

Blocks in the world hide the faces pressed against their neighbors. To render a block the way it looks in place (no bottom face against the ground, no side faces against adjacent blocks), pass `neighbors` to [`renderBlock`](standard-api.md#renderblockargs):

```js
await renderBlock({
  id: "oak_stairs",
  properties: { facing: "east", half: "bottom" },
  neighbors: ([x, y, z]) => {
    if (x === 0 && y === -1 && z === 0) return { id: "stone" }                  // id + blockstate properties
    if (x === 0 && y === 0 && z === -1) return { id: "oak_slab", type: "bottom" }
    if (x === 0 && y === 1 && z === 0) return true                               // force-cull this side
    return null                                                                  // air, nothing culled
  },
  assets,
})
```

`neighbors` is called with an offset `[x, y, z]` from the block and returns the block there. Culling only asks for the six face offsets; [fluids](fluids.md) and [placement-aware loaders](extending.md#placement-aware-models) can ask for any offset.

The rules follow Minecraft's `shouldRenderFace`. A `cullface`-authored face is dropped when:

* the neighbor's shape fully covers it. This is state-aware, so two adjacent bottom slabs cull their touching sides but a top slab against a bottom slab doesn't
* the block self-culls against its own kind (glass against glass, water against water). Panes and bars follow the game's connection rule: vertically against their own kind, sideways only when both sides connect toward each other

And never against blocks the game flags as non-occluding (glass, leaves, powder snow), no matter how solid they look.

It's *near* game-accurate rather than exact: the game hardcodes each block's occlusion shape, while this library rasterizes it off the actual model geometry and texture opacity instead, since copying the game's full per-block shape table would be unsustainable. The non-occluders above (glass, leaves, and such) are the exception, since they can't be read off geometry, so those stay a small built-in id list, which packs can extend through [`culling.json`](extending.md#block-data-and-colors).

## `getCullFaces(args)`

The same logic as a standalone helper, for building your own scenes with [`loadModel`](scenes.md#loadmodelassets-model-args):

| Option | Default | Description |
|---|---|---|
| `id` | required | The block id |
| `assets` | required | The assets source |
| `properties` | `{}` | The block's blockstate property values |
| `neighbors` | | The six face neighbors as an object keyed `up`, `down`, `north`, `south`, `west`, `east`, where each value is `{ id, ...properties }`, an id string, or `true` to force-cull that side. Or the `([x, y, z]) => block` lookup [`renderBlock`](standard-api.md#renderblockargs) takes, which is asked for the six face offsets |

Returns a `Set` of directions to drop (`"down"`, `"up"`, `"north"`, `"south"`, `"west"`, `"east"`). Pass it as the `cull` option to any render function or [`loadModel`](scenes.md#loadmodelassets-model-args); a plain object like `{ north: true }` works there too. Air ids return an empty set without touching the assets, and air neighbors count as absent.

```js
import { getCullFaces, loadModel } from "block-model-renderer"

const cull = await getCullFaces({
  id: "oak_stairs",
  properties: { facing: "east", half: "bottom" },
  neighbors: {
    down: { id: "oak_slab", type: "top" }, // neighbors take properties too
    up: "glass"
  },
  assets
})
// Set { "down" }: the top slab's full upper face covers it (a bottom slab wouldn't); glass up doesn't occlude
await loadModel(assets, resolved, { cull, parent: scene })
```

A neighbor entry can also carry an explicit `occludes` boolean (`{ id: "stone", occludes: false }`, or just `{ occludes: true }`). That skips the model-based occlusion check entirely and uses your answer, with only the self-culling rule still applying on top. Useful when you've already computed occlusion yourself, or need to override a specific pairing.

Because occlusion comes from the models, modded blocks and custom packs just work. The models a call builds are cached for that call; with [`prepareAssets(assets, { cache: true })`](assets.md#caching) they're cached across calls too.

## `fullyOccludes(args)`

Whether a block state is a full occluding cube: every one of its six faces completely hides whatever is pressed against it (stone yes, stairs, glass, and leaves no). Takes `{ id, properties?, assets }`; async, resolves a boolean. Air ids resolve `false` without touching the assets.

Useful for world-scale preprocessing: a cell whose six neighbors all fully occlude can be dropped before building a scene at all, which is how a caller thins buried terrain. The per-face masks it computes are the same ones culling uses, and land in the same cache, which [`exportCache`](assets.md#exporting-and-importing-the-cache) can persist.
