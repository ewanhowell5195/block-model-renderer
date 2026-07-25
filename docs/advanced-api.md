# Advanced API

Deeper behavior of the [standard render functions](standard-api.md) in the browser: deferring the static-or-animated choice, batch rendering across worker pools, keeping animation clocks in sync across contexts, and the playback machinery behind [players](standard-api.md#animated-renders-browser).

## Upgradable renders

`upgradable: true` returns a **handle** instead of the bare canvas. A fully static scene is still freed the moment the pixels land, as always, but a scene that could have animated is kept alive, so the render can become a player later without redoing any of the work:

```js
const handle = await renderBlock({ id: "magma_block", assets, upgradable: true })
document.body.append(handle.canvas)

handle.toAnimated?.().play()
```

| Member | Description |
|---|---|
| `canvas` | The canvas (or array), exactly what the render would have returned without the option |
| `toAnimated(canvas?)` | Only present when the model animates, so its existence is the "would this animate" check. Builds and returns the [player](standard-api.md#animated-renders-browser) that `animated: true` would have made, painting into the same canvas and placement. Pass `canvas` to send the animation somewhere else instead, taking the same forms as the render's own [`canvas` option](standard-api.md#rendering-to-canvases-browser): one canvas, an array, or descriptors with their own `x`/`y`/`width`/`height`/`clear` (anything an entry leaves out still inherits from the original call). Repeat calls return the same player, and passing canvases to one throws; after `dispose()` it returns `null` |
| `dispose()` | Only present alongside `toAnimated()`. Frees the retained scene, or the player if you upgraded |

When the model turns out fully static the handle is just `{ canvas }`: nothing was retained and there's nothing to upgrade. With `animated: true` the option does nothing (you already have a player), and on Node it's ignored.

[`renderTexture`](standard-api.md#rendertextureargs) takes the option too, upgrading to its simplified [texture player](#texture-players) under the same handle contract. Its `toAnimated(canvas?)` accepts a single replacement canvas, matching its own `canvas` option (no arrays or placement), and an unupgraded handle holds nothing heavy: a texture redraw needs no retained scene.

The point is choosing what animates and when: render everything statically, upgrade only what needs motion, and trigger each upgrade at the moment your app wants it (immediately, scrolled into view, hovered, whatever you decide). Placement renders into a shared canvas each get their own handle, so several models on one canvas upgrade and dispose independently. The flow works from workers too, redirecting the upgrade onto a canvas the main thread hands over; see [Batch rendering from workers](#batch-rendering-from-workers).

An unupgraded handle holds its scene until you call `toAnimated()` or `dispose()`, so like players, upgradable renders are a place the library holds resources: `dispose()` the ones you never upgrade.

## Batch rendering from workers

Standard renders run fine in a worker, and a pool of them keeps batch work off the main thread entirely. Static tiles are simple: render, post an `ImageBitmap` of the canvas back, draw it into the page. Animation needs one more step, since a worker's render lives on a canvas the main thread never receives: animating it in place would drive something nobody is looking at.

[Upgradable renders](#upgradable-renders) bridge that. `!!handle.toAnimated` is the "would this animate" flag to post back with the bitmap, and the upgrade stays worker-side, driven by messages: the main thread creates a fresh canvas, hands it over with `transferControlToOffscreen()`, and the worker calls `toAnimated(thatCanvas)`. The retained scene, materials and schedules are reused, so the tile starts animating without a second render. Note the canvas has to be a fresh one, since `transferControlToOffscreen()` throws on a canvas that already has a rendering context, and the canvas showing the static bitmap has a 2d one. The scene still renders at the original `width`/`height` and the new canvas is only a blit target, so a larger canvas scales the same frames up rather than re-rendering sharper. Output moves rather than duplicating: the original canvas keeps its last static frame and stops updating.

When the upgrade happens immediately rather than on demand, the bitmap round trip can be skipped too: the worker posts back the flag alone, and the main thread answers by transferring its still-blank tile canvas, so the first frame the player draws is the first thing shown. The [gallery example](https://block-model-renderer.ewanhowell.com/gallery/) runs this pattern across its render worker pool, with the clock sync below keeping tiles from different workers in step.

## Retargeting a player

A player's canvases aren't fixed for its lifetime. `setCanvases(canvas)` replaces the set it paints, `addCanvases(canvas)` extends it, and both take the same shapes as the [`canvas` option](standard-api.md#rendering-to-canvases-browser): one canvas, an array, or descriptors with their own `x`/`y`/`width`/`height`/`clear`. Both return the player's new `canvas` value.

```js
const player = await renderItem({ id: "magma_block", assets, animated: true, canvas: [slotA, slotB] })

player.setCanvases([slotC, slotD])                 // same animation, different slots
player.addCanvases({ canvas: sheet, x: 64, y: 0 }) // and also here
```

The scene, textures and schedules are reused, so retargeting costs no render. That makes it the cheap way to follow a UI that moves: a slot grid that reshuffles on every roll, or a panel that closes and reopens somewhere else, keeps one player rather than disposing and rebuilding it each time.

The current frame is painted into new canvases immediately rather than at the next tick, so nothing flashes blank while it waits, and [offscreen pausing](standard-api.md#animated-renders-browser) re-observes the new set, so a player follows visibility to wherever it now draws.

Canvases dropped from the set keep whatever frame they last showed; clear them yourself if you want them blank.

## Syncing the animation clock

The animation clock is per JavaScript context: everything in one context stays in phase with itself, but each context starts its own clock when the library loads, so animations in two contexts sit at different phases. This shows up whenever renders from separate contexts share a screen, a pool of render workers being the usual case: every tile animates correctly, but tiles from different workers tick out of step with each other. [`configure({ clockStart })`](standard-api.md#browser-only-exports) fixes the clock to an absolute epoch (`performance.timeOrigin + performance.now()` scale). Derive one value in the primary context and hand that same number to every other context; a context computing its own just recreates the offset. With one shared value, they all compute the same game-time phase:

```js
const clockStart = performance.timeOrigin + performance.now()

// in every context
configure({ THREE, clockStart })
```

[`pauseAnimations()`](standard-api.md#browser-only-exports) is per context too. To pause everywhere, note the time in the primary context and pause each context; to resume, advance the shared epoch by the paused interval (again, computed once in the primary context) and pass it to `resumeAnimations`. Every context continues seamlessly from the frozen moment, on one exact timeline instead of its own measured pause:

```js
// pausing
pausedAt = performance.timeOrigin + performance.now()
pauseAnimations()             // in every context

// resuming
clockStart += performance.timeOrigin + performance.now() - pausedAt
resumeAnimations(clockStart)  // in every context
```

The [gallery example](https://block-model-renderer.ewanhowell.com/gallery/) runs this pattern across its render worker pool.

## Frame cache

Players cache their rendered frames as they play, so steady-state playback is a single `drawImage` per tick instead of a scene render. Controlled by the `cache` option on the render call:

| Value | Behavior |
|---|---|
| `"auto"` | Default. Cache when one full loop fits the budget (`frames.length × width × height × 4` bytes ≤ the `cacheBudget` option, default 4MB) |
| `true` | Always cache; you've done the memory maths yourself |
| `false` | Never cache, always live-render |

Shader-driven animation (the end portal) never caches in any mode: its frames don't repeat, so there is no loop to cache. Idle players (paused, or scrolled offscreen) drop their cache after 10 seconds and rebuild it lazily when they resume.

## Texture players

[`renderTexture`](standard-api.md#rendertextureargs)'s animated form returns a simplified player: `{ canvas, animated, playing, duration, play(), pause(), dispose() }`. It follows the same rules as the full players: the shared clock (so `pauseAnimations` freezes it), `play()` snapping back onto that clock, `duration` as the loop length in ms, and `animated: false` when the texture turned out static, with everything no-oping and a `duration` of `0`. But a texture redraw is a single `drawImage`, so none of the heavier machinery exists: no frame cache, no offscreen pausing, no `frames` timeline or frame stepping. `dispose()` just ends the redraws; there's nothing on the GPU to free.
