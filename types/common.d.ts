import type * as THREE from "three"

// #region Assets

/**
 * A `Blob` or `File`, described structurally so the types work without the DOM
 * lib loaded. Real `Blob`s and `File`s satisfy it.
 */
export interface BlobLike {
  readonly size: number
  readonly type: string
  arrayBuffer(): Promise<ArrayBuffer>
  slice(start?: number, end?: number, contentType?: string): BlobLike
}

/** A zip archive held in memory, in any of the forms the readers accept. */
export type ZipInput = Uint8Array | ArrayBuffer | BlobLike

/**
 * A file source the renderer can read a resource pack out of. Any object with a
 * `read` method works, letting you serve files from anywhere.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/assets.md#virtual-handlers
 */
export interface VirtualHandler {
  /**
   * Return the file's contents, or `null`/`undefined` when it doesn't exist.
   * Texture files can also be returned as ready images: anything with numeric
   * `width`/`height` the platform can draw, like a canvas, `ImageBitmap`,
   * `Image`, or `ImageData`.
   */
  read(filePath: string): Uint8Array | string | VirtualImage | null | undefined | Promise<Uint8Array | string | VirtualImage | null | undefined>
  /** Return the filenames in a directory. */
  list(dir: string): string[] | Promise<string[]>
  /** Return `true` to hide this file from lower-priority entries, like a pack's `pack.mcmeta` filter block. */
  filter?(filePath: string): boolean
}

/** A ready image a {@link VirtualHandler} can return for a texture file. */
export interface VirtualImage {
  width: number
  height: number
}

/**
 * One layer of a resource pack stack: an in-memory zip, a {@link VirtualHandler},
 * or (Node only) a string path to a pack folder, `.zip`, or `.jar`.
 */
export type AssetsEntry = ZipInput | VirtualHandler | string

/**
 * Prepared assets: the normalized, filter-parsed, atlas-indexed form of an asset
 * stack, returned by {@link prepareAssets}. Pass it straight back into any
 * `assets` option to skip re-normalizing on every call.
 */
export interface PreparedAssets extends Array<unknown> {
  /** The cross-call cache, present when prepared with `{ cache: true }`. */
  readonly cache?: unknown
}

/**
 * Anything accepted as an `assets` option: one entry, an array of layered
 * entries (first wins, like the game's pack order), or already-prepared assets.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/assets.md
 */
export type AssetsInput = AssetsEntry | AssetsEntry[] | PreparedAssets

/** The alpha cutoffs that decide whether a texture renders blended or solid. */
export interface TranslucencyCutoffs {
  /** Alpha at or below this counts as cutout, discarded anyway. Default `5`. */
  min?: number
  /** Alpha at or above this counts as opaque. Default `240`. */
  max?: number
}

export interface PrepareAssetsOptions {
  /**
   * Persist decoded textures, resolved models, and culling data on the prepared
   * assets so repeat renders skip the load work. Free it with {@link disposeCache}.
   */
  cache?: boolean
  /**
   * The Minecraft version the assets are for. With `cache: true` the version
   * must be decided here: a render-call `version` that disagrees throws.
   */
  version?: string
  /** Override the alpha cutoffs used for translucency detection. */
  translucency?: TranslucencyCutoffs
  /**
   * Which default blockstates fill properties a block doesn't carry, for every
   * call made with these assets: `"preferred"` (default) layers the preferred
   * overrides over the block's real default state, `"game"` uses the real
   * default state alone. A per-call `defaults` overrides this.
   */
  defaults?: "preferred" | "game"
}

/** A file read out of the asset stack, with where it came from attached. */
export interface AssetFile extends Uint8Array {
  /** The path the file was read from. */
  path: string
  /** The index of the assets entry it came from, for pairing related lookups. */
  hintIndex: number
}

/** One entry of a parsed zip, still compressed. */
export interface ZipEntry {
  /** The zip compression method: `0` stored, `8` deflate. */
  method: number
  /** The raw bytes, still compressed. */
  data: Uint8Array
}

// #endregion
// #region Common values

/** A face direction. */
export type Direction = "down" | "up" | "north" | "south" | "west" | "east"

/** Blockstate property values. Numbers and booleans are stringified like the game's. */
export type BlockProperties = Record<string, string | number | boolean>

/**
 * Block entity data rendered with a block: an item frame's
 * `{ Item, ItemRotation, Invisible }`, a shelf's `{ Items, align_items_to_bottom }`,
 * or a banner's `{ patterns }`.
 */
export type BlockNbt = Record<string, any>

/** Item components used by an item definition, in the same shape as game data. */
export type ItemComponents = Record<string, any>

/**
 * A neighbouring block: an id string for its default state, `{ id, ...properties }`
 * for a specific one, `true` to force-cull that side, or an explicit
 * `{ occludes }` answer that skips the model-based check.
 */
export type NeighborBlock = string | boolean | ({ id?: string, occludes?: boolean } & BlockProperties)

/**
 * The blocks surrounding one cell. The six cardinal keys drive face culling; the
 * diagonal and vertical keys shape fluid surfaces, compounded as vertical, then
 * north/south, then east/west (`up_north_east`, `down_west`). `self` is the
 * fluid block itself, whose `level` sets its own height. Anything missing is air.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/fluids.md
 */
export type Neighbors =
  & Partial<Record<Direction | "self" | "north_east" | "north_west" | "south_east" | "south_west", NeighborBlock>>
  & { [key: string]: NeighborBlock | undefined }

/** Face directions to drop, from {@link getCullFaces} or written out by hand. */
export type CullOption = Set<Direction> | Partial<Record<Direction, boolean>>

/**
 * The clear color behind a render: a hex string (3/4/6/8 digit), a CSS color
 * string, a `0xRRGGBB` number, `[r, g, b, a?]` or `{ r, g, b, a? }` with
 * components `0`-`1`, or a `THREE.Color`. Transparent when omitted.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/rendering.md#background
 */
export type Background = string | number | number[] | { r: number, g: number, b: number, a?: number } | THREE.Color

/** A color in any of the forms the lighting config accepts. */
export type ColorInput = string | number | [number, number, number] | THREE.Color

/**
 * A biome to tint colormap blocks (grass, foliage, dry foliage) from.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/standard-api.md#renderblockargs
 */
export interface Biome {
  /** Colormap temperature, sampled like the game. Default `0.5`. */
  temperature?: number
  /** Colormap downfall, sampled like the game. Default `1`. */
  downfall?: number
  /** Replaces the sampled color, or folds onto it with `combine`. */
  tint?: string | number
  /** Fold `tint` onto the sampled color with the game's dark-forest formula. */
  combine?: boolean
  /** This biome's share of a blended array, any scale. Default `1`. */
  weight?: number
}

/** One biome, or an array of them averaged the way the game blends biome borders. */
export type BiomeInput = Biome | Biome[]

/** The colormap images blocks sample their tint from. */
export type ColormapName = "grass" | "foliage" | "dry_foliage"

// #endregion
// #region Models

/** A Minecraft model JSON, plus the renderer's own extension fields. */
export type ModelJson = Record<string, any>

/** A model reference from a blockstate or item definition, as {@link parseBlockstate} returns. */
export type ModelReference = Record<string, any>

/** A model with its `parent` chain flattened, as {@link resolveModelData} returns. */
export interface ResolvedModel extends Record<string, any> {
  /** The model's elements, after any `builtin/generated` layer conversion. */
  elements?: Record<string, any>[]
  /** `true` when the elements came from the `builtin/generated` layer conversion. */
  generated?: boolean
}

