#!/usr/bin/env bash
#
# Copy GLB assets from the Kenney packs in ./textures/ plus the
# Starter-Kit-City-Builder clone into apps/web/static/models/.
#
# Visual source of truth is Kenney's Starter Kit City Builder (single
# shared colormap.png). We pull three things from outside it:
#   1. Mini Characters — agents; the starter kit has no characters.
#   2. Hexagon Kit      — island terrain surround around the square city.
#
# Every GLB references an external 'Textures/<name>.png' relative to its
# own folder, so each destination directory that mixes packs must have
# the right sibling Textures/ installed. Starter Kit + its sibling packs
# here each ship one colormap.png.
#
# Idempotent: safe to re-run.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/textures"
STARTER="$ROOT/Starter-Kit-City-Builder"
DST="$ROOT/apps/web/static/models"

rm -rf "$DST"
mkdir -p "$DST"/{buildings,roads,nature,pavement,characters,terrain}

copy() {
  local src="$1"
  local dst="$2"
  if [[ ! -f "$src" ]]; then
    echo "MISSING: $src" >&2
    return 1
  fi
  cp "$src" "$dst"
}

install_textures() {
  local pack_textures="$1"
  local dst_dir="$2"
  if [[ ! -d "$pack_textures" ]]; then
    echo "MISSING textures: $pack_textures" >&2
    return 1
  fi
  mkdir -p "$dst_dir/Textures"
  cp -R "$pack_textures/." "$dst_dir/Textures/"
}

# ---------------------------------------------------------------------------
# Starter Kit City Builder — roads, buildings, nature, pavement.
# Everything in this pack shares a single colormap.png, so we install the
# same Textures/ folder next to every destination folder that holds its
# GLBs. This is the whole visual voice of the city.
# ---------------------------------------------------------------------------
SK_MODELS="$STARTER/models"
SK_TEXTURES="$SK_MODELS/Textures"

# Roads come from the Starter Kit City Builder — lampposts are baked into a
# straight variant (road-straight-lightposts.glb) rather than living as a
# separate prop, so Roads.svelte just picks that variant every Nth straight
# instead of spawning a second GLB. Shares the starter kit colormap.
#
# Tile mapping in assets.ts -> this filename:
#   straight     -> road-straight.glb
#   straightLit  -> road-straight-lightposts.glb
#   corner       -> road-corner.glb
#   split        -> road-intersection.glb   (T-junction — starter-kit name lies)
#   intersection -> road-split.glb          (4-way crossroad — see above)
for name in road-straight road-straight-lightposts road-corner road-intersection road-split; do
  copy "$SK_MODELS/$name.glb" "$DST/roads/"
done
install_textures "$SK_TEXTURES" "$DST/roads"

# Pavement — plain pad and pad-with-fountain centerpiece. The fountain is
# dropped on park centers and large district pads by the world-gen decor
# pass; plain pavement is a placement hint for future variant work.
for name in pavement pavement-fountain; do
  copy "$SK_MODELS/$name.glb" "$DST/pavement/"
done
install_textures "$SK_TEXTURES" "$DST/pavement"

# Buildings — five density tiers driven by the aggregated house-point
# generator (see @gitcolony/core/houseCounts). Each tier picks from a
# distinct pool so the skyline reads as a gradient village → town →
# skyscraper core rather than a uniform suburban sprawl.
#
#   rural     → Starter Kit small cottages + garage (5 variants)
#   floor-1   → City Kit Suburban, shortest half (types a..j)
#   floor-2   → City Kit Suburban, tallest half (types k..u)
#   floor-3   → City Kit Commercial mid-rise offices (types a..n)
#   skyscraper→ City Kit Commercial skyscrapers (types a..e)
#
# Each pack ships its own colormap.png, so they live in sibling
# subdirectories with their own Textures/ folders; assets.ts maps variant
# keys onto the right subdirectory.
mkdir -p "$DST/buildings/rural" "$DST/buildings/floor-1" \
         "$DST/buildings/floor-2" "$DST/buildings/floor-3" \
         "$DST/buildings/skyscraper"

# rural — starter kit ships 4 small cottages + the garage; all share the
# starter-kit colormap.
for name in building-garage building-small-a building-small-b building-small-c building-small-d; do
  copy "$SK_MODELS/$name.glb" "$DST/buildings/rural/"
done
install_textures "$SK_TEXTURES" "$DST/buildings/rural"

# suburban → split into 1-floor (shorter) and 2-floor (taller) halves.
# Both halves share the same City Kit Suburban colormap, so we install
# it into both destination folders.
SUB_SRC="$SRC/City Kit Suburban/Models/GLB format"
for letter in a b c d e f g h i j; do
  copy "$SUB_SRC/building-type-$letter.glb" "$DST/buildings/floor-1/"
done
install_textures "$SUB_SRC/Textures" "$DST/buildings/floor-1"

for letter in k l m n o p q r s t u; do
  copy "$SUB_SRC/building-type-$letter.glb" "$DST/buildings/floor-2/"
done
install_textures "$SUB_SRC/Textures" "$DST/buildings/floor-2"

# commercial mid-rise + skyscrapers, same pack, one shared colormap
# installed into both destinations.
COM_SRC="$SRC/City Kit Commercial 2.1/Models/GLB format"
for letter in a b c d e f g h i j k l m n; do
  copy "$COM_SRC/building-$letter.glb" "$DST/buildings/floor-3/"
done
install_textures "$COM_SRC/Textures" "$DST/buildings/floor-3"

for letter in a b c d e; do
  copy "$COM_SRC/building-skyscraper-$letter.glb" "$DST/buildings/skyscraper/"
done
install_textures "$COM_SRC/Textures" "$DST/buildings/skyscraper"

# Nature — grass pad, grass-with-trees, grass-with-tall-trees. Used both
# by decor placement and park scenery fill.
for name in grass grass-trees grass-trees-tall; do
  copy "$SK_MODELS/$name.glb" "$DST/nature/"
done
install_textures "$SK_TEXTURES" "$DST/nature"

# ---------------------------------------------------------------------------
# Mini Characters — agents. The starter kit ships no characters so we keep
# this one external pack. It has its own colormap.png, different from the
# starter kit's, which is why we install it in the characters/ folder only.
# ---------------------------------------------------------------------------
CHAR_SRC="$SRC/Mini Characters/Models/GLB format"
for sex in female male; do
  for letter in a b c d e f; do
    copy "$CHAR_SRC/character-$sex-$letter.glb" "$DST/characters/"
  done
done
install_textures "$CHAR_SRC/Textures" "$DST/characters"

# ---------------------------------------------------------------------------
# Hexagon Kit — island terrain ring around the city. Kept because the
# starter kit has no terrain hexes. Its own colormap.png (different from
# the starter kit's) lives next to the terrain folder only.
# ---------------------------------------------------------------------------
HEX_SRC="$SRC/Hexagon Kit/Models/GLB format"
for name in grass grass-forest grass-hill dirt sand sand-rocks stone stone-hill stone-mountain water water-rocks water-island; do
  copy "$HEX_SRC/$name.glb" "$DST/terrain/"
done
install_textures "$HEX_SRC/Textures" "$DST/terrain"

echo
echo "Done. Copied models to $DST"
du -sh "$DST"/* 2>/dev/null || true
