let _dirty = false

export function subUpload(renderer, tex, source, x, yTopLeft, level = 0) {
  if (!renderer?.getContext) return false
  const gl = renderer.getContext()
  renderer.initTexture(tex)
  const glTex = renderer.properties?.get(tex)?.__webglTexture
  if (!glTex) return false
  const target = level ? tex.mipmaps?.[level] : tex.image
  if (!target) return false
  const gy = target.height - yTopLeft - source.height
  if (x < 0 || gy < 0 || x + source.width > target.width) return false
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, glTex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !!tex.flipY)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !!tex.premultiplyAlpha)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, tex.unpackAlignment ?? 4)
  gl.texSubImage2D(gl.TEXTURE_2D, level, x, gy, gl.RGBA, gl.UNSIGNED_BYTE, source)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  _dirty = true
  return true
}

export function subFlush(renderer) {
  if (!_dirty || !renderer?.resetState) return
  _dirty = false
  renderer.resetState()
}