/**
 * A display transform: a context name from the model's own `display` block, or
 * an object selecting and/or overriding one.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/models.md#display-transforms
 */
export type DisplayOption = string | DisplayTransform

export interface DisplayTransform {
  /** The context to take from the model (`"gui"`, `"fixed"`, `"ground"`, ...). */
  display?: string
  /** Rotation in degrees, `[x, y, z]`. */
  rotation?: [number, number, number]
  /** Translation in voxel units, clamped to ±80 like the game. */
  translation?: [number, number, number]
  /** Scale, clamped to ±4 like the game. */
  scale?: [number, number, number]
  /** `"fallback"` uses the values here only when the model has no matching context. */
  type?: "fallback" | string
  /** `false` stops a fallback applying to generated (item sprite) models. */
  generated?: boolean
  /** Turn flat models (crosses, crops) 45° so they aren't edge-on to the camera. */
  rotateFlat?: boolean
}

/** The ready-made transforms exported as {@link DISPLAYS}. */
export interface DisplayPresets {
  /** Vanilla `block/block`'s gui transform: the isometric inventory look. */
  block: Required<Pick<DisplayTransform, "rotation" | "translation" | "scale">>
  /** The same pose turned 90° around Y. */
  block_90: Required<Pick<DisplayTransform, "rotation" | "translation" | "scale">>
  /** Turned 180°. */
  block_180: Required<Pick<DisplayTransform, "rotation" | "translation" | "scale">>
  /** Turned 270°. */
  block_270: Required<Pick<DisplayTransform, "rotation" | "translation" | "scale">>
  /** No rotation or translation, scale 1. Face-on. */
  flat: Required<Pick<DisplayTransform, "rotation" | "translation" | "scale">>
}

// #endregion
// #region Lighting

/** The lighting modes faces can be shaded with. */
export type LightingMode = "item" | "world" | "scene" | "off"

/** The dimensions with a built-in lighting preset. */
export type LightDimensionName = "overworld" | "the_nether" | "the_end"

/** The per-face shade constants, or a preset name. */
export type CardinalLight = "default" | "nether" | Partial<Record<Direction, number>>

/**
 * A dimension's lightmap attributes. Missing fields default to the overworld's.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/rendering.md#world-lighting
 */
export interface LightDimension {
  /** Sky light strength: a constant `0`-`1`, or `"overworld"` for the day/night timeline. */
  skyLightFactor?: number | "overworld"
  /** The sky light tint. On the timeline this is the night color. */
  skyLightColor?: ColorInput
  /** The additive ambient floor. */
  ambientColor?: ColorInput
  /** The warm torchlight tint on block light. */
  blockLightTint?: ColorInput
  /** The per-face shade constants. */
  cardinalLight?: CardinalLight
  /** Whether {@link computeSceneLight} seeds sky light from above. */
  hasSkyLight?: boolean
}

/** A time of day: a tick `0`-`23999`, or one of the game's named moments. */
export type Daytime = number | "day" | "noon" | "sunset" | "night" | "midnight" | "sunrise"

/**
 * World lighting settings. Passing this object as `lighting` selects world mode.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/rendering.md#world-lighting
 */
export interface WorldLighting {
  /** The dimension's lighting environment, by name or as an override object. Default `"overworld"`. */
  dimension?: LightDimensionName | LightDimension
  /** Sky brightness through the day/night cycle. Overworld only. Default `"noon"`. */
  daytime?: Daytime
  /** The in-game brightness slider, `0` (Moody) to `1` (Bright). Default `0.5`. */
  brightness?: number
  /** A {@link computeSceneLight} volume for per-block light, or `false` for none. */
  light?: SceneLight | false
  /** Rotate the shade along with the model, so each face keeps its own axis shade under the display transform. `false` leaves the shade field fixed, blending across faces the display turns between axes. Default `true`. */
  rotateShade?: boolean
}

/** A lighting mode name, or a world lighting config object. */
export type LightingOption = LightingMode | WorldLighting

/** The presets exported as {@link LIGHT_DIMENSIONS}. */
export type LightDimensionPresets = Record<LightDimensionName, Required<LightDimension>>

/** A block fed to {@link computeSceneLight}. */
export interface SceneLightBlock {
  id: string
  properties?: BlockProperties
  pos?: [number, number, number]
  x?: number
  y?: number
  z?: number
}

export interface ComputeSceneLightOptions {
  /** The assets source. */
  assets: AssetsInput
  /** The Minecraft version the assets are for. Defaults to the prepared assets' pinned version; `false` renders unversioned despite a pin. */
  version?: string | false
  /** The dimension. Ones without sky light skip the sky seeding. Default `"overworld"`. */
  dimension?: LightDimensionName | LightDimension
  /** Progress while the scene's blocks are processed. The flood fill after the last call is quick. */
  onProgress?(done: number, total: number): void
  /** Which default blockstates fill properties that aren't given: `"preferred"` (default) layers the preferred overrides over the block's real default state, `"game"` uses the real default state alone. */
  defaults?: "preferred" | "game"
}

/**
 * A computed light volume, passed to renders through `lighting: { light }`.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/rendering.md#scene-lighting
 */
export interface SceneLight {
  /** The volume's min cell corner. */
  origin: [number, number, number]
  /** The volume's dimensions in cells (the scene bounds plus a one-cell border). */
  size: [number, number, number]
  /** Raw block light levels (0-15), one cell each, x fastest then y then z. */
  blockLight: Uint8Array
  /** Raw sky light levels (0-15), laid out the same way. */
  skyLight: Uint8Array
  /** The shader uniforms the volume is sampled through. */
  uniforms: Record<string, { value: any }>
  /** The light levels at a cell. */
  lightAt(x: number, y: number, z: number): { block: number, sky: number }
  /** Tell the volume the world offset the built scene was moved by, so it keeps sampling the right cells. */
  setOffset(position: THREE.Vector3 | [number, number, number] | { x?: number, y?: number, z?: number }): void
  setOffset(x?: number, y?: number, z?: number): void
  /** Free the light texture. */
  dispose(): void
}

// #endregion
// #region Fluids

/** The fluid a block contributes, or `null` for everything else. */
export type FluidType = "water" | "lava" | null

/**
 * A fluid block's surface shape, as {@link fluidHeights} computes it.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/fluids.md#fluidheightsassets-type-neighbors
 */
export interface FluidHeights {
  /** Corner heights from `0` to `1`, by the vanilla corner-averaging formula. */
  nw: number
  ne: number
  sw: number
  se: number
  /** The block above is the same fluid, so this one renders as a full cube. */
  full: boolean
  /** Flow direction in radians for the flowing texture, or `null` when still. */
  angle: number | null
  /** Sides that use the overlay texture, pressed against a full face like glass or leaves. */
  overlay: Record<"north" | "south" | "west" | "east", boolean>
  /** `true` where the neighbor is the same fluid and the shared face is hidden. */
  same: Record<Direction, boolean>
}

// #endregion
// #region Scenes

/** One block in a {@link createScene} call. */
export interface SceneBlock {
  /** The block id. Namespace optional. */
  id: string
  /** Blockstate property values. */
  properties?: BlockProperties
  /** Block grid position `[x, y, z]`, integers. 16 world units per block. */
  pos: [number, number, number]
  /** Biome tinting for this block, overriding the scene-wide `biome`. */
  biome?: BiomeInput
  /** Block entity data rendered into the scene. */
  nbt?: BlockNbt
  /** Render without occupying the cell: no culling either way, no light contribution, position shareable. */
  overlay?: boolean
  /** Participate without rendering: culls, shapes fluids, and feeds the light volume, but emits no geometry. */
  context?: boolean
}

