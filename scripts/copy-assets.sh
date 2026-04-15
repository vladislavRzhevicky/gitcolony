#!/usr/bin/env bash
#
# Selectively copy GLB models from the Kenney packs in ./textures/ into
# apps/web/static/models/ so SvelteKit serves them as static assets.
#
# Kenney City/Graveyard/Fantasy/Car/Cube/BlockyCharacters GLBs reference an
# external 'Textures/<name>.png' *relative to the GLB file*. Every target
# directory that holds GLBs from a given pack therefore needs a sibling
# Textures/ folder with that pack's texture atlas. Each pack ships its own
# atlas (same filename, different contents) — so directories that mix packs
# must be split, or one pack's GLBs will pick up another pack's palette.
#
# Nature Kit is self-contained: textures are embedded in the .glb, no
# sibling Textures/ folder needed.
#
# Idempotent: safe to re-run.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/textures"
DST="$ROOT/apps/web/static/models"

rm -rf "$DST"
mkdir -p "$DST"/{buildings/{suburban,commercial,industrial,low-detail},roads,nature,characters,pets,cars,props/{car,graveyard,fantasy},terrain}

copy() {
  local src="$1"
  local dst="$2"
  if [[ ! -f "$src" ]]; then
    echo "MISSING: $src" >&2
    return 1
  fi
  cp "$src" "$dst"
}

# Copy the 'Textures' subfolder from a Kenney pack next to a destination
# folder, so embedded GLTF texture references resolve.
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
# Buildings — four pools, picked by semanticType in the registry.
# ---------------------------------------------------------------------------
SUB_SRC="$SRC/City Kit Suburban/Models/GLB format"
for letter in a b c d e f g h i j k l m n o p q r s; do
  copy "$SUB_SRC/building-type-$letter.glb" "$DST/buildings/suburban/"
done
install_textures "$SUB_SRC/Textures" "$DST/buildings/suburban"

COM_SRC="$SRC/City Kit Commercial 2.1/Models/GLB format"
for letter in a b c d e f g h i j k l m n; do
  copy "$COM_SRC/building-$letter.glb" "$DST/buildings/commercial/"
done
for letter in a b c d e; do
  copy "$COM_SRC/building-skyscraper-$letter.glb" "$DST/buildings/commercial/"
done
install_textures "$COM_SRC/Textures" "$DST/buildings/commercial"

# low-detail buildings live in the Commercial pack too, so they share the
# same colormap — but we keep them in their own folder for path clarity.
for letter in a b c d e f g h i j k l m n; do
  copy "$COM_SRC/low-detail-building-$letter.glb" "$DST/buildings/low-detail/"
done
install_textures "$COM_SRC/Textures" "$DST/buildings/low-detail"

IND_SRC="$SRC/City Kit Industrial 1.0/Models/GLB format"
for letter in a b c d e f g h i j k l m n o p q r s t; do
  copy "$IND_SRC/building-$letter.glb" "$DST/buildings/industrial/"
done
install_textures "$IND_SRC/Textures" "$DST/buildings/industrial"

# ---------------------------------------------------------------------------
# Road tiles + street lights — all from City Kit Roads, one colormap.
# ---------------------------------------------------------------------------
ROAD_SRC="$SRC/City Kit Roads/Models/GLB format"
for name in road-straight road-bend road-crossroad road-intersection road-end road-square light-square light-curved; do
  copy "$ROAD_SRC/$name.glb" "$DST/roads/"
done
install_textures "$ROAD_SRC/Textures" "$DST/roads"

# ---------------------------------------------------------------------------
# Nature — textures are embedded in the .glb, nothing else to copy.
# ---------------------------------------------------------------------------
NATURE_SRC="$SRC/Nature Kit/Models/GLTF format"
for name in \
  tree_oak tree_default tree_detailed tree_fat \
  tree_pineDefaultA tree_pineDefaultB tree_pineRoundA tree_pineRoundC \
  tree_pineSmallA tree_pineSmallB \
  grass grass_large grass_leafs grass_leafsLarge \
  flower_purpleA flower_redA flower_yellowA \
  cliff_block_rock cliff_rock; do
  copy "$NATURE_SRC/$name.glb" "$DST/nature/"
done

# ---------------------------------------------------------------------------
# Characters — Mini Characters pack, male + female a..f. One shared
# colormap.png for the whole pack, so a single install_textures is enough.
# ---------------------------------------------------------------------------
CHAR_SRC="$SRC/Mini Characters/Models/GLB format"
for sex in female male; do
  for letter in a b c d e f; do
    copy "$CHAR_SRC/character-$sex-$letter.glb" "$DST/characters/"
  done
done
install_textures "$CHAR_SRC/Textures" "$DST/characters"

# ---------------------------------------------------------------------------
# Pets — Cube Pets shortlist.
# ---------------------------------------------------------------------------
PET_SRC="$SRC/Cube Pets 1.0/Models/GLB format"
for name in bunny cat dog deer fox bee chick parrot; do
  copy "$PET_SRC/animal-$name.glb" "$DST/pets/"
done
install_textures "$PET_SRC/Textures" "$DST/pets"

# ---------------------------------------------------------------------------
# Cars — shortlist from Car Kit.
# ---------------------------------------------------------------------------
CAR_SRC="$SRC/Car Kit/Models/GLB format"
for name in sedan taxi hatchback-sports van suv delivery; do
  copy "$CAR_SRC/$name.glb" "$DST/cars/"
done
install_textures "$CAR_SRC/Textures" "$DST/cars"

# ---------------------------------------------------------------------------
# Props — split by pack because each pack ships its own colormap.
# ---------------------------------------------------------------------------
copy "$CAR_SRC/box.glb"  "$DST/props/car/"
copy "$CAR_SRC/cone.glb" "$DST/props/car/"
install_textures "$CAR_SRC/Textures" "$DST/props/car"

GRAVE_SRC="$SRC/Graveyard Kit 5.0/Models/GLB format"
copy "$GRAVE_SRC/lightpost-single.glb" "$DST/props/graveyard/"
install_textures "$GRAVE_SRC/Textures" "$DST/props/graveyard"

# ---------------------------------------------------------------------------
# Terrain — Hexagon Kit. Used by Island.svelte to build the island surround
# around the square city grid (grass / hills / forest / sand / water). One
# shared colormap.png for the whole pack.
# ---------------------------------------------------------------------------
HEX_SRC="$SRC/Hexagon Kit/Models/GLB format"
for name in grass grass-forest grass-hill dirt sand sand-rocks stone stone-hill stone-mountain water water-rocks water-island; do
  copy "$HEX_SRC/$name.glb" "$DST/terrain/"
done
install_textures "$HEX_SRC/Textures" "$DST/terrain"

FAN_SRC="$SRC/Fantasy Town Kit 2.0/Models/GLB format"
copy "$FAN_SRC/fountain-round.glb" "$DST/props/fantasy/"
copy "$FAN_SRC/lantern.glb"        "$DST/props/fantasy/"
install_textures "$FAN_SRC/Textures" "$DST/props/fantasy"

echo
echo "Done. Copied models to $DST"
du -sh "$DST"/* 2>/dev/null || true
