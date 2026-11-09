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
Bildschirm, PDF, SVG und DXF lesen denselben Plan-Puffer. Datenflüsse im
Einzelnen (Weg eines Grundrisses, Schnitt, 3D, IFC, eine Benutzeraktion) und ein
Glossar stehen in
[`doc/ARCHITEKTUR.md`](https://github.com/expiredtanin/DOSSIER/blob/master/doc/ARCHITEKTUR.md).

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

Die Crates in `src-tauri`, die Ordner unter `src` und was wohin gehört, steht an einer Stelle:
[`doc/ARCHITEKTUR.md`](https://github.com/expiredtanin/DOSSIER/blob/master/doc/ARCHITEKTUR.md) (Abschnitt „Die Crates in `src-tauri`") und die
Modulkarte in [`CLAUDE.md`](https://github.com/expiredtanin/DOSSIER/blob/master/CLAUDE.md). Ausserdem hat jeder grosse Ordner eine kurze
`README.md` mit einer Zeile je wichtiger Datei, zum Beispiel
[`src/plan`](https://github.com/expiredtanin/DOSSIER/blob/master/src/plan/README.md), [`src/panels`](https://github.com/expiredtanin/DOSSIER/blob/master/src/panels/README.md) und
[`src-tauri/core/src`](https://github.com/expiredtanin/DOSSIER/blob/master/src-tauri/core/src/README.md).

Grob: `src-tauri/core` ist der Rust-Kern, `render2d` und `render3d` sind die Anzeige-Engines, `fileio` liest und
schreibt Dateiformate, `trucksolid` rechnet B-Rep, `src-tauri/src` ist die Tauri-App. `src` ist die
Oberfläche und die dünne TypeScript-Seite des Kerns, `e2e` die Oberflächentests, `website` diese Seite.

## Plattformen

- **macOS (Tauri):** WKWebView für die Oberfläche; den Grundriss zeichnet die
  Tauri-Seite zusätzlich nativ über Metal in eine Fläche unter der Webansicht.
- **Linux (Electron):** Chromium mit WebGPU; die Engines laufen als WASM.
  Tauri unter Linux (WebKitGTK) hat kein verlässliches WebGPU.
- **Browser:** wie Electron, für Entwicklung und e2e-Tests.

Es gibt bewusst keinen Ersatz-Renderer ohne WebGPU [46]: lieber eine klare
Meldung als ein zweiter Zeichenweg. Über der GPU-Fläche liegt im Plan eine
SVG-Ebene für Auswahl, Griffe, Fang und Text; läuft kein GPU-Weg, zeichnet sie
den ganzen Plan (Rückfall, `?gl=0`). SVG als Datei entsteht getrennt im Kern.

## Sicherheit

- Content-Security-Policy aus einer Quelle (`scripts/csp.cjs`):
  `script-src 'self' 'wasm-unsafe-eval'`, keine fremden Skripte [117].
- Speichern atomar über einen Rust-Befehl [116]; Dateisperre gegen
  doppeltes Öffnen.
- KI-Zugriff nur nach ausdrücklichem Einschalten, nur 127.0.0.1, mit
  Schlüssel.
