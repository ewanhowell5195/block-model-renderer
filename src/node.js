import { fileURLToPath } from "node:url"
import zlib from "node:zlib"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { setPlatform, parsePackFilter, zipAssets, zipAssetsFromSlices, overridesRole, makeModelScene as buildModelScene } from "./core.js"
import { decodePng } from "./core/png.js"
import { settleInstances } from "./core/models.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const missingPeers = []
function peer(name, loading) {
  return loading.catch(cause => {
    if (cause?.code !== "ERR_MODULE_NOT_FOUND" || !cause.message.includes(`'${name}'`)) throw cause
    missingPeers.push(name)
    return {}
  })
}
const [{ Canvas: SkiaCanvas, Image, ImageData, loadImage }, { default: getTHREE }, { default: createContext }, { default: sharp }] = await Promise.all([peer("skia-canvas", import("skia-canvas")), peer("headless-three", import("headless-three")), peer("gl", import("gl")), peer("sharp", import("sharp"))])
if (missingPeers.length) throw new Error(`block-model-renderer is missing packages it needs to render on Node: ${missingPeers.sort().join(", ")}. Install them with: npm install gl headless-three sharp skia-canvas`)

let canvasGPU = false

class Canvas extends SkiaCanvas {
  constructor(...args) {
    super(...args)
    this.gpu = canvasGPU
  }
}

function setCanvasGPU(enabled) {
  canvasGPU = !!enabled
}

const { THREE, loadTexture: loadCanvasTexture, render } = (await getTHREE({ Canvas, Image, ImageData }))

async function getThree() {
  return THREE
}

class PixelImage extends ImageData {
  toJSON() {
    return {}
  }
}

