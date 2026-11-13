# src-tauri/render3d

Die 3D-Anzeige-Engine (Rust → WASM/WebGPU und Metal). Zweischichtig wie render2d: eine GPU-freie Schicht (Szene,
Netze, Mathematik; `cargo test` ohne Features) und darüber die wgpu-Pipelines (Feature `render`); Browser-Bindung
mit Feature `web`. Zusammenspiel und Weg eines Modells: `doc/ARCHITEKTUR.md`, Abschnitte 6 und 7.

| Datei | Inhalt |
|---|---|
| `scene.rs`, `mesh.rs`, `types.rs`, `math.rs` | Szene aus Teilen, Netze (auch UV, Gelände-Ebene), Typen, Mathematik |
| `gpu.rs`, `shaders.rs`, `grid.rs`, `ghost.rs`, `edges.rs`, `pattern_lines.rs` | Raster-Pipelines (WGSL), Kanten, Geisterschicht, Spuren/Muster |
| `shadow.rs` | Sonnenschatten: zwei Kaskaden, Matrizen |
| `section.rs`, `section_fill.rs`, `section_boolean.rs`, `roof_cut.rs`, `openings.rs` | Schnitt: analytischer Prismen-Schnitt (auch vom Kern genutzt), Live-Schnitt |
| `points.rs`, `gpu_points.rs` | Punktwolken |
| `web.rs` | Browser-Bindung (`set_sun()`, `set_night()` u. a.) |
| `bin/render_png.rs` | Headless-Bilder (nur macOS Metal bzw. lavapipe), `--style pathtrace --samples N` |

## GPU-Pathtracer ([212], Darstellungsart „Pathtracing (Vorschau)“)

| Datei | Inhalt |
|---|---|
| `pathtrace.rs` | GPU-freie Seite: `Sky` (Himmel, Sonne, `exposure`, `room_light`), `sky_for_sun`, `night_sky`, Parameter-Block, WGSL-Quellen (`PT_WGSL`, `PT_DISPLAY_WGSL`) |
| `gpu_pathtrace.rs` | wgpu-Compute: Akkumulation über Bilder, Neustart bei Kamera/Modell/Sonne/Grösse, Entrauscher-Durchläufe |
| `bvh.rs` | Binned-SAH-Baum der Dreiecke auf der CPU, flache Arrays |
| `denoise.rs` | Entrauscher (À-trous/SVGF) |
| `pt_material.rs` | Materialtabelle je Baustoff (Rauigkeit, Metall, Glas, Leuchte) aus `pathtraceMaterials` |
| `pt_texture.rs` | Bildkarten: Farb-, Normalen- und Rauigkeitskarten, Mip-Stufen, UV je Dreieck |
| `pt_lights.rs` | Lichtliste für Next-Event-Estimation: Fensterscheiben als Lichtportale des Himmels (nur mit Kamera drinnen), Leuchten, Raumlicht an den Deckenuntersichten bei Nacht; Auswahl in Gruppen |
| `exposure.rs` | Belichtungsautomatik (Histogramm der Bildhelligkeit, sanft nachgeführt) als Compute-Pass, CPU-Referenz für Tests |

Die Grundwerte (`Sky.exposure`, `Sky.room_light`) stehen in `pathtrace.rs`; Regler, „Auto“ und „Raumlicht“ im Viewport ([212] Etappe 5).
