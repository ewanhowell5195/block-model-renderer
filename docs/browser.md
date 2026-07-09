# Using in the browser

The same package runs in the browser via a conditional export, so bundlers and jsDelivr's `+esm` pick the web build automatically. The goal on web is **display, not files**: renders go into canvases, and animated renders become live players. The `path`, `format`, `output`, `animatedOutput`, `animatedWidth`, and `animatedHeight` options don't exist on web (call `canvas.toBlob()` yourself if you want bytes).

## Providing three.js

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

## Rendering to canvases

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

## Animated renders

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

### Frame cache

Players cache their rendered frames as they play, so steady-state playback is a single `drawImage` per tick instead of a scene render. Controlled by the `cache` option on the render call:

| Value | Behaviour |
|---|---|
| `"auto"` | Default. Cache when one full loop fits the budget (`frames.length × width × height × 4` bytes ≤ the `cacheBudget` option, default 4MB). Shader-driven animation (end portal) never caches |
| `true` | Always cache; you've done the memory maths yourself |
| `false` | Never cache, always live-render |

Idle players (paused, or scrolled offscreen) drop their cache after 10 seconds and rebuild it lazily when they resume.

### Multiple canvases

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

## Asset sources on web

String folder paths don't exist in the browser. Use:

* **Zips**: a `Uint8Array`, `ArrayBuffer`, `Blob`, or `File` entry is detected and unwrapped automatically (a `<input type="file">` file works as-is). Wrapper-folder zips (`MyPack/assets/...`) are handled. `zipAssets(input)` is also exported if you want the handler directly
* **Virtual handlers**: same as Node, see [Virtual handlers](assets.md#virtual-handlers)

The zip reader handles standard stored/deflate zips (what every normal tool produces) but not zip64, encryption, or exotic compression; use a virtual handler for those.

The bundled block entity overrides are fetched once as a single `assets.zip` resolved relative to the module URL (works on jsDelivr and through bundlers). If yours lives somewhere unusual, point at it with `configure({ assetsUrl })`.

## Web-only exports

| Export | Description |
|---|---|
| `configure({ three, assetsUrl })` | Optional overrides, call before first use |
| `getThree()` | Resolves and returns the three instance the library uses |
| `THREE` | The same instance as a live binding (populated after first use) |
| `pauseAnimations()` / `resumeAnimations()` | Pause and resume the page-global animation clock. See [Animated renders](#animated-renders) |
| `createAnimator(root)` | Manual animation control for `loadModel` scenes. See [Animation on web](scenes.md#animation-web) |

`makeModelScene()` is async on web (three resolves lazily), unlike Node where it's sync.
