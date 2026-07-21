# Dossier

Open-Source-CAAD (Computer Aided Architecture Design). Modelliert ein Gebäude
aus semantischen Bauteilen und zieht daraus saubere, normgerechte 2D-Pläne —
ohne Revit. **Desktop-App** — auf macOS über **Tauri**, auf Linux über eine
**Electron**-Shell (weil Tauris Linux-Webview WebKitGTK kein zuverlässiges
WebGPU bietet, das die Rendering-Engines brauchen); dieselbe Codebasis läuft
auch im Browser (eingeschränkt, ohne native Fenster/Dateisystem-Integration).

Das ist die eigenständige Neuimplementierung des Rhino-Plugins
[DOSSIER](https://git.openbureau.ch/karim/dossier): dieselbe Denkweise
(Geschosse, Kategorie-Ebenen, mehrschichtige Bauteile, Prioritäts-
Verschneidung), aber mit eigenem Datenmodell + eigener Rendering-Engine
(Rust/WASM/WebGPU, intern „Nordstern" genannt) statt Rhino-Aufsatz.

## Grundgedanke

Es gibt **ein semantisches Modell** als einzige Wahrheit. Jede Ansicht — 3D,
Grundriss, Schnitt, Ansicht, PDF — wird daraus **abgeleitet**. Darstellung
(Detailgrad, Linienstärken, Schraffuren) wird erst beim Rendern angewandt, nie
in die Geometrie eingebacken. Wer eine Wand verschiebt, verschiebt sie überall.

Konkret heißt das auch: Der Grundriss entsteht nicht aus einem zerschnittenen
3D-Mesh, sondern **analytisch aus den Bauteil-Parametern** (Wandachsen + Dicken →
Linien, Öffnungen → Lücken + Symbol). PDF-Export ist derselbe Plan, nur mit
echten mm-Stiftstärken statt Bildschirm-Hairlines. Schnitte und Ansichten laufen
über eine eigene, analytische Rust-Pipeline (kein Hidden-Line-Removal nötig,
siehe [ARCHITECTURE.md](ARCHITECTURE.md) §4.3) und sind seit Juli live im
3D-Viewport verdrahtet, nicht nur ein Spike.

## Stand heute

Aus dem ursprünglichen Risiko-Spike ist binnen weniger Wochen ein
**funktionsreiches Desktop-BIM-Tool** geworden: eigenes semantisches
Gebäudemodell, zwei eigene Rust/WASM-Rendering-Engines, IFC/DXF/PDF/STL/OBJ-
Export, Swisstopo-Import, SIA-416-Flächen, Materialbibliothek, Layouts/
Plansätze, native Tauri-Fenster. Eine vollständige, ehrliche Bestandsaufnahme
(inklusive offener Punkte und bekannter technischer Schulden) steht in
**[STATUS.md](STATUS.md)**.

**Funktioniert (Auszug — volle Liste in STATUS.md §3):**
- Semantisches Modell mit **mehrschichtigen Wänden**, L-Eck-Gehrung **und**
  Prioritäts-T-/X-Stössen (`joinPriority` am Component) — konsistent in
  Grundriss, 3D-Viewport und 3D-Live-Schnitt.
- **Parametrische Wände**, Decken, Treppen (gerade/L/Wendel), Dächer
  (Flach/Pult/Sattel/Walm/Mansarde/Zelt), Stützen, SIA-416-Räume mit
  automatischer Bilanz + CSV-Export.
- **Türen & Fenster** gehostet in Wänden, mit Rahmen/Zarge/Kämpfer/Oberlicht,
  Detailgrad grob/mittel/fein, echte Rechteck-Löcher im 3D-Wandkörper.
- Rhino-artiges **Kommandosystem** mit getippten Koordinaten (`5,3` · `r5,3` ·
  `5<45`) und Tab-Feld-Zyklus; Snapping, Grips, Trim/Split/Join, 2D-Booleans.
- **Live 2D↔3D-Schnitt**: eine Schnittebene im 3D-Viewport folgt derselben
  Prioritäts-Logik wie der 2D-Plan-Schnitt (Rust-Port, keine Diskrepanz).
- **Vektor-Export:** PDF (Einzel- **und Mehrseiten-Layouts**), DXF, **IFC4**
  (mit echten Fenster-/Tür-Löchern), STL/OBJ, CSV-Bauteilliste.
- **Materialbibliothek**: 13 gebündelte PBR-Starter **plus** Live-Suche der
  kompletten ambientCG-Bibliothek (1K/2K/4K, On-Demand-Download).
- **Layouts/Plansätze** mit mehreren Viewports pro Blatt, Ausschnitte
  (View-Snapshots), Kamera-Presets, Norden-Rotation.
- **Import:** DXF/DWG, Swisstopo (swissBUILDINGS3D/-ALTI3D/SWISSIMAGE,
  radiusgenau zugeschnitten), OSM-Kontextimport, `.lin`/`.pat`.
- **Native Desktop-Integration** (Tauri): eigene randlose Fenster, native
  Speichern/Öffnen-Dialoge, eigenes `.obp`-Dateiformat mit OS-Level-Lock gegen
  Doppelöffnen, mehrere native Zusatzfenster (Resources, Settings, …).
- **Resource Manager** (Component/Hatch/Line/Typ-Editoren), regelbasierte
  Overrides, Panel-System (dockbar/floatend), i18n (de/en).

**Bewusst noch offen** (Details + volle Liste: STATUS.md §4.7):
- **Echtes Mesh-Boolean für Öffnungen** — funktioniert heute über achsparallele
  Rechteck-Löcher; ein generisches CSG-Boolean existiert bereits
  (`trucksolid`/`csgrs`), ist aber nicht an die Wand-Pipeline angeschlossen.
- **3D-Griffsystem**: Feld-Controller (Tab-Zyklus) und Snapping fehlen für
  3D-Grip-Drag (im 2D vollständig vorhanden).
- **DWG/DXF-Domänenimport** (Entitäten → echte Wände/Öffnungen) — Lesen
  funktioniert, das Mapping auf das Modell ist unbegonnen; DWG-Schreiben fehlt.
- **`make2D`**-Kommando (3D-Ansicht → flacher 2D-Plan mit Füllungen).
- Bekannte, noch nicht bereinigte Doppelspur `Door[]`/`Opening[]` im Modell.

## Stack

| | |
|---|---|
| Shell | **Tauri** auf macOS (WKWebView+WebGPU) · **Electron/Chromium** auf Linux (WebKitGTK kann kein WebGPU) — beide randlos, eigene Titelleiste, gemeinsame React-App |
| Frontend | React + TypeScript + Vite |
| 3D | eigener Rust/WASM/WebGPU-Renderer „Nordstern" (`render3d`, Default), Three.js als leichtgewichtiger Zweitpfad |
| 2D-Plan | eigener Rust/WASM/WebGPU-Renderer (`render2d`), plus ein TS/WebGL2-Renderer (`plan/glPlan`), plus SVG (`PlanView.tsx`, immer als Interaktions-/Fallback-Ebene aktiv) |
| Geometrie | eigener 2D-Kernel (`src/geometry/kernel2d.ts`); ein Rust-Port (`src-tauri/kernel2d`) existiert nur als Paritätstest, läuft nicht produktiv |
| CSG/Extrusion | `trucksolid`-Crate (`truck` + `csgrs`), fürs Extrude-Kommando |
| Export | eigener IFC4-Writer, `jspdf`/`svg2pdf.js` (Vektor-PDF), eigener DXF-Writer, STL/OBJ |
| Import | `dxf-parser`, `@mlightcad/libredwg-web` (DWG), eigene `.lin`/`.pat`-Parser |
| Materialien | `jszip` (ambientCG-Zip-Entpacken), `three.js` `TextureLoader` |

`opencascade.js` steht noch als Dependency in `package.json`, wird aber nur
noch von totem Code (`src/section/hlr.ts`, superseded durch die Rust-
Schnitt-Pipeline) importiert. Details zu allen Rust-Crates (inkl. zwei
aktuell unbenutzten WASM-Builds) in [ARCHITECTURE.md](ARCHITECTURE.md) §1
und [STATUS.md](STATUS.md) §4.1.

## Entwicklung

```bash
npm install
npm run dev        # Vite, http://localhost:5187
npm run tauri:dev  # Tauri-Fenster (macOS — nativer Zielrahmen dort)
npm run electron   # Electron-Fenster (Linux — WebGPU über Chromium statt WebKitGTK)
npx tsc -b         # Typecheck
npm run build      # tsc -b && vite build
npm test           # vitest run
```

WASM-Engines nach Rust-Änderungen neu bauen (nur `.rs` committen,
`src/engine/pkg*/` ist gitignored):

```bash
npm run build:engine     # render2d
npm run build:engine3d   # render3d
npm run build:truck      # trucksolid
```

render3d/Wasm3DViewport-Änderungen sind nicht per Puppeteer/Browser
verifizierbar — im laufenden `tauri:dev`-Fenster selbst testen.

## Aufbau

```
src/
  model/       semantisches Modell (types, joins, parametricWalls, roomStamp, terrain)
  geometry/    2D-Kernel (offset/trim/fillet/intersect, ceiling/opening/roomArea/stair/roof/column)
  commands/    Rhino-artiges Befehlssystem (engine, parser, registry, cmds/)
  tools/       interaktive Zeichenwerkzeuge + Snapping + Transformationen
  plan/        Grundriss-Ableitung (generatePlan) + PlanView (SVG) + glPlan (WebGL2) + Rust-Bindings
  viewport/    Viewport3D (Three.js) + Wasm3DViewport (Rust/wgpu „Nordstern", Default)
  section/     TOTER Code (OCCT-HLR-Spike) — Schnitt läuft über render3d, siehe ARCHITECTURE.md §4.3
  export/      IFC4-, PDF-, DXF-, STL/OBJ-, CSV-Export aus derselben Plan-/Modell-Struktur
  materials/   ambientCG-Live-Suche + gebündelte Starter-Bibliothek + PBR-Runtime
  panels/      dockbares Panel-System + die einzelnen Paletten
  state/       eigener Store (useSyncExternalStore) + Slices (project/selection/view/layout/…)
  native/      Tauri-only: native Fenster, macOS-Menüleiste, Fenster-Chrome
  ui/          App.tsx-Shell, Top-Bar, Resource Manager, Kontextmenü, Kommandozeile, Ribbon
  io/          Import/Export (DXF, DWG, .lin, .pat), Swisstopo/LV95, OSM-Kontext
  i18n/        Wörterbücher de/en
src-tauri/     6 Rust-Crates (render2d/render3d/geometry/kernel2d/trucksolid/dwgimport,
               je headless UND per wasm-pack baubar) + der Tauri-Host selbst
```

## Konventionen

- **Bezeichner im Code sind englisch**, an Vectorworks-Terminologie angelehnt
  (Design Layer, Component, Hatch, Wall Style). **UI-Texte sind deutsch**, immer
  über `t('key')` — keine hartcodierten Strings im JSX.
- Intern alles in **Metern**; Anzeige via `formatM`.
- Verbindliches in [CONVENTIONS.md](CONVENTIONS.md).

## Weiterlesen

- [STATUS.md](STATUS.md) — **vollständige, ehrliche Bestandsaufnahme**: Zahlen,
  Feature-Inventar, Mist-Liste, Doku-Widersprüche, Tag-1-Vision vs. heute
- [ARCHITECTURE.md](ARCHITECTURE.md) — technische Architektur im Detail (Ist-Zustand)
- [ROADMAP.md](ROADMAP.md) — ursprüngliche Produktvision (Tag-1-Stand, historisch)
- [HANDOVER.md](HANDOVER.md) / [PENDENZEN.md](PENDENZEN.md) — laufendes
  Arbeitsprotokoll bzw. Backlog (Single Source of Truth für offene Punkte)
- [docs/](docs/) — Design-Specs (teils ebenfalls Tag-1-Vision, siehe Hinweis
  in `docs/README.md`)

## Lizenz

Copyright © 2026 Karim Gabriele Varano. Veröffentlicht unter der
**GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)** —
siehe [LICENSE](LICENSE). Dossier ist Teil der **openbureau**-Suite.

Die AGPL verlangt, dass auch bei Betrieb als Netzwerk-/Webdienst der (ggf.
geänderte) Quellcode für die Nutzer verfügbar gemacht wird. Drittkomponenten
behalten ihre jeweiligen Lizenzen (siehe „Über"-Dialog in der App).

---

Die UI ist deutsch; Schweizer Spezifika (SIA-416-Flächen, Swisstopo-Geodaten)
sind ein bewusster Differenzierer.
