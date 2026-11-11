import { normalize } from "./platform.js"

const SNBT_FLOAT = /[+-]?(?:\d+\.\d*(?:[eE][+-]?\d+)?[fFdD]?|\.\d+(?:[eE][+-]?\d+)?[fFdD]?|\d+[eE][+-]?\d+[fFdD]?|\d+[fFdD])/y
const SNBT_INT = /[+-]?(?:0|[1-9]\d*)([bBsSiIlL])?/y
const SNBT_UNQUOTED = /[0-9A-Za-z_.+-]+/y
const SNBT_ARRAY = /\s*([BIL])\s*;/y
const SNBT_ESCAPES = { b: "\b", s: " ", t: "\t", n: "\n", f: "\f", r: "\r", "\\": "\\", "'": "'", "\"": "\"" }
const SNBT_HEX_ESCAPES = { x: 2, u: 4, U: 8 }
const SNBT_ARRAY_ELEMENTS = { B: "b", I: "bsi", L: "bsil" }

class Unmatchable extends Error {}

class NbtNumber {
  constructor(type, value) {
    this.type = type
    this.value = value
  }
}

class NbtArray {
  constructor(type, values) {
    this.type = type
    this.values = values
  }
}

function parseSnbt(text) {
  let pos = 0

  function fail() {
    throw new Unmatchable()
  }

  function skip() {
    while (/\s/.test(text.charAt(pos))) pos++
  }

  function match(pattern) {
    pattern.lastIndex = pos
    const found = pattern.exec(text)
    if (found) pos = pattern.lastIndex
    return found
  }

  function entries(close, entry) {
    skip()
    while (text[pos] !== close) {
      entry()
      skip()
      if (text[pos] === ",") pos++
      else if (text[pos] !== close) fail()
      skip()
    }
    pos++
  }

  function quoted() {
    const quote = text[pos++]
    let out = ""
    while (pos < text.length && text[pos] !== quote) {
      if (text[pos] !== "\\") {
        out += text[pos++]
        continue
      }
      const escape = text.charAt(pos + 1)
      const digits = SNBT_HEX_ESCAPES[escape]
      const hex = digits ? text.slice(pos + 2, pos + 2 + digits) : ""
      if (digits && (hex.length !== digits || /[^0-9a-fA-F]/.test(hex) || parseInt(hex, 16) > 0x10FFFF)) fail()
      if (!digits && !Object.hasOwn(SNBT_ESCAPES, escape)) fail()
      out += digits ? String.fromCodePoint(parseInt(hex, 16)) : SNBT_ESCAPES[escape]
      pos += 2 + (digits ?? 0)
    }
    if (pos >= text.length) fail()
    pos++
    return out
  }

  function number() {
    const float = match(SNBT_FLOAT)
    if (float) return new NbtNumber(/f$/i.test(float[0]) ? "f" : "d", parseFloat(float[0]))
    const int = match(SNBT_INT) ?? fail()
    return new NbtNumber((int[1] ?? "i").toLowerCase(), parseInt(int[0]))
  }

  function arrayEntry(type) {
    const int = match(SNBT_INT) ?? fail()
    if (int[1] && !SNBT_ARRAY_ELEMENTS[type].includes(int[1].toLowerCase())) fail()
    return parseInt(int[0])
  }

  function list() {
    pos++
    const array = match(SNBT_ARRAY)?.[1]
    const out = []
    entries("]", () => out.push(array ? arrayEntry(array) : value()))
    return array ? new NbtArray(array, out) : out
  }

  function compound() {
    const out = Object.create(null)
    pos++
    entries("}", () => {
      const key = text[pos] === "\"" || text[pos] === "'" ? quoted() : (match(SNBT_UNQUOTED) ?? fail())[0]
      skip()
      if (!key || text[pos++] !== ":") fail()
      out[key] = value()
    })
    return out
  }

  function value() {
    skip()
    const char = text.charAt(pos)
    if (char === "{") return compound()
    if (char === "[") return list()
    if (char === "\"" || char === "'") return quoted()
    if (/[-+.\d]/.test(char)) return number()
    const word = (match(SNBT_UNQUOTED) ?? fail())[0]
    skip()
    if (text[pos] === "(") fail()
    if (/^(true|false)$/i.test(word)) return new NbtNumber("b", word.length === 4 ? 1 : 0)
    return word
  }

  skip()
  if (text[pos] !== "{") fail()
  const tag = compound()
  skip()
  if (pos < text.length) fail()
  return tag
}

