import type * as ThreeModule from "three"
import type {
  AssetsInput, BlockRenderInput, ItemRenderInput, ModelRenderInput, TextureRenderInput,
  CreateSceneOptions, FitAspect, LoadModelArgs, ReadTextureOptions, RenderOptionsCommon,
  ResolvedModel, SceneBlock, SceneHandle, TextureData
} from "./common.js"

export * from "./common.js"

/** A canvas the browser build can draw into. */
export type BrowserCanvas = HTMLCanvasElement | OffscreenCanvas

/** The image type the browser build works in. */
export type BrowserImage = ImageBitmap | HTMLImageElement | BrowserCanvas

/** One entry of an array `canvas` option, with its own placement and draw size. */
export interface CanvasDescriptor {
  /** The canvas to draw into. */
  canvas: BrowserCanvas
  /** Placement mode for this canvas alone: draw into a region without resizing or clearing it. */
  x?: number
  /** Placement mode for this canvas alone. */
  y?: number
  /** This canvas's draw size, defaulting to the render size. A different size scales through the 2d context. */
  width?: number
  /** This canvas's draw size. */
  height?: number
  /** Clear this canvas's target rect before drawing. */
  clear?: boolean
}

/** Where a render draws: one canvas, or an array of canvases and descriptors. */
export type CanvasTarget = BrowserCanvas | Array<BrowserCanvas | CanvasDescriptor>

/**
 * A live animation player, what a render returns with `animated: true`.
 *
 * Players paint frames into their canvas on Minecraft's 50ms tick clock. They
 * all share one page-global clock and one rAF scheduler, and pause automatically
 * while scrolled offscreen.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/standard-api.md#animated-renders-browser
 */
export interface Player {
  /** The canvas being painted: the one you passed, or a new one. An array if `canvas` was one. */
  canvas: BrowserCanvas | BrowserCanvas[]
  /** `false` if the model turned out to have nothing to animate; everything else no-ops. */
  animated: boolean
  /** Whether playback is running. */
  readonly playing: boolean
  /** Resume playback, snapping back onto the global clock so it stays in phase. */
  play(): void
  /** Stop playback. */
  pause(): void
  /** Timeline metadata for one loop, in ms. Computed lazily; `maxAnimationFrames` caps this enumeration only. */
  readonly frames: { time: number, duration: number }[]
  /** Total loop length in ms. */
  readonly duration: number
  /** Paint one frame by index, wrapping modulo the loop. */
  renderFrame(index: number): void
  /** Paint the state at an arbitrary clock time. Wraps, and stays exact regardless of `maxAnimationFrames`. */
  renderTime(ms: number): void
  /**
   * Point the player at a different set of canvases, replacing the current ones
   * and returning the new `canvas` value. Takes the same shapes as the render's
   * own `canvas` option.
   *
   * The scene is reused, so retargeting costs no render: it's the cheap way to
   * follow a grid that reshuffles or a panel that reopens elsewhere. The current
   * frame is painted into the new canvases straight away rather than at the next
   * tick, and offscreen pausing re-observes them. Canvases dropped from the set
   * keep whatever frame they last showed.
   */
  setCanvases(canvas: CanvasTarget): BrowserCanvas | BrowserCanvas[]
  /** Add canvases to the ones already being painted, leaving the existing set in place. */
  addCanvases(canvas: CanvasTarget): BrowserCanvas | BrowserCanvas[]
  /** Stop playback and free the scene and GPU textures. Call it when you remove the canvas. */
  dispose(): void
}

/**
 * The simplified player {@link renderTexture} returns. A texture redraw is a
 * single `drawImage`, so none of the heavier machinery exists: no frame cache,
 * no offscreen pausing, no frames timeline.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/advanced-api.md#texture-players
 */
export interface TexturePlayer {
  /** The canvas being painted: the one you passed, or a new one. An array if `canvas` was one. */
  canvas: BrowserCanvas | BrowserCanvas[]
  /** `false` when the texture turned out static, with everything no-oping and a `duration` of `0`. */
  animated: boolean
  /** Whether playback is running. */
  readonly playing: boolean
  /** Total loop length in ms. */
  readonly duration: number
  /** Resume playback, snapping back onto the global clock. */
  play(): void
  /** Stop playback. */
  pause(): void
  /** Point the player at a different set of canvases, replacing the current ones and returning the new `canvas` value. */
  setCanvases(canvas: CanvasTarget): BrowserCanvas | BrowserCanvas[]
  /** Add canvases to the ones already being painted, leaving the existing set in place. */
  addCanvases(canvas: CanvasTarget): BrowserCanvas | BrowserCanvas[]
  /** End the redraws. There's nothing on the GPU to free. */
  dispose(): void
}

