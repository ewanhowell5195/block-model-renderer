// Regenerates the hardcoded block/colour lists from the real Minecraft code.
//
// Modern server jars ship unobfuscated (real net.minecraft.* names), so instead
// of decompiling we compile a small reflection extractor (Extract.java) with javac
// and run it against the server jar. It bootstraps the registries and reads
// canOcclude(), the tint sources, DyeColor, MobEffect, etc. directly.
//
// Usage:  node tools/generate/generate.js [version]
//   version defaults to the latest snapshot from Mojang's manifest.
//   Downloads are cached under tools/generate/.cache.

import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { parseZip } from "../../src/zip.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../..")
const cache = path.join(here, ".cache")
const dataDir = path.join(root, "src/core/data")
const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"

const log = (...a) => console.log("[generate]", ...a)

async function download(url, dest) {
  if (fs.existsSync(dest)) return dest
  log("downloading", url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  return dest
}

async function resolveVersion(requested) {
  const manifest = await (await fetch(MANIFEST)).json()
  const id = requested ?? manifest.latest.snapshot
  const entry = manifest.versions.find(v => v.id === id)
  if (!entry) throw new Error(`unknown version: ${id}`)
  const meta = await (await fetch(entry.url)).json()
  const server = meta.downloads?.server?.url
  const client = meta.downloads?.client?.url
  if (!server || !client) throw new Error(`version ${id} is missing a server/client download`)
  return { id, server, client }
}

// The server jar is a "bundler": it holds the real server jar and every library
// jar as zip entries. Extract them so we can build a compile/run classpath.
function extractBundler(serverJar, outDir) {
  const files = parseZip(fs.readFileSync(serverJar))
  const jars = []
  for (const [entry, { method, data }] of files) {
    if (!entry.endsWith(".jar")) continue
    if (!entry.startsWith("META-INF/libraries/") && !entry.startsWith("META-INF/versions/")) continue
    const bytes = method === 0 ? data : zlib.inflateRawSync(data)
    const dest = path.join(outDir, path.basename(entry))
    fs.writeFileSync(dest, bytes)
    jars.push(dest)
  }
  if (!jars.length) throw new Error("no jars found in bundler; unexpected server jar layout")
  return jars
}

function javaBin(name) {
  const home = process.env.JAVA_HOME
  return home ? path.join(home, "bin", name) : name
}

// Compress an id list into { suffix, exact, except? } that matchId() reproduces
// exactly against the current block set, preferring the loosest suffixes that
// stay vanilla-exact so modded ids are as likely as possible to match too (a
// new *_stairs or ruby_torch is covered without regenerating). A suffix needs
// at least two vanilla ids behind it: a pattern generalized from a single id
// would likely false-flag modded ids, so those stay exact. freeIds are ids
// an earlier rule in an ordered list already claims, so matching them here is
// harmless. Falls back to a plain exact list if a cover would ever be wrong.
function compress(targetIds, allIds, freeIds = null) {
  const target = new Set(targetIds)
  const candidates = new Set()
  for (const id of targetIds) {
    const parts = id.split("_")
    for (let i = 1; i < parts.length; i++) candidates.add("_" + parts.slice(i).join("_"))
    candidates.add(parts[parts.length - 1])
  }
  const rules = []
  for (const s of candidates) {
    const matched = allIds.filter(id => id.endsWith(s))
    const hits = matched.filter(id => target.has(id))
    if (hits.length > 1) rules.push({ s, hits, miss: matched.filter(id => !target.has(id) && !freeIds?.has(id)) })
  }
  const covered = new Set(), exceptSet = new Set(), suffix = []
  while (true) {
    let best = null
    for (const r of rules) {
      const newHits = r.hits.filter(id => !covered.has(id)).length
      if (!newHits) continue
      const newMiss = r.miss.filter(id => !exceptSet.has(id)).length
      const gain = newHits - newMiss
      if (gain < 1) continue
      if (!best || gain > best.gain || (gain === best.gain && (newMiss < best.newMiss || (newMiss === best.newMiss && r.s.length < best.s.length)))) {
        best = { s: r.s, hits: r.hits, miss: r.miss, gain, newMiss }
      }
    }
    if (!best) break
    suffix.push(best.s)
    for (const id of best.hits) covered.add(id)
    for (const id of best.miss) exceptSet.add(id)
  }
  const exact = targetIds.filter(id => !covered.has(id)).sort()
  const except = [...exceptSet].filter(id => suffix.some(s => id.endsWith(s))).sort()
  const rule = { suffix: suffix.sort(), exact, ...(except.length ? { except } : {}) }

  const exactS = new Set(rule.exact), exceptS = new Set(rule.except || [])
  const produced = allIds.filter(id => !exceptS.has(id) && (exactS.has(id) || rule.suffix.some(s => id.endsWith(s))))
  const ok = targetIds.every(id => produced.includes(id)) && produced.every(id => target.has(id) || freeIds?.has(id))
  return ok ? rule : { suffix: [], exact: [...targetIds].sort() }
}

// Light emission entries carry a value (a level, or a per-blockstate rule), so
// the ids are grouped by identical value and each group gets a suffix cover.
// Rules match in order (largest group first), so a later group's suffix may
// overlap ids an earlier rule already claims exactly, which is what lets the
// suffixes stay loose. The whole ordered list is then verified to reproduce
// the game data exactly over every vanilla block.
function compressEmission(emission, allIds) {
  const groups = new Map()
  for (const [id, value] of Object.entries(emission)) {
    const key = JSON.stringify(value)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(id)
  }
  const free = new Set()
  const out = []
  for (const [key, ids] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))) {
    out.push({ value: JSON.parse(key), ...compress(ids, allIds, free) })
    for (const id of ids) free.add(id)
  }
  const runtime = out.map(r => ({ ...r, exactS: new Set(r.exact), exceptS: new Set(r.except ?? []) }))
  for (const id of allIds) {
    let got = null
    for (const r of runtime) {
      if (r.exceptS.has(id)) continue
      if (r.exactS.has(id) || r.suffix.some(s => id.endsWith(s))) { got = JSON.stringify(r.value); break }
    }
    const want = emission[id] === undefined ? null : JSON.stringify(emission[id])
    if (got !== want) throw new Error(`emission cover resolves ${id} to ${got}, game says ${want}`)
  }
  return out
}

