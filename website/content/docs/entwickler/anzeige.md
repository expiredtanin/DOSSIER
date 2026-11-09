---
title: "Anzeige und Geometrie"
linkTitle: "Anzeige und Geometrie"
weight: 3
---

## Zwei Engines, kein three.js

Die Datenflüsse im Einzelnen (Plan-Puffer, Ausgabewege, 3D-Teile, Schatten, IFC) beschreibt
[`doc/ARCHITEKTUR.md`](https://github.com/expiredtanin/DOSSIER/blob/master/doc/ARCHITEKTUR.md); dieser Abschnitt gibt den Überblick.

Angezeigt wird ausschliesslich über zwei eigene Rust-Engines auf
[wgpu](https://wgpu.rs/) – kein three.js, kein WebGL:

| Engine | Aufgabe | Ziele |
|---|---|---|
| `render2d` | Pläne und Blätter: Füllungen, Linien mit Papier-mm-Strichstärken, Schraffuren, Text | WASM/WebGPU (`src/engine/pkg`), nativ Metal |
| `render3d` | 3D-Modell: schattiert, Kanten, verdeckte Kanten, Texturen, Schnitt, Punktwolken | WASM/WebGPU (`src/engine/pkg3d`), nativ Metal, `render_png` headless |

Beide sind in Schichten gebaut: eine GPU-freie Eingabe- und
Tessellierungsschicht (headless mit `cargo test` prüfbar) und darüber die
wgpu-Pipelines (Feature `render`). Shader sind WGSL.

**Ablauf 2D:** Der Kern erzeugt aus dem Dokument einen binären
**Plan-Puffer** (Polygone, Linien, Schraffuren, Texte mit Stift- und
Ebenenangaben). Daraus lesen:

- `render2d` für den Bildschirm,
- der SVG-Serializer (`plan/svg.rs`) für SVG-Export, CLI und Golden-Tests,
- der Druck-Generator (`plan/print_svg.rs`) für PDF mit ausgebreiteten
  Schraffurlinien,
- der DXF/DWG-Sammler.

Der Skizzenstil [67] wirkt beim Schreiben des Puffers – darum sehen
Bildschirm, SVG und PDF gleich aus.

**Ablauf 3D:** Der Kern erzeugt Netze je Bauteil (Ordner `model3d/`,
zwischengespeichert), `render3d` zeichnet sie. Headless (nur macOS):
`dossier-cli … model3d --out m.json`, dann
`src-tauri/target/release/render_png m.json out.png --view iso --style shaded-edges`
(vorher `npm run build:render-png`).

**macOS:** Die Tauri-Seite legt eine native wgpu/Metal-Fläche als Kind-View
**unter** die transparente Webansicht, genau hinter den Plan-Bereich. Die
Webansicht bleibt für Eingaben und Überlagerungen (Auswahl, Griffe, Fang,
Text) zuständig; die native Fläche liefert nur die Pixel der Geometrie.

## Geometrie: wer rechnet was

| Aufgabe | Werkzeug |
|---|---|
| 2D-Flächen-Booleans | Kern über i_overlay (Ganzzahlraster) |
| 2D-Bearbeitung (Offset, Trim, Fillet, Split, Join) | `kernel2d` |
| Dächer über beliebigen Grundrissen | Straight Skeleton im Kern (`skeleton.rs`, `roof_skeleton.rs`) |
| Wandanschlüsse | Kern (`joins.rs`, Schichten nach Priorität) |
| 3D-Körper im Modell (Öffnungen, Wandverbindungen, Abzugskörper, Dach ↔ Dach) | **Manifold** (`solid_bool.rs`): exakt, synchron |
| B-Rep, STEP, Kennwerte, Kollision | **truck** (`trucksolid`): eigenes WASM, Panic-isoliert über `guarded()` |
| IFC-Import (IfcBooleanResult, Halbräume) | **BSP** (`src-tauri/fileio/src/csg.rs`, Port von csg.js): toleriert offene Netze, fällt bei Budget-Überschreitung auf den ersten Operanden zurück |
| Gelände | Constrained Delaunay mit Bruchkanten (`terrain.rs`, `delaunay.rs`) |
| Sonnenstand, Schatten | Kern (`sun.rs`) |

Regeln: 2D-Booleans laufen über den Kern, 3D-Körper über Manifold bzw.
truck – nicht vermischen. **Neue 3D-Booleans nie mit BSP.**

## Text

Text-Layout (Zeilenumbruch, Formatierung, Textspalten, Text entlang Pfad)
rechnet der Kern (`text_layout.rs`, `rich_text.rs`), damit Bildschirm, PDF und
DXF dieselben Zeilen haben.
