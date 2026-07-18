// Packs every assets/ directory (overrides, versioned overrides_*, fallbacks)
// into a single assets.zip so the web platform can fetch the bundled assets in
// one request. Run on prepublish.
import { buildZip } from "../src/zip.js"
import { fileURLToPath } from "node:url"
import zlib from "node:zlib"
import path from "node:path"
import fs from "node:fs"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

function collect(dir, prefix, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const rel = `${prefix}/${entry.name}`
    if (entry.isDirectory()) collect(full, rel, out)
    else out[rel] = fs.readFileSync(full)
  }
  return out
}

const files = {}
for (const entry of fs.readdirSync(path.join(root, "assets"), { withFileTypes: true })) {
  if (entry.isDirectory()) collect(path.join(root, "assets", entry.name), entry.name, files)
}

const zip = buildZip(files, data => zlib.deflateRawSync(data, { level: 9 }))
fs.writeFileSync(path.join(root, "assets.zip"), zip)

const raw = Object.values(files).reduce((s, d) => s + d.length, 0)
console.log(`assets.zip: ${Object.keys(files).length} files, ${(raw / 1024).toFixed(0)}KB -> ${(zip.length / 1024).toFixed(0)}KB`)
