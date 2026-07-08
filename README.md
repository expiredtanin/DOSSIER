# DOSSIER Standalone

Open-Source-CAAD (Computer Aided Architecture Design). Modelliert ein Gebäude
aus semantischen Bauteilen und zieht daraus saubere, normgerechte 2D-Pläne —
ohne Revit. Als Desktop-App und im Browser zugänglich; die Desktop-App ist die
vollständige Fassung.

Das ist die eigenständige Standalone-Variante des Rhino-Plugins
[DOSSIER](https://git.kgva.ch/karim/DOSSIER): dieselbe Denkweise (Geschosse,
Kategorie-Ebenen, mehrschichtige Bauteile, Prioritäts-Verschneidung), aber als
React-App mit eigener Rendering-Engine (Rust/WASM/WebGPU) statt als Rhino-Aufsatz.
Als Desktop-App (Tauri) läuft sie im eigenen Fenster mit voller Engine-Leistung;
browserseitig ist derselbe Kern zugänglich, die App ist die vollständige Fassung.

## Grundgedanke

Es gibt **ein semantisches Modell** als einzige Wahrheit. Jede Ansicht — 3D,
Grundriss, Schnitt, Ansicht, PDF — wird daraus **abgeleitet**. Darstellung
(Detailgrad, Linienstärken, Schraffuren) wird erst beim Rendern angewandt, nie
in die Geometrie eingebacken. Wer eine Wand verschiebt, verschiebt sie überall.

Konkret heißt das auch: Der Grundriss entsteht nicht aus einem zerschnittenen
3D-Mesh, sondern **analytisch aus den Bauteil-Parametern** (Wandachsen + Dicken →
Linien, Öffnungen → Lücken + Symbol). PDF-Export ist derselbe Plan, nur mit
echten mm-Stiftstärken statt Bildschirm-Hairlines — kein zweites Rendering.
Schnitte und Ansichten brauchen den zweiten Weg — echte 3D-Projektion mit
verdeckten Kanten (HLR) —, dessen Machbarkeit per Spike bewiesen, aber noch
nicht ans UI angebunden ist.

## Stand heute

Ehrlich eingeordnet: aus dem Risiko-Spike ist ein **benutzbares 2D-CAD mit
abgeleiteter 3D-Sicht, Vektor-PDF/DXF-Export und einer parametrischen
Wand-Engine** geworden. Der einfachere Teil steht und ist per Screenshot/Probe
verifiziert; die schwierigen BIM-Kernrisiken sind bewusst noch offen.

**Funktioniert:**
- Semantisches Modell mit **mehrschichtigen Wänden** und automatischer
  **L-Ecken-Gehrung** (`computeJoins`); dieselbe Logik speist Plan *und* 3D.
- **Parametrische Wände** (`ParametricWall`-Regelwerke: Grid/Modul/Sequenz/
  Referenzlinie/bedingte Dicke) lösen sich zu konkreten `Wall`-Objekten auf,
  statt jede Wand einzeln von Hand zu ziehen.
- **Dokumentmodell wie in DOSSIER:** Zeichnungsebenen (Geschosse + Schnitte/
  Ansichten/Zeichnungen) × Kategorie-Ebenen (Code-Baum 1:1, `20 Wände`, `30 Decken` …).
- **Zeichnen & Editieren** im Grundriss: Wand, Linie, Polylinie, Rechteck, Kreis,
  Öffnungen, Treppen, Decken, Raumstempel; Snapping (Endpunkt/Mittelpunkt/
  Schnittpunkt/Lot/Raster/Ortho), Grips, Move/Copy/Offset, Spiegeln/Drehen/Array,
  Trim/Split/Join.
- **Rhino-artiges Befehlssystem** mit getippten Koordinaten (`5,3` · `r5,3` ·
  `5<45`) und Tab-Feld-Zyklus (Länge → Winkel …).
- **Vektor-Export:** PDF (A4/A3, Titelblock, echte mm-Stiftstärken nach ISO-Pen-
  Steps, keine Rasterbilder) und DXF — beide aus derselben `Plan`-Struktur wie
  der Bildschirm.
- **PBR-Material-Bibliothek** (ambientCG-Import, `manifest.json`) für die
  3D-Ansicht.
- **Resource Manager** (Component / Hatch / Line) — alles per id referenziert,
  zentral änderbar.
- **Panel-System** (dockbar, stapelbar, floatend), Top-Bar + Statusleiste
  (echter Maßstab 1:N, Cursor X/Y), eigenes Kontextmenü, **i18n** (de/en).
- **Import:** DXF/DWG (Konturen/Mesh) → Terrain-TIN, Swisstopo/LV95-Geokontext,
  OSM-Kontextimport; `.lin`/`.pat` für Linien/Schraffuren.

**Bewusst noch offen** (die eigentlich harten Teile):
- Echte **3D-Booleans** für Öffnungen — Türen/Fenster sind im Plan eine Lücke,
  noch kein geschnittenes Volumen.
- **HLR** (verdeckte Kanten) für Schnitte und Ansichten: Machbarkeit per
  OCCT-WASM-Spike bewiesen (`docs/welle-c-hlr-spike/`, `src/section/hlr.ts`),
  aber noch nicht ans UI/Dokumentmodell verdrahtet — Views sind noch Stubs.
- **Prioritäts-T-/X-Stöße** mehrschichtiger Wände (Beton läuft durch, Putz
  verbindet seitlich) — das berüchtigte Risiko #1.
- **Multi-Page-Layouts/Ausschnitte** (mehrere Viewports pro Blatt) — PDF-Export
  ist noch single-sheet.

