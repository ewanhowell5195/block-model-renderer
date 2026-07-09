# Building scenes

For custom rendering pipelines, lower-level functions are available. The typical flow: parse a blockstate or item definition into model references, resolve each reference into a flat model, load it into a scene, render the scene.

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

## `parseBlockstate(assets, id, args?)`

Resolves a blockstate to a list of model references, picking variants or multipart cases based on the given property values.

| Argument | Description |
|---|---|
| `assets` | The assets source |
| `id` | The blockstate id |
| `args.data` | Blockstate property values (e.g. `{ axis: "y", half: "top" }`) |
| `args.ignoreAtlases` | Skip texture atlas membership rules for the returned models |
| `args.version` | Minecraft version the assets are for. See [Legacy Minecraft versions](rendering.md#legacy-minecraft-versions) |

Returns a list of model references, one per matching model.

Properties you don't pass fall back to the [default blockstates](extending.md#default-blockstates) rules, per property. Along the way it also applies the block's built-in behaviours: biome colormap, fixed, and property-indexed tints (grass, foliage, water, redstone wire, stems), the end portal / end gateway shader, fluid marking on water and lava, and the automatic water layer on waterloggable blocks given `{ waterlogged: true }`.

## `parseItemDefinition(assets, id, args?)`

Resolves an item definition to a list of model references, walking conditions, selects, and range dispatch based on the given properties.

| Argument | Description |
|---|---|
| `assets` | The assets source |
| `id` | The item id |
| `args.data` | Item components used by the definition |
| `args.display` | Display context, used by `display_context` selects and tint colour resolution |
| `args.ignoreAtlases` | Skip texture atlas membership rules for the returned models |
| `args.version` | Minecraft version the assets are for. See [Legacy Minecraft versions](rendering.md#legacy-minecraft-versions) |

Returns a list of model references.

### Item definitions

The full item definition format is supported. What that means in practice:

* **Model types**: `model`, `composite`, `condition`, `select`, `range_dispatch`, `special`, and `bundle/selected_item`. Nested `transformation` fields compose down the tree
* **Special models** (`type: "special"`) render through the [bundled overrides](assets.md#bundled-packs): banners, chests, shulker boxes, heads and skulls, conduits, decorated pots, shields, tridents, copper golem statues, and the end portal cube. Runtime state like `openness`, `chest_type`, banner `color`, and statue `pose` is honoured
* **Select properties**: `custom_model_data` (strings), `component`, `block_state`, `charge`, `trim_material`, `display_context` (fed from `args.display`), `local_time` (formatted from the actual current time using the definition's pattern), plus any plain string property looked up in `args.data` by name, so future vanilla additions work without renderer updates
* **Condition properties**: `custom_model_data` (flags), `has_component`, and any plain boolean property in `args.data`
* **Tint sources**: `team`, `dye`, `map_color`, `potion` (with the vanilla effect colour blending), `custom_model_data` (colors), `firework` (colour averaging), `grass`/`foliage`/`dry_foliage` (sampled from the colormaps), and `constant`/`default` values

Component values take the same shape as in game data. Two conveniences: a bare number for `custom_model_data` acts as `{ floats: [n] }` (the pre-1.21.4 shorthand), and `dyed_color` accepts the `{ rgb }` wrapper form. A few pseudo-components stand in for runtime context the game would provide; see [Item components](extending.md#item-components).

## `resolveModelData(assets, model)`

Recursively resolves a model's `parent` chain, merging `textures`, `elements`, and other fields into a single flat model. `builtin/generated` item layers are converted into real geometry (the classic extruded item quads), with animated layer frames accounted for in the extrusion.

| Argument | Description |
|---|---|
| `assets` | The assets source |
| `model` | A model reference or inline model object |

Returns the resolved model object.

## `makeModelScene()`

Creates a fresh three.js scene and orthographic camera configured for block rendering. Async on web, sync on Node.

Returns `{ scene, camera }`.

The returned camera has a `fitAspect = true` flag that tells `renderModelScene` to adjust the camera's frustum to match the output aspect ratio (so non-square renders aren't squished). Set the same property on your own camera (`camera.fitAspect = true`) if you want the same behavior. Works for both `OrthographicCamera` and `PerspectiveCamera`. Without the flag, the camera is left exactly as you configured it.

## `loadModel(scene, assets, model, args?)`

Builds a resolved model's geometry and materials as a three.js group. If `scene` is non-null, the group is also added to it; pass `null` to just get the group back without touching any scene.

Texture atlas rules are enforced here: if `model.type` is `"block"` or `"item"` and `model.ignore_atlas_restrictions` isn't set, the model is replaced with the missing-model placeholder when any face texture is in the wrong atlas. Set `model.ignore_atlas_restrictions = true` on the model to bypass.

| Argument | Description |
|---|---|
| `scene` | The three.js scene to add the model to, or `null` to skip adding it |
| `assets` | The assets source |
| `model` | A resolved model (from `resolveModelData`) |
| `args.display` | Display transform to apply to the model |
| `args.lighting` | Lighting mode (`"item"` (default), `"world"`, `"scene"`, `"off"`). See [Lighting modes](#lighting-modes) |
| `args.shaderScale` | Density multiplier for screen-space shader effects, as in `renderBlock` |
| `args.cull` | Face directions to drop, as a `Set` from [`getCullFaces`](rendering.md#getcullfacesargs) or a plain object like `{ north: true }`. Faces whose `cullface` points at a culled direction are skipped |
| `args.neighbors` | Fluid models only: the surrounding blocks as a direction-keyed object (`north`, `north_east`, `up`, `self`, ...), used to shape the surface. See [Fluids](fluids.md) |
| `args.fluidHeights` | Fluid models only: a precomputed [`fluidHeights`](fluids.md#fluidheightsassets-type-neighbors) result, reused instead of deriving it from `neighbors` again |
| `args.block` | Placement context (`{ id, properties, neighbors }`) for [placement-aware model loaders](extending.md#placement-aware-models) |
| `args.animate` | Web only. `false` disables the automatic animator (see [Animation](#animation-web)); drive it yourself with `createAnimator`. Default `true` |
| `args.version` | Minecraft version the assets are for. Sets `model.version` if not already present. See [Legacy Minecraft versions](rendering.md#legacy-minecraft-versions) |

Returns a `THREE.Group` containing the loaded model.

### Lighting modes

`args.lighting` picks how faces are shaded:

| Value | Material | Behaviour |
|---|---|---|
| `"item"` (default) | custom shader | The built-in Minecraft item shading, picking the flat (gui) or 3d (inventory) light config from the model's `gui_light` like vanilla. Lights are world-fixed, so faces stay consistently lit as the camera orbits. Matches the snapshot renderers |
| `"world"` | custom shader | Minecraft's in-world daytime face shading: a flat per-face constant from the world-space normal (up 1.0, down 0.5, north/south 0.8, west/east 0.6). The right mode for blocks placed in world orientation, like structures and dioramas |
| `"scene"` | `MeshStandardMaterial` | Reacts to lights you add to the scene (`roughness: 1`, `metalness: 0`, cutout `alphaTest`, sRGB texture). Renders black until you add lights |
| `"off"` | `MeshBasicMaterial` | Unlit and flat: the texture at full brightness, ignoring all lighting |

Tints are baked into the textures in every mode, and the end portal keeps its own emissive shader.

The model element fields `shade: false` (legacy) and `shade_direction_override` only apply in `"world"` mode, mirroring vanilla, where they only exist in the in-world block pipeline: an unshaded element uses the up-face 1.0 constant, an override uses its direction's constant. Item mode ignores both and lights every element from its real face normals, like holding the block in hand.

```js
const group = new THREE.Group()
for (const model of await parseBlockstate(assets, "stone")) {
  await loadModel(group, assets, await resolveModelData(assets, model), { lighting: "scene" })
}
scene.add(group)
scene.add(new THREE.AmbientLight(0xffffff, 0.6))
scene.add(new THREE.DirectionalLight(0xffffff, 1))
```

### Animation (web)

On web, a model loaded with `loadModel` animates automatically: its textures and the end portal shader advance whenever you render it, driven off the page-global clock via `onBeforeRender`. Just render your scene each frame, with no per-frame call:

```js
import { loadModel } from "block-model-renderer"

// group built via loadModel, animates on its own
function frame() {
  requestAnimationFrame(frame)
  renderer.render(scene, camera)
}
frame()
```

For manual control (scrubbing, pausing, or driving from your own clock), pass `{ animate: false }` to `loadModel` and use `createAnimator(root)`. It scans the object once and `update(ms?)` advances everything animated in it (defaulting to the global clock); `animator.animated` is `false` if there's nothing to animate.

## `renderModelScene(scene, camera, args?)`

Renders a scene to an image buffer. Takes all the same output options as `renderBlock` / `renderItem` / `renderModel`.

| Argument | Description |
|---|---|
| `scene` | The three.js scene to render |
| `camera` | The camera to render from |
| `args` | `path`, `format`, `output`, `width`, `height`, `animated`, `animatedWidth`, `animatedHeight`, `animatedOutput`, `maxAnimationFrames`, `background`, same as [`renderBlock`](../README.md#renderblockargs) |

Returns an image buffer, or `{ buffer, format }` when `args.animated` is truthy. On web it returns a canvas or player instead, honouring the web `canvas`/placement options.

Translucent faces in the scene are depth-sorted once against the given camera before rendering, so water behind glass draws correctly. For live scenes where the camera moves, see [`sortTranslucent`](#translucent-sorting).

## Scene optimisation

Building a world out of per-block `loadModel` groups works, but every block is its own meshes and draw calls. `optimiseScene` merges placed blocks into a few atlased, greedily meshed groups, so a wall of different blocks becomes roughly one draw call:

```js
import { optimiseScene } from "block-model-renderer"

const scene = await optimiseScene(placements, options)
threeScene.add(scene.group)
```

Each placement is `{ pos, group, cull }`: `pos` is the block's `[x, y, z]` cell coordinate (16 units per cell), `group` is `loadModel` output, and `cull` is an optional `Set` of face directions hidden at that placement (from [`getCullFaces`](rendering.md#getcullfacesargs)). Share one `group` reference across placements of the same block state; it's classified once and instanced per placement.

Options: `maxAtlas` overrides the atlas size ceiling (auto-detected from the canvas and GPU limits), `translucency` sets the pixel cutoffs for textures that didn't come from the asset pipeline, `resortDistance` tunes translucent re-sorting (below), and `onProgress(done, total)` / `shouldCancel()` support long builds (cancelling resolves `null`).

The result:

| Field | Description |
|---|---|
| `group` | The merged `THREE.Group` to add to your scene |
| `drawCalls`, `tris` | Stats for the merged output |
| `atlasTextures` | The atlas textures the call built (already applied to the merged materials) |
| `sortTranslucent(camera)` | Force a translucent sort now, before a single-frame capture |
| `dispose()` | Frees everything the call created (merged geometry, atlas textures, cloned materials). Must be called when you discard or replace the scene; GPU resources don't garbage collect. Textures from the assets bundle are untouched; those belong to [`disposeCache`](assets.md#caching) |

Animated textures (water, lava, fire) stay live in the merged output and keep playing through [`createAnimator`](#animation-web) or the automatic animator.

### Translucent sorting

Translucent faces (water, stained glass, ice) blend, and blending is order dependent: they must draw far-to-near or things behind show through things in front. The render functions handle this automatically against their fixed camera. `optimiseScene` attaches a movement-gated sorter to its merged translucent meshes: whenever the live camera has moved `resortDistance` units (default 16, one block) since a mesh last sorted, its triangles re-sort far-to-near, budgeted to one mesh per frame.

For your own live scenes (a model viewer orbiting a `loadModel` group), attach the same behaviour manually:

```js
import { sortTranslucent } from "block-model-renderer"

const handle = sortTranslucent(modelGroup, { resortDistance: 16 })
handle.sort(camera) // force a sort now (before a one-frame capture)
handle.detach()     // stop sorting (when discarding the scene)
```

It traverses the object, hooks every mesh with translucent materials, and needs nothing per-frame from you: the renderer hands it the camera on draw.

## Helpers

### `isWaterloggable(id)`

Checks whether the renderer recognises a block id as waterloggable. When `true`, passing `{ waterlogged: true }` in the blockstate properties to `renderBlock` or `parseBlockstate` will add a water layer to the returned model. When `false`, the `waterlogged` property has no effect.

| Argument | Description |
|---|---|
| `id` | The block id (e.g. `"oak_stairs"`, `"minecraft:lantern"`). Namespace optional |

Returns `true` if the block is waterloggable, `false` otherwise.

```js
import { isWaterloggable } from "block-model-renderer"

isWaterloggable("oak_stairs") // true
isWaterloggable("stone")      // false
```

### `isCrossModel(models)`

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

### `COLOURS`

The colour tables the renderer tints with, exported as one object for lookups in your own tooling (or careful tweaking; it's the live data):

| Key | Contents |
|---|---|
| `colormap` | Which blocks sample the `grass`, `foliage`, and `dry_foliage` colormaps |
| `fixed` | Hardcoded block tints (water, birch/spruce leaves, lily pads, attached stems) |
| `indexed` | Property-indexed tint ramps (stem `age`, redstone wire `power`) |
| `tintindex` | Blocks whose colormap tint applies to a non-zero `tintindex` |
| `dye` | The 16 dye colours as hex strings |
| `effects` | Potion effect colours |
| `potions` | Potion id to effect list, for the blended potion tint |
| `team` | Team colours used by the `team` tint source |

```js
import { COLOURS } from "block-model-renderer"

COLOURS.dye.light_blue // "#3ab3da"
```
