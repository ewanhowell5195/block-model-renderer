import { ModelLoader, renderModel, prepareAssets } from "../../index.js"
import fs from "node:fs"

// A model format built from scratch: no vanilla elements at all, geometry is
// a flat list of textured polygons. each polygon is any number of coplanar
// points in the 0-16 voxel space with per-point uv in texture pixels, and the
// list concatenates down the parent chain instead of the child replacing it
ModelLoader.register({
  name: "polygons",
  mergeKey(key, values) {
    if (key === "polygons") return values.flat()
  },
  match: model => Array.isArray(model.polygons),
  async build({ group, model, helpers }) {
    const { THREE } = helpers
    for (const polygon of model.polygons) {
      const pos = [], uv = []
      for (let i = 1; i + 1 < polygon.points.length; i++) {
        for (const p of [0, i, i + 1]) {
          const [x, y, z] = polygon.points[p]
          pos.push(x - 8, y - 8, z - 8)
          const [u, v] = polygon.uv?.[p] ?? [0, 0]
          uv.push(u / 16, 1 - v / 16)
        }
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2))
      geometry.setIndex(Array.from(Array(pos.length / 3).keys()))
      geometry.computeVertexNormals()
      const texture = helpers.resolveTexture(polygon.texture ?? "#texture") ?? "block/stone"
      group.add(new THREE.Mesh(geometry, await helpers.createMaterial(texture)))
    }
  }
})

// A loader for the (Neo)Forge OBJ model convention: the model json declares
// `"loader": "forge:obj"` and points `"model"` at an .obj file inside the
// pack. Coordinates are in block units (0-1), mtl materials map textures via
// map_Kd, which can reference the json's texture slots ("#sphere"), and
// flip_v mirrors the texture coordinates vertically like Forge's option
ModelLoader.register({
  name: "forge:obj",
  mergeKey(key, values) {
    // claiming the key also keeps it on the resolved model: `model` is
    // normally pipeline plumbing that gets stripped
    if (key === "model") return values.find(v => typeof v === "string" && v.endsWith(".obj"))
  },
  match: model => (model.loader === "forge:obj" || model.loader === "neoforge:obj") && typeof model.model === "string" && model.model.endsWith(".obj"),
  async build({ group, model, helpers }) {
    const { THREE } = helpers
    function objPath(ref) {
      const [ns, path] = ref.includes(":") ? ref.split(":") : ["minecraft", ref]
      return `assets/${ns}/models/${path}`
    }
    const text = async path => new TextDecoder().decode(await helpers.readFile(path))

    const positions = [], uvs = []
    const groups = new Map()
    let current = null
    const materials = new Map()
    const base = objPath(model.model)
    for (const line of (await text(base)).split("\n")) {
      const parts = line.trim().split(/\s+/)
      if (parts[0] === "v") positions.push(parts.slice(1, 4).map(Number))
      else if (parts[0] === "vt") uvs.push(parts.slice(1, 3).map(Number))
      else if (parts[0] === "usemtl") current = parts[1]
      else if (parts[0] === "mtllib") {
        const mtl = await text(base.slice(0, base.lastIndexOf("/") + 1) + parts[1])
        let name = null
        for (const l of mtl.split("\n")) {
          const p = l.trim().split(/\s+/)
          if (p[0] === "newmtl") name = p[1]
          else if (p[0] === "map_Kd" && name) materials.set(name, p[1])
        }
      } else if (parts[0] === "f") {
        let tris = groups.get(current)
        if (!tris) groups.set(current, tris = [])
        const verts = parts.slice(1).map(v => v.split("/").map(n => parseInt(n) - 1))
        for (let i = 1; i + 1 < verts.length; i++) tris.push(verts[0], verts[i], verts[i + 1])
      }
    }

    for (const [mtlName, tris] of groups) {
      const pos = [], uv = []
      for (const [vi, ti] of tris) {
        const [x, y, z] = positions[vi]
        pos.push(x * 16 - 8, y * 16 - 8, z * 16 - 8)
        const [u, v] = ti != null ? uvs[ti] : [0, 0]
        uv.push(u, model.flip_v ? 1 - v : v)
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2))
      geometry.setIndex(Array.from(Array(pos.length / 3).keys()))
      geometry.computeVertexNormals()
      const texture = helpers.resolveTexture(materials.get(mtlName) ?? "#texture") ?? "block/stone"
      group.add(new THREE.Mesh(geometry, await helpers.createMaterial(texture)))
    }
  }
})

