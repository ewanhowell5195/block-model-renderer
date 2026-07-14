# block-model-renderer

Minecraft block and item model rendering for Node.js and the browser.
Render any block, item, or custom model JSON, with full support for vanilla resource pack features. On Node renders go to image files or buffers; in the browser they go straight to canvases, with live animation players.

[![npm version](https://badge.fury.io/js/block-model-renderer.svg)](https://www.npmjs.com/package/block-model-renderer)
[![jsDelivr](https://data.jsdelivr.com/v1/package/npm/block-model-renderer/badge)](https://www.jsdelivr.com/package/npm/block-model-renderer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[**Live Examples**](https://block-model-renderer.ewanhowell.com/)

## Features

* Renders blocks, items, and custom models from a resource pack
* Runs on Node.js and in the browser from the same package
* Full vanilla model, blockstate, item-definition, and texture atlas support, with accurate lighting and tints
* Bundled overrides for block entities that Minecraft renders dynamically (banners, chests, heads, etc)
* Stack resource pack folders, zips, and virtual handlers, with higher packs overriding lower ones just like in Minecraft
* Animated textures: WebP and GIF output on Node, live self-updating canvases in the browser
* Scene optimization: near game-accurate hidden-face culling from neighboring blocks, and the whole scene merged into a handful of draw calls, with far fewer polygons
* Extensible model loaders: write your own to support modded formats (OBJ models, connected textures, etc)
* PNG, JPEG, WebP, GIF, and AVIF output on Node

## Install

For Node.js, or the browser through a bundler:

```bash
npm install block-model-renderer
```

Or in the browser, import it straight from a [CDN](https://www.jsdelivr.com/package/npm/block-model-renderer):

```js
import { renderBlock } from "https://cdn.jsdelivr.net/npm/block-model-renderer@latest/+esm"
```

In the browser you also provide three.js yourself; see [Standard API: Browser](docs/browser.md).

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

And in the browser, where renders go into canvases:

```js
import { renderBlock, prepareAssets } from "block-model-renderer"

// a resource pack zip from a file input, fetch, anywhere
const assets = await prepareAssets([zipFileOrBuffer])

// returns a canvas you can append
const canvas = await renderBlock({ id: "oak_log", assets, width: 128, height: 128 })
document.body.append(canvas)

// animated renders return a live, self-updating player
const player = await renderBlock({ id: "magma_block", assets, animated: true })
document.body.append(player.canvas)
```

### Options

A quick preview of the most-used [`renderBlock`](docs/api.md) options (full lists, and [`renderItem`](docs/api.md)/[`renderModel`](docs/api.md), in [Standard API: Node](docs/node.md) and [Standard API: Browser](docs/browser.md)):

| Option | Default | Description |
|---|---|---|
| `id` | required | The block id (e.g. `"oak_log"`, `"stone"`) |
| `assets` | required | The assets source: pack folders, zips, virtual handlers, or a layered stack of them. Vanilla assets aren't bundled, so provide a base pack. See [Assets](docs/assets.md) |
| `blockstates` | `{}` | Blockstate property values (e.g. `{ axis: "y", half: "top" }`) |
| `width`, `height` | `256` | Output size in pixels |
| `path` | | Node: save the output to this file path |
| `canvas` | | Browser: a canvas (or several) to draw into |
| `background` | transparent | Background color |
| `display` | the gui view | Display transform: a model display context (`"gui"`, `"fixed"`, etc) or custom rotation/translation/scale. See [Display transforms](docs/models.md#display-transforms) |
| `animated` | `false` | Animated WebP/GIF on Node, a live player in the browser |

## Documentation

The full documentation lives in [`docs/`](docs/):

| Doc | Covers |
|---|---|
| [API reference](docs/api.md) | Every export in one place, grouped and linked to its full docs |
| [Standard API: Node](docs/node.md) | The render functions on Node: all options, file and buffer output, animated WebP/GIF |
| [Standard API: Browser](docs/browser.md) | The render functions in the browser: all options, canvases, animation players, providing three.js |
| [Rendering](docs/rendering.md) | How a render looks: backgrounds and lighting modes |
| [Models](docs/models.md) | Model-level behavior: display transforms, model-inspection helpers, the tint tables |
| [Assets](docs/assets.md) | Asset sources, pack layering, virtual handlers, [`prepareAssets`](docs/api.md) and caching, the bundled packs, file access |
| [Fluids](docs/fluids.md) | Water and lava surface shaping, [`fluidTypeOf`](docs/api.md), [`fluidHeights`](docs/api.md) |
| [Building scenes](docs/scenes.md) | The low-level API: blockstate and item definition parsing, [`loadModel`](docs/api.md), hidden-face culling, scene optimization |
| [Extending](docs/extending.md) | Non-vanilla model and blockstate fields, default blockstates, custom model loaders |
| [Legacy Minecraft versions](docs/versions.md) | The `version` option and the era-specific behavior it enables |

## Examples

Everything on the live pages runs in your browser, on the latest vanilla Minecraft assets:

* [Live Examples](https://block-model-renderer.ewanhowell.com/): the main demo page, every feature rendered live
* [Model Viewer](https://block-model-renderer.ewanhowell.com/viewer/): inspect any block or item up close: blockstates, display transforms, lighting modes, culling, wireframe
* [Render Gallery](https://block-model-renderer.ewanhowell.com/gallery/): batch-render blocks straight to canvases, with live animation players
* [Rotating Grid](https://block-model-renderer.ewanhowell.com/grid/): an endless scrolling wall of spinning blocks and items
* [Scenes](https://block-model-renderer.ewanhowell.com/scene/): voxel dioramas with neighbor-aware culling, fluid surface shaping, and world lighting
* [Structure Viewer](https://structure-viewer.ewanhowell.com/): a full website built on the library: browse every vanilla structure, open your own `.nbt` files, and walk around inside builds
* [Node examples](examples/node): simple renders, batch-rendering every block and item in a pack, animated output, the bundled overrides, and two worked custom model loaders

## License

MIT © [Ewan Howell](https://ewanhowell.com/)
