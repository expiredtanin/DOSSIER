# src-tauri/render3d/src

Die 3D-Anzeige-Engine (wgpu, Shader in WGSL). Wie render2d zweischichtig: ohne Features nur GPU-freie Schichten
(Szene, Netze, Mathematik; headless mit `cargo test` prüfbar), mit Feature `render` die Pipelines, mit `web` die
Browser-Bindung. Das 3D-Modell kommt als Teile aus dem Kern (`src-tauri/core/src/model3d/`); TS-Seite:
`src/viewport`. Zusammenspiel: `doc/ARCHITEKTUR.md`, Abschnitt 6.

## Szene und Netze

| Datei | Inhalt |
|---|---|
| `lib.rs` | Modulliste und Beschreibung der Schichten |
| `types.rs` | Eingabe-Typen (Wände, Platten, Meshes, Kamera) und das `Mesh` |
| `scene.rs` | Szene aus benannten Teilen: ein Teil-Update baut nur die betroffenen Teile neu; Kanten-Index mit schnellem Hasher (`edges::KeyHasher`), Beiträge je Teil gruppiert eingetragen (`[214]`) |
| `ghost.rs` | `[180]` Geisterschicht: Elemente grauer Klassen hell, entsättigt und durchscheinend; eigene Szene aus Teilen, je Klumpen umgesetzt (`set_ghost_parts`, `[214]`) |
| `mesh.rs` | extrudiert Wände und Platten zu Dreiecksnetzen, hängt Kontext-Meshes an |
| `openings.rs` | Rechteck-Zerlegung von Wänden an Öffnungen |
| `math.rs` | 4x4-Matrizen, Kamera (Perspektive und Orthografie, Presets), Orbit |
| `edges.rs`, `grid.rs` | Modell-Kanten für Drahtgitter und verdeckte Kanten; Bodenraster |
| `shadow.rs` | Sonnenrichtung und Licht-Matrix für Schatten |
| `bvh.rs` | `[212]` Hüllkörper-Baum (Binned-SAH) aus den Szenen-Dreiecken als flache GPU-Arrays; Material je Dreieck aus Tabelle und Vertexfarbe aufgelöst (Art, Farbe, Rauigkeit, Metall) |
| `pt_material.rs` | `[212]` Materialtabelle des Pathtracers: Material-Ebene der Szene (`materialIndex`) → Look nach Baustoffname/Bildkarte (wie der Blender-Leser [211]), mittlere Bildkarten-Farbe; Glas und Stahl aus der Vertexfarbe |
| `pathtrace.rs` | `[212]` Pathtracer ohne GPU: Parameter-Block, Himmel/Sonne aus dem Sonnenstand, Nachthimmel, Kamera-Basis, WGSL (Pfadverfolgung mit Hilfspuffern für den Entrauscher, Glas mit fester Fresnel-Spiegelung, Anzeige mit Entrauscher-Mischung und ACES) |
| `denoise.rs` | `[212]` Entrauscher: À-trous nach SVGF ohne Zeit-Reprojektion (Albedo demoduliert, Gewichte aus Normale/Tiefe/Luminanz-Varianz), Referenz auf der CPU (Tests) und WGSL; Mischgewicht nach Sample-Zahl |

## Schnitt

| Datei | Inhalt |
|---|---|
| `section.rs` | analytischer Schnitt und Ansicht für Prismen-Modelle (auch vom Kern genutzt) |
| `roof_cut.rs` | Schnitt einer geneigten Dachschicht mit einer senkrechten Ebene |
| `section_fill.rs` | Schnittflächen als Dreiecke für den Live-Schnitt |
| `section_boolean.rs` | Verdeckung der Schnittflächen, dieselbe Rechnung wie im 2D-Schnitt |

## Punktwolken und Muster

| Datei | Inhalt |
|---|---|
| `points.rs` | Punktwolken (`[27]`): Puffer, Farbabbildung, WGSL-Quelle |
| `pattern_lines.rs` | Ansichtsschraffur auf Flächen (`[100]`), Stufe nach Bildschirm-Massstab |

## Mit Feature `render` und Ziele

| Datei | Inhalt |
|---|---|
| `shaders.rs` | WGSL-Quellen (Fläche, texturiert, Luftbild, Raster, Schnittfläche, Geist, Schatten) |
| `gpu_pathtrace.rs` | `[212]` Pathtracer auf der GPU: Compute-Pipeline, Akkumulation und Hilfspuffer über Bilder (Neustart bei Kamera/Modell/Sonne/Nacht), Entrauscher-Pässe (prep + 5 × À-trous), Anzeige; vom `Renderer` im Stil `Pathtrace` erst bei Bedarf angelegt |
| `gpu.rs` | wgpu-Pipelines und der `Renderer`: Puffer je Klumpen (texturiert nur die Material-Ebene, UV im Shader), unveränderte Linien/Hülle nicht neu hochgeladen (Inhalts-Schlüssel), Zahlen je Bild (`frame_stats`, `gpu_bytes`) — `[214]`; `gpu_points.rs`: Pipeline der Punktwolken im selben Pass |
| `web.rs` | Browser-Bindung (Feature `web`): `set_parts()`, Kamera, Stil, Schnitt, Sonne, Punktwolken |
| `bin/render_png.rs` | Headless-Bild in eine PNG-Datei (`npm run build:render-png`); siehe `CLAUDE.md`, „Ergebnis ansehen"; `--style pathtrace --samples N [--denoise off] [--pt-goal 1024]` rechnet mit dem Pathtracer (`[212]`) und meldet Samples/s; `--bench <ordner>` misst die Engine (`bin/bench3d/`, Eingaben aus `src/viewport/render3d.bench.test.ts`, `[214]`) |
| `bin/spike3d.rs` | winit-Fenster mit Orbit-Kamera zur visuellen Prüfung (Feature `window`) |
