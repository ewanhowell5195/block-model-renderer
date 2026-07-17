# Standard API: Node

On Node the render functions return image buffers, and can write files directly with the `path` option. Rendering runs headless (through [gl](https://www.npmjs.com/package/gl) and [headless-three](https://www.npmjs.com/package/headless-three)) and encoding goes through [sharp](https://sharp.pixelplumbing.com/), so any format sharp can write works here: PNG, JPEG, WebP, GIF, AVIF, and more.

This page is the Node version of the API; the browser version (canvases and live players) lives in [Standard API: Browser](browser.md).

## `renderBlock(args)`

Renders a block by its id using the resource pack's blockstates and models.

| Option | Default | Description |
|---|---|---|
| `id` | required | The block id (e.g. `"oak_log"`, `"stone"`). Namespace optional |
| `assets` | required | The assets source, see [Assets](assets.md). Vanilla assets aren't bundled, so provide a base pack |
| `blockstates` | `{}` | Blockstate property values (e.g. `{ axis: "y", half: "top" }`) |
| `seed` | | Seeded randomness for weighted blockstate variants: a number, and the same seed always picks the same variants. Omit to always take the first variant. The picks don't match the game's per-position randomness |
| `biome` | | Biome tinting for the colormap tints (grass, foliage, dry foliage). Takes one biome, or an array of biomes to blend. A biome is `{ temperature, downfall, tint, combine, weight }`: `temperature`/`downfall` sample the colormap like the game (defaults `0.5`/`1`); `tint` (hex string or number) replaces the sampled color, or folds onto it with `combine: true` using the game's dark-forest formula. Given an array, each biome resolves to its own color first, then the colors are averaged weighted by each biome's `weight` (default `1`, any scale: they are divided by the total), the way the game blends biome borders |
| `width` | `256` | Width of the rendered output image, in pixels |
| `height` | `256` | Height of the rendered output image, in pixels |
| `path` | | If provided, saves the output to this file path. Format inferred from the extension |
| `format` | | Output format (`"png"`, `"jpeg"`, `"webp"`, etc.). Overrides extension inference. See [sharp's output docs](https://sharp.pixelplumbing.com/api-output) for the full list of supported formats |
| `output` | | Options passed directly to the sharp format encoder (e.g. `{ quality: 85 }` for JPEG). See [sharp's output docs](https://sharp.pixelplumbing.com/api-output) for all available options per format. Defaults: JPEG gets `{ mozjpeg: true }`, WebP gets `{ lossless: true }` |
| `background` | transparent | See [Background](rendering.md#background) |
| `display` | see below | Display transform applied to the rendered block. See [Display transforms](models.md#display-transforms) |
| `animated` | `false` | See [Animated output](#animated-output) |
| `animatedWidth` | Inherits from `width` | Width of the rendered output image when the output is animated, in pixels |
| `animatedHeight` | Inherits from `height` | Height of the rendered output image when the output is animated, in pixels |
| `animatedOutput` | | Options passed directly to the sharp encoder when the output is animated |
| `maxAnimationFrames` | `4096` | Maximum number of frames in animated output. If a model's textures can't all loop cleanly within this many frames, the loop is truncated and shorter textures may get cut short |
| `lighting` | `"item"` | Lighting mode (`"item"`, `"world"`, `"scene"`, `"off"`), or a [world lighting config object](rendering.md#world-lighting) (dimension, daytime, brightness, light volume) |
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
| `assets`, `width`, `height`, `path`, `format`, `output`, `background`, `animated`, `animatedWidth`, `animatedHeight`, `animatedOutput`, `maxAnimationFrames`, `lighting`, `cull`, `shaderScale`, `ignoreAtlases`, `version` | | Same as [`renderBlock`](api.md) |

## `renderModel(args)`

Renders a custom model JSON directly, bypassing blockstate or item definition lookup.

| Option | Default | Description |
|---|---|---|
| `model` | required | A model JSON object (inherits from `parent` if specified, supports all vanilla model features) |
| `assets`, `width`, `height`, `path`, `format`, `output`, `background`, `display`, `animated`, `animatedWidth`, `animatedHeight`, `animatedOutput`, `maxAnimationFrames`, `lighting`, `cull`, `shaderScale`, `ignoreAtlases`, `version` | | Same as [`renderBlock`](api.md) |

## `renderTexture(args)`

Renders a texture on its own: the flat image, pixel-crisp, with animated textures playing per their `.mcmeta`. The texture-drawing counterpart to `renderBlock`, when you want the art rather than a model (see [`readTexture`](assets.md#readtexturepath-assets-opts) for the raw frames instead).

| Option | Default | Description |
|---|---|---|
| `texture` | required | The texture path, relative to the pack root (e.g. `"assets/minecraft/textures/block/magma.png"`) |
| `width`, `height` | the texture's frame size | Output size. The image scales with nearest-neighbor sampling |
| `assets`, `path`, `format`, `output`, `background`, `canvas`, `animated`, `animatedWidth`, `animatedHeight`, `animatedOutput`, `maxAnimationFrames` | | Same as [`renderBlock`](api.md) |

## Return value

All three render functions return a `Uint8Array` (a `Buffer`) of the encoded image:

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

> **Note:** GIF doesn't handle semi-transparent pixels well. For textures like water or nether portals, stick with WebP.

A few mechanics worth knowing:

* **The `path` extension is corrected to match the actual output.** `path: "water.png"` with `animated: true` writes `water.webp` when the model animates (and `water.png` when it doesn't). Passing an explicit `format` disables this and the path is used as given
* **Encoder defaults**: animated WebP is encoded lossless by default. Pass `animatedOutput` to override (e.g. `{ quality: 80, lossless: false }`)
* **Frame budget**: alongside `maxAnimationFrames`, the total decoded animation is capped at roughly 268 million pixels (`frames × width × height`), so very large `animatedWidth`/`animatedHeight` values reduce the frame cap. Loops are truncated to whole cycles of the longest texture where possible
* Interpolated textures (`interpolate` in the mcmeta) render with sub-frame blending, up to 8 blend steps per frame, reduced automatically if the frame budget would overflow

## Asset sources

Everything from [Assets](assets.md) works, and string paths are Node's convenience on top:

* A **folder path** to an unpacked resource pack
* A **file path** to a `.zip` or `.jar` (a client jar works directly)
* In-memory zips (`Uint8Array`, `ArrayBuffer`, `Blob`, `File`) and virtual handlers

```js
// a folder, a zip/jar path, in-memory bytes, or a layered stack (higher overrides lower)
await renderBlock({ id: "oak_log", assets: "packs/my_pack" })
await renderBlock({ id: "oak_log", assets: "versions/1.21/client.jar" })
await renderBlock({ id: "oak_log", assets: [myPackZipBytes, "packs/base"] })
```

## Going further

* [API reference](api.md): every export in one place
* [Rendering](rendering.md): backgrounds and lighting modes
* [Models](models.md): display transforms, model-inspection helpers, the tint tables
* [Assets](assets.md): pack layering, virtual handlers, [`prepareAssets`](api.md) and caching, the bundled packs
* [Fluids](fluids.md): water and lava surface shaping
* [Building scenes](scenes.md): the low-level API for custom rendering pipelines, hidden-face culling, and scene optimization
* [Extending](extending.md): non-vanilla model fields and custom model loaders
* [Legacy Minecraft versions](versions.md): the `version` option and era-specific behavior
