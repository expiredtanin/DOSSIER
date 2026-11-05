---
title: "Für Entwickler"
linkTitle: "Für Entwickler"
weight: 2
---

Dossier ist ein Rust-Kern mit einer React/TypeScript-Oberfläche, verpackt mit
Tauri (macOS) oder Electron (Linux). Dieser Teil erklärt den Aufbau, wie man
baut und testet und wie man mitarbeitet. Die verbindlichen Arbeitsregeln für
Menschen und Agenten stehen in
[`CLAUDE.md`](https://github.com/expiredtanin/DOSSIER/blob/master/CLAUDE.md),
der Stand jeder Aufgabe in
[`TODO.md`](https://github.com/expiredtanin/DOSSIER/blob/master/TODO.md).

{{< cards >}}
  {{< card link="architektur" title="Architektur" subtitle="Ein Modell, Kern und Hülle, Modulkarte, harte Grenzen." >}}
  {{< card link="kern" title="Rust-Kern" subtitle="Dokument, Ops, Undo/Redo, Abfragen, Modell-Typen, WASM-Grenze." >}}
  {{< card link="anzeige" title="Anzeige und Geometrie" subtitle="render2d, render3d, Metal/WebGPU, Booleans: Manifold, truck, BSP." >}}
  {{< card link="bauen-testen" title="Bauen und Testen" subtitle="WASM-Pakete, npm run check, Golden-Tests, e2e, CI, CLI." >}}
  {{< card link="mitarbeiten" title="Mitarbeiten" subtitle="Arbeitsablauf, Konventionen, Commits, Übersetzungen, Lizenz." >}}
{{< /cards >}}

## In Zahlen (5.11.2026)

- rund 160 000 Zeilen Rust in acht Crates und 160 000 Zeilen TypeScript;
- rund 1 560 Rust-Tests, 320 Vitest-Dateien, 32 Playwright-Szenarien;
- Lizenz AGPL-3.0-or-later; Fremdcode mit Herkunft in `NOTICE`.
