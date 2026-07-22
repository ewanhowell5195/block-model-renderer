# Building scenes

For custom rendering pipelines, lower-level functions are available. The typical flow: parse a blockstate or item definition into model references, resolve each reference into a flat model, load it into a scene, render the scene. For whole block scenes there's [`createScene`](#createsceneassets-blocks-args), which runs the entire pipeline in one call. Two parts of that pipeline have their own docs: [culling](culling.md) (hidden faces, occlusion) and [scene optimization](optimization.md) (merging, lighting volumes, translucent sorting, worker builds).

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
| `nbt` | Block entity data rendered into the scene: an item frame's held item, a shelf's contents, or a banner's patterns, same shape as [`renderBlock`](standard-api.md#renderblockargs)'s `nbt`. Entries with the same id, properties, and nbt share one template |
| `overlay` | `true` renders the entry without occupying its cell: no face culling in either direction and no light volume contribution, and other blocks (or more overlays) can share the position. Item frames are the intended use, matching their entity nature in game |
| `context` | `true` makes the entry participate without rendering: it culls neighbor faces, shapes fluid surfaces, and feeds the light volume, but emits no geometry. Use it to border a partial build (a chunk tile) with its surroundings so the edges come out right |

Options, grouped by what they affect. How the scene looks:

| Option | Default | Description |
|---|---|---|
| `biome` | | Scene-wide biome tinting; a block's own `biome` overrides it |
| `lighting` | `"world"` | Lighting mode (`"item"`, `"world"`, `"scene"`, `"off"`), or a [world lighting config object](rendering.md#world-lighting): dimension, daytime, brightness, and `light`. World mode computes the light volume from the blocks automatically (respecting the dimension's `hasSkyLight`); set `lighting: { light }` to reuse an existing [`computeSceneLight`](optimization.md#scene-lighting) handle (it stays yours to dispose), or `{ light: false }` to skip the volume entirely |
| `shaderScale` | `1` | Screen-space shader density (the end portal), as in [`renderBlock`](standard-api.md#renderblockargs) |
| `technical` | `false` | Build the [technical blocks](models.md#skip_blocks-and-technical_blocks) (barrier, light, structure void) with their placeholder icons. Off, they're invisible like in game, but still feed the light volume, so a light block lights its area either way |
| `mapArt` | | Map art callback for framed maps, as on [`renderBlock`](standard-api.md#renderblockargs). See [Map art](#map-art) |

Asset interpretation:

| Option | Default | Description |
|---|---|---|
| `version` | | Minecraft version the assets are for. See [Legacy Minecraft versions](versions.md#legacy-minecraft-versions) |
| `ignoreAtlases` | `false` | Skip texture atlas membership rules |

The optimize pass:

| Option | Default | Description |
|---|---|---|
| `optimize` | `true` | Merge the built scene with [`optimizeScene`](optimization.md#scene-optimization). `false` keeps one group clone per block, which renders far slower on big scenes but leaves every block individually addressable |
| `resortDistance`, `maxAtlas`, `translucency` | | Passed through to the optimize pass |
| `sharedAtlas` | | A [`createSharedAtlas`](optimization.md#packed-scenes-and-shared-atlases) handle. Textures pack into its pages (shared across every scene using the handle) instead of per-scene atlases; the handle owns the pages and outlives each scene |

The build itself:

| Option | Default | Description |
|---|---|---|
| `onProgress` | | `(stage, done, total)` progress callback, see below |
| `shouldCancel` | | Checked between work slices; return `true` to abort. A cancelled `createScene` resolves `null` |
| `animate` | `true` | Browser: auto-play texture animations, like [`loadModel`](#loadmodelscene-assets-model-args). On Node, animated output goes through [`renderModelScene`](#rendermodelscenescene-camera-args) as usual |
| `keepTemplates` | `false` | Retain the internal per-state template groups and return them on the handle, for tooling that needs per-block geometry (collision, hit-testing). Holds their memory for the scene's lifetime |
| `externalOcclusion` | | `(x, y, z) => boolean` over cell coordinates outside `blocks`. Return `true` to treat that absent cell as a full occluder, so faces pressed against it cull. For building a chunk of a larger world where the surroundings exist but aren't in this scene (the culled faces stay culled; nothing re-lights) |

Weighted blockstate variants pick deterministically per position (the position seeds the pick), so a field of grass blocks gets a natural rotation spread like in game, though not the game's exact per-position picks. Block entity contents and sign text are out of scope.

### Progress stages

`onProgress(stage, done, total)` reports per stage. `stage` is `{ index, count, name }`: `index` counts from 0, `count` is fixed for the whole call (computed up front from the options), and `done`/`total` are monotonic within the stage. An overall bar can use `(stage.index + done / total) / stage.count`.

| Name | Present | Work |
|---|---|---|
| `"parse"` | always | Blockstate parsing, variant picks, culling, fluid shapes |
| `"light"` | `lighting: "world"` only (the default) | Flood-filling the light volume |
| `"build"` | always | Building geometry |
| `"optimize"` | `optimize: true` | Merging the scene; [`optimizeScene`](optimization.md#scene-optimization)'s own progress passes through |

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
| `light` | The [`computeSceneLight`](optimization.md#scene-lighting) handle when world lighting ran, else `null`. If you reposition the group, call `light.setOffset(group.position)` so torchlight stays aligned |
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
* **Enchantment glint**: items that shimmer in game render with the animated glint overlay: anything with a non-empty `enchantments` component (or legacy `Enchantments` nbt on frame and shelf items), the always-glinting items (extracted from the game into `items.json`, extendable by packs like the other [block data files](extending.md#block-data-and-colors)), and a compass with a `lodestone_tracker`. An explicit `enchantment_glint_override` component wins both ways: `true` forces the glint, `false` removes it. The pattern comes from `minecraft/textures/misc/enchanted_glint_item.png` (resource packs can override it; a vanilla fallback is bundled)

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
| `args.cull` | Face directions to drop, as a `Set` from [`getCullFaces`](culling.md#getcullfacesargs) or a plain object like `{ north: true }`. Faces whose `cullface` points at a culled direction are skipped |
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

Some blocks the game animates at runtime load as **dynamic models**: banners, bells, chests, decorated pots, the enchanting table book, and shulker boxes (the kinds and their part names are tabled in [Extending](extending.md#dynamic-models)). Their moving pieces are tagged as [`part`](extending.md#element-json) elements in the bundled models, so the loaded group keeps a named sub-group per part instead of merging it away, and all posing is transforms on those groups: no rebuilds, no new geometry. To find the dynamic models in a built scene, traverse for `userData.dynamic`.

The animation runs itself, off the same draw-driven hooks as [animated textures](#animation-browser):

* **Banners** wave their flag (pattern layers included) on the game's 5-second cycle, phase-offset per block position so a row of them doesn't wave in unison.
* **Bells** get a `.ring(direction?)` method on their group (`direction` is the side the bell was hit from, default `"north"`). The body swings with the game's decaying oscillation and settles after the game's 50 ticks.
* **Chests and shulker boxes** get `.open()` and `.close()` methods on their group. Each animates the lid over the game's 10 ticks (500ms) from wherever it currently is, so a `.close()` mid-open reverses smoothly, and the easing matches the game (chests `1 - (1 - t)³`, shulker boxes linear).
* **Decorated pots** get a `.wobble(style?)` method on their group: `"positive"` plays the game's happy tilt (7 ticks), `"negative"` the refusal shake (10 ticks). Default `"positive"`.
* **Dragon and piglin heads** rendered with `powered: true` animate continuously (the dragon's jaw chatters, the piglin's ears flap), phase-offset per block position. Unpowered heads stay still.
* **Enchanting books** play the full game animation automatically, with the rendering camera as the player: the book opens and tracks the camera within range, and drifts closed when it leaves. The activation range is `userData.range` on the book's group, in blocks (default `3`, the game's), read live so you can change it any time. Each book seeds its idle facing and bob phase from its position, so a room of them doesn't move in lockstep.

Nothing is yours to run per-frame: like texture animation, it advances whenever the scene draws. A single one-off render shows the load pose.

### `poseSpecial(root, pose)`

The manual setter, for driving a pose yourself. Calling it cancels the automatic movement: an in-flight `.open()`/`.close()`, `.ring()`, or `.wobble()` stops, and a book's or banner's auto animation turns off for good (that one is yours from then on).

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
| `"decorated_pot"` | `{ style, progress }` | A wobble (`"positive"` or `"negative"`) at `progress` 0-1 through its run. No `style` means at rest |
| `"dragon_head"` | `{ openness }` | How open the jaw is, 0-1 |
| `"enchanting_book"` | `{ time, rot, open, flip }` | The game's `EnchantingTableBlockEntity` fields: `time` in ticks drives the hover bob and page ripple, `rot` is the facing angle in radians, `open` is 0-1, `flip` is the page-flip counter (fractional values mid-flip) |
| `"piglin_head"` | `{ left, right }` | How far each ear is raised, 0-1 (0 is the resting droop) |
| `"shulker_box"` | `{ openness }` | Opening progress 0-1: lifts the lid 8 voxels while twisting it 270°, linear like the game |

Models opt in with the `dynamic` and `part` [extension fields](extending.md#dynamic-models), and [`loadModel`](#loadmodelscene-assets-model-args) applies the model's initial `pose` on build (a chest special's `openness` ends up there).

## `renderModelScene(scene, camera, args?)`

Renders a scene to an image buffer. Takes all the same output options as [`renderBlock`](standard-api.md#renderblockargs) / [`renderItem`](standard-api.md#renderitemargs) / [`renderModel`](standard-api.md#rendermodelargs).

| Argument | Description |
|---|---|
| `scene` | The three.js scene to render |
| `camera` | The camera to render from |
| `args` | The output options of [`renderBlock`](standard-api.md#renderblockargs), same as the [standard API](standard-api.md) on both platforms |

Returns an image buffer, or `{ buffer, format }` when `args.animated` is truthy. In the browser it returns a canvas or player instead, honoring the browser `canvas`/placement options.

Translucent faces in the scene are depth-sorted once against the given camera before rendering, so water behind glass draws correctly. For live scenes where the camera moves, see [`sortTranslucent`](optimization.md#translucent-sorting).

## Map art

Helpers behind the [`mapArt`](#createsceneassets-blocks-args) callback, exported for standalone use:

| Export | Description |
|---|---|
| `renderMapColors(assets, colors)` | Renders 16384 map color bytes through the vanilla map palette over `map_background.png`, returning a 128×128 canvas. `colors` is the `colors` array from a save's `map_<id>.dat`, or one you build yourself (below) |
| `MAP_COLORS` | The vanilla palette: `{ base, shade, names }`, where a color byte resolves as `base[byte >> 2]` (an `[r, g, b]`, index 0 unset) scaled by `shade[byte & 3] / 255`. `names` labels each base index with the game's map color name (`names[34]` is `"podzol"`, `names[12]` is `"water"`) |
| `mapIdOf(item)` | The map id from an item's `minecraft:map_id` component (or legacy `tag.map`), `null` when absent |
| `disposeMapArt(assets)` | Clears the cached map art canvases. Call when the world the maps came from is no longer the source of truth |

Real maps live in the world save as `data/map_<id>.dat` (gzipped NBT), with the pixel bytes in the `data.colors` field. The library doesn't read world saves, so the callback bridges the two: look the id up however you read the world, and hand the bytes to `renderMapColors`:

```js
const handle = await createScene(assets, blocks, {
  mapArt: async id => {
    const nbt = await readWorldNbt(`data/map_${id}.dat`) // however you read the save
    return nbt ? renderMapColors(assets, nbt.data.colors) : null
  }
})
```

Returning nothing (an unknown id, no world open) renders the frame holding the `filled_map` item instead.

The bytes can also be built by hand: one per pixel, where the pixel at `(x, y)` (from the top-left) is `colors[x + y * 128] = color * 4 + shade`, with `color` a `MAP_COLORS.base` index and `shade` a brightness step 0-3:

```js
const colors = new Uint8Array(16384) // every pixel starts unset, showing the parchment

const grass = MAP_COLORS.names.indexOf("grass")
const water = MAP_COLORS.names.indexOf("water")
colors[64 + 64 * 128] = grass * 4 + 2 // (64, 64): full strength
colors[65 + 64 * 128] = water * 4 + 2 // (65, 64): full strength
colors[64 + 65 * 128] = water * 4 + 0 // (64, 65): darkest step

const art = await renderMapColors(assets, colors)
```

## Helpers

The model-inspection helpers and tint tables live in [Models](models.md): [`isWaterloggable`](models.md#iswaterloggableid), [`isWaterlogged`](models.md#iswaterloggedid), [`isCrossModel`](models.md#iscrossmodelmodels), [`getLightEmission`](models.md#getlightemissionid-properties-resolvedefault), and [`COLORS`](models.md#colors).
