# Dossier — Arbeitsregeln für Agenten

CAAD-Desktop-App (Tauri/macOS, Electron/Linux). Ein semantisches Modell (`Project`) ist die einzige
Wahrheit; Grundriss, Schnitt, Ansicht und 3D werden daraus abgeleitet. Anzeige nur über die zwei
Rust-Engines `render2d` und `render3d` (WebGPU/Metal) — kein three.js, kein WebGL, kein Browser-Betrieb.

## Vor jedem Abschluss

```
npm run check            # tsc, vitest, cargo test aller 6 Crates  (--fast: ohne Rust)
npm run build:cli        # nur nötig, wenn src/cli oder src/core geändert wurden
```

WASM-Pakete (`src/engine/pkg*`) sind nicht im Repo: vor vitest mit `npm run build:core|truck|engine3d|engine|dwgimport`
bauen. Test zuerst, dann Code. Ein Schritt endet mit grünen Tests und gelöschtem Altcode (keine Doppelspur).

## Rust-Kern (Umstellung läuft, Entscheid 27.10.)

Der Kern wandert vollständig nach Rust (`src-tauri/core`, Crate `dossier-core`): Etappe 0 Lader ·
1 2D-Geometrie · 2 Geometrie-Ableitungen · 3 Plan/Schnitt/Ansicht · 4 Modell und Ops; die UI bleibt TSX.
**Neuer Kern-Code entsteht in Rust**, nicht in TS. Wer eine TS-Kernfunktion portiert, löscht die TS-Fassung
im selben Schritt (keine Doppelspur). Geladen wird der Kern einmal (`engine/coreWasm.ts`: App `initCore()`
vor dem Rendern, CLI mit Byte-Provider, Vitest per Setup-Datei), danach synchron über `core()`. Daten über
die Grenze als flache `Float64Array`s. truck (`trucksolid`) bleibt eigenes WASM-Modul (Panic-Isolation).

## Architektur (harte Grenze, vom Test `src/core/boundary.test.ts` geprüft)

- **Kern**: `model/ geometry/ plan/ io/ export/ analysis/ materials/ text/ engine/ net/ core/` — importiert nie
  `ui panels views menus editors viewport native tools state commands App`, nie React/Zustand/Tauri.
- **Hülle** (UI/Interaktion/Darstellung) holt Funktionen aus `plan/` und `geometry/` nur über die Fassade
  `src/core` (`index.ts` erzeugt von `scripts/core-facade.py`, Handgepflegtes in `core/extra.ts`).
- **Das Projekt ändert sich nur über Ops** (`core/ops.ts`): `setProject(fn)` übersetzt die Änderung in
  `CoreOp`s, validiert und wendet sie an. Ops sind JSON; NaN/doppelte ids werden zurückgerollt.
- `dossier-cli` (`src/cli/main.ts`) importiert nur `../core`; `npm run build:cli` → `dist-cli/`.
- Verschieben von Modulen: `scripts/move-modules.py alt=neu …` (schreibt alle Importe um).

## Modulkarte

| Ort | Inhalt |
|---|---|
| `src/model` | Typen (`types.ts`), Wand/Decke/Dach-Logik, Verbindungen, Ansichts-Typen (`viewTypes.ts`) |
| `src/geometry` | reine Geometrie: Dach-Skelett (`roofSkeleton.ts`), kernel2d-Fassade, Treppen, Räume |
| `src/plan` | Ableitung: `generatePlan`, `toSection`, `toElevation`, `toWalls3d`, `toRenderScene`, `voids.ts` |
| `src/views/plan` | React-Plan-Ansicht, Renderer-Hooks (native Metal / WASM-WebGPU) |
| `src/viewport` | 3D-Viewport (`Wasm3DViewport`), Raycast, Griffe |
| `src/state` | Zustands-Store (`projectSlice.ts`), Autosave, Export-/Datei-Aktionen |
| `src/commands` | Befehle (Zustandsautomaten) + `registry.ts`; `tools/` Zeichenwerkzeuge |
| `src/io`, `src/export` | Import/Export (DXF, IFC, STEP, OBJ, Swisstopo …), Projektformat (`projectFormat.ts`) |
| `src/native` | Tauri-Adapter (Dateien, Fenster, Menü, Farbprofile) |
| `src/net` | einziges Tor ins Netz (`netFetch`, Offline-Modus, Host-Liste) |
| `src-tauri/render2d, render3d` | die zwei Anzeige-Engines (Rust → WASM/Metal) |
| `src-tauri/trucksolid` | B-Rep (truck 0.6): Körper, Booleans, STEP, Kennwerte, Kollision |
| `src-tauri/core` | Rust-Kern (`dossier-core`): Polygon-Booleans (i_overlay), 2D-Kern (`kernel2d`), wächst etappenweise |
| `src-tauri/kernel2d, dwgimport` | 2D-Geometrie (Offset/Trim/Fillet/Split/Join, in `core` eingebunden; `geometry/kernel2d.ts` ist Fassade), DWG-Import |

## Konventionen

Bezeichner englisch, Kommentare und UI-Text deutsch, UI-Text nur über `t()` (de + en; Test
`src/i18n/untranslated.test.ts`). Intern Meter. Kein `window.alert/confirm/prompt` (im Tauri-WKWebView
stumm) → `notify()` oder Overlay-Dialog. Entfernte Abrufe nur über `netFetch`. Commits deutsch, ohne
Co-Authored-By-Zeile. Interne Planung (gitignored): `docs/*.md`, `PENDENZEN.md`.

## Ergebnis ansehen

Plan/Schnitt/Ansicht headless: `node dist-cli/dossier-cli.mjs projekt.obp plan --out eg.svg` und
Chromium-Screenshot. **3D headless:** `dossier-cli … model3d --out m.json`, dann
`src-tauri/target/release/render_png m.json out.png --view iso --style shaded-edges` (nativ über Metal;
vorher `npm run build:render-png`) und das PNG ansehen — kein Nutzer-Test nötig.
Headless-Browser-Tests laufen gegen `dist-test` auf Port 5188 (`vite build --outDir dist-test`).
