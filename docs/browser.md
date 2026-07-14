# Standard API: Browser

In the browser the render functions return canvases, and animated renders become live, self-updating players: display, not files. The browser build is picked automatically via a conditional export, so bundlers and jsDelivr's `+esm` just work.

This page is the browser version of the API; the Node version (file and buffer output) lives in [Standard API: Node](node.md).

## `renderBlock(args)`

Renders a block by its id using the resource pack's blockstates and models.

| Option | Default | Description |
|---|---|---|
| `id` | required | The block id (e.g. `"oak_log"`, `"stone"`). Namespace optional |
| `assets` | required | The assets source, see [Assets](assets.md) and [Asset sources](#asset-sources). Vanilla assets aren't bundled, so provide a base pack |
| `blockstates` | `{}` | Blockstate property values (e.g. `{ axis: "y", half: "top" }`) |
| `seed` | | Seeded randomness for weighted blockstate variants: a number, and the same seed always picks the same variants. Omit to always take the first variant. The picks don't match the game's per-position randomness |
| `width` | `256` | Render width in pixels. Defaults to the target canvas's size when a `canvas` is given |
| `height` | `256` | Render height in pixels, same defaulting as `width` |
| `canvas` | | A canvas to draw into, or an array of canvases/descriptors; omit to get a fresh canvas back. See [Rendering to canvases](#rendering-to-canvases) |
| `x`, `y` | | Placement mode: draw into a region of the canvas without resizing or clearing it. See [Rendering to canvases](#rendering-to-canvases) |
| `clear` | `true` | Clear the target rect before drawing. Defaults to `false` in placement mode |
| `background` | transparent | See [Background](rendering.md#background) |
| `display` | see below | Display transform applied to the rendered block. See [Display transforms](models.md#display-transforms) |
| `animated` | `false` | Return a live [player](#animated-renders) instead of a canvas |
| `cache` | `"auto"` | Player frame caching. See [Frame cache](#frame-cache) |
| `cacheBudget` | `4194304` | Frame cache budget in bytes (4MB). See [Frame cache](#frame-cache) |
| `pauseOffscreen` | `true` | Players pause automatically while scrolled offscreen. See [Animated renders](#animated-renders) |
| `maxAnimationFrames` | `4096` | Caps the player's `frames` timeline enumeration. See [Animated renders](#animated-renders) |
| `lighting` | `"item"` | Lighting mode (`"item"`, `"world"`, `"scene"`, `"off"`). See [Lighting modes](rendering.md#lighting-modes) |
| `daytime` | `"noon"` | `"world"` mode sky brightness: a tick `0`-`23999` or a name (`"day"`, `"noon"`, `"sunset"`, `"night"`, `"midnight"`, `"sunrise"`). Exposed live as `scene.userData.daytime`. See [Lighting modes](rendering.md#lighting-modes) |
| `blockLightTint` | `#FFD88C` | `"world"` mode torchlight color. See [Lighting modes](rendering.md#lighting-modes) |
| `nightSkyTint` | `#7A7AFF` | `"world"` mode moonlight color. See [Lighting modes](rendering.md#lighting-modes) |
| `neighbors` | | The blocks surrounding this one; faces they hide are dropped, and fluid surfaces shape themselves from it. See [Culling hidden faces](scenes.md#culling-hidden-faces) and [Fluids](fluids.md) |
| `cull` | | Explicit set of face directions to drop; overrides `neighbors`. See [Culling hidden faces](scenes.md#culling-hidden-faces) |
| `shaderScale` | `1` | Density multiplier for screen-space shader effects (the end portal). The pattern is sized as if the block filled the viewport, so raise this when the block renders small in a larger scene. Exposed as the `Scale` uniform on the shader material, so it can also be updated live. The material also has an `Aspect` uniform (default `1`): set it to the viewport's width/height ratio on non-square viewports, which anchors the pattern to the viewport height so it neither stretches nor changes size as the width changes |
| `ignoreAtlases` | `false` | Render without enforcing texture atlas membership rules (which atlas a model's textures may come from) |
| `version` | | Minecraft version the assets are for. Enables era-appropriate behavior (see [Legacy Minecraft versions](versions.md#legacy-minecraft-versions)) |

Default display:
```js
{ rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625], type: "fallback", display: "gui" }
```

## `renderItem(args)`

Renders an item by id using its item definition.

| Option | Default | Description |
|---|---|---|
| `id` | required | The item id (e.g. `"diamond_sword"`, `"apple"`). Namespace optional |
| `components` | `{}` | Item components used by the item definition (e.g. `{ using_item: true }` on a `bow` to show it drawn). See [Item definitions](scenes.md#item-definitions) for what's supported |
| `display` | `{ type: "fallback", display: "gui" }` | Same as [`renderBlock`](api.md), with a plainer default (no rotation or scale) |
| `assets`, `width`, `height`, `canvas`, `x`, `y`, `clear`, `background`, `animated`, `cache`, `cacheBudget`, `pauseOffscreen`, `maxAnimationFrames`, `lighting`, `daytime`, `blockLightTint`, `nightSkyTint`, `cull`, `shaderScale`, `ignoreAtlases`, `version` | | Same as [`renderBlock`](api.md) |

## `renderModel(args)`

Renders a custom model JSON directly, bypassing blockstate or item definition lookup.

| Option | Default | Description |
|---|---|---|
| `model` | required | A model JSON object (inherits from `parent` if specified, supports all vanilla model features) |
| `assets`, `width`, `height`, `canvas`, `x`, `y`, `clear`, `background`, `display`, `animated`, `cache`, `cacheBudget`, `pauseOffscreen`, `maxAnimationFrames`, `lighting`, `daytime`, `blockLightTint`, `nightSkyTint`, `cull`, `shaderScale`, `ignoreAtlases`, `version` | | Same as [`renderBlock`](api.md) |

## Return value

All three render functions return a canvas: the one you passed, or a fresh one (if `canvas` was an array, you get the array back):

```js
const canvas = await renderBlock({ id: "stone", assets })
document.body.append(canvas)
```

When `animated` is truthy they return a [player](#animated-renders) instead:

```js
const player = await renderBlock({ id: "magma_block", assets, animated: true })
document.body.append(player.canvas)
```

## Providing three.js

three is a peer dependency you supply, resolved lazily on first use:

1. An instance passed via [`configure`](api.md) before the first render:
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
3. A [`THREE`](api.md) global, if you made one

The recommended version is **0.162.0**, the version the renderer is built and tested against. Other versions from ~0.152 up will probably work, but if a newer three shifts colors or breaks behavior, adjusting for it is on you. Versions below the supported floor technically work too, your mileage may vary: the renderer opts out of modern three's color management and lighting anyway, so on old versions that setup becomes a no-op and core rendering has been seen working fine as far back as r129, but nothing below 0.152 is tested or supported. The instance the library resolved is re-exported (`import { THREE } from "block-model-renderer"`, populated after the first call, or `await getThree()`); build your own scenes from it rather than a second three copy.

## Rendering to canvases

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

## Animated renders

With `animated: true` the render functions return a **player** instead of a canvas:

```js
const player = await renderBlock({ id: "magma_block", assets, animated: true })
document.body.append(player.canvas)
```

The player keeps painting frames into its canvas on Minecraft's 50ms tick clock. All players share one page-global clock (everything stays in phase, like game time) and one rAF scheduler, and pause automatically while offscreen via IntersectionObserver (opt out with `pauseOffscreen: false`).

The [array `canvas`](#multiple-canvases) form works here too: `player.canvas` is then the array you passed, and the player keeps playing as long as at least one of its canvases is visible.

To freeze everything at once, pause the clock itself with [`pauseAnimations()`](api.md) and continue with [`resumeAnimations()`](api.md). Unlike `player.pause()` (which snaps back onto the running clock when resumed, to stay in phase with everything else), pausing the clock resumes seamlessly from the frozen moment: every player and [`loadModel`](api.md) scene picks up exactly where it stopped, still in phase with each other.

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
| `"auto"` | Default. Cache when one full loop fits the budget (`frames.length × width × height × 4` bytes ≤ the `cacheBudget` option, default 4MB). Shader-driven animation (end portal) never caches |
| `true` | Always cache; you've done the memory maths yourself |
| `false` | Never cache, always live-render |

Idle players (paused, or scrolled offscreen) drop their cache after 10 seconds and rebuild it lazily when they resume.

## Asset sources

String folder paths don't exist in the browser. Use:

* **Zips**: a `Uint8Array`, `ArrayBuffer`, `Blob`, or `File` entry is detected and unwrapped automatically (a `<input type="file">` file works as-is). Wrapper-folder zips (`MyPack/assets/...`) are handled. [`zipAssets(input)`](api.md) is also exported if you want the handler directly
* **Virtual handlers**: see [Virtual handlers](assets.md#virtual-handlers)

```js
// a pack zip straight from a file input, plus a base pack underneath (higher overrides lower)
const file = document.querySelector("input[type=file]").files[0]
await renderBlock({ id: "oak_log", assets: [file, basePackZipBytes] })
```

The zip reader handles standard stored/deflate zips (what every normal tool produces) but not zip64, encryption, or exotic compression; use a virtual handler for those.

The bundled block entity overrides are fetched once as a single `assets.zip` resolved relative to the module URL (works on jsDelivr and through most bundlers). If yours lives somewhere unusual, or your build inlines the library so the module URL is lost, point at it with [`configure({ assetsUrl })`](api.md), e.g. `https://cdn.jsdelivr.net/npm/block-model-renderer/assets.zip`. A failed fetch logs a one-time warning and rendering continues without the bundled entries instead of erroring; the failure isn't cached, and changing `assetsUrl` refetches. Either applies to assets prepared afterwards, while already-prepared bundles keep the entries they were built with.

Setting `configure({ assetsUrl: false })` skips the bundled zip entirely: nothing is fetched, and block entities (chests, banners, beds, shulker boxes...) render from whatever your own assets provide, which for vanilla jars means not at all. The zip also carries the biome colormaps and end sky texture, so tints and end portals degrade to flat colors without it. The small internal fallbacks (the missing-model texture, default blockstate data, atlas definitions) are built into the library and always available.

## Browser-only exports

| Export | Description |
|---|---|
| [`configure({ THREE, assetsUrl })`](api.md) | Optional overrides, call before first use (`three` is accepted too) |
| [`getThree()`](api.md) | Resolves and returns the three instance the library uses |
| [`THREE`](api.md) | The same instance as a live binding (populated after first use) |
| [`pauseAnimations()`](api.md) / [`resumeAnimations()`](api.md) | Pause and resume the page-global animation clock. See [Animated renders](#animated-renders) |
| [`createAnimator(root)`](api.md) | Manual animation control for [`loadModel`](api.md) scenes. See [Animation in the browser](scenes.md#animation-browser) |

[`makeModelScene()`](api.md) is async in the browser, since three resolves lazily.

## Going further

* [API reference](api.md): every export in one place
* [Rendering](rendering.md): backgrounds and lighting modes
* [Models](models.md): display transforms, model-inspection helpers, the tint tables
* [Assets](assets.md): pack layering, virtual handlers, [`prepareAssets`](api.md) and caching, the bundled packs
* [Fluids](fluids.md): water and lava surface shaping
* [Building scenes](scenes.md): the low-level API for custom rendering pipelines, hidden-face culling, and scene optimization
* [Extending](extending.md): non-vanilla model fields and custom model loaders
* [Legacy Minecraft versions](versions.md): the `version` option and era-specific behavior
