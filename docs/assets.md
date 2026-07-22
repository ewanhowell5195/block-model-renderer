# Assets

The `assets` option tells the renderer where to find resource pack files. It can be any of:

* A **string**, a path to a resource pack folder, or to a `.zip`/`.jar` file (Node only)
* A **zip in memory**: `Uint8Array`, `ArrayBuffer`, `Blob`, or `File`
* A **virtual handler object**, see [Virtual handlers](#virtual-handlers)
* An **array** of any combination of the above
* **Prepared assets**, the return value of [`prepareAssets()`](#prepareassetsassets-options)

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

Each pack's `pack.mcmeta` filter block is respected: files a higher pack filters out are hidden from the packs below it, like in the game.

Zipped packs don't need `pack.mcmeta` at the zip root: if it only exists in a subfolder (a zipped GitHub repo, a release zip with the pack folder inside), the shallowest one marks the pack root and the wrapper folders are stripped automatically.

> **Vanilla assets are not included.** The [bundled packs](#bundled-packs) only cover fallbacks and required overrides. Provide a base pack yourself: an extracted vanilla assets dump, or the client jar directly. Resource packs and mods are overlays, so layered without a base, everything they don't override renders as missing.

## Virtual handlers

Any object with a `read` method can be used as an assets entry, letting you serve files from anywhere, a zip file, memory, an HTTP server, etc...

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
    // own the item textures: versions from lower packs are ignored, and any not in this pack (or higher) render as missing
    return filePath.startsWith("assets/minecraft/textures/item/")
  }
}

await renderBlock({ id: "stone", assets: handler, path: "out.png" })
```

| Method | Required | Description |
|---|---|---|
| `read(filePath)` | yes | Return file contents (`Buffer`, `Uint8Array`, or `string`), or `null` / `undefined` if the file doesn't exist |
| `list(dir)` | yes | Return an array of filenames in the given directory |
| `filter(filePath)` | no | Return `true` to hide this file from lower-priority entries |

## `prepareAssets(assets, options?)`

The renderer internally calls `prepareAssets(assets)` on each render to normalize the input, parse `pack.mcmeta` filters, and index atlas definitions. If you're running many renders with the same assets, call it once yourself and pass the result for faster subsequent renders:

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

### Caching

Within a single render call nothing is ever decoded or resolved twice: the block, its cull neighbors, and an item's layers all share one internal cache. Pass `{ cache: true }` to extend that reuse **across** calls:

```js
const assets = await prepareAssets(sources, { cache: true })
```

Decoded textures, resolved models, and culling data then persist on the prepared assets, so repeat renders from the same pack skip the load work (several times faster once warm). The cache is bounded by the pack's unique textures and models, but it holds real texture memory, so free it when you swap packs:

```js
import { disposeCache } from "block-model-renderer"

disposeCache(oldAssets)
```

Caching stays enabled after a dispose; it just repopulates. Don't dispose while something from those assets is still rendering (a live player, a scene on screen).

### Minecraft version

Pass `{ version: "1.21.11" }` to pin the Minecraft version the assets are for, for the asset-level era behaviors in [Legacy Minecraft versions](versions.md) (the armor trim palette locations, the [versioned override packs](#versioned-packs)). Without it, the first render that passes a `version` stamps it onto the prepared assets, and with no version at all both the modern and legacy forms are probed.

With [`{ cache: true }`](#caching) the version must be decided here: the cross-call cache isn't version-aware, so a render-call `version` that doesn't match the prepared assets' version throws instead of silently mixing cached resolutions from two eras.

### Translucency detection

Whether a texture renders blended (water, stained glass, ice) or solid is decided by inspecting its pixels, since packs can't declare it: a texture counts as translucent when any pixel's alpha falls strictly between the cutoffs. The defaults treat alpha at or below 5 as cutout (discarded anyway) and at or above 240 as opaque, so textures exported at 98% opacity or with anti-aliased edges render solid like the game's cutout pass instead of joining the sorted transparent pass. Tune per prepared assets when a pack draws the line somewhere else:

```js
const assets = await prepareAssets(sources, { translucency: { min: 5, max: 240 } })
```

## Bundled packs

Minecraft renders some blocks dynamically at runtime with hardcoded geometry, with no usable model JSON in the vanilla resource pack. block-model-renderer ships bundled packs that supply models for these cases, so they render correctly without any setup from you. They come in two categories that mirror how the game treats each block:

### Forced (highest priority)

Blocks that vanilla never renders from resource pack models at all: the [technical blocks](models.md#skip_blocks-and-technical_blocks) (barrier, light, structure void), the end portal and end gateway, the fluids (water, lava), and the item frames (their frame; held items render from nbt). A resource pack can't remodel these in game, so the renderer matches that: the bundled blockstates for these blocks always win, shadowing anything your packs provide for them.

### Additional (rendered alongside)

Blocks where the game draws an entity model on top of whatever the blockstate produces (vanilla's own blockstates for them point at stub models with no geometry). Here your packs stay fully in effect: [`parseBlockstate`](scenes.md#parseblockstateassets-id-args) returns the models your blockstates resolve to plus the bundled overlay models together, the same layering the game draws. Remodel the block in your pack and both render.

The following categories are covered:

* Banners
* Bells (the swinging bell body; the frame is a real vanilla model)
* Chests (including the copper chest family)
* Conduits
* Copper Golem Statues
* Cushions
* Decorated Pots
* Enchanting Table Books (the floating book; the table is a real vanilla model)
* Lectern Books (the open book on a lectern with `has_book`; the lectern is a real vanilla model)
* Mob Heads and Skulls
* Shields
* Shulker Boxes
* Tridents

These packs stay out of your way in the `minecraft` namespace: their blockstates only resolve through [`readFile`](#readfilepath-assets-hint) when nothing else provides the file (cushions, for example, have no vanilla blockstate), their atlas definitions merge in, and everything else they ship lives under the `block-model-renderer` namespace.

#### Versioned packs

Blocks that vanilla has since moved from entity models to block models live in versioned packs alongside the main ones, named for the last version they apply to: `additional_26.1` carries the bed and sign models, since both used entity models until 26.2. A versioned pack only activates when the [`version` option](versions.md#legacy-minecraft-versions) falls at or below its name; without a `version` it is inert, so modern renders always use the real vanilla models. With [`{ cache: true }`](#caching) assets, pass the version to `prepareAssets`: a render-call `version` that doesn't match the cached assets' pinned version [throws](#minecraft-version), since the cache would otherwise mix resolutions from before and after the pack activates.

### Fallback pack (lowest priority)

A second bundled pack sits at the very bottom of the stack, beneath vanilla. It provides the vanilla atlas definitions, the [default blockstate rules](extending.md#default-blockstates), the missing-texture placeholder, and last-resort textures some renders need (the colormaps, the end sky, the enchantment glint). Anything a real pack provides beats it. The missing-model placeholder and the template models the overrides build on ship in the additional pack's `block-model-renderer` namespace instead.

## File access

Helpers for reading through the same layered, filtered view of the assets that the renderer uses.

### `readFile(path, assets, hint?)`

Reads a file from the assets, walking entries in order and respecting filters. Atlas-generated virtual sprites (armor trims, unstitched regions) resolve here too.

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

### `readTexture(path, assets, opts?)`

Reads a texture for drawing yourself, when you want an image rather than a model: GUI sprites, map decorations, particles, item art. [`readFile`](#readfilepath-assets-hint) gives the raw PNG bytes; this gives a ready image, and animated textures also work: the `.mcmeta` is read alongside, slicing the sheet into frames with the game's rules (frame size from `animation.width`/`height`, square by the smaller image dimension when absent; row-major frame indexing; a `frames` list with per-entry times falling back to `frametime`, default 1 tick; `interpolate` blending). To render a texture instead of drawing it yourself, see [`renderTexture`](standard-api.md#rendertextureargs).

| Argument | Description |
|---|---|
| `path` | The texture path, relative to the pack root |
| `assets` | The assets source |
| `opts.onChange(frame)` | Browser only: called whenever the displayed frame changes, on the shared animation clock (so `pauseAnimations` freezes it). Fires only on real changes, so redraw from it without polling. `current` is updated before each call |

Returns `null` if the texture is missing, else:

| Field | Description |
|---|---|
| `image` | The texture image (the first frame when animated) |
| `frames` | The frame images, in playback order (just the image for still textures) |
| `times` | Each frame's duration in ticks |
| `animated` | Whether there is more than one frame |
| `interpolate` | Whether the animation blends between frames |
| `meta` | The parsed `.mcmeta` JSON (e.g. `meta.gui.scaling` for GUI sprites), or `null` |
| `current` | The latest frame: kept live while an `onChange` subscription runs, else the first frame |
| `frameAt(tick)` | The frame image for a game tick (20/s, e.g. `performance.now() / 50`), stepping and interpolating like the game. Still textures just return the image |
| `stop()` | Ends the `onChange` subscription |

### `zipAssets(input)`

Wraps a zip (`Uint8Array`, `ArrayBuffer`, `Blob`, or `File`) as an assets entry. You rarely need it, since zips passed straight into `assets` are detected and wrapped automatically, but it's here if you want the handler itself.

Returns (async) a [virtual handler](#virtual-handlers) entry with `read`/`list`/`filter`, ready to drop into an `assets` array.

Zips stay out of memory when they can. A `Blob`/`File` over 256MB is read through slices: only the zip's directory is parsed up front and each file's bytes come off disk when first read. On Node the same applies to paths (read through a file handle instead of loaded whole) and to large buffers, which spill to a temp file (cleaned up at exit) so the original can be collected. Zip64 archives (over 4GB) are supported throughout, so the practical size limit is disk, not memory.

### `zipAssetsFromSlices(slice, size)`

The disk-backed form with a custom byte source: `slice(start, end)` returns a `Promise` of the `Uint8Array` for that range, and `size` is the total archive size. Everything `zipAssets` does (pack root detection, `pack.mcmeta` filters) applies; only where the bytes come from changes. Useful for sources like HTTP range requests or a custom file API.

### `parseZip(bytes)`

The low-level reader behind [`zipAssets`](#zipassetsinput). Takes a `Uint8Array`/`ArrayBuffer`. Useful for enumerating paths outside the `assets/` tree (e.g. the structures inside a client jar), then reading them through [`readFile`](#readfilepath-assets-hint), which handles decompression.

Returns a `Map` from each file path to its raw entry:

```js
const files = parseZip(jarBytes)

Array.from(files.keys())  // every file path in the zip

files.get("data/minecraft/structures/village/plains/houses/plains_small_house_1.nbt")
// {
//   method: 8,          // zip compression method: 0 stored, 8 deflate
//   data: Uint8Array    // the raw bytes, still compressed
// }
```
