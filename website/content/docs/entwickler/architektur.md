---
title: "Architektur"
linkTitle: "Architektur"
weight: 1
---

## Grundgedanke: ein Modell

Ein semantisches Modell – das `Project` – ist die einzige Wahrheit. Grundriss,
Deckenspiegel, Schnitt, Ansicht, 3D, Mengen, Listen und alle Exporte werden
daraus **abgeleitet** und nie gespeichert oder von Hand nachgeführt. Intern
wird in Metern gerechnet, Strichstärken sind Papier-Millimeter.

Der Grundriss wird analytisch aus den Bauteilparametern erzeugt (Wandachse,
Schichten, Öffnungen, Anschlüsse nach Priorität), nicht aus einem 3D-Netz
geschnitten. Schnitte verschneiden die Bauteile nach derselben Priorität.
Bildschirm, PDF, SVG und DXF lesen denselben Plan-Puffer.

```text
                        ┌──────────────────────────────┐
  UI (React/TS)  ──Ops──▶  Rust-Kern: Dokument, Ops,   │
  Leseansicht   ◀─Ops───  Prüfung, Undo/Redo            │
                        └──────┬───────────────────────┘
                               │ Abfragen (doc_query*)
     ┌──────────┬──────────────┼──────────────┬───────────────┐
     ▼          ▼              ▼              ▼               ▼
 Grundriss   Schnitt/      3D-Modell      Kennzahlen,     Export
 Plan-Puffer Ansicht       (Netze)        Listen          DXF/DWG/IFC/
     │          │              │                          STEP/PDF/SVG
     └────┬─────┘              ▼
          ▼                render3d (Metal / WebGPU)
     render2d (Metal / WebGPU), SVG, PDF
```

## Kern und Hülle

Seit dem Entscheid vom 27.10.2026 wandert der ganze Kern nach Rust; die
Oberfläche bleibt React/TypeScript. Die Etappen K0–K4 (Lader, 2D-Geometrie,
Geometrie-Ableitungen, Plan/Schnitt/Ansicht, Modell und Ops) sind
abgeschlossen; Restlogik wird laufend nachgezogen [128].

- **Kern** (TypeScript-Seite): `src/model`, `geometry`, `plan`, `io`,
  `export`, `analysis`, `materials`, `text`, `engine`, `net`, `core`. Das
  sind heute überwiegend **dünne Fassaden** über den Rust-Kern mit
  unveränderten Signaturen.
- **Hülle**: `src/ui`, `panels`, `views`, `menus`, `editors`, `viewport`,
  `native`, `tools`, `state`, `commands`, `App`.

Harte Grenze, geprüft vom Test `src/core/boundary.test.ts`:

- Der Kern importiert nie aus der Hülle und nie React, Zustand oder Tauri.
- Die Hülle holt Funktionen aus `plan/` und `geometry/` nur über die Fassade
  `src/core` (`index.ts`, `extra.ts`; neue Exporte von Hand eintragen).
- `dossier-cli` (`src/cli/main.ts`) importiert nur `../core`.
- Netzwerk nur über `src/net` (`netFetch`, Offline-Modus, Host-Liste).

## Modulkarte

| Ort | Inhalt |
|---|---|
| `src-tauri/core` | Crate `dossier-core`: Dokument, Ops, Verlauf, Projektformat; Plan/Schnitt/Ansicht (`plan/`), 3D-Modell, Export-Sammler, Text-Layout, Griffe, Objekt-Info, Befehle, Ebenen, Stifte, Layouts; Geometrie (Booleans, Dächer, Treppen, Wand-Anschlüsse, Gelände, Schatten, Baurecht, Kennzahlen, U-Wert) |
| `src-tauri/kernel2d` | 2D-Geometrie: Offset, Trim, Fillet, Split, Join (in `core` eingebunden) |
| `src-tauri/hatchgen` | Schraffur- und Linienmuster-Geometrie |
| `src-tauri/render2d` | 2D-Anzeige (Pläne, Blätter) |
| `src-tauri/render3d` | 3D-Anzeige; `render_png` für Headless-Bilder |
| `src-tauri/trucksolid` | B-Rep über truck 0.6: Körper, Booleans, STEP, Kennwerte, Kollision; eigenes WASM |
| `src-tauri/fileio` | Dateiformate: DXF/DWG (acadrust), IFC, PDF, Meshes, Punktwolken, Tabellen; eigenes WASM, nachgeladen |
| `src-tauri/src` | Tauri-App: Fenster, Menüs, atomares Speichern, Dateisperre, native Metal-Anzeige |
| `src/model` | Typen (generiert aus Rust), Fassaden, Ansichtstypen |
| `src/plan` | Fassaden `generatePlan`, `toSection`, `toElevation`; Plan-Puffer lesen; Goldens |
| `src/views/plan`, `src/viewport` | Plan-Ansicht und 3D-Viewport mit Renderer-Hooks, Raycast, Griffen |
| `src/commands` | Befehls-Engine, Registry, Befehle als Zustandsautomaten |
| `src/state` | Store (Zustand), Autosave, Datei- und Export-Aktionen, Tastenkürzel |
| `src/panels`, `src/ui` | Dock-Panels und Dialoge |
| `src/io`, `src/export` | Import/Export-Fassaden, Projektformat, PDF |
| `src/native` | Tauri-Adapter (Dateien, Fenster, Menü, Farbprofile), Nebenfenster |
| `src/engine` | WASM-Lader (`coreWasm.ts`, `engine3d.ts`, `truckSolid.ts`, `fileioWasm.ts`) |
| `src/cli` | `dossier-cli` |
| `e2e` | Oberflächentests (Playwright) |
| `website` | diese Website (Hugo) |

## Plattformen

- **macOS (Tauri):** WKWebView für die Oberfläche; Plan und 3D zeichnet die
  Tauri-Seite nativ über Metal in eine Ebene unter der Webansicht.
- **Linux (Electron):** Chromium mit WebGPU; die Engines laufen als WASM.
  Tauri unter Linux (WebKitGTK) hat kein verlässliches WebGPU.
- **Browser:** wie Electron, für Entwicklung und e2e-Tests.

Es gibt bewusst keinen Ersatz-Renderer ohne WebGPU [46]: lieber eine klare
Meldung als ein zweiter Zeichenweg. Für den Plan gibt es einen SVG-Weg, der
für Interaktion, Export und Tests genutzt wird.

## Sicherheit

- Content-Security-Policy aus einer Quelle (`scripts/csp.cjs`):
  `script-src 'self' 'wasm-unsafe-eval'`, keine fremden Skripte [117].
- Speichern atomar über einen Rust-Befehl [116]; Dateisperre gegen
  doppeltes Öffnen.
- KI-Zugriff nur nach ausdrücklichem Einschalten, nur 127.0.0.1, mit
  Schlüssel.
