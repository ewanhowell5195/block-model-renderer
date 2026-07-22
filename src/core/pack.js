import { THREE, Canvas } from "./platform.js"

export async function packScene(handle, opts = {}) {
  const shared = opts.sharedAtlas ?? null
  const transfers = []
  const textures = []
  const texIndex = new Map()
  const materials = []
  const matIndex = new Map()
  const meshes = []

  const pageRefs = new Map()
  if (shared) {
    for (const [sig, sheet] of shared.sheets) {
      sheet.pages.forEach((page, pi) => pageRefs.set(page.texture, { sig, page: pi }))
    }
  }

  async function packTexture(tex) {
    let i = texIndex.get(tex)
    if (i !== undefined) return i
    const pageRef = pageRefs.get(tex)
    let spec
    if (pageRef) spec = { kind: "page", sig: pageRef.sig, page: pageRef.page }
    else if (tex.isDataTexture) {
      const img = tex.image
      const data = img.data.slice()
      transfers.push(data.buffer)
      spec = { kind: "data", data, w: img.width, h: img.height, linear: tex.magFilter === THREE.LinearFilter }
    } else {
      const img = tex.image
      const bitmap = await createImageBitmap(img)
      transfers.push(bitmap)
      spec = {
        kind: "bitmap", bitmap,
        nearest: tex.magFilter === THREE.NearestFilter,
        repeat: tex.wrapS === THREE.RepeatWrapping,
        colorSpace: tex.colorSpace,
        flipY: tex.flipY
      }
    }
    i = textures.length
    textures.push(spec)
    texIndex.set(tex, i)
    return i
  }

  async function packUniforms(uniforms) {
    const out = {}
    for (const [k, u] of Object.entries(uniforms)) {
      const v = u.value
      if (v == null || typeof v === "number" || typeof v === "boolean") out[k] = { t: "raw", v }
      else if (v.isVector2) out[k] = { t: "v2", v: [v.x, v.y] }
      else if (v.isVector3) out[k] = { t: "v3", v: [v.x, v.y, v.z] }
      else if (v.isVector4) out[k] = { t: "v4", v: [v.x, v.y, v.z, v.w] }
      else if (v.isColor) out[k] = { t: "col", v: [v.r, v.g, v.b] }
      else if (v.isTexture) out[k] = { t: "tex", v: await packTexture(v) }
      else out[k] = { t: "json", v: JSON.parse(JSON.stringify(v)) }
    }
    return out
  }

  async function packMaterial(mat) {
    let i = matIndex.get(mat)
    if (i !== undefined) return i
    const common = {
      side: mat.side, transparent: !!mat.transparent,
      depthWrite: mat.depthWrite !== false, depthTest: mat.depthTest !== false,
      blending: mat.blending, blendSrc: mat.blendSrc, blendDst: mat.blendDst, blendEquation: mat.blendEquation,
      polygonOffset: !!mat.polygonOffset, polygonOffsetFactor: mat.polygonOffsetFactor ?? 0, polygonOffsetUnits: mat.polygonOffsetUnits ?? 0,
      alphaTest: mat.alphaTest ?? 0, opacity: mat.opacity ?? 1
    }
    let spec
    if (mat.isShaderMaterial) {
      spec = {
        kind: "shader", ...common,
        vertexShader: mat.vertexShader, fragmentShader: mat.fragmentShader,
        defines: { ...(mat.defines ?? {}) }, clipping: !!mat.clipping,
        uniforms: await packUniforms(mat.uniforms)
      }
    } else {
      spec = {
        kind: "basic", ...common,
        map: mat.map ? await packTexture(mat.map) : null,
        color: mat.color ? [mat.color.r, mat.color.g, mat.color.b] : null
      }
    }
    i = materials.length
    materials.push(spec)
    matIndex.set(mat, i)
    return i
  }

  handle.group.updateMatrixWorld(true)
  const list = []
  handle.group.traverse(o => { if (o.isMesh) list.push(o) })
  for (const o of list) {
    const geo = o.geometry
    const attrs = {}
    for (const [name, attr] of Object.entries(geo.attributes)) {
      if (name === "instanceMatrix") continue
      const array = attr.array.slice()
      transfers.push(array.buffer)
      attrs[name] = { array, itemSize: attr.itemSize, normalized: !!attr.normalized }
    }
    let index = null
    if (geo.index) {
      const array = geo.index.array.slice()
      transfers.push(array.buffer)
      index = { array }
    }
    const material = Array.isArray(o.material) ? [] : await packMaterial(o.material)
    if (Array.isArray(o.material)) for (const m of o.material) material.push(await packMaterial(m))
    const spec = {
      attrs, index, material,
      groups: geo.groups?.length ? geo.groups.map(g => ({ start: g.start, count: g.count, materialIndex: g.materialIndex })) : null,
      matrix: Array.from(o.matrixWorld.elements),
      renderOrder: o.renderOrder ?? 0,
      frustumCulled: o.frustumCulled !== false
    }
    if (o.isInstancedMesh) {
      spec.instanced = o.count
      const im = o.instanceMatrix.array.slice()
      transfers.push(im.buffer)
      spec.instanceMatrix = im
      if (o.userData?.billboard && o.userData.billboardEntries) {
        spec.billboard = o.userData.billboardEntries.map(e => ({ p: [e.pos.x, e.pos.y, e.pos.z], s: [e.scale.x, e.scale.y, e.scale.z] }))
      }
    }
    meshes.push(spec)
  }
  return { payload: { meshes, materials, textures }, transfers }
}

