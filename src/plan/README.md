# src/plan

TS-Seite der Plan-Ableitungen. Gerechnet wird im Rust-Kern (`src-tauri/core/src/plan/`); hier liegen die
Fassaden, die den Kern fragen, und die Leser der Plan-Puffer. Die Hülle importiert diese Funktionen nur
über `src/core/index.ts`. Wie ein Grundriss entsteht: `doc/ARCHITEKTUR.md`, Abschnitt 3.

## Plan, Schnitt, Ansicht

| Datei | Inhalt |
|---|---|
| `generatePlan.ts` | `generatePlan()`, `generateVisibleLevelsPlan()`: Grundriss eines Geschosses aus der Kern-Abfrage `planDomains`; Typ `Plan` |
| `generatePlan/shared.ts` | Typ `Primitive` (Austauschformat aller Plan-Verbraucher), `HatchRender`, Detailgrad |
| `generatePlan/layerSig.ts` | Signatur der stilrelevanten Ebenen-Eigenschaften (Cache-Schlüssel) |
| `toSection.ts` | `computeSection()` (Körper-Netze über truck), `generateSectionPlan()` (Abfrage `sectionPlan`) |
| `toElevation.ts` | `generateElevationPlan()` (Abfrage `elevationPlan`) |
| `viewportPlan.ts` | Inhalt eines Layout-Viewports: Plan der Ebene, auf die sein Ausschnitt zeigt (mit verknüpfter Ansichtsvorlage) |
| `viewTemplate.ts` | [34] Ansichtsvorlage → Projekt/Anzeigewerte für Viewport und CLI (`projectWithTemplate`, `templateDisplay`) |
| `levelMarkers.ts` | automatische Höhenkoten in Schnitt und Ansicht |
| `presentationSheet.ts` | Präsentationsplan mit einem Klick (`[66]`) |
| `openingPreview.ts` | Vorschau im Fenster-/Tür-Dialog |

## Plan-Puffer lesen und weitergeben

| Datei | Inhalt |
|---|---|
| `planBuf.ts` | Leser (und Schreiber für gemischte Listen) des Plan-Puffers v2; `decodePlanBuf()`. Format im Dateikopf |
| `planLazy.ts` | `lazyPlan()`: Plan, dessen `primitives` erst beim ersten Zugriff entstehen |
| `planParts.ts` | `planParts()`, `withPlanParts()`: Plan als Abschnitte gehaltener Kern-Puffer für Kern-Verbraucher |
| `toRenderScene.ts` | `planSceneBin()` (render2d-Szene binär), `planToRenderScene()` (Szene als Objekte für Druck und CLI) |
| `nativeText.ts` | Texte für die native 2D-Engine |
| `pickLabels.ts`, `pickTypes.ts` | Namen und Formen für Auswahl und 3D-Raycast |

## Unterordner

| Ordner | Inhalt |
|---|---|
| `glPlan/` | GPU-Chunk-Cache (`glPlanChunks.ts`) und Fassaden der GPU-Kompilierung und Schraffur (`glPlanCompile.ts`, `glPlanHatch.ts`) für den nativen macOS-Weg |
| `planView/` | reine Helfer der Plan-Ansicht: Picken über den Kern-Index (`planPick.ts`), Culling, Marquee, Massstab |
| `toWalls3d/` | Teile der 3D-Ableitung, die TS bleiben: truck-Körper (`extrusions.ts`, `voids3d.ts`), gemeinsame Typen (`shared.ts`) |
| `__golden__/` | Referenz-Digests für `golden.test.ts` |

## 3D und Körper

| Datei | Inhalt |
|---|---|
| `toWalls3d.ts` | `projectToModel3d()`, `projectToModel3dParts()`: 3D-Modell aus dem Kern (`model3dParts`), Pick-Geometrie, Auswahl-Umrisse |
| `extrudedSolidSpec.ts` | `ExtrudedSolid` → B-Rep-Spezifikation für truck |
| `wallSpec.ts` | B-Rep-Spezifikation einer Wandschicht für truck |
| `voids.ts` | Abzugskörper (Fassade) |
| `surfaceOpening.ts` | Dach- und Deckenfenster: Lage in der Wirtsfläche |

## Tests

`golden.test.ts` vergleicht Plan, Schnitt, Ansicht und 3D beider Musterprojekte mit `__golden__/`.
Gewollte Änderung übernehmen: `npx vitest run -u src/plan/golden.test.ts`, Diff im Commit prüfen.
Die übrigen `*.test.ts` prüfen einzelne Fälle am Grundriss (`generatePlan.*.test.ts`), am Puffer und an
der 3D-Ableitung.