/** Which stage a {@link createScene} progress callback is reporting. */
export interface ProgressStage {
  /** Counts from 0. */
  index: number
  /** How many stages this call runs, fixed up front from the options. */
  count: number
  /** The stage name. */
  name: "parse" | "light" | "build" | "optimize"
}

export interface CreateSceneOptions {
  /** Scene-wide biome tinting; a block's own `biome` overrides it. */
  biome?: BiomeInput
  /** Lighting mode or world lighting config. Default `"world"`, which computes the light volume from the blocks. */
  lighting?: LightingOption
  /** Density multiplier for screen-space shader effects (the end portal). Default `1`. */
  shaderScale?: number
  /** Build the technical blocks (barrier, light, structure void) with their placeholder icons. Default `false`. */
  technical?: boolean
  /** Map art callback for framed maps, as on `renderBlock`. */
  mapArt?: MapArtCallback
  /** The Minecraft version the assets are for. Defaults to the prepared assets' pinned version; `false` renders unversioned despite a pin. */
  version?: string | false
  /** Skip texture atlas membership rules. Default `false`. */
  ignoreAtlases?: boolean
  /** Merge the built scene with {@link optimizeScene}. Default `true`. */
  optimize?: boolean
  /** Passed through to the optimize pass. */
  resortDistance?: number
  /** Passed through to the optimize pass. */
  maxAtlas?: number
  /** Passed through to the optimize pass. */
  translucency?: TranslucencyCutoffs
  /** A {@link createSharedAtlas} handle whose pages the scene's textures resolve against. */
  sharedAtlas?: SharedAtlas
  /** Passed through to the optimize pass. Workers must set `false`. */
  batchDynamics?: boolean
  /** Per-stage progress. An overall bar can use `(stage.index + done / total) / stage.count`. */
  onProgress?(stage: ProgressStage, done: number, total: number): void
  /** Checked between work slices; return `true` to abort, resolving `null`. */
  shouldCancel?(): boolean
  /** Browser: auto-play texture animations. Default `true`. */
  animate?: boolean
  /** Retain the internal per-state template groups and return them on the handle. Default `false`. */
  keepTemplates?: boolean
  /** Treat absent cells as full occluders, for building a chunk of a larger world. */
  externalOcclusion?(x: number, y: number, z: number): boolean
  /** Which default blockstates fill properties that aren't given: `"preferred"` (default) layers the preferred overrides over the block's real default state, `"game"` uses the real default state alone. */
  defaults?: "preferred" | "game"
}

/** One unique block state a built scene used. */
export interface ScenePaletteEntry {
  id: string
  properties?: BlockProperties
  biome?: BiomeInput
  /** The parsed model references, so tooling doesn't have to re-parse. */
  models: ModelReference[]
}

/** A retained template group, present with `keepTemplates`. */
export interface SceneTemplate {
  /** The palette entry this template was built from. */
  palette: ScenePaletteEntry
  /** The block-local geometry stamped at every position using it. */
  group: THREE.Group
}

/**
 * A built scene, as {@link createScene} resolves to.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#createsceneassets-blocks-args
 */
export interface SceneHandle {
  /** The built group; add it to your scene (or any parent) yourself. */
  group: THREE.Group
  /** The unique states used, with their parsed model references. */
  palette: ScenePaletteEntry[]
  /** Maps each input block index to its `palette` index. */
  blockPalette: Uint32Array
  /** The built templates with `keepTemplates`, else `null`. */
  templates: SceneTemplate[] | null
  /** Maps each input block index to its `templates` index (`0xFFFFFFFF` where nothing was placed), else `null`. */
  blockTemplate: Uint32Array | null
  /** The bounds of the built geometry, for camera fitting. */
  bounds: THREE.Box3
  /** The light volume when world lighting ran, else `null`. */
  light: SceneLight | null
  /** Draw call count from the optimize pass. */
  drawCalls: number
  /** Triangle count from the optimize pass. */
  tris: number
  /** Force a translucent sort now, before a single-frame capture. */
  sortTranslucent(camera: THREE.Camera): void
  /** Free the geometry, materials, and atlas textures, and remove the group from its parent. */
  dispose(): void
}

export interface ParseBlockstateArgs {
  /** Blockstate property values. Missing ones fall back to the default blockstate rules. */
  data?: BlockProperties
  /** Seeded randomness for weighted variants. The same seed always picks the same variants. */
  seed?: number
  /** Biome tinting for the colormap tints. */
  biome?: BiomeInput
  /** Block entity data rendered with the block. */
  nbt?: BlockNbt
  /** Map art callback for framed maps. */
  mapArt?: MapArtCallback
  /** The block's grid position, passed to the `mapArt` callback. */
  pos?: [number, number, number]
  /** Skip texture atlas membership rules for the returned models. */
  ignoreAtlases?: boolean
  /** The Minecraft version the assets are for. Defaults to the prepared assets' pinned version; `false` renders unversioned despite a pin. */
  version?: string | false
  /** Which default blockstates fill properties that aren't given: `"preferred"` (default) layers the preferred overrides over the block's real default state, `"game"` uses the real default state alone. */
  defaults?: "preferred" | "game"
}

export interface ParseItemDefinitionArgs {
  /** Item components used by the definition. */
  data?: ItemComponents
  /** Display context, used by `display_context` selects and tint resolution. */
  display?: DisplayOption
  /** Skip texture atlas membership rules for the returned models. */
  ignoreAtlases?: boolean
  /** The Minecraft version the assets are for. Defaults to the prepared assets' pinned version; `false` renders unversioned despite a pin. */
  version?: string | false
}

/** Placement context handed to placement-aware model loaders. */
export interface PlacementContext {
  id: string
  properties?: BlockProperties
  /** Filled from `loadModel`'s `neighbors` arg; don't set it here. */
  neighbors?: Neighbors | null
}

export interface LoadModelArgs {
  /** Display transform to apply to the model. */
  display?: DisplayOption
  /** Lighting mode or world lighting config. Default `"item"`. */
  lighting?: LightingOption
  /** Floor every element's light emission at this level (0-15), replacing the automatic block level. */
  emission?: number
  /** Density multiplier for screen-space shader effects. */
  shaderScale?: number
  /** Face directions to drop. */
  cull?: CullOption
  /** The surrounding blocks: shapes fluid surfaces and fills `block.neighbors` for loaders. */
  neighbors?: Neighbors
  /** A precomputed {@link fluidHeights} result, reused instead of deriving it from `neighbors` again. */
  fluidHeights?: FluidHeights | null
  /** Placement context for placement-aware model loaders. */
  block?: PlacementContext
  /** Browser only. `false` disables the automatic animator; drive it with `createAnimator`. Default `true`. */
  animate?: boolean
  /** `false` keeps one mesh per element instead of merging them. Default `true`. */
  mergeElements?: boolean
  /** The Minecraft version the assets are for, defaulting to the prepared assets' pinned version. Sets `model.version` if not already present; `false` renders unversioned despite a pin. */
  version?: string | false
  /** Which default blockstates fill properties that aren't given: `"preferred"` (default) layers the preferred overrides over the block's real default state, `"game"` uses the real default state alone. */
  defaults?: "preferred" | "game"
}

/** The block entity kinds that load as dynamic models. */
export type DynamicKind = "banner" | "bell" | "chest" | "decorated_pot" | "dragon_head" | "enchanting_book" | "piglin_head" | "shulker_box"

