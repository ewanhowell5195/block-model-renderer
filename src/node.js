import { Canvas, Image, ImageData, loadImage } from "skia-canvas"
import { fileURLToPath } from "node:url"
import getTHREE from "headless-three"
import createContext from "gl"
import sharp from "sharp"
import zlib from "node:zlib"
import path from "node:path"
import fs from "node:fs"
import { setPlatform, parsePackFilter, zipAssets } from "./core.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const { THREE, loadTexture, render } = (await getTHREE({ Canvas, Image, ImageData }))

let frameCtx = null, frameRenderer = null, frameSize = null

async function makeFolderEntry(folderPath) {
  const entry = {
    path: folderPath,
    async read(file) {
      try { return await fs.promises.readFile(path.join(folderPath, file)) } catch { return null }
    },
    async list(dir) {
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

let maxTexSize = null
setPlatform({
  THREE,
  loadTexture,
  render,
  Canvas,
  loadImage,
  maxAnimationPixels: 268402689,

  maxTextureSize() {
    if (maxTexSize) return maxTexSize
    const gl = frameCtx ?? createContext(1, 1)
    maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE)
    if (gl !== frameCtx) gl.getExtension("STACKGL_destroy_context")?.destroy()
    return maxTexSize
  },

  async prepareEntry(entry) {
    if (typeof entry !== "string") return zipAssets(entry)
    let stat
    try {
      stat = await fs.promises.stat(entry)
    } catch {
      return makeFolderEntry(entry)
    }
    if (stat.isDirectory()) return makeFolderEntry(entry)
    return zipAssets(await fs.promises.readFile(entry))
  },

  inflateRaw(data) {
    return zlib.inflateRawSync(data)
  },

  async addBundledEntries(arr) {
    const overridesPath = path.join(__dirname, "../assets/overrides")
    const fallbacksPath = path.join(__dirname, "../assets/fallbacks")
    function find(target) {
      const resolved = path.resolve(target)
      return arr.find(e => typeof e?.path === "string" && path.resolve(e.path) === resolved)
    }
    const existingOverrides = find(overridesPath)
    if (existingOverrides) {
      existingOverrides.bundledOverrides = true
    } else {
      const entry = await makeFolderEntry(overridesPath)
      entry.bundledOverrides = true
      arr.unshift(entry)
    }
    if (!find(fallbacksPath)) {
      arr.push(await makeFolderEntry(fallbacksPath))
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
    if (!frameCtx) {
      frameCtx = createContext(width, height)
      frameRenderer = new THREE.WebGLRenderer({ context: frameCtx })
      frameRenderer.outputColorSpace = THREE.LinearSRGBColorSpace
      frameSize = { width, height }
    } else if (frameSize.width !== width || frameSize.height !== height) {
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
      dispose() {}
    }
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
  COLORS, isWaterloggable, isWaterlogged, getLightEmission, computeSceneLight, getCullFaces, prepareAssets, disposeCache, listDirectory, readFile,
  renderBlock, renderItem, renderModel, renderTexture,
  makeModelScene, renderModelScene,
  parseBlockstate, parseItemDefinition, resolveModelData, loadModel, createScene, isCrossModel, getBiomeTint,
  fluidHeights, fluidTypeOf, ModelLoader,
  optimizeScene, sortTranslucent,
  zipAssets, readTexture
} from "./core.js"
export { parseZip } from "./zip.js"