Details und die Begründungen stehen im
[HANDOVER](HANDOVER.md) (laufendes Arbeitsprotokoll) und in der
[ROADMAP](ROADMAP.md) (Vision, Phasen, Backlog).

## Stack

Bewusst leichtgewichtig — Three.js ist reiner Display-Layer, kein schwerer
Geometrie-Kernel verfrüht eingezogen.

| | |
|---|---|
| Shell | Electron (eigenes randloses App-Fenster, kein Browser-Tab) |
| Frontend | React + TypeScript + Vite |
| 3D | Three.js, plus eigener nativer Rust/WASM/WebGPU-Renderer (`render3d`) |
| 2D-Plan | eigener SVG-Renderer, plus eigener nativer Rust/WASM/WebGPU-Renderer (`render2d`) |
| Geometrie | eigener 2D-Kernel (`src/geometry/kernel2d.ts`), `delaunator` fürs Terrain |
| Export | `jspdf`/`svg2pdf.js` (Vektor-PDF), eigener DXF-Writer |
| Import | `dxf-parser`, `@mlightcad/libredwg-web` (DWG), eigene `.lin`/`.pat`-Parser |
| Schnitt/HLR-Spike | `opencascade.js` (OCCT-WASM) — isoliert, noch nicht verdrahtet |

Geplant, aber noch nicht eingezogen: `rhino3dm` (NURBS / `.3dm`), web-ifc (IFC),
Manifold (exakte 3D-Booleans). OCCT-WASM ist für HLR bereits als Spike da (s.o.),
aber noch nicht an Dokumentmodell/UI angebunden. Siehe ROADMAP §4.

## Entwicklung

```bash
npm install
npm run dev      # Vite, http://localhost:5187
npm run electron # Electron-Fenster (Dev-Server + randlose App-Shell)
npx tsc -b       # Typecheck
npm run build    # tsc -b && vite build
npm test         # vitest run
```

Verifiziert wird visuell: `node scripts/probe.mjs` rendert die App headless und
schreibt `scripts/probe.png` — Screenshot ansehen, Geometrie prüfen. Weitere
`scripts/probe-*.mjs` decken einzelne Features ab (PDF, Trim, Materialien,
Theme, Boolean-Ops …); für Firefox-Fälle gibt es `scripts/probe-ff*.mjs`
(Playwright).

## Aufbau

```
src/
  model/       semantisches Modell + Ableitungen (types, parametricWalls, roomStamp, joins, terrain)
  geometry/    2D-Kernel (offset/trim/fillet/intersect, ceiling, opening, roomArea/-Boundary, stair)
  commands/    Rhino-artiges Befehlssystem (engine, parser, registry, cmds/)
  tools/       interaktive Zeichenwerkzeuge + Snapping + Transformationen
  plan/        Grundriss-Ableitung (generatePlan) + PlanView (SVG) + glPlan (WebGL2-Renderer)
  viewport/    Viewport3D (Three.js)
  section/     HLR-Spike (OCCT-WASM) — Schnitte/Ansichten, noch nicht verdrahtet
  export/      PDF- und DXF-Export aus derselben Plan-Struktur wie der Bildschirm
  materials/   PBR-Material-Bibliothek (ambientCG-Import, Runtime)
  text/        Rich-Text (Beschriftungen, Textobjekte)
  panels/      dockbares Panel-System + die einzelnen Paletten
  state/       Store + Slices (project/selection/view/layout)
  ui/          Top-Bar, Statusleiste, Kontextmenü, Resource Manager, Command-Line
  io/          Import/Export (DXF, DWG, .lin, .pat), Swisstopo/LV95, OSM-Kontext
  i18n/        Wörterbücher de/en
src-tauri/     Rust-Crates (render2d/render3d) — headless per wasm-pack zu WASM
               gebaut (npm run build:engine), Tauri-Host selbst ist ausrangiert
```

## Konventionen

- **Bezeichner im Code sind englisch**, an Vectorworks-Terminologie angelehnt
  (Design Layer, Component, Hatch, Wall Style). **UI-Texte sind deutsch**, immer
  über `t('key')` — keine hartcodierten Strings im JSX.
- Intern alles in **Metern**; Anzeige via `formatM`.
- `App.tsx` bleibt dünner Shell, Zustand lebt im Store. Verbindliches in
  [CONVENTIONS.md](CONVENTIONS.md).

## Weiterlesen

- [ROADMAP.md](ROADMAP.md) — Produktvision, Architektur-Entscheidungen, Phasen 0–7, DOSSIER-Backlog
- [ARCHITECTURE.md](ARCHITECTURE.md) — Technische Architektur im Detail
- [HANDOVER.md](HANDOVER.md) — aktueller Arbeitsstand, Befunde, nächste Schritte
- [docs/](docs/) — Design-Specs (Befehlssystem, Zeichenwerkzeuge, Wand-Joins, Backend …)

## Lizenz

Copyright © 2026 Karim Gabriele Varano. Veröffentlicht unter der
**GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)** —
siehe [LICENSE](LICENSE). DOSSIER ist Teil der **openbureau**-Suite.

Die AGPL verlangt, dass auch bei Betrieb als Netzwerk-/Webdienst der (ggf.
geänderte) Quellcode für die Nutzer verfügbar gemacht wird. Drittkomponenten
behalten ihre jeweiligen Lizenzen (siehe „Über"-Dialog in der App).

---

Die UI ist deutsch; Schweizer Spezifika (SIA-416-Flächen, Swisstopo-Geodaten)
sind als Differenzierer eingeplant.
