# Dossier — Arbeitsregeln für Agenten

CAAD-Desktop-App für Architekt:innen (Tauri/macOS als Hauptplattform, Electron/Linux). Ein semantisches
Modell (`Project`) ist die einzige Wahrheit; Grundriss, Schnitt, Ansicht und 3D werden daraus abgeleitet.
Anzeige nur über die zwei Rust-Engines `render2d` und `render3d` (WebGPU/Metal) — kein three.js, kein WebGL.

## Arbeitsablauf (jeder Agent, jede Aufgabe)

1. **Lesen:** `TODO.md` (Arbeitsliste mit stabilen IDs wie `[63]`, Stand ✅ ◐ ○), dann diese Datei.
2. **Test zuerst**, dann Code. Rust: `cargo test` im Crate; TS: vitest neben der Datei (`*.test.ts`).
3. **Neuer Kern-Code in Rust** (s. „Rust-Kern"). Wer eine TS-Kernfunktion ersetzt, löscht die TS-Fassung
   im selben Schritt — keine Doppelspur, kein toter Code.
4. **Prüfen:** `npm run check` muss grün sein. Sichtbare Änderungen zusätzlich ansehen (s. „Ergebnis
   ansehen") — Zahlen allein reichen nicht.
5. **Abschliessen:** kleine Commits, Nachricht deutsch, beginnt mit den IDs (`[63] Baurecht: …`), ohne
   Co-Authored-By-Zeile. `TODO.md` im selben Commit nachführen (Stand + Datum + was offen bleibt).
6. **Ehrlich berichten:** was geprüft wurde und was nicht (z. B. „nicht in der Tauri-App getestet").

```
npm run check            # tsc, vitest, cargo test aller 6 Crates  (--fast: ohne Rust)
npm run build:cli        # nötig für dossier-cli, wenn src/cli oder der Kern geändert wurde
```

## Rust-Kern (Umstellung läuft, Entscheid 27.10.)

Der ganze Kern wandert nach Rust (`src-tauri/core`, Crate `dossier-core`); die UI bleibt TSX. Etappen
(`TODO.md`, [K0]–[K4]): Lader · 2D-Geometrie · Geometrie-Ableitungen · Plan/Schnitt/Ansicht · Modell+Ops.

- **Neues Rust-Modul:** `src-tauri/core/src/<modul>.rs` (+ `mod` in `lib.rs`), Bindungen in
  `src-tauri/core/src/web/<modul>.rs` (+ `mod` in `web/mod.rs`). TS-Seite als dünne Fassade mit
  unveränderter Signatur (Muster: `src/geometry/polygonBool.ts`), damit Aufrufer gleich bleiben.
- **Grenze:** Daten als flache `Float64Array`s (Kodierung `src-tauri/core/src/flat.rs`), kein JSON für
  Geometrie. Bindungen verwerfen Unsinn (NaN, leere/kaputte Puffer) mit leerem Ergebnis — nie Panic: ein
  Panic legt das ganze WASM-Modul lahm.
- **Laden:** einmal, dann synchron über `core()` (`src/engine/coreWasm.ts`): App `initCore()` vor dem
  ersten Render (`src/main.tsx`), CLI über den Byte-Provider, Vitest per `src/engine/coreWasm.setup.ts`.
- **Dokument im Kern** ([K4]): Der Kern hält das Projekt-Dokument, prüft Ops und führt Undo/Redo; Ableitungen
  (Plan, Schnitt, Ansicht, 3D, Exporte, Griffe, Objekt-Info, Befehle) fragen das Dokument ab (`doc_query*`,
  Wurzel-Abfragen). TS hält nur eine Leseansicht, die mit den angenommenen Ops nachgeführt wird (`applyOps`).
  Ausnahme zur JSON-Regel: Wurzel-Abfragen, Griffe und Befehle tauschen ganze Elemente als JSON.
- **truck** (`src-tauri/trucksolid`, 3D-B-Rep) bleibt eigenes WASM-Modul (Panic-Isolation, `guarded()`).
  2D-Flächen-Booleans laufen über den Kern (i_overlay), 3D-Körper über truck — nicht vermischen.
- **Bitgleich zu TS:** JS-Zahlsemantik über `jsnum.rs` (`Math.min/max/round`, ToInt32; `sin/cos/tan/atan2/acos/pow`
  im Web-Build über `Math` der JS-Engine) und `jsmath.rs` (`Math.hypot`); Rechenreihenfolge wie in TS.
- **Genauigkeit:** i_overlay rechnet auf einem Ganzzahlraster (≈ Ausdehnung/2³⁰); Tests mit 1e-6 m statt 1e-9.

## Architektur (harte Grenze, vom Test `src/core/boundary.test.ts` geprüft)

- **Kern**: `model/ geometry/ plan/ io/ export/ analysis/ materials/ text/ engine/ net/ core/` — importiert nie
  `ui panels views menus editors viewport native tools state commands App`, nie React/Zustand/Tauri.
- **Hülle** (UI/Interaktion/Darstellung) holt Funktionen aus `plan/` und `geometry/` nur über die Fassade
  `src/core`. Neue Exporte **von Hand** in `src/core/index.ts` bzw. `src/core/extra.ts` eintragen —
  `scripts/core-facade.py` nicht mehr laufen lassen (es baut die Fassade aus direkten Importen neu und
  würde sie heute fast leeren).
- **Das Projekt ändert sich nur über Ops** (Kern prüft und führt den Verlauf): `applyChange(ops | (p) => ops, coalesceKey?)`
  mit den Helfern aus `src/core/opsBuild.ts` (`patchItem`, `addItems`, `removeItems` …); Befehle liefern `opsMutation`.
  Mehrere Änderungen = ein Undo-Schritt über `groupChanges(fn, key?)`; gleicher `coalesceKey` (Regler, Tippen) ebenso.
  Öffnen/Neu über `openProjectFile`/`loadProject` (Kern lädt, Verlauf leer). Kein `diffToOps` mehr.
- **Modell-Typen kommen aus Rust** ([K4] S4): Neue Modellfelder/-typen NUR im Rust-Modell
  (`src-tauri/core/src/model/generated.rs`, `manual.rs`; serde- + ts-rs-Attribute, Regeln in `model/ts_export.rs`),
  dann `npm run gen:types` → `src/model/types.generated.ts` (nie von Hand ändern; `types.ts` re-exportiert sie und
  hält nur Hilfstypen/-funktionen). `cargo test` im Kern schlägt fehl, wenn die Datei veraltet ist. Neue
  `Project`-Felder zusätzlich in `KNOWN_KEYS` (`src-tauri/core/src/project_format.rs`; ein Test gleicht mit dem Modell ab).
- `dossier-cli` (`src/cli/main.ts`) importiert nur `../core`.
- **macOS-Nebenfenster** (Einstellungen, Ressourcen …, `src/native/*WindowApp.tsx`) sind eigene Dokumente
  ohne gemeinsamen Store: Zustand über die Sync-Brücke (z. B. `src/native/settingsWindow.ts`), nicht über
  `useStore`.

## Parallel arbeitende Agents

In der Cloud höchstens **3 Agents gleichzeitig** (Vorgabe Maintainer); neue erst starten, wenn einer
fertig ist. Modell je Aufgabe: Sonnet für mechanische, klar umrissene Portierungen; Opus für knifflige
Geometrie mit vielen Sonderfällen oder Architektur-Entscheide. Jeder Agent in eigenem Git-Worktree und eigenem Branch, nur die Dateien seiner Aufgabe. In gemeinsamen
Dateien (`lib.rs`, `web/mod.rs`, `Cargo.toml`, `src/core/index.ts`, `src/core/extra.ts`, `i18n/de.ts`,
`i18n/en.ts`, `TODO.md`) nur Zeilen ergänzen, nichts umordnen oder umformatieren. Nicht pushen — der
Koordinator führt zusammen, prüft und pusht. Im Worktree: `node_modules` verlinken und die WASM-Pakete
aus dem Hauptcheckout kopieren (beide gitignored).

## Umgebung

- **WASM-Pakete** (`src/engine/pkg*`) sind nicht im Repo: vor vitest mit `npm run build:core` sowie den
  übrigen `build:*`-Skripten in `package.json` bauen. In Linux-Cloud-Containern ist das System-`wasm-opt`
  zu alt (Module brechen mit `Table.grow`): dort `wasm-pack build … --no-opt` direkt aufrufen.
- **IFC-Prüfung:** `scripts/validate-ifc.py` (braucht `pip install ifcopenshell pytest`); der Test
  `src/export/exportIfc.validate.test.ts` läuft nur, wenn es installiert ist.
- **macOS** ist die Hauptplattform des Maintainers; Metal (`render_png`, native Ansicht) gibt es nur dort.
  Was nur im Linux-Container geprüft wurde, so benennen.

## Modulkarte

| Ort | Inhalt |
|---|---|
| `src/model` | Typen (`types.ts`, generiert aus Rust), dünne Fassaden über Kern-Logik, Ansichts-Typen (`viewTypes.ts`) |
| `src/geometry` | reine Geometrie: `kernel2d.ts` (Fassade über den Rust-2D-Kern), Treppen, Räume, Polygon-Booleans (`polygonBool.ts`), Aussenbemassung; `roof.ts` = Hülle um die Rust-Dachgeometrie |
| `src/analysis` | Kennzahlen/Raumprogramm, Sonnenstand/Schatten, Baurecht, Kollision |
| `src/plan` | dünne Fassaden über Kern-Abfragen (`generatePlan`, `toSection`, `toElevation`), Plan-Puffer lesen (`planBuf`, `planLazy`), `toRenderScene` |
| `src/views/plan` | React-Plan-Ansicht, Renderer-Hooks (native Metal / WASM-WebGPU) |
| `src/viewport` | 3D-Viewport (`Wasm3DViewport`), Raycast, Griffe |
| `src/panels` | Dock-Panels (Lage mit Schatten/Baurecht, Flächenbilanz mit Kennzahlen …) |
| `src/state` | Zustands-Store (`projectSlice.ts`), Autosave, Export-/Datei-Aktionen |
| `src/commands` | Befehle (Zustandsautomaten) + `registry.ts`; `tools/` Zeichenwerkzeuge |
| `src/io`, `src/export` | Import/Export (DXF, IFC, STEP, OBJ, Swisstopo …), Projektformat (`projectFormat.ts`) |
| `src/native` | Tauri-Adapter (Dateien, Fenster, Menü, Farbprofile) |
| `src/net` | einziges Tor ins Netz (`netFetch`, Offline-Modus, Host-Liste) |
| `src/engine` | WASM-Lader (`coreWasm.ts`, `engine3d.ts`, `truckSolid.ts`, `wasmSource.ts`) |
| `src-tauri/core` | Rust-Kern (`dossier-core`): Dokument, Ops, Verlauf, Projektdatei; Plan/Schnitt/Ansicht (`plan/`), 3D-Modell, Export-Sammler, Text-Layout, Griffe, Objekt-Info, Befehle (`commands.rs`), Ebenen/Gruppen/Stifte/Layouts; Geometrie (Booleans, Dächer, Treppen, Wand-Joins, Schatten, Baurecht, Kennzahlen) |
| `src-tauri/render2d, render3d` | die zwei Anzeige-Engines (Rust → WASM/Metal) |
| `src-tauri/trucksolid` | B-Rep (truck 0.6): Körper, Booleans, STEP, Kennwerte, Kollision |
| `src-tauri/kernel2d` | 2D-Geometrie (Offset/Trim/Fillet/Split/Join, in `core` eingebunden) |
| `src-tauri/fileio` | Dateiformate in Rust (DXF/DWG über acadrust, später IFC); eigenes WASM `pkgFileIo`, nachgeladen über `src/engine/fileioWasm.ts` |

## Konventionen

Bezeichner englisch, Kommentare und UI-Text deutsch, UI-Text nur über `t()` (de + en; Test
`src/i18n/untranslated.test.ts`). Intern Meter, Strichstärken in Papier-mm. Kein
`window.alert/confirm/prompt` (im Tauri-WKWebView stumm) → `notify()` oder Overlay-Dialog. Entfernte Abrufe
nur über `netFetch`. Übernommener Fremdcode: Herkunft im Dateikopf + `NOTICE` ([51]). Lokale, gitignorierte
Notizen: `docs/*.md`, `PENDENZEN.md` — was alle wissen müssen, gehört in `TODO.md` oder hierher.

## Ergebnis ansehen

Plan/Schnitt/Ansicht headless: `node dist-cli/dossier-cli.mjs projekt.obp plan --scale 100 --out eg.svg`
und Chromium-Screenshot (Playwright ist vorinstalliert). Weitere CLI-Befehle: `kennzahlen`, `sun --when …`,
`ifc`, `bench`. **3D headless (nur macOS):** `dossier-cli … model3d --out m.json`, dann
`src-tauri/target/release/render_png m.json out.png --view iso --style shaded-edges` (vorher
`npm run build:render-png`). App im Browser: `vite build --outDir dist-test`, Vorschau auf Port 5188.
