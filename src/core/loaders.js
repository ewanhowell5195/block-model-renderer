export const modelLoaders = []

export const ModelLoader = {
  register(loader) {
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
  }
}