function loadTexture(input) {
  if (!(input instanceof ImageData)) return loadCanvasTexture(input)
  const tex = new THREE.Texture(input)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

let frameCtx = null, frameRenderer = null, frameSize = null
const pinnedPrograms = new WeakSet()

function openFrameContext(width, height) {
  frameCtx = createContext(width, height)
  frameRenderer = new THREE.WebGLRenderer({ context: frameCtx })
  frameSize = { width, height }
}

const bundledIndex = new Map()

async function makeFolderEntry(folderPath, indexed = false) {
  let files = null
  if (indexed) {
    files = bundledIndex.get(folderPath)
    if (!files) {
      try { bundledIndex.set(folderPath, files = new Set((await fs.promises.readdir(folderPath, { recursive: true })).map(p => p.split(path.sep).join("/")))) } catch {}
    }
  }
  function inside(file) {
    const rel = path.relative(folderPath, path.join(folderPath, file))
    return !rel.startsWith("..") && !path.isAbsolute(rel)
  }
  const entry = {
    path: folderPath,
    async read(file) {
      if (files ? !files.has(file) : !inside(file)) return null
      try { return await fs.promises.readFile(path.join(folderPath, file)) } catch { return null }
    },
    async list(dir) {
      if (!inside(dir)) return []
      try { return await fs.promises.readdir(path.join(folderPath, dir)) } catch { return [] }
    }
  }
  try {
    entry.filter = parsePackFilter(await fs.promises.readFile(path.join(folderPath, "pack.mcmeta"), "utf8"))
  } catch {
    entry.filter = []
  }
  return entry
}

const LARGE_ZIP = 256 * 1048576

const zipHandles = new FinalizationRegistry(fd => fs.close(fd, () => {}))

async function fdZipAssets(filePath, size) {
  const fd = await new Promise((resolve, reject) => fs.open(filePath, "r", (err, opened) => err ? reject(err) : resolve(opened)))
  function slice(start, end) {
    const buf = Buffer.allocUnsafe(end - start)
    return new Promise((resolve, reject) => fs.read(fd, buf, 0, end - start, start, err => err ? reject(err) : resolve(new Uint8Array(buf.buffer, buf.byteOffset, end - start))))
  }
  const entry = await zipAssetsFromSlices(slice, size)
  zipHandles.register(entry, fd)
  return entry
}

const tempZips = []
const spilled = new WeakMap()
function spillToTemp(bytes, source) {
  const known = spilled.get(source)
  if (known) return known
  const p = path.join(os.tmpdir(), `bmr-${process.pid}-${tempZips.length}.zip`)
  spilled.set(source, p)
  fs.writeFileSync(p, bytes)
  if (!tempZips.length) {
    process.on("exit", () => {
      for (const t of tempZips) {
        try { fs.unlinkSync(t) } catch {}
      }
    })
  }
  tempZips.push(p)
  return p
}

let maxTexSize = null
setPlatform({
  THREE,
  loadTexture,
  render,
  Canvas,
  ImageData,
  loadImage(data) {
    if (data != null && typeof data === "object" && typeof data.width === "number" && typeof data.height === "number") {
      if (data instanceof Canvas || data instanceof Image) return data
      const canvas = new Canvas(data.width, data.height)
      const ctx = canvas.getContext("2d")
      if (data instanceof ImageData) ctx.putImageData(data, 0, 0)
      else ctx.drawImage(data, 0, 0)
      return canvas
    }
    return loadImage(data)
  },
  async loadPixelImage(data) {
    const png = await decodePng(data).catch(() => null)
    return png ? new PixelImage(png.data, png.width, png.height) : null
  },
  imagePixels(image) {
    return image instanceof ImageData ? image.data : null
  },
  inflateZlib(parts) {
    return zlib.inflateSync(parts.length === 1 ? parts[0] : Buffer.concat(parts))
  },
  sliceImage(image, x, y, width, height) {
    if (!(image instanceof ImageData) || x < 0 || y < 0 || x + width > image.width || y + height > image.height) return null
    const out = new Uint8ClampedArray(width * height * 4)
    for (let row = 0; row < height; row++) {
      const from = ((y + row) * image.width + x) * 4
      out.set(image.data.subarray(from, from + width * 4), row * width * 4)
    }
    return new PixelImage(out, width, height)
  },
  maxAnimationPixels: 268402689,
  batchedMesh: false,
  mipmaps: false,
  webgl2: () => false,

  maxTextureSize() {
    if (maxTexSize) return maxTexSize
    if (!frameCtx) openFrameContext(1, 1)
    return maxTexSize = frameCtx.getParameter(frameCtx.MAX_TEXTURE_SIZE)
  },

  async prepareEntry(entry) {
    if (typeof entry !== "string") {
      const bytes = entry instanceof ArrayBuffer ? new Uint8Array(entry) : entry
      if (bytes instanceof Uint8Array && bytes.length > LARGE_ZIP) return fdZipAssets(spillToTemp(bytes, entry), bytes.length)
      return zipAssets(entry)
    }
    let stat
    try {
      stat = await fs.promises.stat(entry)
    } catch {
      return makeFolderEntry(entry)
    }
    if (stat.isDirectory()) return makeFolderEntry(entry)
    if (stat.size > LARGE_ZIP) return fdZipAssets(entry, stat.size)
    return zipAssets(await fs.promises.readFile(entry))
  },

  inflateRaw(data) {
    return zlib.inflateRawSync(data)
  },

  async addBundledEntries(arr) {
    const assetsDir = path.join(__dirname, "../assets")
    const fallbacksPath = path.join(assetsDir, "fallbacks")
    function find(target) {
      const resolved = path.resolve(target)
      return arr.find(e => typeof e?.path === "string" && path.resolve(e.path) === resolved)
    }
    let names = []
    try { names = await fs.promises.readdir(assetsDir) } catch {}
    const bundled = []
    for (const name of names.sort()) {
      const role = overridesRole(name)
      if (!role) continue
      const rolePath = path.join(assetsDir, name)
      const existing = find(rolePath)
      const entry = existing ?? await makeFolderEntry(rolePath, true)
      entry.bundledOverrides = true
      entry.overrideRole = role.role
      if (role.versionBefore) entry.versionBefore = role.versionBefore
      if (!existing) bundled.push(entry)
    }
    bundled.sort((a, b) => (a.versionBefore ? 0 : 1) - (b.versionBefore ? 0 : 1))
    arr.unshift(...bundled)
    if (!find(fallbacksPath)) {
      arr.push(await makeFolderEntry(fallbacksPath, true))
    }
  },

  async getImageSize(data) {
    const { width, height } = await sharp(data).metadata()
    return { width, height }
  },

  cropToPng(data, { left, top, width, height }) {
    return sharp(data).extract({ left, top, width, height }).png().toBuffer()
  },

  async decodeToRaw(data) {
    const { data: raw, info } = await sharp(data).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    return { data: raw, width: info.width, height: info.height }
  },

  encodeRawToPng({ data, width, height }) {
    return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer()
  },

  createFrameRenderer({ width, height, background, camera }) {
    if (!frameCtx) openFrameContext(width, height)
    else if (frameSize.width !== width || frameSize.height !== height) {
      frameCtx.getExtension("STACKGL_resize_drawingbuffer").resize(width, height)
      frameSize = { width, height }
    }
    const glCtx = frameCtx
    const renderer = frameRenderer
    renderer.setSize(width, height)
    const parsed = background != null ? THREE.headless.parseColor(background) : null
    if (parsed) renderer.setClearColor(parsed.color, parsed.alpha)
    else renderer.setClearColor(0x000000, 0)

    return {
      renderFrame(scene, cam) {
        settleInstances(scene, cam)
        renderer.render(scene, cam)
      },
      readPixels() {
        const row = width * 4
        const pixels = new Uint8Array(width * height * 4)
        glCtx.readPixels(0, 0, width, height, glCtx.RGBA, glCtx.UNSIGNED_BYTE, pixels)
        const flipped = new Uint8Array(pixels.length)
        for (let y = 0; y < height; y++) {
          flipped.set(pixels.subarray(y * row, (y + 1) * row), (height - 1 - y) * row)
        }
        return flipped
      },
      programs() {
        return renderer.info.programs
      },
      release(scene) {
        const materials = new Set()
        scene.traverse(obj => {
          if (!obj.isMesh && !obj.isLineSegments) return
          obj.geometry?.dispose()
          for (const mat of [].concat(obj.material ?? [])) materials.add(mat)
        })
        for (const mat of materials) {
          const slots = Object.values(mat.uniforms ?? {}).filter(u => u?.value?.isTexture)
          for (const texture of slots.map(u => u.value).concat(mat.map ?? [], mat.emissiveMap ?? [])) {
            if (!texture.userData?.cached) texture.dispose()
          }
          let keeper = false
          for (const program of renderer.properties.get(mat).programs?.values() ?? []) {
            if (pinnedPrograms.has(program)) continue
            pinnedPrograms.add(program)
            keeper = true
          }
          if (!keeper) {
            mat.dispose()
            continue
          }
          for (const u of slots) u.value = null
          if (mat.map) mat.map = null
          if (mat.emissiveMap) mat.emissiveMap = null
        }
      }
    }
  },

  encodeStill({ data, width, height, format, output }) {
    return sharp(data, { raw: { width, height, channels: 4, premultiplied: true } }).toFormat(format ?? "png", output).toBuffer()
  },

  encodeAnimated({ data, width, height, pages, format, delay, output }) {
    let image = sharp(data, {
      raw: { width, height: height * pages, channels: 4, premultiplied: true, pages, pageHeight: height }
    })
    image = image[format === "webp" ? "webp" : "gif"]({ loop: 0, delay, ...output })
    return image.toBuffer()
  },

  writeFile(file, data) {
    return fs.promises.writeFile(file, data)
  }
})

export {
  wasmStatus, COLORS, isWaterloggable, isWaterlogged, getLightEmission, computeSceneLight, getCullFaces, DISPLAYS, LIGHT_DIMENSIONS, SKIP_BLOCKS, TECHNICAL_BLOCKS, prepareAssets, disposeCache, listDirectory, readFile,
  renderBlock, renderItem, renderModel, renderTexture, fullyOccludes, exportCache, importCache,
  renderModelScene, createSky, createClouds, createFog, rebindUniforms,
  parseBlockstate, parseItemDefinition, resolveModelData, loadModel, createScene, warmShaders, isFlatModel, getBiomeTint,
  fluidHeights, fluidTypeOf, ModelLoader,
  optimizeScene, createSharedAtlas, createTranslucentSorter, poseSpecial, resumeSpecial,
  packScene, reviveScene, collectAnimated, buildSchedules, evaluateAnimation, setAnimationRenderer,
  zipAssets, zipAssetsFromSlices, readTexture,
  renderMapColors, disposeMapArt, mapIdOf, MAP_COLORS, resolveProfile
} from "./core.js"
export { parseZip } from "./zip.js"
export { setCanvasGPU, getThree }

export async function makeModelScene() {
  return buildModelScene()
}
