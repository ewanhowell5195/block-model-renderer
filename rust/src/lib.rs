pub mod emit;
pub mod light;
pub mod mesh;

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

/// `triples` is `[grid, a, b, ...]`, the result is `[grid, a0, a1, b0, b1, ...]`.
#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = greedyMesh)]
pub fn greedy_mesh_wasm(triples: &[i32], grid_count: usize) -> Vec<i32> {
    mesh::greedy_mesh(triples, grid_count)
}

/// Layouts are at `emit::QUAD_STRIDE` and `emit::FACE_STRIDE`.
#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = emitQuads)]
pub fn emit_quads_wasm(quads: &[f64], faces: &[f64], acc_count: usize) -> emit::Emitted {
    emit::emit_quads(quads, faces, acc_count)
}

/// `damp` uses -1 for "no state", and `mask_off` indexes `masks` in six-face
/// blocks of 16 rows each.
#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = computeLightVolume)]
#[allow(clippy::too_many_arguments)]
pub fn compute_light_volume_wasm(
    w: usize,
    h: usize,
    d: usize,
    cell_state: &[u16],
    damp: &[i32],
    emit: &[u8],
    ao: &[u8],
    mask_off: &[i32],
    masks: &[u16],
    has_sky_light: bool,
) -> light::LightVolume {
    let st = light::States { damp, emit, ao, mask_off, masks };
    light::compute_volume(w, h, d, cell_state, &st, has_sky_light)
}
