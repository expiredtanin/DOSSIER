---
title: "DOSSIER"
---

DOSSIER ist ein CAD-Programm für Architektur. Man zeichnet in 2D wie in
anderen CAD-Programmen und modelliert das Gebäude aus Bauteilen: Wände, Decken,
Dächer, Treppen, Öffnungen, Räume. Grundriss, Schnitt, Ansicht, 3D und PDF
werden aus diesem Modell berechnet und nicht separat gezeichnet.

Es ist die eigenständige Neuimplementierung des Rhino-Plugins
[DOSSIER](https://git.openbureau.ch/karim/dossier), mit eigenem Datenmodell
und eigenen Renderern in Rust. Teil von [openbureau](https://openbureau.ch).

```text
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

## Stand

Version 0.1.0. Es gibt noch keine Installer, DOSSIER wird aus dem Quellcode
gebaut. Es läuft auf macOS (Tauri) und Linux (Electron), im Browser mit
Einschränkungen.

Rund 119 000 Zeilen TypeScript und 23 000 Zeilen Rust, etwa 1 900 Vitest- und
180 Rust-Tests.

## Bauen

Voraussetzungen: Node.js, Rust mit dem Target `wasm32-unknown-unknown`, für
Tauri die [Tauri-Voraussetzungen](https://tauri.app/start/prerequisites/).

```bash
git clone https://git.openbureau.ch/karim/DOSSIER-STANDALONE.git
cd DOSSIER-STANDALONE
npm install
npm run build:engine && npm run build:engine3d && npm run build:truck
npm run tauri:dev     # macOS
npm run electron      # Linux
```

Details unter [Installation](/docs/anleitung/installation/).

## Was drin ist

- **Bauteile:** Wände mit Schichten und Verschneidung nach Priorität, Fenster
  und Türen, Decken, Dächer, Treppen, Stützen, Räume nach SIA 416
- **2D:** Zeichnen und Bearbeiten, Bemassung, Text, Schraffuren
- **Befehlszeile** mit rund 55 Befehlen und getippten Koordinaten: `5,3`,
  `r5,3`, `5<45`
- **Ansichten:** Grundriss je Geschoss, Schnitt, Ansicht, 3D mit Schnittebene
- **Pläne:** Layouts mit mehreren Ansichtsfenstern, Plankopf, mehrseitiges PDF
- **Volumenkörper:** B-Rep über [truck](https://github.com/ricosjp/truck),
  Booleans, Kollisionsprüfung
- **Import:** DXF, DWG, STEP, PDF, Bilder, swisstopo, OpenStreetMap
- **Export:** PDF, SVG, DXF, IFC4, STEP, STL, OBJ, CSV

Die vollständige Liste steht im
[README](https://git.openbureau.ch/karim/DOSSIER-STANDALONE).

## Was fehlt

- DWG und DXF werden gelesen, aber noch nicht in Wände und Öffnungen
  übersetzt. DWG schreiben geht nicht.
- `make2D`: eine 3D-Sicht als flache 2D-Zeichnung ausgeben.
- Öffnungen werden als achsparallele Löcher aus der Wand geschnitten, nicht
  über allgemeine Booleans.
- Dachfenster.

## Log

{{< log >}}

## Kontakt

Fehler und Wünsche als
[Issue](https://git.openbureau.ch/karim/DOSSIER-STANDALONE/issues), Fragen im
[Forum](https://dossier.openbureau.ch/forum).

## Lizenz

[AGPL-3.0-or-later](https://git.openbureau.ch/karim/DOSSIER-STANDALONE/src/branch/master/LICENSE).
Wer DOSSIER verändert und als Netzwerkdienst betreibt, muss den geänderten
Quellcode den Nutzern zugänglich machen. Die mitgelieferten Materialien von
ambientCG stehen unter CC0.
