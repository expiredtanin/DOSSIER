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
- `backfilled` (bool, nur Hinweis): das Gelände im `model.glb` ist das gewachsene, ohne Baugruben (hinterfüllt, bis an die Fassade geschlossen);
  false = mit Aushub wie im 3D. Der Leser setzt dazu nichts um, die Geometrie steckt im GLB.
- `camera`: entweder `{preset}` (`iso`, `perspective`, `front`, `back`, `left`, `right`, `side`, `top`; der Leser
  rahmt das Gebäude ein, ohne Gelände/Kontext) oder explizit `{kind: "perspective"|"orthogonal", position[3],
  direction[3] (normiert), up[3], fovDeg (vertikal), orthoHeight (volle Sichthöhe, m)}`.
- `sun {azimuth, elevation, when, lat, lon}`: Grad, Azimut von Norden im Uhrzeigersinn (Ost = 90), Höhe über
  dem Horizont. Himmel: physikalischer Tageshimmel mit Sonnenscheibe an dieser Richtung; unter dem Horizont wird
  mit 1° gerendert. Optional `sun.intensity` (Standard 1.0) und `exposure` (EV; fehlt sie, belichtet der Leser automatisch
  nach Sonnenhöhe, s. u.), `ground` (bool, Bodenplatte).
- `materials[]`, Schlüssel = glTF-Materialname:
  `color [r,g,b]` sRGB 0..1, `opacity`, `roughness`, `metallic`, `glass` (bool), `transmission` 0..1, `ior`,
  `textures {color, normal, roughness, metalness}` (Pfade), `sizeM` (Kantenlänge einer Kachel in m),
  `role` (`terrain` | `roof` | `context` | `opening` | `building`: Verwendung nach dem Bauteil-Knoten des GLB) und
  `component` (Baustoff, wenn er vom Materialnamen abweicht). Gleiche Namen mit verschiedener Farbe ordnet der Leser
  über die Farbe zu.

## Material je Bauteil

Der glTF-Materialname ist der Baustoff-Name (`Component.name`); dessen `material` liefert die Bildkarten. Ausnahmen:
- **Dach:** der Kern legt alle Dachschichten als „Dach“ ab. `splitRoofMaterials` ordnet jedem Teilnetz die Schicht des Dachtyps
  zu (Farbe des Baustoffs, Rückfall die äusserste Schicht) und benennt das Material `Dach: <Baustoff>` (`component` = Baustoff,
  damit dessen Bildkarten/Ersatzlook gelten). Hat das Dach eine eigene Farbe (`Roof.color`), bleibt es bei „Dach“.
- **Gelände:** hat im Modell kein Material; bekommt die Wiese `Grass005` der Bibliothek (Kachel 4 m). Ohne Bildkarte setzt der
  Leser ein Wiesengrün. **Kontext** (importierte Körper): neutral hellgrau.

## Bildwirkung (Leser)

Cycles-Standard statt Augenmass: Nishita-Himmel mit Sonnenstärke 1.0 (absolut, weisse besonnte Fläche ≈ 45 bei 60°), automatische
Belichtung nach Sonnenhöhe (besonnte weisse Fläche → 1.5; ≈ −4.9 EV bei 60°), AgX, Albedo höchstens 0.8, Wiese/Ziegel/Blech nach
Rolle und Baustoffname, Glas mit Transmission (für Schattenstrahlen durchsichtig), leichte Umgebungsverdeckung. Werte im Kopf von
`render_dossier.py`.

## Kamera

`camera` = Voreinstellung oder explizit. Der Dialog bietet „Aktuelle 3D-Ansicht“ und jede gespeicherte Kamera (`Project.cameras`,
[213]); deren Sonnenzeit (`sunWhen`) füllt die Zeit vor (änderbar). CLI: `--camera <Name|id>`; `--when` übersteuert die Zeit.

## Texturen ohne UVs

Der Leser projiziert Texturen als Box (je Achse, weiche Übergänge) aus Objektkoordinaten, skaliert mit `1 / sizeM`.
Farbkarte sRGB, Rauheit/Metall/Normal linear (Non-Color), Normalen im OpenGL-Stil (ambientCG).

## Glas

`glass: true`: Alpha ignorieren, Transmission und IOR setzen, Rauheit klein, Basisfarbe nur leicht getönt.

## Leser

Blender: `blender -b --python scripts/blender/render_dossier.py -- scene.json`. Meldungen auf stdout:
`DOSSIER_STAGE`, `DOSSIER_DONE <png>`, `DOSSIER_ERROR <text>`, dazu Cycles' `Sample x/y` (Fortschritt).
Ein anderer Leser sollte dieselben Marken ausgeben, dann bleibt die App-Seite unverändert.
