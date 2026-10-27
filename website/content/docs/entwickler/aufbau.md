---
title: "Aufbau"
linkTitle: "Aufbau"
weight: 5
---

```text
src/
  model/       semantisches Modell (types, joins, parametricWalls, roomStamp, terrain)
  geometry/    2D-Kernel (offset/trim/fillet/intersect, ceiling/opening/roomArea/stair/roof/column)
  commands/    Rhino-artiges Befehlssystem (engine, parser, registry, cmds/)
  tools/       interaktive Zeichenwerkzeuge, Snapping, Transformationen
  plan/        Grundriss-Ableitung (generatePlan) + PlanView (SVG) + glPlan (WebGL2) + Rust-Bindings
  viewport/    Viewport3D (Three.js) + Wasm3DViewport (Rust/wgpu „Nordstern", Default)
  export/      IFC4-, PDF-, DXF-, STL/OBJ-, CSV-Export aus derselben Plan-/Modell-Struktur
  materials/   ambientCG-Live-Suche + gebündelte Starter-Bibliothek + PBR-Runtime
  panels/      dockbares Panel-System + die einzelnen Paletten
  state/       eigener Store (useSyncExternalStore) + Slices (project/selection/view/layout/…)
  native/      Tauri-only: native Fenster, macOS-Menüleiste, Fenster-Chrome
  ui/          App.tsx-Shell, Top-Bar, Resource Manager, Kontextmenü, Kommandozeile, Ribbon
  io/          Import/Export (DXF, DWG, .lin, .pat), Swisstopo/LV95, OSM-Kontext
  i18n/        Wörterbücher de/en
src-tauri/     Rust-Crates (render2d/render3d/geometry/kernel2d/trucksolid/dwgimport),
               je headless UND per wasm-pack baubar, plus der Tauri-Host selbst
```
