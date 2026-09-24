import init, { greedyMesh as rsGreedyMesh, emitQuads as rsEmitQuads, computeLightVolume as rsLightVolume, memoryBytes as rsMemoryBytes, reinstantiate as rsReinstantiate } from "../../wasm/block_model_renderer.js"

let ready = null
let broken = false
const KEEP_BYTES = 32 * 1048576

// built rather than written out, so a browser bundler does not resolve them
const NODE_FS = "node:fs/promises"
const NODE_WASM = "../../wasm/block_model_renderer_bg" + ".wasm"

const off = () => !!globalThis.__BMR_NO_WASM

export function wasmReady() {
  if (broken) return null
  ready ??= (async () => {
    // node's fetch refuses file: urls, so there the bytes are handed over
    if (globalThis.process?.versions?.node) {
      const { readFile } = await import(NODE_FS)
      await init({ module_or_path: await readFile(new URL(NODE_WASM, import.meta.url)) })
    } else await init()
    return true
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

export function settleWasm() {
  if (broken || !ready) return
  try {
    if (rsMemoryBytes() > KEEP_BYTES) rsReinstantiate()
  } catch {
    broken = true
  }
}

function recover() {
  try {
    rsReinstantiate()
  } catch {
    broken = true
  }
  return null
}

export function greedyMeshFast(triples, gridCount) {
  if (broken || off() || !ready) return null
  try {
    return rsGreedyMesh(triples, gridCount)
  } catch {
    return recover()
  }
}

export function emitQuadsFast(quads, faces, accCount) {
  if (broken || off() || !ready) return null
  try {
    return rsEmitQuads(quads, faces, accCount)
  } catch {
    return recover()
  }
}

export function computeLightVolumeFast(w, h, d, cellState, damp, emit, ao, maskOff, masks, hasSkyLight, split = false) {
  if (broken || off() || !ready) return null
  try {
    return rsLightVolume(w, h, d, cellState, damp, emit, ao, maskOff, masks, hasSkyLight, split)
  } catch {
    return recover()
  }
}
