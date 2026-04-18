# block-model-renderer

Minecraft block and item rendering for Node.js.
Render any block, item, or custom model JSON to an image, with full support for vanilla resource pack features.

[![npm version](https://badge.fury.io/js/block-model-renderer.svg)](https://www.npmjs.com/package/block-model-renderer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

* Renders blocks, items, and custom models from a resource pack
* Full vanilla model, blockstate, and item-definition support, with accurate lighting and tints
* Animated textures with GIF and WebP output
* Stack multiple resource packs with higher ones overriding lower ones, just like Minecraft
* Virtual asset handlers, serve files from memory, zips, HTTP, anywhere
* Bundled overrides for block entities that Minecraft renders dynamically (signs, banners, chests, heads, and more)
* PNG, JPEG, WebP, and AVIF output

## Install

```bash
npm install block-model-renderer
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
| `id` | `""` | The block id (e.g. `"oak_log"`, `"stone"`). Namespace optional |
| `assets` | `[]` | The assets source, see [Assets](#assets) |
| `blockstates` | `{}` | Blockstate property values (e.g. `{ axis: "y", half: "top" }`) |
| `display` | see below | Display transform applied to the rendered block. See [Display transforms](#display-transforms) |
| `path` | | If provided, saves the output to this file path. Format inferred from the extension |
| `format` | | Output format (`"png"`, `"jpeg"`, `"webp"`, etc.). Overrides extension inference |
| `width` | `1024` | Output width in pixels |
| `height` | `1024` | Output height in pixels |
| `animated` | `false` | See [Animated output](#animated-output) |
| `animatedWidth` | Inherits from `width` | Width used when the output is animated |
| `animatedHeight` | Inherits from `height` | Height used when the output is animated |
| `background` | transparent | See [Background](#background) |

Default display:
```js
{ rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625], type: "fallback", display: "gui" }
```

### `renderItem(args)`

Renders an item by id using its item definition.

| Option | Default | Description |
|---|---|---|
| `id` | `""` | The item id (e.g. `"diamond_sword"`, `"apple"`). Namespace optional |
| `assets` | `[]` | The assets source |
| `properties` | `{}` | Item components used by the item definition (e.g. `minecraft:damage`, `minecraft:enchantments`) |
| `display` | `{ type: "fallback", display: "gui" }` | Display transform. See [Display transforms](#display-transforms) |
| `path`, `format`, `width`, `height`, `animated`, `animatedWidth`, `animatedHeight`, `background` | | Same as `renderBlock` |

### `renderModel(args)`

Renders a custom model JSON directly, bypassing blockstate or item definition lookup.

| Option | Default | Description |
|---|---|---|
| `model` | `{}` | A model JSON object (inherits from `parent` if specified, supports all vanilla model features) |
| `assets` | `[]` | The assets source |
| `display` | Same as `renderBlock` | Display transform. See [Display transforms](#display-transforms) |
| `path`, `format`, `width`, `height`, `animated`, `animatedWidth`, `animatedHeight`, `background` | | Same as `renderBlock` |

### Return value

All three render functions return:
* A `Buffer` when `animated` is `false` (default)
* An object `{ buffer, format }` when `animated` is truthy. The `format` field tells you what was actually produced. For example, `animated: true` produces `"gif"` if the model has animated textures, or `"png"` if it doesn't

## Assets

The `assets` option tells the renderer where to find resource pack files. It can be any of:

* A **string**, a path to a resource pack folder on disk
* A **prepared handle**, an array returned by `prepareAssets()`
* A **virtual handler object**, see [Virtual handlers](#virtual-handlers)
* An **array** of any combination of the above

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
| `list(dir)` | conditional | Return an array of filenames in the given directory. Required if you use the `listDirectory` function |
| `filter(filePath)` | no | Return `true` to hide this file from lower-priority entries |

### `prepareAssets(assets)`

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
* Signs
* Water & Lava
* Technical blocks (barrier, light, structure void, moving piston)

### Limitation

The overrides pack is prepended to your assets array at the highest priority. Any blockstate or model covered by it will override whatever your own packs provide, the bundled version always wins. This is a renderer limitation, not a design choice. That said, since these blocks are rendered dynamically by vanilla, you're very unlikely to actually have modified these files.

## Animated output

Minecraft textures with an accompanying `.mcmeta` animation block are supported out of the box. When the model uses animated textures, enable animated output with `animated: true`:

```js
await renderBlock({
  id: "magma_block",
  assets,
  animated: true,
  path: "magma_block.gif"
})
```

| Value | Result |
|---|---|
| `false` | Single-frame PNG (default). Renders frame 0 of any animated textures |
| `true` | GIF if the model has animated textures, PNG otherwise |
| `"gif"` | Same as `true` |
| `"webp"` | WebP if the model has animated textures, PNG otherwise (recommended for translucent content) |

> **Note:** GIF doesn't handle semi-transparent pixels well. For textures like water, kelp, or fire, use `animated: "webp"` for correct output.

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

**String** - name of a context in the model's `display` block (`"gui"`, `"fixed"`, `"ground"`, `"firstperson_righthand"`, etc.). The renderer uses that context's transform from the model.

```js
display: "firstperson_righthand"
```

**Plain transform** - an object with `rotation`, `translation`, and/or `scale`. Applied directly, ignoring anything the model defines.

```js
display: { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] }
```

**Fallback transform** - add `type: "fallback"` to a plain transform to first try the model's own `display` for a named context (`display: "gui"` by default), falling back to the object's own `rotation`/`translation`/`scale` if the model doesn't define that context.

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

## Low-level API

For custom rendering pipelines, lower-level functions are available.

### `parseBlockstate(assets, id, args?)`

Resolves a blockstate to a list of model references, picking variants or multipart cases based on the given property values.

| Argument | Description |
|---|---|
| `assets` | The assets source |
| `id` | The blockstate id |
| `args.data` | Blockstate property values (e.g. `{ axis: "y", half: "top" }`) |

Returns a list of model references, one per matching model.

### `parseItemDefinition(assets, id, args?)`

Resolves an item definition to a list of model references, walking conditions, selects, and range dispatch based on the given properties.

| Argument | Description |
|---|---|
| `assets` | The assets source |
| `id` | The item id |
| `args.data` | Item components used by the definition |
| `args.display` | Display context, used by tint colour resolution |

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

### `loadModel(scene, assets, model, args?)`

Adds a resolved model's geometry and materials to an existing scene.

| Argument | Description |
|---|---|
| `scene` | The three.js scene to add meshes to |
| `assets` | The assets source |
| `model` | A resolved model (from `resolveModelData`) |
| `args.display` | Display transform to apply to the model |

Returns nothing.

### `renderModelScene(scene, camera, args?)`

Renders a scene to an image buffer. Takes all the same output options as `renderBlock` / `renderItem` / `renderModel`.

| Argument | Description |
|---|---|
| `scene` | The three.js scene to render |
| `camera` | The camera to render from |
| `args` | `path`, `format`, `width`, `height`, `animated`, `animatedWidth`, `animatedHeight`, `background` - same as [`renderBlock`](#renderblockargs) |

Returns an image buffer, or `{ buffer, format }` when `args.animated` is truthy.

### `readFile(path, assets, hint?)`

Reads a file from the assets, walking entries in order and respecting filters.

| Argument | Description |
|---|---|
| `path` | The file path, relative to the pack root (e.g. `"assets/minecraft/textures/block/stone.png"`) |
| `assets` | The assets source |
| `hint` | If set, only look in the entry at this index. Use `buf.hintIndex` from a previous read to pair related lookups (like a PNG and its mcmeta) |

Returns a `Buffer` with `.path` and `.hintIndex` fields, or `undefined` if not found.

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

## License

MIT © [Ewan Howell](https://ewanhowell.com/)
