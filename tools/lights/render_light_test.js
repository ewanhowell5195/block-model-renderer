import { renderItem } from "../../index.js"
import fs from "node:fs"
import sharp from "sharp"

const assets = "pack"

fs.mkdirSync("renders", { recursive: true })


const tests = [
  ["cube_side", "light_test_cube_side", { front: [512, 512] }],
  ["cube_front", "light_test_cube_front", { front: [512, 512] }],
  ["cube_display_side", "light_test_cube_display_side", { top: [512, 256], left: [300, 600], right: [700, 600] }],
  ["cube_display_front", "light_test_cube_display_front", { top: [512, 256], left: [300, 600], right: [700, 600] }],
  ["side", "light_test_side", { middle: [500, 700], up1: [500, 580], up2: [500, 480], up3: [500, 400], down1: [500, 820], down2: [500, 920], down3: [500, 1000], left1: [400, 700], left2: [300, 700], left3: [220, 700], right1: [640, 700], right2: [740, 700], right3: [800, 700], diagUL: [340, 480], diagUR: [680, 480], diagDL: [340, 900], diagDR: [680, 900] }],
  ["front", "light_test_front", { middle: [500, 700], up1: [500, 580], up2: [500, 480], up3: [500, 400], down1: [500, 820], down2: [500, 920], down3: [500, 1000], left1: [400, 700], left2: [300, 700], left3: [220, 700], right1: [640, 700], right2: [740, 700], right3: [800, 700], diagUL: [340, 480], diagUR: [680, 480], diagDL: [340, 900], diagDR: [680, 900] }],
]

for (const [igFile, itemId, points] of tests) {
  const renderPath = "renders/" + itemId + ".png"
  await renderItem({ id: itemId, assets, path: renderPath })

  const raw = await sharp(renderPath).raw().toBuffer()
  const { width, channels } = await sharp(renderPath).metadata()
  const ig = await sharp("real/" + igFile + ".png").raw().toBuffer()
  const { width: iw, channels: ic } = await sharp("real/" + igFile + ".png").metadata()

  console.log("=== " + igFile.toUpperCase() + " ===")
  let allPerfect = true
  for (const [n, [x, y]] of Object.entries(points)) {
    const igv = ig[(y * iw + x) * ic]
    const rnv = raw[(y * width + x) * channels]
    if (rnv !== igv) {
      console.log(n.padEnd(8) + " ig=" + igv + " rn=" + rnv + " diff=" + (rnv - igv))
      allPerfect = false
    }
  }
  if (allPerfect) console.log("ALL PERFECT")
  console.log()
}
