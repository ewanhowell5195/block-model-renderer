# API reference

Every export the package provides, grouped by area, with a link to where each is documented in full. The import is the same on Node and in the browser (`import { ... } from "block-model-renderer"`) except for the [browser-only](#browser-only) and [Node-only](#node-only) exports.

```js
import {
  // rendering
  renderBlock, renderItem, renderModel, renderTexture, getCullFaces, fullyOccludes,
  // assets and files
  prepareAssets, readFile, listDirectory, readTexture, zipAssets, zipAssetsFromSlices, parseZip, disposeCache, exportCache, importCache,
  // model data
  parseBlockstate, parseItemDefinition, resolveModelData,
  // scenes
  makeModelScene, getThree, createScene, createSky, createClouds, createFog, loadModel, poseSpecial, resumeSpecial, renderModelScene, optimizeScene, createTranslucentSorter, warmShaders,
  computeSceneLight, renderMapColors, disposeMapArt, mapIdOf, MAP_COLORS, resolveProfile,
  // shared atlases, packing, animation
  createSharedAtlas, packScene, reviveScene, rebindUniforms, setAnimationRenderer, collectAnimated, buildSchedules, evaluateAnimation,
  // fluids
  fluidTypeOf, fluidHeights,
  // helpers and data
  isWaterloggable, isWaterlogged, isFlatModel, getLightEmission, getBiomeTint, COLORS, DISPLAYS, LIGHT_DIMENSIONS, SKIP_BLOCKS, TECHNICAL_BLOCKS, wasmStatus,
  // extending
  ModelLoader,
  // browser only
  configure, THREE, pauseAnimations, resumeAnimations, createAnimator,
  // Node only
  setCanvasGPU
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

## Assets and files

| Export | Description |
|---|---|
| `prepareAssets(assets, options?)` | Normalize asset sources once for reuse. [Details](assets.md#prepareassetsassets-options) |
| `readFile(assets, path, hint?)` | Read one file from a set of asset sources. [Details](assets.md#readfileassets-path-hint) |
| `listDirectory(assets, dir)` | List a directory across layered sources. [Details](assets.md#listdirectoryassets-dir) |
| `readTexture(assets, path, opts?)` | Read a texture as ready-to-draw frames. [Details](assets.md#readtextureassets-path-opts) |
| `zipAssets(input)` | Wrap a zip (bytes, `Blob`, or `File`) as an asset source. [Details](assets.md#zipassetsinput) |
| `zipAssetsFromSlices(slice, size)` | Wrap a zip read on demand through a slice callback, for huge files. [Details](assets.md#zipassetsfromslicesslice-size) |
| `parseZip(bytes)` | Parse a zip into its entries. [Details](assets.md#parsezipbytes) |
| `disposeCache(assets)` | Free textures and GPU data cached on prepared assets. [Details](assets.md#caching) |
| `exportCache(assets)` | The cached blockstate files, model data and occlusion masks, for workers or persistence. [Details](assets.md#exporting-and-importing-the-cache) |
| `importCache(assets, data)` | Seed a prepared assets instance with an exported cache. [Details](assets.md#exporting-and-importing-the-cache) |

## Model data

| Export | Description |
|---|---|
| `parseBlockstate(assets, id, args?)` | Resolve a blockstate to its chosen model(s). [Details](scenes.md#parseblockstateassets-id-args) |
| `parseItemDefinition(assets, id, args?)` | Resolve an item definition to its chosen model(s). [Details](scenes.md#parseitemdefinitionassets-id-args) |
| `resolveModelData(assets, model)` | Flatten a model's inheritance into final data. [Details](scenes.md#resolvemodeldataassets-model) |

## Scenes

| Export | Description |
|---|---|
| `makeModelScene()` | Create an empty scene and camera. [Details](scenes.md#makemodelscene) |
| `getThree()` | Resolve the three.js instance the library uses, to build your own scenes from. [Details](standard-api.md#getthree) |
| `createScene(assets, blocks, args?)` | Build a whole block scene in one call: parsing, culling, fluids, lighting, and optimization. [Details](scenes.md#createsceneassets-blocks-args) |
| `createSky(assets, args?)` | Build the game's sky: the gradient, the pack's sun and moon, stars, and the sunrise glow, on one day/night clock. [Details](rendering.md#createskyassets-args) |
| `createClouds(assets, args?)` | Build the game's cloud layer from the pack's cloud texture, drifting on its own clock. [Details](rendering.md#createcloudsassets-args) |
| `createFog(config, dimension?)` | Make a fog handle on its own, to share between scenes and a sky. [Details](rendering.md#fog) |
| `loadModel(assets, model, args?)` | Build a model's geometry as a group. [Details](scenes.md#loadmodelassets-model-args) |
| `poseSpecial(root, pose)` | Manually pose a dynamic model (chest lid, shulker lid, enchanting book); books animate and lids `.open()`/`.close()` on their own. [Details](scenes.md#dynamic-models) |
| `resumeSpecial(root)` | Hand an auto animation held by `poseSpecial` back to its own clock. [Details](scenes.md#resumespecialroot) |
| `renderModelScene(scene, camera, args?)` | Render a scene to output. [Details](scenes.md#rendermodelscenescene-camera-args) |
| `optimizeScene(placements, options?)` | Merge the whole scene into a handful of draw calls, with far fewer polygons. [Details](optimization.md#scene-optimization) |
| `createTranslucentSorter(object, options?)` | Depth-sort an object's translucent faces for a moving camera. [Details](optimization.md#translucent-sorting) |
| `warmShaders(assets, renderer, args?)` | Compile the shader programs scenes will use before the first one renders. [Details](optimization.md#warming-shaders) |
| `renderMapColors(assets, colors)` | Render a save's map color bytes into a 128×128 canvas through the vanilla palette. [Details](scenes.md#map-art) |
| `MAP_COLORS` | The vanilla map palette, `{ base, shade, names }`. [Details](scenes.md#map-art) |
| `mapIdOf(item)` | The map id from an item's components, `null` when absent. [Details](scenes.md#map-art) |
| `disposeMapArt(assets)` | Clear the cached framed-map art. [Details](scenes.md#map-art) |
| `resolveProfile(assets, profile)` | Resolve a player profile to its skin and cape through Mojang's API. [Details](scenes.md#player-heads) |
| `computeSceneLight(assets, blocks, options?)` | Flood-fill block and sky light for a scene, for torch-lit `"world"` lighting. [Details](rendering.md#scene-lighting) |

## Shared atlases, packing, animation

| Export | Description |
|---|---|
| `createSharedAtlas(opts?)` | An atlas pool shared across scenes, for worker builds and streaming. Its handle stitches the packs' sprites up front, exports and adopts layouts for workers, and inserts runtime textures; `animate: true` makes it tick its own regions. [Details](optimization.md#shared-atlases) |
| `packScene(handle, opts?)` | Pack a built scene into transferable data for `postMessage`. [Details](optimization.md#packing-scenes-across-workers) |
| `reviveScene(payload, opts?)` | Rebuild a packed scene into live meshes. [Details](optimization.md#packing-scenes-across-workers) |
| `rebindUniforms(target, source)` | Bind a scene's light volume, time of day, fog and lighting switches onto separately built meshes. [Details](optimization.md#packing-scenes-across-workers) |
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
| `wasmStatus()` | Resolves `true` when the wasm geometry kernels are in use and `false` when the JavaScript fallbacks are. [Details](optimization.md#wasm-kernels) |

## Extending

| Export | Description |
|---|---|
| `ModelLoader` | Register custom model loaders for modded formats. [Details](extending.md#custom-model-loaders) |

## Browser only

Not exported on Node.

| Export | Description |
|---|---|
| `configure({ THREE, assetsUrl, clockStart })` | Provide the three.js instance, the bundled `assets.zip` URL (`false` skips the bundled assets entirely), and/or a shared animation clock epoch. [Details](standard-api.md#browser-only-exports) |
| `THREE` | Live binding to the instance [`getThree()`](standard-api.md#getthree) resolves, populated after first use. [Details](standard-api.md#browser-only-exports) |
| `pauseAnimations()` / `resumeAnimations(clockStart?)` | Pause and resume the page-global animation clock, optionally rebasing onto a [shared epoch](advanced-api.md#syncing-the-animation-clock). [Details](standard-api.md#animated-renders-browser) |
| `createAnimator(root)` | Manual animation control for `loadModel` scenes. [Details](scenes.md#animation-browser) |

## Node only

Not exported in the browser.

| Export | Description |
|---|---|
| `setCanvasGPU(enabled)` | Let skia-canvas draw 2D canvases on the GPU, off by default. [Details](standard-api.md#node-only-exports) |

## Migrating from 2.x

The old option names and argument orders throw an error that names the new form.

| 2.x | 3.0 |
|---|---|
| `renderBlock({ blockstates })`, `getCullFaces({ blockstates })` | `{ properties }` |
| `parseBlockstate(assets, id, { data })` | `parseBlockstate(assets, id, { properties })` |
| `parseItemDefinition(assets, id, { data })` | `parseItemDefinition(assets, id, { components })` |
| `version`, `defaults`, `ignoreAtlases` passed per call, `version: false` | Set once: `prepareAssets(sources, { version, defaults, ignoreAtlases })` |
| `readFile(path, assets, hint?)` | `readFile(assets, path, hint?)` |
| `listDirectory(dir, assets)` | `listDirectory(assets, dir)` |
| `readTexture(path, assets, opts?)` | `readTexture(assets, path, opts?)` |
| `computeSceneLight(blocks, { assets, ...options })` | `computeSceneLight(assets, blocks, options?)` |
| `warmShaders(renderer, assets, args?)` | `warmShaders(assets, renderer, args?)` |
| `loadModel(scene, assets, model, args)` | `loadModel(assets, model, { ...args, parent: scene })` |
| `loadModel(null, assets, model, args)` | `loadModel(assets, model, args)` |
| `makeModelScene()` synchronous on Node | `await makeModelScene()` on both platforms |
| `getThree()` browser only | `await getThree()` on both platforms |
| `exportModelCache(assets)`, `exportOcclusionCache(assets)` | `exportCache(assets)`, resolving `{ files, models, occlusion }` |
| `importModelCache(assets, data)`, `importOcclusionCache(assets, entries)` | `importCache(assets, data)` |
| `sortTranslucent(object, options)` | `createTranslucentSorter(object, options)` |
| `stitchSharedAtlas(shared, assets, opts)` | `shared.stitch(assets, opts)` |
| `exportSharedAtlasLayout(shared)` | `shared.exportLayout()` |
| `adoptSharedAtlasLayout(shared, layout)` | `shared.adoptLayout(layout)` |
| `insertSharedTextures(shared, items)` | `shared.insert(items)` |
| `reviveScene(payload, { atlas })` | `reviveScene(payload, { sharedAtlas })` |
| A revived scene's `light` is `{ uniforms }` | `{ uniforms, setOffset }` |
| `getCullFaces({ neighbors })` takes the six-face object | Also takes the `([x, y, z]) => block` lookup |
