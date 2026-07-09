export const modelLoaders = []

export const ModelLoader = {
  register(loader) {
    if (!loader || typeof loader !== "object") throw new Error("ModelLoader.register requires a loader object")
    modelLoaders.push(loader)
    modelLoaders.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    return loader
  },
  remove(loader) {
    const i = modelLoaders.findIndex(l => l === loader || (typeof loader === "string" && l.name === loader))
    if (i === -1) return false
    modelLoaders.splice(i, 1)
    return true
  },
  list() {
    return Array.from(modelLoaders)
  },
  variantKey(model, block) {
    let key = null
    for (const loader of modelLoaders) {
      if (loader.variantKey && loader.match?.(model)) {
        const k = loader.variantKey(model, block)
        if (k != null) key = key === null ? String(k) : `${key}\0${k}`
      }
    }
    return key
  }
}
