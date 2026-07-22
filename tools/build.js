import esbuild from "esbuild"
import fs from "node:fs"

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version

const banner = `/*!
 * block-model-renderer
 * Version  : ${version}
 * License  : MIT
 * Copyright: ${new Date().getFullYear()} Ewan Howell
 */`

// esbuild leaves template literal contents alone, so the GLSL ships fully
// indented; strip it down line by line. Line structure is preserved (preprocessor
// directives need it) and //salt: comments survive (the recompile salt is read
// off the end of the fragment shader at runtime)
function minifyGLSL(body) {
  const interps = []
  body = body.replace(/\$\{[^{}]*\}/g, s => `\x00${interps.push(s) - 1}\x00`)
  const lines = []
  for (let line of body.split("\n")) {
    if (!line.includes("${")) {
      const c = line.indexOf("//")
      if (c !== -1 && !line.includes("salt:")) line = line.slice(0, c)
    }
    line = line.trim().replace(/\s+/g, " ")
    if (line) lines.push(line)
  }
  return lines.join("\n").replace(/\x00(\d+)\x00/g, (_, i) => interps[+i])
}

function minifyShaderTemplates(source) {
  const marker = /(vertexShader|fragmentShader):\s*`/g
  let out = ""
  let last = 0
  let count = 0
  let m
  while ((m = marker.exec(source))) {
    const start = m.index + m[0].length
    let j = start
    let depth = 0
    while (j < source.length) {
      const c = source[j]
      if (c === "\\") { j += 2; continue }
      if (depth === 0 && c === "`") break
      if (c === "$" && source[j + 1] === "{") { depth++; j += 2; continue }
      if (depth > 0 && c === "{") depth++
      else if (depth > 0 && c === "}") depth--
      j++
    }
    if (j >= source.length) throw new Error("unterminated shader template literal")
    out += source.slice(last, start) + minifyGLSL(source.slice(start, j))
    last = j
    marker.lastIndex = j
    count++
  }
  out += source.slice(last)
  const salts = s => (s.match(/\/\/salt:/g) ?? []).length
  if (salts(out) !== salts(source)) throw new Error("shader minify dropped a salt comment")
  return { out, count }
}

const shaderMinify = {
  name: "shader-minify",
  setup(build) {
    build.onLoad({ filter: /core[\\/]models\.js$/ }, async args => {
      const source = await fs.promises.readFile(args.path, "utf8")
      const { out, count } = minifyShaderTemplates(source)
      console.log(`Minified ${count} shader templates`)
      return { contents: out, loader: "js" }
    })
  }
}

await esbuild.build({
  entryPoints: ["src/web.js"],
  bundle: true,
  minify: true,
  format: "esm",
  external: ["three"],
  banner: { js: banner },
  plugins: [shaderMinify],
  outfile: "dist/block-model-renderer.min.js"
})

console.log("Built block-model-renderer v" + version)
