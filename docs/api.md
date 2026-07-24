# API reference

Every export the package provides, grouped by area, with a link to where each is documented in full. The import is the same on Node and in the browser (`import { ... } from "block-model-renderer"`) except for the [browser-only](#browser-only) exports at the bottom.

```js
import {
  // rendering
  renderBlock, renderItem, renderModel, renderTexture, getCullFaces, fullyOccludes,
  exportOcclusionCache, importOcclusionCache,
  // assets and files
  prepareAssets, readFile, listDirectory, readTexture, zipAssets, zipAssetsFromSlices, parseZip, disposeCache,
  // model data
  parseBlockstate, parseItemDefinition, resolveModelData,
  // scenes
  makeModelScene, createScene, loadModel, poseSpecial, renderModelScene, optimizeScene, sortTranslucent,
  computeSceneLight, renderMapColors, disposeMapArt, mapIdOf, MAP_COLORS,
  // shared atlases, packing, animation
  createSharedAtlas, stitchSharedAtlas, exportSharedAtlasLayout, adoptSharedAtlasLayout, insertSharedTextures,
  packScene, reviveScene, setAnimationRenderer, collectAnimated, buildSchedules, evaluateAnimation,
  // fluids
  fluidTypeOf, fluidHeights,
  // helpers and data
  isWaterloggable, isWaterlogged, isFlatModel, getLightEmission, getBiomeTint, COLORS, DISPLAYS, LIGHT_DIMENSIONS, SKIP_BLOCKS, TECHNICAL_BLOCKS,
  // extending
  ModelLoader,
  // browser only
  configure, getThree, THREE, pauseAnimations, resumeAnimations, createAnimator,
  packAtlasDelta, createAtlasMirror
} from "block-model-renderer"
```

## Rendering

| Export | Description |
|---|---|
| `renderBlock(args)` | Render a block state by id. [Details](standard-api.md#renderblockargs) |
| `renderItem(args)` | Render an item by id. [Details](standard-api.md#renderitemargs) |
| `renderModel(args)` | Render a raw model JSON. [Details](standard-api.md#rendermodelargs) |
| `renderTexture(args)` | Render a texture by path, animated per its mcmeta. [Details](standard-api.md#rendertextureargs) |
| `getCullFaces(args)` | Which faces a block's neighbors hide, for [culling](culling.md#culling-hidden-faces). [Details](culling.md#getcullfacesargs) |
| `fullyOccludes(args)` | Whether a block state is a full occluding cube, for world-scale preprocessing. [Details](culling.md#fullyoccludesargs) |
| `exportOcclusionCache(assets)` | Serialize the computed occlusion masks for persistence. [Details](culling.md#persisting-the-occlusion-cache) |
| `importOcclusionCache(assets, entries)` | Seed a prepared assets instance with persisted masks. [Details](culling.md#persisting-the-occlusion-cache) |

## Assets and files

| Export | Description |
|---|---|
| `prepareAssets(assets, options?)` | Normalize asset sources once for reuse. [Details](assets.md#prepareassetsassets-options) |
| `readFile(path, assets, hint?)` | Read one file from a set of asset sources. [Details](assets.md#readfilepath-assets-hint) |
| `listDirectory(dir, assets)` | List a directory across layered sources. [Details](assets.md#listdirectorydir-assets) |
| `readTexture(path, assets, opts?)` | Read a texture as ready-to-draw frames. [Details](assets.md#readtexturepath-assets-opts) |
| `zipAssets(input)` | Wrap a zip (bytes, `Blob`, or `File`) as an asset source. [Details](assets.md#zipassetsinput) |
| `zipAssetsFromSlices(slice, size)` | Wrap a zip read on demand through a slice callback, for huge files. [Details](assets.md#zipassetsfromslicesslice-size) |
| `parseZip(bytes)` | Parse a zip into its entries. [Details](assets.md#parsezipbytes) |
| `disposeCache(assets)` | Free textures and GPU data cached on prepared assets. [Details](assets.md#caching) |

## Model data

| Export | Description |
|---|---|
| `parseBlockstate(assets, id, args?)` | Resolve a blockstate to its chosen model(s). [Details](scenes.md#parseblockstateassets-id-args) |
| `parseItemDefinition(assets, id, args?)` | Resolve an item definition to its chosen model(s). [Details](scenes.md#parseitemdefinitionassets-id-args) |
| `resolveModelData(assets, model)` | Flatten a model's inheritance into final data. [Details](scenes.md#resolvemodeldataassets-model) |

## Scenes

| Export | Description |
|---|---|
| `makeModelScene()` | Create an empty scene (async on the web, sync on Node). [Details](scenes.md#makemodelscene) |
| `createScene(assets, blocks, args?)` | Build a whole block scene in one call: parsing, culling, fluids, lighting, and optimization. [Details](scenes.md#createsceneassets-blocks-args) |
| `loadModel(scene, assets, model, args?)` | Build a model's geometry into a scene. [Details](scenes.md#loadmodelscene-assets-model-args) |
| `poseSpecial(root, pose)` | Manually pose a dynamic model (chest lid, shulker lid, enchanting book); books animate and lids `.open()`/`.close()` on their own. [Details](scenes.md#dynamic-models) |
| `renderModelScene(scene, camera, args?)` | Render a scene to output. [Details](scenes.md#rendermodelscenescene-camera-args) |
| `optimizeScene(placements, options?)` | Merge the whole scene into a handful of draw calls, with far fewer polygons. [Details](optimization.md#scene-optimization) |
| `sortTranslucent(group, options?)` | Depth-sort a group's translucent faces for a moving camera. [Details](optimization.md#translucent-sorting) |
| `renderMapColors(assets, colors)` | Render a save's map color bytes into a 128×128 canvas through the vanilla palette. [Details](scenes.md#map-art) |
| `MAP_COLORS` | The vanilla map palette, `{ base, shade }`. [Details](scenes.md#map-art) |
| `mapIdOf(item)` | The map id from an item's components, `null` when absent. [Details](scenes.md#map-art) |
| `disposeMapArt(assets)` | Clear the cached framed-map art. [Details](scenes.md#map-art) |
| `computeSceneLight(blocks, options)` | Flood-fill block and sky light for a scene, for torch-lit `"world"` lighting. [Details](rendering.md#scene-lighting) |

## Shared atlases, packing, animation

| Export | Description |
|---|---|
| `createSharedAtlas(opts?)` | An atlas pool shared across scenes, for worker builds and streaming; `animate: true` makes it tick its own regions. [Details](optimization.md#shared-atlases) |
| `stitchSharedAtlas(shared, assets, opts?)` | Stitch every pack sprite into the atlas up front, like the game's startup stitch. [Details](optimization.md#shared-atlases) |
| `exportSharedAtlasLayout(shared)` | The atlas's coordinate table, structured-cloneable for workers. [Details](optimization.md#shared-atlases) |
| `adoptSharedAtlasLayout(shared, layout)` | Adopt a layout pixel-free so worker scenes bake UVs against fixed coordinates. [Details](optimization.md#shared-atlases) |
| `insertSharedTextures(shared, items)` | Add runtime textures (sign text, banners), animated included, to a live atlas. [Details](optimization.md#shared-atlases) |
| `packScene(handle, opts?)` | Pack a built scene into transferable data for `postMessage`. [Details](optimization.md#packing-scenes-across-workers) |
| `reviveScene(payload, opts?)` | Rebuild a packed scene into live meshes. [Details](optimization.md#packing-scenes-across-workers) |
| `setAnimationRenderer(renderer)` | Register the renderer for GPU subimage animation updates. [Details](optimization.md#atlas-animation) |
| `collectAnimated(root)` | Gather a group's animated textures and `GameTime` shaders. [Details](optimization.md#atlas-animation) |
| `buildSchedules(textures)` | Precompute animation schedules for atlas textures. [Details](optimization.md#atlas-animation) |
| `evaluateAnimation(schedules, shaders, tickTime)` | Advance schedules to a game-tick time. [Details](optimization.md#atlas-animation) |

## Fluids

| Export | Description |
|---|---|
| `fluidTypeOf(id, properties?)` | The fluid type (water, lava, or none) for a block. [Details](fluids.md#fluidtypeofid-properties) |
| `fluidHeights(assets, type, neighbors)` | Corner heights for a fluid surface from its neighbors. [Details](fluids.md#fluidheightsassets-type-neighbors) |

## Helpers and data

| Export | Description |
|---|---|
| `isWaterloggable(id)` | Whether the renderer recognizes a block id as waterloggable. [Details](models.md#iswaterloggableid) |
| `isWaterlogged(id)` | Whether a block id is inherently water-filled (kelp, seagrass, bubble columns). [Details](models.md#iswaterloggedid) |
| `isFlatModel(models)` | Whether resolved model data is built entirely from flat planes (crosses, crops). [Details](models.md#isflatmodelmodels) |
| `getLightEmission(id, properties?, resolveDefault?)` | The light level (0-15) a block emits in game, from its blockstate. [Details](models.md#getlightemissionid-properties-resolvedefault) |
| `getBiomeTint(assets, map, biome?)` | The hex tint a biome (or blend of biomes) produces from a colormap. [Details](models.md#getbiometintassets-map-biome) |
| `COLORS` | The color tables the renderer tints with, for your own lookups. [Details](models.md#colors) |
| `DISPLAYS` | Ready-made display transforms for posing models that don't carry one. [Details](models.md#displays) |
| `LIGHT_DIMENSIONS` | The per-dimension world lighting presets, for spreading into overrides. [Details](rendering.md#world-lighting) |
| `SKIP_BLOCKS` | The `Set` of block ids that resolve to no models (the airs, `moving_piston`); skip these when iterating every block. [Details](models.md#skip_blocks-and-technical_blocks) |
| `TECHNICAL_BLOCKS` | The `Set` of invisible-in-game ids rendered here as placeholder icons (`barrier`, `light`, `structure_void`). [Details](models.md#skip_blocks-and-technical_blocks) |

## Extending

| Export | Description |
|---|---|
| `ModelLoader` | Register custom model loaders for modded formats. [Details](extending.md#custom-model-loaders) |

## Browser only

Not exported on Node.

| Export | Description |
|---|---|
| `configure({ THREE, assetsUrl })` | Provide the three.js instance and/or the bundled `assets.zip` URL (`false` skips the bundled assets entirely). [Details](standard-api.md#browser-only-exports) |
| `getThree()` | Resolve and return the three.js instance the library uses. [Details](standard-api.md#providing-threejs-browser) |
| `THREE` | Live binding to that instance, populated after first use. [Details](standard-api.md#providing-threejs-browser) |
| `pauseAnimations()` / `resumeAnimations()` | Pause and resume the page-global animation clock. [Details](standard-api.md#animated-renders-browser) |
| `createAnimator(root)` | Manual animation control for `loadModel` scenes. [Details](scenes.md#animation-browser) |
| `packAtlasDelta(shared, since?)` | The shared atlas regions added since a serial, for the legacy mirroring flow. [Details](optimization.md#incremental-mirroring-legacy) |
| `createAtlasMirror(opts?)` | Main-thread mirror of a worker's dynamically grown atlas pages. [Details](optimization.md#incremental-mirroring-legacy) |
