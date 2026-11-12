# Render-Paket (`scene.json` + `model.glb`) [211]

Renderer-neutrales Austauschformat für fotorealistische Bilder. Erzeugt von `src/export/blenderRender.ts`
(`buildRenderPackage`), gelesen heute vom Blender-Skript `scripts/blender/render_dossier.py` (Cycles in Blender),
später vom mitgelieferten Cycles-Standalone ([215]). Ein Leser setzt nur um, was hier steht; Dossier-Interna
(Ebenen, Plan) kommen darin nicht vor.

## Ordner

| Datei | Inhalt |
|---|---|
| `model.glb` | glTF 2.0 binär (Export [201]): Geometrie, Normalen, PBR-Materialien (Basisfarbe linear, Rauheit, Metall, Alpha-Blend für Glas). **Keine UVs**, keine Texturen. |
| `scene.json` | Beschreibung unten. Alle Pfade relativ zur JSON-Datei. |
| `textures/*` | Bildkarten (JPG/PNG), nur wo das Bauteil-Material (`Component.material`) welche hat. |

Achsen: Modell-Koordinaten, Meter, x Ost, y Nord, z oben. Das GLB ist Y-oben (x, z, −y); glTF-Importer drehen es
nach z-oben zurück, `scene.json` braucht keine Umrechnung.

## `scene.json` (Typ `RenderScene`, Version 1)

- `model`, `output`: Dateinamen (`model.glb`, `render.png`).
- `resolution {width, height}` in Pixeln; `samples` je Pixel; `denoise` (bool); `device` `"auto"` oder `"cpu"`.
- `camera`: entweder `{preset}` (`iso`, `perspective`, `front`, `back`, `left`, `right`, `side`, `top`; der Leser
  rahmt das Gebäude ein, ohne Gelände/Kontext) oder explizit `{kind: "perspective"|"orthogonal", position[3],
  direction[3] (normiert), up[3], fovDeg (vertikal), orthoHeight (volle Sichthöhe, m)}`.
- `sun {azimuth, elevation, when, lat, lon}`: Grad, Azimut von Norden im Uhrzeigersinn (Ost = 90), Höhe über
  dem Horizont. Himmel: physikalischer Tageshimmel mit Sonnenscheibe an dieser Richtung; unter dem Horizont wird
  mit 1° gerendert. Optional `sun.intensity` und `exposure` (Leser-Voreinstellungen), `ground` (bool, Bodenplatte).
- `materials[]`, Schlüssel = glTF-Materialname:
  `color [r,g,b]` sRGB 0..1, `opacity`, `roughness`, `metallic`, `glass` (bool), `transmission` 0..1, `ior`,
  `textures {color, normal, roughness, metalness}` (Pfade), `sizeM` (Kantenlänge einer Kachel in m).

## Texturen ohne UVs

Der Leser projiziert Texturen als Box (je Achse, weiche Übergänge) aus Objektkoordinaten, skaliert mit `1 / sizeM`.
Farbkarte sRGB, Rauheit/Metall/Normal linear (Non-Color), Normalen im OpenGL-Stil (ambientCG).

## Glas

`glass: true`: Alpha ignorieren, Transmission und IOR setzen, Rauheit klein, Basisfarbe nur leicht getönt.

## Leser

Blender: `blender -b --python scripts/blender/render_dossier.py -- scene.json`. Meldungen auf stdout:
`DOSSIER_STAGE`, `DOSSIER_DONE <png>`, `DOSSIER_ERROR <text>`, dazu Cycles' `Sample x/y` (Fortschritt).
Ein anderer Leser sollte dieselben Marken ausgeben, dann bleibt die App-Seite unverändert.