/**
 * A pose for a dynamic model. Which fields apply depends on the model's kind;
 * omitted ones fall back to the rest pose.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#posespecialroot-pose
 */
export interface SpecialPose {
  /** `"banner"`: where in the wave cycle the flag is, 0-1. */
  phase?: number
  /** `"bell"`: ticks since it was rung, fractional for partial ticks. */
  ticks?: number
  /** `"bell"`: the side it was hit from. No direction means at rest. */
  direction?: "north" | "south" | "east" | "west"
  /** `"chest"`, `"shulker_box"`, `"dragon_head"`: opening progress 0-1. */
  openness?: number
  /** `"decorated_pot"`: which wobble. No style means at rest. */
  style?: "positive" | "negative"
  /** `"decorated_pot"`: progress 0-1 through the wobble's run. */
  progress?: number
  /** `"enchanting_book"`: time in ticks, driving the hover bob and page ripple. */
  time?: number
  /** `"enchanting_book"`: the facing angle in radians. */
  rot?: number
  /** `"enchanting_book"`: how open the book is, 0-1. */
  open?: number
  /** `"enchanting_book"`: the page-flip counter, fractional mid-flip. */
  flip?: number
  /** `"piglin_head"`: how far the left ear is raised, 0-1. */
  left?: number
  /** `"piglin_head"`: how far the right ear is raised, 0-1. */
  right?: number
}

// #endregion
// #region Sky

/** A shared time-of-day uniform, as `scene.userData.daytime` and {@link SkyHandle}`.daytime`. */
export interface DaytimeUniform {
  value: number
}

/** A dimension's sky: which skybox it draws, and the colors it draws it in. */
export interface SkyDimension {
  /** Which sky the dimension draws: the overworld cycle, the End's tiled skybox, or nothing but fog. */
  skybox?: "overworld" | "end" | "none"
  /** The base sky color, before the day/night curve scales it. */
  skyColor?: ColorInput
  /** The base fog color the sky fades to at the horizon. */
  fogColor?: ColorInput
}

/**
 * Sky settings.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/rendering.md#createskyassets-args
 */
export interface CreateSkyOptions {
  /** The dimension's sky, by name or as an override object. Default `"overworld"`. */
  dimension?: LightDimensionName | SkyDimension
  /** The time of day, or a uniform to share with a scene's `userData.daytime`. Default `"noon"`. */
  daytime?: Daytime | DaytimeUniform
  /** The moon phase, `0` (full) to `7`. Default `0`. */
  moonPhase?: number
  /** Tilt the sun and moon's path through the sky, in degrees: `0` passes straight overhead. Default `0`. */
  angle?: number
  /** The base sky color, overriding the dimension's. */
  skyColor?: ColorInput
  /** The base fog color, overriding the dimension's. */
  fogColor?: ColorInput
  /** How far out the sky sits, in world units. Default 90% of the camera's `far`. */
  distance?: number
  /** Fade the sun and moon out once they are well below the horizon, over the game's 13500-14000 nightfall window and its equivalents. Default `false`, as the game itself only ever hides them behind terrain. */
  horizonFade?: boolean
  /** The Minecraft version the assets are for, which picks the sun and moon texture layout. */
  version?: string
}

/**
 * A built sky, as {@link createSky} resolves to.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/rendering.md#createskyassets-args
 */
export interface SkyHandle {
  /** The sky group; add it to your scene. It follows the camera and draws behind everything. */
  group: THREE.Group
  /** The time-of-day uniform: assign `daytime.value` for a live cycle. */
  daytime: DaytimeUniform
  /** The moon phase, `0` (full) to `7`. Assignable. */
  moonPhase: number
  /** The tilt of the sun and moon's path, in degrees off overhead. Assignable. */
  angle: number
  /** Free the geometry, materials, and textures, and remove the group from its parent. */
  dispose(): void
}

// #endregion
// #region Map art

/**
 * Resolves a framed map's face. Return a drawn canvas, or nothing to render the
 * `filled_map` item in a normal frame instead. Results cache per map id.
 */
export type MapArtCallback = (
  id: string | number | null,
  context: { pos?: [number, number, number], facing?: string, nbt?: BlockNbt }
) => any

/** The vanilla map palette, exported as {@link MAP_COLORS}. */
export interface MapColors {
  /** The base colors, `[r, g, b]` each. Index 0 is unset. */
  base: [number, number, number][]
  /** The four brightness steps out of 255. */
  shade: number[]
  /** The game's map color name per base index. */
  names: string[]
}

// #endregion
// #region Culling

/** A serialized occlusion cache entry: a state key and its per-direction masks. */
export type OcclusionCacheEntry = [string, Record<Direction, Uint16Array> | null]

export interface GetCullFacesArgs {
  /** The block id. */
  id: string
  /** The assets source. */
  assets: AssetsInput
  /** The block's blockstate property values. */
  blockstates?: BlockProperties
  /** The surrounding blocks. */
  neighbors?: Neighbors
  /** The Minecraft version the assets are for. Defaults to the prepared assets' pinned version; `false` renders unversioned despite a pin. */
  version?: string | false
  /** Which default blockstates fill properties that aren't given: `"preferred"` (default) layers the preferred overrides over the block's real default state, `"game"` uses the real default state alone. */
  defaults?: "preferred" | "game"
}

export interface FullyOccludesArgs {
  /** The block id. */
  id: string
  /** The assets source. */
  assets: AssetsInput
  /** The block's blockstate property values. */
  properties?: BlockProperties
  /** The Minecraft version the assets are for. Defaults to the prepared assets' pinned version; `false` renders unversioned despite a pin. */
  version?: string | false
  /** Which default blockstates fill properties that aren't given: `"preferred"` (default) layers the preferred overrides over the block's real default state, `"game"` uses the real default state alone. */
  defaults?: "preferred" | "game"
}

// #endregion
// #region Optimization

/** One block placed into an {@link optimizeScene} call. */
export interface Placement {
  /** The block's `[x, y, z]` cell coordinate, 16 units per cell. */
  pos: [number, number, number]
  /** The built group for this block state. Share one reference across placements of the same state. */
  group: THREE.Group
  /** Face directions hidden at this placement. */
  cull?: CullOption
}

export interface OptimizeSceneOptions {
  /** Override the atlas size ceiling, otherwise auto-detected from the canvas and GPU limits. */
  maxAtlas?: number
  /** Pixel cutoffs for textures that didn't come from the asset pipeline. */
  translucency?: TranslucencyCutoffs
  /** How far the camera must move before translucent meshes re-sort. Default `16`, one block. */
  resortDistance?: number
  /** A shared atlas handle whose pages textures resolve against. */
  sharedAtlas?: SharedAtlas
  /** Force `InstancedMesh` for dynamic parts. Workers must set this: `BatchedMesh` doesn't survive revival. */
  batchDynamics?: boolean
  /** Progress on a fixed scale: use `done / total`, not the numbers themselves. */
  onProgress?(done: number, total: number): void
  /** Checked between work slices; return `true` to abort, resolving `null`. */
  shouldCancel?(): boolean
}

/**
 * The merged output of {@link optimizeScene}.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/optimization.md#scene-optimization
 */
export interface OptimizedScene {
  /** The merged group to add to your scene. */
  group: THREE.Group
  /** Draw call count for the merged output. */
  drawCalls: number
  /** Triangle count for the merged output. */
  tris: number
  /** The atlas textures the call built, already applied to the merged materials. */
  atlasTextures: THREE.Texture[]
  /** Force a translucent sort now, before a single-frame capture. */
  sortTranslucent(camera: THREE.Camera): void
  /** Free everything the call created. GPU resources don't garbage collect. */
  dispose(): void
}

