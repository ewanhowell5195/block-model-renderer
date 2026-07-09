// Reflection extractor: runs against the unobfuscated Minecraft server jar,
// bootstraps the registries, and dumps the block/colour lists the library
// hardcodes. Compiled by ECJ and run on a plain JRE from generate.js.
import java.util.*;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.data.registries.VanillaRegistries;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.biome.Biomes;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.shapes.VoxelShape;
import net.minecraft.world.item.DyeColor;
import net.minecraft.world.item.alchemy.Potion;
import net.minecraft.world.effect.MobEffect;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.level.GrassColor;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.TextColor;
import net.minecraft.client.color.block.BlockColors;
import net.minecraft.client.color.block.BlockTintSource;

public class Extract {
  static String hex(int c) { return String.format("#%06X", c & 0xFFFFFF); }
  @SuppressWarnings({"unchecked", "rawtypes"})
  static BlockState with(BlockState s, Property p, Object v) { return s.setValue(p, (Comparable) v); }
  static String arr(List<String> xs) {
    Collections.sort(xs);
    StringBuilder b = new StringBuilder("[");
    for (int i = 0; i < xs.size(); i++) { if (i > 0) b.append(","); b.append("\"").append(xs.get(i)).append("\""); }
    return b.append("]").toString();
  }

  public static void main(String[] args) {
    SharedConstants.tryDetectVersion();
    Bootstrap.bootStrap();

    // The client renders a block's biome-colormap tint (grass/foliage/dry_foliage)
    // on the model face at the tintindex that matches the colormap source's
    // position in the block's tint-source list. Most are at index 0; record the
    // few that aren't (e.g. pink_petals, where a blank layer sits at 0).
    BlockColors colors = BlockColors.createDefault();
    int grassDefault = GrassColor.getDefaultColor();
    TreeMap<String, Integer> tintindex = new TreeMap<>();

    // Two tint kinds resolvable straight from the block's tint source: a flat
    // constant colour (fixed), or a ramp keyed off one blockstate property
    // (indexed, e.g. redstone by power, stems by age). Biome-tinted sources
    // (grass/foliage colormap, water) can't be read here (no colormap textures
    // and water's tint comes from the fluid renderer), so they're skipped.
    TreeMap<String, String> fixed = new TreeMap<>();
    TreeMap<String, String> indexed = new TreeMap<>();

    // Water is tinted by the fluid renderer using the biome water colour, not by
    // a flat BlockColors source, so inject the vanilla default (plains) colour.
    HolderLookup.Provider registries = VanillaRegistries.createLookup();
    int waterColor = registries.lookupOrThrow(Registries.BIOME).getOrThrow(Biomes.PLAINS).value().getWaterColor();

    List<String> all = new ArrayList<>(), waterlog = new ArrayList<>(), noOcc = new ArrayList<>(), selfAll = new ArrayList<>(), selfY = new ArrayList<>();
    for (Block block : BuiltInRegistries.BLOCK) {
      String id = BuiltInRegistries.BLOCK.getKey(block).getPath();
      all.add(id);
      List<BlockTintSource> tintSources = colors.getTintSources(block.defaultBlockState());
      for (int i = 1; i < tintSources.size(); i++) {
        int c = tintSources.get(i).color(block.defaultBlockState());
        if (c == grassDefault || c == -12012264 || c == -10732494) { tintindex.put(id, i); break; }
      }
      BlockState st = block.defaultBlockState();
      if (block.getStateDefinition().getProperties().contains(BlockStateProperties.WATERLOGGED)) waterlog.add(id);

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
    sb.append("\"waterloggable\":").append(arr(waterlog)).append(",\n");
    sb.append("\"nonOccluding\":").append(arr(noOcc)).append(",\n");
    sb.append("\"selfCullAll\":").append(arr(selfAll)).append(",\n");
    sb.append("\"selfCullY\":").append(arr(selfY)).append(",\n");

    sb.append("\"dye\":{");
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
