# Scene optimization

Building a world out of per-block [`loadModel`](scenes.md#loadmodelassets-model-args) groups works, but every block is its own meshes and draw calls. `optimizeScene` merges the whole scene into a handful of draw calls, with far fewer polygons, so a wall of different blocks becomes roughly one draw call:

```js
import { parseBlockstate, resolveModelData, loadModel, getCullFaces, optimizeScene } from "block-model-renderer"

// your world: cell "x,y,z" -> block. two stone side by side, a log on top of one
const grid = {
  "0,0,0": { id: "stone" },
  "1,0,0": { id: "stone" },
  "0,1,0": { id: "oak_log", properties: { axis: "y" } }
}

// a lookup that reads the blocks around a cell off the grid
function neighborsAt([x, y, z]) {
  return ([dx, dy, dz]) => {
    const cell = grid[`${x + dx},${y + dy},${z + dz}`]
    return cell ? { id: cell.id, ...cell.properties } : null
  }
}

// build each distinct block state once (it can resolve to several models) and reuse it
const groups = new Map()
async function groupFor(block) {
  const key = JSON.stringify(block)
  if (!groups.has(key)) {
    const group = new THREE.Group()
    for (const model of await parseBlockstate(assets, block.id, { properties: block.properties })) {
      await loadModel(assets, await resolveModelData(assets, model), { parent: group })
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
    cull: await getCullFaces({ id: block.id, properties: block.properties, neighbors: neighborsAt(pos), assets })
  })
}

const optimized = await optimizeScene(placements, {
  onProgress: (done, total) => console.log(`optimizing ${Math.round(done / total * 100)}%`)
})
threeScene.add(optimized.group)
```

Each placement is `{ pos, group, cull }`: `pos` is the block's `[x, y, z]` cell coordinate (16 units per cell), `group` is [`loadModel`](scenes.md#loadmodelassets-model-args) output, and `cull` is an optional `Set` of face directions hidden at that placement (from [`getCullFaces`](culling.md#getcullfacesargs)). Above, the two stone blocks cull their touching faces and the log culls its underside, so those faces never reach the merged mesh.

Share one `group` reference across placements of the same block state, as `groupFor` caches here; it's classified once and instanced per placement. That sharing is why `cull` lives on the placement rather than being baked in at [`loadModel`](scenes.md#loadmodelassets-model-args) time.

You *can* cull the other way, pre-culling a separate group per placement and passing those with no `cull` field, and it renders the same. But then no two placements share a build, so you're back to one build per block instead of one per block state. Passing `cull` per placement keeps the single shared build and drops each instance's hidden faces as it merges, which is far cheaper for anything bigger than a handful of blocks.

Options: `maxAtlas` overrides the atlas size ceiling (auto-detected from the canvas and GPU limits), `translucency` sets the pixel cutoffs for textures that didn't come from the asset pipeline, `resortDistance` tunes translucent re-sorting (below), `batchDynamics: false` forces dynamic parts to `InstancedMesh` instead of `BatchedMesh` (what [worker builds](#packing-scenes-across-workers) need, since a revived `BatchedMesh` draws garbage), `release: true` drops the CPU copies of what has been uploaded to the GPU (see [Releasing CPU copies](#releasing-cpu-copies)), and `onProgress(done, total)` / `shouldCancel()` support long builds (cancelling resolves `null`). [`createScene`](scenes.md#createsceneassets-blocks-args) passes all of these through. `onProgress` reports progress across all internal stages, weighted by typical cost, on a fixed scale: use `done / total` as the fraction complete rather than reading the numbers as counts of anything.

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

### Releasing CPU copies

A built scene keeps a CPU copy of what it uploads to the GPU. A scene that is only ever drawn doesn't need them, and `release: true` drops them on first upload:

| Dropped | Kept |
|---|---|
| Opaque merged geometry | Translucent geometry, which the [sorter](#translucent-sorting) rewrites |
| Atlas pages the scene built | [Shared atlas](#shared-atlases) pages, which belong to the handle |
| The light volume `createScene` computes, as with [`computeSceneLight`'s](rendering.md#computescenelightassets-blocks-options) own `release` | A light volume passed in as `lighting: { light }` |

Released atlas pages aren't cached for reuse by later scenes. Their animated textures keep playing only through [`setAnimationRenderer`](#atlas-animation)'s subimage uploads, and hold still without it.

A released scene can't be raycast, packed with [`packScene`](#packing-scenes-across-workers) or exported, and doesn't survive a lost WebGL context. It only draws in the renderer that first uploaded it, so in node, where every static `renderModelScene` call gets a fresh context, it renders once.

## Translucent sorting

Translucent faces (water, stained glass, ice) blend, and blending is order dependent: they must draw far-to-near or things behind show through things in front. The render functions handle this automatically against their fixed camera. [`optimizeScene`](#scene-optimization) attaches a movement-gated sorter to its merged translucent meshes: whenever the live camera has moved `resortDistance` units (default 16, one block) since a mesh last sorted, its triangles re-sort far-to-near, budgeted to about 50,000 triangles a frame (always at least one mesh), longest-waiting mesh first.

For your own live scenes (a model viewer orbiting a [`loadModel`](scenes.md#loadmodelassets-model-args) group), attach the same behavior manually:

```js
import { createTranslucentSorter } from "block-model-renderer"

const sorter = createTranslucentSorter(modelGroup, { resortDistance: 16 })
sorter.sort(camera) // force a sort now (before a one-frame capture)
sorter.detach()     // stop sorting (when discarding the scene)
```

It traverses the object, hooks every mesh with translucent materials, and needs nothing per-frame from you: the renderer hands it the camera on draw.

## Shared atlases

A shared atlas is an atlas pool that outlives any one scene: pass it as `sharedAtlas` to [`createScene`](scenes.md#createsceneassets-blocks-args) / [`optimizeScene`](#scene-optimization) and every scene using the handle resolves its textures against the same pages instead of building per-scene atlases. Main-thread scenes on a stitched handle use its pages and stitch any missing texture into them.

Faces merged on a shared atlas repeat their texture in the library's shader: such a mesh has a `tileRect` attribute and its `uv` holds repeat counts and the texture's orientation, with a `tileLookup` attribute as well where it merges a block's random variants, so it only textures correctly with the material it was built with.

| Export | Description |
|---|---|
| `createSharedAtlas({ size?, headroom?, renderer?, animate? })` | The atlas handle. With a `renderer`, page updates upload as GPU subimages instead of full re-uploads. `animate: true` makes the atlas [tick its own animated regions](#atlas-animation). Page size auto-picks at stitch time (below); pass `size` to force one, or `headroom` to set how much of the page the stitch leaves free (default `0.25`, clamped to `0.95`) |

The handle's methods:

| Method | Description |
|---|---|
| `stitch(assets, opts?)` | Stitch every sprite the packs' atlas definition files list into the atlas up front, the way the game builds its block atlas at startup. `opts.atlases` picks the definitions (default `["blocks", "items"]`, merged into the one atlas), `onProgress(done, total)` reports, `shouldCancel()` aborts. Resolves the handle, or `null` when cancelled. Unless the handle was given an explicit `size`, the page size is picked from the measured sprite area so the stitch leaves the handle's `headroom` fraction of a page free (a quarter of it by default, capped by GPU limits) for runtime textures. After this, scenes are pure rect lookups: no stitching cost, and every scene shares the exact same coordinates |
| `exportLayout()` | The atlas's coordinate table as a structured-cloneable `{ size, pages, rects }` (no pixels, on the order of 150KB for the vanilla pack). Send it to workers once |
| `adoptLayout(layout)` | Turn a fresh handle into a pixel-less adopter of that layout, returning the handle: scenes built against it bake UVs to the fixed coordinates, and `packScene` emits page references only. Adopters never stitch locally; textures missing from the layout either go through `requestSpace` (below) or fall back to per-material textures |
| `insert(items)` | Add runtime textures (sign text, patterned banners, map art) to a live atlas. `items` is `[{ key, image, frames?, times?, interpolate? }]`: `key` is your stable content hash, `image` a bitmap or canvas, and the optional frame fields register the region as animated. Already-present keys dedup to the existing rect; passed bitmaps are closed. Resolves `{ rects, pages }` to merge into worker layouts |
| `texture(sig, page)` | Resolves a page's texture (what revived scenes reference) |
| `dispose()` | Frees the pages and stops the animator |

### Packing scenes across workers

For streaming-scale apps, scenes build in web workers and ship to the main thread as transferable data: the worker runs [`createScene`](scenes.md#createsceneassets-blocks-args) with `batchDynamics: false` (workers have no WebGL, so the output group is plain geometry and materials, and a revived `BatchedMesh` draws garbage), packs the result, and the main thread revives it into live meshes without rebuilding anything. With a prestitched atlas the pixels live only on the main thread; workers carry just the coordinate layout. These exports also exist on Node (useful for testing the pipeline end to end); the one gap is that packing a non-atlas texture as a bitmap needs `createImageBitmap`, so on Node pack scenes against a shared atlas.

| Export | Description |
|---|---|
| `packScene(handle, { sharedAtlas? })` | Pack a `createScene` handle's group into `{ payload, transfers }` for `postMessage`. Geometry attributes, index buffers, material specs, uniforms, instanced meshes (billboards included), and bounds all ship as transferables; textures ship as bitmaps, except shared-atlas pages which ship as `{ sig, page }` references |
| `reviveScene(payload, { sharedAtlas?, release? })` | Rebuild a packed payload into `{ group, light, lightSwitches, dispose() }` of live meshes. `light` is the scene's light volume as `{ uniforms, setOffset }`, or `null`: world lighting takes it as `lighting: { light }`, and its `setOffset` is called like a built scene's [`light.setOffset`](rendering.md#computescenelightassets-blocks-options). `sharedAtlas` is the handle that page references resolve against: the main thread's stitched `createSharedAtlas`. `release` drops CPU-side geometry arrays after GPU upload (plain opaque meshes only; translucent ones keep theirs for the sorter), roughly a third of a big scene's heap |

The whole flow:

```js
// main, once: stitch, export the layout, send it to each worker
const shared = createSharedAtlas({ renderer, animate: true })
await shared.stitch(assets)
worker.postMessage({ type: "init", layout: shared.exportLayout() })

// worker, once: adopt the layout; scenes bake UVs against the fixed coordinates
const atlas = createSharedAtlas().adoptLayout(msg.layout)

// worker, per scene: build, pack (page references only), post
const handle = await createScene(assets, blocks, { sharedAtlas: atlas, animate: false, batchDynamics: false })
const scene = await packScene(handle, { sharedAtlas: atlas })
postMessage({ scene: scene.payload }, scene.transfers)
handle.dispose()

// main, per scene: revive against the stitched atlas, add
const tile = reviveScene(msg.scene, { sharedAtlas: shared, release: true })
world.add(tile.group)
```

Revived groups are inert data, not `createScene` handles: no palette, no light levels, no [dynamic model](scenes.md#dynamic-models) rigs (dynamic parts can't cross the thread boundary as live objects; build those separately on the main thread; the main thread's own scenes can keep stitching into the same live atlas). Billboards re-attach their camera-facing behavior on revive.

A revived scene keeps one set of [lighting switches](rendering.md#lighting-switches) for all its materials, returned as `lightSwitches`.

Pieces built separately on the main thread draw with the revived scene's light volume, time of day, fog and lighting switches through `rebindUniforms(target, source)`. `target` is a group or material, and `source` is a scene group, a material, or anything with `uniforms`, such as `tile.light` or a fog handle:

```js
const dynamics = await createScene(assets, chests, { lighting: { light: tile.light } })
rebindUniforms(doorMesh, tile.group)
```

### Requesting atlas space from workers

Runtime textures a worker generates (sign text, patterned banners) aren't in the prestitched layout. Set `requestSpace` on an adopted handle and the optimizer batches every missing texture in a scene into one call before it bakes UVs:

```js
// worker: ship the pixels to the main thread, get coordinates back
atlas.requestSpace = async items => {
  const bitmaps = await Promise.all(items.map(it => createImageBitmap(it.image)))
  return await askMainThread(items.map((it, i) => ({ ...it, image: bitmaps[i] })), bitmaps)
}

// main, on that message: stitch them in, reply with the rects
const res = await shared.insert(msg.items)
reply({ rects: res.rects, pages: res.pages })
```

`items` is `[{ key, image, w, h, frames, times, interpolate }]` and the resolved value is `insert`'s `{ rects, pages }`; the granted rects merge into the worker's layout automatically, so the scene packs them as page references like everything else. Duplicate content across workers dedups to one rect on the main thread. Textures that stay unresolved (a failed request, glint, repeat-wrapping textures) fall back to per-material textures, which pack as bitmaps and still render correctly.

### Atlas animation

[`createSharedAtlas({ animate: true })`](#shared-atlases) gives the atlas its own player at `shared.animation` (`playing`, `play()`, `pause()`), auto-playing on creation. It ticks every animated region on the pages at the game's 20Hz, budgeted so one tick never uploads an unbounded number of regions, and picks up regions added later (a `stitch` run, `insert`, live scene builds) automatically. Call `setAnimationRenderer(renderer)` (below) so the frame updates upload as GPU subimages.

To drive animation yourself instead, the schedule helpers work on any animated textures or atlas pages:

| Export | Description |
|---|---|
| `setAnimationRenderer(renderer)` | Register the renderer once so frame updates upload as GPU subimages instead of full-page texture re-uploads. Also used by the automatic animator; call it in any app that animates atlas textures on large pages |
| `collectAnimated(root)` | Gather `{ textures, shaders, dynamics }` from a built group: textures with animated frames or regions, materials whose `GameTime` uniform should advance (the end portal), and the roots of self-animating block entity parts |
| `buildSchedules(textures)` | Precompute per-region frame schedules for a list of textures with animated frames or regions |
| `evaluateAnimation(schedules, shaders, tickTime)` | Advance every schedule to `tickTime` (in game ticks, 20 per second) and update the textures. Returns whether anything changed |

The game runs at 20Hz and interpolated textures look right up to 60Hz. Regions only re-blend and re-upload when their evaluated frame actually changes.

Running the standard render functions themselves across a worker pool, and keeping the animation clock in sync between contexts, are covered in the [Advanced API](advanced-api.md#batch-rendering-from-workers).

## Warming shaders

A scene's first frame compiles every shader program it uses, which stalls the page for a few hundred milliseconds. `warmShaders(assets, renderer, args?)` compiles them ahead of time, in the background where the browser supports it, by building a small set of blocks that covers every program vanilla blocks produce:

```js
const warmed = await warmShaders(assets, renderer, { scene, camera, sharedAtlas, lighting: "world" })
// ...build and render scenes...
warmed.dispose()
```

`args` takes every [`createScene`](scenes.md#createsceneassets-blocks-args) option; pass the ones your real scenes use, since lighting mode and a shared atlas change the programs. `scene` is the scene your real scenes are added to and `camera` the one they render with. `blocks` replaces the built-in set, for packs or loaders with materials of their own.

The handle keeps the programs alive: three frees a program once nothing uses it, so dispose the handle only when no more scenes are coming. `programs` is the renderer's program count after warming.

## Wasm kernels

Greedy meshing and the scene light volume run as wasm compiled from `rust/`
(sparse grids mesh with the JavaScript walk, which is faster there). The module ships as `block_model_renderer_bg.wasm`
next to the bundle and is fetched on first use.

`wasmStatus()` resolves `true` when the kernels are in use and `false` when the
JavaScript fallbacks are. Both paths produce identical output; setting
`globalThis.__BMR_NO_WASM = true` forces the JavaScript ones.

Rebuild the module with `npm run build:wasm`, which needs the Rust toolchain and
`wasm-pack`. The build output is committed, so installing from the repository needs neither.
