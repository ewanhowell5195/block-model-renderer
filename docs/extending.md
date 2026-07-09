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
| `ignore_rotations` | `true` | Skip the display rotation for this model |
| `double_sided` | `true` | Render all faces from both sides |
| `tints` | `["#FF0000", "#00FF00"]` | Array of hex colour strings. Faces with a `tintindex` look up their tint from this array |
| `shader` | `{ type: "end_portal", layers: 15 }` | Apply the end portal / end gateway shader to the model |
| `type` | `"block"`, `"item"` | Which texture atlas rules to enforce. Block-type models use only the manually provided display settings. Model-defined displays are ignored since they are meant to apply to items, not blocks |
| `ignore_atlas_restrictions` | `true` | Skip texture atlas membership checks for this model, letting it reference textures from any atlas |
| `version` | `"1.8.9"` | Minecraft version the model is for. Enables era-appropriate behaviour, see [Legacy Minecraft versions](rendering.md#legacy-minecraft-versions) |

### Blockstate JSON

| Field | Example | Description |
|---|---|---|
| `allow_invalid_rotations` | `true` | Allow variant `x`/`y`/`z` rotation values that aren't multiples of 90 |

### Item components

Extra fields that can be passed through the `components` arg on `renderItem`, or the `data` arg on `parseItemDefinition`. These aren't real Minecraft item components, they stand in for runtime context that the game would normally provide:

| Field | Example | Description |
|---|---|---|
| `team` | `"red"` | Team colour context used by the `team` tint source |
| `context_entity_type` | `"pig"` | The entity type holding the item, used by `context_entity_type` selects |
| `context_dimension` | `"the_nether"` | The dimension the item is rendered in, used by `context_dimension` selects |

Any future non-component select properties vanilla adds will work without renderer updates. The renderer looks up the property by name in `components` and checks whether its value equals any of the select's listed cases, so as long as the property is a plain string and you pass it in `components`, it resolves correctly.

## Default blockstates

Blockstate properties you don't pass to `renderBlock` fall back to sensible defaults (stairs face the camera, campfires are lit, mushroom blocks show caps on all sides). The defaults merge with whatever `blockstates` you do provide, per property. Those rules live in a pack file, so any pack can extend or override them by shipping its own:

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

Mods extend the model format in their own ways: extra keys on standard models, embedded mesh data, references to other formats entirely. `ModelLoader.register` lets you plug that in without forking the pipeline. Loaders are global and identical on Node and web. They're consulted by `priority` (a number, default `0`, higher first; ties keep registration order). Give a loader a `name` to identify it later: `ModelLoader.remove(loaderOrName)` unregisters (by the object or its name), and `ModelLoader.list()` returns the current loaders in consultation order. To reprioritise, remove and re-register with a new `priority`.

```js
import { ModelLoader } from "block-model-renderer"

ModelLoader.register({
  // offered EVERY model json key during parent-chain merging, with the values
  // from every layer (child first). return a merged value to own the key, or
  // undefined to let the vanilla merge handle it. may be async
  mergeKey(key, values, merged) {
    if (key === "my_mod:overlays") return values.flat()
  },

  // which resolved models this loader builds for
  match(model) {
    return !!model["my_mod:overlays"]
  },

  // add three.js objects to the model's group. runs after the standard
  // elements build, so vanilla elements and loader geometry coexist; display
  // transforms, lighting modes, and mirroring all apply to it automatically
  async build({ group, model, assets, args, block, helpers }) {
    const material = await helpers.createMaterial("block/glowstone", { shade: false })
    const mesh = new helpers.THREE.Mesh(new helpers.THREE.BoxGeometry(4, 4, 4), material)
    group.add(mesh)
  }
})
```

The `helpers` object keeps loader-built geometry consistent with everything else:

| Helper | Description |
|---|---|
| `THREE` | The three.js instance the library uses |
| `lighting` | The active [lighting mode](scenes.md#lighting-modes) |
| `readFile(path, hint?)` | Read any file from the asset stack (obj files, custom json, whatever the format needs) |
| `loadTexture(id, tint?)` | Load a texture by id with the standard caching, animation frames, and optional tint |
| `resolveTexture(ref)` | Follow `#slot` references through the model's texture map |
| `buildElements(elements)` | Run an array of vanilla-format elements through the standard cube pipeline (uv defaults, face rotation, uvlock, cullfaces, rotation with rescale, mesh merging) and get back a group to add. For formats that are "vanilla elements, chosen differently", so they don't reimplement cube building |
| `createMaterial(id, opts?)` | A material matching the active lighting mode. `opts`: `tint`, `shade` (false = unshaded in world mode, the pre-26.3 element field), `shade_direction` (shade as if facing this direction, the 26.3+ replacement; see [Legacy Minecraft versions](rendering.md#legacy-minecraft-versions)), `double_sided`, `shader` |

Geometry added through `build` participates in [culling masks](rendering.md#culling-hidden-faces) automatically (occlusion rasterizes real triangles), and meshes can tag `userData.cullface = [dir]` to make their faces droppable per placement like element faces.

A few more mechanics:

* **Claimed keys are kept.** A key that a loader merges through `mergeKey` stays on the resolved model, including `parent` and `model`, which are otherwise stripped as pipeline plumbing. That's how the Forge OBJ convention works here: claiming `model` keeps the `.obj` path readable in `match` and `build`
* **Per-file decisions.** `mergeKey` receives a fourth argument: the raw json layers of the parent chain, child first. Use it when a key should only count from files that opted into your format
* **Replacing vanilla geometry.** A loader with `replaceElements: true` suppresses the standard `elements` build for the models it matches, so a format can fully own its geometry instead of adding alongside

### Placement-aware models

Some formats build different geometry depending on where the block sits (connected textures, models that extend toward matching neighbours). Two pieces support that:

* **`block` context.** `build` receives a `block` argument: `{ id, properties, neighbors }`, in the same shape as [culling neighbours](rendering.md#culling-hidden-faces). `renderBlock` fills it in automatically from its `id`/`blockstates`/`neighbors` args; when calling `loadModel` directly, pass it as `block` in the options. It's `null` when the caller didn't provide placement info, so loaders should fall back to a sensible default variant
* **`variantKey(model, block)`.** A loader whose output varies by placement declares this hook returning a short string (e.g. `"connected_east"`) identifying which variant a placement gets. Consumers that cache or instance built models call `ModelLoader.variantKey(model, block)`, which combines the keys from every matching loader (or returns `null` when no loader varies), and mix it into their cache keys so different variants don't share a mesh

Note that `mergeKey` is the wrong place for placement decisions: resolved models are cached per model reference, so the merge must stay placement-independent. Pick variants in `build`.

Two worked loaders ship in the [loader example](https://example.com/node/render_loader): a from-scratch polygon model format with concatenating inheritance, and the (Neo)Forge OBJ format (`"loader": "forge:obj"`, mtl materials resolving `#slot` textures, `flip_v`).
