import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const pkg = path.join(root, "rust", "pkg")
const out = path.join(root, "wasm")

execFileSync("wasm-pack", ["build", "--target", "web", "--release", "--features", "wasm"], {
  cwd: path.join(root, "rust"),
  stdio: "inherit",
  shell: process.platform === "win32"
})

const RESET = `
export function memoryBytes() {
    return wasm ? wasm.memory.buffer.byteLength : 0;
}

export function reinstantiate() {
    if (!wasmModule) return;
    const module = wasmModule;
    wasm = undefined;
    initSync({ module });
}
`

const glue = fs.readFileSync(path.join(pkg, "block_model_renderer.js"), "utf8")
if (!glue.includes("let wasmModule, wasmInstance, wasm;") || !glue.includes("function initSync(module)")) {
  throw new Error("the wasm-bindgen glue changed shape, so memoryBytes and reinstantiate can't be added")
}

fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, "block_model_renderer.js"), glue + RESET)
fs.writeFileSync(path.join(out, "block_model_renderer.d.ts"), fs.readFileSync(path.join(pkg, "block_model_renderer.d.ts"), "utf8") + "\nexport function memoryBytes(): number;\nexport function reinstantiate(): void;\n")

fs.copyFileSync(path.join(pkg, "block_model_renderer_bg.wasm"), path.join(out, "block_model_renderer_bg.wasm"))

console.log(`wasm: ${(fs.statSync(path.join(out, "block_model_renderer_bg.wasm")).size / 1024).toFixed(1)}KB`)
