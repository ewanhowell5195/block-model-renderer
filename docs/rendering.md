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
| `light` | | A [`computeSceneLight`](scenes.md#scene-lighting) volume for per-block light levels, or `false` for none. Without one, faces get full sky light and only `emission` feeds block light |

Each dimension carries the game's lightmap attributes; pass an object as `dimension` to override any of them (optionally starting `{ dimension: "the_nether", ... }` from a preset):

| Field | overworld | the_nether | the_end | Description |
|---|---|---|---|---|
| `skyLightFactor` | `"overworld"` | `0` | `0` | Sky light strength: a constant `0`-`1`, or `"overworld"` for the day/night timeline (`1.0` by day, `0.24` by night, with the game's dusk/dawn ramps) |
| `skyLightColor` | `#7A7AFF` | `#7A7AFF` | `#AC60CD` | The sky light tint. On the timeline this is the night color (days are white); as a constant factor it applies as-is |
| `ambientColor` | `#0A0A0A` | `#302821` | `#3F473F` | The additive ambient floor: this is what keeps the nether warm-dark and the end green-dark with no light around |
| `blockLightTint` | `#FFD88C` | `#FFD88C` | `#FFD88C` | The warm torchlight tint on block light |
| `cardinalLight` | `"default"` | `"nether"` | `"default"` | The per-face shade constants. `"default"` is down 0.5, up 1.0, n/s 0.8, w/e 0.6; `"nether"` raises down/up to 0.9. An object with any of `down`/`up`/`north`/`south`/`west`/`east` customizes them |
| `hasSkyLight` | `true` | `false` | `true` | Whether [`computeSceneLight`](scenes.md#scene-lighting) seeds sky light from above (it takes the same `dimension` option) |

Colors can be a hex number, a `"#rrggbb"` string, an `[r, g, b]` array of `0`-`1` floats, or a `THREE.Color`. The presets are exported as `LIGHT_DIMENSIONS` if you need the values. The day/night curve runs in the shader from a shared uniform exposed as `scene.userData.daytime`, so a live cycle is just `scene.userData.daytime.value = tick` per frame, with no rebuild.

An element's `light_emission` (0-15, since 1.21.2) is the light level it emits: the element feeds the lightmap's block-light channel, holding bright while the rest of the model darkens, with vanilla's warm torchlight tint at partial levels. It shows wherever the model can be darker than full: in `"world"` mode at a dim `daytime` (a `light_emission: 15` face stays lit at midnight while its neighbours fall to moonlight), and in `"scene"` mode as self-illumination even with no scene lights. In the full-bright `"item"` and `"off"` modes there is nothing to stand out against, like the game's inventory, so it has no visible effect.

Blocks that glow in game without their models using `light_emission` (glowstone, lanterns, lava) get it automatically: when the renderer knows the block being rendered (`renderBlock`, or `loadModel` with `args.block`), every element's emission is floored at the block's own in-game light level, including state-dependent ones like a lit furnace or candle counts (see [`getLightEmission`](models.md#getlightemissionid-properties-resolvedefault)). So a glowstone stays bright at midnight with no model changes.

`loadModel` also takes an `emission` option (0-15) that floors every element the same way. It covers renders the game draws at full lightmap while keeping their normal face shading, like the contents of a glow item frame: pass `emission: 15` and the model stays bright at any `daytime` or light level without the flat look of `lighting: "off"`.

Emission alone keeps a glowing block bright; it doesn't light anything around it. For scenes where torches should light up their surroundings, compute a light volume with [`computeSceneLight`](scenes.md#scene-lighting) and pass it as `lighting: { light }`.

```js
const group = new THREE.Group()
for (const model of await parseBlockstate(assets, "stone")) {
  await loadModel(group, assets, await resolveModelData(assets, model), { lighting: "scene" })
}
scene.add(group)
scene.add(new THREE.AmbientLight(0xffffff, 0.6))
scene.add(new THREE.DirectionalLight(0xffffff, 1))
```
