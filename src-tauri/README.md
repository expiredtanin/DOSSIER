# src-tauri

Alles in Rust: die Tauri-App selbst und mehrere eigenständige Crates. Jedes Crate hat einen eigenen
`[workspace]`-Block oder ist im Workspace der App ausgeschlossen; es baut und testet für sich
(`cargo test` im Crate-Ordner). Die WASM-Pakete entstehen über die `build:*`-Skripte in `package.json`.
Zusammenspiel: `doc/ARCHITEKTUR.md`.

| Ordner | Crate | Inhalt | WASM |
|---|---|---|---|
| `core/` | `dossier-core` | der Kern: Dokument, Ops, Verlauf, Projektformat, Plan, Schnitt, Ansicht, 3D, Export-Sammler, Befehle; siehe `core/src/README.md` | `npm run build:core` → `src/engine/pkgCore` |
| `kernel2d/` | `kernel2d` | 2D-Geometrie: Offset, Trim, Extend, Fillet, Fase, Split, Join, Schnittpunkte (`src/lib.rs`), Bögen (`src/bulge.rs`) | im Kern eingebunden |
| `hatchgen/` | `dossier-hatch` | Schraffur- und Linienmuster (`hatch.rs`), Schnitt-Dominanz (`section_dominance.rs`), JS-Zahlsemantik (`jsnum.rs`, `jsmath.rs`) | im Kern und in render3d eingebunden |
| `render2d/` | `render2d` | Plan-Renderer: Szene lesen (`scene_bin.rs`), Tessellierung (`tessellate.rs`), wgpu (`gpu.rs`, Feature `render`), GPU-Chunks des nativen Wegs (`chunks.rs`), Browser-Bindung (`web.rs`) | `npm run build:engine` → `src/engine/pkg` |
| `render3d/` | `render3d` | 3D-Renderer: Szene aus Teilen (`scene.rs`), Netze (`mesh.rs`), Kanten (`edges.rs`), Schatten (`shadow.rs`), Live-Schnitt (`section_fill.rs`, `section_boolean.rs`), Punktwolken, wgpu (`gpu.rs`), Browser-Bindung (`web.rs`); analytischer Prismen-Schnitt (`section.rs`, auch vom Kern genutzt); Headless-Bilder `src/bin/render_png.rs` | `npm run build:engine3d` → `src/engine/pkg3d` |
| `fileio/` | `dossier-fileio` | Dateiformate: DXF/DWG lesen und schreiben (acadrust: `import.rs`, `export.rs`), IFC lesen (`ifc_import.rs`, `ifc_semantic.rs`) und schreiben (`ifc_export.rs`), Vektor-PDF (`pdf_*.rs`), Meshes, Punktwolken, Tabellen, BCF | `npm run build:fileio` → `src/engine/pkgFileIo` |
| `trucksolid/` | `trucksolid` | B-Rep über truck: Körper, Booleans, STEP, Kennwerte, Kollision; eigenes Modul zur Panic-Isolation | `npm run build:truck` → `src/engine/pkgTruck` |
| `src/` | `cad-tauri` | Tauri-App: Befehle und Start (`lib.rs`), atomares Speichern (`atomic_save.rs`), Dateisperre (`lock.rs`), native Metal-Fläche unter der Webansicht auf macOS (`native_embed.rs`), native Fenster auf Linux (`native.rs`) | keines |

Weitere Dateien: `tauri.conf.json` (App-Konfiguration), `capabilities/` (Tauri-Rechte), `deny.toml`
(Lizenzprüfung mit `cargo deny`), `icons/`.

## Schichten in den Renderern

render2d und render3d sind zweischichtig: eine GPU-freie Schicht (Szene, Tessellierung, Mathematik; ohne
Features, headless mit `cargo test` prüfbar) und darüber die wgpu-Pipelines (Feature `render`). Die
Browser-Bindung kommt mit Feature `web`. Shader sind WGSL (`shaders.rs`).

## Tests

`npm run check` führt `cargo test` in `core`, `render2d`, `render3d`, `kernel2d`, `trucksolid`, `fileio`
und `hatchgen` aus (`scripts/check.mjs`). Die Tauri-App (`src/`) gehört nicht dazu; sie braucht die
Tauri-Voraussetzungen und baut im Linux-Container meist nicht (fehlende GTK-Bibliotheken).
