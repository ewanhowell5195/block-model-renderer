import init, { greedyMesh as rsGreedyMesh, emitQuads as rsEmitQuads, computeLightVolume as rsLightVolume } from "../../wasm/block_model_renderer.js"

let ready = null
let broken = false

// built rather than written out, so a browser bundler does not resolve them
const NODE_FS = "node:fs/promises"

const off = () => !!globalThis.__BMR_NO_WASM

export function wasmReady() {
  if (broken) return null
  ready ??= (async () => {
    // node's fetch refuses file: urls, so there the bytes are handed over
    if (globalThis.process?.versions?.node) {
      const { readFile } = await import(NODE_FS)
      return init({ module_or_path: await readFile(new URL("../../wasm/block_model_renderer_bg.wasm", import.meta.url)) })
    }
    return init()
  })().catch(() => {
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