export async function packAtlasDelta(shared, since = 0) {
  const deltas = []
  const transfers = []
  let serial = since
  for (const [sig, sheet] of shared.sheets) {
    for (const r of sheet.rects.values()) {
      if (!(r.serial > since)) continue
      serial = Math.max(serial, r.serial)
      const page = sheet.pages[r.ai]
      const bitmap = await createImageBitmap(page.canvas, r.x - 1, r.y - 1, r.w + 2, r.h + 2)
      transfers.push(bitmap)
      deltas.push({ sig, page: r.ai, x: r.x - 1, y: r.y - 1, bitmap, colorSpace: page.texture.colorSpace })
    }
  }
  return { deltas, serial, size: shared.size, transfers }
}

export function createAtlasMirror(opts = {}) {
  const renderer = opts.renderer ?? null
  const sheets = new Map()
  return {
    apply(pack) {
      for (const d of pack.deltas) {
        let sheet = sheets.get(d.sig)
        if (!sheet) sheets.set(d.sig, sheet = [])
        let page = sheet[d.page]
        if (!page) {
          const canvas = new Canvas(pack.size, pack.size)
          const texture = new THREE.CanvasTexture(canvas)
          texture.magFilter = texture.minFilter = THREE.NearestFilter
          texture.generateMipmaps = false
          texture.colorSpace = d.colorSpace ?? THREE.NoColorSpace
          sheet[d.page] = page = { canvas, ctx: canvas.getContext("2d"), texture }
        }
        page.ctx.drawImage(d.bitmap, d.x, d.y)
        let subbed = false
        if (renderer) {
          try {
            const sub = new Canvas(d.bitmap.width, d.bitmap.height)
            sub.getContext("2d").drawImage(d.bitmap, 0, 0)
            const st = new THREE.CanvasTexture(sub)
            renderer.copyTextureToTexture(new THREE.Vector2(d.x, pack.size - d.y - d.bitmap.height), st, page.texture)
            st.dispose()
            subbed = true
          } catch {}
        }
        if (!subbed) page.texture.needsUpdate = true
        d.bitmap.close?.()
      }
    },
    texture(sig, page) {
      return sheets.get(sig)?.[page]?.texture ?? null
    },
    dispose() {
      for (const sheet of sheets.values()) for (const page of sheet) { try { page?.texture.dispose() } catch {} }
      sheets.clear()
    }
  }
}

