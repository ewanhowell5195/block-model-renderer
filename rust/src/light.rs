// Faces run west, east, down, up, north, south, so the opposite of `d` is
// always `d ^ 1`.

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

const FACE_DOWN: usize = 2;
const FACE_UP: usize = 3;

// dx, dy, dz per face
const DIR: [(i32, i32, i32); 6] = [
    (-1, 0, 0),
    (1, 0, 0),
    (0, -1, 0),
    (0, 1, 0),
    (0, 0, -1),
    (0, 0, 1),
];

#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub struct LightVolume {
    block: Vec<u8>,
    sky: Vec<u8>,
    bytes: Vec<u8>,
    ao: Vec<u8>,
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
impl LightVolume {
    #[cfg_attr(feature = "wasm", wasm_bindgen(js_name = blockLight))]
    pub fn block_light(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.block)
    }
    #[cfg_attr(feature = "wasm", wasm_bindgen(js_name = skyLight))]
    pub fn sky_light(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.sky)
    }
    pub fn bytes(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.bytes)
    }
    pub fn ao(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.ao)
    }
}

pub struct States<'a> {
    /// -1 marks a cell with no state at all
    pub damp: &'a [i32],
    pub emit: &'a [u8],
    pub ao: &'a [u8],
    /// offset into `masks` for this state's six faces, -1 when it has none
    pub mask_off: &'a [i32],
    pub masks: &'a [u16],
}

impl<'a> States<'a> {
    #[inline]
    fn damp_of(&self, si: usize) -> i32 {
        self.damp.get(si).copied().unwrap_or(-1)
    }
    #[inline]
    fn face(&self, si: usize, dir: usize) -> Option<&'a [u16]> {
        let off = *self.mask_off.get(si)?;
        if off < 0 {
            return None;
        }
        let start = off as usize + dir * 16;
        self.masks.get(start..start + 16)
    }
}

#[inline]
fn union_covers(a: Option<&[u16]>, b: Option<&[u16]>) -> bool {
    for v in 0..16 {
        let av = a.map_or(0, |m| m[v]);
        let bv = b.map_or(0, |m| m[v]);
        if av | bv != 0xffff {
            return false;
        }
    }
    true
}

fn state_info(st: &States) -> Vec<u32> {
    let mut info = vec![1u32; 65536];
    for (si, v) in info.iter_mut().enumerate().take(st.damp.len().max(st.mask_off.len())) {
        let (mut has, mut full) = (0u32, 0u32);
        for dir in 0..6 {
            if let Some(m) = st.face(si, dir) {
                has |= 1 << dir;
                if m.iter().all(|&v| v == 0xffff) {
                    full |= 1 << dir;
                }
            }
        }
        *v = st.damp_of(si).max(1) as u32 | has << 8 | full << 16;
    }
    info
}

