# DOSSIER Standalone

Eigenständiges BIM-Werkzeug für Wohnbau. Modelliert ein Wohnhaus aus
semantischen Bauteilen und zieht daraus saubere, normgerechte 2D-Pläne —
ohne Revit.

Das ist die eigenständige Standalone-Variante des Rhino-Plugins
[DOSSIER](https://git.kgva.ch/karim/DOSSIER): dieselbe Denkweise (Geschosse,
Kategorie-Ebenen, mehrschichtige Bauteile, Prioritäts-Verschneidung), aber als
React/Three.js-App in einer Electron-Desktop-Shell statt als Rhino-Aufsatz.
Kein Browser-Tab-Produkt: eigenes Fenster, eigene Rendering-Engine
(Rust/WASM/WebGPU), gebaut für flüssiges CAD-Arbeiten statt für den Webview
kleinster gemeinsamer Nenner.

## Grundgedanke

Es gibt **ein semantisches Modell** als einzige Wahrheit. Jede Ansicht — 3D,
Grundriss, Schnitt, Ansicht — wird daraus **abgeleitet**. Darstellung
(Detailgrad, Linienstärken, Schraffuren) wird erst beim Rendern angewandt, nie
in die Geometrie eingebacken. Wer eine Wand verschiebt, verschiebt sie überall.

Konkret heißt das auch: Der Grundriss entsteht nicht aus einem zerschnittenen
3D-Mesh, sondern **analytisch aus den Bauteil-Parametern** (Wandachsen + Dicken →
Linien, Öffnungen → Lücken + Symbol). Schnitte und Ansichten brauchen später den
zweiten Weg — echte 3D-Projektion mit verdeckten Kanten.

## Stand heute

Ehrlich eingeordnet: aus dem Risiko-Spike ist ein **benutzbares 2D-CAD mit
abgeleiteter 3D-Sicht** geworden. Der einfachere Teil steht und ist per
Screenshot verifiziert; die schwierigen BIM-Kernrisiken sind bewusst noch offen.

**Funktioniert:**
- Semantisches Modell mit **mehrschichtigen Wänden** und automatischer
  **L-Ecken-Gehrung** (`computeJoins`); dieselbe Logik speist Plan *und* 3D.
- **Dokumentmodell wie in DOSSIER:** Zeichnungsebenen (Geschosse + Schnitte/
  Ansichten/Zeichnungen) × Kategorie-Ebenen (Code-Baum 1:1, `20 Wände`, `30 Decken` …).
- **Zeichnen & Editieren** im Grundriss: Wand, Linie, Polylinie, Rechteck, Kreis;
  Snapping (Endpunkt/Mittelpunkt/Schnittpunkt/Lot/Raster/Ortho), Grips, Move/Copy/
  Offset, Spiegeln/Drehen/Array.
- **Rhino-artiges Befehlssystem** mit getippten Koordinaten (`5,3` · `r5,3` ·
  `5<45`) und Tab-Feld-Zyklus (Länge → Winkel …).
- **Resource Manager** (Component / Hatch / Line) — alles per id referenziert,
  zentral änderbar.
- **Panel-System** (dockbar, stapelbar, floatend), Top-Bar + Statusleiste
  (echter Maßstab 1:N, Cursor X/Y), eigenes Kontextmenü, **i18n** (de/en).
- **Import:** DXF (Konturen/Mesh) → Terrain-TIN; `.lin`/`.pat` für Linien/Schraffuren.

**Bewusst noch offen** (die eigentlich harten Teile):
- Echte **3D-Booleans** für Öffnungen — Türen/Fenster sind im Plan eine Lücke,
  noch kein geschnittenes Volumen.
- **HLR** (verdeckte Kanten) für Schnitte und Ansichten — diese Views sind Stubs.
- **Prioritäts-T-/X-Stöße** mehrschichtiger Wände (Beton läuft durch, Putz
  verbindet seitlich) — das berüchtigte Risiko #1.

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
| Import | `dxf-parser`, eigene `.lin`/`.pat`-Parser |

Geplant, aber noch nicht eingezogen: `rhino3dm` (NURBS / `.3dm`), web-ifc (IFC),
OpenCascade/Manifold (exakte Booleans + HLR). Siehe ROADMAP §4.

## Entwicklung

```bash
npm install
npm run dev      # Vite, http://localhost:5173
npm run electron # Electron-Fenster (Dev-Server + randlose App-Shell)
npx tsc -b       # Typecheck
npm run build    # tsc -b && vite build
```

Verifiziert wird visuell: `node scripts/probe.mjs` rendert die App headless und
schreibt `scripts/probe.png` — Screenshot ansehen, Geometrie prüfen. Für
Firefox-Fälle gibt es `scripts/probe-ff*.mjs` (Playwright).

## Aufbau

```
src/
  model/       semantisches Modell + Ableitungen (types, geometry, joins, terrain)
  geometry/    2D-Kernel (offset/trim/fillet/intersect)
  commands/    Rhino-artiges Befehlssystem (engine, parser, registry, cmds/)
  tools/       interaktive Zeichenwerkzeuge + Snapping + Transformationen
  plan/        Grundriss-Ableitung (generatePlan) + PlanView (SVG)
  viewport/    Viewport3D (Three.js)
  panels/      dockbares Panel-System + die einzelnen Paletten
  state/       Store + Slices (project/selection/view/layout)
  ui/          Top-Bar, Statusleiste, Kontextmenü, Resource Manager, Command-Line
  io/          Import/Export (DXF, .lin, .pat)
  i18n/        Wörterbücher de/en
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

---

Privates Projekt. Die UI ist deutsch; Schweizer Spezifika (SIA-416-Flächen,
Swisstopo-Geodaten) sind als Differenzierer eingeplant.
