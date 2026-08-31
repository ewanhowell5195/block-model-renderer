pub mod emit;
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
