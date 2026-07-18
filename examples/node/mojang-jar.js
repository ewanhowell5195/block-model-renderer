import { parseZip } from "../../src/zip.js"
import zlib from "node:zlib"
import fs from "node:fs"
import path from "node:path"

const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
const jarPath = path.join(import.meta.dirname, "assets.jar")

function jarVersion() {
  try {
    const f = parseZip(fs.readFileSync(jarPath)).get("version.json")
    const bytes = f.method === 0 ? f.data : zlib.inflateRawSync(f.data)
    return JSON.parse(new TextDecoder().decode(bytes)).id
  } catch {}
}

export async function loadMojangJar() {
  let manifest
  try {
    manifest = await fetch(MANIFEST).then(r => r.json())
  } catch (err) {
    if (fs.existsSync(jarPath)) return jarPath
    throw err
  }
  const latest = manifest.versions[0]
  if (jarVersion() === latest.id) return jarPath
  const { url, size } = (await fetch(latest.url).then(r => r.json())).downloads.client
  const res = await fetch(url)
  if (!res.ok) throw new Error(`client.jar fetch failed (${res.status})`)
  const total = +res.headers.get("content-length") || size
  const reader = res.body.getReader()
  const chunks = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    process.stdout.write(`\rDownloading ${latest.id} assets.jar: ${(got / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)}MB`)
  }
  process.stdout.write("\n")
  fs.writeFileSync(jarPath, Buffer.concat(chunks))
  return jarPath
}
