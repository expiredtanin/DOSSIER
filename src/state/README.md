# src/state

Zustand der Oberfläche: ein Store mit Slices, Hooks, die `App.tsx` entlasten, und reine Logik ohne React
(Ansichtsvorlagen, Ausschnitte, Auswahl). Das Projekt selbst lebt im Rust-Kern; der Store hält davon nur
die **Leseansicht** (`project`) und ändert sie ausschliesslich über Ops, die der Kern angenommen hat.

Kein Zustand-/Redux-Paket: `store.ts` ist ein kleiner eigener Store auf `useSyncExternalStore`.
Komponenten lesen mit `useStore(selector)` nur ihren Ausschnitt — möglichst schmal
(`s.project.drawingLevels` statt `s.project`), denn jede Op erzeugt ein neues `project`, aber nur die
geänderten Listen sind neu ([121]).

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

`App.tsx` ruft diese Hooks in fester Reihenfolge auf (Effekte laufen in dieser Reihenfolge) und reicht die
Ergebnisse weiter; Komponenten-Teile der App liegen in `src/ui/AppDialogs.tsx`, `HiddenFileInputs.tsx`,
`BootScreen.tsx`, `useTopBarElements.tsx`, `src/menus/AppContextMenu.tsx` und `src/panels/DockArea.tsx`.

| Datei | Inhalt |
|---|---|
| `useProjectActions.ts` | Projekt-Aktionen als Store-Actions (früh aufgerufen, nur Selektoren) |
| `useCommandEngineHost.ts` | Host der Befehls-Engine: Kontext, Fang, Vorschau, Commit in den Store |
| `useToolInput.ts` | Plan-Handler (`toolHandlers`), Werkzeugwahl, Ribbon-Befehle, 3D-Arbeitsebene → Engine |
| `useGripInputs.ts` | einzeln gewähltes Element je Art, Schnitt-/Ansichts-Blatt, Fang für Griffe |
| `useSelectionCommands.ts` | Befehle auf der Auswahl (Löschen, Split, Booleans, Stil, Sperren, Ebenen, Gruppen) samt Kürzeln |
| `useGripEditing.ts`, `useGrip3dEditing.ts` | Griffe in 2D und 3D; die Rechnung je Mausschritt liegt im Kern (`grips.rs`, `grip_drag.rs`) |
| `useCommandLineBinding.ts` | Befehlszeile und Cursor-HUD: Feld-Controller eines Griff-Drags oder die Engine |
| `useMouseSelectionHandlers.ts` | Auswahl und Kontextmenü aus Grundriss und 3D |
| `useKeyboardShortcuts.ts`, `keyboardShortcuts.ts`, `commandKeys.ts` | Tastenkürzel, Esc/Enter laufender Befehle |
| `useDisplayResolvers.ts` | sichtbar, gedimmt, gesperrt je Ebene und Kategorie |
| `useTextTarget.ts`, `useSectionLineState.ts`, `useStatusBarInfo.ts` | Text-Ziel der Formatierleiste; Objekt-Info, Schnittlinie, 3D-Live-Schnitt; Status-Leiste |
| `usePanelHostBase.ts`, `panelHost/` | Host-Wert für die Panels: Zusammenbau aus Teil-Bauern je Bereich (`toolsHost`, `selectionStyleHost`, `elementAttributesHost`, `siteHost`, `viewSnapshotsHost` + `viewState`, `layoutsHost`); `stableHost.ts` hält die Identität fest (Handler als Trampoline), solange sich kein Wert-Feld ändert |
| `useSelectionInfo.ts` | Objekt-Info der Auswahl für Panels (`useSelectionInfo()`) und App (`selectionInfoFor`), einmal je Projekt/Auswahl gerechnet, inhaltlich stabil |
| `useProjectFileActions.ts`, `useImportHandling.ts`, `useModelImport.ts`, `useExportHandlers.ts` | Datei öffnen und speichern, Importe (Bild, Drag & Drop; IFC/STEP/Mesh), Plan-Export |
| `useResourceHandlers.ts`, `useSettingsHost.ts` | Ressourcen-Fenster; Einstellungen, Offline, KI-Zugriff, Start-Protokoll |
| `useNativeWindowHosts.ts`, `useNativeMenu.ts` | native Nebenfenster und macOS-Menüleiste (ausserhalb von Tauri No-ops) |
| `useSheetPane.ts` | offenes Layout-Blatt |

## Reine Logik

| Datei | Inhalt |
|---|---|
| `selectionInfo.ts` | Objekt-Info der Auswahl (Fassade über den Kern, `selection_info.rs`) |
| `dataEqual.ts` | Strukturvergleich reiner Daten (Objekt-Info, Zustand der Nebenfenster) |
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
- Panels lesen Projektdaten selbst aus dem Store, nicht über den Panel-Host (der trägt nur Handler und
  kleine Ansichts-Werte); die Objekt-Info über `useSelectionInfo()`. So rendert eine Op nur die Panels,
  deren Daten sich geändert haben ([121], Messung `e2e/renderCount.spec.ts`).
- macOS-Nebenfenster (`src/native/*WindowApp.tsx`) haben keinen gemeinsamen Store; ihr Zustand läuft über
  die Sync-Brücken in `src/native/` (`windowBridge.ts`: erst ganz, dann nur geänderte Felder als Patch).
