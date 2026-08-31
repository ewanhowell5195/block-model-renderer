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

fs.mkdirSync(out, { recursive: true })
fs.copyFileSync(path.join(pkg, "block_model_renderer.js"), path.join(out, "block_model_renderer.js"))
fs.copyFileSync(path.join(pkg, "block_model_renderer.d.ts"), path.join(out, "block_model_renderer.d.ts"))

fs.copyFileSync(path.join(pkg, "block_model_renderer_bg.wasm"), path.join(out, "block_model_renderer_bg.wasm"))

console.log(`wasm: ${(fs.statSync(path.join(out, "block_model_renderer_bg.wasm")).size / 1024).toFixed(1)}KB`)
