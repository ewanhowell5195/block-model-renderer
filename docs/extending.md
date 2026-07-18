# Extending

## Custom extensions

In a few places the renderer accepts fields that aren't part of vanilla Minecraft's model or item format: ways to pass data from blockstates into models, apply arbitrary tints, mark models double-sided, and a few other things vanilla doesn't expose. They're used internally, but you can set them on your own models and blockstates too.

### Model JSON

| Field | Example | Description |
|---|---|---|
| `x`, `y`, `z` | `90` | Rotation angles (in degrees) applied to the whole model around each axis. Normally set by a blockstate variant, but can be set on a model directly too |
| `uvlock` | `true` | Keep face UVs aligned to world space when the model is rotated by `x`/`y`/`z`. Normally set by a blockstate variant |
| `translation` | `[8, 0, 8]` | `[x, y, z]` translation (in voxel units) applied to the whole model before rendering |
| `scale` | `[0.5, 0.5, 0.5]` | `[x, y, z]` scale applied to the whole model before rendering |
| `transformation` | `{ translation: [0,0,0], scale: [1,1,1], left_rotation: [0,0,0,1], right_rotation: [0,0,0,1] }` | Translation, rotation, and scale applied to the whole model before rendering. Accepts the vanilla item-definition transformation form (translation/rotations/scale) or a flat 16-element matrix array |
| `ignore_rotations` | `true` | Skip the [display](models.md#display-transforms) rotation for this model |
| `double_sided` | `true` | Render all faces from both sides |
| `tints` | `["#FF0000", "#00FF00"]` | Array of hex color strings. Faces with a `tintindex` look up their tint from this array |
| `shader` | `{ type: "end_portal", layers: 15 }` | Apply the end portal / end gateway shader to the model |
| `type` | `"block"`, `"item"` | Which texture atlas rules to enforce. Block-type models use only the manually provided display settings. Model-defined displays are ignored since they are meant to apply to items, not blocks |
| `ignore_atlas_restrictions` | `true` | Skip texture atlas membership checks for this model, letting it reference textures from any atlas |
| `version` | `"26.3"` | Minecraft version the model is for. Enables era-appropriate behavior, see [Legacy Minecraft versions](versions.md#legacy-minecraft-versions) |

### Blockstate JSON

| Field | Example | Description |
|---|---|---|
| `allow_invalid_rotations` | `true` | Allow variant `x`/`y`/`z` rotation values that aren't multiples of 90 |

### Item components

Extra fields that can be passed through the `components` arg on [`renderItem`](standard-api.md#renderitemargs), or the `data` arg on [`parseItemDefinition`](scenes.md#parseitemdefinitionassets-id-args). These aren't real Minecraft item components, they stand in for runtime context that the game would normally provide:

| Field | Example | Description |
|---|---|---|
| `team` | `"red"` | Team color context used by the `team` tint source |
| `context_entity_type` | `"pig"` | The entity type holding the item, used by `context_entity_type` selects |
| `context_dimension` | `"the_nether"` | The dimension the item is rendered in, used by `context_dimension` selects |

Any future non-component select properties vanilla adds will work without renderer updates. The renderer looks up the property by name in `components` and checks whether its value equals any of the select's listed cases, so as long as the property is a plain string and you pass it in `components`, it resolves correctly.

## Default blockstates

Blockstate properties you don't pass to [`renderBlock`](standard-api.md#renderblockargs) fall back to sensible defaults (stairs face the camera, campfires are lit, mushroom blocks show caps on all sides). The defaults merge with whatever `blockstates` you do provide, per property. Those rules live in a pack file, so any pack can extend or override them by shipping its own:

```
assets/block-model-renderer/default_blockstates.json
```

```json
{
  "properties": {
    "facing": "north",
    "half": ["bottom", "lower"]
  },
  "blocks": [
    { "match": "*_stairs|*_glazed_terracotta", "defaults": { "facing": "south" } },
    { "match": "my_mod_block", "defaults": { "open": true } }
  ]
}
```

* `properties` are per-property fallbacks used for any block. A value can be an array of candidates tried in order (the first one the blockstate actually has wins)
* `blocks` is an ordered rule list. `match` matches block ids with `*` wildcards and `|` alternatives; the first matching rule's `defaults` are used whole
* Files from every pack merge, higher packs win: per property for `properties`, and higher packs' rules go first for `blocks` (a matching rule in a higher pack completely replaces lower ones)
* The library's own rules ship in its [bundled fallback pack](assets.md#bundled-packs) at the very bottom of the stack, so anything a pack defines beats them

Lookup order for a property: the `blockstates` option → the first matching `blocks` rule → `properties`.

## Custom model loaders

Mods extend the model format in their own ways: extra keys on standard models, embedded mesh data, references to other formats entirely. `ModelLoader` lets you plug that in without forking the pipeline. Loaders are global and identical on Node and in the browser, and consulted by `priority` (a number, default `0`, higher first; ties keep registration order), read live so setting `loader.priority` any time takes effect on the next render.

```js
import { ModelLoader } from "block-model-renderer"
```

| `ModelLoader` method | Description |
|---|---|
| `register(loader)` | Register a loader (the object described below). Returns the loader |
| `remove(loaderOrName)` | Unregister by the loader object or its `name`. Returns `true` if one was removed |
| `list()` | The registered loaders in consultation order (`priority` first, then registration order) |

(There's also `ModelLoader.variantKey(model, block)`, a helper for callers that cache built models themselves; see [Placement-aware models](#placement-aware-models).)

Say a pack ships an otherwise-vanilla model with a custom key on it:

```json
{
  "textures": { "all": "block/stone" },
  "elements": [
    {
      "from": [0, 0, 0],
      "to": [16, 16, 16],
      "faces": { "down": { "texture": "#all" }, "up": { "texture": "#all" }, "north": { "texture": "#all" }, "south": { "texture": "#all" }, "west": { "texture": "#all" }, "east": { "texture": "#all" } }
    }
  ],
  "my_mod:overlays": [
    { "texture": "block/glowstone", "size": [8, 8, 8] },
    { "texture": "block/ice", "size": [16, 16, 16] }
  ]
}
```

To handle that key, you register a loader: a plain object that claims it and builds a box from each overlay, added alongside the standard `elements` (the base cube still renders) rather than in place of them (`replaceElements` opts into that):

```js
ModelLoader.register({
  name: "my_mod:overlays",
  priority: 10,

  // claim a custom model json key and merge it across the parent chain yourself
  mergeKey(key, values) {
    // values is this key from every layer (child first); concatenate the lists
    if (key === "my_mod:overlays") {
      return values.flat()
    }
  },

  // which resolved models this loader builds for
  match(model) {
    return !!model["my_mod:overlays"]
  },

  // build geometry from the model data this loader claimed
  async build({ group, model, helpers }) {
    // one box per overlay in the merged list, from its own texture and size
    for (const overlay of model["my_mod:overlays"]) {
      const material = await helpers.createMaterial(overlay.texture)
      const [w, h, d] = overlay.size
      group.add(new helpers.THREE.Mesh(new helpers.THREE.BoxGeometry(w, h, d), material))
    }
  },

  // if build varies by placement, key the variants apart so caches don't share them
  variantKey(model, block) {
    return block ? `facing_${block.properties?.facing}` : null
  }
})
```

### Fields

Everything a loader object can hold. The hooks are detailed below.

| Field | Description |
|---|---|
| `name` | Optional string identifying the loader, so `ModelLoader.remove(name)` works by name |
| `priority` | Number, default `0`. Higher is consulted first; ties keep registration order. Read live, so changing it takes effect on the next render |
| `replaceElements` | If `true`, suppresses the standard `elements` build for matched models, so the format fully owns its geometry instead of adding alongside |
| [`mergeKey`](#mergekeykey-values-merged-stack) | Optional. Claim and merge a custom model json key across the parent chain |
| [`match`](#matchmodel) | Which resolved models this loader builds for |
| [`build`](#build-group-model-assets-args-block-helpers) | Optional. Add your own three.js geometry to a matched model |
| [`variantKey`](#variantkeymodel-block) | Optional. Key placement variants apart so caches don't share geometry |

### `mergeKey(key, values, merged, stack)`

Optional, may be async. Called for **every** model json key during parent-chain merging. Return a value to own the key, or `undefined` to let the vanilla merge handle it. A key you claim stays on the resolved model, including `parent` and `model` (otherwise stripped as plumbing), which is how the Forge OBJ convention keeps its `.obj` path readable in `match`/`build`.

| Argument | Description | Example |
|---|---|---|
| `key` | The model json key being merged | `"my_mod:overlays"` |
| `values` | That key's value from every layer of the parent chain, child first. It holds all levels, so merging them loses nothing | `[[{ texture: "block/glowstone", size: [8, 8, 8] }], [{…}]]` |
| `merged` | The sibling fields resolved so far (`type`, `model`, `x`/`y`/`z`, etc.), for context. `merged[key]` isn't set yet | `{ type: "block", model: "block/glowstone" }` |
| `stack` | The raw json layers of the parent chain, child first. Use it when a key should only count from files that opted into your format | `[{ parent: "block/cube_all", "my_mod:overlays": [{…}] }, { elements: [{…}] }]` |

Placement decisions don't belong here: resolved models are cached per reference, so the merge must stay placement-independent. Pick variants in `build`.

### `match(model)`

Which resolved models this loader builds for. Return `true` to have `build` (and `variantKey`) run for that model.

| Argument | Description | Example |
|---|---|---|
| `model` | The resolved model data, after merging | `{ type: "block", "my_mod:overlays": [{…}], textures: {…} }` |

### `build({ group, model, assets, args, block, helpers })`

Optional, may be async. Adds three.js objects to the model's group. Runs after the standard elements build, so vanilla elements and loader geometry coexist; display transforms, lighting modes, and mirroring all apply automatically. Geometry added here participates in [culling masks](scenes.md#culling-hidden-faces) (occlusion rasterizes real triangles), and meshes can tag `userData.cullface = [dir]` to make their faces droppable per placement like element faces.

| Property | Description | Example |
|---|---|---|
| `group` | The `THREE.Group` to add your objects to | `new THREE.Group()` (empty) |
| `model` | The resolved model data | `{ type: "block", "my_mod:overlays": [{…}] }` |
| `assets` | The prepared assets | `[…]` (prepared assets) |
| `args` | The render args | `{ width: 128, height: 128, lighting: "world" }` |
| `block` | Placement context `{ id, properties, neighbors }`, or `null` when the caller gave no placement info. See [Placement-aware models](#placement-aware-models) | `{ id: "minecraft:oak_stairs", properties: { facing: "east" }, neighbors: {…} }` |
| `helpers` | Helpers that keep loader geometry consistent with the rest (below) | `{ THREE, createMaterial, … }` |

The `helpers` object:

| Helper | Description |
|---|---|
| `THREE` | The three.js instance the library uses |
| `lighting` | The active [lighting mode](rendering.md#lighting-modes) |
| [`readFile(path, hint?)`](assets.md#readfilepath-assets-hint) | Read any file from the asset stack (obj files, custom json, whatever the format needs) |
| `loadTexture(id, tint?)` | Load a texture by id with the standard caching, animation frames, and optional tint |
| `resolveTexture(ref)` | Follow `#slot` references through the model's texture map |
| `buildElements(elements)` | Run an array of vanilla-format elements through the standard cube pipeline (uv defaults, face rotation, uvlock, cullfaces, rotation with rescale, mesh merging) and get back a group to add. For formats that are "vanilla elements, chosen differently", so they don't reimplement cube building |
| `createMaterial(id, opts?)` | A material matching the active lighting mode. `opts`: `tint`, `shade` (false = unshaded in world mode, the pre-26.3 element field), `shade_direction` (shade as if facing this direction, the 26.3+ replacement; see [Legacy Minecraft versions](versions.md#legacy-minecraft-versions)), `double_sided`, `light_emission` (0-15, the element emission floor as in [Lighting modes](rendering.md#lighting-modes)), `shader` |

### `variantKey(model, block)`

Optional. A loader whose output varies by placement returns a short string (e.g. `"connected_east"`) identifying which variant a placement gets, so cached or instanced meshes don't share geometry across variants. Consumers call `ModelLoader.variantKey(model, block)`, which combines the keys from every matching loader (or returns `null` when none vary) for use in their own cache keys.

| Argument | Description | Example |
|---|---|---|
| `model` | The resolved model data | `{ type: "block", "my_mod:overlays": [{…}] }` |
| `block` | Placement context `{ id, properties, neighbors }`, or `null`. See [Placement-aware models](#placement-aware-models) | `{ id: "minecraft:oak_stairs", properties: { facing: "east" }, neighbors: {…} }` |

### Placement-aware models

Some formats build different geometry depending on where the block sits (connected textures, models that extend toward matching neighbors). The `block` argument to `build` carries that context: `{ id, properties, neighbors }`, with `neighbors` in the same shape as [culling neighbors](scenes.md#culling-hidden-faces). [`renderBlock`](standard-api.md#renderblockargs) fills it in automatically from its `id`/`blockstates`/`neighbors` args; when calling [`loadModel`](scenes.md#loadmodelscene-assets-model-args) directly, pass `block: { id, properties }` and the surrounding blocks as the separate `neighbors` arg, which gets merged in as `block.neighbors`. `block` is `null` when the caller gave no placement info, so loaders should fall back to a sensible default variant.

A loader whose output varies by placement should also implement [`variantKey`](#variantkeymodel-block), so anything caching built models keys the variants apart.

Two worked loaders ship as examples in [`examples/node/render_loader.js`](../examples/node/render_loader.js): a from-scratch polygon model format with concatenating inheritance, and the (Neo)Forge OBJ format (`"loader": "forge:obj"`, mtl materials resolving `#slot` textures, `flip_v`).
