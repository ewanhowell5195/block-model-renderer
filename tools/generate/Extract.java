// Reflection extractor: runs against the unobfuscated Minecraft server jar,
// bootstraps the registries, and dumps the block/colour lists the library
// hardcodes. Compiled with javac and run from generate.js.
import java.util.*;
import java.io.InputStream;
import java.awt.image.BufferedImage;
import javax.imageio.ImageIO;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.data.registries.VanillaRegistries;
import net.minecraft.world.level.ColorResolver;
import net.minecraft.world.level.CardinalLighting;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.GrassColor;
import net.minecraft.world.level.FoliageColor;
import net.minecraft.world.level.DryFoliageColor;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.biome.Biomes;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.lighting.LevelLightEngine;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.shapes.VoxelShape;
import net.minecraft.core.component.DataComponentInitializers;
import net.minecraft.core.component.DataComponents;
import net.minecraft.world.item.DyeColor;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.alchemy.Potion;
import net.minecraft.world.effect.MobEffect;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.TextColor;
import net.minecraft.client.renderer.block.BlockAndTintGetter;
import net.minecraft.client.color.block.BlockColors;
import net.minecraft.client.color.block.BlockTintSource;

public class Extract {
  // A block-and-tint getter that reports one fixed biome everywhere, enough for
  // a colormap tint source to resolve (it only reads the biome at the position).
  static class Stub implements BlockAndTintGetter {
    final Biome biome;
    Stub(Biome b) { biome = b; }
    public int getBlockTint(BlockPos p, ColorResolver r) { return r.getColor(biome, p.getX(), p.getZ()); }
    public CardinalLighting cardinalLighting() { return null; }
    public LevelLightEngine getLightEngine() { return null; }
    public FluidState getFluidState(BlockPos p) { return Blocks.AIR.defaultBlockState().getFluidState(); }
    public BlockEntity getBlockEntity(BlockPos p) { return null; }
    public BlockState getBlockState(BlockPos p) { return Blocks.AIR.defaultBlockState(); }
    public int getMinY() { return 0; }
    public int getHeight() { return 16; }
  }

  static int[] colormapPixels(String path) {
    try {
      InputStream is = Extract.class.getResourceAsStream(path);
      BufferedImage img = ImageIO.read(is);
      is.close();
      int[] px = new int[img.getWidth() * img.getHeight()];
      img.getRGB(0, 0, img.getWidth(), img.getHeight(), px, 0, img.getWidth());
      return px;
    } catch (Exception e) { throw new RuntimeException(e); }
  }

  // The datapack-registry lookup factory was renamed (createLookup ->
  // createWorldLookup) between versions, so resolve whichever exists at runtime.
  static HolderLookup.Provider worldLookup() {
    for (String name : new String[]{ "createWorldLookup", "createLookup" }) {
      try { return (HolderLookup.Provider) VanillaRegistries.class.getMethod(name).invoke(null); }
      catch (NoSuchMethodException e) { continue; }
      catch (Exception e) { throw new RuntimeException(e); }
    }
    throw new RuntimeException("no VanillaRegistries world-lookup factory found");
  }

  static int anchorTint(BlockColors colors, Block b, Stub stub) {
    BlockState st = b.defaultBlockState();
    return colors.getTintSources(st).get(0).colorInWorld(st, stub, BlockPos.ZERO);
  }

  static String hex(int c) { return String.format("#%06X", c & 0xFFFFFF); }
  @SuppressWarnings({"unchecked", "rawtypes"})
  static BlockState with(BlockState s, Property p, Object v) { return s.setValue(p, (Comparable) v); }
  @SuppressWarnings({"unchecked", "rawtypes"})
  static String pval(BlockState s, Property p) { return p.getName(s.getValue(p)); }

