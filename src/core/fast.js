import init, { greedyMesh as rsGreedyMesh, emitQuads as rsEmitQuads, computeLightVolume as rsLightVolume } from "../../wasm/block_model_renderer.js"
import { WASM_BASE64 } from "../../wasm/inline.js"

let ready = null
let broken = false

function bytes() {
  const bin = atob(WASM_BASE64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const off = () => !!globalThis.__BMR_NO_WASM

export function wasmReady() {
  if (broken) return null
  ready ??= init({ module_or_path: bytes() }).catch(() => {
    broken = true
    return null
  })
  return ready
}

export function wasmLoaded() {
  return !broken && !off() && ready != null
}

export async function wasmStatus() {
  await wasmReady()
  return wasmLoaded()
}

export function greedyMeshFast(triples, gridCount) {
  if (broken || off() || !ready) return null
  try {
    return rsGreedyMesh(triples, gridCount)
  } catch {
    return null
  }
}

export function emitQuadsFast(quads, faces, accCount) {
  if (broken || off() || !ready) return null
  try {
    return rsEmitQuads(quads, faces, accCount)
  } catch {
    return null
  }
}

export function computeLightVolumeFast(w, h, d, cellState, damp, emit, ao, maskOff, masks, hasSkyLight) {
  if (broken || off() || !ready) return null
  try {
    return rsLightVolume(w, h, d, cellState, damp, emit, ao, maskOff, masks, hasSkyLight)
  } catch {
    return null
  }
}
