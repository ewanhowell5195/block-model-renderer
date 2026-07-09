# Rendering

Everything the render functions ([`renderBlock`, `renderItem`, `renderModel`](../README.md#api)) can do beyond the basic option tables: culling, animated output, backgrounds, display transforms, and legacy version handling.

## Culling hidden faces

Blocks in the world hide the faces pressed against their neighbours. To render a block the way it looks in place (no bottom face against the ground, no side faces against adjacent blocks), pass `neighbors` to `renderBlock`:

```js
await renderBlock({
  id: "oak_stairs",
  blockstates: { facing: "east", half: "bottom" },
  neighbors: {
    down: "stone",                             // id string = that block, default state
    north: { id: "oak_slab", type: "bottom" }, // object = id + blockstate properties
    up: true,                                  // force-cull this side
    // omitted sides = air, nothing culled
  },
  assets,
})
```

The rules follow Minecraft's `shouldRenderFace`. A `cullface`-authored face is dropped when:

* the neighbour's shape fully covers it. This is state-aware, so two adjacent bottom slabs cull their touching sides but a top slab against a bottom slab doesn't
* the block self-culls against its own kind (glass against glass, water against water)

And never against blocks the game flags as non-occluding (glass, leaves, powder snow), no matter how solid they look.

It's *near* game-accurate rather than exact: the game hardcodes each block's occlusion shape, while this library reads it off the actual models and textures in use, since maintaining a copy of that hardcoded list would be unsustainable.

### `getCullFaces(args)`

The same logic as a standalone helper, for building your own scenes with `loadModel`:

| Option | Default | Description |
|---|---|---|
| `id` | | The block id |
| `blockstates` | `{}` | The block's blockstate property values |
| `neighbors` | | The surrounding blocks, as in `renderBlock` above |
| `assets` | `[]` | The assets source |
| `version` | | Minecraft version, as in `renderBlock` |

Returns a `Set` of directions to drop (`"down"`, `"up"`, `"north"`, `"south"`, `"west"`, `"east"`). Pass it as the `cull` option to any render function or `loadModel`; a plain object like `{ north: true }` works there too.

```js
import { getCullFaces, loadModel } from "block-model-renderer"

const cull = await getCullFaces({ id: "stone", neighbors: { down: "stone", up: "glass" }, assets })
// Set { "down" }: glass doesn't occlude
await loadModel(scene, assets, resolved, { cull })
```

A neighbor entry can also carry an explicit `occludes` boolean (`{ id: "stone", occludes: false }`, or just `{ occludes: true }`). That skips the model-based occlusion check entirely and uses your answer, with only the self-culling rule still applying on top. Useful when you've already computed occlusion yourself, or need to override a specific pairing.

Because occlusion comes from the models, modded blocks and custom packs just work. The models a call builds are cached for that call; with [`prepareAssets(assets, { cache: true })`](assets.md#caching) they're cached across calls too.

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
* **Frame budget**: alongside `maxAnimationFrames`, Node caps the total decoded animation at roughly 268 million pixels (`frames × width × height`), so very large `animatedWidth`/`animatedHeight` values reduce the frame cap. Loops are truncated to whole cycles of the longest texture where possible
* Interpolated textures (`interpolate` in the mcmeta) render with sub-frame blending, up to 8 blend steps per frame, reduced automatically if the frame budget would overflow

On web, `animated: true` returns a live player instead of writing a file. See [Animated renders](browser.md#animated-renders).

## Background

The `background` option sets the clear color behind the rendered model. Supports several formats:

```js
// Transparent (default)
background: undefined

// Hex strings (3/4/6/8 digit)
background: "#ffffff"
background: "#ffffff80"

// CSS color strings
background: "rgb(255, 255, 255)"
background: "rgba(255, 255, 255, 0.5)"
background: "hsl(210, 50%, 40%)"
background: "hsla(210, 50%, 40%, 0.5)"
background: "rebeccapurple"

// Number (0xRRGGBB), fully opaque
background: 0xffffff

// Array or object, components 0 to 1
background: [1, 1, 1, 0.5]
background: { r: 1, g: 1, b: 1, a: 0.5 }

// A THREE.Color instance, fully opaque
background: new THREE.Color(0xffffff)
```

## Display transforms

The `display` option controls how the model is rotated, translated, and scaled before rendering. It takes one of three forms:

**String**: name of a context in the model's `display` block (`"gui"`, `"fixed"`, `"ground"`, `"firstperson_righthand"`, etc.). The renderer uses that context's transform from the model.

```js
display: "firstperson_righthand"
```

**Plain transform**: an object with `rotation`, `translation`, and/or `scale`. Applied directly, ignoring anything the model defines.

```js
display: { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] }
```

**Fallback transform**: add `type: "fallback"` to a plain transform to first try the model's own `display` for a named context (`display: "gui"` by default), falling back to the object's own `rotation`/`translation`/`scale` if the model doesn't define that context.

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

Translation values are clamped to ±80 and scale to ±4, like the game. Mirrored scales (an odd number of negative components) render inside out from 1.15 onwards (MC-176864), which is what unversioned renders do too; see the version notes below for the pre-1.15 behaviour.

## Legacy Minecraft versions

The `version` option tells the renderer what Minecraft version the assets are for, so it can apply era-appropriate behaviour automatically. Older versions had quirks that modern ones don't, and this lets the renderer handle them transparently.

```js
await renderBlock({
  id: "cactus",
  assets,
  version: "1.8.9",
  path: "cactus.png"
})
```

`version` accepts release-style version strings like `"1.8"`, `"1.16.5"`, or `"26.1.2"`. Trailing segments are optional and treated as `0` (so `"26"` compares as `"26.0.0"`). Anything after a `-` is ignored, so snapshot, pre-release, and release-candidate suffixes work too: `"1.21-pre1"`, `"1.21-rc2"`, `"26.1.2-snapshot-2"`.

Currently triggered behaviours:
- **Pre-1.9**: `display.gui` entries compose onto the era's built-in gui base (rotation `[30, 225, 0]`, scale `0.625`) the way the old pipeline applied them, instead of being the whole transform like today. The old `thirdperson`/`firstperson` display names convert to their modern `_righthand` forms
- **Pre-1.13**: prepends `block/` to bare blockstate model refs (e.g. `"model": "cactus"` resolves to `block/cactus`, matching the implicit prefix the game used before the 1.13 flattening)
- **Pre-1.15**: mirrored display scales (an odd number of negative components) render solid like the old pipeline compensated them. From 1.15 the game renders them inside out (MC-176864), which is what unversioned and 1.15+ renders do
- **Pre-1.21.4**: items with no [item definition](scenes.md#parseitemdefinitionassets-id-args) fall back to the classic `models/item/<id>.json`
- **Pre-1.21.6**: element rotation angles that aren't multiples of 22.5 make the model render as missing, like the game rejected them
- **Pre-1.21.11**: skips texture atlas membership rules (the block/item atlas restriction only began in 1.21.11). Element rotations outside ±45, or using the multi-axis `x`/`y`/`z` form, make the model render as missing. Blockstate variant `z` rotations are ignored (the game didn't read the field yet)
- **Pre-26.3**: ignores the element `shade_direction_override` field (it didn't exist yet)
- **26.3+**: ignores the element `shade` field (26.3 removed it in favour of `shade_direction_override`)

Without a `version`, everything that can coexist works at once: when the format replaces one field with another, both the old and new forms are supported simultaneously, and the newer form wins if a model carries both. Only behaviours that directly conflict fall back to the modern rules. So an unversioned render still falls back to `models/item/<id>.json`, still converts the old display names, and resolves renamed item definition properties (`holder_type`, `shift_down`) as their current names; passing a `version` turns those into strict era rules instead (a 1.21.4+ game never reads `models/item`, a 1.9+ game ignores the old display names).

The option is accepted by every entry point (`renderBlock`, `renderItem`, `renderModel`, `parseBlockstate`, `parseItemDefinition`, `loadModel`) and is also propagated onto model objects as `model.version`, so manually constructed models can carry it through too.
