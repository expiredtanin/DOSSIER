---
title: "Bauen und Testen"
linkTitle: "Bauen und Testen"
weight: 4
---

## Voraussetzungen

Node.js 22, Rust stable mit dem Ziel `wasm32-unknown-unknown`, `wasm-pack`;
für die Desktop-App auf dem Mac die Tauri-Voraussetzungen. Siehe
[Download und Installation](/download/).

## WASM-Pakete

Die Pakete unter `src/engine/pkg*` sind nicht im Repository und müssen vor
Vitest, CLI und App gebaut werden:

| Skript | Crate | Ausgabe |
|---|---|---|
| `npm run build:core` | `core` (Kern) | `src/engine/pkgCore` |
| `npm run build:fileio` | `fileio` | `src/engine/pkgFileIo` |
| `npm run build:engine` | `render2d` | `src/engine/pkg` |
| `npm run build:engine3d` | `render3d` | `src/engine/pkg3d` |
| `npm run build:truck` | `trucksolid` | `src/engine/pkgTruck` |

**Linux-Container:** Das System-`wasm-opt` ist dort oft zu alt; die Module
brechen dann beim Laden mit `Table.grow`. Abhilfe: ohne Optimierung bauen,
`npm run build:core -- --no-opt` bzw. `wasm-pack build … --no-opt`. Wer den
Kern direkt mit `wasm-pack` baut, ruft danach
`node scripts/build-core.mjs --patch-only` auf (ergänzt `__dossier_reinit`
für den Wiederanlauf nach einem Panic).

## Starten

```bash
npm run dev          # Vite, Browser, http://localhost:5187
npm run electron     # Linux: Electron-Fenster
npm run tauri:dev    # macOS: Tauri mit nativer Metal-Anzeige
npm run build:cli    # dist-cli/dossier-cli.mjs
```

## Prüfen

```bash
npm run check            # tsc, Vitest, cargo test aller Crates
npm run check -- --fast  # nur tsc und Vitest
npm run e2e              # Playwright-Suite gegen den Browser-Build (dist-test)
```

`npm run check` muss vor jedem Commit grün sein. Die Teile:

- **TypeScript** (`tsc --noEmit`).
- **Vitest**: Tests neben den Dateien (`*.test.ts`). Der Kern wird über
  `src/engine/coreWasm.setup.ts` geladen. Wichtige Wächter:
  `src/core/boundary.test.ts` (Architekturgrenze),
  `src/i18n/untranslated.test.ts` (fehlende Übersetzungen),
  `src/commands/hostile.test.ts` (alle Befehle mit Unsinn gefüttert).
- **cargo test** in jedem Crate; im Kern auch der Abgleich der generierten
  TS-Typen und der `KNOWN_KEYS`.
- **Golden-Tests** (`src/plan/golden.test.ts`): Grundriss je Geschoss,
  Schnitte, Ansichten und 3D beider Musterprojekte als lesbare Text-Digests
  (Zähler je Element-Art, Rahmen, Hash der gerundeten Zahlen, keine SVGs) in
  `src/plan/__golden__` [119]. Gewollte Änderungen:
  `npx vitest run -u src/plan/golden.test.ts` und den Diff im Commit prüfen.
- **IFC** gegen IfcOpenShell: `scripts/validate-ifc.py`
  (`pip install ifcopenshell pytest`); der Test
  `src/export/exportIfc.validate.test.ts` läuft nur, wenn es installiert ist.

## Oberflächentests

Die Suite in `e2e/` bedient die gebaute Web-App wie ein Mensch (Playwright,
Chromium headless): öffnet Projekte über das Menü, zeichnet, prüft
sichtbare Werte und Panels – nie Pixel, weil WebGPU headless nichts
Verlässliches zeichnet. Der Konsolen-Wächter lässt jeden Test scheitern, der
unerwartete Fehler loggt. Gemeinsame Helfer in `e2e/app.ts`.

## Ergebnis ansehen

Ausführlicher mit allen CLI-Befehlen: [`doc/ARCHITEKTUR.md`](https://github.com/expiredtanin/DOSSIER/blob/master/doc/ARCHITEKTUR.md), Abschnitt 11.

Zahlen allein reichen nicht. Plan, Schnitt und Ansicht headless:

```bash
node dist-cli/dossier-cli.mjs :musterhaus-komplex plan --level EG --scale 100 --hatch --out eg.svg
```

dann das SVG im Browser ansehen oder mit Playwright rastern. Das CLI-SVG hat
ohne `--hatch` keine Schraffurlinien (nur die Grundfüllung). 3D headless geht
nur auf macOS (`render_png`, siehe [Anzeige](../anzeige/)). Die App im Browser:
`npx vite build --outDir dist-test`, dann `npx vite preview --outDir dist-test`.

## CI

GitHub Actions (`.github/workflows/`):

| Workflow | Wann | Was |
|---|---|---|
| `check.yml` | Push und PR auf `master` | WASM bauen, `npm run check`, `build:cli`; Lizenzprüfung mit `cargo deny`; e2e-Suite als eigener Job |
| `macos.yml` | Push auf `master`; PRs mit Änderungen an `src-tauri/**` oder `src/views/plan/**`; von Hand | Tauri-App mit `native2d` prüfen, render2d/render3d-Tests, Golden-Bild auf Metal, 3D-Rauchtest mit `render_png` |
| `release.yml` | Tag `v*` | macOS-App (universal), Release-Entwurf mit Änderungsliste |

Ein Release entsteht aus einem Tag: Version in `src-tauri/tauri.conf.json`
anheben, committen, `git tag v0.2.0 && git push origin v0.2.0`. Ohne
Apple-Zertifikat entstehen unsignierte Artefakte; Signierung, Notarisierung
und Updater-Signatur kommen über Repository-Secrets (siehe README).

## Diese Website

Die Website liegt in `website/` (Hugo, ohne externe Themes oder CDNs).
Inhalt in `website/content/` als Markdown, Bilder in `website/static/img/`.

```bash
cd website && hugo server      # Vorschau
cd website && hugo --minify    # nach website/public
```

Die Bilder entstehen mit `dossier-cli … --hatch/--sketch/--ceiling` und
Screenshots des Browser-Builds.
