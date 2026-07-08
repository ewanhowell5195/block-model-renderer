# block-model-renderer

Minecraft block and item model rendering for Node.js and the browser.
Render any block, item, or custom model JSON, with full support for vanilla resource pack features. On Node renders go to image files or buffers; in the browser they go straight to canvases, with live animation players.

[![npm version](https://badge.fury.io/js/block-model-renderer.svg)](https://www.npmjs.com/package/block-model-renderer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

* Renders blocks, items, and custom models from a resource pack
* Runs on Node.js and in the browser from the same package
* Full vanilla model, blockstate, item-definition, and texture atlas support, with accurate lighting and tints
* Hidden-face culling: tell it the neighbouring blocks and the faces they hide are dropped. Near game-accurate, ideal for optimised scenes
* Water and lava with the vanilla surface shaping: corner heights, flow angle, side overlays, and automatic water layers on waterlogged blocks
* Animated textures: WebP and GIF output on Node, live self-updating canvases on web
* Stack multiple resource packs with higher ones overriding lower ones, just like in Minecraft
* Resource pack zips work directly as asset sources, plus virtual handlers for serving files from anywhere
* Bundled overrides for block entities that Minecraft renders dynamically (banners, chests, heads, and more)
* PNG, JPEG, WebP, GIF, and AVIF output on Node

## Install

```bash
npm install block-model-renderer
```

Or in the browser, straight from a CDN (three.js is a peer dependency you provide; see [Using in the browser](#using-in-the-browser)):

```js
import { renderBlock } from "https://cdn.jsdelivr.net/npm/block-model-renderer@2/+esm"
```

## Quick Start

```js
import { renderBlock, renderItem, renderModel } from "block-model-renderer"

const assets = "C:/Users/ewanh/AppData/Roaming/.minecraft/resourcepacks/vanilla"

// Render a block by id
await renderBlock({
  id: "oak_log",
  assets,
  path: "oak_log.png"
})

// Render an item by id
await renderItem({
  id: "diamond_sword",
  assets,
  path: "diamond_sword.png"
})

// Render a custom model JSON
await renderModel({
  assets,
  model: {
    textures: { main: "block/stone" },
    elements: [{
      from: [0, 0, 0],
      to: [16, 16, 16],
      faces: {
        up:    { texture: "#main" },
        down:  { texture: "#main" },
        north: { texture: "#main" },
        south: { texture: "#main" },
        east:  { texture: "#main" },
        west:  { texture: "#main" }
      }
    }]
  },
  path: "custom.png"
})
```

## API

### `renderBlock(args)`

Renders a block by its id using the resource pack's blockstates and models.

| Option | Default | Description |
|---|---|---|
| `id` | | The block id (e.g. `"oak_log"`, `"stone"`). Namespace optional |
| `assets` | `[]` | The assets source, see [Assets](#assets) |
| `blockstates` | `{}` | Blockstate property values (e.g. `{ axis: "y", half: "top" }`) |
| `neighbors` | | The blocks surrounding this one; faces they hide are dropped. See [Culling hidden faces](#culling-hidden-faces) |
| `cull` | | Explicit set of face directions to drop; overrides `neighbors`. See [Culling hidden faces](#culling-hidden-faces) |
| `lighting` | `"item"` | Lighting mode (`"item"`, `"world"`, `"scene"`, `"off"`). See [Lighting modes](#lighting-modes) |
| `display` | see below | Display transform applied to the rendered block. See [Display transforms](#display-transforms) |
| `path` | | Node only. If provided, saves the output to this file path. Format inferred from the extension |
| `format` | | Node only. Output format (`"png"`, `"jpeg"`, `"webp"`, etc.). Overrides extension inference. See [sharp's output docs](https://sharp.pixelplumbing.com/api-output) for the full list of supported formats |
| `output` | | Node only. Options passed directly to the sharp format encoder (e.g. `{ quality: 85, mozjpeg: true }` for JPEG). See [sharp's output docs](https://sharp.pixelplumbing.com/api-output) for all available options per format |
| `canvas`, `x`, `y`, `clear`, `pauseOffscreen` | | Web only. See [Using in the browser](#using-in-the-browser) |
| `width` | `256` | Width of the rendered output image, in pixels |
| `height` | `256` | Height of the rendered output image, in pixels |
| `animated` | `false` | See [Animated output](#animated-output) |
| `animatedWidth` | Inherits from `width` | Width of the rendered output image when the output is animated, in pixels |
| `animatedHeight` | Inherits from `height` | Height of the rendered output image when the output is animated, in pixels |
| `animatedOutput` | | Options passed directly to the sharp encoder when the output is animated |
| `maxAnimationFrames` | `4096` | Maximum number of frames in animated output. If a model's textures can't all loop cleanly within this many frames, the loop is truncated and shorter textures may get cut short |
| `ignoreAtlases` | `false` | Render without enforcing texture atlas rules |
| `version` | | Minecraft version the assets are for. Enables era-appropriate behaviour (see [Legacy Minecraft versions](#legacy-minecraft-versions)) |
| `background` | transparent | See [Background](#background) |

Default display:
```js
{ rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625], type: "fallback", display: "gui" }
```

### `renderItem(args)`

Renders an item by id using its item definition.

| Option | Default | Description |
|---|---|---|
| `id` | | The item id (e.g. `"diamond_sword"`, `"apple"`). Namespace optional |
| `assets` | `[]` | The assets source |
| `components` | `{}` | Item components used by the item definition (e.g. `{ using_item: true }` on a `bow` to show it drawn) |
| `display` | `{ type: "fallback", display: "gui" }` | Display transform. See [Display transforms](#display-transforms) |
| `path`, `format`, `output`, `width`, `height`, `animated`, `animatedWidth`, `animatedHeight`, `animatedOutput`, `maxAnimationFrames`, `ignoreAtlases`, `version`, `background`, `cull`, `lighting` | | Same as `renderBlock` |

### `renderModel(args)`

Renders a custom model JSON directly, bypassing blockstate or item definition lookup.

| Option | Default | Description |
|---|---|---|
| `model` | `{}` | A model JSON object (inherits from `parent` if specified, supports all vanilla model features) |
| `assets` | `[]` | The assets source |
| `display` | Same as `renderBlock` | Display transform. See [Display transforms](#display-transforms) |
| `path`, `format`, `output`, `width`, `height`, `animated`, `animatedWidth`, `animatedHeight`, `animatedOutput`, `maxAnimationFrames`, `ignoreAtlases`, `version`, `background`, `cull`, `lighting` | | Same as `renderBlock` |

### Return value

On Node, all three render functions return:
* A `Uint8Array` (a `Buffer`) when `animated` is `false` (default)
* An object `{ buffer, format }` when `animated` is truthy. The `format` field tells you what was actually produced. For example, `animated: true` produces `"webp"` if the model has animated textures, or `"png"` if it doesn't

On web they return a canvas, or an animation player. See [Using in the browser](#using-in-the-browser).

### Culling hidden faces

Blocks in the world hide the faces pressed against their neighbours. To render a block the way it looks in place (no bottom face against the ground, no side faces against adjacent blocks), pass `neighbors` to `renderBlock`:

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

* the neighbour's shape fully covers it. This is state-aware, so two adjacent bottom slabs cull their touching sides but a top slab against a bottom slab doesn't
* the block self-culls against its own kind (glass against glass, water against water)

And never against blocks the game flags as non-occluding (glass, leaves, powder snow), no matter how solid they look.

It's *near* game-accurate rather than exact: the game hardcodes each block's occlusion shape, while this library reads it off the actual models and textures in use, since maintaining a copy of that hardcoded list would be unsustainable.

#### `getCullFaces(args)`

The same logic as a standalone helper, for building your own scenes with `loadModel`:

| Option | Default | Description |
|---|---|---|
| `id` | | The block id |
| `blockstates` | `{}` | The block's blockstate property values |
| `neighbors` | | The surrounding blocks, as in `renderBlock` above |
| `assets` | `[]` | The assets source |
| `version` | | Minecraft version, as in `renderBlock` |

Returns a `Set` of directions to drop (`"down"`, `"up"`, `"north"`, `"south"`, `"west"`, `"east"`). Pass it as the `cull` option to any render function or `loadModel`; a plain object like `{ north: true }` works there too.

```js
import { getCullFaces, loadModel } from "block-model-renderer"

const cull = await getCullFaces({ id: "stone", neighbors: { down: "stone", up: "glass" }, assets })
// Set { "down" }: glass doesn't occlude
await loadModel(scene, assets, resolved, { cull })
```

Because occlusion comes from the models, modded blocks and custom packs just work. The models a call builds are cached for that call; with [`prepareAssets(assets, { cache: true })`](#prepareassetsassets-options) they're cached across calls too.

## Using in the browser

The same package runs in the browser via a conditional export, so bundlers and jsDelivr's `+esm` pick the web build automatically. The goal on web is **display, not files**: renders go into canvases, and animated renders become live players. The `path`, `format`, `output`, `animatedOutput`, `animatedWidth`, and `animatedHeight` options don't exist on web (call `canvas.toBlob()` yourself if you want bytes).

### Providing three.js

three is a peer dependency you supply, resolved lazily on first use:

1. An instance passed via `configure({ three })`
2. `import("three")`, from your bundler install or an import map entry:
   ```html
   <script type="importmap">
     { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js" } }
   </script>
   ```
3. A `THREE` global, if you made one

The recommended version is **0.162.0**, the exact version the Node renderer uses, so scene maths match. Other versions from ~0.152 up will probably work, but if a newer three shifts colours or breaks behaviour, adjusting for it is on you. The instance the library resolved is re-exported (`import { THREE } from "block-model-renderer"`, populated after the first call, or `await getThree()`); build your own scenes from it rather than a second three copy.

### Rendering to canvases

```js
import { renderBlock, prepareAssets } from "block-model-renderer"

// a resource pack zip from a file input, fetch, anywhere
const assets = await prepareAssets([zipFileOrBuffer])

// returns a canvas you can append
const canvas = await renderBlock({ id: "oak_log", assets, width: 128, height: 128 })
document.body.append(canvas)

// or draws into a canvas you already have (renders at the canvas's size
// if width/height are omitted, resizes it to width/height if given)
await renderBlock({ id: "stone", assets, canvas: myCanvas })
```

Returned canvases are plain 2D canvases: snapshots blitted off one shared internal WebGL context, so they don't count against the browser's WebGL context limit no matter how many you make.

**Placement mode**: give `x` and/or `y` (the other defaults to `0`) to draw into a region of a bigger canvas without resizing or clearing it. Great for spritesheets:

```js
const sheet = document.createElement("canvas")
sheet.width = sheet.height = 2048
let i = 0
for (const id of blockIds) {
  await renderBlock({ id, assets, canvas: sheet, width: 128, height: 128, x: (i % 16) * 128, y: Math.floor(i / 16) * 128 })
  i++
}
```

In placement mode `clear` defaults to `false` (the block composites over whatever is in the rect, so your background survives). Pass `clear: true` when re-rendering into the same spot, otherwise the old render shows through the new one's transparent pixels.

### Animated renders

With `animated: true` the render functions return a **player** instead of a canvas (mirroring how Node returns `{ buffer, format }` instead of a buffer):

```js
const player = await renderBlock({ id: "magma_block", assets, animated: true })
document.body.append(player.canvas)
```

The player keeps painting frames into its canvas on Minecraft's 50ms tick clock. All players share one page-global clock (everything stays in phase, like game time) and one rAF scheduler, and pause automatically while offscreen via IntersectionObserver (opt out with `pauseOffscreen: false`).

To freeze everything at once, pause the clock itself with `pauseAnimations()` and continue with `resumeAnimations()`. Unlike `player.pause()` (which snaps back onto the running clock when resumed, to stay in phase with everything else), pausing the clock resumes seamlessly from the frozen moment: every player and `loadModel` scene picks up exactly where it stopped, still in phase with each other.

| Member | Description |
|---|---|
| `canvas` | The canvas being painted (the one you passed, or a new one) |
| `animated` | `false` if the model turned out to have no animated textures; the canvas just holds a static render and everything else no-ops |
| `playing` | Whether playback is running |
| `play()` / `pause()` | Resume / stop playback. Resuming snaps back onto the global clock |
| `frames` | Timeline metadata for one loop: `[{ time, duration }, ...]` in ms. Computed lazily; `maxAnimationFrames` caps this enumeration only |
| `duration` | Total loop length in ms |
| `renderFrame(index)` | Paint one frame by index (wraps modulo the loop) |
| `renderTime(ms)` | Paint the state at an arbitrary clock time (wraps; exact regardless of `maxAnimationFrames`) |
| `dispose()` | Stop playback and free the scene and GPU textures. Call it when you remove the canvas; animated renders are the one place the library holds resources |

`frames` is metadata, not bitmaps. If you need frame images: `player.renderFrame(i)` then `createImageBitmap(player.canvas)`.

Interpolated textures (`interpolate` in the mcmeta) are blended per tick with the exact ratio, which is actually smoother than Node's animated file output.

The end portal and end gateway also animate live on web. Their shader is driven by game time rather than texture frames, so there's no frame timeline (`frames` is empty, `duration` is `0`), but `renderTime(ms)` works and playback advances per game tick. On Node they render a fixed moment, since the pattern has no short loop an animated file could close.

#### Frame cache

Players cache their rendered frames as they play, so steady-state playback is a single `drawImage` per tick instead of a scene render. Controlled by the `cache` option on the render call:

| Value | Behaviour |
|---|---|
| `"auto"` | Default. Cache when one full loop fits the budget (`frames.length × width × height × 4` bytes ≤ `cacheBudget`, default 4MB). Shader-driven animation (end portal) never caches |
| `true` | Always cache; you've done the memory maths yourself |
| `false` | Never cache, always live-render |

Idle players (paused, or scrolled offscreen) drop their cache after 10 seconds and rebuild it lazily when they resume.

#### Multiple canvases

`canvas` also accepts an array: the model renders once and the result is blitted to every canvas, so mirroring the same block in several places costs one render, not N:

```js
const player = await renderBlock({ id: "magma_block", assets, canvas: [a, b, c], animated: true })
player.canvas // [a, b, c], the return shape mirrors what you passed
```

Array entries can also be descriptors with per-canvas placement and draw size:

```js
await renderBlock({
  id: "magma_block", assets,
  width: 128, height: 128,  // render resolution; the scene renders once at this size
  animated: true,
  canvas: [
    plain,                                                  // resized to 128x128, render fills it
    { canvas: sheet, x: 256, y: 0 },                        // placed at native size
    { canvas: sheet, x: 0, y: 0, width: 64, height: 64 },   // second rect on the same sheet, scaled down
    { canvas: hud, x: 10, y: 10, width: 512, height: 128 }  // stretch/distort if you want
  ]
})
```

Entry `x`/`y` place that canvas (placement mode for it alone); entry `width`/`height` set its draw size, defaulting to the render size. A draw size that differs from the render size scales through the 2d context, so set `imageSmoothingEnabled` on the canvas yourself to pick crisp vs smooth. Top-level `x`/`y`/`clear` act as inherited defaults for entries that don't specify their own. Placement snapshots are taken per canvas, and a player keeps playing while at least one of its canvases is visible.

The render itself still happens once, at one resolution, and scaled draws reuse it. If you want crisp 1:1 pixels at a different size, that's a separate render call.

### Asset sources on web

String folder paths don't exist in the browser. Use:

* **Zips**: a `Uint8Array`, `ArrayBuffer`, `Blob`, or `File` entry is detected and unwrapped automatically (a `<input type="file">` file works as-is). Wrapper-folder zips (`MyPack/assets/...`) are handled. `zipAssets(input)` is also exported if you want the handler directly
* **Virtual handlers**: same as Node, see [Virtual handlers](#virtual-handlers)

The zip reader handles standard stored/deflate zips (what every normal tool produces) but not zip64, encryption, or exotic compression; use a virtual handler for those.

The bundled block entity overrides are fetched once as a single `assets.zip` resolved relative to the module URL (works on jsDelivr and through bundlers). If yours lives somewhere unusual, point at it with `configure({ assetsUrl })`.

### Web-only exports

| Export | Description |
|---|---|
| `configure({ three, assetsUrl })` | Optional overrides, call before first use |
| `getThree()` | Resolves and returns the three instance the library uses |
| `THREE` | The same instance as a live binding (populated after first use) |
| `pauseAnimations()` / `resumeAnimations()` | Pause and resume the page-global animation clock. See [Animated renders](#animated-renders) |

`makeModelScene()` is async on web (three resolves lazily), unlike Node where it's sync.

## Assets

The `assets` option tells the renderer where to find resource pack files. It can be any of:

* A **string**, a path to a resource pack folder, or to a `.zip`/`.jar` file (Node only)
* A **zip in memory**: `Uint8Array`, `ArrayBuffer`, `Blob`, or `File` (both platforms)
* A **virtual handler object**, see [Virtual handlers](#virtual-handlers)
* An **array** of any combination of the above
* **Prepared assets**, the return value of `prepareAssets()`

When given an array, entries are checked in order: the first entry that has a file wins (higher-priority packs override lower-priority ones). This lets you layer packs on top of vanilla, just like Minecraft does.

```js
// Single pack
assets: "C:/Users/ewanh/AppData/Roaming/.minecraft/resourcepacks/vanilla"

// Multiple layers (first wins)
assets: [
  "C:/Users/ewanh/AppData/Roaming/.minecraft/resourcepacks/my-overrides",
  "C:/Users/ewanh/AppData/Roaming/.minecraft/resourcepacks/vanilla"
]
```

### Virtual handlers

Any object with a `read` method can be used as an assets entry, letting you serve files from anywhere, a zip file, memory, an HTTP server, a database. No disk access required.

```js
const zip = { /* ... loaded zip ... */ }

const handler = {
  async read(filePath) {
    const entry = zip.files[filePath]
    return entry ? await entry.buffer() : null
  },
  list(dir) {
    return zip.folders[dir] ?? []
  },
  filter(filePath) {
    return filePath.startsWith("assets/minecraft/recipes/")
  }
}

await renderBlock({ id: "stone", assets: handler, path: "out.png" })
```

| Method | Required | Description |
|---|---|---|
| `read(filePath)` | yes | Return file contents (`Buffer`, `Uint8Array`, or `string`), or `null` / `undefined` if the file doesn't exist |
| `list(dir)` | yes | Return an array of filenames in the given directory |
| `filter(filePath)` | no | Return `true` to hide this file from lower-priority entries |

### `prepareAssets(assets, options?)`

The renderer internally calls `prepareAssets(assets)` on each render to normalize the input and parse `pack.mcmeta` filters. If you're running many renders with the same assets, call it once yourself and pass the result for faster subsequent renders:

```js
import { prepareAssets, renderBlock } from "block-model-renderer"

const assets = await prepareAssets([
  "C:/Users/ewanh/AppData/Roaming/.minecraft/resourcepacks/my-overrides",
  "C:/Users/ewanh/AppData/Roaming/.minecraft/resourcepacks/vanilla"
])

for (const id of ["stone", "dirt", "oak_log"]) {
  await renderBlock({ id, assets, path: `${id}.png` })
}
```

#### Caching

Within a single render call nothing is ever decoded or resolved twice: the block, its cull neighbours, and an item's layers all share one internal cache. Pass `{ cache: true }` to extend that reuse **across** calls:

```js
const assets = await prepareAssets(sources, { cache: true })
```

Decoded textures, resolved models, and culling data then persist on the bundle, so repeat renders from the same pack skip the load work (several times faster once warm). The cache is bounded by the pack's unique textures and models, but it holds real texture memory, so free it when you swap packs:

```js
import { disposeCache } from "block-model-renderer"

disposeCache(oldAssets) // safe if caching was never on
```

Caching stays enabled after a dispose; it just repopulates. Don't dispose while something from that bundle is still rendering (a live player, a scene on screen).

## Block entity overrides

Minecraft renders some blocks dynamically at runtime using hardcoded geometry, with no corresponding model JSON in the vanilla resource pack. block-model-renderer ships with a bundled overrides pack that supplies model JSONs for these cases, so they render correctly without any setup from you.

The following categories are covered:

* Banners
* Bells
* Chests
* Conduits
* Copper Golem Statues
* Decorated Pots
* Enchanting Table Books
* End Portal & End Gateway
* Mob Heads and Skulls
* Shulker boxes
* Water & Lava
* Technical blocks (barrier, light, structure void, moving piston)

### Limitation

The overrides pack is prepended to your assets array at the highest priority. Any blockstate or model covered by it will override whatever your own packs provide, the bundled version always wins. This is a renderer limitation, not a design choice. That said, since these blocks are rendered dynamically by vanilla, you're very unlikely to actually have modified these files.

## Fluids

Water and lava render like any other block: `renderBlock({ id: "water", assets })` just works, and waterloggable blocks given `{ waterlogged: true }` in their `blockstates` gain the water layer automatically. A standalone render uses the still texture at the game's resting height.

In the world a fluid's shape depends on its surroundings: each surface corner averages with the neighbouring fluid columns, rising to full height against taller fluid and dipping where the fluid falls away, a flowing surface angles its texture along the flow, sides pressed against glass or leaves switch to the overlay texture, and faces shared with the same fluid disappear. To get all of that, give `loadModel` the surrounding blocks:

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

The object uses the same per-direction values as `renderBlock`'s culling `neighbors` (a block id string, or `{ id, ...properties }`), extended with diagonal and vertical keys since the surface shape needs them. Anything missing counts as air. Non-fluid models ignore it.

| Key | Used for |
|---|---|
| `self` | The fluid block itself; its `level` property sets its own height. Optional: when omitted, the block counts as the still fluid |
| `north`, `south`, `east`, `west` | Corner averaging, hiding shared faces, overlays, and flow direction |
| `north_east`, `north_west`, `south_east`, `south_west` | Corner averaging with the diagonal columns |
| `up`, plus `up_north` ... `up_south_west` | Fluid above a column makes that column full height |
| `down`, plus `down_north` ... `down_west` | Falling fluid below: hides the bottom face and pulls the flow |

Compound keys order as vertical, then north/south, then east/west (`up_north_east`, `down_west`).

That's the whole API for a single block. The two helpers below only matter when you render fluids at scale, scanning a structure or world for fluid cells and reusing surface shapes across models and blocks; skip them otherwise.

### `fluidTypeOf(id, properties?)`

The fluid a block contributes: `"water"` for water (including any blockstate with `waterlogged: true`), `"lava"` for lava, `null` for everything else. Flowing variants count as their fluid.

Use it when walking blocks to decide which cells need fluid handling at all, instead of reimplementing those rules; the return value is also the `type` to pass to `fluidHeights`.

```js
import { fluidTypeOf } from "block-model-renderer"

fluidTypeOf("water")                               // "water"
fluidTypeOf("flowing_lava")                        // "lava"
fluidTypeOf("oak_stairs", { waterlogged: "true" }) // "water"
fluidTypeOf("stone")                               // null
```

### `fluidHeights(assets, type, neighbors)`

The vanilla surface calculation as a standalone helper: exactly what `loadModel` computes internally from `neighbors`.

Use it to compute a block's surface shape once and share it: a waterlogged block is several models needing the same shape (pass the result to each `loadModel` as `fluidHeights`), and across a scene, cells with identical results can share one built model instead of rebuilding geometry per block.

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
| `type` | `"water"` or `"lava"` |
| `neighbors` | The surrounding blocks, in the same direction-keyed form shown above |

Returns an object you can pass to `loadModel` as `fluidHeights`:

| Field | Description |
|---|---|
| `nw`, `ne`, `sw`, `se` | Corner heights from `0` to `1`, the vanilla corner-averaging formula |
| `full` | The block above is the same fluid, so this one renders as a full cube |
| `angle` | Flow direction in radians for the flowing texture, or `null` when still |
| `overlay` | `{ north, south, west, east }` booleans: sides that use the `water_overlay` texture (pressed against a block with a full face there, like glass or leaves) |
| `same` | All six directions: `true` where the neighbour is the same fluid, and the shared face is hidden |

## Animated output

Minecraft textures with an accompanying `.mcmeta` animation block are supported out of the box. When the model uses animated textures, enable animated output with `animated: true`:

```js
await renderBlock({
  id: "magma_block",
  assets,
  animated: true,
  path: "magma_block.webp"
})
```

| Value | Result |
|---|---|
| `false` | Single-frame PNG (default). Renders frame 0 of any animated textures |
| `true` | WebP if the model has animated textures, PNG otherwise |
| `"webp"` | Same as `true` |
| `"gif"` | GIF if the model has animated textures, PNG otherwise |

> **Note:** GIF doesn't handle semi-transparent pixels well. For textures like water or nether portals, stich with WebP.

## Background

The `background` option sets the clear color behind the rendered model. Supports several formats:

```js
// Transparent (default)
background: undefined

// Hex strings (3/4/6/8 digit)
background: "#ffffff"
background: "#ffffff80"

// rgb() / rgba()
background: "rgb(255, 255, 255)"
background: "rgba(255, 255, 255, 0.5)"

// Number (0xRRGGBB), fully opaque
background: 0xffffff

// Object
background: { r: 255, g: 255, b: 255, a: 0.5 }
```

## Display transforms

The `display` option controls how the model is rotated, translated, and scaled before rendering. It takes one of three forms:

**String**: name of a context in the model's `display` block (`"gui"`, `"fixed"`, `"ground"`, `"firstperson_righthand"`, etc.). The renderer uses that context's transform from the model.

```js
display: "firstperson_righthand"
```

**Plain transform**: an object with `rotation`, `translation`, and/or `scale`. Applied directly, ignoring anything the model defines.

```js
display: { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] }
```

**Fallback transform**: add `type: "fallback"` to a plain transform to first try the model's own `display` for a named context (`display: "gui"` by default), falling back to the object's own `rotation`/`translation`/`scale` if the model doesn't define that context.

```js
// Use the model's "gui" transform if it defines one, otherwise use this one
display: {
  type: "fallback",
  rotation: [30, 225, 0],
  scale: [0.625, 0.625, 0.625]
}

// Use the model's "firstperson_righthand" transform if it defines one, otherwise use this one
display: {
  type: "fallback",
  display: "firstperson_righthand",
  rotation: [30, 225, 0],
  scale: [0.625, 0.625, 0.625]
}
```

## Legacy Minecraft versions

The `version` option tells the renderer what Minecraft version the assets are for, so it can apply era-appropriate behaviour automatically. Older versions had quirks that modern ones don't, and this lets the renderer handle them transparently.

```js
await renderBlock({
  id: "cactus",
  assets,
  version: "1.8.9",
  path: "cactus.png"
})
```

`version` accepts release-style version strings like `"1.8"`, `"1.16.5"`, or `"26.1.2"`. Trailing segments are optional and treated as `0` (so `"26"` compares as `"26.0.0"`). Anything after a `-` is ignored, so snapshot, pre-release, and release-candidate suffixes work too: `"1.21-pre1"`, `"1.21-rc2"`, `"26.1.2-snapshot-2"`.

Currently triggered behaviours:
- **Pre-1.9**: `display.gui` entries compose onto the era's built-in gui base (rotation `[30, 225, 0]`, scale `0.625`) the way the old pipeline applied them, instead of being the whole transform like today
- **Pre-1.13**: prepends `block/` to bare blockstate model refs (e.g. `"model": "cactus"` resolves to `block/cactus`, matching the implicit prefix the game used before the 1.13 flattening)
- **Pre-1.21.6**: element rotation angles that aren't multiples of 22.5 make the model render as missing, like the game rejected them
- **Pre-1.21.11**: skips texture atlas membership rules (the block/item atlas restriction only began in 1.21.11). Element rotations outside ±45, or using the multi-axis `x`/`y`/`z` form, make the model render as missing
- **Pre-26.3**: ignores the element `shade_direction_override` field (it didn't exist yet)
- **26.3+**: ignores the element `shade` field (26.3 removed it in favour of `shade_direction_override`)

A few legacy behaviours don't conflict with anything, so they apply even without a `version`: items with no [item definition](#parseitemdefinitionassets-id-args) fall back to the classic `models/item/<id>.json` (the pre-1.21.4 world), the pre-1.9 `thirdperson`/`firstperson` display names map to their modern `_righthand` forms, and renamed item definition properties (`holder_type`, `shift_down`) resolve as their current names.

Without a `version`, everything that can coexist works at once: when the format replaces one field with another, both the old and new forms are supported simultaneously, and the newer form wins if a model carries both. Only behaviours that directly conflict fall back to the modern rules.

The option is accepted by every entry point (`renderBlock`, `renderItem`, `renderModel`, `parseBlockstate`, `parseItemDefinition`, `loadModel`) and is also propagated onto model objects as `model.version`, so manually constructed models can carry it through too.

## Low-level API

For custom rendering pipelines, lower-level functions are available.

### `parseBlockstate(assets, id, args?)`

Resolves a blockstate to a list of model references, picking variants or multipart cases based on the given property values.

| Argument | Description |
|---|---|
| `assets` | The assets source |
| `id` | The blockstate id |
| `args.data` | Blockstate property values (e.g. `{ axis: "y", half: "top" }`) |
| `args.ignoreAtlases` | Skip texture atlas membership rules for the returned models |
| `args.version` | Minecraft version the assets are for. See [Legacy Minecraft versions](#legacy-minecraft-versions) |

Returns a list of model references, one per matching model.

### `parseItemDefinition(assets, id, args?)`

Resolves an item definition to a list of model references, walking conditions, selects, and range dispatch based on the given properties.

| Argument | Description |
|---|---|
| `assets` | The assets source |
| `id` | The item id |
| `args.data` | Item components used by the definition |
| `args.display` | Display context, used by tint colour resolution |
| `args.ignoreAtlases` | Skip texture atlas membership rules for the returned models |
| `args.version` | Minecraft version the assets are for. See [Legacy Minecraft versions](#legacy-minecraft-versions) |

Returns a list of model references.

### `resolveModelData(assets, model)`

Recursively resolves a model's `parent` chain, merging `textures`, `elements`, and other fields into a single flat model.

| Argument | Description |
|---|---|
| `assets` | The assets source |
| `model` | A model reference or inline model object |

Returns the resolved model object.

### `makeModelScene()`

Creates a fresh three.js scene and orthographic camera configured for block rendering.

Returns `{ scene, camera }`.

The returned camera has a `fitAspect = true` flag that tells `renderModelScene` to adjust the camera's frustum to match the output aspect ratio (so non-square renders aren't squished). Set the same property on your own camera (`camera.fitAspect = true`) if you want the same behavior. Works for both `OrthographicCamera` and `PerspectiveCamera`. Without the flag, the camera is left exactly as you configured it.

### `loadModel(scene, assets, model, args?)`

Builds a resolved model's geometry and materials as a three.js group. If `scene` is non-null, the group is also added to it; pass `null` to just get the group back without touching any scene.

Texture atlas rules are enforced here: if `model.type` is `"block"` or `"item"` and `model.ignore_atlas_restrictions` isn't set, the model is replaced with the missing-model placeholder when any face texture is in the wrong atlas. Set `model.ignore_atlas_restrictions = true` on the model to bypass.

| Argument | Description |
|---|---|
| `scene` | The three.js scene to add the model to, or `null` to skip adding it |
| `assets` | The assets source |
| `model` | A resolved model (from `resolveModelData`) |
| `args.display` | Display transform to apply to the model |
| `args.lighting` | Lighting mode (`"item"` (default), `"world"`, `"scene"`, `"off"`). See [Lighting modes](#lighting-modes) |
| `args.cull` | Face directions to drop, as a `Set` from [`getCullFaces`](#getcullfacesargs) or a plain object like `{ north: true }`. Faces whose `cullface` points at a culled direction are skipped |
| `args.neighbors` | Fluid models only: the surrounding blocks as a direction-keyed object (`north`, `north_east`, `up`, `self`, ...), used to shape the surface. See [Fluids](#fluids) |
| `args.fluidHeights` | Fluid models only: a precomputed [`fluidHeights`](#fluidheightsassets-type-neighbors) result, reused instead of deriving it from `neighbors` again |
| `args.animate` | Web only. `false` disables the automatic animator (see [Animation](#animation-web)); drive it yourself with `createAnimator`. Default `true` |
| `args.version` | Minecraft version the assets are for. Sets `model.version` if not already present. See [Legacy Minecraft versions](#legacy-minecraft-versions) |

Returns a `THREE.Group` containing the loaded model.

#### Lighting modes

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

#### Animation (web)

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

### `renderModelScene(scene, camera, args?)`

Renders a scene to an image buffer. Takes all the same output options as `renderBlock` / `renderItem` / `renderModel`.

| Argument | Description |
|---|---|
| `scene` | The three.js scene to render |
| `camera` | The camera to render from |
| `args` | `path`, `format`, `width`, `height`, `animated`, `animatedWidth`, `animatedHeight`, `maxAnimationFrames`, `background`, same as [`renderBlock`](#renderblockargs) |

Returns an image buffer, or `{ buffer, format }` when `args.animated` is truthy.

### `readFile(path, assets, hint?)`

Reads a file from the assets, walking entries in order and respecting filters.

| Argument | Description |
|---|---|
| `path` | The file path, relative to the pack root (e.g. `"assets/minecraft/textures/block/stone.png"`) |
| `assets` | The assets source |
| `hint` | If set, only look in the entry at this index. Use `buf.hintIndex` from a previous read to pair related lookups (like a PNG and its mcmeta) |

Returns a `Uint8Array` (a `Buffer` on Node) with `.path` and `.hintIndex` fields, or `undefined` if not found.

### `listDirectory(dir, assets)`

Lists files in a directory across all assets entries, merging results and respecting filters.

| Argument | Description |
|---|---|
| `dir` | The directory path, relative to the pack root |
| `assets` | The assets source |

Returns a list of filenames.

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

### `zipAssets(input)`

Wraps a zip (`Uint8Array`, `ArrayBuffer`, `Blob`, or `File`) as an assets entry. You rarely need it, since zips passed straight into `assets` are detected and wrapped automatically, but it's here if you want the handler itself.

### `parseZip(bytes)`

The low-level reader behind `zipAssets`. Takes a `Uint8Array`/`ArrayBuffer` and returns a `Map` of every file path to its raw entry (compressed bytes, not inflated). Useful for enumerating paths outside the `assets/` tree (e.g. the structures inside a client jar), then reading them through `readFile`, which handles decompression.

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

## Custom extensions

In a few places the renderer accepts fields that aren't part of vanilla Minecraft's model or item format: ways to pass data from blockstates into models, apply arbitrary tints, mark models double-sided, and a few other things vanilla doesn't expose. They're used internally, but you can set them on your own models and blockstates too.

### Model JSON

| Field | Example | Description |
|---|---|---|
| `x`, `y`, `z` | `90` | Rotation angles (in degrees) applied to the whole model around each axis. Normally set by a blockstate variant, but can be set on a model directly too |
| `uvlock` | `true` | Keep face UVs aligned to world space when the model is rotated by `x`/`y`/`z`. Normally set by a blockstate variant |
| `translation` | `[8, 0, 8]` | `[x, y, z]` translation (in voxel units) applied to the whole model before rendering |
| `scale` | `[0.5, 0.5, 0.5]` | `[x, y, z]` scale applied to the whole model before rendering |
| `transformation` | `{ translation: [0,0,0], scale: [1,1,1], left_rotation: [0,0,0,1], right_rotation: [0,0,0,1] }` | Translation, rotation, and scale applied to the whole model before rendering. Accepts the vanilla item-definition transformation form (translation/rotations/scale) or a flat 16-element matrix array. |
| `ignore_rotations` | `true` | Skip the display rotation for this model |
| `double_sided` | `true` | Render all faces from both sides |
| `tints` | `["#FF0000", "#00FF00"]` | Array of hex colour strings. Faces with a `tintindex` look up their tint from this array |
| `shader` | `{ type: "end_portal", layers: 15 }` | Apply the end portal / end gateway shader to the model |
| `type` | `"block"`, `"item"` | Which texture atlas rules to enforce. Block-type models use only the manually provided display settings. Model-defined displays are ignored since they are meant to apply to items, not blocks |
| `ignore_atlas_restrictions` | `true` | Skip texture atlas membership checks for this model, letting it reference textures from any atlas |
| `version` | `"1.8.9"` | Minecraft version the model is for. Enables era-appropriate behaviour, see [Legacy Minecraft versions](#legacy-minecraft-versions) |

### Blockstate JSON

| Field | Example | Description |
|---|---|---|
| `allow_invalid_rotations` | `true` | Allow variant `x`/`y`/`z` rotation values that aren't multiples of 90 |

### Item components

Extra fields that can be passed through the `components` arg on `renderItem`, or the `data` arg on `parseItemDefinition`. These aren't real Minecraft item components, they stand in for runtime context that the game would normally provide:

| Field | Example | Description |
|---|---|---|
| `team` | `"red"` | Team colour context used by the `team` tint source |
| `context_entity_type` | `"pig"` | The entity type holding the item, used by `context_entity_type` selects |
| `context_dimension` | `"the_nether"` | The dimension the item is rendered in, used by `context_dimension` selects |

Any future non-component select properties vanilla adds will work without renderer updates. The renderer looks up the property by name in `components` and checks whether its value equals any of the select's listed cases, so as long as the property is a plain string and you pass it in `components`, it resolves correctly.

### Default blockstates

Blockstate properties you don't pass to `renderBlock` fall back to sensible defaults (stairs face the camera, campfires are lit, mushroom blocks show caps on all sides). The defaults merge with whatever `blockstates` you do provide, per property. Those rules live in a pack file, so any pack can extend or override them by shipping its own:

```
assets/block-model-renderer/default_blockstates.json
```

```json
{
  "properties": {
    "facing": "north",
    "half": ["bottom", "lower"]
  },
  "blocks": [
    { "match": "*_stairs|*_glazed_terracotta", "defaults": { "facing": "south" } },
    { "match": "my_mod_block", "defaults": { "open": true } }
  ]
}
```

* `properties` are per-property fallbacks used for any block. A value can be an array of candidates tried in order (the first one the blockstate actually has wins)
* `blocks` is an ordered rule list. `match` matches block ids with `*` wildcards and `|` alternatives; the first matching rule's `defaults` are used whole
* Files from every pack merge, higher packs win: per property for `properties`, and higher packs' rules go first for `blocks` (a matching rule in a higher pack completely replaces lower ones)
* The library's own rules ship in its bundled fallback pack at the very bottom of the stack, so anything a pack defines beats them

Lookup order for a property: the `blockstates` option → the first matching `blocks` rule → `properties`.

## License

MIT © [Ewan Howell](https://ewanhowell.com/)
