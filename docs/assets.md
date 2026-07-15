# Assets

The `assets` option tells the renderer where to find resource pack files. It can be any of:

* A **string**, a path to a resource pack folder, or to a `.zip`/`.jar` file (Node only)
* A **zip in memory**: `Uint8Array`, `ArrayBuffer`, `Blob`, or `File`
* A **virtual handler object**, see [Virtual handlers](#virtual-handlers)
* An **array** of any combination of the above
* **Prepared assets**, the return value of [`prepareAssets()`](api.md)

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

The renderer internally calls [`prepareAssets(assets)`](api.md) on each render to normalize the input, parse `pack.mcmeta` filters, and index atlas definitions. If you're running many renders with the same assets, call it once yourself and pass the result for faster subsequent renders:

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

Decoded textures, resolved models, and culling data then persist on the bundle, so repeat renders from the same pack skip the load work (several times faster once warm). The cache is bounded by the pack's unique textures and models, but it holds real texture memory, so free it when you swap packs:

```js
import { disposeCache } from "block-model-renderer"

disposeCache(oldAssets)
```

Caching stays enabled after a dispose; it just repopulates. Don't dispose while something from that bundle is still rendering (a live player, a scene on screen).

### Bundle version

Pass `{ version: "1.21.11" }` to pin the Minecraft version the bundle's assets are for, for the asset-level era behaviors in [Legacy Minecraft versions](versions.md) (currently the armor trim palette locations). Without it, the first render that passes a `version` stamps it onto the bundle, and a bundle with no version at all probes both the modern and legacy forms.

### Translucency detection

Whether a texture renders blended (water, stained glass, ice) or solid is decided by inspecting its pixels, since packs can't declare it: a texture counts as translucent when any pixel's alpha falls strictly between the cutoffs. The defaults treat alpha at or below 5 as cutout (discarded anyway) and at or above 240 as opaque, so textures exported at 98% opacity or with anti-aliased edges render solid like the game's cutout pass instead of joining the sorted transparent pass. Tune per bundle when a pack draws the line somewhere else:

```js
const assets = await prepareAssets(sources, { translucency: { min: 5, max: 240 } })
```

## Bundled packs

Two built-in packs are added around your assets array on every render:

### Block entity overrides (highest priority)

Minecraft renders some blocks dynamically at runtime using hardcoded geometry, with no corresponding model JSON in the vanilla resource pack. block-model-renderer ships with a bundled overrides pack that supplies model JSONs for these cases, so they render correctly without any setup from you.

The following categories are covered:

* Banners
* Bells
* Chests (including the copper chest family)
* Conduits
* Copper Golem Statues
* Cushions
* Decorated Pots
* Enchanting Table Books
* End Portal & End Gateway
* Mob Heads and Skulls
* Shields
* Shulker Boxes
* Tridents
* Water & Lava
* Technical blocks (barrier, light, structure void, moving piston)

**Limitation:** the overrides pack is prepended to your assets array at the highest priority. Any blockstate or model covered by it will override whatever your own packs provide, the bundled version always wins. This is a renderer limitation, not a design choice. That said, since these blocks are rendered dynamically by vanilla, you're very unlikely to actually have modified these blockstates and models.

### Fallback pack (lowest priority)

A second bundled pack sits at the very bottom of the stack, beneath vanilla. It provides the vanilla atlas definitions, the [default blockstate rules](extending.md#default-blockstates), the missing-model and missing-texture placeholders, and a handful of blockstates and models some override models build on. Anything a real pack provides beats it.

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

### `zipAssets(input)`

Wraps a zip (`Uint8Array`, `ArrayBuffer`, `Blob`, or `File`) as an assets entry. You rarely need it, since zips passed straight into `assets` are detected and wrapped automatically, but it's here if you want the handler itself.

Returns (async) a [virtual handler](#virtual-handlers) entry with `read`/`list`/`filter`, ready to drop into an `assets` array.

### `parseZip(bytes)`

The low-level reader behind [`zipAssets`](api.md). Takes a `Uint8Array`/`ArrayBuffer`. Useful for enumerating paths outside the `assets/` tree (e.g. the structures inside a client jar), then reading them through [`readFile`](api.md), which handles decompression.

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