#[allow(clippy::too_many_arguments)]
fn spread(
    light: &mut [u8],
    cell_state: &[u16],
    st: &States,
    info: &[u32],
    mut buckets: Vec<Vec<u32>>,
    w: usize,
    h: usize,
    d: usize,
) {
    let stride_y = w;
    let stride_z = w * h;
    for lvl in (2..=15i32).rev() {
        let bucket = std::mem::take(&mut buckets[lvl as usize]);
        for &i in &bucket {
            let i = i as usize;
            if light[i] as i32 != lvl {
                continue;
            }
            let x = i % w;
            let r = i / w;
            let y = r % h;
            let z = r / h;
            let from = cell_state[i] as usize;
            let from_info = info[from];
            let from_has = from_info >> 8;
            let from_full = from_info >> 16;
            let interior = x > 0 && x < w - 1 && y > 0 && y < h - 1 && z > 0 && z < d - 1;
            for di in 0..6 {
                let (dx, dy, dz) = DIR[di];
                if !interior {
                    if dx == -1 && x == 0 {
                        continue;
                    }
                    if dx == 1 && x == w - 1 {
                        continue;
                    }
                    if dy == -1 && y == 0 {
                        continue;
                    }
                    if dy == 1 && y == h - 1 {
                        continue;
                    }
                    if dz == -1 && z == 0 {
                        continue;
                    }
                    if dz == 1 && z == d - 1 {
                        continue;
                    }
                }
                let j = (i as i32 + dx + dy * stride_y as i32 + dz * stride_z as i32) as usize;
                let to = cell_state[j] as usize;
                let to_info = info[to];
                let nl = lvl - (to_info & 0xff) as i32;
                if nl <= light[j] as i32 {
                    continue;
                }
                let od = di ^ 1;
                let f_bit = from_has & (1 << di);
                let t_bit = (to_info >> 8) & (1 << od);
                if f_bit != 0 || t_bit != 0 {
                    if from_full & (1 << di) != 0 || (to_info >> 16) & (1 << od) != 0 {
                        continue;
                    }
                    let from_face = if f_bit != 0 { st.face(from, di) } else { None };
                    let to_face = if t_bit != 0 { st.face(to, od) } else { None };
                    if union_covers(from_face, to_face) {
                        continue;
                    }
                }
                light[j] = nl as u8;
                if nl > 1 {
                    buckets[nl as usize].push(j as u32);
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn compute_volume(
    w: usize,
    h: usize,
    d: usize,
    cell_state: &[u16],
    st: &States,
    has_sky_light: bool,
    split: bool,
) -> LightVolume {
    let n = w * h * d;
    let stride_y = w;
    let stride_z = w * h;
    let mut block_light = vec![0u8; n];
    let mut sky_light = vec![0u8; n];
    let mut sky_buckets: Vec<Vec<u32>> = (0..16).map(|_| Vec::new()).collect();

    if has_sky_light {
        let mut bottom = vec![h; w * d];
        for z in 0..d {
            for x in 0..w {
                let mut above: Option<&[u16]> = None;
                for y in (0..h).rev() {
                    let i = (z * h + y) * w + x;
                    let si = cell_state[i] as usize;
                    let damp = st.damp_of(si);
                    if damp >= 0 && damp != 0 {
                        break;
                    }
                    let up = st.face(si, FACE_UP);
                    if (above.is_some() || up.is_some()) && union_covers(above, up) {
                        break;
                    }
                    sky_light[i] = 15;
                    bottom[z * w + x] = y;
                    above = st.face(si, FACE_DOWN);
                }
            }
        }
        for z in 0..d {
            for x in 0..w {
                let c = z * w + x;
                let b = bottom[c];
                let mut top = b + 1;
                if x > 0 {
                    top = top.max(bottom[c - 1]);
                }
                if x < w - 1 {
                    top = top.max(bottom[c + 1]);
                }
                if z > 0 {
                    top = top.max(bottom[c - w]);
                }
                if z < d - 1 {
                    top = top.max(bottom[c + w]);
                }
                for y in b..top.min(h) {
                    sky_buckets[15].push(((z * h + y) * w + x) as u32);
                }
            }
        }
    }

    let mut block_buckets: Vec<Vec<u32>> = (0..16).map(|_| Vec::new()).collect();
    for i in 0..n {
        let si = cell_state[i] as usize;
        if st.damp_of(si) >= 0 {
            let e = st.emit.get(si).copied().unwrap_or(0);
            if e != 0 {
                block_light[i] = e;
                if e > 1 {
                    block_buckets[e as usize & 15].push(i as u32);
                }
            }
        }
    }

    let info = state_info(st);
    spread(&mut block_light, cell_state, st, &info, block_buckets, w, h, d);
    spread(&mut sky_light, cell_state, st, &info, sky_buckets, w, h, d);

    let states = st.damp.len().max(st.emit.len());
    let mut state_solid = vec![false; states];
    let mut state_ao = vec![false; states];
    let mut state_emit = vec![0u8; states];
    for si in 0..states {
        let damp = st.damp_of(si);
        state_solid[si] = damp == 15;
        state_ao[si] = damp == 15 || (damp >= 0 && st.ao.get(si).copied().unwrap_or(0) != 0);
        if damp >= 0 {
            state_emit[si] = st.emit.get(si).copied().unwrap_or(0);
        }
    }
    let solid = |i: usize| state_solid.get(cell_state[i] as usize).copied().unwrap_or(false);
    let ao_cell = |i: usize| state_ao.get(cell_state[i] as usize).copied().unwrap_or(false);
    let mut level = [[0u8; 256]; 16];
    for (open, row) in level.iter_mut().enumerate() {
        for (sum, v) in row.iter_mut().enumerate() {
            let avg = if open != 0 { sum as f64 / open as f64 } else { sum as f64 / 8.0 };
            *v = js_round(avg * 17.0);
        }
    }
    let own_block = |i: usize| state_emit.get(cell_state[i] as usize).copied().unwrap_or(0);

    for i in 0..n {
        if !solid(i) {
            continue;
        }
        let x = i % w;
        let r = i / w;
        let y = r % h;
        let z = r / h;
        let mut bl = own_block(i);
        let mut sl = 0u8;
        let mut take = |j: usize| {
            let (jb, js) = if solid(j) { (own_block(j), 0) } else { (block_light[j], sky_light[j]) };
            if jb > bl {
                bl = jb
            }
            if js > sl {
                sl = js
            }
        };
        if x > 0 {
            take(i - 1)
        }
        if x < w - 1 {
            take(i + 1)
        }
        if y > 0 {
            take(i - stride_y)
        }
        if y < h - 1 {
            take(i + stride_y)
        }
        if z > 0 {
            take(i - stride_z)
        }
        if z < d - 1 {
            take(i + stride_z)
        }
        block_light[i] = bl;
        sky_light[i] = sl;
    }

    // y slices tiled into one texture
    let w2 = w + 1;
    let h2 = h + 1;
    let d2 = d + 1;
    let cols = (h2 as f64).sqrt().ceil() as usize;
    let rows = (h2 + cols - 1) / cols;
    let tex_w = cols * w2;
    let tex_h = rows * d2;
    let texels = tex_w * tex_h;
    let mut bytes = vec![0u8; texels * if split { 2 } else { 4 }];
    let mut ao_bytes = if split { vec![0u8; texels] } else { Vec::new() };

    let hw = h * w;

    let clamp_idx = |x: i32, y: i32, z: i32| -> usize {
        let cz = z.clamp(0, d as i32 - 1) as usize;
        let cy = y.clamp(0, h as i32 - 1) as usize;
        let cx = x.clamp(0, w as i32 - 1) as usize;
        (cz * h + cy) * w + cx
    };

    let pack = |ci: usize| -> u64 {
        let (b, s) = (block_light[ci] as u64, sky_light[ci] as u64);
        if solid(ci) {
            b << 24 | s << 32
        } else {
            b | s << 8 | 1 << 16
        }
    };
    let mut col = vec![0u64; w];
    for y in 0..=h {
        let tx = (y % cols) * w2;
        let ty = (y / cols) * d2;
        for z in 0..=d {
            let mut ti = (ty + z) * tex_w + tx;
            let inner = y >= 1 && y < h && z >= 1 && z < d;
            if inner {
                let base = ((z - 1) * h + (y - 1)) * w;
                for (x, c) in col.iter_mut().enumerate() {
                    let ci = base + x;
                    *c = pack(ci) + pack(ci + w) + pack(ci + hw) + pack(ci + hw + w);
                }
            }
            for x in 0..=w {
                let mut v = 0u64;
                if inner && x >= 1 && x < w {
                    v = col[x - 1] + col[x];
                } else {
                    for dy in -1..=0 {
                        for dz in -1..=0 {
                            for dx in -1..=0 {
                                v += pack(clamp_idx(x as i32 + dx, y as i32 + dy, z as i32 + dz));
                            }
                        }
                    }
                }
                let open = (v >> 16) as usize & 15;
                let row = &level[open];
                let lit = if open != 0 { v } else { v >> 24 };
                let ao = if x < w && y < h && z < d && ao_cell((z * h + y) * w + x) { 255 } else { 0 };
                let (r, g) = (row[lit as u8 as usize], row[(lit >> 8) as u8 as usize]);
                if split {
                    bytes[ti * 2..ti * 2 + 2].copy_from_slice(&[r, g]);
                    ao_bytes[ti] = ao;
                } else {
                    bytes[ti * 4..ti * 4 + 4].copy_from_slice(&[r, g, ao, 255]);
                }
                ti += 1;
            }
        }
    }

    for i in 0..n {
        if solid(i) {
            block_light[i] = own_block(i);
            sky_light[i] = 0;
        }
    }

    LightVolume {
        block: block_light,
        sky: sky_light,
        bytes,
        ao: ao_bytes,
    }
}

// Math.round, which breaks ties upward rather than away from zero
#[inline]
fn js_round(v: f64) -> u8 {
    let r = (v + 0.5).floor();
    if r < 0.0 {
        0
    } else if r > 255.0 {
        255
    } else {
        r as u8
    }
}