/** The handle {@link sortTranslucent} attaches. */
export interface TranslucentSorter {
  /** Force a sort now, before a one-frame capture. */
  sort(camera: THREE.Camera): void
  /** Stop sorting, when discarding the scene. */
  detach(): void
}

export interface CreateSharedAtlasOptions {
  /** Force a page size. Omit to auto-pick at stitch time from the measured sprite area. */
  size?: number
  /** How much of a page the stitch leaves free for runtime textures. Default `0.25`, clamped to `0.95`. */
  headroom?: number
  /** With a renderer, page updates upload as GPU subimages instead of full re-uploads. */
  renderer?: THREE.WebGLRenderer
  /** Give the atlas its own player that ticks its animated regions at 20Hz. */
  animate?: boolean
}

/** The atlas's own animation player, present with `animate: true`. */
export interface AtlasAnimation {
  readonly playing: boolean
  play(): void
  pause(): void
  dispose(): void
}

/**
 * An atlas pool that outlives any one scene.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/optimization.md#shared-atlases
 */
export interface SharedAtlas {
  /** The page size. */
  size: number
  /** How much of a page the stitch leaves free. */
  headroom: number
  /** The renderer page updates upload through, if any. */
  renderer: THREE.WebGLRenderer | null
  /** The atlas's player, or `null` without `animate: true`. */
  animation: AtlasAnimation | null
  /**
   * Set on an adopted handle to have the optimizer batch every texture missing
   * from the layout into one call before it bakes UVs.
   */
  requestSpace?: (items: SharedTextureItem[]) => Promise<SharedTextureResult>
  /** Resolve a page's texture. This is what revived scenes reference. */
  texture(sig: string, page: number): THREE.Texture | null
  /** Free the pages and stop the animator. */
  dispose(): void
}

export interface StitchSharedAtlasOptions {
  /** Which atlas definitions to stitch, merged into the one atlas. Default `["blocks", "items"]`. */
  atlases?: string[]
  onProgress?(done: number, total: number): void
  /** Return `true` to abort, resolving `null`. */
  shouldCancel?(): boolean
}

/** An atlas's coordinate table, structured-cloneable for workers. */
export interface SharedAtlasLayout {
  size: number
  pages: number
  rects: unknown
}

/** A runtime texture handed to {@link insertSharedTextures}. */
export interface SharedTextureItem {
  /** Your stable content hash. Already-present keys dedup to the existing rect. */
  key: string
  /** The image to stitch in. Passed bitmaps are closed. */
  image: any
  /** Frame images, to register the region as animated. */
  frames?: any[]
  /** Each frame's duration in ticks. */
  times?: number[]
  /** Whether the animation blends between frames. */
  interpolate?: boolean
  w?: number
  h?: number
}

/** Granted coordinates, to merge into a worker's layout. */
export interface SharedTextureResult {
  rects: unknown[]
  pages: number
}

export interface PackSceneOptions {
  /** The adopted handle whose pages ship as references instead of bitmaps. */
  sharedAtlas?: SharedAtlas
}

/** A scene packed for `postMessage`. */
export interface PackedScene {
  /** The structured-cloneable payload. */
  payload: {
    meshes: unknown[]
    materials: unknown[]
    textures: unknown[]
  }
  /** The transfer list to pass alongside it. */
  transfers: Transferable[]
}

export interface ReviveSceneOptions {
  /** The handle page references resolve against: the main thread's stitched atlas. */
  atlas?: SharedAtlas
  /** Drop CPU-side geometry arrays after GPU upload, roughly a third of a big scene's heap. */
  releaseArrays?: boolean
}

/** A revived scene: inert live meshes, not a {@link SceneHandle}. */
export interface RevivedScene {
  group: THREE.Group
  dispose(): void
}

// #endregion
// #region Animation

/** What {@link collectAnimated} found in a built group. */
export interface CollectedAnimation {
  /** Textures with animated frames or regions. */
  textures: THREE.Texture[]
  /** Materials whose `GameTime` uniform should advance (the end portal). */
  shaders: THREE.Material[]
  /** The roots of self-animating block entity parts. */
  dynamics: THREE.Object3D[]
}

/** A precomputed per-region frame schedule. */
export interface AnimationSchedule {
  tex: THREE.Texture
  region: unknown
  frames: any[]
  times: number[]
  total: number
  boundaries: number[]
  interpolate?: boolean
  lastKey: unknown
}

// #endregion
// #region Data tables

/**
 * The color tables the renderer tints with.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/models.md#colors
 */
export interface ColorTables {
  /** Block-id lists grouped by which biome colormap image they sample. */
  colormap: Record<ColormapName, string[]>
  /** Blocks with a flat hex tint instead of a colormap. */
  fixed: Record<string, string>
  /** Tint ramps keyed off a blockstate property. */
  indexed: Record<string, { property: string, default: string | number, colors: string[] }>
  /** Blocks whose colormap tint applies to a `tintindex` other than `0`. */
  tintindex: Record<string, number>
  /** The 16 dye colors. */
  dye: Record<string, string>
  /** Each status effect's particle color. */
  effects: Record<string, string>
  /** Each potion id to the effect(s) it draws color from, optionally weighted. */
  potions: Record<string, (string | [string, number])[]>
  /** The 16 team/formatting colors. */
  team: Record<string, string>
}

// #endregion
// #region Model loaders

/** The helpers handed to a loader's `build` hook. */
export interface LoaderHelpers {
  /** The three.js instance the library uses. */
  THREE: typeof THREE
  /** The active lighting mode. */
  lighting: LightingOption | undefined
  /** Read any file from the asset stack. */
  readFile(path: string, hint?: number): Promise<AssetFile | undefined>
  /** Load a texture by id with the standard caching, animation frames, and optional tint. */
  loadTexture(id: string, tint?: string): Promise<THREE.Texture>
  /** Follow `#slot` references through the model's texture map. */
  resolveTexture(ref: string): string | undefined
  /** Run vanilla-format elements through the standard cube pipeline and get back a group. */
  buildElements(elements: Record<string, any>[]): Promise<THREE.Group>
  /** A material matching the active lighting mode. */
  createMaterial(id: string, opts?: {
    tint?: string
    /** `false` = unshaded in world mode, the pre-26.3 element field. */
    shade?: boolean
    /** Shade as if facing this direction, the 26.3+ replacement. */
    shade_direction?: Direction
    double_sided?: boolean
    /** 0-15, the element emission floor. */
    light_emission?: number
    shader?: Record<string, any>
  }): Promise<THREE.Material>
}

/**
 * A custom model loader, for model formats the vanilla pipeline doesn't know.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/extending.md#custom-model-loaders
 */
export interface ModelLoaderDefinition {
  /** Identifies the loader, so `ModelLoader.remove(name)` works by name. */
  name?: string
  /** Higher is consulted first; ties keep registration order. Read live. Default `0`. */
  priority?: number
  /** Suppress the standard `elements` build for matched models, so the format fully owns its geometry. */
  replaceElements?: boolean
  /**
   * Claim and merge a custom model json key across the parent chain. Called for
   * every key; return a value to own it, or `undefined` for the vanilla merge.
   * Placement decisions don't belong here: resolved models are cached per reference.
   */
  mergeKey?(key: string, values: any[], merged: Record<string, any>, stack: Record<string, any>[]): any
  /** Which resolved models this loader builds for. */
  match?(model: ResolvedModel): boolean
  /** Add your own three.js geometry to a matched model, after the standard elements build. */
  build?(context: {
    group: THREE.Group
    model: ResolvedModel
    assets: PreparedAssets
    args: Record<string, any>
    block: PlacementContext | null
    helpers: LoaderHelpers
  }): void | Promise<void>
  /** Key placement variants apart so caches don't share geometry across them. */
  variantKey?(model: ResolvedModel, block: PlacementContext | null): string | null
}

