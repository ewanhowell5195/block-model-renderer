# Building scenes

For custom rendering pipelines, lower-level functions are available. The typical flow: parse a blockstate or item definition into model references, resolve each reference into a flat model, load it into a scene, render the scene. For whole block scenes there's [`createScene`](#createsceneassets-blocks-args), which runs the entire pipeline in one call.

```js
import {
  makeModelScene,
  parseBlockstate,
  resolveModelData,
  loadModel,
  renderModelScene,
  prepareAssets
} from "block-model-renderer"

const assets = await prepareAssets("C:/Users/ewanh/AppData/Roaming/.minecraft/resourcepacks/vanilla")
const { scene, camera } = makeModelScene()
const models = await parseBlockstate(assets, "oak_log")

for (const model of models) {
  const resolved = await resolveModelData(assets, model)
  await loadModel(scene, assets, resolved)
}

const buffer = await renderModelScene(scene, camera, {
  path: "oak_log.png",
  width: 512,
  height: 512
})
```

## `createScene(assets, blocks, args?)`

Builds a whole block scene in one call: blockstate parsing, per-position variant picks, hidden-face culling, fluid surface shaping, waterlogging, block entity models, lighting, and scene optimization with live translucent sorting. Feed it your raw block list as-is: the [`SKIP_BLOCKS`](models.md#skip_blocks-and-technical_blocks) and [technical](models.md#skip_blocks-and-technical_blocks) ids are handled for you, no pre-filtering needed. You add the returned group wherever you want it. Everything below this section is the manual pipeline underneath it, for when you need finer control.

```js
const handle = await createScene(assets, [
  { id: "grass_block", pos: [0, 0, 0], biome: { temperature: 0.8, downfall: 0.4 } },
  { id: "oak_log", properties: { axis: "y" }, pos: [0, 1, 0] },
  { id: "water", pos: [1, 0, 0] }
])
scene.add(handle.group)
```

Each block entry:

| Field | Description |
|---|---|
| `id` | The block id. Namespace optional |
| `properties` | Blockstate property values (e.g. `{ axis: "y", waterlogged: "true" }`) |
| `pos` | Block grid position `[x, y, z]`, integers. Geometry comes out at 16 world units per block, block centres at `pos * 16`. When two entries share a position, the last one wins |
| `biome` | Biome tinting for this block's colormap tints, same value as the `biome` render option. Overrides `args.biome` |

Options, grouped by what they affect. How the scene looks:

| Option | Default | Description |
|---|---|---|
| `biome` | | Scene-wide biome tinting; a block's own `biome` overrides it |
| `lighting` | `"world"` | Lighting mode (`"item"`, `"world"`, `"scene"`, `"off"`), or a [world lighting config object](rendering.md#world-lighting): dimension, daytime, brightness, and `light`. World mode computes the light volume from the blocks automatically (respecting the dimension's `hasSkyLight`); set `lighting: { light }` to reuse an existing [`computeSceneLight`](#scene-lighting) handle (it stays yours to dispose), or `{ light: false }` to skip the volume entirely |
| `shaderScale` | `1` | Screen-space shader density (the end portal), as in [`renderBlock`](standard-api.md#renderblockargs) |
| `technical` | `false` | Build the [technical blocks](models.md#skip_blocks-and-technical_blocks) (barrier, light, structure void) with their placeholder icons. Off, they're invisible like in game, but still feed the light volume, so a light block lights its area either way |

Asset interpretation:

| Option | Default | Description |
|---|---|---|
| `version` | | Minecraft version the assets are for. See [Legacy Minecraft versions](versions.md#legacy-minecraft-versions) |
| `ignoreAtlases` | `false` | Skip texture atlas membership rules |

The optimize pass:

| Option | Default | Description |
|---|---|---|
| `optimize` | `true` | Merge the built scene with [`optimizeScene`](#scene-optimization). `false` keeps one group clone per block, which renders far slower on big scenes but leaves every block individually addressable |
| `resortDistance`, `maxAtlas`, `translucency` | | Passed through to the optimize pass |

The build itself:

| Option | Default | Description |
|---|---|---|
| `onProgress` | | `(stage, done, total)` progress callback, see below |
| `shouldCancel` | | Checked between work slices; return `true` to abort. A cancelled `createScene` resolves `null` |
| `animate` | `true` | Browser: auto-play texture animations, like [`loadModel`](#loadmodelscene-assets-model-args). On Node, animated output goes through [`renderModelScene`](#rendermodelscenescene-camera-args) as usual |
| `keepTemplates` | `false` | Retain the internal per-state template groups and return them on the handle, for tooling that needs per-block geometry (collision, hit-testing). Holds their memory for the scene's lifetime |

Weighted blockstate variants pick deterministically per position (the position seeds the pick), so a field of grass blocks gets a natural rotation spread like in game, though not the game's exact per-position picks. Block entity contents and sign text are out of scope.

### Progress stages

`onProgress(stage, done, total)` reports per stage. `stage` is `{ index, count, name }`: `index` counts from 0, `count` is fixed for the whole call (computed up front from the options), and `done`/`total` are monotonic within the stage. An overall bar can use `(stage.index + done / total) / stage.count`.

| Name | Present | Work |
|---|---|---|
| `"parse"` | always | Blockstate parsing, variant picks, culling, fluid shapes |
| `"light"` | `lighting: "world"` only (the default) | Flood-filling the light volume |
| `"build"` | always | Building geometry |
| `"optimize"` | `optimize: true` | Merging the scene; [`optimizeScene`](#scene-optimization)'s own progress passes through |

### Return value

Resolves to a handle, or `null` when cancelled:

| Field | Description |
|---|---|
| `group` | The built `THREE.Group`; add it to your scene (or any parent) yourself |
| `palette` | The unique states used: `{ id, properties, biome, models }` per entry, with the parsed model references. For tooling like hover info or collision, without re-parsing |
| `blockPalette` | `Uint32Array` mapping each input block index to its `palette` index |
| `templates` | With `keepTemplates`: the built template list, `{ palette, group }` per entry. `group` is the block-local geometry stamped at every position using it (a state can own several: one per variant pick, one per fluid shape); merged element meshes carry `userData.collision` boxes. `null` otherwise |
| `blockTemplate` | With `keepTemplates`: `Uint32Array` mapping each input block index to its `templates` index (`0xFFFFFFFF` where nothing was placed). `null` otherwise |
| `bounds` | `THREE.Box3` of the built geometry, for camera fitting |
| `light` | The [`computeSceneLight`](#scene-lighting) handle when world lighting ran, else `null`. If you reposition the group, call `light.setOffset(group.position)` so torchlight stays aligned |
| `drawCalls`, `tris` | Draw call and triangle counts from the optimize pass |
| `sortTranslucent(camera)` | Force a translucent sort now, before a single-frame capture |
| `dispose()` | Frees the geometry, materials, and atlas textures, and removes the group from its parent |

## `parseBlockstate(assets, id, args?)`

Resolves a blockstate to a list of model references, picking variants or multipart cases based on the given property values.

| Argument | Description |
|---|---|
| `assets` | The assets source |
| `id` | The blockstate id |
| `args.data` | Blockstate property values (e.g. `{ axis: "y", half: "top" }`) |
| `args.seed` | Seeded randomness for weighted blockstate variants: a number, and the same seed always picks the same variants. Omit to always take the first variant. The picks don't match the game's per-position randomness |
| `args.biome` | Biome tinting for the colormap tints: one `{ temperature, downfall, tint, combine, weight }` biome, or an array of them for a weighted blend. Same as [`renderBlock`](standard-api.md#renderblockargs) |
| `args.ignoreAtlases` | Skip texture atlas membership rules for the returned models |
| `args.version` | Minecraft version the assets are for. See [Legacy Minecraft versions](versions.md#legacy-minecraft-versions) |

Returns a list of model references, one per matching model.

Properties you don't pass fall back to the [default blockstates](extending.md#default-blockstates) rules, per property. Along the way it also applies the block's built-in behaviors: biome colormap, fixed, and property-indexed tints (grass, foliage, water, redstone wire, stems), the end portal / end gateway shader, fluid marking on water and lava, and the automatic water layer on waterloggable blocks given `{ waterlogged: true }` (always added for the inherently water-filled blocks, per [`isWaterlogged`](models.md#iswaterloggedid)). Air ids (`air`, `cave_air`, `void_air`) resolve to no models, as does `moving_piston`, the invisible placeholder the game uses while a piston moves a block.

## `parseItemDefinition(assets, id, args?)`

Resolves an item definition to a list of model references, walking conditions, selects, and range dispatch based on the given properties.

| Argument | Description |
|---|---|
| `assets` | The assets source |
| `id` | The item id |
| `args.data` | Item components used by the definition |
| `args.display` | Display context, used by `display_context` selects and tint color resolution |
| `args.ignoreAtlases` | Skip texture atlas membership rules for the returned models |
| `args.version` | Minecraft version the assets are for. See [Legacy Minecraft versions](versions.md#legacy-minecraft-versions) |

Returns a list of model references.

### Item definitions

The full item definition format is supported. What that means in practice:

* **Model types**: `model`, `composite`, `condition`, `select`, `range_dispatch`, `special`, and `bundle/selected_item`. Nested `transformation` fields compose down the tree
* **Special models** (`type: "special"`) render through the [bundled overrides](assets.md#bundled-packs): banners, chests, shulker boxes, heads and skulls, conduits, decorated pots, shields, tridents, copper golem statues, and the end portal cube. Runtime state like `openness`, `chest_type`, banner `color`, and statue `pose` is honored, as are `banner_patterns` (on both banners and shields) and a shield's `base_color`, each pattern layered in its dye color the way the game builds them
* **Select properties**: `custom_model_data` (strings), `component`, `block_state`, `charge`, `trim_material`, `display_context` (fed from `args.display`), `local_time` (formatted from the actual current time using the definition's pattern), plus any plain string property looked up in `args.data` by name, so future vanilla additions work without renderer updates
* **Condition properties**: `custom_model_data` (flags), `has_component`, and any plain boolean property in `args.data`
* **Tint sources**: `team`, `dye`, `map_color`, `potion` (with the vanilla effect color blending), `custom_model_data` (colors), `firework` (color averaging), `grass`/`foliage`/`dry_foliage` (sampled from the colormaps), and `constant`/`default` values

Component values take the same shape as in game data. Two conveniences: a bare number for `custom_model_data` acts as `{ floats: [n] }` (the pre-1.21.4 shorthand), and `dyed_color` accepts the `{ rgb }` wrapper form. A few pseudo-components stand in for runtime context the game would provide; see [Item components](extending.md#item-components).

## `resolveModelData(assets, model)`

Recursively resolves a model's `parent` chain, merging `textures`, `elements`, and other fields into a single flat model. `builtin/generated` item layers are converted into real geometry (the classic extruded item quads), with animated layer frames accounted for in the extrusion.

| Argument | Description |
|---|---|
| `assets` | The assets source |
| `model` | A model reference or inline model object |

Returns the resolved model object.

When the layer conversion happened, the resolved model carries `generated: true`, since afterwards the elements look like any other elements. A model that inherits `builtin/generated` but declares its own `elements` is not marked: like the game, its elements win and the generator never runs (the parent still contributes `gui_light: "front"`).

```js
const resolved = await resolveModelData(assets, { model: "minecraft:item/apple", type: "item" })
resolved.generated // true, and resolved.elements holds the extruded quads
```

## `makeModelScene()`

Creates a fresh three.js scene and orthographic camera configured for block rendering. Async in the browser, sync on Node.

Returns `{ scene, camera }`.

The returned camera has a `fitAspect = true` flag that tells [`renderModelScene`](#rendermodelscenescene-camera-args) to adjust the camera's frustum to match the output aspect ratio (so non-square renders aren't squished). Set the same property on your own camera (`camera.fitAspect = true`) if you want the same behavior. Works for both `OrthographicCamera` and `PerspectiveCamera`. Without the flag, the camera is left exactly as you configured it.

## `loadModel(scene, assets, model, args?)`

Builds a resolved model's geometry and materials as a three.js group. If `scene` is non-null, the group is also added to it; pass `null` to just get the group back without touching any scene.

Texture atlas rules are enforced here: if `model.type` is `"block"` or `"item"` and `model.ignore_atlas_restrictions` isn't set, the model is replaced with the missing-model placeholder when any face texture is in the wrong atlas. Set `model.ignore_atlas_restrictions = true` on the model to bypass.

| Argument | Description |
|---|---|
| `scene` | The three.js scene to add the model to, or `null` to skip adding it |
| `assets` | The assets source |
| `model` | A resolved model (from [`resolveModelData`](#resolvemodeldataassets-model)) |

The `args` object, grouped by what it affects. How the model looks:

| Option | Description |
|---|---|
| `args.display` | Display transform to apply to the model. See [Display transforms](models.md#display-transforms) |
| `args.lighting` | Lighting mode (`"item"` (default), `"world"`, `"scene"`, `"off"`), or a [world lighting config object](rendering.md#world-lighting) with the dimension, daytime, brightness, and `light` volume. With a `light` volume, faces sample per-block light, so torches glow and interiors darken |
| `args.emission` | Floor every element's light emission at this level (0-15), like a glow item frame's contents. When present it replaces the automatic block-level glow from `args.block`, so `0` disables it. See [Lighting modes](rendering.md#lighting-modes) |
| `args.shaderScale` | Density multiplier for screen-space shader effects, as in [`renderBlock`](standard-api.md#renderblockargs) |

Where the block sits:

| Option | Description |
|---|---|
| `args.cull` | Face directions to drop, as a `Set` from [`getCullFaces`](#getcullfacesargs) or a plain object like `{ north: true }`. Faces whose `cullface` points at a culled direction are skipped |
| `args.neighbors` | The surrounding blocks as a direction-keyed object (`north`, `north_east`, `up`, `self`, ...). Shapes fluid surfaces (see [Fluids](fluids.md)), and is merged into `args.block` as the placement context's `neighbors` for loaders |
| `args.fluidHeights` | Fluid models only: a precomputed [`fluidHeights`](fluids.md#fluidheightsassets-type-neighbors) result, reused instead of deriving it from `neighbors` again |
| `args.block` | Placement context (`{ id, properties }`) for [placement-aware model loaders](extending.md#placement-aware-models). Its `neighbors` are filled from `args.neighbors`, so don't set them here |

How the group is built:

| Option | Description |
|---|---|
| `args.animate` | Browser only. `false` disables the automatic animator (see [Animation](#animation-browser)); drive it yourself with [`createAnimator`](#animation-browser). Default `true` |
| `args.mergeElements` | `false` keeps one mesh per model element instead of merging them into shared geometry, for tooling that edits or inspects individual cubes (a model editor). More draw calls, and no per-element `userData.collision` boxes, since the merge pass is what produces those. Default `true` |
| `args.version` | Minecraft version the assets are for. Sets `model.version` if not already present. See [Legacy Minecraft versions](versions.md#legacy-minecraft-versions) |

Returns a `THREE.Group` containing the loaded model.

The group carries the resolved model it was built from as `userData.model`. This is the model after any missing-model swap, so it always describes what actually got built. Meshes that map to one element carry that element's JSON as `userData.element`, the same object as its entry in `userData.model.elements`. With `mergeElements: false` that's every mesh; with merging on, merged geometry no longer maps to individual elements, so only single-element models have it.

### Animation (browser)

In the browser, a model loaded with [`loadModel`](#loadmodelscene-assets-model-args) animates on its own. Its textures and the end portal shader advance every time the scene is drawn, driven off the page-global clock via `onBeforeRender`, so nothing per-frame is yours to do: if your app already has a render loop (as any interactive three.js scene does), the animation just plays. Only a one-off render freezes it, since a single draw captures a single frame.

For manual control (scrubbing, pausing, or driving from your own clock), pass `{ animate: false }` to [`loadModel`](#loadmodelscene-assets-model-args) and use [`createAnimator(root)`](#animation-browser). It scans the object once and `update(ms?)` advances everything animated in it (defaulting to the global clock); `animator.animated` is `false` if there's nothing to animate.

```js
import { loadModel, createAnimator } from "block-model-renderer"

// opt out of the automatic animator, then drive it yourself
const group = await loadModel(scene, assets, resolved, { animate: false })
const animator = createAnimator(group)

// scrub to a fixed moment (2s in) and render one frozen frame:
animator.update(2000)
renderer.render(scene, camera)

// or advance it from your own clock each frame:
function frame(nowMs) {
  requestAnimationFrame(frame)
  animator.update(nowMs)   // omit the argument to follow the global clock
  renderer.render(scene, camera)
}
requestAnimationFrame(frame)
```

## Dynamic models

Some blocks the game animates at runtime load as **dynamic models**: chests and shulker boxes (their lids), banners (their waving flag), and the enchanting table book. Their moving pieces are tagged as [`part`](extending.md#element-json) elements in the bundled models, so the loaded group keeps a named sub-group per part instead of merging it away, and all posing is transforms on those groups: no rebuilds, no new geometry. To find the dynamic models in a built scene, traverse for `userData.dynamic`.

The animation runs itself, off the same draw-driven hooks as [animated textures](#animation-browser):

* **Banners** wave their flag (pattern layers included) on the game's 5-second cycle, phase-offset per block position so a row of them doesn't wave in unison.
* **Bells** get a `.ring(direction?)` method on their group (`direction` is the side the bell was hit from, default `"north"`). The body swings with the game's decaying oscillation and settles after the game's 50 ticks.
* **Chests and shulker boxes** get `.open()` and `.close()` methods on their group. Each animates the lid over the game's 10 ticks (500ms) from wherever it currently is, so a `.close()` mid-open reverses smoothly, and the easing matches the game (chests `1 - (1 - t)³`, shulker boxes linear).
* **Enchanting books** play the full game animation automatically, with the rendering camera as the player: the book opens and tracks the camera within range, and drifts closed when it leaves. The activation range is `userData.range` on the book's group, in blocks (default `3`, the game's), read live so you can change it any time. Each book seeds its idle facing and bob phase from its position, so a room of them doesn't move in lockstep.

Nothing is yours to run per-frame: like texture animation, it advances whenever the scene draws. A single one-off render shows the load pose.

### `poseSpecial(root, pose)`

The manual setter, for driving a pose yourself. Calling it cancels the automatic movement: an in-flight `.open()`/`.close()` stops, and a book's or banner's auto animation turns off for good (that one is yours from then on).

| Argument | Description |
|---|---|
| `root` | A group whose `userData.dynamic` is set: [`loadModel`](#loadmodelscene-assets-model-args) output for a dynamic model, or any clone of one |
| `pose` | The pose values for that model kind (below). Omitted fields fall back to the rest pose |

The pose fields per kind (`root.userData.dynamic`):

| Kind | Pose | Description |
|---|---|---|
| `"banner"` | `{ phase }` | Where in the wave cycle the flag is, 0-1 (the game's cycle is 100 ticks) |
| `"bell"` | `{ ticks, direction }` | Ticks since the bell was rung (fractional for partial ticks) and the side it was hit from (`"north"`, `"south"`, `"east"`, `"west"`). No `direction` means at rest |
| `"chest"` | `{ openness }` | Opening progress 0-1, as the game's block entity tracks it. The lid renders through the game's `1 - (1 - t)³` easing internally |
| `"enchanting_book"` | `{ time, rot, open, flip }` | The game's `EnchantingTableBlockEntity` fields: `time` in ticks drives the hover bob and page ripple, `rot` is the facing angle in radians, `open` is 0-1, `flip` is the page-flip counter (fractional values mid-flip) |
| `"shulker_box"` | `{ openness }` | Opening progress 0-1: lifts the lid 8 voxels while twisting it 270°, linear like the game |

Models opt in with the `dynamic` and `part` [extension fields](extending.md#model-json), and [`loadModel`](#loadmodelscene-assets-model-args) applies the model's initial `pose` on build (a chest special's `openness` ends up there).

## `renderModelScene(scene, camera, args?)`

Renders a scene to an image buffer. Takes all the same output options as [`renderBlock`](standard-api.md#renderblockargs) / [`renderItem`](standard-api.md#renderitemargs) / [`renderModel`](standard-api.md#rendermodelargs).

| Argument | Description |
|---|---|
| `scene` | The three.js scene to render |
| `camera` | The camera to render from |
| `args` | The output options of [`renderBlock`](standard-api.md#renderblockargs), same as the [standard API](standard-api.md) on both platforms |

Returns an image buffer, or `{ buffer, format }` when `args.animated` is truthy. In the browser it returns a canvas or player instead, honoring the browser `canvas`/placement options.

Translucent faces in the scene are depth-sorted once against the given camera before rendering, so water behind glass draws correctly. For live scenes where the camera moves, see [`sortTranslucent`](#translucent-sorting).

## Culling hidden faces

Blocks in the world hide the faces pressed against their neighbors. To render a block the way it looks in place (no bottom face against the ground, no side faces against adjacent blocks), pass `neighbors` to [`renderBlock`](standard-api.md#renderblockargs):

```js
await renderBlock({
  id: "oak_stairs",
  blockstates: { facing: "east", half: "bottom" },
  neighbors: {
    down: "stone",                             // id string = that block, default state
    north: { id: "oak_slab", type: "bottom" }, // object = id + blockstate properties
    up: true,                                  // force-cull this side
    // omitted sides = air, nothing culled
  },
  assets,
})
```

The rules follow Minecraft's `shouldRenderFace`. A `cullface`-authored face is dropped when:

* the neighbor's shape fully covers it. This is state-aware, so two adjacent bottom slabs cull their touching sides but a top slab against a bottom slab doesn't
* the block self-culls against its own kind (glass against glass, water against water). Panes and bars follow the game's connection rule: vertically against their own kind, sideways only when both sides connect toward each other

And never against blocks the game flags as non-occluding (glass, leaves, powder snow), no matter how solid they look.

It's *near* game-accurate rather than exact: the game hardcodes each block's occlusion shape, while this library rasterizes it off the actual model geometry and texture opacity instead, since copying the game's full per-block shape table would be unsustainable. The non-occluders above (glass, leaves, and such) are the exception, since they can't be read off geometry, so those stay a small built-in id list, which packs can extend through [`culling.json`](extending.md#block-data-and-colors).

### `getCullFaces(args)`

The same logic as a standalone helper, for building your own scenes with [`loadModel`](#loadmodelscene-assets-model-args):

| Option | Default | Description |
|---|---|---|
| `id` | required | The block id |
| `assets` | required | The assets source |
| `blockstates` | `{}` | The block's blockstate property values |
| `neighbors` | | The surrounding blocks, as in [`renderBlock`](standard-api.md#renderblockargs) above |
| `version` | | Minecraft version, as in [`renderBlock`](standard-api.md#renderblockargs) |

Returns a `Set` of directions to drop (`"down"`, `"up"`, `"north"`, `"south"`, `"west"`, `"east"`). Pass it as the `cull` option to any render function or [`loadModel`](#loadmodelscene-assets-model-args); a plain object like `{ north: true }` works there too. Air ids return an empty set without touching the assets, and air neighbors count as absent.

```js
import { getCullFaces, loadModel } from "block-model-renderer"

const cull = await getCullFaces({
  id: "oak_stairs",
  blockstates: { facing: "east", half: "bottom" },
  neighbors: {
    down: { id: "oak_slab", type: "top" }, // neighbors take blockstates too
    up: "glass"
  },
  assets
})
// Set { "down" }: the top slab's full upper face covers it (a bottom slab wouldn't); glass up doesn't occlude
await loadModel(scene, assets, resolved, { cull })
```

A neighbor entry can also carry an explicit `occludes` boolean (`{ id: "stone", occludes: false }`, or just `{ occludes: true }`). That skips the model-based occlusion check entirely and uses your answer, with only the self-culling rule still applying on top. Useful when you've already computed occlusion yourself, or need to override a specific pairing.

Because occlusion comes from the models, modded blocks and custom packs just work. The models a call builds are cached for that call; with [`prepareAssets(assets, { cache: true })`](assets.md#caching) they're cached across calls too.

## Scene lighting

`"world"` lighting on its own shades every face as if it stood under open sky, with `daytime` scaling the whole scene evenly. [`computeSceneLight`](#scene-lighting) adds real per-block light: torches and other emitters glow, light falls off with distance and wraps around corners, and interiors and overhangs darken because the sky can't reach them. It runs Minecraft's flood fill over the scene's block grid and packs the result into a light volume texture the `"world"` shader samples per fragment, so the gradients are smooth and merged geometry from [`optimizeScene`](#scene-optimization) is lit correctly with no extra draw calls.

### `computeSceneLight(blocks, options)`

| Option | Default | Description |
|---|---|---|
| `blocks` | required | The scene's blocks, each `{ id, properties?, pos: [x, y, z] }` (`{ x, y, z }` fields work too). Cell coordinates, as in [`optimizeScene`](#scene-optimization) placements |
| `options.assets` | required | The assets source |
| `options.version` | | Minecraft version, as in [`renderBlock`](standard-api.md#renderblockargs) |
| `options.dimension` | `"overworld"` | The dimension, as in [world lighting](rendering.md#world-lighting): dimensions without sky light (the nether) skip the sky seeding, so their volumes carry block light only |
| `options.onProgress` | | `(done, total)` while the scene's blocks are processed, for progress bars. The flood fill after the last call is quick |

Pass the result to every [`loadModel`](#loadmodelscene-assets-model-args) call in the scene through the world lighting config:

```js
import { computeSceneLight, loadModel } from "block-model-renderer"

const blocks = [
  { id: "stone", pos: [0, 0, 0] },
  { id: "torch", pos: [0, 1, 0] }
]
const light = await computeSceneLight(blocks, { assets })
for (const block of blocks) {
  // build as usual, passing the same light to each block
  await loadModel(scene, assets, resolved, { lighting: { light } })
}
```

Light propagates accurately to the game: block light from emitters (via [`getLightEmission`](models.md#getlightemissionid-properties-resolvedefault)) and sky light from above, both spreading one level per block and blocked by the block shapes read from the models, so a slab roof shadows the room while light wraps through the open half. Opacity comes from those models alone, so the game's few hardcoded exceptions (leaves, slime, tinted glass) aren't applied.

Shading uses the vanilla lightmap: the dimension's ambient floor, sky and block light adding on top, the warm torchlight tint, and the brightness setting (all [configurable](rendering.md#world-lighting)). In the overworld at the default full-bright `noon` most of the scene reads as lit, so emitters mainly show indoors; use a darker `daytime` (or the nether or end) to see them everywhere.

The result:

| Field | Description |
|---|---|
| `origin`, `size` | The volume's min cell corner and dimensions in cells (the scene bounds plus a one-cell border) |
| `blockLight`, `skyLight` | The raw levels (0-15), one `Uint8Array` cell each, x fastest then y then z |
| `lightAt(x, y, z)` | `{ block, sky }` levels at a cell, for your own use |
| `setOffset(position)` | Call with the world offset you move the built scene by (a `Vector3`, array, or `x, y, z` numbers), e.g. the centering translation on [`optimizeScene`](#scene-optimization)'s group, so the shader keeps sampling the right cells. Rotation and scaling aren't supported |
| `dispose()` | Frees the light texture. Call it when you discard the scene |

The volume uploads as a single 2D texture of stacked slices with trilinear filtering done in the shader, so it behaves identically on the web and on Node's WebGL1 context. Lighting is static: it's computed once from the block list, so moving or removing emitters means computing a fresh volume and rebuilding the scene.

## Scene optimization

Building a world out of per-block [`loadModel`](#loadmodelscene-assets-model-args) groups works, but every block is its own meshes and draw calls. [`optimizeScene`](#scene-optimization) merges the whole scene into a handful of draw calls, with far fewer polygons, so a wall of different blocks becomes roughly one draw call:

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

Each placement is `{ pos, group, cull }`: `pos` is the block's `[x, y, z]` cell coordinate (16 units per cell), `group` is [`loadModel`](#loadmodelscene-assets-model-args) output, and `cull` is an optional `Set` of face directions hidden at that placement (from [`getCullFaces`](#getcullfacesargs)). Above, the two stone blocks cull their touching faces and the log culls its underside, so those faces never reach the merged mesh.

Share one `group` reference across placements of the same block state, as `groupFor` caches here; it's classified once and instanced per placement. That sharing is why `cull` lives on the placement rather than being baked in at [`loadModel`](#loadmodelscene-assets-model-args) time.

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

Animated textures (water, lava, fire) stay live in the merged output and keep playing through [`createAnimator`](#animation-browser) or the automatic animator. [Dynamic models](#dynamic-models) (chests, shulker boxes, the enchanting book) keep their moving pieces live: static cubes (a chest's base) merge like any other geometry, while `part` elements stay as a per-placement clone in the output group, so books keep animating and each placement's `.open()`/`.close()` and [`poseSpecial`](#posespecialroot-pose) keep working.

Every material the library creates (merged or per-model) compiles with clipping support, so three.js clipping planes work as with any standard material: assign `renderer.clippingPlanes` globally, or enable `renderer.localClippingEnabled` and set `clippingPlanes` per material.

### Translucent sorting

Translucent faces (water, stained glass, ice) blend, and blending is order dependent: they must draw far-to-near or things behind show through things in front. The render functions handle this automatically against their fixed camera. [`optimizeScene`](#scene-optimization) attaches a movement-gated sorter to its merged translucent meshes: whenever the live camera has moved `resortDistance` units (default 16, one block) since a mesh last sorted, its triangles re-sort far-to-near, budgeted to one mesh per frame.

For your own live scenes (a model viewer orbiting a [`loadModel`](#loadmodelscene-assets-model-args) group), attach the same behavior manually:

```js
import { sortTranslucent } from "block-model-renderer"

const handle = sortTranslucent(modelGroup, { resortDistance: 16 })
handle.sort(camera) // force a sort now (before a one-frame capture)
handle.detach()     // stop sorting (when discarding the scene)
```

It traverses the object, hooks every mesh with translucent materials, and needs nothing per-frame from you: the renderer hands it the camera on draw.

## Helpers

The model-inspection helpers and tint tables live in [Models](models.md): [`isWaterloggable`](models.md#iswaterloggableid), [`isWaterlogged`](models.md#iswaterloggedid), [`isCrossModel`](models.md#iscrossmodelmodels), [`getLightEmission`](models.md#getlightemissionid-properties-resolvedefault), and [`COLORS`](models.md#colors).
