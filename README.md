# TERRA — Physically-Based Earth Raytracer

Ein physikalisch basierter WebGL2-Raytracer für fotorealistische Erde-aus-dem-Weltall-Renders mit interaktiver Vorschau, progressivem Offline-Raytracing (bis 4K UHD & 192 SPP) und 4K-Videosequenz-Export.

## Features
- **Physikalische Atmosphäre (Rayleigh + Mie + Ozon)**: Zweistufiges volumetrisches Raymarching für blauen Horizont-Limb, Luftperspektive über Kontinenten und rötliche Dämmerungs-Terminatoren.
- **4K / 8K Satellitentexturen**: Realistische Landmassen, Gebirgsrelief (Normal-Perturbation), Ozean-Sonnenglanz (GGX Microfacet BRDF) und Nachtlichter (Städte).
- **3D-Wolkenschicht mit echten Raytraced-Wolkenschatten**: Schwebende Wolkenschale mit Schattenwurf auf Land/Ozean, Self-Shadowing und Silver-Lining.
- **Raytraced Mond im Hintergrund**: Realistische Mondtextur mit Krater-Relief, Lommel-Seeliger-Regolith-Shading, Mondphasen, Earthshine und Erdschatten (Mondfinsternis).
- **Volumetrische Polarlichter (Aurora Borealis & Australis)**: 3D-raygemarchte Polarlicht-Vorhänge rund um die magnetischen Pole mit animiertem Drift und Grün-zu-Violett-Spektrum.
- **Offline Raytrace-Standbild & 4K-Videosequenzen**:
  - Standbilder bis **3840×2160 (4K)** und **192 SPP** als PNG.
  - Animierte Videosequenzen (*Sonnenaufgang*, *Orbit-Vorbeiflug*, *ISS-Horizontflug*, *Erdrotation + Mond*) Frame-für-Frame raytraced bis **4K** als MP4/WebM.

## Starten
```bash
cd ~/dev/earth-renderer
python3 -m http.server 8765
```
Anschließend im Browser öffnen: `http://localhost:8765`

## Lokale 8K-Texturen herunterladen (optional)
```bash
cd ~/dev/earth-renderer
./download_8k_textures.sh
```
Das Skript lädt die kostenlosen 8K-Texturen (Erde Tag, Nacht, Wolken, Mond; CC BY 4.0 von Solar System Scope) nach `./textures/` und aktiviert sie automatisch.

## Steuerung
- **Ziehen**: Kamera um die Erde drehen
- **Scrollen**: Zoom (vom ISS-Orbit bis zur Vollansicht)
- **Shift + Ziehen**: Sonnenposition drehen
- **R**: Raytrace-Render starten
- **Esc**: Zurück zur Live-Vorschau
