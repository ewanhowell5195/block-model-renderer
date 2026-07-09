# Data generation

The block and colour lists the library used to hardcode (`src/core/data/blocks.json`
and `colors.json`) are generated from the real Minecraft code, so they can be
refreshed for a new version instead of maintained by hand.

Modern Minecraft server jars ship **unobfuscated** (real `net.minecraft.*` names),
so there is no decompilation or remapping: `Extract.java` is compiled with a small
bundled compiler ([ECJ](https://mvnrepository.com/artifact/org.eclipse.jdt/ecj),
which runs on a plain JRE) and executed against the server jar. It bootstraps the
registries and reads the values straight from the game:

| Data | Source |
|---|---|
| `waterloggable` | blocks with a `WATERLOGGED` state property |
| `nonOccluding` | blocks where `state.canOcclude()` is false **and** they cover a full 16×16 face on some side (`Block.isFaceFull`), so they'd otherwise wrongly occlude that neighbour: full cubes, but also one-face coverers like doors, trapdoors, ladders. Thin/small models (plants, skulls, bars) cover no full face and are skipped. Fluids are handled by an `isFluid` check in code |
| `selfCullAll` | `HalfTransparentBlock` / `PowderSnowBlock` instances |
| `selfCullY` | `MangroveRootsBlock` instances |
| `dye` | `DyeColor.getTextureDiffuseColor()` |
| `effects` | `MobEffect.getColor()` over the mob-effect registry |
| `team` | `TextColor.fromLegacyFormat()` over the colour `ChatFormatting`s |
| `tintindex` | client `BlockColors.getTintSources()`: the list index of a block's biome-colormap source (only the non-zero ones, e.g. `pink_petals`) |
| `potions` | `Potion.getEffects()` over the potion registry: effect ids per potion (with amplifiers for multi-effect blends); potions whose name is itself an effect id are omitted |

The block/colour reads come from the server jar; `tintindex` needs the **client**
jar (also unobfuscated), since it lives in client `BlockColors`. Both are downloaded
and cached. `BlockColors.createDefault()` runs headlessly (no GL).

The block lists are compressed into a minimal `{ suffix, exact, except }` cover
(consumed by `matchId`) rather than a flat list of every id, so they stay small and
generalise to future blocks (a new `*_stairs` is covered without regenerating). The
cover is verified against the full block set, so it never over-matches the current
version; the `except` list holds the few blocks a suffix would wrongly catch (e.g.
`packed_ice` under the `ice` suffix, `jack_o_lantern` under `lantern`).

## Usage

Requires a Java runtime (`java` on `PATH`, or `JAVA_HOME` set). A JRE is enough; no
JDK needed.

```bash
npm run generate            # latest snapshot from Mojang's manifest
npm run generate 26.2       # a specific version
node tools/generate/generate.js --check 26.2   # verify, don't write (used by tests)
```

Downloads (server jar, ECJ) are cached under `tools/generate/.cache` (gitignored).

## Tests

`npm test` checks the generated data and the code that consumes it, and (when a
JRE is available) re-runs the generator in `--check` mode against the version the
data was generated from, failing if the committed JSON no longer matches the game.
