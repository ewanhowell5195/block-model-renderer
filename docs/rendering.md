# Rendering

How a render looks: backgrounds and lighting. These apply wherever a model renders, through the render functions and the low-level scene pipeline alike.

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

## Lighting modes

The `lighting` option picks how faces are shaded:

| Value | Material | Behavior |
|---|---|---|
| `"item"` (default) | custom shader | The built-in Minecraft item shading, picking the flat (gui) or 3d (inventory) light config from the model's `gui_light` like vanilla. Lights are world-fixed, so faces stay consistently lit as the camera orbits. Matches the snapshot renderers |
| `"world"`, or an object | custom shader | Minecraft's in-world lighting: the game's lightmap driven by dimension, time of day, and brightness, plus its flat per-face shade constants. The right mode for blocks placed in world orientation, like structures and dioramas. An object configures it (below); the bare string is world mode with every default |
| `"scene"` | `MeshStandardMaterial` | Reacts to lights you add to the scene (`roughness: 1`, `metalness: 0`, cutout `alphaTest`, sRGB texture). Renders black until you add lights |
| `"off"` | `MeshBasicMaterial` | Unlit and flat: the texture at full brightness, ignoring all lighting |

Tints are baked into the textures in every mode, and the end portal keeps its own emissive shader.

The model element fields `shade: false` (legacy) and `shade_direction_override` only apply in `"world"` mode, mirroring vanilla, where they only exist in the in-world block pipeline: an unshaded element uses the up-face constant, an override uses its direction's constant. Item mode ignores both and lights every element from its real face normals, like holding the block in hand.

### World lighting

World mode reproduces the game's lightmap shader. Passing an object as `lighting` selects world mode and configures it:

```js
lighting: {
  dimension: "overworld",  // "the_nether", "the_end", or an override object
  daytime: "noon",         // overworld only; the other dimensions have fixed time
  brightness: 0.5,         // the in-game brightness slider: 0 Moody to 1 Bright
  light: sceneLight        // a computeSceneLight volume, or false to skip one
}
```

