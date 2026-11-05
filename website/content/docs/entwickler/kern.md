---
title: "Rust-Kern"
linkTitle: "Rust-Kern"
weight: 2
---

Der Kern ist das Crate `dossier-core` in `src-tauri/core`. Er läuft als
WebAssembly in der App, in Electron, im Browser, in Vitest und in
`dossier-cli`, und nativ in der Tauri-App.

## Dokument, Ops, Verlauf

Der Kern **hält das Projekt-Dokument** (`document.rs`). Die Oberfläche hält
nur eine Leseansicht.

1. Eine Änderung ist eine Folge von **Ops** (`ops.rs`, Spiegel in
   `src/core/ops.ts`): Element anlegen, Felder setzen, entfernen ….
2. Der Kern wendet die Folge **atomar** an und **prüft** sie: keine NaN, keine
   doppelten IDs, Werte gegen das typisierte Modell. Abgelehnte Folgen werden
   vollständig zurückgenommen, mit Meldung.
3. Angenommene Ops gehen zurück an TS, das sie mit `applyOps` auf die
   Leseansicht anwendet. Es gibt kein zweites Dokument und keinen
   Differenz-Abgleich mehr [122].
4. Der **Verlauf** speichert je Schritt die Vorwärts- und die inversen Ops,
   keine Schnappschüsse. Undo/Redo, Sprung im Verlauf-Panel und
   Speichergrenze laufen im Kern.

In der Oberfläche ändert man das Projekt ausschliesslich so:

```ts
applyChange(ops | ((p) => ops), coalesceKey?)
```

mit den Helfern aus `src/core/opsBuild.ts` (`patchItem`, `addItems`,
`removeItems` …). Befehle liefern `opsMutation`. Mehrere Änderungen als ein
Undo-Schritt: `groupChanges(fn, key?)`; gleicher `coalesceKey` (Regler,
Tippen) fasst ebenfalls zusammen. Öffnen und Neu laufen über
`openProjectFile`/`loadProject` (Kern lädt, Verlauf leer).

## Abfragen

Alles Abgeleitete fragt das Dokument ab (`doc_query*`, Wurzel-Abfragen):
Plan, Schnitt, Ansicht, 3D, Exporte, Griffe, Objekt-Info, Befehle,
Kennzahlen. Zwischenergebnisse werden im Kern zwischengespeichert, etwa das
3D-Modell je Bauteil oder vernetztes Gelände [58].

## Modell-Typen kommen aus Rust

- Neue Felder und Typen nur im Rust-Modell
  (`src-tauri/core/src/model/generated.rs`, `manual.rs`) mit serde- und
  ts-rs-Attributen.
- `npm run gen:types` schreibt `src/model/types.generated.ts`; die Datei nie
  von Hand ändern. `cargo test` im Kern schlägt fehl, wenn sie veraltet ist.
- Neue `Project`-Felder zusätzlich in `KNOWN_KEYS`
  (`project_format.rs`).
- Das Dateiformat `.obp` ist versioniert (`formatVersion`); ältere Dateien
  werden beim Laden migriert, unbekannte Felder tolerant gelesen, Befehle aber
  streng geprüft.

## Die WASM-Grenze

- **Geometrie als flache `Float64Array`s**, kein JSON (Kodierung in
  `flat.rs`, z. B. Mehrfach-Polygone als
  `[n_polys, (n_rings, (n_pts, x0, y0, …)…)…]`). Ausnahme: Wurzel-Abfragen,
  Griffe und Befehle tauschen ganze Elemente als JSON.
- Bindungen liegen in `src-tauri/core/src/web/<modul>.rs`. Sie verwerfen
  Unsinn (NaN, leere oder kaputte Puffer) mit leerem Ergebnis – **nie
  Panic**, denn ein Panic legt das ganze WASM-Modul lahm.
- Geladen wird einmal, danach synchron über `core()`
  (`src/engine/coreWasm.ts`): App `initCore()` vor dem ersten Render, CLI über
  einen Byte-Provider, Vitest über `coreWasm.setup.ts`.
- Kommt es doch zu einem Panic (Trap), wirft `core()` einen `CoreTrapError`
  und startet im Hintergrund eine frische Instanz (`__dossier_reinit`, von
  `scripts/build-core.mjs` ergänzt); die Oberfläche wartet, baut sich neu auf
  und öffnet das Dokument aus der Leseansicht – der letzte angenommene Stand
  bleibt erhalten [118].
- TS-Fassaden behalten ihre Signaturen (Muster:
  `src/geometry/polygonBool.ts`), damit Aufrufer gleich bleiben. Wer eine
  TS-Kernfunktion nach Rust bringt, löscht die TS-Fassung im selben Schritt.

## Zahlen

- Trigonometrie, `pow` und `hypot` über das Crate `libm`: deterministisch auf
  allen Plattformen, ohne Aufruf in die JS-Engine.
- `jsnum.rs` behält JS-artige `min`/`max`/`round` wegen der NaN-Semantik
  (Rusts `f64::min`/`max` ignorieren NaN).
- 2D-Booleans (i_overlay) rechnen auf einem Ganzzahlraster; Tests
  vergleichen mit 1e-6 m.

## Neues Kern-Modul anlegen

1. Test zuerst (`cargo test` im Crate).
2. `src-tauri/core/src/<modul>.rs` und `mod` in `lib.rs`.
3. Bindung in `src-tauri/core/src/web/<modul>.rs` und `mod` in
   `web/mod.rs`.
4. TS-Fassade mit unveränderter Signatur; Export von Hand in
   `src/core/index.ts` bzw. `extra.ts`.
5. `npm run build:core`, `npm run check`.