export function reviveScene(payload, opts = {}) {
  const mirror = opts.atlas ?? null
  const owned = { textures: [], materials: [], geometries: [] }

  const textures = payload.textures.map(spec => {
    if (spec.kind === "page") return mirror?.texture(spec.sig, spec.page)
    if (spec.kind === "data") {
      const tex = new THREE.DataTexture(spec.data, spec.w, spec.h)
      tex.minFilter = tex.magFilter = spec.linear ? THREE.LinearFilter : THREE.NearestFilter
      tex.generateMipmaps = false
      tex.needsUpdate = true
      owned.textures.push(tex)
      return tex
    }
    const canvas = new Canvas(spec.bitmap.width, spec.bitmap.height)
    canvas.getContext("2d").drawImage(spec.bitmap, 0, 0)
    spec.bitmap.close?.()
    const tex = new THREE.Texture(canvas)
    tex.magFilter = tex.minFilter = spec.nearest ? THREE.NearestFilter : THREE.LinearFilter
    if (spec.repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.colorSpace = spec.colorSpace ?? THREE.SRGBColorSpace
    tex.flipY = spec.flipY
    tex.generateMipmaps = false
    tex.needsUpdate = true
    owned.textures.push(tex)
    return tex
  })

  const reviveUniform = u => {
    if (u.t === "raw" || u.t === "json") return { value: u.v }
    if (u.t === "v2") return { value: new THREE.Vector2(...u.v) }
    if (u.t === "v3") return { value: new THREE.Vector3(...u.v) }
    if (u.t === "v4") return { value: new THREE.Vector4(...u.v) }
    if (u.t === "col") return { value: new THREE.Color(...u.v) }
    if (u.t === "tex") return { value: textures[u.v] }
    return { value: null }
  }

  const materials = payload.materials.map(spec => {
    let mat
    if (spec.kind === "shader") {
      const uniforms = {}
      for (const [k, u] of Object.entries(spec.uniforms)) uniforms[k] = reviveUniform(u)
      mat = new THREE.ShaderMaterial({
        vertexShader: spec.vertexShader, fragmentShader: spec.fragmentShader,
        defines: { ...spec.defines }, uniforms, clipping: spec.clipping
      })
    } else {
      mat = new THREE.MeshBasicMaterial({ map: spec.map != null ? textures[spec.map] : null })
      if (spec.color) mat.color.setRGB(...spec.color)
    }
    mat.side = spec.side
    mat.transparent = spec.transparent
    mat.depthWrite = spec.depthWrite
    mat.depthTest = spec.depthTest
    mat.blending = spec.blending
    if (spec.blendSrc !== undefined) { mat.blendSrc = spec.blendSrc; mat.blendDst = spec.blendDst; mat.blendEquation = spec.blendEquation }
    mat.polygonOffset = spec.polygonOffset
    mat.polygonOffsetFactor = spec.polygonOffsetFactor
    mat.polygonOffsetUnits = spec.polygonOffsetUnits
    mat.alphaTest = spec.alphaTest
    mat.opacity = spec.opacity
    owned.materials.push(mat)
    return mat
  })

  const group = new THREE.Group()
  for (const spec of payload.meshes) {
    const geo = new THREE.BufferGeometry()
    for (const [name, a] of Object.entries(spec.attrs)) {
      geo.setAttribute(name, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized))
    }
    if (spec.index) geo.setIndex(new THREE.BufferAttribute(spec.index.array, 1))
    if (spec.groups) for (const g of spec.groups) geo.addGroup(g.start, g.count, g.materialIndex)
    owned.geometries.push(geo)
    const material = Array.isArray(spec.material) ? spec.material.map(i => materials[i]) : materials[spec.material]
    let mesh
    if (spec.instanced != null) {
      mesh = new THREE.InstancedMesh(geo, material, spec.instanced)
      mesh.instanceMatrix.array.set(spec.instanceMatrix)
      mesh.instanceMatrix.needsUpdate = true
      if (spec.billboard) {
        const entries = spec.billboard.map(b => ({ pos: new THREE.Vector3(...b.p), scale: new THREE.Vector3(...b.s) }))
        const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _flip = new THREE.Quaternion(0, 1, 0, 0), _m = new THREE.Matrix4(), _inv = new THREE.Matrix4()
        mesh.frustumCulled = false
        mesh.onBeforeRender = function (renderer, scene, camera) {
          _inv.copy(this.matrixWorld).invert()
          camera.getWorldQuaternion(_q).multiply(_flip)
          for (let i = 0; i < entries.length; i++) {
            const e = entries[i]
            _p.copy(e.pos).applyMatrix4(this.matrixWorld)
            this.setMatrixAt(i, _m.compose(_p, _q, e.scale).premultiply(_inv))
          }
          this.instanceMatrix.needsUpdate = true
        }
      }
    } else {
      mesh = new THREE.Mesh(geo, material)
    }
    mesh.matrixAutoUpdate = false
    mesh.matrix.fromArray(spec.matrix)
    mesh.renderOrder = spec.renderOrder
    mesh.frustumCulled = spec.frustumCulled
    group.add(mesh)
  }

  return {
    group,
    dispose() {
      group.removeFromParent()
      for (const g of owned.geometries) { try { g.dispose() } catch {} }
      for (const m of owned.materials) { try { m.dispose() } catch {} }
      for (const t of owned.textures) { try { t.dispose() } catch {} }
    }
  }
}
