import { createScene, makeModelScene, renderModelScene, prepareAssets } from "../../index.js"
import { loadMojangJar } from "./mojang-jar.js"
import sharp from "sharp"
import fs from "node:fs"

const assets = await prepareAssets([
  await loadMojangJar()
])

fs.mkdirSync(`${import.meta.dirname}/renders/scene`, { recursive: true })

// The campsite scene from the web homepage, as a legend + ascii layers
const SCENE = {
  legend: {
    "a": "stone",
    "b": "sand",
    "c": "gravel",
    "d": "dirt",
    "e": "grass_block",
    "f": "spruce_planks",
    "g": { id: "water", properties: { level: "0" } },
    "h": "dirt_path",
    "i": "seagrass",
    "j": { id: "oak_log", properties: { axis: "y" } },
    "k": { id: "oak_log", properties: { axis: "x" } },
    "l": { id: "oak_log", properties: { axis: "z" } },
    "m": { id: "farmland", properties: { moisture: "7" } },
    "n": { id: "oak_fence", properties: { waterlogged: "true" } },
    "o": { id: "red_bed", properties: { facing: "west", part: "head" } },
    "p": { id: "red_bed", properties: { facing: "west", part: "foot" } },
    "q": { id: "chest", properties: { facing: "south" } },
    "r": "cobblestone",
    "s": "short_grass",
    "t": { id: "sugar_cane", properties: { age: "0" } },
    "u": "mossy_cobblestone",
    "v": { id: "water", properties: { level: "8" } },
    "w": "bush",
    "x": { id: "spruce_door", properties: { facing: "east", half: "lower", hinge: "left", open: "false" } },
    "y": "crafting_table",
    "z": { id: "barrel", properties: { facing: "up" } },
    "A": "poppy",
    "B": { id: "oak_stairs", properties: { facing: "south" } },
    "C": "oak_planks",
    "D": { id: "wildflowers", properties: { flower_amount: "4", facing: "north" } },
    "E": { id: "birch_log", properties: { axis: "y" } },
    "F": { id: "wildflowers", properties: { flower_amount: "1", facing: "west" } },
    "G": { id: "wildflowers", properties: { flower_amount: "2", facing: "east" } },
    "H": { id: "wildflowers", properties: { flower_amount: "4", facing: "south" } },
    "I": { id: "cobblestone_stairs", properties: { facing: "north" } },
    "J": "oxeye_daisy",
    "K": { id: "leaf_litter", properties: { segment_amount: "4", facing: "west" } },
    "L": { id: "wildflowers", properties: { flower_amount: "3", facing: "south" } },
    "M": "firefly_bush",
    "N": "lily_pad",
    "O": { id: "oak_stairs", properties: { facing: "north" } },
    "P": "oak_fence",
    "Q": { id: "leaf_litter", properties: { segment_amount: "1", facing: "south" } },
    "R": { id: "leaf_litter", properties: { segment_amount: "3", facing: "east" } },
    "S": { id: "leaf_litter", properties: { segment_amount: "2", facing: "north" } },
    "T": { id: "wheat", properties: { age: "7" } },
    "U": { id: "wheat", properties: { age: "5" } },
    "V": { id: "carrots", properties: { age: "8" } },
    "W": { id: "potatoes", properties: { age: "7" } },
    "X": { id: "wheat", properties: { age: "6" } },
    "Y": { id: "potatoes", properties: { age: "4" } },
    "Z": "cornflower",
    "0": { id: "wheat", properties: { age: "4" } },
    "1": { id: "carrots", properties: { age: "4" } },
    "2": { id: "potatoes", properties: { age: "2" } },
    "3": "azure_bluet",
    "4": { id: "hay_block", properties: { axis: "y" } },
    "5": { id: "composter", properties: { level: "3" } },
    "6": { id: "sweet_berry_bush", properties: { age: "3" } },
    "7": { id: "tall_grass", properties: { half: "lower" } },
    "8": { id: "campfire", properties: { lit: "true", facing: "west" } },
    "9": { id: "leaf_litter", properties: { segment_amount: "3", facing: "north" } },
    "!": { id: "oak_slab", properties: { type: "bottom" } },
    "@": { id: "spruce_stairs", properties: { facing: "north" } },
    "#": "dandelion",
    "$": "andesite",
    "%": { id: "glass_pane", properties: { east: "true", west: "true" } },
    "^": { id: "glass_pane", properties: { north: "true", south: "true" } },
    "&": { id: "wall_torch", properties: { facing: "east" } },
    "*": { id: "lantern", properties: { hanging: "true" } },
    "(": { id: "spruce_door", properties: { facing: "east", half: "upper", hinge: "left", open: "false" } },
    ")": { id: "lantern", properties: { hanging: "false" } },
    "-": { id: "tall_grass", properties: { half: "upper" } },
    "_": { id: "spruce_stairs", properties: { facing: "east" } },
    "=": { id: "spruce_stairs", properties: { facing: "west" } },
    "+": { id: "birch_leaves", properties: { persistent: "true" } },
    "[": { id: "oak_leaves", properties: { persistent: "true" } },
    "]": { id: "water", properties: { level: "2" } },
    "{": { id: "water", properties: { level: "1" } },
    "~": { id: "water", properties: { level: "3" } },
    "}": { id: "spruce_leaves", properties: { persistent: "true" } },
    ";": { id: "spruce_log", properties: { axis: "y" } },
    ":": { id: "spruce_slab", properties: { type: "top" } }
  },
  layers: [
    ["aaaaaaaaaaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaaaaaaaaaa", "aaaaaaaaaaaabbbaaaaaaaaa", "aaaaaaaaaaaaccbaaaaaaaaa", "aaaaaaaaaaaabbbaaaaaaaaa", "aaaaaaaaaaaabbbaaaaaaaaa", "aaaaaaaaaaaacbcaaaaaaaaa", "aaaaaaaaaaaabbcaaaaaaaaa", "aaaaaaaaaaabbbaaaaaaaaaa", "aaaaaaaaaabbcaaaaaaaaaaa", "aaaaaaaaacbcaaaaaaaaaaaa", "aaaaaaaacbbaaaaaaaaaaaaa", "aaaaaaabccaaaaaaaaaaaaaa", "aaabcbccbbaaaaaaaaaaaaaa", "aabcbbbbcbaaaaaaaaaddaaa", "aacbccbbbbaaaaaaaaaddaaa", "aabcbcbcbbaaaaaaaaaaaaaa", "aabbccbcccaaaaaaaaaaaaaa", "aaabbcbbbcaaaaaaaaaaaaaa", "aaabbbcbbbaaaaaaaaaaaaaa", "aaaaccbbbaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaaaaaaaaaa"],
    ["eeeeeeeeeeeeeeeddddddddd", "eedddddddeeebeeddddddddd", "eedfffffdeeegggddddddddd", "eedfffffdeebgggbdddddddd", "eedfffffehhbgggbdddddddd", "eedfffffdehbgggbdddddddd", "eedfffffdehbgggedddddddd", "eedddddddehbgggbdddddddd", "eeeeeeeeeebgggeddddddddd", "eeeeeeeeebgggbeeeeedeeee", "eedeeeeebgggbeeeeeeeeeee", "eeeeeeebgggbeeeeeeeeeeee", "eeeeebbggieeeeedejkkkkje", "eebggigggghheeeeelmmmmle", "eeggggggggbhhhhhhhmggmle", "eegggnggggbehedeelmggmle", "eeggngggigbeheeeelmmmmle", "ebggggggggbehheeejkkkkje", "eeeginggggeedhdeeeeeeeee", "eebggggiggeedhdeeeeeeeee", "eeebgngggbeeeeeeeeedeeee", "eeeebbbbbeeeeeeeeddeeeee", "eeeeeeeeeeeeeeeeedeeeeee", "eeeeeeeeeeeeeeeeeeeeeeee"],
    ["...............ddddddddd", "..jfffffj......ddddddddd", "..fop.qrf.st...udddddddd", "..f.....f.....vudddddddd", ".wf.....x.....vudddddddd", "..f.....f......udddddddd", "..fyz...f......tdddddddd", "..jfffffj......ddddddddd", ".A........B....ddddrdrdd", "..........C...D.w..r....", "..E.......C..F.G.H.I..J.", "..........C...sKL....s..", "..M....N..OP.A.jQ.......", ".s............R.S.TUVV..", "....N.............T..W..", "....CC........u...X..Y..", ".Z.NCC........Z.s.0T12..", ".....C.N.......3.4....5.", ".....C....M.l.l.6.......", ".s...C....7.l8l.....9.w.", ".....C........7.A..j....", "..ss.!t...s.@@ss.ur.#...", ".....Js.s........r.Asw..", "........................"],
    ["...............$dddddddd", "..jff%ffj......ddddddddd", "..f....r^..t...adddddddd", "..f.....f&....vadddddddd", "..f..*..(.....vadddddddd", "..f.....f&.....adddddddd", "..f.....^......tdddddddd", "..jf%%ffj......eaddddddd", "...............eed$r$$aa", "...................I....", "..E.....................", "........................", "...........)...j........", "........................", "........................", "....P...................", "........................", "........................", "........................", "..........-.............", "..............-....j....", "......t..........u......", "........................", "........................"],
    ["._fffffff=.....ddddddddd", "._fffffff=.....rdddddddd", "._fffffrf=.....adaaaaddd", "._fffffff=....vaaaaaaddd", "._fffffff=....vaaaaaaddd", "._fffffff=.....adaaaaddd", "._fffffff=.....tdddddddd", "._fffffff=......$ddddddd", "._fffffff=.......ddIr$a$", ".+++....................", ".+E+..........[[[.......", ".+++.........[[[[[......", ".............[[j[[......", ".............[[[[[......", "..............[[[.......", "....)...................", "........................", "........................", "..................[[[[..", ".................[[[[[..", ".................[[j[[..", ".................[[[[[..", "..................[[[...", "........................"],
    [".._fffff=......eeeeeeeee", ".._.....=......eeeeeeedd", ".._....r=......eeggggeee", ".._.....=.....~]{ggggeee", ".._.....=.....~]{ggggeee", ".._.....=......eeggggeee", ".._.....=......eeeeeeeee", ".._.....=.......eeeIedee", ".._fffff=........ee.eeee", ".+++....................", ".+E+.........[[[[.......", ".+++.........[[[[[......", ".............[[j[[......", ".............[[[[[......", ".............[[[[.......", "........................", "........................", "........................", ".................[[[[[..", ".................[[[[[..", ".................[[j[[..", ".................[[[[[..", ".................[[[[[..", "........................"],
    ["..._fff=................", "..._...=........s.....ur", "..._...r..............s.", "..._...=.............s..", "..._...=................", "..._...=............}}}.", "..._...=..........s}}}}}", "..._...=...........}};}}", "..._fff=...........}}}}}", "..+.................}}}.", ".+++....................", "..+...........[[[.......", "..............[j[.......", "..............[[[.......", "........................", "........................", "........................", "........................", "........................", "..................[[[...", "..................[j[...", "..................[[[...", "........................", "........................"],
    ["...._:=.................", "...._:=.................", "...._:=r................", "...._:=.................", "...._:=.................", "...._:=.................", "...._:=.............}}}.", "...._:=.............};}.", "...._:=.............}}}.", "........................", "..+.....................", "...............[........", "..............[[[.......", "...............[........", "........................", "........................", "........................", "........................", "........................", "...................[....", "..................[[[...", "...................[....", "........................", "........................"],
    ["........................", "........................", ".......r................", "........................", "........................", "....................}}}.", "...................}}}}}", "...................}};}}", "...................}}}}}", "....................}}}.", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................"],
    ["........................", "........................", "........................", "........................", "........................", "........................", "....................}}}.", "....................};}.", "....................}}}.", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................"],
    ["........................", "........................", "........................", "........................", "........................", "........................", "........................", ".....................;..", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................"],
    ["........................", "........................", "........................", "........................", "........................", "........................", "....................}}}.", "....................};}.", "....................}}}.", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................"],
    ["........................", "........................", "........................", "........................", "........................", "........................", "........................", ".....................}..", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................", "........................"]
  ]
}

const blocks = []
SCENE.layers.forEach((layer, y) => {
  layer.forEach((row, z) => {
    Array.from(row).forEach((ch, x) => {
      const entry = SCENE.legend[ch]
      if (!entry) return
      blocks.push(typeof entry === "string"
        ? { id: entry, pos: [x, y, z] }
        : { id: entry.id, properties: entry.properties, pos: [x, y, z] })
    })
  })
})

const handle = await createScene(assets, blocks)

const { scene, camera } = makeModelScene()
scene.add(handle.group)

// Centre the scene at the origin, keeping the light volume aligned with it
const { min, max } = handle.bounds
handle.group.position.set(-(min.x + max.x) / 2, -(min.y + max.y) / 2, -(min.z + max.z) / 2)
handle.light?.setOffset(handle.group.position)

// Isometric camera fitted around the scene's bounding sphere
const radius = Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2
const pitch = Math.PI / 6, yaw = -Math.PI / 4, distance = radius * 2
camera.position.set(
  Math.sin(yaw) * Math.cos(pitch) * distance,
  Math.sin(pitch) * distance,
  Math.cos(yaw) * Math.cos(pitch) * distance
)
camera.lookAt(0, 0, 0)
camera.left = -radius
camera.right = radius
camera.top = radius
camera.bottom = -radius
camera.near = 0.01
camera.far = distance + radius * 2

handle.sortTranslucent(camera)

const buffer = await renderModelScene(scene, camera, {
  width: 1024,
  height: 1024
})
await sharp(buffer).trim().png().toFile(`${import.meta.dirname}/renders/scene/scene.png`)

handle.dispose()
console.log("Done scene")