/**
 * The registry for custom model loaders. Loaders are global and identical on
 * Node and in the browser.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/extending.md#custom-model-loaders
 */
export interface ModelLoaderRegistry {
  /** Register a loader. Returns it. */
  register(loader: ModelLoaderDefinition): ModelLoaderDefinition
  /** Unregister by the loader object or its `name`. Returns `true` if one was removed. */
  remove(loaderOrName: ModelLoaderDefinition | string): boolean
  /** The registered loaders in consultation order. */
  list(): ModelLoaderDefinition[]
  /**
   * The combined variant key from every matching loader, or `null` when none
   * vary by placement. For callers that cache built models themselves.
   */
  variantKey(model: ResolvedModel, block: PlacementContext | null): string | null
}

// #endregion
// #region Shared render options

/** The render options that mean the same thing on both platforms. */
export interface RenderOptionsCommon {
  /** The assets source. Vanilla assets aren't bundled, so provide a base pack. */
  assets: AssetsInput
  /** Output size in pixels. Default `256`. */
  width?: number
  /** Output size in pixels. Default `256`. */
  height?: number
  /** The clear color behind the model. Transparent by default. */
  background?: Background
  /** Display transform applied to the rendered model. */
  display?: DisplayOption
  /** Lighting mode or world lighting config. Default `"item"`. */
  lighting?: LightingOption
  /** Floor every element's light emission at this level (0-15), replacing the automatic block level. */
  emission?: number
  /** Density multiplier for screen-space shader effects (the end portal). Default `1`. */
  shaderScale?: number
  /** Explicit face directions to drop; overrides `neighbors`. */
  cull?: CullOption
  /** The Minecraft version the assets are for. Defaults to the prepared assets' pinned version; `false` renders unversioned despite a pin. */
  version?: string | false
  /** Render without enforcing texture atlas membership rules. Default `false`. */
  ignoreAtlases?: boolean
  /** Which default blockstates fill properties that aren't given: `"preferred"` (default) layers the preferred overrides over the block's real default state, `"game"` uses the real default state alone. */
  defaults?: "preferred" | "game"
  /** Caps the animation timeline. Default `4096`. */
  maxAnimationFrames?: number
}

/** The file-encoding options, honoured on Node and ignored in the browser. */
export interface NodeOutputOptions {
  /** Save the output to this path. Format inferred from the extension. */
  path?: string
  /** Output format (`"png"`, `"jpeg"`, `"webp"`, ...). Overrides extension inference. */
  format?: string
  /** Options passed straight to the sharp format encoder. */
  output?: Record<string, any>
  /** Output size when the output is animated. Inherits from `width`/`height`. */
  animatedWidth?: number
  /** Output size when the output is animated. Inherits from `width`/`height`. */
  animatedHeight?: number
  /** Options passed straight to the sharp encoder when the output is animated. */
  animatedOutput?: Record<string, any>
}

/** What Node's `animated` option accepts: WebP when the model animates, PNG when it doesn't. */
export type AnimatedOption = boolean | "webp" | "gif"

/**
 * A camera carrying the renderer's `fitAspect` flag. When it's `true`,
 * `renderModelScene` adjusts the camera's frustum to match the output aspect
 * ratio, so non-square renders aren't squished. Set it on your own cameras for
 * the same behavior; without it the camera is left exactly as you configured it.
 */
export type FitAspect<T> = T & { fitAspect?: boolean }

/** What to render for {@link RenderOptionsCommon}, block form. */
export interface BlockRenderInput {
  /** The block id (e.g. `"oak_log"`). Namespace optional. */
  id: string
  /** Blockstate property values (e.g. `{ axis: "y", half: "top" }`). */
  blockstates?: BlockProperties
  /** Block entity data rendered with the block. */
  nbt?: BlockNbt
  /** Resolves a framed map's face. */
  mapArt?: MapArtCallback
  /** Seeded randomness for weighted blockstate variants. */
  seed?: number
  /** Biome tinting for the colormap tints. */
  biome?: BiomeInput
  /** The blocks surrounding this one: faces they hide are dropped, and fluids shape themselves from it. */
  neighbors?: Neighbors
}

/** What to render for {@link RenderOptionsCommon}, item form. */
export interface ItemRenderInput {
  /** The item id (e.g. `"diamond_sword"`). Namespace optional. */
  id: string
  /** Item components used by the item definition. */
  components?: ItemComponents
}

/** What to render for {@link RenderOptionsCommon}, raw model form. */
export interface ModelRenderInput {
  /** A model JSON object. Inherits from `parent` if specified. */
  model: ModelJson
}

/** What to render for {@link RenderOptionsCommon}, texture form. */
export interface TextureRenderInput {
  /** The texture path relative to the pack root. */
  texture: string
  /** The assets source. */
  assets: AssetsInput
  /** Output size. Defaults to the texture's frame size. The image scales with nearest-neighbor sampling. */
  width?: number
  /** Output size. Defaults to the texture's frame size. */
  height?: number
  /** A color multiplied into the texture, preserving its alpha: a hex string or a dye name. */
  tint?: string
}

// #endregion
// #region Textures

/**
 * A texture read for drawing yourself, as {@link readTexture} returns.
 *
 * @typeParam TImage The platform's image type: an `ImageBitmap` or canvas in the browser, a skia-canvas `Image` on Node.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/assets.md#readtexturepath-assets-opts
 */
export interface TextureData<TImage = unknown> {
  /** The texture image, or the first frame when animated. */
  image: TImage
  /** The frame images in playback order, or just the image for still textures. */
  frames: TImage[]
  /** Each frame's duration in ticks. */
  times: number[]
  /** Whether there is more than one frame. */
  animated: boolean
  /** Whether the animation blends between frames. */
  interpolate: boolean
  /** The parsed `.mcmeta` JSON (e.g. `meta.gui.scaling`), or `null`. */
  meta: Record<string, any> | null
  /** The latest frame: kept live while an `onChange` subscription runs, else the first frame. */
  current: TImage
  /** The frame for a game tick (20/s), stepping and interpolating like the game. */
  frameAt(tick: number): TImage
  /** End the `onChange` subscription. */
  stop(): void
}

export interface ReadTextureOptions<TImage = unknown> {
  /**
   * Browser only: called whenever the displayed frame changes, on the shared
   * animation clock. Fires only on real changes, so redraw from it without
   * polling. `current` is updated before each call.
   */
  onChange?(frame: TImage): void
}

// #endregion

/**
 * Normalize an asset stack once for reuse: parse `pack.mcmeta` filters, index
 * atlas definitions, and optionally set up a cross-call cache. The renderer does
 * this internally on every call, so doing it yourself makes repeat renders faster.
 *
 * @example
 * const assets = await prepareAssets(["packs/my-overrides", "packs/vanilla"], { cache: true })
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/assets.md#prepareassetsassets-options
 */
export function prepareAssets(assets: AssetsInput, options?: PrepareAssetsOptions): Promise<PreparedAssets>

/**
 * Free the textures and GPU data cached on prepared assets. Caching stays
 * enabled afterwards; it just repopulates. Don't dispose while something from
 * those assets is still rendering.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/assets.md#caching
 */
