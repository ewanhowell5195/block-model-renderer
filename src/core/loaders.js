export const modelLoaders = []
export const shadings = new Map()

function shadingLights(lights, name, context) {
  if (lights == null) return null
  if (!Array.isArray(lights?.lights) || lights.lights.length !== 2 || !lights.lights.every(l => Array.isArray(l) && l.length === 3 && l.every(Number.isFinite))) throw new Error(`ModelLoader.registerShading("${name}") ${context} needs lights: two [x, y, z] directions`)
  return { lights: lights.lights.map(l => l.slice()), power: lights.power ?? 0.6, ambient: lights.ambient ?? 0.4 }
}

export function activeLoaders() {
  return modelLoaders.slice().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
}

export const ModelLoader = {
  register(loader) {
    if (!loader || typeof loader !== "object") throw new Error("ModelLoader.register requires a loader object")
    modelLoaders.push(loader)
    return loader
  },
  remove(loader) {
    const i = modelLoaders.findIndex(l => l === loader || (typeof loader === "string" && l.name === loader))
    if (i === -1) return false
    modelLoaders.splice(i, 1)
    return true
  },
  list() {
    return activeLoaders()
  },
  registerShading(name, definition) {
    if (typeof name !== "string" || !definition || typeof definition !== "object") throw new Error("ModelLoader.registerShading requires a name and a definition")
    const level = shadingLights(definition.level, name, "level")
    if (!level) throw new Error(`ModelLoader.registerShading("${name}") needs level lights`)
    shadings.set(name, { level, nether: shadingLights(definition.nether, name, "nether") ?? level, ui: shadingLights(definition.ui, name, "ui") ?? level })
    return name
  },
  removeShading(name) {
    return shadings.delete(name)
  },
  variantKey(model, block) {
    let key = null
    for (const loader of activeLoaders()) {
      if (loader.variantKey && loader.match?.(model)) {
        const k = loader.variantKey(model, block)
        if (k != null) key = key === null ? String(k) : `${key}\0${k}`
      }
    }
    return key
  }
}
