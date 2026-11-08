# src/state

Zustand der Oberfläche: ein Store mit Slices, Hooks, die `App.tsx` entlasten, und reine Logik ohne React
(Ansichtsvorlagen, Ausschnitte, Auswahl). Das Projekt selbst lebt im Rust-Kern; der Store hält davon nur
die **Leseansicht** (`project`) und ändert sie ausschliesslich über Ops, die der Kern angenommen hat.

Kein Zustand-/Redux-Paket: `store.ts` ist ein kleiner eigener Store auf `useSyncExternalStore`.
Komponenten lesen mit `useStore(selector)` nur ihren Ausschnitt.

## Store und Slices

| Datei | Inhalt |
|---|---|
| `store.ts` | `createStore()`: der Store-Kern (Slices, `set`/`get`, selektives Lesen) |
| `appStore.ts` | setzt die Slices zu einem Gesamtzustand zusammen, exportiert `useStore`, `getState`, `setState` |
| `projectSlice.ts` | `project` (Leseansicht), `applyChange()`, `setProject()`, Befehls- und Griff-Commits, `loadProject()`, `openProjectFile()` und die Projekt-Aktionen |
| `historySlice.ts` | Undo/Redo, Sprung im Verlauf, `groupChanges()` (mehrere Änderungen = ein Schritt) |
| `selectionSlice.ts`, `selection.ts` | Auswahl als ein Wert (`Selection`, je Element-Art eine Menge) |
| `viewSlice.ts` | Darstellung ohne Modell: aktive Ebene, Massstab, Detailgrad, Schwarz-Weiss … |
| `layoutSlice.ts` | Panel-Layout (Docks, Tabs, schwebende Fenster) |
| `siteSlice.ts`, `notifySlice.ts` | Kontext-Objekte; Kurzmeldungen (`notify()`) |
| `busyStore.ts`, `cursorStore.ts`, `liveScaleStore.ts` | hochfrequente oder globale Werte ausserhalb von React-State |

## Verdrahtung (aus `App.tsx` herausgelöst)

| Datei | Inhalt |
|---|---|
| `useCommandEngineHost.ts` | Host der Befehls-Engine: Kontext, Fang, Vorschau, Commit in den Store |
| `useGripEditing.ts`, `useGrip3dEditing.ts` | Griffe in 2D und 3D; die Rechnung je Mausschritt liegt im Kern (`grips.rs`, `grip_drag.rs`) |
| `useMouseSelectionHandlers.ts` | Auswahl und Kontextmenü aus Grundriss und 3D |
| `useKeyboardShortcuts.ts`, `keyboardShortcuts.ts`, `commandKeys.ts` | Tastenkürzel, Esc/Enter laufender Befehle |
| `useDisplayResolvers.ts` | sichtbar, gedimmt, gesperrt je Ebene und Kategorie |
| `usePanelHostBase.ts` | Host-Wert für die Panels |
| `useProjectFileActions.ts`, `useImportHandling.ts`, `useExportHandlers.ts` | Datei öffnen und speichern, Importe, Plan-Export |
| `useSheetPane.ts` | offenes Layout-Blatt |

## Reine Logik

| Datei | Inhalt |
|---|---|
| `selectionInfo.ts` | Objekt-Info der Auswahl (Fassade über den Kern, `selection_info.rs`) |
| `viewTemplates.ts` | Ansichtsvorlagen als Ops |
| `viewSnapshots.ts`, `viewSnapshotFolders.ts`, `viewTabs.ts` | Ausschnitte, ihre Ordner, Zeichnungs-Reiter |
| `groupActions.ts` | Gruppen erzeugen, auflösen, betreten |
| `exportScope.ts`, `objectLock.ts` | Export „nur Auswahl"; Objekt-Sperre |
| `autosave.ts`, `projectStore.ts`, `recentProjects.ts`, `startupGuard.ts` | Autosave und Wiederherstellen, IndexedDB, zuletzt geöffnet, Start-Protokoll |
| `aiAccess.ts` | KI-Zugriff auf das offene Projekt (`[9]`) |

## Regeln

- Das Projekt ändert sich nur über Ops: `applyChange(ops | (p) => ops, coalesceKey?)` mit den Helfern aus
  `src/core/opsBuild.ts`. Kein direktes Setzen von `project`.
- Öffnen und Neu über `openProjectFile()` bzw. `loadProject()`; danach ist der Verlauf leer.
- macOS-Nebenfenster (`src/native/*WindowApp.tsx`) haben keinen gemeinsamen Store; ihr Zustand läuft über
  die Sync-Brücken in `src/native/`.