export function disposeCache(assets: AssetsInput): void

/**
 * Read one file through the same layered, filtered view of the assets the
 * renderer uses. Atlas-generated virtual sprites resolve here too.
 *
 * @param path The file path relative to the pack root.
 * @param hint Only look in the entry at this index. Use a previous read's `hintIndex` to pair related lookups.
 * @returns The bytes with `.path` and `.hintIndex`, or `undefined` if not found.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/assets.md#readfilepath-assets-hint
 */
export function readFile(path: string, assets: AssetsInput, hint?: number): Promise<AssetFile | undefined>

/**
 * List the files in a directory across every assets entry, merging results and
 * respecting filters.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/assets.md#listdirectorydir-assets
 */
export function listDirectory(dir: string, assets: AssetsInput): Promise<string[]>

/**
 * Wrap a zip as an assets entry. Zips passed straight into `assets` are detected
 * and wrapped automatically, so this is only for when you want the handler itself.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/assets.md#zipassetsinput
 */
export function zipAssets(input: ZipInput): Promise<VirtualHandler>

/**
 * The disk-backed zip handler with a custom byte source, for HTTP range
 * requests or a custom file API.
 *
 * @param slice Returns the bytes for a byte range.
 * @param size The total archive size.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/assets.md#zipassetsfromslicesslice-size
 */
export function zipAssetsFromSlices(slice: (start: number, end: number) => Promise<Uint8Array>, size: number): Promise<VirtualHandler>

/**
 * The low-level zip reader. Useful for enumerating paths outside the `assets/`
 * tree (the structures inside a client jar, say), then reading them through
 * {@link readFile}, which handles decompression.
 *
 * @returns Every file path in the zip, mapped to its still-compressed entry.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/assets.md#parsezipbytes
 */
export function parseZip(bytes: Uint8Array | ArrayBuffer): Map<string, ZipEntry>

/**
 * Resolve a blockstate to its chosen model references, picking variants or
 * multipart cases from the given property values. Properties you don't pass fall
 * back to the default blockstate rules, per property.
 *
 * Along the way it applies the block's built-in behaviors: colormap, fixed and
 * property-indexed tints, the end portal shader, fluid marking, and the
 * automatic water layer on waterlogged blocks.
 *
 * @example
 * const models = await parseBlockstate(assets, "oak_log", { data: { axis: "y" } })
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#parseblockstateassets-id-args
 */
export function parseBlockstate(assets: AssetsInput, id: string, args?: ParseBlockstateArgs): Promise<ModelReference[]>

/**
 * Resolve an item definition to its chosen model references, walking conditions,
 * selects, and range dispatch from the given components.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#parseitemdefinitionassets-id-args
 */
export function parseItemDefinition(assets: AssetsInput, id: string, args?: ParseItemDefinitionArgs): Promise<ModelReference[]>

/**
 * Flatten a model's `parent` chain into one model, merging `textures`,
 * `elements`, and the rest. `builtin/generated` item layers become real geometry,
 * and the result carries `generated: true` when that conversion ran.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#resolvemodeldataassets-model
 */
export function resolveModelData(assets: AssetsInput, model: ModelReference | ModelJson | string): Promise<ResolvedModel>

/**
 * Which of a block's faces its neighbors hide, following the game's
 * `shouldRenderFace` rules. Pass the result as the `cull` option to any render
 * function or {@link loadModel}.
 *
 * @returns The directions to drop. Air ids return an empty set without touching the assets.
 *
 * @example
 * const cull = await getCullFaces({ id: "oak_stairs", neighbors: { down: "stone" }, assets })
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/culling.md#getcullfacesargs
 */
export function getCullFaces(args: GetCullFacesArgs): Promise<Set<Direction>>

/**
 * Whether a block state is a full occluding cube: every one of its six faces
 * completely hides whatever is pressed against it. For world-scale
 * preprocessing, dropping cells whose neighbors all occlude before building a
 * scene at all.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/culling.md#fullyoccludesargs
 */
export function fullyOccludes(args: FullyOccludesArgs): Promise<boolean>

/**
 * Serialize the computed occlusion masks so an app can persist them (IndexedDB,
 * a file) and skip the cold pass next session. Only valid for the same effective
 * pack stack, so key your copy by the pack list it was exported under.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/culling.md#persisting-the-occlusion-cache
 */
export function exportOcclusionCache(assets: AssetsInput): Promise<OcclusionCacheEntry[]>

/**
 * Seed prepared assets with previously exported occlusion masks. Existing keys
 * are kept.
 *
 * @returns How many entries were added.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/culling.md#persisting-the-occlusion-cache
 */
export function importOcclusionCache(assets: AssetsInput, entries: OcclusionCacheEntry[]): Promise<number>

/**
 * Flood-fill Minecraft's block and sky light over a scene's block grid and pack
 * the result into a light volume the `"world"` shader samples per fragment, so
 * torches glow, light wraps corners, and interiors darken.
 *
 * Pass the result to every {@link loadModel} call in the scene as `lighting: { light }`.
 * Lighting is static: moving an emitter means computing a fresh volume.
 *
 * @example
 * const light = await computeSceneLight([{ id: "torch", pos: [0, 1, 0] }], { assets })
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/rendering.md#scene-lighting
 */
export function computeSceneLight(blocks: SceneLightBlock[], options: ComputeSceneLightOptions): Promise<SceneLight>

/**
 * The tint a colormap-tinted block would get, as a hex string. Omit `biome` for
 * the default climate sample (temperature `0.5`, downfall `1`).
 *
 * @example
 * await getBiomeTint(assets, "grass", { temperature: 2, downfall: 0 }) // "#BFB755"
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/models.md#getbiometintassets-map-biome
 */
export function getBiomeTint(assets: AssetsInput, map: ColormapName, biome?: BiomeInput): Promise<string>

/**
 * Merge a whole scene into a handful of draw calls with far fewer polygons.
 * Share one `group` reference across placements of the same block state: it's
 * classified once and instanced per placement, which is why `cull` lives on the
 * placement rather than being baked in at {@link loadModel} time.
 *
 * @returns The merged scene, or `null` if `shouldCancel` aborted it.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/optimization.md#scene-optimization
 */
export function optimizeScene(placements: Placement[], options?: OptimizeSceneOptions): Promise<OptimizedScene | null>

/**
 * Depth-sort an object's translucent faces for a moving camera, so water behind
 * glass draws correctly. Needs nothing per-frame from you: the renderer hands it
 * the camera on draw.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/optimization.md#translucent-sorting
 */
export function sortTranslucent(object: THREE.Object3D, options?: { resortDistance?: number }): TranslucentSorter

/**
 * An atlas pool that outlives any one scene: pass it as `sharedAtlas` and every
 * scene using the handle resolves textures against the same pages.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/optimization.md#shared-atlases
 */
export function createSharedAtlas(options?: CreateSharedAtlasOptions): SharedAtlas

/**
 * Stitch every sprite the packs' atlas definitions list into the atlas up front,
 * the way the game builds its block atlas at startup. After this, scene builds
 * are pure rect lookups and every scene shares the exact same coordinates.
 *
 * @returns The same handle, or `null` if `shouldCancel` aborted it.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/optimization.md#shared-atlases
 */
export function stitchSharedAtlas(shared: SharedAtlas, assets: AssetsInput, opts?: StitchSharedAtlasOptions): Promise<SharedAtlas | null>

/**
 * The atlas's coordinate table with no pixels, structured-cloneable. Send it to
 * workers once.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/optimization.md#shared-atlases
 */
