# Legacy Minecraft versions

The `version` option tells the renderer what Minecraft version the assets are for, so it can apply era-appropriate behavior automatically. Older versions had quirks that modern ones don't, and this lets the renderer handle them transparently.

```js
await renderBlock({
  id: "cactus",
  assets,
  version: "1.8.9",
  path: "cactus.png"
})
```

## Version strings

`version` accepts release-style version strings like `"1.8"`, `"1.16.5"`, or `"26.1.2"`. Trailing segments are optional and treated as `0` (so `"26"` compares as `"26.0.0"`). Anything after a `-` is ignored, so snapshot, pre-release, and release-candidate suffixes work too: `"1.21-pre1"`, `"1.21-rc2"`, `"26.1.2-snapshot-2"`.

## Triggered behaviors

Each threshold below only kicks in when the `version` you pass falls in its range. Anything you don't pass a `version` for uses the modern behavior (with the coexistence rules [below](#without-a-version)).

| Assets from | What changes | Why |
|---|---|---|
| **before 1.9** | `display.gui` transforms compose *onto* the era's built-in gui base (rotation `[30, 225, 0]`, scale `0.625`) instead of replacing it, and the legacy `thirdperson` / `firstperson` display names map to their modern `_righthand` forms | The old pipeline layered gui transforms and used the pre-`_righthand` context names |
| **before 1.13** | Bare blockstate model refs gain a `block/` prefix (`"model": "cactus"` → `block/cactus`) | Matches the implicit folder the game assumed before the 1.13 flattening |
| **before 1.15** | Mirrored display scales (an odd number of negative components) render solid rather than inside out | The old pipeline compensated the mirror; 1.15 stopped (MC-176864), which is what unversioned renders match |
| **before 1.21.2** | The element `light_emission` field is ignored | It didn't exist yet |
| **before 1.21.4** | Items with no [item definition](scenes.md#parseitemdefinitionassets-id-args) fall back to `models/item/<id>.json` | Item definitions didn't exist yet; models lived directly under `models/item` |
| **before 1.21.6** | Element rotation angles that aren't multiples of 22.5° render as the missing model | The game rejected off-grid rotations before 1.21.6 |
| **before 1.21.11** | Texture atlas membership rules are skipped; element rotations outside ±45° or using the multi-axis `x`/`y`/`z` form render as missing; blockstate variant `z` rotations are ignored | The block/item atlas restriction and the wider rotation form both arrived in 1.21.11, and the game didn't read variant `z` before it |
| **before 26.2** | Beds and signs render through bundled override models (the versioned `additional_26.1` pack activates) | They used entity models until 26.2 changed them to block models |
| **before 26.3** | The element `shade_direction_override` field is ignored; `paletted_permutations` palette references read from their literal texture locations (`textures/trims/color_palettes/…`) | Neither the field nor the 26.3 palette folder existed yet |
| **26.3 and later** | The element `shade` field is ignored; `paletted_permutations` palette references resolve as palette IDs under `textures/palettes/` | 26.3 removed `shade` in favor of `shade_direction_override`, and moved trim palettes |

## Without a `version`

Everything that can coexist works at once: when the format replaces one field with another, both the old and new forms are supported simultaneously, and the newer form wins if a model carries both. Only behaviors that directly conflict fall back to the modern rules. So an unversioned render still falls back to `models/item/<id>.json`, still converts the old display names, and resolves renamed item definition properties (`holder_type`, `shift_down`) as their current names; passing a `version` turns those into strict era rules instead (a 1.21.4+ game never reads `models/item`, a 1.9+ game ignores the old display names).

The option is accepted by every entry point ([`renderBlock`](standard-api.md#renderblockargs), [`renderItem`](standard-api.md#renderitemargs), [`renderModel`](standard-api.md#rendermodelargs), [`parseBlockstate`](scenes.md#parseblockstateassets-id-args), [`parseItemDefinition`](scenes.md#parseitemdefinitionassets-id-args), [`loadModel`](scenes.md#loadmodelscene-assets-model-args)) and is also propagated onto model objects as `model.version`, so manually constructed models can carry it through too. Asset-level behaviors (the trim palette locations, the [versioned override packs](assets.md#versioned-overrides)) read the version from the prepared assets: it sticks there from the first versioned call, or pass it up front with `prepareAssets(sources, { version })`. With [`{ cache: true }`](assets.md#caching) up front is the only option: a render-call `version` that doesn't match the cached assets' version throws.
