---
title: "Download und Installation"
description: "Dossier aus dem Quellcode bauen: macOS (Tauri), Linux (Electron), Browser für die Entwicklung."
---

Fertige Installer gibt es noch nicht. Die Release-Pipeline (macOS-App,
universal für Apple Silicon und Intel) steht, veröffentlichte Versionen
erscheinen künftig unter
[Releases auf GitHub](https://github.com/expiredtanin/DOSSIER/releases). Bis
dahin baut man Dossier aus dem Quellcode – das dauert beim ersten Mal einige
Minuten, weil der Rust-Kern und die beiden Anzeige-Engines zu WebAssembly
übersetzt werden.

## Plattformen

| Plattform | Hülle | Anzeige | Stand |
|---|---|---|---|
| macOS (Apple Silicon, Intel) | Tauri | nativ über Metal | Hauptplattform |
| Linux | Electron (Chromium) | WebGPU | läuft, ohne Release-Build |
| Browser (Chromium mit WebGPU) | – | WebGPU | für Entwicklung und Tests; ohne Dateisperre und native Dialoge |
| Windows | – | – | nicht geprüft |

Linux nutzt Electron statt Tauri, weil die WebKitGTK-Webansicht von Tauri unter
Linux kein verlässliches WebGPU bietet.

## Voraussetzungen

- [Node.js](https://nodejs.org/) 22 mit npm
- [Rust](https://rustup.rs/) (stable) mit dem Ziel `wasm32-unknown-unknown`
  (`rustup target add wasm32-unknown-unknown`)
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/) (`cargo install wasm-pack`)
- für die Desktop-App unter macOS die
  [Tauri-Voraussetzungen](https://tauri.app/start/prerequisites/) (Xcode
  Command Line Tools)

## Bauen und starten

```bash
git clone https://github.com/expiredtanin/DOSSIER.git
cd DOSSIER
npm install

# WASM-Pakete (nicht im Repository): Kern, Dateiformate, 2D-, 3D-Anzeige, B-Rep
npm run build:core && npm run build:fileio && npm run build:engine \
  && npm run build:engine3d && npm run build:truck

npm run tauri:dev     # macOS: Desktop-App
npm run electron      # Linux: Electron-Fenster
npm run dev           # nur Browser (http://localhost:5187)
```

Unter Linux-Containern mit veraltetem `wasm-opt` brechen die Module beim Laden
(`Table.grow`); dann ohne Optimierung bauen:
`npm run build:core -- --no-opt` (Details unter
[Bauen und Testen](/docs/entwickler/bauen-testen/)).

Eine eigenständige macOS-App baut `npm run tauri:build`. Ohne
Apple-Zertifikat ist sie unsigniert; macOS fragt beim ersten Start nach
(Rechtsklick → Öffnen).

## Kommandozeile

Die Kommandozeile `dossier-cli` braucht nur Node.js und die gebauten
WASM-Pakete:

```bash
npm run build:cli
node dist-cli/dossier-cli.mjs :musterhaus-komplex info
```

Mehr unter [Kommandozeile](/docs/anleitung/kommandozeile/).

## Aktualisieren

```bash
git pull
npm install
npm run build:core   # und die übrigen build:*-Skripte, wenn sich Rust geändert hat
```

Die Desktop-App unter macOS bringt einen Updater mit; er greift, sobald
signierte Releases veröffentlicht werden.

## Erste Schritte

Weiter mit [Erste Schritte](/docs/anleitung/erste-schritte/).