  // A per-state int property as JSON: a bare value when every state agrees,
  // else {"default":..,"cases":[..]} keyed on only the deciding properties,
  // with the most common value as the default (same shape as lightEmission).
  static String caseValue(Block block, java.util.function.ToIntFunction<BlockState> fn) {
    List<BlockState> states = block.getStateDefinition().getPossibleStates();
    Set<Integer> vals = new TreeSet<>();
    for (BlockState s2 : states) vals.add(fn.applyAsInt(s2));
    if (vals.size() == 1) return String.valueOf(vals.iterator().next());
    List<Property<?>> deps = new ArrayList<>();
    for (Property<?> p : block.getStateDefinition().getProperties()) {
      outer:
      for (BlockState s2 : states) {
        for (Object v : p.getPossibleValues()) {
          if (fn.applyAsInt(with(s2, p, v)) != fn.applyAsInt(s2)) { deps.add(p); break outer; }
        }
      }
    }
    TreeMap<String, Integer> combos = new TreeMap<>();
    for (BlockState s2 : states) {
      StringBuilder ck = new StringBuilder("{");
      boolean cf = true;
      for (Property<?> p : deps) { if (!cf) ck.append(","); cf = false; ck.append("\"").append(p.getName()).append("\":\"").append(pval(s2, p)).append("\""); }
      combos.putIfAbsent(ck.append("}").toString(), fn.applyAsInt(s2));
    }
    TreeMap<Integer, Integer> counts = new TreeMap<>();
    for (int e : combos.values()) counts.merge(e, 1, Integer::sum);
    int def = 0, best = -1;
    for (var en : counts.entrySet()) if (en.getValue() > best) { best = en.getValue(); def = en.getKey(); }
    StringBuilder cases = new StringBuilder("[");
    boolean cf = true;
    for (var en : combos.entrySet()) {
      if (en.getValue() == def) continue;
      if (!cf) cases.append(",");
      cf = false;
      cases.append("[").append(en.getKey()).append(",").append(en.getValue()).append("]");
    }
    return "{\"default\":" + def + ",\"cases\":" + cases.append("]") + "}";
  }
  static String arr(List<String> xs) {
    Collections.sort(xs);
    StringBuilder b = new StringBuilder("[");
    for (int i = 0; i < xs.size(); i++) { if (i > 0) b.append(","); b.append("\"").append(xs.get(i)).append("\""); }
    return b.append("]").toString();
  }

