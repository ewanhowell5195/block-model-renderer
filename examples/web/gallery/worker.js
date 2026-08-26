import { loadMojangJar } from "../mojang-pack.js"

const LIB = "https://cdn.jsdelivr.net/npm/block-model-renderer@2/dist/block-model-renderer.min.js"
const THREE = "https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js"

let lib = null
let assets = null
let seq = 0
let clockStart = null
const handles = new Map()
const players = new Map()

const ready = (async () => {
  const [three, mod] = await Promise.all([import(THREE), import(LIB)])
  lib = mod
  lib.configure({ THREE: three })
  if (clockStart != null) lib.configure({ clockStart })
})()

function clearRenders() {
  for (const handle of handles.values()) handle.dispose()
  handles.clear()
  for (const player of players.values()) player.dispose()
  players.clear()
}

async function blockList() {
  const lists = []
  for (const ns of await lib.listDirectory("assets", assets)) {
    const files = (await lib.listDirectory(`assets/${ns}/blockstates`, assets)).filter(f => f.endsWith(".json"))
    if (files.length) lists.push([ns, files])
  }
  const prefix = lists.length > 1
  const ids = []
  for (const [ns, files] of lists) {
    for (const f of files) ids.push(prefix ? `${ns}:${f.slice(0, -5)}` : f.slice(0, -5))
  }
  return { ids: ids.sort(), namespaces: lists.map(([ns]) => ns).sort() }
}

self.addEventListener("message", async e => {
  const msg = e.data
  if (msg.type === "seq") {
    seq = msg.seq
    clearRenders()
    return
  }
  if (msg.type === "clock") {
    clockStart = msg.clockStart
    lib?.configure({ clockStart })
    return
  }
  await ready
  if (msg.type === "assets") {
    try {
      clearRenders()
      const sources = []
      if (msg.file) sources.push(msg.file)
      const { bytes } = await loadMojangJar((got, total, ver) => {
        postMessage({ type: "progress", token: msg.token, got, total, ver })
      }, msg.channel)
      sources.push(bytes)
      const prepared = await lib.prepareAssets(sources, { cache: true })
      if (assets && assets !== prepared) lib.disposeCache(assets)
      assets = prepared
      postMessage({ type: "assets", token: msg.token, ...await blockList() })
    } catch (err) {
      postMessage({ type: "assets", token: msg.token, error: String(err) })
    }
  } else if (msg.type === "render") {
    if (msg.seq !== seq) {
      postMessage({ type: "rendered", seq: msg.seq, key: msg.key })
      return
    }
    try {
      const result = await lib.renderBlock({
        id: msg.id,
        assets,
        width: msg.size,
        height: msg.size,
        upgradable: msg.upgradable,
        display: { ...lib.DISPLAYS.block, type: "fallback", rotateFlat: true }
      })
      if (result.toAnimated) {
        if (msg.seq !== seq) {
          result.dispose()
          postMessage({ type: "rendered", seq: msg.seq, key: msg.key })
          return
        }
        handles.set(msg.key, result)
        postMessage({ type: "rendered", seq: msg.seq, key: msg.key, animates: true })
      } else {
        const bitmap = await createImageBitmap(result.canvas ?? result)
        postMessage({ type: "rendered", seq: msg.seq, key: msg.key, animates: false, bitmap }, [bitmap])
      }
    } catch (err) {
      postMessage({ type: "rendered", seq: msg.seq, key: msg.key, error: err.message })
    }
  } else if (msg.type === "animate") {
    const handle = handles.get(msg.key)
    if (!handle) return
    handles.delete(msg.key)
    const player = handle.toAnimated(msg.canvas)
    if (player) players.set(msg.key, player)
  } else if (msg.type === "drop") {
    handles.get(msg.key)?.dispose()
    handles.delete(msg.key)
  } else if (msg.type === "visible") {
    players.get(msg.key)?.[msg.visible ? "play" : "pause"]()
  } else if (msg.type === "playing") {
    if (msg.playing) lib.resumeAnimations(msg.clockStart)
    else lib.pauseAnimations()
  }
})
