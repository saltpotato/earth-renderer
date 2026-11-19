# TERRA — Physically-Based Earth Raytracer

Ein physikalisch basierter WebGL2-Raytracer für fotorealistische Erde-aus-dem-Weltall-Renders mit interaktiver Vorschau und progressivem Offline-Raytracing-Modus (bis 4K UHD & 192 SPP).

## Features
- **Physikalische Atmosphäre (Rayleigh + Mie + Ozon)**: Zweistufiges volumetrisches Raymarching für blauen Horizont-Limb, Luftperspektive über Kontinenten und rötliche Dämmerungs-Terminatoren.
- **4K NASA Blue Marble Satellitentexturen**: Realistische Landmassen, Gebirgsrelief (Normal-Perturbation), Ozean-Sonnenglanz (GGX Microfacet BRDF) und Nachtlichter (Städte).
- **3D-Wolkenschicht mit echten Raytraced-Wolkenschatten**: Schwebende Wolkenschale mit Schattenwurf auf Land/Ozean, Self-Shadowing und Silver-Lining.
- **Tiefraum-Hintergrund**: Prozedurales Sternenfeld mit realistischen Spektralfarben, Milchstraßen-Band und Sonnenkorona.
- **Offline Raytrace-Renderknopf**: Progressiver HDR-Akkumulations-Renderer (Full HD / QHD / 4K, bis 192 Samples pro Pixel mit Subpixel-Antialiasing, weicher Sonnenscheibe, ACES Filmic Tonemapping und PNG-Export).
- **Eigene 8K/16K Texturen**: Über das Panel lassen sich jederzeit eigene Equirectangular-Texturen (z. B. 8K-Maps von NASA Visible Earth / Solar System Scope) laden.

## Starten
```bash
cd ~/dev/earth-renderer
python3 -m http.server 8765
```
Anschließend im Browser öffnen: `http://localhost:8765`

## Steuerung
- **Ziehen**: Kamera um die Erde drehen
- **Scrollen**: Zoom (vom ISS-Orbit bis zur Vollansicht)
- **Shift + Ziehen**: Sonnenposition drehen
- **R**: Raytrace-Render starten
- **Esc**: Zurück zur Live-Vorschau
