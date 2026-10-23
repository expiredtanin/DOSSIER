# Dossier

**Open-Source-CAD für die Architektur.** Dossier modelliert ein Gebäude aus
semantischen Bauteilen — Wände, Decken, Dächer, Treppen, Öffnungen, Räume — und
leitet daraus saubere, normgerechte Pläne ab: Grundriss, Schnitt, Ansicht, 3D,
Planlayout und PDF. Dazu kommt ein vollwertiges 2D-Zeichenprogramm mit
Rhino-artiger Befehlszeile.

Dossier ist eine Desktop-Anwendung (macOS über Tauri, Linux über Electron) und
die eigenständige Neuimplementierung des Rhino-Plugins
[DOSSIER](https://git.openbureau.ch/karim/dossier): dieselbe Denkweise
(Geschosse, Kategorie-Ebenen, mehrschichtige Bauteile, Prioritäts-
Verschneidung), aber mit eigenem Datenmodell und eigenen Rendering-Engines in
Rust/WebGPU (intern „Nordstern") statt eines Aufsatzes auf Rhino.

Dossier ist Teil der **openbureau**-Suite.

---

## Grundgedanke

Es gibt **ein semantisches Modell** als einzige Wahrheit. Jede Darstellung
wird daraus **abgeleitet**, nie umgekehrt:

```
                    ┌──────────────────────────┐
                    │  Projekt (semantisches   │
                    │  Modell, intern Meter)   │
                    └────────────┬─────────────┘
       ┌──────────────┬──────────┼───────────┬───────────────┐
       ▼              ▼          ▼           ▼               ▼
  Grundriss       Schnitt     Ansicht       3D       Export (IFC, STEP,
 (analytisch    (Rust-WASM,  (Projektion) (WebGPU)    DXF, PDF, SVG, …)
  aus Para-      Prioritäts-
  metern)        logik)
```

- **Darstellung wird erst beim Rendern angewandt** — Detailgrad, Stiftstärken,
  Schraffuren und Farben sind nie in die Geometrie eingebacken. Wer eine Wand
  verschiebt, verschiebt sie überall.
- **Der Grundriss entsteht analytisch** aus den Bauteil-Parametern
  (Wandachsen + Schichtdicken → Linien und Füllungen, Öffnungen → Lücken +
  Symbol), nicht aus einem zerschnittenen 3D-Mesh.
- **Schnitte laufen über eine eigene analytische Pipeline** in Rust, die
  dieselbe Prioritäts-Verschneidung wie der Grundriss anwendet — kein
  Hidden-Line-Removal, keine Abweichung zwischen 2D und 3D.
- **PDF ist derselbe Plan** wie am Bildschirm, nur mit echten
  mm-Stiftstärken statt Bildschirm-Haarlinien.

## Funktionsumfang

_Stand Oktober 2026, Version 0.1.0. Das Projekt entwickelt sich schnell; die
Liste beschreibt den Ist-Zustand des Codes, nicht eine Zusage._

### Bauteile

- **Wände** mit beliebig vielen Materialschichten, L-Eck-Gehrungen und
  Prioritäts-T-/X-Stössen (`joinPriority` je Bauteil) — identisch im
  Grundriss, in 3D und im Schnitt. Wandtypen, Referenzlinie, parametrische
  Wand-Regelwerke.
- **Öffnungen**: Fenster und Türen in Wänden gehostet, mit Blendrahmen,
  Flügelrahmen, Glas, Sprossen, Kämpfer, Oberlicht, Rollladenkasten,
  zweiflügeligen Türen, Kassettentüren; Detailgrad grob/mittel/fein; Fenster-
  und Türtypen.
- **Decken** mit Deckentypen und Aussparungen.
- **Dächer**: Flach-, Pult-, Sattel-, Walm-, Mansard- und Zeltdach, Krüppelwalm,
  Dachschichten über Dachtypen, getrennter Trauf-/Ortgang-Überstand. Sattel-,
  Pult- und Mansarddach auch über L/T/U-Grundrissen; Walm-, Zelt- und
  Mansard-Walmdach über beliebigen einfachen Umrissen (auch schiefwinklig und
  konkav) mit echten Graten und Kehlen (Straight-Skeleton).
- **Treppen** (gerade, L-förmig, Wendel) inkl. Podest und Geländer; gerade
  Betontreppen mit schräger Untersicht im Schnitt.
- **Stützen**, **Räume** nach SIA 416 mit Raumstempel, automatischer
  Flächenbilanz und CSV-Export.
- **Gruppen**, Symbole/Blöcke, Objektsperre.

### Volumenkörper (B-Rep)

Über die Crate `trucksolid` ([truck](https://github.com/ricosjp/truck) +
[csgrs](https://github.com/timschmidt/csgrs)) als WASM:

- Extrusion von 2D-Profilen mit Löchern, Verjüngung, verrundeten Ecken
  (echte Kreisbögen) und Fasen.
- Grundkörper: Quader, Kugel, Zylinder, Kegel, Kegelstumpf, Torus;
  Rotationskörper und Loft.
- Boolesche Operationen (`solidbool`) als B-Rep mit Mesh-CSG-Rückfall bei
  bündigen Flächen; Drehen, Skalieren und Spiegeln direkt am B-Rep.
- Kennwerte im Objekt-Panel: Volumen, Oberfläche, Schwerpunkt, Dichtheit.
- **Kollisionsprüfung** zwischen freien Körpern, importierten Meshes und den
  übrigen Bauteilen, mit Markierungen im Plan.

### 2D-Zeichnen und Annotation

- Linie, Polylinie (Eck-, Bogen- und Splinepunkte), Rechteck mit Fasen, Kreis,
  Bogen, Ellipse, Vieleck, Spline, Bézier, Konstruktionslinie, Strahl,
  Mehrfachlinie.
- Bearbeiten: Verschieben, Kopieren, Drehen, Spiegeln, Skalieren, Reihe,
  Versatz, Trimmen, Dehnen, Unterbrechen, Verbinden, Verrunden, Fasen,
  Explodieren, Ausrichten, Eigenschaften übertragen, 2D-Booleans.
- Bemassung, Höhenkote, Text, Textrahmen mit Rich-Text, Pfadtext,
  Hinweislinie, Detailverweis, Massstabsbalken, Revisionswolke, Punktmarker,
  Ausblend-Maske, Schnitt- und Ansichtslinien, Bilder (auch PDF-Seiten als
  Bild).
- Füllungen als Vollfläche, Schraffur oder Verlauf, mit Transparenz;
  Schraffur-Winkel, -Massstab und -Ursprung je Element.

### Bedienung

- **Befehlszeile** nach Rhino-Vorbild mit rund 55 Befehlen, deutschen und
  englischen Aliassen (`w`/`wand`, `d`/`decke`, `dach`, `koerper`, …) und
  getippten Koordinaten: absolut `5,3`, relativ `r5,3`, polar `5<45`;
  Tab-Zyklus durch die Eingabefelder.
- **Fang** auf Endpunkte, Mitten, Schnittpunkte, Kanten usw.; Griffe mit
  Vorschau (das Projekt ändert sich erst beim Loslassen); Esc bricht ab.
- **3D-Griffsystem** auf 2D-Niveau: getippte Länge und Winkel, Fang beim
  Verschieben, Achssperre, Rotations-Gizmo, verbundene Ecken ziehen mit.
- Übereinanderliegende Objekte per Cmd/Strg-Klick durchschalten oder aus
  einer Liste wählen.
- Dockbare und frei schwebende Panels, Ribbon-Leiste mit eigener
  Werkzeugleiste, frei belegbare Tastenkürzel mit Kollisionserkennung,
  Oberfläche auf Deutsch und Englisch, helles und dunkles Thema.

### Ansichten und Pläne

- **Grundriss** je Geschoss mit Zeichnungsebenen, Kategorie-Ebenen,
  gedimmten Referenzebenen, Sichtbarkeits-Kombinationen und fünf
  Darstellungsmodi.
- **Schnitt** und **Ansicht** aus Schnitt-/Ansichtslinien: geschnittene
  Bauteile mit Schraffur, automatische Höhenkoten, eigene 2D-Elemente pro
  Blatt. Bauteile lassen sich direkt im Schnitt bearbeiten — Wände, Decken,
  Öffnungen und Treppen waagrecht verschieben, Wandhöhe und Brüstung über
  Höhengriffe anpassen.
- **3D-Ansicht** mit Live-Schnittebene, schattiert/mit Kanten/texturiert; die
  Wand-Oberseiten tragen in der Draufsicht dieselbe Schraffur wie im Plan.
- **Layouts und Plansätze**: mehrere Viewports pro Blatt, Masterlayouts mit
  Rahmen und Titelblock, gespeicherte Ausschnitte, Kamera-Presets,
  Nordrotation, Ordner als Mehrseiten-PDF.

### Darstellung und Ressourcen

- **Resource Manager** für Bauteile (Components), Schraffuren, Linienstile,
  Text-Stile und Bauteiltypen; Import von `.lin`- und `.pat`-Dateien.
- **Stiftsätze** nach ArchiCAD-Vorbild: Bauteile und Ebenen verweisen auf einen
  Stift statt auf eine feste Farbe; ein Wechsel des Stiftsatzes färbt alles
  Gekoppelte um.
- **Grafische Overrides**: Regeln, die Farbe, Strichstärke und Linienstil
  abhängig von Ebene und Element überschreiben, ohne die Daten zu ändern.
- **Farbmanagement**: RGB/CMYK-Mischer mit echtem ICC-Abgleich (Little CMS)
  und Spektral-Picker.
- **Materialbibliothek**: 13 gebündelte PBR-Materialien plus Live-Suche in der
  gesamten [ambientCG](https://ambientcg.com)-Bibliothek (CC0, 1K/2K/4K, auf
  Abruf geladen).

### Import

| Format / Quelle | Ergebnis |
|---|---|
| DXF | 2D-Elemente; fehlende Layer werden zu Kategorien. Grosse Dateien (Kataster ganzer Städte) werden parallel in Web Workern geparst. |
| DWG | über `@mlightcad/libredwg-web`, inkl. Polyface-Meshes |
| STEP (ISO 10303, B-Rep) | tessellierte Körper im Kontext |
| PDF, Bilder | als Bild-Element im Plan oder im Layout |
| swisstopo | Ortssuche, swissBUILDINGS3D (2.0/3.0), swissALTI3D-Gelände, SWISSIMAGE-Orthofoto — radiusgenau zugeschnitten, LV95-georeferenziert |
| OpenStreetMap | Gebäude, Strassen, Gewässer, Grünflächen, Bahn, Wald als Kontext |
| Höhenlinien | Gelände als TIN (Delaunay) |
| `.lin`, `.pat` | Linienstile und Schraffuren |

### Export

| Format | Inhalt |
|---|---|
| PDF | Vektor-PDF einzelner Pläne und mehrseitiger Plansätze, echte Stiftstärken in mm |
| SVG | dasselbe druckgenaue SVG, aus dem auch das PDF entsteht |
| DXF | Linien, Bögen, Füllungen und Verläufe |
| IFC4 | Geschossstruktur, Bauteile mit Schichten, Öffnungen als echte Löcher |
| STEP | B-Rep-Körper je Wandschicht, Decke, Dach, Treppe und Extrusion (in mm) |
| STL, OBJ | Dreiecksnetz des 3D-Modells, Öffnungen ausgeschnitten |
| CSV | Bauteilliste und SIA-416-Raumbilanz |

### Desktop-Integration

- Eigenes Projektformat **`.obp`** (JSON) mit OS-Lock gegen doppeltes Öffnen,
  Vorlagen, zuletzt geöffnete Projekte, Rückfrage bei ungespeicherten
  Änderungen.
- Randlose Fenster mit eigener Titelleiste, native macOS-Menüleiste, native
  Zusatzfenster (Ressourcen, Einstellungen, Ebenen, Kontext-Import).
- Selbst-Update über den Tauri-Updater (signierte Releases).
- Auf macOS rendert der Grundriss in eine **native Metal-Fläche** unter der
  Webview (`native2d`): Millionen von Linien aus einem Kataster-Import bleiben
  flüssig zoom- und verschiebbar.

### Bewusst noch offen

- **DWG/DXF als Bauteile**: Lesen funktioniert, die Zuordnung von Entitäten zu
  echten Wänden und Öffnungen fehlt; DWG-Schreiben fehlt.
- **`make2D`**: aus einer 3D-Sicht eine flache 2D-Zeichnung mit Füllungen
  erzeugen.
- **Generische Mesh-Booleans für Wandöffnungen**: Öffnungen werden heute als
  achsparallele Löcher aus dem Wandkörper geschnitten; das allgemeine
  CSG aus `trucksolid` ist nicht an die Wand-Pipeline angeschlossen.
- Dachfenster.
- Die historische Doppelung `doors` / `openings` im Datenmodell ist noch nicht
  bereinigt.

## Plattformen

| Plattform | Shell | Rendering |
|---|---|---|
| macOS | **Tauri** (WKWebView) | WebGPU für 3D; Grundriss nativ über Metal (`native2d`), Rückfall auf WebGL2 mit `?native=0` |
| Linux | **Electron** (Chromium) | WebGPU — WebKitGTK, die Linux-Webview von Tauri, bietet kein verlässliches WebGPU |
| Browser | Vite-Dev-Server | eingeschränkt: ohne native Fenster, Dialoge und Dateisperre; gedacht für Entwicklung und Tests |

Fertige Installer gibt es noch nicht; Dossier wird derzeit aus dem Quellcode
gebaut.

## Technik

| Bereich | Umsetzung |
|---|---|
| Oberfläche | React 18 + TypeScript + Vite; eigener Store auf `useSyncExternalStore` mit Slices und Undo/Redo |
| Grundriss | Plan-Ableitung in TS (`plan/generatePlan`) → GPU-Chunks; Rendering nativ über `render2d` (macOS), WebGL2 (`plan/glPlan`) oder `render2d` als WASM; SVG-Ebene immer aktiv für Interaktion und Overlays |
| 3D | eigener WebGPU-Renderer `render3d` („Nordstern", Rust/WASM); Three.js als leichtgewichtiger Zweitpfad |
| Schnitt | analytische Schnitt-Pipeline in `render3d` (`section.rs`), Ansicht in TS (`plan/toElevation.ts`) |
| 2D-Geometrie | eigener Kernel `geometry/kernel2d.ts` (Offset, Trim, Verrundung, Schnittpunkte, Bulges) |
| Volumenkörper | `trucksolid` (truck 0.6, csgrs) als WASM: B-Rep, Booleans, STEP-I/O, Mesh-Kennwerte |
| PDF/SVG | eigene Druck-SVG-Erzeugung, `jspdf` + `svg2pdf.js` |
| IFC, DXF, STEP | eigene Writer bzw. truck-stepio |
| Import | `dxf-parser` (in Workern), `@mlightcad/libredwg-web`, `pdfjs-dist`, eigene `.lin`/`.pat`-Parser |
| Farbe | `lcms-wasm` (Little CMS) |

### Rust-Crates (`src-tauri/`)

Jede Crate ist eigenständig, headless testbar und per `wasm-pack` baubar.

| Crate | Zweck | Im Einsatz |
|---|---|---|
| `render2d` | 2D-Plan-Renderer (wgpu, Vektor-Text, Chunk-Renderer für `native2d`) | ja |
| `render3d` | 3D-Renderer „Nordstern" + analytischer Schnitt | ja |
| `trucksolid` | B-Rep-Modellierung, Booleans, STEP, Kennwerte, Kollision | ja |
| `kernel2d` | Rust-Port des 2D-Kernels, nur als Paritätstest gegen die TS-Version | nein |
| `dwgimport` | DXF/DWG-Parser-Spike (`acadrust`) | nein |
| `src/` | Tauri-Host: Fenster, Menüs, Dateisperre, Metal-Einbettung | ja |

### Umfang

Rund 119 000 Zeilen TypeScript und 23 000 Zeilen Rust; etwa 1 900
Vitest-Fälle in rund 200 Testdateien sowie gut 180 Rust-Tests.

## Entwicklung

### Voraussetzungen

- Node.js mit npm
- Rust mit dem Target `wasm32-unknown-unknown` (`rustup target add
  wasm32-unknown-unknown`); `wasm-pack` kommt als npm-Abhängigkeit mit
- für Tauri die [Tauri-Voraussetzungen](https://tauri.app/start/prerequisites/)
  der jeweiligen Plattform

### Erster Start

Die kompilierten WASM-Pakete (`src/engine/pkg*/`) sind nicht im Repository.
Nach dem Klonen einmal bauen:

```bash
git clone https://git.openbureau.ch/karim/DOSSIER-STANDALONE.git
cd DOSSIER-STANDALONE
npm install
npm run build:engine     # render2d
npm run build:engine3d   # render3d
npm run build:truck      # trucksolid
```

Nach Änderungen an Rust-Code die betroffene Crate erneut bauen.

### Befehle

```bash
npm run tauri:dev     # Tauri-Fenster (macOS: inkl. native2d; Opt-out: DOSSIER_NO_NATIVE2D=1)
npm run tauri:build   # App-Bundle bauen
npm run electron      # Electron-Fenster (Linux)
npm run dev           # nur Vite, http://localhost:5187
npm run build         # Typecheck + Produktions-Build
npm test              # Vitest
npx tsc -b            # nur Typecheck
```

Rust-Tests laufen je Crate mit `cargo test` im jeweiligen Verzeichnis unter
`src-tauri/`.

Änderungen am 3D-Viewport und an der nativen Plan-Fläche lassen sich nicht
zuverlässig headless prüfen — im laufenden `tauri:dev`-Fenster testen.

### Aufbau

```
src/
  model/       semantisches Modell (types), Wand-Anschlüsse, parametrische Wände,
               Raumstempel, Stiftsätze, Farbe/ICC, Gelände
  geometry/    2D-Kernel und Bauteil-Geometrie (Decke, Öffnung, Dach, Dach-Skelett,
               Treppe, Stütze, Raumfläche)
  commands/    Befehlssystem (Engine, Eingabe-Parser, Registry, cmds/ je Befehl)
  tools/       interaktive Werkzeuge, Fang, Transformationen
  editors/     reine Editier-Logik (Ausrichten, Explodieren, Booleans, Zwischenablage)
  plan/        Plan-Ableitung (generatePlan), Schnitt/Ansicht, 3D-Modell (toWalls3d),
               PlanView (SVG), glPlan (WebGL2), native2d-Anbindung
  viewport/    3D-Viewports (WebGPU „Nordstern", Three.js), 3D-Griffe
  views/       Zusammensetzen der Viewports (Grundriss, Schnitt, Ansicht, 3D)
  engine/      Laden der WASM-Crates (render3d, trucksolid)
  analysis/    Modellprüfungen (Kollision)
  export/      PDF, SVG, DXF, IFC, STEP, STL/OBJ, CSV
  io/          Import (DXF, DWG, STEP, PDF, Bilder, .lin/.pat), swisstopo, OSM, LV95,
               Projektdatei
  materials/   Materialbibliothek, ambientCG-Suche, PBR-Laufzeit
  overrides/   Regel-Engine für grafische Overrides
  state/       Store, Slices, Undo/Redo, Hooks der App-Shell
  panels/      Panel-System und die einzelnen Paletten
  ui/          App-Shell, Ribbon, Resource Manager, Dialoge, Befehlszeile
  native/      Tauri-spezifisch: Menüleiste, Zusatzfenster, Fensterrahmen
  text/        Schriftmetriken, Textrahmen, Rich-Text
  i18n/        Wörterbücher de/en
  update/      Selbst-Update
src-tauri/     Tauri-Host + Rust-Crates (siehe oben)
scripts/       Shell-Starter (Electron/Chromium), Benchmarks, Browser-Probes
website/       Dokumentations-Website (Hugo)
```

### Konventionen

- **Bezeichner englisch**, an Vectorworks-Begriffe angelehnt (Design Layer,
  Component, Hatch, Wall Style); Kommentare deutsch.
- **UI-Texte** stehen nie im Code, sondern immer über `t('key')` in
  `src/i18n/`.
- **Einheiten**: intern immer Meter; Anzeige über `formatM`. Der STEP-Export
  schreibt Millimeter.
- Neue Befehle sind additiv: Modul unter `src/commands/cmds/` anlegen und in
  `registry.ts` eintragen.

## Dokumentation

Eine ausführliche Anleitung (Installation, erste Schritte, Bauteile,
Befehlssystem, Layouts, Import/Export, Fehlerbehebung) und eine
Entwickler-Dokumentation entstehen unter [`website/`](website/) (Hugo,
Hextra-Theme, Ziel: `dossier.openbureau.ch`).

## Lizenz

Copyright © 2026 Karim Gabriele Varano. Veröffentlicht unter der
**GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)** —
siehe [LICENSE](LICENSE).

Die AGPL verlangt, dass auch beim Betrieb als Netzwerkdienst der (gegebenenfalls
geänderte) Quellcode für die Nutzer verfügbar gemacht wird. Drittkomponenten
behalten ihre eigenen Lizenzen (siehe „Über"-Dialog in der App); die
gebündelten ambientCG-Materialien stehen unter CC0 1.0.