| Option | Default | Description |
|---|---|---|
| `dimension` | `"overworld"` | The dimension's lighting environment, matching the game's dimension type attributes (see below) |
| `daytime` | `"noon"` | Sky brightness through the day/night cycle: a tick `0`-`23999`, or a name (`"day"` 1000, `"noon"` 6000, `"sunset"` 12000, `"night"` 13000, `"midnight"` 18000, `"sunrise"` 23000). Only the overworld cycles; the nether and end have fixed time, so it has no effect there |
| `brightness` | `0.5` | The in-game brightness setting, `0` (Moody) to `1` (Bright), applied with the game's exact curve. `0.5` is the game's default |
| `light` | | A [`computeSceneLight`](#scene-lighting) volume for per-block light levels, or `false` for none. Without one, faces get full sky light and only `emission` feeds block light |

Each dimension carries the game's lightmap attributes; pass an object as `dimension` to override any of them, with missing fields defaulting to the overworld's. To tweak another dimension instead, spread its preset: `dimension: { ...LIGHT_DIMENSIONS.the_nether, ambientColor: 0x000000 }`.

| Field | overworld | the_nether | the_end | Description |
|---|---|---|---|---|
| `skyLightFactor` | `"overworld"` | `0` | `0` | Sky light strength: a constant `0`-`1`, or `"overworld"` for the day/night timeline (`1.0` by day, `0.24` by night, with the game's dusk/dawn ramps) |
| `skyLightColor` | `#7A7AFF` | `#7A7AFF` | `#AC60CD` | The sky light tint. On the timeline this is the night color (days are white); as a constant factor it applies as-is |
| `ambientColor` | `#0A0A0A` | `#302821` | `#3F473F` | The additive ambient floor: this is what keeps the nether warm-dark and the end green-dark with no light around |
| `blockLightTint` | `#FFD88C` | `#FFD88C` | `#FFD88C` | The warm torchlight tint on block light |
| `cardinalLight` | `"default"` | `"nether"` | `"default"` | The per-face shade constants. `"default"` is down 0.5, up 1.0, n/s 0.8, w/e 0.6; `"nether"` raises down/up to 0.9. An object with any of `down`/`up`/`north`/`south`/`west`/`east` customizes them |
| `hasSkyLight` | `true` | `false` | `true` | Whether [`computeSceneLight`](#scene-lighting) seeds sky light from above (it takes the same `dimension` option) |

Colors can be a hex number, a `"#rrggbb"` string, an `[r, g, b]` array of `0`-`1` floats, or a `THREE.Color`. The presets are exported as `LIGHT_DIMENSIONS` if you need the values. The day/night curve runs in the shader from a shared uniform exposed as `scene.userData.daytime`, so a live cycle is just `scene.userData.daytime.value = tick` per frame, with no rebuild.

An element's `light_emission` (0-15) is the light level it emits: the element feeds the lightmap's block-light channel, holding bright while the rest of the model darkens, with vanilla's warm torchlight tint at partial levels. It shows wherever the model can be darker than full: in `"world"` mode at a dim `daytime` (a `light_emission: 15` face stays lit at midnight while its neighbours fall to moonlight), and in `"scene"` mode as self-illumination even with no scene lights. In the full-bright `"item"` and `"off"` modes there is nothing to stand out against, like the game's inventory, so it has no visible effect.

Blocks that glow in game without their models using `light_emission` (glowstone, lanterns, lava) get it automatically: when the renderer knows the block being rendered (`renderBlock`, or `loadModel` with `args.block`), every element's emission is floored at the block's own in-game light level, including state-dependent ones like a lit furnace or candle counts (see [`getLightEmission`](models.md#getlightemissionid-properties-resolvedefault)). So a glowstone stays bright at midnight with no model changes.

The render functions and `loadModel` also take an `emission` option (0-15) that floors every element the same way, and when present it replaces the automatic block level entirely. `emission: 15` keeps a model bright at any `daytime` or light level without the flat look of `lighting: "off"`, covering renders the game draws at full lightmap while keeping their normal face shading, like the contents of a glow item frame; `emission: 0` turns a glowing block's automatic glow off.

Emission alone keeps a glowing block bright; it doesn't light anything around it. For scenes where torches should light up their surroundings, compute a light volume with [`computeSceneLight`](#scene-lighting) and pass it as `lighting: { light }`.

A light volume also enables the game's smooth-lighting ambient occlusion: faces darken toward corners where full-cube blocks crowd them, with vanilla's exact neighbor rules and falloff, evaluated per fragment so it stays correct across merged geometry. Matching the game, it skips emitting elements, fluids, and models with `ambientocclusion: false`; without a volume there is no occlusion data, so plain `"world"` lighting renders without it.

```js
const group = new THREE.Group()
for (const model of await parseBlockstate(assets, "stone")) {
  await loadModel(group, assets, await resolveModelData(assets, model), { lighting: "scene" })
}
scene.add(group)
scene.add(new THREE.AmbientLight(0xffffff, 0.6))
scene.add(new THREE.DirectionalLight(0xffffff, 1))
```

## Scene lighting

`"world"` lighting on its own shades every face as if it stood under open sky, with `daytime` scaling the whole scene evenly. [`computeSceneLight`](#scene-lighting) adds real per-block light: torches and other emitters glow, light falls off with distance and wraps around corners, and interiors and overhangs darken because the sky can't reach them. It runs Minecraft's flood fill over the scene's block grid and packs the result into a light volume texture the `"world"` shader samples per fragment, so the gradients are smooth and merged geometry from [`optimizeScene`](optimization.md#scene-optimization) is lit correctly with no extra draw calls.

### `computeSceneLight(blocks, options)`

| Option | Default | Description |
|---|---|---|
| `blocks` | required | The scene's blocks, each `{ id, properties?, pos: [x, y, z] }` (`{ x, y, z }` fields work too). Cell coordinates, as in [`optimizeScene`](optimization.md#scene-optimization) placements |
| `options.assets` | required | The assets source |
| `options.version` | | Minecraft version, as in [`renderBlock`](standard-api.md#renderblockargs) |
| `options.dimension` | `"overworld"` | The dimension, as in [world lighting](#world-lighting): dimensions without sky light (the nether) skip the sky seeding, so their volumes carry block light only |
| `options.onProgress` | | `(done, total)` while the scene's blocks are processed, for progress bars. The flood fill after the last call is quick |

Pass the result to every [`loadModel`](scenes.md#loadmodelscene-assets-model-args) call in the scene through the world lighting config:

```js
import { computeSceneLight, loadModel } from "block-model-renderer"

const blocks = [
  { id: "stone", pos: [0, 0, 0] },
  { id: "torch", pos: [0, 1, 0] }
]
const light = await computeSceneLight(blocks, { assets })
for (const block of blocks) {
  // build as usual, passing the same light to each block
  await loadModel(scene, assets, resolved, { lighting: { light } })
}
```

Light propagates accurately to the game: block light from emitters (via [`getLightEmission`](models.md#getlightemissionid-properties-resolvedefault)) and sky light from above, both spreading one level per block and blocked by the block shapes read from the models, so a slab roof shadows the room while light wraps through the open half. The game's non-model attenuation is applied on top from extracted data (`lightDampening` in [`lighting.json`](extending.md#block-data-and-colors)): leaves, fluids, and waterlogged blocks dim light one level per block, so tree canopies darken toward the trunk and deep water darkens with depth, and tinted glass blocks light outright.

Shading uses the vanilla lightmap: the dimension's ambient floor, sky and block light adding on top, the warm torchlight tint, and the brightness setting (all [configurable](#world-lighting)). In the overworld at the default full-bright `noon` most of the scene reads as lit, so emitters mainly show indoors; use a darker `daytime` (or the nether or end) to see them everywhere.

The result:

| Field | Description |
|---|---|
| `origin`, `size` | The volume's min cell corner and dimensions in cells (the scene bounds plus a one-cell border) |
| `blockLight`, `skyLight` | The raw levels (0-15), one `Uint8Array` cell each, x fastest then y then z |
| `lightAt(x, y, z)` | `{ block, sky }` levels at a cell, for your own use |
| `setOffset(position)` | Call with the world offset you move the built scene by (a `Vector3`, array, or `x, y, z` numbers), e.g. the centering translation on [`optimizeScene`](optimization.md#scene-optimization)'s group, so the shader keeps sampling the right cells. Rotation and scaling aren't supported |
| `dispose()` | Frees the light texture. Call it when you discard the scene |

The volume uploads as a single 2D texture of stacked slices with trilinear filtering done in the shader, so it behaves identically on the web and on Node's WebGL1 context. Lighting is static: it's computed once from the block list, so moving or removing emitters means computing a fresh volume and rebuilding the scene.