/**
 * What `upgradable: true` returns instead of the bare canvas. A fully static
 * scene is freed the moment the pixels land as always, but a scene that *could*
 * have animated is kept alive, so the render can become a player later without
 * redoing any of the work.
 *
 * An unupgraded handle holds its scene until you call `toAnimated()` or
 * `dispose()`, so `dispose()` the ones you never upgrade.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/advanced-api.md#upgradable-renders
 */
export interface UpgradableHandle {
  /** The canvas (or array), exactly what the render would have returned without the option. */
  canvas: BrowserCanvas | BrowserCanvas[]
  /**
   * Only present when the model animates, so its existence is the "would this
   * animate" check. Builds the player `animated: true` would have made, painting
   * into the same canvas and placement.
   *
   * Pass `canvas` to send the animation somewhere else, taking the same forms as
   * the render's own `canvas` option; anything an entry leaves out inherits from
   * the original call. Repeat calls return the same player, and passing canvases
   * to one throws. Returns `null` after `dispose()`.
   */
  toAnimated?(canvas?: CanvasTarget): Player | null
  /** Only present alongside `toAnimated()`. Frees the retained scene, or the player if you upgraded. */
  dispose?(): void
}

/**
 * {@link renderTexture}'s upgradable handle. Its `toAnimated` takes a single
 * replacement canvas, matching the function's own `canvas` option, and an
 * unupgraded handle holds nothing heavy: a texture redraw needs no retained scene.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/advanced-api.md#upgradable-renders
 */
export interface TextureUpgradableHandle {
  /** The canvas the static frame was drawn into, or the array if `canvas` was one. */
  canvas: BrowserCanvas | BrowserCanvas[]
  /** Only present when the texture animates. Returns `null` after `dispose()`. */
  toAnimated?(canvas?: CanvasTarget): TexturePlayer | null
  /** Only present alongside `toAnimated()`. */
  dispose?(): void
}

/** The browser-side output options every model render function takes. */
export interface BrowserRenderOptions extends RenderOptionsCommon {
  /** Return a live {@link Player} instead of a canvas. Default `false`. */
  animated?: boolean
  /** A canvas to draw into, or an array of canvases/descriptors. Omit to get a fresh canvas back. */
  canvas?: CanvasTarget
  /** Placement mode: draw into a region of the canvas without resizing or clearing it. */
  x?: number
  /** Placement mode. The other axis defaults to `0`. */
  y?: number
  /** Clear the target rect before drawing. Default `true`, or `false` in placement mode. */
  clear?: boolean
  /**
   * Player frame caching. `"auto"` caches when one full loop fits `cacheBudget`,
   * `true` always caches, `false` never does. Default `"auto"`.
   */
  cache?: "auto" | boolean
  /** Frame cache budget in bytes. Default `4194304` (4MB). */
  cacheBudget?: number
  /** Players pause automatically while scrolled offscreen. Default `true`. */
  pauseOffscreen?: boolean
  /** Static renders return an {@link UpgradableHandle} instead of the bare canvas. Default `false`. */
  upgradable?: boolean
}

/** {@link renderModelScene}'s options: the same output options, with nothing to look up. */
export interface SceneRenderOptions extends Omit<BrowserRenderOptions, "assets"> {
  assets?: AssetsInput
}

export interface RenderBlockArgs extends BrowserRenderOptions, BlockRenderInput {}
export interface RenderItemArgs extends BrowserRenderOptions, ItemRenderInput {}
export interface RenderModelArgs extends BrowserRenderOptions, ModelRenderInput {}
export interface RenderTextureArgs extends TextureRenderInput {
  /** Play the texture's animation, returning a {@link TexturePlayer}. Default `false`. */
  animated?: boolean
  /** A canvas to draw into, or an array of canvases/descriptors. Omit to get a fresh canvas back. */
  canvas?: CanvasTarget
  /** Placement mode: draw into a region of the canvas without resizing or clearing it. */
  x?: number
  /** Placement mode. The other axis defaults to `0`. */
  y?: number
  /** Clear the target rect before drawing. Default `true`, or `false` in placement mode. */
  clear?: boolean
  /** Static renders return a {@link TextureUpgradableHandle} that can upgrade to a texture player later. Default `false`. */
  upgradable?: boolean
}

