# src-tauri/render2d/src

Die 2D-Anzeige-Engine für Pläne und Blätter (wgpu, Shader in WGSL). Zweischichtig: ohne Features nur die
GPU-freien Schichten (Szene, Tessellierung, Mathematik; headless mit `cargo test` prüfbar), mit Feature `render`
die wgpu-Pipelines, mit `web` die Browser-Bindung, mit `headless` ein Offscreen-Pfad. Die Szene schreibt der Kern
(`src-tauri/core/src/plan/scene.rs`); TS-Seite: `src/views/plan`, `src/plan/toRenderScene.ts`.
Zusammenspiel: `doc/ARCHITEKTUR.md`, Abschnitt 3.4.

## GPU-frei

| Datei | Inhalt |
|---|---|
| `lib.rs` | Modulliste und Beschreibung der Schichten |
| `types.rs` | Eingabe-Typen: Primitive, Szene, Ausschnitt |
| `scene_bin.rs` | Binärformat der Plan-Szene (little-endian), das der Kern schreibt und render2d liest |
| `tessellate.rs` | Polygone (Ear-Clipping) und Linien (Quads) zu Vertex- und Index-Puffern |
| `ortho.rs` | aspekt-treue Ortho-Matrix und Strichbreite in Papier-mm |
| `shaders.rs` | WGSL-Quellen für Füllung und Linie |
| `demo.rs` | gemeinsame Demo-Szene der Spikes |

## Mit Feature `render`

| Datei | Inhalt |
|---|---|
| `gpu.rs` | wgpu-Pipelines (Füllung, Linie) und der `Renderer` |
| `vtext.rs` | Vektor-Text: Glyphen-Umrisse einmal tesselliert und instanziert gezeichnet, auch gedreht |
| `chunks.rs` | Chunk-Renderer des nativen macOS-Wegs: zeichnet die in der Webansicht fertig tessellierten GPU-Chunks |

## Ziele

| Datei | Inhalt |
|---|---|
| `web.rs` | Browser-Bindung (Feature `web`): `WebPlanRenderer` mit Canvas als wgpu-Surface; `set_scene_bin()`, Ausschnitt, Massstab, `render()` |
| `headless.rs` | Offscreen-Renderpfad ohne Fenster (Feature `headless`) |
| `bin/spike.rs` | winit-Fenster zur visuellen Prüfung (Feature `window`) |
| `bin/render_png.rs` | rendert die Demo-Szene headless in eine PNG-Datei |
