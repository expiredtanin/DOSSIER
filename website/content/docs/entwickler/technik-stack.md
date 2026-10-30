---
title: "Technik-Stack"
linkTitle: "Technik-Stack"
weight: 3
---

| | |
|---|---|
| Shell | **Tauri** auf macOS (WKWebView + WebGPU) · **Electron/Chromium** auf Linux (WebKitGTK kann kein WebGPU) — beide randlos, eigene Titelleiste, gemeinsame React-App |
| Frontend | React + TypeScript + Vite |
| 3D | eigener Rust/WASM/WebGPU-Renderer „Nordstern" (`render3d`, Default), Three.js als leichtgewichtiger Zweitpfad |
| 2D-Plan | eigener Rust/WASM/WebGPU-Renderer (`render2d`), plus ein TS/WebGL2-Renderer (`plan/glPlan`), plus SVG als Interaktions-/Fallback-Ebene |
| Geometrie | eigener 2D-Kernel (`src/geometry/kernel2d.ts`); ein Rust-Port existiert als Paritätstest |
| CSG/Extrusion | `trucksolid`-Crate (`truck` + `manifold-rust`) für das Extrude-Kommando |
| Export | eigener IFC4-Writer, `jspdf`/`svg2pdf.js` (Vektor-PDF), eigener DXF-Writer, STL/OBJ |
| Import | `acadrust` (DXF/DWG, Rust-Crate `src-tauri/fileio`), eigene `.lin`/`.pat`-Parser |
| Materialien | `jszip` (ambientCG-Zip-Entpacken), Three.js `TextureLoader` |

Alle Rust-Crates laufen sowohl headless als auch per `wasm-pack` gebaut.
