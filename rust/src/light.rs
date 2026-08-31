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

fn spread(light: &mut [u8], cell_state: &[u16], st: &States, w: usize, h: usize, d: usize) {
    let stride_y = w;
    let stride_z = w * h;
    let mut buckets: Vec<Vec<usize>> = (0..16).map(|_| Vec::new()).collect();
    for (i, &l) in light.iter().enumerate() {
        if l > 1 {
            buckets[l as usize].push(i);
        }
    }
    for lvl in (2..=15i32).rev() {
        let mut bi = 0;
        while bi < buckets[lvl as usize].len() {
            let i = buckets[lvl as usize][bi];
            bi += 1;
            if light[i] as i32 != lvl {
                continue;
            }
            let x = i % w;
            let r = i / w;
            let y = r % h;
            let z = r / h;
            let from = cell_state[i] as usize;
            for di in 0..6 {
                let (dx, dy, dz) = DIR[di];
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
                let j = (i as i32 + dx + dy * stride_y as i32 + dz * stride_z as i32) as usize;
                let to = cell_state[j] as usize;
                let to_damp = st.damp_of(to).max(0);
                let nl = lvl - to_damp.max(1);
                if nl <= light[j] as i32 {
                    continue;
                }
                let from_face = st.face(from, di);
                let to_face = st.face(to, di ^ 1);
                if (from_face.is_some() || to_face.is_some()) && union_covers(from_face, to_face) {
                    continue;
                }
                light[j] = nl as u8;
                if nl > 1 {
                    buckets[nl as usize].push(j);
                }
            }
        }
        buckets[lvl as usize].clear();
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
) -> LightVolume {
    let n = w * h * d;
    let stride_y = w;
    let stride_z = w * h;
    let mut block_light = vec![0u8; n];
    let mut sky_light = vec![0u8; n];

    if has_sky_light {
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
                    above = st.face(si, FACE_DOWN);
                }
            }
        }
    }

    for i in 0..n {
        let si = cell_state[i] as usize;
        if st.damp_of(si) >= 0 {
            let e = st.emit.get(si).copied().unwrap_or(0);
            if e != 0 {
                block_light[i] = e;
            }
        }
    }

    spread(&mut block_light, cell_state, st, w, h, d);
    spread(&mut sky_light, cell_state, st, w, h, d);

    let mut sample_block = block_light.clone();
    let mut sample_sky = sky_light.clone();
    for i in 0..n {
        if st.damp_of(cell_state[i] as usize) != 15 {
            continue;
        }
        let x = i % w;
        let r = i / w;
        let y = r % h;
        let z = r / h;
        let mut bl = block_light[i];
        let mut sl = sky_light[i];
        let take = |j: usize, bl: &mut u8, sl: &mut u8| {
            if block_light[j] > *bl {
                *bl = block_light[j]
            }
            if sky_light[j] > *sl {
                *sl = sky_light[j]
            }
        };
        if x > 0 {
            take(i - 1, &mut bl, &mut sl)
        }
        if x < w - 1 {
            take(i + 1, &mut bl, &mut sl)
        }
        if y > 0 {
            take(i - stride_y, &mut bl, &mut sl)
        }
        if y < h - 1 {
            take(i + stride_y, &mut bl, &mut sl)
        }
        if z > 0 {
            take(i - stride_z, &mut bl, &mut sl)
        }
        if z < d - 1 {
            take(i + stride_z, &mut bl, &mut sl)
        }
        sample_block[i] = bl;
        sample_sky[i] = sl;
    }

    let mut solid = vec![0u8; n];
    let mut ao_cell = vec![0u8; n];
    for i in 0..n {
        let si = cell_state[i] as usize;
        let damp = st.damp_of(si);
        if damp == 15 {
            solid[i] = 1;
        }
        if damp == 15 || (damp >= 0 && st.ao.get(si).copied().unwrap_or(0) != 0) {
            ao_cell[i] = 1;
        }
    }

    // y slices tiled into one texture
    let w2 = w + 1;
    let h2 = h + 1;
    let d2 = d + 1;
    let cols = (h2 as f64).sqrt().ceil() as usize;
    let rows = (h2 + cols - 1) / cols;
    let tex_w = cols * w2;
    let tex_h = rows * d2;
    let mut bytes = vec![0u8; tex_w * tex_h * 4];

    let clamp_idx = |x: i32, y: i32, z: i32| -> usize {
        let cz = z.clamp(0, d as i32 - 1) as usize;
        let cy = y.clamp(0, h as i32 - 1) as usize;
        let cx = x.clamp(0, w as i32 - 1) as usize;
        (cz * h + cy) * w + cx
    };

    for y in 0..=h {
        let tx = (y % cols) * w2;
        let ty = (y / cols) * d2;
        for z in 0..=d {
            let mut ti = ((ty + z) * tex_w + tx) * 4;
            for x in 0..=w {
                let (mut bl, mut sl, mut open, mut blf, mut slf) = (0u32, 0u32, 0u32, 0u32, 0u32);
                for dy in -1..=0 {
                    for dz in -1..=0 {
                        for dx in -1..=0 {
                            let ci = clamp_idx(x as i32 + dx, y as i32 + dy, z as i32 + dz);
                            if solid[ci] != 0 {
                                blf += sample_block[ci] as u32;
                                slf += sample_sky[ci] as u32;
                            } else {
                                bl += block_light[ci] as u32;
                                sl += sky_light[ci] as u32;
                                open += 1;
                            }
                        }
                    }
                }
                let bv = if open != 0 {
                    bl as f64 / open as f64
                } else {
                    blf as f64 / 8.0
                };
                let sv = if open != 0 {
                    sl as f64 / open as f64
                } else {
                    slf as f64 / 8.0
                };
                bytes[ti] = js_round(bv * 17.0);
                bytes[ti + 1] = js_round(sv * 17.0);
                if x < w && y < h && z < d && ao_cell[(z * h + y) * w + x] != 0 {
                    bytes[ti + 2] = 255;
                }
                bytes[ti + 3] = 255;
                ti += 4;
            }
        }
    }

    LightVolume {
        block: block_light,
        sky: sky_light,
        bytes,
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