// Mirrors defaultBlockstates() in src/core/models.js: a block-specific rule wins
// over the global per-property default, and an array default means the first
// entry is preferred. Returns (block, property) -> the default value the
// renderer uses for that property.
function loadDefaultBlockstates() {
  const json = JSON.parse(fs.readFileSync(path.join(root, "src/core/data/default_blockstates.json"), "utf8"))
  const properties = json.properties ?? {}
  const rules = (json.blocks ?? []).filter(r => r?.match && r.defaults).map(r => ({
    patterns: r.match.split("|").map(p => new RegExp("^" + p.replace(/\*/g, ".*") + "$")),
    value: r.defaults
  }))
  const unique = block => rules.find(r => r.patterns.some(rx => rx.test(block)))?.value ?? {}
  return (block, property) => {
    const raw = unique(block)[property] ?? properties[property]
    return Array.isArray(raw) ? raw[0] : raw
  }
}

async function main() {
  const check = process.argv.includes("--check")
  const positional = process.argv.slice(2).filter(a => !a.startsWith("--"))
  const version = await resolveVersion(positional[0] || process.env.MC_VERSION)
  log("target version:", version.id)
  const verDir = path.join(cache, version.id)
  const cpDir = path.join(verDir, "cp")
  fs.mkdirSync(cpDir, { recursive: true })

  const serverJar = await download(version.server, path.join(verDir, "server.jar"))
  const clientJar = await download(version.client, path.join(verDir, "client.jar"))

  let classpath = fs.readdirSync(cpDir).filter(f => f.endsWith(".jar")).map(f => path.join(cpDir, f))
  if (!classpath.length) {
    log("extracting bundler")
    classpath = extractBundler(serverJar, cpDir)
  }
  const cp = [...classpath, clientJar].join(path.delimiter)
  log(`classpath: ${classpath.length + 1} jars`)

  const classesDir = path.join(verDir, "classes")
  fs.rmSync(classesDir, { recursive: true, force: true })
  fs.mkdirSync(classesDir, { recursive: true })
  log("compiling Extract.java")
  execFileSync(javaBin("javac"), ["-cp", cp, "-nowarn", "-d", classesDir, path.join(here, "Extract.java")], { stdio: "inherit", cwd: verDir })

  log("running extractor")
  const out = execFileSync(javaBin("java"), ["-cp", `${cp}${path.delimiter}${classesDir}`, "Extract"], { maxBuffer: 64 * 1024 * 1024, cwd: verDir }).toString()
  const raw = out.replace(/^.*?\[STDOUT\]: /gm, "").match(/<<<EXTRACT-JSON([\s\S]*?)EXTRACT-JSON>>>/)
  if (!raw) throw new Error("extractor produced no JSON; output:\n" + out.slice(-2000))
  const d = JSON.parse(raw[1])

  // An indexed ramp's `default` is the value used when the block is rendered
  // without the property set, so it must match the state the renderer picks by
  // default. Resolve it the same way models.js does, from default_blockstates
  // (e.g. age's [7,6,..] priority makes stems default to a full 7, redstone_wire
  // pins power to 0), falling back to the extractor's default-state value.
  const defaultState = loadDefaultBlockstates()
  for (const [id, entry] of Object.entries(d.indexed)) {
    const resolved = defaultState(id, entry.property)
    if (resolved !== undefined) entry.default = resolved
  }

  fs.mkdirSync(dataDir, { recursive: true })
  const stamp = `from minecraft ${version.id} by tools/generate/generate.js`
  const waterlogging = {
    _generated: stamp,
    waterloggable: compress(d.waterloggable, d.allBlocks),
    waterlogged: compress(d.waterlogged, d.allBlocks)
  }
  const culling = {
    _generated: stamp,
    nonOccluding: compress(d.nonOccluding, d.allBlocks),
    selfCullAll: compress(d.selfCullAll, d.allBlocks),
    selfCullY: compress(d.selfCullY, d.allBlocks)
  }
  const lighting = {
    _generated: stamp,
    lightEmission: compressEmission(d.lightEmission, d.allBlocks),
    shapeLightOcclusion: compressEmission(d.shapeLightOcclusion, d.allBlocks),
    lightDampening: compressEmission(d.lightDampening, d.allBlocks)
  }
  const items = {
    _generated: stamp,
    alwaysGlint: compress(d.glintItems, d.allItems)
  }
  const colors = {
    _generated: stamp,
    colormap: d.colormap,
    dye: d.dye,
    effects: d.effects,
    team: d.team,
    tintindex: d.tintindex,
    fixed: d.fixed,
    indexed: d.indexed,
    potions: d.potions
  }
  const write = (name, obj) => {
    const file = path.join(dataDir, name)
    const next = JSON.stringify(obj, null, 2) + "\n"
    const rel = path.relative(root, file)
    if (check) {
      const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
      if (cur === next) { log("ok", rel); return }
      console.error(`[generate] MISMATCH: ${rel} differs from generated output (run without --check to update)`)
      process.exitCode = 1
    } else {
      fs.writeFileSync(file, next)
      log("wrote", rel)
    }
  }
  write("waterlogging.json", waterlogging)
  write("culling.json", culling)
  write("lighting.json", lighting)
  write("colors.json", colors)
  write("items.json", items)

  log(`${check ? "checked" : "done"}: ${d.waterloggable.length} waterloggable, ${d.nonOccluding.length} non-occluding, ${d.selfCullAll.length} self-cull, ${Object.keys(d.dye).length} dye, ${Object.keys(d.effects).length} effects, ${Object.keys(d.team).length} team, ${d.glintItems.length} glint`)
}

main().catch(e => { console.error(e); process.exit(1) })