  public static void main(String[] args) {
    SharedConstants.tryDetectVersion();
    Bootstrap.bootStrap();

    BlockColors colors = BlockColors.createDefault();

    // Biome-colormap tints (grass/foliage/dry_foliage) are sampled from the
    // colormap textures, so load them and resolve each block against a real
    // biome. A block's colormap kind is whichever anchor colour (grass_block,
    // oak_leaves, leaf_litter) its biome-varying source matches; a second biome
    // tells a biome-varying source apart from a constant. The index of that
    // source is the tintindex (0 for most, 1 for e.g. pink_petals).
    HolderLookup.Provider registries = worldLookup();
    var biomeReg = registries.lookupOrThrow(Registries.BIOME);
    int waterColor = biomeReg.getOrThrow(Biomes.PLAINS).value().getWaterColor();
    GrassColor.init(colormapPixels("/assets/minecraft/textures/colormap/grass.png"));
    FoliageColor.init(colormapPixels("/assets/minecraft/textures/colormap/foliage.png"));
    DryFoliageColor.init(colormapPixels("/assets/minecraft/textures/colormap/dry_foliage.png"));
    Stub plains = new Stub(biomeReg.getOrThrow(Biomes.PLAINS).value());
    Stub cold = new Stub(biomeReg.getOrThrow(Biomes.SNOWY_TAIGA).value());

    int grassRef = 0, foliageRef = 0, dryRef = 0;
    for (Block b : BuiltInRegistries.BLOCK) {
      String id = BuiltInRegistries.BLOCK.getKey(b).getPath();
      if (id.equals("grass_block")) grassRef = anchorTint(colors, b, plains);
      else if (id.equals("oak_leaves")) foliageRef = anchorTint(colors, b, plains);
      else if (id.equals("leaf_litter")) dryRef = anchorTint(colors, b, plains);
    }

    TreeMap<String, Integer> tintindex = new TreeMap<>();
    LinkedHashMap<String, List<String>> colormap = new LinkedHashMap<>();
    for (String k : new String[]{ "grass", "foliage", "dry_foliage" }) colormap.put(k, new ArrayList<>());

    // Two tint kinds resolvable straight from the block's tint source: a flat
    // constant colour (fixed), or a ramp keyed off one blockstate property
    // (indexed, e.g. redstone by power, stems by age). Biome-tinted sources are
    // handled by the colormap classification above, so they're skipped here.
    TreeMap<String, String> fixed = new TreeMap<>();
    TreeMap<String, String> indexed = new TreeMap<>();

    List<String> all = new ArrayList<>(), waterlog = new ArrayList<>(), alwaysWater = new ArrayList<>(), noOcc = new ArrayList<>(), selfAll = new ArrayList<>(), selfY = new ArrayList<>();
    TreeMap<String, String> lightEmission = new TreeMap<>();
    TreeMap<String, String> shapeLightOcclusion = new TreeMap<>();
    for (Block block : BuiltInRegistries.BLOCK) {
      String id = BuiltInRegistries.BLOCK.getKey(block).getPath();
      all.add(id);
      List<BlockTintSource> tintSources = colors.getTintSources(block.defaultBlockState());
      BlockState st = block.defaultBlockState();
      for (int i = 0; i < tintSources.size(); i++) {
        int p, c;
        try { p = tintSources.get(i).colorInWorld(st, plains, BlockPos.ZERO); c = tintSources.get(i).colorInWorld(st, cold, BlockPos.ZERO); }
        catch (Throwable t) { continue; }
        if (p == c) continue;
        String kind = p == grassRef ? "grass" : p == foliageRef ? "foliage" : p == dryRef ? "dry_foliage" : null;
        if (kind != null) { colormap.get(kind).add(id); if (i > 0) tintindex.put(id, i); break; }
      }
      boolean canWaterlog = block.getStateDefinition().getProperties().contains(BlockStateProperties.WATERLOGGED);
      if (canWaterlog) waterlog.add(id);
      // Inherently water-filled blocks: no waterlogged property, but their
      // fluid state is always water (kelp, seagrass, bubble columns). The
      // fluids themselves stay out, they have their own handling.
      if (!st.getFluidState().isEmpty() && !canWaterlog && !(block instanceof LiquidBlock)) alwaysWater.add(id);

      // A block hides a shared face against an identical neighbour wherever
      // skipRendering() says so. Probing behaviour (not classes) keeps this
      // robust across versions: all six directions -> selfCullAll, only the
      // vertical pair -> selfCullY (e.g. mangrove roots, iron bars).
      // Fluids self-cull and don't occlude too, but the code handles them via
      // its own fluid rules, so keep them out of these lists.
      boolean fluid = !st.getFluidState().isEmpty();
      boolean up = st.skipRendering(st, Direction.UP), dn = st.skipRendering(st, Direction.DOWN);
      boolean nn = st.skipRendering(st, Direction.NORTH), sso = st.skipRendering(st, Direction.SOUTH);
      boolean ee = st.skipRendering(st, Direction.EAST), ww = st.skipRendering(st, Direction.WEST);
      boolean cullAll = up && dn && nn && sso && ee && ww;
      if (cullAll && !fluid) selfAll.add(id);
      else if (up && dn && !nn && !sso && !ee && !ww && !fluid) selfY.add(id);

      // Non-occluding blocks only need the override when they render a full
      // opaque face that would occlude a neighbour: any one full 16x16 face
      // (a trapdoor/door/ladder covers one side), or (for soft-collision full
      // models like powder snow) an all-direction self-cull.
      VoxelShape shape = st.getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
      boolean anyFullFace = false;
      for (Direction d : Direction.values()) if (Block.isFaceFull(shape, d)) { anyFullFace = true; break; }
      if (!st.canOcclude() && (anyFullFace || cullAll) && !fluid) noOcc.add(id);

      // Blocks that emit light by themselves (glowstone, torches, lava). A
      // uniform emitter is stored as its level; when the level depends on
      // blockstate (lit furnaces, candle counts), only the deciding properties
      // are kept: the most common level becomes the default and the rest are
      // per-combination cases, so e.g. glow_lichen (level 7 unless every face
      // is off) is one case rather than 64 combinations.
      List<BlockState> states = block.getStateDefinition().getPossibleStates();
      String emissionValue = caseValue(block, BlockState::getLightEmission);
      if (!emissionValue.equals("0")) lightEmission.put(id, emissionValue);

      // Blocks whose occlusion shape also blocks light face-to-face (stairs,
      // slabs, snow layers): useShapeForLightOcclusion is an explicit opt-in
      // flag in the game, not derivable from the shape, so it's extracted.
      boolean anyShapeOcclusion = false;
      for (BlockState s2 : states) if (s2.useShapeForLightOcclusion()) { anyShapeOcclusion = true; break; }
      if (anyShapeOcclusion) shapeLightOcclusion.put(id, caseValue(block, s2 -> s2.useShapeForLightOcclusion() ? 1 : 0));

      if (!tintSources.isEmpty()) {
        BlockTintSource s0 = tintSources.get(0);
        boolean biomeDep;
        int world = 0;
        try { world = s0.colorInWorld(st, null, BlockPos.ZERO); biomeDep = s0.color(st) == -1; }
        catch (Throwable t) { biomeDep = true; }
        Set<Property<?>> rel = s0.relevantProperties();
        if (biomeDep) {
          // grass/foliage colormap or water: not resolvable here, handled elsewhere
        } else if (rel.isEmpty()) {
          fixed.put(id, hex(world));
        } else if (rel.size() == 1 && rel.iterator().next().getPossibleValues().iterator().next() instanceof Integer) {
          Property<?> p = rel.iterator().next();
          int max = 0;
          for (Object v : p.getPossibleValues()) max = Math.max(max, (Integer) v);
          String[] ramp = new String[max + 1];
          for (Object v : p.getPossibleValues()) { int n = (Integer) v; ramp[n] = hex(s0.colorInWorld(with(st, p, n), null, BlockPos.ZERO)); }
          StringBuilder r = new StringBuilder("[");
          for (int i = 0; i < ramp.length; i++) { if (i > 0) r.append(","); r.append("\"").append(ramp[i]).append("\""); }
          indexed.put(id, "{\"property\":\"" + p.getName() + "\",\"default\":" + st.getValue(p) + ",\"colors\":" + r.append("]") + "}");
        }
      }
    }
    for (String w : new String[]{ "water", "bubble_column", "water_cauldron" }) fixed.put(w, hex(waterColor));

    // Items that always render the enchantment glint: registered with a default
    // ENCHANTMENT_GLINT_OVERRIDE=true component (enchanted golden apple, nether
    // star, debug stick...). Component-driven glint (enchantments, an explicit
    // override, lodestone compasses) is logic in the renderer, not a list.
    // Default components bind lazily (they can reference datapack registries),
    // so run the initializers against the vanilla lookup first.
    for (DataComponentInitializers.PendingComponents<?> pending : BuiltInRegistries.DATA_COMPONENT_INITIALIZERS.build(registries)) pending.apply();
    List<String> allItems = new ArrayList<>(), glintItems = new ArrayList<>();
    for (Item item : BuiltInRegistries.ITEM) {
      String iid = BuiltInRegistries.ITEM.getKey(item).getPath();
      allItems.add(iid);
      if (Boolean.TRUE.equals(item.components().get(DataComponents.ENCHANTMENT_GLINT_OVERRIDE))) glintItems.add(iid);
    }

    // Potion tint = the blend of its effects' colours. Skip potions whose name
    // is itself an effect id (getPotionColor resolves those directly), and drop
    // the amplifier for single-effect potions (it can't affect a one-colour blend).
    TreeMap<String, String> potions = new TreeMap<>();
    for (Potion p : BuiltInRegistries.POTION) {
      String pid = BuiltInRegistries.POTION.getKey(p).getPath();
      List<MobEffectInstance> effs = p.getEffects();
      if (effs.isEmpty()) continue;
      String firstId = BuiltInRegistries.MOB_EFFECT.getKey(effs.get(0).getEffect().value()).getPath();
      if (effs.size() == 1) {
        if (firstId.equals(pid)) continue;
        potions.put(pid, "[\"" + firstId + "\"]");
      } else {
        StringBuilder arr = new StringBuilder("[");
        for (int i = 0; i < effs.size(); i++) {
          String eid = BuiltInRegistries.MOB_EFFECT.getKey(effs.get(i).getEffect().value()).getPath();
          if (i > 0) arr.append(",");
          arr.append("[\"").append(eid).append("\",").append(effs.get(i).getAmplifier()).append("]");
        }
        potions.put(pid, arr.append("]").toString());
      }
    }

    StringBuilder sb = new StringBuilder("{\n");
    sb.append("\"allBlocks\":").append(arr(all)).append(",\n");
    sb.append("\"allItems\":").append(arr(allItems)).append(",\n");
    sb.append("\"glintItems\":").append(arr(glintItems)).append(",\n");
    sb.append("\"waterloggable\":").append(arr(waterlog)).append(",\n");
    sb.append("\"waterlogged\":").append(arr(alwaysWater)).append(",\n");
    sb.append("\"nonOccluding\":").append(arr(noOcc)).append(",\n");
    sb.append("\"selfCullAll\":").append(arr(selfAll)).append(",\n");
    sb.append("\"selfCullY\":").append(arr(selfY)).append(",\n");

    sb.append("\"lightEmission\":{");
    boolean fe = true;
    for (var e : lightEmission.entrySet()) { if (!fe) sb.append(","); fe = false; sb.append("\"").append(e.getKey()).append("\":").append(e.getValue()); }
    sb.append("},\n\"shapeLightOcclusion\":{");
    fe = true;
    for (var e : shapeLightOcclusion.entrySet()) { if (!fe) sb.append(","); fe = false; sb.append("\"").append(e.getKey()).append("\":").append(e.getValue()); }
    sb.append("},\n\"colormap\":{");
    boolean fc = true;
    for (var e : colormap.entrySet()) { if (!fc) sb.append(","); fc = false; sb.append("\"").append(e.getKey()).append("\":").append(arr(e.getValue())); }
    sb.append("},\n\"dye\":{");
    DyeColor[] ds = DyeColor.values();
    for (int i = 0; i < ds.length; i++) { if (i > 0) sb.append(","); sb.append("\"").append(ds[i].getName()).append("\":\"").append(hex(ds[i].getTextureDiffuseColor())).append("\""); }

    sb.append("},\n\"effects\":{");
    boolean f = true;
    for (MobEffect e : BuiltInRegistries.MOB_EFFECT) { if (!f) sb.append(","); f = false; sb.append("\"").append(BuiltInRegistries.MOB_EFFECT.getKey(e).getPath()).append("\":\"").append(hex(e.getColor())).append("\""); }

    sb.append("},\n\"team\":{");
    f = true;
    for (ChatFormatting c : ChatFormatting.values()) {
      TextColor tc = TextColor.fromLegacyFormat(c);
      if (tc != null) { if (!f) sb.append(","); f = false; sb.append("\"").append(c.name().toLowerCase()).append("\":\"").append(hex(tc.getValue())).append("\""); }
    }
    sb.append("},\n\"tintindex\":{");
    f = true;
    for (var e : tintindex.entrySet()) { if (!f) sb.append(","); f = false; sb.append("\"").append(e.getKey()).append("\":").append(e.getValue()); }
    sb.append("},\n\"fixed\":{");
    f = true;
    for (var e : fixed.entrySet()) { if (!f) sb.append(","); f = false; sb.append("\"").append(e.getKey()).append("\":\"").append(e.getValue()).append("\""); }
    sb.append("},\n\"indexed\":{");
    f = true;
    for (var e : indexed.entrySet()) { if (!f) sb.append(","); f = false; sb.append("\"").append(e.getKey()).append("\":").append(e.getValue()); }
    sb.append("},\n\"potions\":{");
    f = true;
    for (var e : potions.entrySet()) { if (!f) sb.append(","); f = false; sb.append("\"").append(e.getKey()).append("\":").append(e.getValue()); }
    sb.append("}\n}");

    System.out.println("<<<EXTRACT-JSON");
    System.out.println(sb.toString());
    System.out.println("EXTRACT-JSON>>>");
  }
}
