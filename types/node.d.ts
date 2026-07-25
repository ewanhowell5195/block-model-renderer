import type * as THREE from "three"
import type {
  AssetsInput, AnimatedOption, BlockRenderInput, ItemRenderInput, ModelRenderInput, TextureRenderInput,
  CreateSceneOptions, FitAspect, LoadModelArgs, NodeOutputOptions, ReadTextureOptions, RenderOptionsCommon,
  ResolvedModel, SceneBlock, SceneHandle, TextureData
} from "./common.js"

export * from "./common.js"

/**
 * A skia-canvas `Canvas`, what the Node build draws into. Described structurally
 * so the types need no skia-canvas or `@types/node` install.
 */
export interface NodeCanvas {
  width: number
  height: number
  getContext(type: "2d"): any
  toBuffer(format?: string, options?: Record<string, any>): Promise<Uint8Array>
  toDataURL(format?: string, options?: Record<string, any>): Promise<string>
}

/** The image type the Node build works in: a skia-canvas `Image` or `Canvas`. */
export interface NodeImage {
  readonly width: number
  readonly height: number
}

/**
 * A render's encoded image. A Node `Buffer` at runtime, typed as its
 * `Uint8Array` base so the types need no `@types/node`.
 */
export type ImageBuffer = Uint8Array

/** What an animated render resolves to: the encoded bytes and what was actually produced. */
export interface AnimatedResult {
  buffer: ImageBuffer
  /** `"webp"`/`"gif"` when the model animated, `"png"` when it turned out to have a single frame. */
  format: string
}

/** The output options every Node render function takes. */
export interface NodeRenderOptions extends RenderOptionsCommon, NodeOutputOptions {
  /**
   * Animated WebP/GIF output. `true` and `"webp"` produce WebP when the model
   * animates and PNG when it doesn't; `"gif"` produces GIF the same way.
   * Default `false`.
   */
  animated?: AnimatedOption
}

/** {@link renderModelScene}'s options: the same output options, with nothing to look up. */
export interface SceneRenderOptions extends Omit<NodeRenderOptions, "assets"> {
  assets?: AssetsInput
}

export interface RenderBlockArgs extends NodeRenderOptions, BlockRenderInput {}
export interface RenderItemArgs extends NodeRenderOptions, ItemRenderInput {}
export interface RenderModelArgs extends NodeRenderOptions, ModelRenderInput {}
export interface RenderTextureArgs extends NodeOutputOptions, TextureRenderInput {
  /** Animated WebP/GIF output. Default `false`. */
  animated?: AnimatedOption
  /** Caps the animation timeline. Default `4096`. */
  maxAnimationFrames?: number
  /** The clear color behind the texture. Transparent by default. */
  background?: RenderOptionsCommon["background"]
}

/**
 * Render a block state by id, using the resource pack's blockstates and models.
 *
 * Returns the encoded image, or `{ buffer, format }` when `animated` is truthy.
 * The buffer comes back whether or not `path` is set, so you can save and
 * post-process in one call.
 *
 * @example
 * const buffer = await renderBlock({ id: "stone", assets })
 * await renderBlock({ id: "magma_block", assets, animated: true, path: "magma.webp" })
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/standard-api.md#renderblockargs
 */
export function renderBlock(args: RenderBlockArgs & { animated: Exclude<AnimatedOption, false> }): Promise<AnimatedResult>
export function renderBlock(args: RenderBlockArgs): Promise<ImageBuffer>

/**
 * Render an item by id, using its item definition.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/standard-api.md#renderitemargs
 */
export function renderItem(args: RenderItemArgs & { animated: Exclude<AnimatedOption, false> }): Promise<AnimatedResult>
export function renderItem(args: RenderItemArgs): Promise<ImageBuffer>

/**
 * Render a model JSON directly, bypassing blockstate and item definition lookup.
 * Nothing is imposed on a model that carries no transform, so item models render
 * face-on like the game; pass `DISPLAYS.block` for the isometric look.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/standard-api.md#rendermodelargs
 */
export function renderModel(args: RenderModelArgs & { animated: Exclude<AnimatedOption, false> }): Promise<AnimatedResult>
export function renderModel(args: RenderModelArgs): Promise<ImageBuffer>

/**
 * Render a texture on its own: the flat image, pixel-crisp, with animated
 * textures playing per their `.mcmeta`. The texture-drawing counterpart to
 * {@link renderBlock}, when you want the art rather than a model.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/standard-api.md#rendertextureargs
 */
export function renderTexture(args: RenderTextureArgs & { animated: Exclude<AnimatedOption, false> }): Promise<AnimatedResult>
export function renderTexture(args: RenderTextureArgs): Promise<ImageBuffer>

/**
 * A fresh three.js scene and orthographic camera configured for block rendering.
 * Sync on Node, async in the browser.
 *
 * The camera carries `fitAspect = true`, telling {@link renderModelScene} to
 * match the camera frustum to the output aspect ratio so non-square renders
 * aren't squished.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#makemodelscene
 */
export function makeModelScene(): { scene: THREE.Scene, camera: FitAspect<THREE.OrthographicCamera> }

/**
 * Render a scene to an image, taking the same output options as the standard
 * render functions. Translucent faces are depth-sorted once against the given
 * camera first, so water behind glass draws correctly.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#rendermodelscenescene-camera-args
 */
export function renderModelScene(scene: THREE.Scene, camera: FitAspect<THREE.Camera>, args: SceneRenderOptions & { animated: Exclude<AnimatedOption, false> }): Promise<AnimatedResult>
export function renderModelScene(scene: THREE.Scene, camera: FitAspect<THREE.Camera>, args?: SceneRenderOptions): Promise<ImageBuffer>

/**
 * Build a resolved model's geometry and materials as a three.js group, adding it
 * to `scene` when one is given. Pass `null` for `scene` to just get the group.
 *
 * The group carries the model it was built from as `userData.model`, and meshes
 * that map to one element carry it as `userData.element`.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#loadmodelscene-assets-model-args
 */
export function loadModel(scene: THREE.Object3D | null, assets: AssetsInput, model: ResolvedModel, args?: LoadModelArgs): Promise<THREE.Group>

/**
 * Build a whole block scene in one call: blockstate parsing, per-position
 * variant picks, hidden-face culling, fluid shaping, waterlogging, block entity
 * models, lighting, and optimization. Feed it your raw block list as-is; the
 * skipped and technical ids are handled for you.
 *
 * @returns The scene handle, or `null` if `shouldCancel` aborted it.
 *
 * @example
 * const handle = await createScene(assets, [{ id: "stone", pos: [0, 0, 0] }])
 * scene.add(handle.group)
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#createsceneassets-blocks-args
 */
export function createScene(assets: AssetsInput, blocks: SceneBlock[], args?: CreateSceneOptions): Promise<SceneHandle | null>

/**
 * Read a texture as ready-to-draw frames, when you want an image rather than a
 * model. Animated textures are sliced per their `.mcmeta` with the game's rules.
 *
 * @returns The texture data, or `null` if the texture is missing.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/assets.md#readtexturepath-assets-opts
 */
export function readTexture(path: string, assets: AssetsInput, opts?: ReadTextureOptions<NodeImage>): Promise<TextureData<NodeImage> | null>

/**
 * Render 16384 map color bytes through the vanilla map palette over
 * `map_background.png`, giving a 128×128 canvas to hand back from a `mapArt`
 * callback.
 *
 * @param colors The `colors` array from a save's `map_<id>.dat`, or one you build yourself.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#map-art
 */
export function renderMapColors(assets: AssetsInput, colors: Uint8Array | number[]): Promise<NodeCanvas>
