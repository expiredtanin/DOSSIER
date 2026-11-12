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
| `scene.rs` | Szene aus benannten Teilen: ein Teil-Update baut nur die betroffenen Teile neu |
| `ghost.rs` | `[180]` Geisterschicht: Elemente grauer Klassen hell, entsättigt und durchscheinend; eigene Szene aus Teilen, je Klumpen umgesetzt (`set_ghost_parts`, `[214]`) |
| `mesh.rs` | extrudiert Wände und Platten zu Dreiecksnetzen, hängt Kontext-Meshes an |
| `openings.rs` | Rechteck-Zerlegung von Wänden an Öffnungen |
| `math.rs` | 4x4-Matrizen, Kamera (Perspektive und Orthografie, Presets), Orbit |
| `edges.rs`, `grid.rs` | Modell-Kanten für Drahtgitter und verdeckte Kanten; Bodenraster |
| `shadow.rs` | Sonnenrichtung und Licht-Matrix für Schatten |

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
| `gpu.rs` | wgpu-Pipelines und der `Renderer`: Puffer je Klumpen (texturiert nur die Material-Ebene, UV im Shader), unveränderte Linien/Hülle nicht neu hochgeladen (Inhalts-Schlüssel), Zahlen je Bild (`frame_stats`, `gpu_bytes`) — `[214]`; `gpu_points.rs`: Pipeline der Punktwolken im selben Pass |
| `web.rs` | Browser-Bindung (Feature `web`): `set_parts()`, Kamera, Stil, Schnitt, Sonne, Punktwolken |
| `bin/render_png.rs` | Headless-Bild in eine PNG-Datei (`npm run build:render-png`); siehe `CLAUDE.md`, „Ergebnis ansehen"; `--bench <ordner>` misst die Engine (`bin/bench3d/`, Eingaben aus `src/viewport/render3d.bench.test.ts`, `[214]`) |
| `bin/spike3d.rs` | winit-Fenster mit Orbit-Kamera zur visuellen Prüfung (Feature `window`) |