/**
 * Render a block state by id, using the resource pack's blockstates and models.
 *
 * Returns the canvas you passed or a fresh one, the array back if `canvas` was
 * an array, a {@link Player} with `animated: true`, or an
 * {@link UpgradableHandle} with `upgradable: true`.
 *
 * @example
 * const canvas = await renderBlock({ id: "stone", assets })
 * document.body.append(canvas)
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/standard-api.md#renderblockargs
 */
export function renderBlock(args: RenderBlockArgs & { animated: true }): Promise<Player>
export function renderBlock(args: RenderBlockArgs & { upgradable: true }): Promise<UpgradableHandle>
export function renderBlock(args: RenderBlockArgs & { canvas: Array<BrowserCanvas | CanvasDescriptor> }): Promise<BrowserCanvas[]>
export function renderBlock(args: RenderBlockArgs): Promise<BrowserCanvas>

/**
 * Render an item by id, using its item definition.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/standard-api.md#renderitemargs
 */
export function renderItem(args: RenderItemArgs & { animated: true }): Promise<Player>
export function renderItem(args: RenderItemArgs & { upgradable: true }): Promise<UpgradableHandle>
export function renderItem(args: RenderItemArgs & { canvas: Array<BrowserCanvas | CanvasDescriptor> }): Promise<BrowserCanvas[]>
export function renderItem(args: RenderItemArgs): Promise<BrowserCanvas>

/**
 * Render a model JSON directly, bypassing blockstate and item definition lookup.
 * Nothing is imposed on a model that carries no transform, so item models render
 * face-on like the game; pass `DISPLAYS.block` for the isometric look.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/standard-api.md#rendermodelargs
 */
export function renderModel(args: RenderModelArgs & { animated: true }): Promise<Player>
export function renderModel(args: RenderModelArgs & { upgradable: true }): Promise<UpgradableHandle>
export function renderModel(args: RenderModelArgs & { canvas: Array<BrowserCanvas | CanvasDescriptor> }): Promise<BrowserCanvas[]>
export function renderModel(args: RenderModelArgs): Promise<BrowserCanvas>

/**
 * Render a texture on its own: a plain 2d canvas draw, pixel-crisp, with
 * animated textures playing per their `.mcmeta`.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/standard-api.md#rendertextureargs
 */
export function renderTexture(args: RenderTextureArgs & { animated: true }): Promise<TexturePlayer>
export function renderTexture(args: RenderTextureArgs & { upgradable: true }): Promise<TextureUpgradableHandle>
export function renderTexture(args: RenderTextureArgs): Promise<BrowserCanvas>

/**
 * A fresh three.js scene and orthographic camera configured for block rendering.
 * Async in the browser, since three resolves lazily.
 *
 * The camera carries `fitAspect = true`, telling {@link renderModelScene} to
 * match the camera frustum to the output aspect ratio so non-square renders
 * aren't squished.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#makemodelscene
 */
export function makeModelScene(): Promise<{ scene: ThreeModule.Scene, camera: FitAspect<ThreeModule.OrthographicCamera> }>

/**
 * Render a scene, honouring the same canvas and placement options as the
 * standard render functions. Translucent faces are depth-sorted once against the
 * given camera first, so water behind glass draws correctly.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#rendermodelscenescene-camera-args
 */
export function renderModelScene(scene: ThreeModule.Scene, camera: FitAspect<ThreeModule.Camera>, args: SceneRenderOptions & { animated: true }): Promise<Player>
export function renderModelScene(scene: ThreeModule.Scene, camera: FitAspect<ThreeModule.Camera>, args?: SceneRenderOptions): Promise<BrowserCanvas | BrowserCanvas[]>

/**
 * Build a resolved model's geometry and materials as a three.js group, adding it
 * to `scene` when one is given. Pass `null` for `scene` to just get the group.
 *
 * In the browser the loaded model animates on its own, driven off the
 * page-global clock via `onBeforeRender`, so an app with a render loop needs
 * nothing per-frame. Pass `{ animate: false }` and use {@link createAnimator} to
 * drive it yourself.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#loadmodelscene-assets-model-args
 */
export function loadModel(scene: ThreeModule.Object3D | null, assets: AssetsInput, model: ResolvedModel, args?: LoadModelArgs): Promise<ThreeModule.Group>

