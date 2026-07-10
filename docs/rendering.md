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
| `"world"` | custom shader | Minecraft's in-world daytime face shading: a flat per-face constant from the world-space normal (up 1.0, down 0.5, north/south 0.8, west/east 0.6). The right mode for blocks placed in world orientation, like structures and dioramas |
| `"scene"` | `MeshStandardMaterial` | Reacts to lights you add to the scene (`roughness: 1`, `metalness: 0`, cutout `alphaTest`, sRGB texture). Renders black until you add lights |
| `"off"` | `MeshBasicMaterial` | Unlit and flat: the texture at full brightness, ignoring all lighting |

Tints are baked into the textures in every mode, and the end portal keeps its own emissive shader.

The model element fields `shade: false` (legacy) and `shade_direction_override` only apply in `"world"` mode, mirroring vanilla, where they only exist in the in-world block pipeline: an unshaded element uses the up-face 1.0 constant, an override uses its direction's constant. Item mode ignores both and lights every element from its real face normals, like holding the block in hand.

The `daytime` option sets `"world"` mode's sky brightness, following Minecraft's day/night cycle: a tick `0`-`23999`, or a name (`"day"` 1000, `"noon"` 6000, `"sunset"` 12000, `"night"` 13000, `"midnight"` 18000, `"sunrise"` 23000). It defaults to `noon`, which is full brightness, so world renders are unchanged unless you set a darker time; the brightness follows the game's `getSkyDarken` curve, bottoming out around `0.08` at midnight. The curve runs in the shader from a shared uniform exposed as `scene.userData.daytime`, so a live day/night cycle is just `scene.userData.daytime.value = tick` per frame, with no rebuild.

An element's `light_emission` (0-15, since 1.21.2) is the light level it emits: the element holds at `light_emission / 15` brightness while the rest of the model darkens. It shows wherever the model can be darker than full: in `"world"` mode at a dim `daytime` (a `light_emission: 15` face stays lit at midnight while its neighbours fall to `0.08`), and in `"scene"` mode as self-illumination even with no scene lights. In the full-bright `"item"` and `"off"` modes there is nothing to stand out against, like the game's inventory, so it has no visible effect.

Blocks that glow in game without their models using `light_emission` (glowstone, lanterns, lava) get it automatically: when the renderer knows the block being rendered (`renderBlock`, or `loadModel` with `args.block`), every element's emission is floored at the block's own in-game light level, including state-dependent ones like a lit furnace or candle counts (see [`getLightEmission`](models.md#getlightemissionid-properties-resolvedefault)). So a glowstone stays bright at midnight with no model changes.

```js
const group = new THREE.Group()
for (const model of await parseBlockstate(assets, "stone")) {
  await loadModel(group, assets, await resolveModelData(assets, model), { lighting: "scene" })
}
scene.add(group)
scene.add(new THREE.AmbientLight(0xffffff, 0.6))
scene.add(new THREE.DirectionalLight(0xffffff, 1))
```