function compoundOf(value) {
  return typeof value === "string" ? parseSnbt(value) : value
}

function nbtTag(value) {
  if (typeof value === "number") return new NbtNumber(null, value)
  if (typeof value === "boolean") return new NbtNumber("b", Number(value))
  return value
}

function isCompound(tag) {
  return tag !== null && typeof tag === "object" && !Array.isArray(tag) && !(tag instanceof NbtNumber) && !(tag instanceof NbtArray)
}

function sameNumber(a, b) {
  if (a.type && b.type && a.type !== b.type) return false
  return a.type === "f" || b.type === "f" ? Math.fround(a.value) === Math.fround(b.value) : a.value === b.value
}

function nbtMatches(expected, actual) {
  expected = nbtTag(expected)
  actual = nbtTag(actual)
  if (expected instanceof NbtNumber) return actual instanceof NbtNumber && sameNumber(expected, actual)
  if (expected instanceof NbtArray) return actual instanceof NbtArray && expected.type === actual.type && expected.values.length === actual.values.length && expected.values.every((v, i) => v === actual.values[i])
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false
    if (!expected.length) return !actual.length
    return actual.length >= expected.length && expected.every(tag => actual.some(candidate => nbtMatches(tag, candidate)))
  }
  if (isCompound(expected)) return isCompound(actual) && Object.keys(expected).every(key => nbtMatches(expected[key], actual[key]))
  return expected === actual
}

function listOf(value) {
  return Array.isArray(value) ? value : []
}

function rawOf(filterable) {
  return filterable !== null && typeof filterable === "object" && "raw" in filterable ? filterable.raw : filterable
}

function optionalEquals(expected, actual) {
  return expected == null || expected === actual
}

function boundsMatch(bounds, value) {
  if (bounds == null) return true
  if (typeof bounds !== "object") return Number(bounds) === value
  return (bounds.min == null || bounds.min <= value) && (bounds.max == null || bounds.max >= value)
}

function holderSetContains(set, id) {
  if (typeof set === "string" && set.startsWith("#")) throw new Unmatchable()
  return typeof id === "string" && [].concat(set).some(entry => normalize(entry) === normalize(id))
}

function collectionMatches(predicate, values, test) {
  if (predicate == null) return true
  if (!listOf(predicate.contains).every(expected => values.some(value => test(value, expected)))) return false
  if (!listOf(predicate.count).every(entry => boundsMatch(entry.count, values.filter(value => test(value, entry.test)).length))) return false
  return boundsMatch(predicate.size, values.length)
}

function componentMap(components) {
  const data = Object.create(null)
  for (const key in components) {
    if (!key.startsWith("!")) data[normalize(key)] = components[key]
  }
  return data
}

export function sameValue(a, b) {
  if (typeof a === "string" && typeof b === "string") return normalize(a) === normalize(b)
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameValue(value, b[i]))
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b
  const other = componentMap(b)
  const keys = Object.keys(a)
  return keys.length === Object.keys(other).length && keys.every(key => normalize(key) in other && sameValue(a[key], other[normalize(key)]))
}

function textOf(component) {
  return typeof component === "string" ? { text: component } : component
}

function damageMatches(data, value) {
  if (data.damage == null) return false
  const damage = Number(data.damage)
  return boundsMatch(value?.durability, Number(data.max_damage ?? 0) - damage) && boundsMatch(value?.damage, damage)
}

function enchantmentsMatch(enchantments, value) {
  const levels = Object.entries(enchantments).map(([id, level]) => [id, Number(level)])
  return listOf(value).every(predicate => {
    if (predicate.enchantments == null) return levels.some(([, level]) => boundsMatch(predicate.levels, level))
    return levels.some(([id, level]) => holderSetContains(predicate.enchantments, id) && level !== 0 && boundsMatch(predicate.levels, level))
  })
}

function effectMatches(effect, predicates) {
  const key = Object.keys(predicates).find(id => normalize(id) === normalize(effect.id))
  if (key === undefined) return false
  const predicate = predicates[key]
  if (!boundsMatch(predicate.amplifier, effect.amplifier ?? 0) || !boundsMatch(predicate.duration, effect.duration ?? 0)) return false
  return optionalEquals(predicate.ambient, effect.ambient ?? false) && optionalEquals(predicate.visible, effect.show_particles ?? true)
}

