# Scene optimization

Building a world out of per-block [`loadModel`](scenes.md#loadmodelscene-assets-model-args) groups works, but every block is its own meshes and draw calls. `optimizeScene` merges the whole scene into a handful of draw calls, with far fewer polygons, so a wall of different blocks becomes roughly one draw call:

```js
import { parseBlockstate, resolveModelData, loadModel, getCullFaces, optimizeScene } from "block-model-renderer"

// your world: cell "x,y,z" -> block. two stone side by side, a log on top of one
const grid = {
  "0,0,0": { id: "stone" },
  "1,0,0": { id: "stone" },
  "0,1,0": { id: "oak_log", blockstates: { axis: "y" } }
}

// the six face offsets, and a getter that reads a cell's neighbors off the grid
const FACES = { down: [0,-1,0], up: [0,1,0], north: [0,0,-1], south: [0,0,1], west: [-1,0,0], east: [1,0,0] }
function neighborsAt([x, y, z]) {
  const n = {}
  for (const dir in FACES) {
    const [dx, dy, dz] = FACES[dir]
    const cell = grid[`${x + dx},${y + dy},${z + dz}`]
    if (cell) n[dir] = cell.blockstates ? { id: cell.id, ...cell.blockstates } : cell.id
  }
  return n
}

// build each distinct block state once (it can resolve to several models) and reuse it
const groups = new Map()
async function groupFor(block) {
  const key = JSON.stringify(block)
  if (!groups.has(key)) {
    const group = new THREE.Group()
    for (const model of await parseBlockstate(assets, block.id, { data: block.blockstates })) {
      await loadModel(group, assets, await resolveModelData(assets, model))
    }
    groups.set(key, group)
  }
  return groups.get(key)
}

// turn the grid into placements, culling each cell against its neighbors
const placements = []
for (const key in grid) {
  const block = grid[key], pos = key.split(",").map(Number)
  placements.push({
    pos,
    group: await groupFor(block),
    cull: await getCullFaces({ id: block.id, blockstates: block.blockstates, neighbors: neighborsAt(pos), assets })
  })
}

const optimized = await optimizeScene(placements, {
  onProgress: (done, total) => console.log(`optimizing ${Math.round(done / total * 100)}%`)
})
threeScene.add(optimized.group)
```

Each placement is `{ pos, group, cull }`: `pos` is the block's `[x, y, z]` cell coordinate (16 units per cell), `group` is [`loadModel`](scenes.md#loadmodelscene-assets-model-args) output, and `cull` is an optional `Set` of face directions hidden at that placement (from [`getCullFaces`](culling.md#getcullfacesargs)). Above, the two stone blocks cull their touching faces and the log culls its underside, so those faces never reach the merged mesh.

Share one `group` reference across placements of the same block state, as `groupFor` caches here; it's classified once and instanced per placement. That sharing is why `cull` lives on the placement rather than being baked in at [`loadModel`](scenes.md#loadmodelscene-assets-model-args) time.

You *can* cull the other way, pre-culling a separate group per placement and passing those with no `cull` field, and it renders the same. But then no two placements share a build, so you're back to one build per block instead of one per block state. Passing `cull` per placement keeps the single shared build and drops each instance's hidden faces as it merges, which is far cheaper for anything bigger than a handful of blocks.

Options: `maxAtlas` overrides the atlas size ceiling (auto-detected from the canvas and GPU limits), `translucency` sets the pixel cutoffs for textures that didn't come from the asset pipeline, `resortDistance` tunes translucent re-sorting (below), and `onProgress(done, total)` / `shouldCancel()` support long builds (cancelling resolves `null`). `onProgress` reports progress across all internal stages, weighted by typical cost, on a fixed scale: use `done / total` as the fraction complete rather than reading the numbers as counts of anything.

The result:

| Field | Description |
|---|---|
| `group` | The merged `THREE.Group` to add to your scene |
| `drawCalls`, `tris` | Stats for the merged output |
| `atlasTextures` | The atlas textures the call built (already applied to the merged materials) |
| [`sortTranslucent(camera)`](#translucent-sorting) | Force a translucent sort now, before a single-frame capture |
| `dispose()` | Frees everything the call created (merged geometry, atlas textures, cloned materials). Must be called when you discard or replace the scene; GPU resources don't garbage collect. Textures from the assets are untouched; those belong to [`disposeCache`](assets.md#caching) |

Animated textures (water, lava, fire) stay live in the merged output and keep playing through [`createAnimator`](scenes.md#animation-browser) or the automatic animator. [Dynamic models](scenes.md#dynamic-models) keep their moving pieces live: static cubes (a chest's base) merge like any other geometry, while `part` elements render as instanced meshes, one draw per unique part geometry and material no matter how many placements share it (a hundred chests cost the same two lid draws as one). Every placement still has its own pose rig in the output group, so books keep animating and each placement's `.open()`/`.close()` and [`poseSpecial`](scenes.md#posespecialroot-pose) keep working independently.

Every material the library creates (merged or per-model) compiles with clipping support, so three.js clipping planes work as with any standard material: assign `renderer.clippingPlanes` globally, or enable `renderer.localClippingEnabled` and set `clippingPlanes` per material.

## Translucent sorting

Translucent faces (water, stained glass, ice) blend, and blending is order dependent: they must draw far-to-near or things behind show through things in front. The render functions handle this automatically against their fixed camera. [`optimizeScene`](#scene-optimization) attaches a movement-gated sorter to its merged translucent meshes: whenever the live camera has moved `resortDistance` units (default 16, one block) since a mesh last sorted, its triangles re-sort far-to-near, budgeted to one mesh per frame.

For your own live scenes (a model viewer orbiting a [`loadModel`](scenes.md#loadmodelscene-assets-model-args) group), attach the same behavior manually:

```js
import { sortTranslucent } from "block-model-renderer"

const handle = sortTranslucent(modelGroup, { resortDistance: 16 })
handle.sort(camera) // force a sort now (before a one-frame capture)
handle.detach()     // stop sorting (when discarding the scene)
```

It traverses the object, hooks every mesh with translucent materials, and needs nothing per-frame from you: the renderer hands it the camera on draw.

## Shared atlases

A shared atlas is an atlas pool that outlives any one scene: pass it as `sharedAtlas` to [`createScene`](scenes.md#createsceneassets-blocks-args) / [`optimizeScene`](#scene-optimization) and every scene using the handle resolves its textures against the same pages instead of building per-scene atlases.

| Export | Description |
|---|---|
| `createSharedAtlas({ size?, headroom?, renderer?, animate? })` | The atlas handle. With a `renderer`, page updates upload as GPU subimages instead of full re-uploads. `animate: true` makes the atlas [tick its own animated regions](#atlas-animation). `texture(sig, page)` resolves a page's texture (what revived scenes reference); `dispose()` frees the pages and stops the animator. Page size auto-picks at stitch time (below); pass `size` to force one, or `headroom` to set how much of the page the stitch leaves free (default `0.25`, clamped to `0.95`) |
| `stitchSharedAtlas(shared, assets, opts?)` | Stitch every sprite the packs' atlas definition files list into the atlas up front, the way the game builds its block atlas at startup. `opts.atlases` picks the definitions (default `["blocks", "items"]`, merged into the one atlas), `onProgress(done, total)` reports, `shouldCancel()` aborts (resolving `null`). Unless the handle was given an explicit `size`, the page size is picked from the measured sprite area so the stitch leaves the handle's `headroom` fraction of a page free (a quarter of it by default, capped by GPU limits) for runtime textures. After this, scenes are pure rect lookups: no stitching cost, and every scene shares the exact same coordinates |
| `exportSharedAtlasLayout(shared)` | The atlas's coordinate table as a structured-cloneable `{ size, pages, rects }` (no pixels, on the order of 150KB for the vanilla pack). Send it to workers once |
| `adoptSharedAtlasLayout(shared, layout)` | Turn a fresh handle into a pixel-less adopter of that layout: scenes built against it bake UVs to the fixed coordinates, and `packScene` emits page references only. Adopters never stitch locally; textures missing from the layout either go through `requestSpace` (below) or fall back to per-material textures |
| `insertSharedTextures(shared, items)` | Add runtime textures (sign text, patterned banners, map art) to a live atlas. `items` is `[{ key, image, frames?, times?, interpolate? }]`: `key` is your stable content hash, `image` a bitmap or canvas, and the optional frame fields register the region as animated. Already-present keys dedup to the existing rect; passed bitmaps are closed. Returns `{ rects, pages }` to merge into worker layouts |

### Packing scenes across workers

For streaming-scale apps, scenes build in web workers and ship to the main thread as transferable data: the worker runs [`createScene`](scenes.md#createsceneassets-blocks-args) (workers have no WebGL, so the output group is plain geometry and materials), packs the result, and the main thread revives it into live meshes without rebuilding anything. With a prestitched atlas the pixels live only on the main thread; workers carry just the coordinate layout. These exports also exist on Node (useful for testing the pipeline end to end); the one gap is that packing a non-atlas texture as a bitmap needs `createImageBitmap`, so on Node pack scenes against a shared atlas.

| Export | Description |
|---|---|
| `packScene(handle, { sharedAtlas? })` | Pack a `createScene` handle's group into `{ payload, transfers }` for `postMessage`. Geometry attributes, index buffers, material specs, uniforms, instanced meshes (billboards included), and bounds all ship as transferables; textures ship as bitmaps, except shared-atlas pages which ship as `{ sig, page }` references |
| `reviveScene(payload, { atlas?, releaseArrays? })` | Rebuild a packed payload into `{ group, dispose() }` of live meshes. `atlas` is the handle that page references resolve against: the main thread's stitched `createSharedAtlas`. `releaseArrays` drops CPU-side geometry arrays after GPU upload (plain meshes only), roughly a third of a big scene's heap |

The whole flow:

```js
// main, once: stitch, export the layout, send it to each worker
const shared = createSharedAtlas({ renderer, animate: true })
await stitchSharedAtlas(shared, assets)
worker.postMessage({ type: "init", layout: exportSharedAtlasLayout(shared) })

// worker, once: adopt the layout; scenes bake UVs against the fixed coordinates
const atlas = adoptSharedAtlasLayout(createSharedAtlas(), msg.layout)

// worker, per scene: build, pack (page references only), post
const handle = await createScene(assets, blocks, { sharedAtlas: atlas, animate: false })
const scene = await packScene(handle, { sharedAtlas: atlas })
postMessage({ scene: scene.payload }, scene.transfers)
handle.dispose()

// main, per scene: revive against the stitched atlas, add
const tile = reviveScene(msg.scene, { atlas: shared, releaseArrays: true })
world.add(tile.group)
```

Revived groups are inert data, not `createScene` handles: no palette, no light handle, no [dynamic model](scenes.md#dynamic-models) rigs (dynamic parts can't cross the thread boundary as live objects; build those separately on the main thread; the main thread's own scenes can keep stitching into the same live atlas). Billboards re-attach their camera-facing behavior on revive.

### Requesting atlas space from workers

Runtime textures a worker generates (sign text, patterned banners) aren't in the prestitched layout. Set `requestSpace` on an adopted handle and the optimizer batches every missing texture in a scene into one call before it bakes UVs:

```js
// worker: ship the pixels to the main thread, get coordinates back
atlas.requestSpace = async items => {
  const bitmaps = await Promise.all(items.map(it => createImageBitmap(it.image)))
  return await askMainThread(items.map((it, i) => ({ ...it, image: bitmaps[i] })), bitmaps)
}

// main, on that message: stitch them in, reply with the rects
const res = await insertSharedTextures(shared, msg.items)
reply({ rects: res.rects, pages: res.pages })
```

`items` is `[{ key, image, w, h, frames, times, interpolate }]` and the resolved value is `insertSharedTextures`' `{ rects, pages }`; the granted rects merge into the worker's layout automatically, so the scene packs them as page references like everything else. Duplicate content across workers dedups to one rect on the main thread. Textures that stay unresolved (a failed request, glint, repeat-wrapping textures) fall back to per-material textures, which pack as bitmaps and still render correctly.

### Atlas animation

[`createSharedAtlas({ animate: true })`](#shared-atlases) gives the atlas its own player at `shared.animation` (`playing`, `play()`, `pause()`), auto-playing on creation. It ticks every animated region on the pages at the game's 20Hz, budgeted so one tick never uploads an unbounded number of regions, and picks up regions added later (a `stitchSharedAtlas` run, `insertSharedTextures`, live scene builds) automatically. Call [`setAnimationRenderer(renderer)`](#atlas-animation) so the frame updates upload as GPU subimages.

To drive animation yourself instead, the schedule helpers work on any animated textures or atlas pages:

| Export | Description |
|---|---|
| `setAnimationRenderer(renderer)` | Register the renderer once so frame updates upload as GPU subimages instead of full-page texture re-uploads. Also used by the automatic animator; call it in any app that animates atlas textures on large pages |
| `collectAnimated(root)` | Gather `{ textures, shaders }` from a built group: textures with animated frames or regions, and materials whose `GameTime` uniform should advance (the end portal) |
| `buildSchedules(textures)` | Precompute per-region frame schedules for a list of textures with animated frames or regions |
| `evaluateAnimation(schedules, shaders, tickTime)` | Advance every schedule to `tickTime` (in game ticks, 20 per second) and update the textures. Returns whether anything changed |

The game runs at 20Hz and interpolated textures look right up to 60Hz. Regions only re-blend and re-upload when their evaluated frame actually changes.
