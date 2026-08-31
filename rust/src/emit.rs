#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

pub const QUAD_STRIDE: usize = 16;
// acc, face, wpc, wALo, wAHi, wBLo, wBHi, rx, ry, rw, rh, sw, sh, tintR, tintG, tintB
// tintR < 0 means no tint, which the js wrote as white

pub const FACE_STRIDE: usize = 7 + 6 * 4;
// na, pa, pb, ns, hasFd, fd0, fd1, then six lots of (ha, hb, u, v)
// hasFd < 0 means the face writes no faceData rows

pub struct Buffers {
    pub p: Vec<f32>,
    pub n: Vec<f32>,
    pub u: Vec<f32>,
    pub f: Vec<f32>,
    pub t: Vec<u8>,
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub struct Emitted {
    bufs: Vec<Buffers>,
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
impl Emitted {
    #[cfg_attr(feature = "wasm", wasm_bindgen(getter))]
    pub fn count(&self) -> usize {
        self.bufs.len()
    }
    pub fn position(&self, i: usize) -> Vec<f32> {
        self.bufs[i].p.clone()
    }
    pub fn normal(&self, i: usize) -> Vec<f32> {
        self.bufs[i].n.clone()
    }
    pub fn uv(&self, i: usize) -> Vec<f32> {
        self.bufs[i].u.clone()
    }
    #[cfg_attr(feature = "wasm", wasm_bindgen(js_name = faceData))]
    pub fn face_data(&self, i: usize) -> Vec<f32> {
        self.bufs[i].f.clone()
    }
    pub fn color(&self, i: usize) -> Vec<u8> {
        self.bufs[i].t.clone()
    }
}

impl Emitted {
    pub fn buffers(&self) -> &[Buffers] {
        &self.bufs
    }
}

pub fn emit_quads(quads: &[f64], faces: &[f64], acc_count: usize) -> Emitted {
    let mut bufs: Vec<Buffers> = (0..acc_count)
        .map(|_| Buffers {
            p: Vec::new(),
            n: Vec::new(),
            u: Vec::new(),
            f: Vec::new(),
            t: Vec::new(),
        })
        .collect();

    let n_quads = quads.len() / QUAD_STRIDE;

    let mut verts = vec![0usize; acc_count];
    let mut fd_verts = vec![0usize; acc_count];
    for q in 0..n_quads {
        let base = q * QUAD_STRIDE;
        let acc = quads[base] as usize;
        if acc >= acc_count {
            continue;
        }
        let fi = quads[base + 1] as usize * FACE_STRIDE;
        if fi + FACE_STRIDE > faces.len() {
            continue;
        }
        verts[acc] += 6;
        if faces[fi + 4] >= 0.0 {
            fd_verts[acc] += 6;
        }
    }
    for a in 0..acc_count {
        bufs[a].p.reserve(verts[a] * 3);
        bufs[a].n.reserve(verts[a] * 3);
        bufs[a].u.reserve(verts[a] * 2);
        bufs[a].t.reserve(verts[a] * 3);
        bufs[a].f.reserve(fd_verts[a] * 2);
    }

    for q in 0..n_quads {
        let base = q * QUAD_STRIDE;
        let acc = quads[base] as usize;
        if acc >= acc_count {
            continue;
        }
        let fi = quads[base + 1] as usize * FACE_STRIDE;
        if fi + FACE_STRIDE > faces.len() {
            continue;
        }

        let wpc = quads[base + 2];
        let wa_lo = quads[base + 3];
        let wa_hi = quads[base + 4];
        let wb_lo = quads[base + 5];
        let wb_hi = quads[base + 6];
        let rx = quads[base + 7];
        let ry = quads[base + 8];
        let rw = quads[base + 9];
        let rh = quads[base + 10];
        let sw = quads[base + 11];
        let sh = quads[base + 12];
        let tint_r = quads[base + 13];
        let (tr, tg, tb) = if tint_r < 0.0 {
            (255u8, 255u8, 255u8)
        } else {
            (tint_r as u8, quads[base + 14] as u8, quads[base + 15] as u8)
        };

        let na = faces[fi] as usize;
        let pa = faces[fi + 1] as usize;
        let pb = faces[fi + 2] as usize;
        let ns = faces[fi + 3] as f32;
        let has_fd = faces[fi + 4] >= 0.0;
        let fd0 = faces[fi + 5] as f32;
        let fd1 = faces[fi + 6] as f32;

        let b = &mut bufs[acc];
        for v in 0..6 {
            let vi = fi + 7 + v * 4;
            let ha = faces[vi] >= 0.5;
            let hb = faces[vi + 1] >= 0.5;
            let vu = faces[vi + 2];
            let vv = faces[vi + 3];

            let mut p = [0f32; 3];
            let mut nn = [0f32; 3];
            p[na] = wpc as f32;
            p[pa] = (if ha { wa_hi } else { wa_lo }) as f32;
            p[pb] = (if hb { wb_hi } else { wb_lo }) as f32;
            nn[na] = ns;

            b.p.extend_from_slice(&p);
            b.n.extend_from_slice(&nn);
            b.u.push(((rx + vu * rw) / sw) as f32);
            b.u.push((1.0 - (ry + (1.0 - vv) * rh) / sh) as f32);
            b.t.extend_from_slice(&[tr, tg, tb]);
            if has_fd {
                b.f.push(fd0);
                b.f.push(fd1);
            }
        }
    }

    Emitted { bufs }
}