function potionMatches(contents, value) {
  const potion = typeof contents === "string" ? contents : contents.potion
  if (value.potions != null && (potion == null || !holderSetContains(value.potions, potion))) return false
  return collectionMatches(value.effects, listOf(contents.custom_effects), effectMatches)
}

function containerItems(slots) {
  const items = new Map()
  for (const entry of listOf(slots)) items.set(entry?.slot, entry?.item)
  return Array.from(items.values())
}

function itemMatches(stack, predicate) {
  const item = typeof stack === "string" ? { id: stack } : stack ?? {}
  if (predicate.items != null && !holderSetContains(predicate.items, item.id)) return false
  if (!boundsMatch(predicate.count, item.count ?? 1)) return false
  const data = componentMap(item.components)
  return Object.keys(predicate.components ?? {}).every(id => sameValue(predicate.components[id], data[normalize(id)])) && Object.keys(predicate.predicates ?? {}).every(type => testPredicate(data, normalize(type), predicate.predicates[type]))
}

function explosionMatches(explosion, predicate) {
  return optionalEquals(predicate.shape, explosion.shape) && optionalEquals(predicate.has_twinkle, explosion.has_twinkle ?? false) && optionalEquals(predicate.has_trail, explosion.has_trail ?? false)
}

function writtenBookMatches(book, value) {
  if (!optionalEquals(value.author, book.author) || !optionalEquals(value.title, rawOf(book.title))) return false
  if (!boundsMatch(value.generation, book.generation ?? 0) || !optionalEquals(value.resolved, book.resolved ?? false)) return false
  return collectionMatches(value.pages, listOf(book.pages).map(rawOf), (page, expected) => sameValue(textOf(expected), textOf(page)))
}

function modifierMatches(modifier, predicate) {
  if (predicate.attribute != null && !holderSetContains(predicate.attribute, modifier.type)) return false
  if (predicate.id != null && normalize(predicate.id) !== normalize(modifier.id)) return false
  return boundsMatch(predicate.amount, modifier.amount) && optionalEquals(predicate.operation, modifier.operation) && optionalEquals(predicate.slot, modifier.slot ?? "any")
}

function single(component, test) {
  return (data, value) => data[component] != null && test(data[component], value ?? {})
}

const PREDICATES = {
  damage: damageMatches,
  enchantments: single("enchantments", enchantmentsMatch),
  stored_enchantments: single("stored_enchantments", enchantmentsMatch),
  potion_contents: single("potion_contents", potionMatches),
  custom_data: (data, value) => nbtMatches(compoundOf(value ?? {}), compoundOf(data.custom_data ?? {})),
  container: single("container", (slots, value) => collectionMatches(value.items, containerItems(slots), itemMatches)),
  bundle_contents: single("bundle_contents", (items, value) => collectionMatches(value.items, listOf(items), itemMatches)),
  firework_explosion: single("firework_explosion", explosionMatches),
  fireworks: single("fireworks", (fireworks, value) => collectionMatches(value.explosions, listOf(fireworks.explosions), explosionMatches) && boundsMatch(value.flight_duration, fireworks.flight_duration ?? 0)),
  writable_book_content: single("writable_book_content", (book, value) => collectionMatches(value.pages, listOf(book.pages).map(rawOf), (page, expected) => page === expected)),
  written_book_content: single("written_book_content", writtenBookMatches),
  attribute_modifiers: single("attribute_modifiers", (modifiers, value) => collectionMatches(value.modifiers, listOf(modifiers), modifierMatches)),
  trim: single("trim", (trim, value) => (value.material == null || holderSetContains(value.material, trim.material)) && (value.pattern == null || holderSetContains(value.pattern, trim.pattern))),
  jukebox_playable: single("jukebox_playable", (song, value) => value.song == null || holderSetContains(value.song, song)),
  "villager/variant": single("villager/variant", (variant, value) => holderSetContains(value, variant))
}

function testPredicate(data, type, value) {
  if (Object.hasOwn(PREDICATES, type)) return PREDICATES[type](data, value)
  return data[type] != null
}

export function matchesComponentPredicate(components, predicate, value) {
  try {
    return testPredicate(componentMap(components), normalize(predicate), value)
  } catch (error) {
    if (error instanceof Unmatchable) return false
    throw error
  }
}