export function exportSharedAtlasLayout(shared: SharedAtlas): SharedAtlasLayout

/**
 * Turn a fresh handle into a pixel-less adopter of an exported layout: scenes
 * built against it bake UVs to the fixed coordinates and {@link packScene} emits
 * page references only. Adopters never stitch locally.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/optimization.md#shared-atlases
 */
export function adoptSharedAtlasLayout(shared: SharedAtlas, layout: SharedAtlasLayout): SharedAtlas

/**
 * Add runtime textures (sign text, patterned banners, map art) to a live atlas.
 * Already-present keys dedup to the existing rect.
 *
 * @returns The rects and page count, to merge into worker layouts.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/optimization.md#shared-atlases
 */
export function insertSharedTextures(shared: SharedAtlas, items: SharedTextureItem[]): Promise<SharedTextureResult>

/**
 * Pack a built scene's group into transferable data for `postMessage`. Textures
 * ship as bitmaps, except shared-atlas pages which ship as references.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/optimization.md#packing-scenes-across-workers
 */
export function packScene(handle: SceneHandle | { group: THREE.Group }, opts?: PackSceneOptions): Promise<PackedScene>

/**
 * Rebuild a packed payload into live meshes. Revived groups are inert data, not
 * {@link createScene} handles: no palette, no light handle, no dynamic model rigs.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/optimization.md#packing-scenes-across-workers
 */
export function reviveScene(payload: PackedScene["payload"], opts?: ReviveSceneOptions): RevivedScene

/**
 * Register the renderer once so animation frame updates upload as GPU subimages
 * instead of full-page texture re-uploads.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/optimization.md#atlas-animation
 */
export function setAnimationRenderer(renderer: THREE.WebGLRenderer): void

/**
 * Gather everything animated in a built group: textures with animated frames or
 * regions, `GameTime` shader materials, and self-animating block entity roots.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/optimization.md#atlas-animation
 */
export function collectAnimated(root: THREE.Object3D): CollectedAnimation

/**
 * Precompute per-region frame schedules for textures with animated frames or
 * regions.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/optimization.md#atlas-animation
 */
export function buildSchedules(textures: THREE.Texture[]): AnimationSchedule[]

/**
 * Advance every schedule to a game-tick time (20 ticks per second) and update
 * the textures. Regions only re-blend and re-upload when their frame changes.
 *
 * @returns Whether anything changed.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/optimization.md#atlas-animation
 */
export function evaluateAnimation(schedules: AnimationSchedule[], shaders: THREE.Material[], tickTime: number): boolean

/**
 * Manually pose a dynamic model. Calling it cancels the automatic movement: an
 * in-flight `.open()`/`.close()`, `.ring()`, or `.wobble()` stops, and a book's
 * or banner's auto animation turns off for good.
 *
 * @param root A group whose `userData.dynamic` is set, or any clone of one.
 * @param pose The pose values for that model kind. Omitted fields fall back to the rest pose.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#posespecialroot-pose
 */
export function poseSpecial(root: THREE.Object3D, pose?: SpecialPose): void

/**
 * The fluid a block contributes: `"water"` for water (including anything
 * `waterlogged`, and the always-water blocks like kelp), `"lava"` for lava,
 * `null` for everything else. Flowing variants count as their fluid.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/fluids.md#fluidtypeofid-properties
 */
export function fluidTypeOf(id: string, properties?: BlockProperties): FluidType

/**
 * The vanilla fluid surface calculation as a standalone helper: exactly what
 * {@link loadModel} computes internally from `neighbors`. Use it to compute a
 * shape once and share it across the several models a waterlogged block resolves to.
 *
 * @returns The surface shape, or `null` when `type` was `null`.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/fluids.md#fluidheightsassets-type-neighbors
 */
export function fluidHeights(assets: AssetsInput, type: FluidType, neighbors: Neighbors): Promise<FluidHeights | null>

/**
 * Whether the renderer recognizes a block id as waterloggable, so
 * `{ waterlogged: true }` adds a water layer to it.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/models.md#iswaterloggableid
 */
export function isWaterloggable(id: string): boolean

/**
 * Whether a block id is inherently water-filled without carrying a `waterlogged`
 * property (kelp, seagrass, bubble columns). The water layer is added to these
 * automatically.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/models.md#iswaterloggedid
 */
export function isWaterlogged(id: string): boolean

/**
 * Whether resolved model data is built entirely from flat planes: crosses
 * (flowers, saplings, cobwebs) and crops. Such a model always has a plane
 * edge-on to the camera from some angles, showing nothing.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/models.md#isflatmodelmodels
 */
export function isFlatModel(models: ResolvedModel | ResolvedModel[]): boolean

/**
 * The light level (0-15) a block emits in game. Uniform emitters return their
 * level for any state; state-dependent ones (lit furnaces, candle counts, the
 * light block's `level`) read the deciding properties from `properties`.
 *
 * Reports the built-in data: pack overrides apply to what renders, not here.
 *
 * @param resolveDefault Fallback for properties missing from `properties`.
 * @returns The emission level, `0` for non-emitting blocks.
 *
 * @example
 * getLightEmission("candle", { candles: 3, lit: true }) // 9
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/models.md#getlightemissionid-properties-resolvedefault
 */
export function getLightEmission(id: string, properties?: BlockProperties, resolveDefault?: (key: string) => any): number

/**
 * The map id from an item's `minecraft:map_id` component (or legacy `tag.map`),
 * `null` when absent.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#map-art
 */
export function mapIdOf(item: Record<string, any>): string | number | null

/**
 * Clear the cached framed-map art. Call it when the world the maps came from is
 * no longer the source of truth.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#map-art
 */
export function disposeMapArt(assets: AssetsInput): void

/**
 * The vanilla map palette: a color byte resolves as `base[byte >> 2]` scaled by
 * `shade[byte & 3] / 255`.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#map-art
 */
export const MAP_COLORS: MapColors

/**
 * The color tables the renderer tints with, for lookups in your own tooling.
 * Always reports the built-in data, even when a pack overrides entries.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/models.md#colors
 */
export const COLORS: ColorTables

/**
 * Ready-made display transforms, for posing models that don't carry one of their
 * own.
 *
 * @example
 * await renderModel({ model, assets, display: { type: "fallback", ...DISPLAYS.block } })
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/models.md#displays
 */
export const DISPLAYS: DisplayPresets

/**
 * The per-dimension world lighting presets, for spreading into overrides.
 *
 * @example
 * lighting: { dimension: { ...LIGHT_DIMENSIONS.the_nether, ambientColor: 0x000000 } }
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/rendering.md#world-lighting
 */
export const LIGHT_DIMENSIONS: LightDimensionPresets

/**
 * Block ids that resolve to no models and render nothing: `air`, `cave_air`,
 * `void_air`, and `moving_piston`. Skip these when batch-rendering. The ids are
 * bare, without a namespace.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/models.md#skip_blocks-and-technical_blocks
 */
export const SKIP_BLOCKS: Set<string>

/**
 * Block ids that are invisible in game but render with placeholder icon models
 * here: `barrier`, `light`, `structure_void`. The ids are bare, without a
 * namespace.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/models.md#skip_blocks-and-technical_blocks
 */
export const TECHNICAL_BLOCKS: Set<string>

/**
 * Register custom model loaders, for mod formats the vanilla pipeline doesn't
 * know: extra keys on standard models, embedded mesh data, or other formats entirely.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/extending.md#custom-model-loaders
 */
export const ModelLoader: ModelLoaderRegistry
