const CORS = "https://cors.ewanhowell.com/"
const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
const KEY = "https://mc-jar.cache/"

export async function loadMojangJar(onProgress, channel = "release") {
  const manifest = await fetch(CORS + MANIFEST).then(r => r.json())
  const id = manifest.latest[channel]
  const ver = manifest.versions.find(v => v.id === id)
  const { url, size } = (await fetch(CORS + ver.url).then(r => r.json())).downloads.client

  const key = `${KEY}${channel}/${id}`, mine = `${KEY}${channel}/`
  const cache = await caches.open("mc-client-jars")
  for (const k of await cache.keys()) {
    if (!k.url.startsWith(KEY)) await cache.delete(k)
    else if (k.url.startsWith(mine) && k.url !== key) await cache.delete(k)
  }
  const hit = await cache.match(key)
  if (hit) return { id, channel, bytes: new Uint8Array(await hit.arrayBuffer()) }

  const res = await fetch(CORS + url)
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
    onProgress?.(got, total, id)
  }
  const bytes = new Uint8Array(got)
  let off = 0
  for (const c of chunks) { bytes.set(c, off); off += c.length }
  await cache.put(key, new Response(bytes))
  return { id, channel, bytes }
}
