import { loadMojangJar } from "../mojang-pack.js"

const LIB = "https://cdn.jsdelivr.net/npm/block-model-renderer/dist/block-model-renderer.min.js"
const THREE = "https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js"

let lib = null
let assets = null
let seq = 0
let clockStart = null
const players = new Map()

const ready = (async () => {
  const [three, mod] = await Promise.all([import(THREE), import(LIB)])
  lib = mod
  lib.configure({ THREE: three })
  if (clockStart != null) lib.configure({ clockStart })
})()

function clearRenders() {
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
      const handle = await lib.renderBlock({
        id: msg.id,
        assets,
        width: msg.size,
        height: msg.size,
        upgradable: true,
        display: { ...lib.DISPLAYS.block, type: "fallback", rotateFlat: true }
      })
      const animates = !!handle.toAnimated
      const bitmap = await createImageBitmap(handle.canvas)
      handle.dispose?.()
      postMessage({ type: "rendered", seq: msg.seq, key: msg.key, animates, bitmap }, [bitmap])
    } catch (err) {
      postMessage({ type: "rendered", seq: msg.seq, key: msg.key, error: err.message })
    }
  } else if (msg.type === "animate") {
    if (msg.seq !== seq) return
    try {
      const player = await lib.renderBlock({
        id: msg.id,
        assets,
        width: msg.size,
        height: msg.size,
        canvas: msg.canvas,
        animated: true,
        display: { ...lib.DISPLAYS.block, type: "fallback", rotateFlat: true }
      })
      if (msg.seq !== seq) {
        player.dispose()
        return
      }
      players.set(msg.key, player)
    } catch {}
  } else if (msg.type === "visible") {
    players.get(msg.key)?.[msg.visible ? "play" : "pause"]()
  } else if (msg.type === "playing") {
    if (msg.playing) lib.resumeAnimations(msg.clockStart)
    else lib.pauseAnimations()
  }
})
