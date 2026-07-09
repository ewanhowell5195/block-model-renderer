# block-model-renderer

Minecraft block and item model rendering for Node.js and the browser.
Render any block, item, or custom model JSON, with full support for vanilla resource pack features. On Node renders go to image files or buffers; in the browser they go straight to canvases, with live animation players.

[![npm version](https://badge.fury.io/js/block-model-renderer.svg)](https://www.npmjs.com/package/block-model-renderer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

* Renders blocks, items, and custom models from a resource pack
* Runs on Node.js and in the browser from the same package
* Full vanilla model, blockstate, and item-definition support, with accurate lighting and tints
* Texture atlases: membership rules enforced like the game, and atlas-generated sprites (armor trims, unstitched regions) synthesized on the fly
* Hidden-face culling: tell it the neighbouring blocks and the faces they hide are dropped. Near game-accurate, ideal for optimised scenes
* Water and lava with the vanilla surface shaping: corner heights, flow angle, side overlays, and automatic water layers on waterlogged blocks
* Animated textures: WebP and GIF output on Node, live self-updating canvases on web
* Scene optimisation: merge placed blocks into a few atlased, greedily meshed draw calls
* Stack multiple resource packs with higher ones overriding lower ones, just like in Minecraft
* Resource pack zips work directly as asset sources, plus virtual handlers for serving files from anywhere
* Bundled overrides for block entities that Minecraft renders dynamically (banners, chests, heads, and more)
* Custom model loaders for modded formats (OBJ models, connected textures, anything)
* PNG, JPEG, WebP, GIF, and AVIF output on Node

## Install

```bash
npm install block-model-renderer
```

Or in the browser, straight from a CDN (three.js is a peer dependency you provide; see [Using in the browser](docs/browser.md)):

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

## Documentation

The full documentation lives in [`docs/`](docs/):

| Doc | Covers |
|---|---|
| [Rendering](docs/rendering.md) | Culling hidden faces, animated output, backgrounds, display transforms, legacy Minecraft versions |
| [Using in the browser](docs/browser.md) | Providing three.js, rendering to canvases, animation players, web asset sources |
| [Assets](docs/assets.md) | Asset sources, pack layering, virtual handlers, `prepareAssets` and caching, texture atlases, the bundled packs, file access |
| [Fluids](docs/fluids.md) | Water and lava surface shaping, `fluidTypeOf`, `fluidHeights` |
| [Building scenes](docs/scenes.md) | The low-level API: blockstate and item definition parsing, `loadModel`, lighting modes, scene optimisation, helpers |
| [Extending](docs/extending.md) | Non-vanilla model and blockstate fields, default blockstates, custom model loaders |

## API

### `renderBlock(args)`

Renders a block by its id using the resource pack's blockstates and models.

| Option | Default | Description |
|---|---|---|
| `id` | | The block id (e.g. `"oak_log"`, `"stone"`). Namespace optional |
| `assets` | `[]` | The assets source, see [Assets](docs/assets.md) |
| `blockstates` | `{}` | Blockstate property values (e.g. `{ axis: "y", half: "top" }`) |
| `neighbors` | | The blocks surrounding this one; faces they hide are dropped, and fluid surfaces shape themselves from it. See [Culling hidden faces](docs/rendering.md#culling-hidden-faces) and [Fluids](docs/fluids.md) |
| `cull` | | Explicit set of face directions to drop; overrides `neighbors`. See [Culling hidden faces](docs/rendering.md#culling-hidden-faces) |
| `lighting` | `"item"` | Lighting mode (`"item"`, `"world"`, `"scene"`, `"off"`). See [Lighting modes](docs/scenes.md#lighting-modes) |
| `shaderScale` | `1` | Density multiplier for screen-space shader effects (the end portal). The pattern is sized as if the block filled the viewport, so raise this when the block renders small in a larger scene. Exposed as the `Scale` uniform on the shader material, so it can also be updated live |
| `display` | see below | Display transform applied to the rendered block. See [Display transforms](docs/rendering.md#display-transforms) |
| `path` | | Node only. If provided, saves the output to this file path. Format inferred from the extension |
| `format` | | Node only. Output format (`"png"`, `"jpeg"`, `"webp"`, etc.). Overrides extension inference. See [sharp's output docs](https://sharp.pixelplumbing.com/api-output) for the full list of supported formats |
| `output` | | Node only. Options passed directly to the sharp format encoder (e.g. `{ quality: 85 }` for JPEG). See [sharp's output docs](https://sharp.pixelplumbing.com/api-output) for all available options per format. Defaults: JPEG gets `{ mozjpeg: true }`, WebP gets `{ lossless: true }` |
| `canvas`, `x`, `y`, `clear`, `cache`, `cacheBudget`, `pauseOffscreen` | | Web only. See [Using in the browser](docs/browser.md) |
| `width` | `256` | Width of the rendered output image, in pixels |
| `height` | `256` | Height of the rendered output image, in pixels |
| `animated` | `false` | See [Animated output](docs/rendering.md#animated-output) |
| `animatedWidth` | Inherits from `width` | Width of the rendered output image when the output is animated, in pixels |
| `animatedHeight` | Inherits from `height` | Height of the rendered output image when the output is animated, in pixels |
| `animatedOutput` | | Options passed directly to the sharp encoder when the output is animated |
| `maxAnimationFrames` | `4096` | Maximum number of frames in animated output. If a model's textures can't all loop cleanly within this many frames, the loop is truncated and shorter textures may get cut short |
| `ignoreAtlases` | `false` | Render without enforcing texture atlas rules. See [Texture atlases](docs/assets.md#texture-atlases) |
| `version` | | Minecraft version the assets are for. Enables era-appropriate behaviour (see [Legacy Minecraft versions](docs/rendering.md#legacy-minecraft-versions)) |
| `background` | transparent | See [Background](docs/rendering.md#background) |

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
| `components` | `{}` | Item components used by the item definition (e.g. `{ using_item: true }` on a `bow` to show it drawn). See [Item definitions](docs/scenes.md#item-definitions) for what's supported |
| `display` | `{ type: "fallback", display: "gui" }` | Display transform. See [Display transforms](docs/rendering.md#display-transforms) |
| `path`, `format`, `output`, `width`, `height`, `animated`, `animatedWidth`, `animatedHeight`, `animatedOutput`, `maxAnimationFrames`, `ignoreAtlases`, `version`, `background`, `cull`, `lighting`, `shaderScale` | | Same as `renderBlock` |

### `renderModel(args)`

Renders a custom model JSON directly, bypassing blockstate or item definition lookup.

| Option | Default | Description |
|---|---|---|
| `model` | `{}` | A model JSON object (inherits from `parent` if specified, supports all vanilla model features) |
| `assets` | `[]` | The assets source |
| `display` | Same as `renderBlock` | Display transform. See [Display transforms](docs/rendering.md#display-transforms) |
| `path`, `format`, `output`, `width`, `height`, `animated`, `animatedWidth`, `animatedHeight`, `animatedOutput`, `maxAnimationFrames`, `ignoreAtlases`, `version`, `background`, `cull`, `lighting`, `shaderScale` | | Same as `renderBlock` |

### Return value

On Node, all three render functions return:
* A `Uint8Array` (a `Buffer`) when `animated` is `false` (default)
* An object `{ buffer, format }` when `animated` is truthy. The `format` field tells you what was actually produced. For example, `animated: true` produces `"webp"` if the model has animated textures, or `"png"` if it doesn't

On web they return a canvas, or an animation player. See [Using in the browser](docs/browser.md).

## Examples

* [Node examples](https://example.com/node): simple renders, batch-rendering every block and item in a pack, animated output, the bundled overrides, and two worked custom model loaders
* [Web examples](https://example.com/web): a block gallery, a spritesheet grid, a live three.js scene, and an animated model viewer

## License

MIT © [Ewan Howell](https://ewanhowell.com/)