// the parent model contributes the big center crystal: four triangles from a
// base square up to the apex. the child adds two smaller crystals of its own,
// and the polygons lists concatenate through the merge
const parent = {
  textures: {
    texture: "block/amethyst_block"
  },
  polygons: [
    { points: [[10, 0, 6],  [6, 0, 6],   [8, 14, 8]], uv: [[14, 14], [2, 14], [8, 2]] },
    { points: [[10, 0, 10], [10, 0, 6],  [8, 14, 8]], uv: [[14, 14], [2, 14], [8, 2]] },
    { points: [[6, 0, 10],  [10, 0, 10], [8, 14, 8]], uv: [[14, 14], [2, 14], [8, 2]] },
    { points: [[6, 0, 6],   [6, 0, 10],  [8, 14, 8]], uv: [[14, 14], [2, 14], [8, 2]] }
  ]
}

const virtualPack = {
  read(path) {
    if (path === "assets/minecraft/models/example/crystal_base.json") return Buffer.from(JSON.stringify(parent))
    if (path === "assets/minecraft/models/example/sphere.obj") return fs.promises.readFile(`${import.meta.dirname}/obj/sphere.obj`)
    if (path === "assets/minecraft/models/example/sphere.mtl") return fs.promises.readFile(`${import.meta.dirname}/obj/sphere.mtl`)
    return null
  }
}

const assets = await prepareAssets([
  virtualPack,
  "C:/Users/ewanh/AppData/Roaming/.minecraft/resourcepacks/26.3-snapshot-3"
])

const outputDir = `${import.meta.dirname}/renders/loader`
fs.mkdirSync(outputDir, { recursive: true })

await renderModel({
  assets,
  model: {
    parent: "example/crystal_base",
    polygons: [
      { points: [[5, 0, 2],   [2, 0, 2],   [3.5, 8, 3.5]],   uv: [[14, 14], [2, 14], [8, 2]] },
      { points: [[5, 0, 5],   [5, 0, 2],   [3.5, 8, 3.5]],   uv: [[14, 14], [2, 14], [8, 2]] },
      { points: [[2, 0, 5],   [5, 0, 5],   [3.5, 8, 3.5]],   uv: [[14, 14], [2, 14], [8, 2]] },
      { points: [[2, 0, 2],   [2, 0, 5],   [3.5, 8, 3.5]],   uv: [[14, 14], [2, 14], [8, 2]] },
      { points: [[15, 0, 11], [11, 0, 11], [13, 10, 13]],    uv: [[14, 14], [2, 14], [8, 2]] },
      { points: [[15, 0, 15], [15, 0, 11], [13, 10, 13]],    uv: [[14, 14], [2, 14], [8, 2]] },
      { points: [[11, 0, 15], [15, 0, 15], [13, 10, 13]],    uv: [[14, 14], [2, 14], [8, 2]] },
      { points: [[11, 0, 11], [11, 0, 15], [13, 10, 13]],    uv: [[14, 14], [2, 14], [8, 2]] }
    ]
  },
  lighting: "world",
  path: `${outputDir}/crystals.png`
})
console.log("Done crystals")

await renderModel({
  assets,
  model: {
    loader: "forge:obj",
    model: "example/sphere.obj",
    flip_v: true,
    textures: {
      sphere: "block/red_concrete"
    }
  },
  lighting: "world",
  path: `${outputDir}/sphere.png`
})
console.log("Done sphere")