/**
 * Build a whole block scene in one call: blockstate parsing, per-position
 * variant picks, hidden-face culling, fluid shaping, waterlogging, block entity
 * models, lighting, and optimization. Feed it your raw block list as-is; the
 * skipped and technical ids are handled for you.
 *
 * @returns The scene handle, or `null` if `shouldCancel` aborted it.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#createsceneassets-blocks-args
 */
export function createScene(assets: AssetsInput, blocks: SceneBlock[], args?: CreateSceneOptions): Promise<SceneHandle | null>

/**
 * Read a texture as ready-to-draw frames, when you want an image rather than a
 * model. Animated textures are sliced per their `.mcmeta` with the game's rules,
 * and `opts.onChange` subscribes to the shared animation clock.
 *
 * @returns The texture data, or `null` if the texture is missing.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/assets.md#readtexturepath-assets-opts
 */
export function readTexture(path: string, assets: AssetsInput, opts?: ReadTextureOptions<BrowserImage>): Promise<TextureData<BrowserImage> | null>

/**
 * Render 16384 map color bytes through the vanilla map palette over
 * `map_background.png`, giving a 128×128 canvas to hand back from a `mapArt`
 * callback.
 *
 * @param colors The `colors` array from a save's `map_<id>.dat`, or one you build yourself.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#map-art
 */
export function renderMapColors(assets: AssetsInput, colors: Uint8Array | number[]): Promise<BrowserCanvas>

/** Manual animation control for a {@link loadModel} group built with `animate: false`. */
export interface Animator {
  /** `false` if there's nothing in the object to animate. */
  readonly animated: boolean
  /**
   * Advance everything animated in the object. Omit `timeMs` to follow the
   * global clock.
   *
   * @returns Whether anything changed.
   */
  update(timeMs?: number): boolean
}

export interface ConfigureOptions {
  /** The three.js instance to use. Resolved lazily on first use otherwise. */
  THREE?: typeof ThreeModule
  /** The same thing, lowercase. */
  three?: typeof ThreeModule
  /**
   * Where to fetch the bundled `assets.zip` from, when the module URL doesn't
   * find it. `false` skips the bundled assets entirely.
   */
  assetsUrl?: string | false
  /**
   * Fix the animation clock to an absolute epoch on the
   * `performance.timeOrigin + performance.now()` scale, so renders from separate
   * JavaScript contexts (a worker pool) animate in phase. Derive one value in
   * the primary context and hand that same number to every other one.
   */
  clockStart?: number
}

/**
 * Browser only. Optional overrides, called before first use.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/standard-api.md#browser-only-exports
 */
export function configure(opts: ConfigureOptions): void

/**
 * Browser only. Resolve and return the three.js instance the library uses:
 * whatever {@link configure} was given, an `import("three")`, or a `THREE` global.
 * Build your own scenes from it rather than a second three copy.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/standard-api.md#providing-threejs-browser
 */
export function getThree(): Promise<typeof ThreeModule>

/**
 * Browser only. The resolved three.js instance as a live binding, populated
 * after first use. `null` until then; {@link getThree} resolves it on demand.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/standard-api.md#providing-threejs-browser
 */
export const THREE: typeof ThreeModule | null

/**
 * Browser only. Freeze the page-global animation clock: every player and
 * {@link loadModel} scene stops where it is. Unlike `player.pause()`, resuming
 * continues seamlessly from the frozen moment rather than snapping back onto a
 * running clock.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/standard-api.md#animated-renders-browser
 */
export function pauseAnimations(): void

/**
 * Browser only. Resume the page-global animation clock.
 *
 * @param clockStart Rebase onto this absolute epoch instead of the locally
 * measured pause, so several contexts resume on one exact timeline.
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/advanced-api.md#syncing-the-animation-clock
 */
export function resumeAnimations(clockStart?: number): void

/**
 * Browser only. Manual animation control for a {@link loadModel} group, for
 * scrubbing, pausing, or driving from your own clock. Pass `{ animate: false }`
 * to `loadModel` first to opt out of the automatic animator.
 *
 * @example
 * const animator = createAnimator(group)
 * animator.update(2000)   // scrub to 2s in
 * renderer.render(scene, camera)
 *
 * @see https://github.com/ewanhowell5195/block-model-renderer/blob/master/docs/scenes.md#animation-browser
 */
export function createAnimator(root: ThreeModule.Object3D): Animator
