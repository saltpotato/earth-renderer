#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEX_DIR="$SCRIPT_DIR/textures"
mkdir -p "$TEX_DIR"

echo "Lade 8K Satellitentexturen (Solar System Scope, CC BY 4.0) nach $TEX_DIR ..."

download_tex() {
  local name="$1"
  local url="$2"
  echo "  -> $name"
  curl -fL --progress-bar "$url" -o "$TEX_DIR/$name"
}

download_tex "8k_earth_daymap.jpg"   "https://www.solarsystemscope.com/textures/download/8k_earth_daymap.jpg"
download_tex "8k_earth_nightmap.jpg" "https://www.solarsystemscope.com/textures/download/8k_earth_nightmap.jpg"
download_tex "8k_earth_clouds.jpg"   "https://www.solarsystemscope.com/textures/download/8k_earth_clouds.jpg"
download_tex "8k_moon.jpg"           "https://www.solarsystemscope.com/textures/download/8k_moon.jpg"

cat > "$TEX_DIR/local_manifest.json" <<'EOF'
{
  "useLocal8k": true,
  "day": "./textures/8k_earth_daymap.jpg",
  "night": "./textures/8k_earth_nightmap.jpg",
  "clouds": "./textures/8k_earth_clouds.jpg",
  "moon": "./textures/8k_moon.jpg"
}
EOF

echo ""
echo "Fertig! 8K-Texturen sind aktiviert. Lade http://localhost:8765 im Browser neu."
