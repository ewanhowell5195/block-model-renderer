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

## Packed scenes and shared atlases

For streaming-scale apps, scenes can build in web workers and ship to the main thread as transferable data: the worker runs [`createScene`](scenes.md#createsceneassets-blocks-args) (workers have no WebGL, so the output group is plain geometry and materials), packs the result, and the main thread revives it into live meshes without rebuilding anything. Atlas pages are deduplicated across every scene a worker builds through a shared atlas, and the main thread mirrors those pages once rather than receiving them again per scene.

| Export | Description |
|---|---|
| `createSharedAtlas({ size?, renderer? })` | An atlas pool handle (default page size 2048). Pass it as `sharedAtlas` to [`createScene`](scenes.md#createsceneassets-blocks-args) / [`optimizeScene`](#scene-optimization) and every scene using it packs textures into the same growing pages. `dispose()` frees the pages |
| `packScene(handle, { sharedAtlas? })` | Pack a `createScene` handle's group into `{ payload, transfers }` for `postMessage`. Geometry attributes, index buffers, material specs, uniforms, instanced meshes (billboards included), and bounds all ship as transferables; textures ship as bitmaps, except shared-atlas pages which ship as `{ sig, page }` references into the mirror |
| `packAtlasDelta(shared, since?)` | The shared atlas regions added after serial `since`, as `{ deltas, serial, size, transfers }`. Send alongside each packed scene and feed the returned `serial` into the next call so each region crosses the thread boundary once. Animated regions carry their frame bitmaps and timing |
| `createAtlasMirror({ renderer? })` | The main-thread counterpart of a worker's shared atlas. `apply(pack)` draws delta regions into locally owned pages (with the renderer, established pages update by GPU sub-uploads instead of full re-uploads); `texture(sig, page)` resolves the page textures that revived scenes reference; `dispose()` frees them |
| `reviveScene(payload, { atlas?, releaseArrays? })` | Rebuild a packed payload into `{ group, dispose() }` of live meshes. `atlas` is the mirror that page-referencing textures resolve against. `releaseArrays` drops CPU-side geometry arrays after GPU upload (plain meshes only), roughly a third of a big scene's heap |

The shape of the flow, worker side then main side:

```js
// worker: build against its own shared atlas, pack, post
const shared = createSharedAtlas()
const handle = await createScene(assets, blocks, { sharedAtlas: shared, animate: false })
const scene = await packScene(handle, { sharedAtlas: shared })
const atlas = await packAtlasDelta(shared, lastSerial)
lastSerial = atlas.serial
postMessage({ scene: scene.payload, atlas }, [...scene.transfers, ...atlas.transfers])
handle.dispose()

// main: mirror the new atlas regions, revive, add
mirror ??= createAtlasMirror({ renderer })
mirror.apply(msg.atlas)
const tile = reviveScene(msg.scene, { atlas: mirror, releaseArrays: true })
world.add(tile.group)
```

Revived groups are inert data, not `createScene` handles: no palette, no light handle, no [dynamic model](scenes.md#dynamic-models) rigs (dynamic parts can't cross the thread boundary as live objects; build those separately on the main thread). Billboards re-attach their camera-facing behavior on revive.

### Animating mirror pages

Packed scenes reference mirror pages, and animated texture regions ride along in the atlas deltas, but nothing plays them automatically: the mirror's pages aren't wired into the page-global animator. Drive them with the schedule helpers:

| Export | Description |
|---|---|
| `setAnimationRenderer(renderer)` | Register the renderer once so frame updates upload as GPU subimages instead of full-page texture re-uploads. Also used by the automatic animator; call it in any app that animates atlas textures on large pages |
| `buildSchedules(textures)` | Precompute per-region frame schedules for a list of textures with animated frames or regions (a mirror's pages via `eachPage`) |
| `evaluateAnimation(schedules, shaders, tickTime)` | Advance every schedule to `tickTime` (in game ticks, 20 per second) and update the textures; `shaders` is materials whose `GameTime` uniform should follow (the end portal). Returns whether anything changed |

Rebuild the schedules when the mirror's `regionsVersion` changes (new animated regions arrived) and call `evaluateAnimation` from your render loop at whatever rate you like; the game runs at 20Hz and interpolated textures look right up to 60Hz.
