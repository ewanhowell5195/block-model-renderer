# Standard API

The render functions are the same import on Node and in the browser: a conditional export picks the right build automatically, so bundlers and jsDelivr's `+esm` just work. The platforms differ only in what a render produces:

* **Node**: renders return image buffers, and can write files directly with the `path` option. Rendering runs headless (through [gl](https://www.npmjs.com/package/gl) and [headless-three](https://www.npmjs.com/package/headless-three)) and encoding goes through [sharp](https://sharp.pixelplumbing.com/), so any format sharp can write works: PNG, JPEG, WebP, GIF, AVIF, and more
* **Browser**: renders return canvases, and animated renders become live, self-updating [players](#animated-renders-browser): display, not files

Options below are shared unless marked Node or browser; platform-specific options are ignored on the other platform.

## `renderBlock(args)`

Renders a block by its id using the resource pack's blockstates and models.

**What to render:**

| Option | Default | Description |
|---|---|---|
| `id` | required | The block id (e.g. `"oak_log"`, `"stone"`). Namespace optional |
| `assets` | required | The assets source, see [Assets](assets.md) and [Asset sources](#asset-sources) below. Vanilla assets aren't bundled, so provide a base pack |
| `blockstates` | `{}` | Blockstate property values (e.g. `{ axis: "y", half: "top" }`) |
| `nbt` | | Block entity data rendered with the block: an item frame's `{ Item, ItemRotation, Invisible }`, a shelf's `{ Items, align_items_to_bottom }`, or a banner's `{ patterns }` (legacy `Patterns` codes work too). Held items bake in like block geometry, with the item's `fixed`/`on_shelf` display applied; glow frame items render fullbright; `Invisible: 1` drops the frame itself and keeps the item; enchanted items get the [glint](scenes.md#item-definitions) |
| `mapArt` | | `(id, { pos, facing, nbt }) => canvas` for framed maps: return a drawn canvas (any canvas or image type) for the frame's map face, or nothing to render the `filled_map` item in a normal frame instead. `id` is the item's `minecraft:map_id` (`null` when absent); [`renderMapColors`](scenes.md#map-art) turns real save bytes into the canvas. Results cache per map id in the assets cache, first one wins, until [`disposeMapArt`](scenes.md#map-art) |
| `seed` | | Seeded randomness for weighted blockstate variants: a number, and the same seed always picks the same variants. Omit to always take the first variant. The picks don't match the game's per-position randomness |
| `biome` | | Biome tinting for the colormap tints (grass, foliage, dry foliage). Takes one biome, or an array of biomes to blend. A biome is `{ temperature, downfall, tint, combine, weight }`: `temperature`/`downfall` sample the colormap like the game (defaults `0.5`/`1`); `tint` (hex string or number) replaces the sampled color, or folds onto it with `combine: true` using the game's dark-forest formula. Given an array, each biome resolves to its own color first, then the colors are averaged weighted by each biome's `weight` (default `1`, any scale: they are divided by the total), the way the game blends biome borders |

**Appearance:**

| Option | Default | Description |
|---|---|---|
| `display` | see below | Display transform applied to the rendered block. See [Display transforms](models.md#display-transforms) |
| `lighting` | `"item"` | Lighting mode (`"item"`, `"world"`, `"scene"`, `"off"`), or a [world lighting config object](rendering.md#world-lighting) (dimension, daytime, brightness, light volume) |
| `emission` | the block's in-game glow | Floor every element's light emission at this level (0-15), replacing the automatic level: `0` renders a glowing block unlit, `15` keeps a model bright at any `daytime`. See [Lighting modes](rendering.md#lighting-modes) |
| `background` | transparent | See [Background](rendering.md#background) |
| `shaderScale` | `1` | Density multiplier for screen-space shader effects (the end portal). The pattern is sized as if the block filled the viewport, so raise this when the block renders small in a larger scene. Exposed as the `Scale` uniform on the shader material, so it can also be updated live. The material also has an `Aspect` uniform (default `1`): set it to the viewport's width/height ratio on non-square viewports, which anchors the pattern to the viewport height so it neither stretches nor changes size as the width changes |

Default display:
```js
{ rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625], type: "fallback", display: "gui" }
```

**Placement context:**

| Option | Default | Description |
|---|---|---|
| `neighbors` | | The blocks surrounding this one; faces they hide are dropped, and fluid surfaces shape themselves from it. See [Culling hidden faces](culling.md#culling-hidden-faces) and [Fluids](fluids.md) |
| `cull` | | Explicit set of face directions to drop; overrides `neighbors`. See [Culling hidden faces](culling.md#culling-hidden-faces) |

**Asset interpretation:**

| Option | Default | Description |
|---|---|---|
| `version` | | Minecraft version the assets are for. Enables era-appropriate behavior (see [Legacy Minecraft versions](versions.md#legacy-minecraft-versions)) |
| `ignoreAtlases` | `false` | Render without enforcing texture atlas membership rules (which atlas a model's textures may come from) |

**Output size and animation:**

| Option | Default | Description |
|---|---|---|
| `width`, `height` | `256` | Output size in pixels. In the browser, they default to the target canvas's size when a `canvas` is given |
| `animated` | `false` | Node: animated WebP/GIF file output, see [Animated output](#animated-output-node). Browser: return a live [player](#animated-renders-browser) instead of a canvas |
| `maxAnimationFrames` | `4096` | Caps the animation timeline. On Node, the maximum number of frames in animated output: if a model's textures can't all loop cleanly within this many frames, the loop is truncated and shorter textures may get cut short. In the browser it caps the player's `frames` timeline enumeration only |

**File encoding (Node):**

| Option | Default | Description |
|---|---|---|
| `path` | | If provided, saves the output to this file path. Format inferred from the extension |
| `format` | | Output format (`"png"`, `"jpeg"`, `"webp"`, etc.). Overrides extension inference. See [sharp's output docs](https://sharp.pixelplumbing.com/api-output) for the full list of supported formats |
| `output` | | Options passed directly to the sharp format encoder (e.g. `{ quality: 85 }` for JPEG). See [sharp's output docs](https://sharp.pixelplumbing.com/api-output) for all available options per format. Defaults: JPEG gets `{ mozjpeg: true }`, WebP gets `{ lossless: true }` |
| `animatedWidth`, `animatedHeight` | Inherit from `width`/`height` | Output size when the output is animated, in pixels |
| `animatedOutput` | | Options passed directly to the sharp encoder when the output is animated |

**Canvases and players (browser):**

| Option | Default | Description |
|---|---|---|
| `canvas` | | A canvas to draw into, or an array of canvases/descriptors; omit to get a fresh canvas back. See [Rendering to canvases](#rendering-to-canvases-browser) |
| `x`, `y` | | Placement mode: draw into a region of the canvas without resizing or clearing it. See [Rendering to canvases](#rendering-to-canvases-browser) |
| `clear` | `true` | Clear the target rect before drawing. Defaults to `false` in placement mode |
| `cache` | `"auto"` | Player frame caching. See [Frame cache](#frame-cache) |
| `cacheBudget` | `4194304` | Frame cache budget in bytes (4MB). See [Frame cache](#frame-cache) |
| `pauseOffscreen` | `true` | Players pause automatically while scrolled offscreen. See [Animated renders](#animated-renders-browser) |

## `renderItem(args)`

Renders an item by id using its item definition.

| Option | Default | Description |
|---|---|---|
| `id` | required | The item id (e.g. `"diamond_sword"`, `"apple"`). Namespace optional |
| `components` | `{}` | Item components used by the item definition (e.g. `{ using_item: true }` on a `bow` to show it drawn, or `{ enchantments: { sharpness: 5 } }` for the enchantment glint). See [Item definitions](scenes.md#item-definitions) for what's supported |
| `display` | `{ type: "fallback", display: "gui" }` | Same as [`renderBlock`](#renderblockargs), with a plainer default (no rotation or scale) |
| `assets`, `width`, `height`, `background`, `animated`, `maxAnimationFrames`, `lighting`, `emission`, `cull`, `shaderScale`, `ignoreAtlases`, `version`, `path`, `format`, `output`, `animatedWidth`, `animatedHeight`, `animatedOutput`, `canvas`, `x`, `y`, `clear`, `cache`, `cacheBudget`, `pauseOffscreen` | | Same as [`renderBlock`](#renderblockargs) |

## `renderModel(args)`

Renders a custom model JSON directly, bypassing blockstate or item definition lookup.

| Option | Default | Description |
|---|---|---|
| `model` | required | A model JSON object (inherits from `parent` if specified, supports all vanilla model features) |
| `display` | `"gui"` | The model's own gui transform, or none if it doesn't define one. Unlike [`renderBlock`](#renderblockargs) nothing is imposed on a model that carries no transform, so item models render face-on like the game. Pass [`DISPLAYS.block`](models.md#displays) for the isometric look |
| `assets`, `width`, `height`, `background`, `animated`, `maxAnimationFrames`, `lighting`, `emission`, `cull`, `shaderScale`, `ignoreAtlases`, `version`, `path`, `format`, `output`, `animatedWidth`, `animatedHeight`, `animatedOutput`, `canvas`, `x`, `y`, `clear`, `cache`, `cacheBudget`, `pauseOffscreen` | | Same as [`renderBlock`](#renderblockargs) |

## `renderTexture(args)`

Renders a texture on its own: the flat image, pixel-crisp, with animated textures playing per their `.mcmeta`. The texture-drawing counterpart to `renderBlock`, when you want the art rather than a model (see [`readTexture`](assets.md#readtexturepath-assets-opts) for the raw frames instead).

On Node the output goes through the standard pipeline: a buffer back, a file via `path`, animated WebP/GIF via `animated`. In the browser it's a plain 2d canvas draw returning the canvas (the one you passed, or a fresh one); with `animated: true` it returns a simplified [texture player](#texture-players) instead.

| Option | Default | Description |
|---|---|---|
| `texture` | required | The texture path, relative to the pack root (e.g. `"assets/minecraft/textures/block/magma.png"`) |
| `assets` | required | The assets source |
| `width`, `height` | the texture's frame size | Output size. The image scales with nearest-neighbor sampling |
| `tint` | | A color multiplied into the texture, preserving its alpha: a hex string (`"#3F76E4"`) or a dye name (`"red"`). Applies to animated frames too |
| `animated` | `false` | Node: animated WebP/GIF output. Browser: play the texture's animation, returning a [texture player](#texture-players) |
| Node: `path`, `format`, `output`, `background`, `animatedWidth`, `animatedHeight`, `animatedOutput`, `maxAnimationFrames` | | Same as [`renderBlock`](#renderblockargs) |
| Browser: `canvas` | a fresh canvas | Draw into this canvas instead (resized to the output size) |

## Return value

### On Node

All four render functions return a `Buffer` of the encoded image:

```js
const buffer = await renderBlock({ id: "stone", assets })
await fs.promises.writeFile("stone.png", buffer)
```

When `animated` is truthy they return `{ buffer, format }` instead, where `format` tells you what was actually produced:

```js
const { buffer, format } = await renderBlock({ id: "magma_block", assets, animated: true })
format // "webp" (the model had animated textures) or "png" (it didn't, single frame)
```

The buffer is returned whether or not `path` is set, so you can save and post-process in one call.

### In the browser

The three model render functions return a canvas: the one you passed, or a fresh one. If `canvas` was an array, you get the array back. [`renderTexture`](#rendertextureargs) returns its canvas, or its own simplified [texture player](#texture-players) when `animated` is set.

```js
const canvas = await renderBlock({ id: "stone", assets })
document.body.append(canvas)
```

When `animated` is truthy they return a [player](#animated-renders-browser) instead:

```js
const player = await renderBlock({ id: "magma_block", assets, animated: true })
document.body.append(player.canvas)
```

## Animated output (Node)

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

> **Note:** GIF doesn't handle semi-transparent pixels well. For textures like water or nether portals, stick with WebP.

A few mechanics worth knowing:

* **The `path` extension is corrected to match the actual output.** `path: "water.png"` with `animated: true` writes `water.webp` when the model animates (and `water.png` when it doesn't). Passing an explicit `format` disables this and the path is used as given
* **Encoder defaults**: animated WebP is encoded lossless by default. Pass `animatedOutput` to override (e.g. `{ quality: 80, lossless: false }`)
* **Frame budget**: alongside `maxAnimationFrames`, the total decoded animation is capped at roughly 268 million pixels (`frames × width × height`), so very large `animatedWidth`/`animatedHeight` values reduce the frame cap. Loops are truncated to whole cycles of the longest texture where possible
* Interpolated textures (`interpolate` in the mcmeta) render with sub-frame blending, up to 8 blend steps per frame, reduced automatically if the frame budget would overflow

## Rendering to canvases (browser)

```js
import { renderBlock, prepareAssets } from "block-model-renderer"

const assets = await prepareAssets([resourcePackZip])

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

In placement mode `clear` defaults to `false` (the block composites over whatever is in the rect, so your background survives). Pass `clear: true` when re-rendering into the same spot, otherwise the old render shows through the new one's transparent pixels:

```js
// replace slot 0 with a different block: clear wipes the old render first
await renderBlock({ id: "stone", assets, canvas: sheet, width: 128, height: 128, x: 0, y: 0, clear: true })
```

### Multiple canvases

`canvas` also accepts an array: the model renders once and the result is blitted to every canvas, so mirroring the same block in several places costs one render, not N. You get the array back:

```js
const [a, b, c] = await renderBlock({ id: "oak_log", assets, canvas: [a, b, c] })
```

Array entries can also be descriptors with per-canvas placement and draw size:

```js
await renderBlock({
  id: "oak_log", assets,
  width: 128, height: 128,  // render resolution; the scene renders once at this size
  canvas: [
    plain,                                                  // resized to 128x128, render fills it
    { canvas: sheet, x: 256, y: 0 },                        // placed at native size
    { canvas: sheet, x: 0, y: 0, width: 64, height: 64 },   // second rect on the same sheet, scaled down
    { canvas: hud, x: 10, y: 10, width: 512, height: 128 }  // stretch/distort if you want
  ]
})
```

Entry `x`/`y` place that canvas (placement mode for it alone); entry `width`/`height` set its draw size, defaulting to the render size. A draw size that differs from the render size scales through the 2d context, so set `imageSmoothingEnabled` on the canvas yourself to pick crisp vs smooth. Top-level `x`/`y`/`clear` act as inherited defaults for entries that don't specify their own.

The render itself still happens once, at one resolution, and scaled draws reuse it. If you want crisp 1:1 pixels at a different size, that's a separate render call.

## Animated renders (browser)

With `animated: true` the render functions return a **player** instead of a canvas:

```js
const player = await renderBlock({ id: "magma_block", assets, animated: true })
document.body.append(player.canvas)
```

The player keeps painting frames into its canvas on Minecraft's 50ms tick clock. All players share one page-global clock (everything stays in phase, like game time) and one rAF scheduler, and pause automatically while offscreen via IntersectionObserver (opt out with `pauseOffscreen: false`).

The [array `canvas`](#multiple-canvases) form works here too: `player.canvas` is then the array you passed, and the player keeps playing as long as at least one of its canvases is visible.

To freeze everything at once, pause the clock itself with [`pauseAnimations()`](#browser-only-exports) and continue with [`resumeAnimations()`](#browser-only-exports). Unlike `player.pause()` (which snaps back onto the running clock when resumed, to stay in phase with everything else), pausing the clock resumes seamlessly from the frozen moment: every player and [`loadModel`](scenes.md#loadmodelscene-assets-model-args) scene picks up exactly where it stopped, still in phase with each other.

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

`frames` is metadata, not bitmaps. To get a specific frame's image, `player.renderFrame(i)` paints it into `player.canvas`.

Interpolated textures (`interpolate` in the mcmeta) are blended per tick with the exact ratio.

The end portal and end gateway also animate live. Their shader is driven by game time rather than texture frames, so there's no frame timeline (`frames` is empty, `duration` is `0`), but `renderTime(ms)` works and playback advances per game tick.

### Frame cache

Players cache their rendered frames as they play, so steady-state playback is a single `drawImage` per tick instead of a scene render. Controlled by the `cache` option on the render call:

| Value | Behavior |
|---|---|
| `"auto"` | Default. Cache when one full loop fits the budget (`frames.length × width × height × 4` bytes ≤ the `cacheBudget` option, default 4MB) |
| `true` | Always cache; you've done the memory maths yourself |
| `false` | Never cache, always live-render |

Shader-driven animation (the end portal) never caches in any mode: its frames don't repeat, so there is no loop to cache. Idle players (paused, or scrolled offscreen) drop their cache after 10 seconds and rebuild it lazily when they resume.

### Texture players

[`renderTexture`](#rendertextureargs)'s animated form returns a simplified player: `{ canvas, animated, playing, duration, play(), pause(), dispose() }`. It follows the same rules as the full players: the shared clock (so `pauseAnimations` freezes it), `play()` snapping back onto that clock, `duration` as the loop length in ms, and `animated: false` when the texture turned out static, with everything no-oping and a `duration` of `0`. But a texture redraw is a single `drawImage`, so none of the heavier machinery exists: no frame cache, no offscreen pausing, no `frames` timeline or frame stepping. `dispose()` just ends the redraws; there's nothing on the GPU to free.

## Providing three.js (browser)

On Node three.js comes with the package; in the browser it's a peer dependency you supply, resolved lazily on first use:

1. An instance passed via [`configure`](#browser-only-exports) before the first render:
   ```js
   import * as THREE from "three"
   import { configure } from "block-model-renderer"

   configure({ THREE })
   ```
2. `import("three")`, from your bundler install or an import map entry:
   ```html
   <script type="importmap">
     { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js" } }
   </script>
   ```
3. A `THREE` global, if you made one

The recommended version is **0.162.0**, the version the renderer is built and tested against. Other versions from ~0.152 up will probably work, but if a newer three shifts colors or breaks behavior, adjusting for it is on you. Versions below the supported floor technically work too, your mileage may vary: the renderer opts out of modern three's color management and lighting anyway, so on old versions that setup becomes a no-op and core rendering has been seen working fine as far back as r129, but nothing below 0.152 is tested or supported. The instance the library resolved is re-exported (`import { THREE } from "block-model-renderer"`, populated after the first call, or `await getThree()`); build your own scenes from it rather than a second three copy.

## Asset sources

Everything from [Assets](assets.md) works on both platforms; what differs is the conveniences.

### On Node

String paths are Node's convenience on top:

* A **folder path** to an unpacked resource pack
* A **file path** to a `.zip` or `.jar` (a client jar works directly)
* In-memory zips (`Uint8Array`, `ArrayBuffer`, `Blob`, `File`) and virtual handlers

```js
// a folder, a zip/jar path, in-memory bytes, or a layered stack (higher overrides lower)
await renderBlock({ id: "oak_log", assets: "packs/my_pack" })
await renderBlock({ id: "oak_log", assets: "versions/1.21/client.jar" })
await renderBlock({ id: "oak_log", assets: [myPackZipBytes, "packs/base"] })
```

### In the browser

String folder paths don't exist in the browser. Use:

* **Zips**: a `Uint8Array`, `ArrayBuffer`, `Blob`, or `File` entry is detected and unwrapped automatically (a `<input type="file">` file works as-is). Wrapper-folder zips (`MyPack/assets/...`) are handled. [`zipAssets(input)`](assets.md#zipassetsinput) is also exported if you want the handler directly
* **Virtual handlers**: see [Virtual handlers](assets.md#virtual-handlers)

```js
// a pack zip straight from a file input, plus a base pack underneath (higher overrides lower)
const file = document.querySelector("input[type=file]").files[0]
await renderBlock({ id: "oak_log", assets: [file, basePackZipBytes] })
```

The zip reader handles standard stored/deflate zips (what every normal tool produces) but not zip64, encryption, or exotic compression; use a virtual handler for those.

The bundled block entity overrides are fetched once as a single `assets.zip` resolved relative to the module URL (works on jsDelivr and through most bundlers). If yours lives somewhere unusual, or your build inlines the library so the module URL is lost, point at it with [`configure({ assetsUrl })`](#browser-only-exports), e.g. `https://cdn.jsdelivr.net/npm/block-model-renderer/assets.zip`. A failed fetch logs a one-time warning and rendering continues without the bundled entries instead of erroring; the failure isn't cached, and changing `assetsUrl` refetches. Either applies to assets prepared afterwards, while already-prepared assets keep the entries they were built with.

The zip's contents track new Minecraft versions, so loading the library from a major-pinned CDN URL (`block-model-renderer@2`) keeps the bundled packs current on their own; pinning an exact version freezes them where that release left them, and a hand-set `assetsUrl` wants the same treatment. Dropping the version entirely works but is worth avoiding: jsDelivr caches unversioned URLs at the edge and can serve a build several releases old for days after a publish.

With Vite's dev server, for example, the dependency pre-bundler moves the module URL without copying `assets.zip` alongside it, so the fetch quietly fails and the bundled entries drop out. Exclude the library from pre-bundling:

```js
// vite.config.js
export default defineConfig({
  optimizeDeps: {
    exclude: ["block-model-renderer"]
  }
})
```

Vite builds are unaffected, since Rollup resolves the URL itself and emits the zip as an asset. Other bundlers may need their own equivalent, or [`configure({ assetsUrl })`](#browser-only-exports).

Setting [`configure({ assetsUrl: false })`](#browser-only-exports) skips the bundled zip entirely: nothing is fetched, and block entities (chests, banners, beds, shulker boxes...) render from whatever your own assets provide, which for vanilla jars means not at all. The zip also carries the biome colormaps and end sky texture, so tints and end portals degrade to flat colors without it. The small internal fallbacks (the missing-model texture, default blockstate data, atlas definitions) are built into the library and always available.

## Browser-only exports

| Export | Description |
|---|---|
| `configure({ THREE, assetsUrl })` | Optional overrides, call before first use (`three` is accepted too). See [Providing three.js](#providing-threejs-browser) and [Asset sources](#in-the-browser) |
| `getThree()` | Resolves and returns the three instance the library uses. See [Providing three.js](#providing-threejs-browser) |
| `THREE` | The same instance as a live binding (populated after first use) |
| `pauseAnimations()` / `resumeAnimations()` | Pause and resume the page-global animation clock. See [Animated renders](#animated-renders-browser) |
| `createAnimator(root)` | Manual animation control for [`loadModel`](scenes.md#loadmodelscene-assets-model-args) scenes. See [Animation in the browser](scenes.md#animation-browser) |

[`makeModelScene()`](scenes.md#makemodelscene) is async in the browser, since three resolves lazily.

## Going further

* [API reference](api.md): every export in one place
* [Rendering](rendering.md): backgrounds and lighting modes
* [Models](models.md): display transforms, model-inspection helpers, the tint tables
* [Assets](assets.md): pack layering, virtual handlers, [`prepareAssets`](assets.md#prepareassetsassets-options) and caching, the bundled packs
* [Fluids](fluids.md): water and lava surface shaping
* [Building scenes](scenes.md): the low-level API for custom rendering pipelines, hidden-face culling, and scene optimization
* [Extending](extending.md): non-vanilla model fields and custom model loaders
* [Legacy Minecraft versions](versions.md): the `version` option and era-specific behavior
