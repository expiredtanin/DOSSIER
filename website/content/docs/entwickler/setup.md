---
title: "Lokal einrichten"
linkTitle: "Lokal einrichten"
weight: 4
---

```bash
npm install
npm run dev        # Vite, http://localhost:5187
npm run tauri:dev  # Tauri-Fenster (macOS — nativer Zielrahmen dort)
npm run electron   # Electron-Fenster (Linux — WebGPU über Chromium statt WebKitGTK)
npx tsc -b         # Typecheck
npm run build      # tsc -b && vite build
npm test           # vitest run
```

Die WASM-Engines müssen nach Rust-Änderungen neu gebaut werden (nur `.rs`
committen, `src/engine/pkg*/` ist gitignored):

```bash
npm run build:engine     # render2d
npm run build:engine3d   # render3d
npm run build:truck      # trucksolid
```

Änderungen an `render3d`/`Wasm3DViewport` lassen sich nicht per Puppeteer oder
Headless-Browser verifizieren — im laufenden `tauri:dev`-Fenster selbst
testen.
