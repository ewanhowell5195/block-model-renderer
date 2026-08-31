/* tslint:disable */
/* eslint-disable */

export class Emitted {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    color(i: number): Uint8Array;
    faceData(i: number): Float32Array;
    normal(i: number): Float32Array;
    position(i: number): Float32Array;
    uv(i: number): Float32Array;
    readonly count: number;
}

export class LightVolume {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    blockLight(): Uint8Array;
    bytes(): Uint8Array;
    skyLight(): Uint8Array;
}

/**
 * `damp` uses -1 for "no state", and `mask_off` indexes `masks` in six-face
 * blocks of 16 rows each.
 */
export function computeLightVolume(w: number, h: number, d: number, cell_state: Uint16Array, damp: Int32Array, emit: Uint8Array, ao: Uint8Array, mask_off: Int32Array, masks: Uint16Array, has_sky_light: boolean): LightVolume;

/**
 * Layouts are at `emit::QUAD_STRIDE` and `emit::FACE_STRIDE`.
 */
export function emitQuads(quads: Float64Array, faces: Float64Array, acc_count: number): Emitted;

/**
 * `triples` is `[grid, a, b, ...]`, the result is `[grid, a0, a1, b0, b1, ...]`.
 */
export function greedyMesh(triples: Int32Array, grid_count: number): Int32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_emitted_free: (a: number, b: number) => void;
    readonly __wbg_lightvolume_free: (a: number, b: number) => void;
    readonly computeLightVolume: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => number;
    readonly emitQuads: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly emitted_color: (a: number, b: number) => [number, number];
    readonly emitted_count: (a: number) => number;
    readonly emitted_faceData: (a: number, b: number) => [number, number];
    readonly emitted_normal: (a: number, b: number) => [number, number];
    readonly emitted_position: (a: number, b: number) => [number, number];
    readonly emitted_uv: (a: number, b: number) => [number, number];
    readonly greedyMesh: (a: number, b: number, c: number) => [number, number];
    readonly lightvolume_blockLight: (a: number) => [number, number];
    readonly lightvolume_bytes: (a: number) => [number, number];
    readonly lightvolume_skyLight: (a: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
