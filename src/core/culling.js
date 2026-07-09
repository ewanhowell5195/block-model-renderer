import { normalize, matchId } from "./platform.js"

const SELF_CULL_ANY = { suffix: ["glass", "_grate"], exact: new Set(["ice", "frosted_ice", "honey_block", "slime_block", "powder_snow", "dirt_path"]) }
const selfCullAny = id => matchId(id, SELF_CULL_ANY)

const selfCullY = id => id === "mangrove_roots"

const NO_OCCLUDE = {
  suffix: ["glass", "_grate", "_door", "_trapdoor", "_leaves", "_head", "_skull", "_egg"],
  exact: new Set([
    "ice", "frosted_ice", "honey_block", "slime_block", "powder_snow", "tinted_glass",
    "barrier", "light", "beacon", "conduit", "spawner", "trial_spawner", "vault", "moving_piston",
    "mangrove_roots", "iron_bars", "iron_chain", "ladder", "lantern", "soul_lantern", "sea_pickle",
    "lily_pad", "amethyst_cluster", "pointed_dripstone", "chorus_flower", "chorus_plant", "cocoa",
    "frogspawn", "end_rod", "hopper", "brewing_stand", "cauldron", "campfire", "soul_campfire",
    "decorated_pot", "dried_ghast", "azalea", "flowering_azalea", "bamboo", "sulfur_spike",
    "test_instance_block", "glass_pane", "pale_moss_carpet",
  ]),
  except: new Set(["piston_head"]),
}
const isFluid = id => /(^|_)(water|lava)$/.test(id)
const fluidFamily = id => id.includes("lava") ? "lava" : "water"

export function canOcclude(block) {
  block = normalize(block)
  return !isFluid(block) && !matchId(block, NO_OCCLUDE)
}

export function selfCulls(block, neighbor, direction) {
  if (!block || !neighbor) return false
  block = normalize(block); neighbor = normalize(neighbor)
  if (isFluid(block) && isFluid(neighbor)) return fluidFamily(block) === fluidFamily(neighbor)
  if (block !== neighbor) return false
  if (selfCullAny(block)) return true
  if (selfCullY(block) && (direction === "up" || direction === "down")) return true
  return false
}
