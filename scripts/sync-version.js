import { readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

const write = (file, pattern, replacement) => {
  const url = new URL(file, import.meta.url)
  const before = readFileSync(url, "utf8")
  const after = before.replace(pattern, replacement)
  if (after === before) throw new Error(`could not set the version in ${file}`)
  writeFileSync(url, after)
}

write("../rust/Cargo.toml", /^version = ".*"$/m, `version = "${version}"`)
write("../rust/Cargo.lock", /(name = "block-model-renderer"\r?\nversion = ").*(")/, `$1${version}$2`)

execFileSync("git", ["add", "rust/Cargo.toml", "rust/Cargo.lock"], { stdio: "inherit" })
console.log(`crate synced to ${version}`)
