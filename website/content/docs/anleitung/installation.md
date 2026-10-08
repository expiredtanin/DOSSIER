---
title: "Installation"
linkTitle: "Installation"
weight: 1
---

DOSSIER ist eine **Desktop-App**. Es gibt noch keine fertig gepackten
Installer-Downloads — momentan baut man aus dem Quellcode. Auf macOS aktualisiert
sich eine laufende App danach selbständig (Tauri-Updater).

## Voraussetzungen

- [Node.js](https://nodejs.org/) (für `npm`)
- Für native Fenster zusätzlich [Rust](https://www.rust-lang.org/) — Tauri
  (macOS) bzw. die Rust-Toolchain für die WASM-Engines

## macOS — Tauri (empfohlen, natives Ziel)

```bash
git clone https://git.openbureau.ch/karim/DOSSIER-STANDALONE.git
cd DOSSIER-STANDALONE
npm install
npm run tauri:dev
```

Öffnet ein randloses natives Fenster mit eigener Titelleiste. macOS nutzt
WKWebView mit WebGPU — beide eigenen Rendering-Engines (`render2d`/`render3d`)
laufen hier im Standardpfad.

## Linux — Electron

```bash
npm install
npm run electron
```

Linux läuft über eine Electron/Chromium-Shell statt Tauri: WebKitGTK (Tauris
Linux-Webview) bietet kein zuverlässiges WebGPU, das die beiden
Rust/WASM-Renderer brauchen. Electron/Chromium liefert WebGPU zuverlässig,
gleiche React-Codebasis, eigene randlose Fenster.

## Browser (eingeschränkt)

```bash
npm run dev   # Vite, http://localhost:5187
```

Läuft auch im normalen Browser — ohne native Fenster-Integration und ohne
echtes Dateisystem (Projekte lassen sich nicht über native Speichern/Öffnen-
Dialoge verwalten, `.obp`-Dateien mit OS-Level-Lock entfallen).

## WASM-Engines neu bauen

Nur die `.rs`-Quellen werden committet, die kompilierten WASM-Pakete
(`src/engine/pkg*/`) sind gitignored. Nach Änderungen an Rust-Code:

```bash
npm run build:engine     # render2d
npm run build:engine3d   # render3d
npm run build:truck      # trucksolid (CSG/Extrusion)
```

Details zu allen Rust-Crates: [Technik-Stack](../entwickler/technik-stack/).
