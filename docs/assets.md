# Assets

The `assets` option tells the renderer where to find resource pack files. It can be any of:

* A **string**, a path to a resource pack folder, or to a `.zip`/`.jar` file (Node only)
* A **zip in memory**: `Uint8Array`, `ArrayBuffer`, `Blob`, or `File` (both platforms)
* A **virtual handler object**, see [Virtual handlers](#virtual-handlers)
* An **array** of any combination of the above
* **Prepared assets**, the return value of `prepareAssets()`

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

## Virtual handlers

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

Within a single render call nothing is ever decoded or resolved twice: the block, its cull neighbours, and an item's layers all share one internal cache. Pass `{ cache: true }` to extend that reuse **across** calls:

```js
const assets = await prepareAssets(sources, { cache: true })
```

Decoded textures, resolved models, and culling data then persist on the bundle, so repeat renders from the same pack skip the load work (several times faster once warm). The cache is bounded by the pack's unique textures and models, but it holds real texture memory, so free it when you swap packs:

```js
import { disposeCache } from "block-model-renderer"

disposeCache(oldAssets) // safe if caching was never on
```

Caching stays enabled after a dispose; it just repopulates. Don't dispose while something from that bundle is still rendering (a live player, a scene on screen).

### Translucency detection

Whether a texture renders blended (water, stained glass, ice) or solid is decided by inspecting its pixels, since packs can't declare it: a texture counts as translucent when any pixel's alpha falls strictly between the cutoffs. The defaults treat alpha at or below 5 as cutout (discarded anyway) and at or above 240 as opaque, so textures exported at 98% opacity or with anti-aliased edges render solid like the game's cutout pass instead of joining the sorted transparent pass. Tune per bundle when a pack draws the line somewhere else:

```js
const assets = await prepareAssets(sources, { translucency: { min: 5, max: 240 } })
```

## Texture atlases

The `atlases/*.json` definitions in every pack are parsed and honoured, covering both things the game does with them:

**Virtual sprites.** Atlas sources that *generate* textures work transparently: the generated sprites resolve through `readFile`, `listDirectory`, and every model texture lookup as if they were real files.

| Source type | What it does |
|---|---|
| `paletted_permutations` | Palette-swapped variants (armor trims, spawn eggs), synthesized per permutation |
| `unstitch` | Regions cropped out of a larger sheet (map decorations) |
| `single` | One texture exposed under a different sprite name |
| `directory` | A folder mapped in under a prefix |
| `filter` | Removes matching sprites added by earlier sources |

**Membership rules.** From 1.21.11 the game restricts which atlas a model's textures may come from: block models can only use `blocks` atlas textures, item models can use `blocks` and `items` (but not mix an items-only texture with a blocks-only one). Models that violate the rules render as the missing model, matching the game. This is what the `ignoreAtlases` render option and the `ignore_atlas_restrictions` model field switch off, and it's skipped automatically for `version` values before 1.21.11 (see [Legacy Minecraft versions](rendering.md#legacy-minecraft-versions)).

The vanilla atlas definitions ship in the bundled fallback pack (below), so packs that don't define their own atlases still get the vanilla trims, membership sets, and sprite sources.

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

**Limitation:** the overrides pack is prepended to your assets array at the highest priority. Any blockstate or model covered by it will override whatever your own packs provide, the bundled version always wins. This is a renderer limitation, not a design choice. That said, since these blocks are rendered dynamically by vanilla, you're very unlikely to actually have modified these files.

### Fallback pack (lowest priority)

A second bundled pack sits at the very bottom of the stack, beneath vanilla. It provides the vanilla atlas definitions, the [default blockstate rules](extending.md#default-blockstates), the missing-model and missing-texture placeholders, and a handful of blockstates and models some override models build on. Anything a real pack provides beats it.

## File access

Helpers for reading through the same layered, filtered view of the assets that the renderer uses.

### `readFile(path, assets, hint?)`

Reads a file from the assets, walking entries in order and respecting filters. Atlas-generated [virtual sprites](#texture-atlases) resolve here too.

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

### `parseZip(bytes)`

The low-level reader behind `zipAssets`. Takes a `Uint8Array`/`ArrayBuffer` and returns a `Map` of every file path to its raw entry (compressed bytes, not inflated). Useful for enumerating paths outside the `assets/` tree (e.g. the structures inside a client jar), then reading them through `readFile`, which handles decompression.
