// Rectangle order must match the js walk: it sorted `(b + M) * W + (a + M)`
// ascending, so b then a, which a row by row walk gives for free.

use std::collections::HashMap;

const ABSENT: u8 = 0;
const PRESENT: u8 = 1;
const DONE: u8 = 2;

// past this the dense buffer would be too big, so the sparse walk takes over
const MAX_DENSE: u64 = 16 << 20;

/// `[grid, a, b, ...]` in, `[grid, a0, a1, b0, b1, ...]` out, grids ascending.
pub fn greedy_mesh(triples: &[i32], grid_count: usize) -> Vec<i32> {
    if triples.len() < 3 || grid_count == 0 {
        return Vec::new();
    }

    let n = triples.len() / 3;
    let mut starts = vec![0u32; grid_count + 1];
    for i in 0..n {
        let g = triples[i * 3];
        if g >= 0 && (g as usize) < grid_count {
            starts[g as usize + 1] += 1;
        }
    }
    for g in 0..grid_count {
        starts[g + 1] += starts[g];
    }
    let total = starts[grid_count] as usize;
    let mut cursor = starts.clone();
    let mut cells_a = vec![0i32; total];
    let mut cells_b = vec![0i32; total];
    for i in 0..n {
        let g = triples[i * 3];
        if g < 0 || (g as usize) >= grid_count {
            continue;
        }
        let slot = &mut cursor[g as usize];
        cells_a[*slot as usize] = triples[i * 3 + 1];
        cells_b[*slot as usize] = triples[i * 3 + 2];
        *slot += 1;
    }

    let mut out: Vec<i32> = Vec::with_capacity(total / 2 + 8);
    let mut state: Vec<u8> = Vec::new();

    for g in 0..grid_count {
        let lo = starts[g] as usize;
        let hi = starts[g + 1] as usize;
        if lo == hi {
            continue;
        }
        let (mut min_a, mut max_a) = (i32::MAX, i32::MIN);
        let (mut min_b, mut max_b) = (i32::MAX, i32::MIN);
        for i in lo..hi {
            let (a, b) = (cells_a[i], cells_b[i]);
            if a < min_a {
                min_a = a
            }
            if a > max_a {
                max_a = a
            }
            if b < min_b {
                min_b = b
            }
            if b > max_b {
                max_b = b
            }
        }
        let span_a = (max_a as i64 - min_a as i64 + 1) as u64;
        let span_b = (max_b as i64 - min_b as i64 + 1) as u64;

        if span_a.saturating_mul(span_b) > MAX_DENSE {
            sparse_grid(g as i32, &cells_a[lo..hi], &cells_b[lo..hi], &mut out);
            continue;
        }

        let w = span_a as usize;
        let h = span_b as usize;
        state.clear();
        state.resize(w * h, ABSENT);
        for i in lo..hi {
            state[(cells_b[i] - min_b) as usize * w + (cells_a[i] - min_a) as usize] = PRESENT;
        }

        for row in 0..h {
            let row_off = row * w;
            for col in 0..w {
                if state[row_off + col] != PRESENT {
                    continue;
                }
                let mut a1 = col;
                while a1 + 1 < w && state[row_off + a1 + 1] == PRESENT {
                    a1 += 1;
                }
                let mut b1 = row;
                while b1 + 1 < h {
                    let probe = (b1 + 1) * w;
                    let mut ok = true;
                    for c in col..=a1 {
                        if state[probe + c] != PRESENT {
                            ok = false;
                            break;
                        }
                    }
                    if !ok {
                        break;
                    }
                    b1 += 1;
                }
                for r in row..=b1 {
                    let off = r * w;
                    for c in col..=a1 {
                        state[off + c] = DONE;
                    }
                }
                out.extend_from_slice(&[
                    g as i32,
                    min_a + col as i32,
                    min_a + a1 as i32,
                    min_b + row as i32,
                    min_b + b1 as i32,
                ]);
            }
        }
    }
    out
}

fn sparse_grid(g: i32, cells_a: &[i32], cells_b: &[i32], out: &mut Vec<i32>) {
    let mut state: HashMap<(i32, i32), u8> = HashMap::with_capacity(cells_a.len());
    let mut sorted: Vec<(i32, i32)> = Vec::with_capacity(cells_a.len());
    for i in 0..cells_a.len() {
        let key = (cells_b[i], cells_a[i]);
        if state.insert(key, PRESENT).is_none() {
            sorted.push(key);
        }
    }
    sorted.sort_unstable();
    for &(b0, a0) in &sorted {
        if state[&(b0, a0)] != PRESENT {
            continue;
        }
        let mut a1 = a0;
        while state.get(&(b0, a1 + 1)) == Some(&PRESENT) {
            a1 += 1;
        }
        let mut b1 = b0;
        loop {
            let row = b1 + 1;
            let mut ok = true;
            for a in a0..=a1 {
                if state.get(&(row, a)) != Some(&PRESENT) {
                    ok = false;
                    break;
                }
            }
            if !ok {
                break;
            }
            b1 = row;
        }
        for b in b0..=b1 {
            for a in a0..=a1 {
                if let Some(v) = state.get_mut(&(b, a)) {
                    *v = DONE;
                }
            }
        }
        out.extend_from_slice(&[g, a0, a1, b0, b1]);
    }
}
