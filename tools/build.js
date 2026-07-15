import esbuild from "esbuild"
import fs from "node:fs"

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version

const banner = `/*!
 * block-model-renderer
 * Version  : ${version}
 * License  : MIT
 * Copyright: ${new Date().getFullYear()} Ewan Howell
 */`

await esbuild.build({
  entryPoints: ["src/web.js"],
  bundle: true,
  minify: true,
  format: "esm",
  external: ["three"],
  banner: { js: banner },
  outfile: "dist/block-model-renderer.min.js"
})

console.log("Built block-model-renderer v" + version)
