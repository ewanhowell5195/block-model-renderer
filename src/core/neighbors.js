const FACE_OFFSETS = [["up", [0, 1, 0]], ["down", [0, -1, 0]], ["north", [0, 0, -1]], ["south", [0, 0, 1]], ["west", [-1, 0, 0]], ["east", [1, 0, 0]]]

const none = q => Array.isArray(q?.[0]) ? q.map(() => null) : null

export function neighborLookup(fn) {
  if (typeof fn !== "function") return none
  return q => Array.isArray(q[0]) ? q.map(o => fn(o) ?? null) : fn(q) ?? null
}

export function faceNeighbors(fn) {
  const out = {}
  for (const [dir, offset] of FACE_OFFSETS) {
    const v = fn(offset)
    if (v) out[dir] = v
  }
  return out
}
