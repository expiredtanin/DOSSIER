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
| `siteSlice.ts`, `notifySlice.ts` | Gelände-/Umgebungs-Elemente (`project.context`, [181]); Kurzmeldungen (`notify()`) |
| `busyStore.ts`, `cursorStore.ts`, `liveScaleStore.ts` | hochfrequente oder globale Werte ausserhalb von React-State |

## Verdrahtung (aus `App.tsx` herausgelöst)

`App.tsx` ruft diese Hooks in fester Reihenfolge auf (Effekte laufen in dieser Reihenfolge) und reicht die
Ergebnisse weiter; Komponenten-Teile der App liegen in `src/ui/AppDialogs.tsx`, `HiddenFileInputs.tsx`,
`BootScreen.tsx`, `useTopBarElements.tsx`, `ProjectSync.tsx`, `src/menus/AppContextMenu.tsx`,
`src/panels/DockArea.tsx` und `src/views/ViewportCenter.tsx`.

`App` abonniert das Projekt nicht ([121]): nur schmale Ausschnitte (Zeichnungsebenen, Ebenen-Baum, Name …).
Hooks in `App` lesen das Projekt in Handlern über `getState()` und im Render nur über schmale Selektoren.
Was das ganze Projekt im Render braucht, läuft in einer Komponente: Griffe, Zifferntasten und Befehlszeile in
`ViewportCenter`, Anzeige-Werte des Kontextmenüs in `AppContextMenu`, Gauben-Hinweis und Ressourcen-Fenster
in `ProjectSync`.

| Datei | Inhalt |
|---|---|
| `useProjectActions.ts` | Projekt-Aktionen als Store-Actions (früh aufgerufen, nur Selektoren) |
| `useCommandEngineHost.ts` | Host der Befehls-Engine: Kontext, Fang, Vorschau, Commit in den Store |
| `useToolInput.ts` | Plan-Handler (`toolHandlers`), Werkzeugwahl, Ribbon-Befehle, 3D-Arbeitsebene → Engine |
| `useGripInputs.ts` | einzeln gewähltes Element je Art, Schnitt-/Ansichts-Blatt, Fang für Griffe (in `ViewportCenter`) |
| `useSelectionCommands.ts` | Befehle auf der Auswahl (Löschen, Split, Booleans, Stil, Sperren, Ebenen, Gruppen) samt Kürzeln; `selectionMenuState` für die Anzeige im Kontextmenü |
| `useGripEditing.ts`, `useGrip3dEditing.ts` | Griffe in 2D und 3D (in `ViewportCenter`); die Rechnung je Mausschritt liegt im Kern (`grips.rs`, `grip_drag.rs`) |
| `useCommandLineBinding.ts` | Befehlszeile und Cursor-HUD (in `ViewportCenter`): Feld-Controller eines Griff-Drags oder die Engine |
| `useDormerNotice.ts` | Gauben-Hinweis (in `ProjectSync`, abonniert nur Dächer und Projekt-Id) |
| `useMouseSelectionHandlers.ts` | Auswahl und Kontextmenü aus Grundriss und 3D |
| `useKeyboardShortcuts.ts`, `keyboardShortcuts.ts`, `commandKeys.ts` | Tastenkürzel, Esc/Enter laufender Befehle |
| `shortcutOverview.ts`, `shortcutOverviewHook.ts` | [210] Kürzel-Übersicht (Hilfe → Tastaturkürzel …): Liste aus `SHORTCUT_DEFS` und der Befehls-Registry abgeleitet, nichts von Hand gepflegt; Anzeige `ui/ShortcutOverviewDialog.tsx` |
| `modalScope.ts` | [249] `isInModalDialog`: Ziele in `aria-modal`-Dialogen gehören dem Dialog, nicht den App-Kürzeln |
| `sheetGuides.ts`, `layoutImageActions.ts` | [208] Hilfslinien am Masterlayout und Aktionen für Bilder auf dem Blatt |
| `objectSettings.ts` | Taste T / Menü „Objekteinstellungen…" ([195]): öffnet das schwebende Fenster `object-settings` und klappt den passenden Abschnitt der Objekt-Info auf; `mixedValues.ts`: gemeinsamer Wert über die Mehrfachauswahl (abweichend = leer) |
| `useDisplayResolvers.ts` | sichtbar, gedimmt, gesperrt je Ebene und Kategorie |
| `useTextTarget.ts`, `useSectionLineState.ts`, `useStatusBarInfo.ts` | Text-Ziel der Formatierleiste; Schnittlinie, 3D-Live-Schnitt; Status-Leiste (je mit schmalen Selektoren) |
| `usePanelHostBase.ts`, `panelHost/` | Host-Wert für die Panels: Zusammenbau aus Teil-Bauern je Bereich (`toolsHost`, `selectionStyleHost`, `elementAttributesHost`, `siteHost`, `viewSnapshotsHost` + `viewState`, `layoutsHost`); `stableHost.ts` hält die Identität fest (Handler als Trampoline), solange sich kein Wert-Feld ändert. Projekt und Objekt-Info kommen beim Bau aus dem Store; die Fassung hinter den Trampolinen wird bei geändertem Projekt/Auswahl erst beim Aufruf neu gebaut |
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
| `viewSnapshots.ts`, `viewSnapshotFolders.ts`, `viewTabs.ts` | Ausschnitte, ihre Ordner, Zeichnungs-Reiter (mit dem Projekt als `uiState.viewTabs` gesichert, [136]); Reiter-Arten und Navigations-Regeln ([182]) |
| `traceRef.ts`, `traceActions.ts` | Pausfolie je Reiter ([205]): reine Zustandslogik (Ein/Aus, Quelle, Verschieben/Drehen) und Aktionen auf dem Store (Kürzel, Menü, Statusleiste, Navigator, Befehle `tracemove`/`tracerotate`) |
| `tabNavigation.ts` | Navigator/Grundriss-/3D-Knöpfe/Layouts wählen den passenden Reiter (`openLevel`, `switchViewType`, `openLayoutTab`, [182]) |
| `view3dFilter.ts` | 3D-Element-Filter ([185], rein UI): „Auswahl in 3D zeigen" (Cmd/Ctrl+3) und temporär ausgeblendete Elemente (Cmd/Ctrl+4); Geschoss-Kürzel Cmd/Ctrl+5/6 in `tabNavigation.ts` |
| `selectionActions.ts` | Ablage für Aktionen mit mehreren Eingängen ([190]): Duplizieren, Sperren, Verbinden, Ebenen aus-/einblenden, Einpassen — Tastenkürzel und natives Menü rufen dieselben Funktionen (`runSelectionAction`) |
| `groupActions.ts` | Gruppen erzeugen, auflösen, betreten |
| `exportScope.ts`, `objectLock.ts`, `selectAll.ts`, `contextHeight.ts` | Export „nur Auswahl"; Objekt-Sperre; Cmd+A-Auswahl (reine Funktion); Höhenversatz von Gelände-Elementen |
| `autosave.ts`, `projectStore.ts`, `recentProjects.ts`, `startupGuard.ts` | Autosave und Wiederherstellen, IndexedDB, zuletzt geöffnet, Start-Protokoll |
| `aiAccess.ts` | KI-Zugriff auf das offene Projekt (`[9]`) |

## Regeln

- Das Projekt ändert sich nur über Ops: `applyChange(ops | (p) => ops, coalesceKey?)` mit den Helfern aus
  `src/core/opsBuild.ts`. Kein direktes Setzen von `project`.
- Öffnen und Neu über `openProjectFile()` bzw. `loadProject()`; danach ist der Verlauf leer.
- Panels lesen Projektdaten selbst aus dem Store, nicht über den Panel-Host (der trägt nur Handler und
  kleine Ansichts-Werte); die Objekt-Info über `useSelectionInfo()`. So rendert eine Op nur die Panels,
  deren Daten sich geändert haben ([121], Messung `e2e/renderCount.spec.ts`).
- `App` abonniert nie das ganze Projekt (`useStore((s) => s.project)`); der e2e-Test prüft, dass sie bei einer
  Wand-Änderung nicht rendert. Neue Hooks in `App` lesen das Projekt in Handlern über `getState()`, im
  Render über schmale Selektoren; was das ganze Projekt im Render braucht, gehört in eine Kind-Komponente.
- macOS-Nebenfenster (`src/native/*WindowApp.tsx`) haben keinen gemeinsamen Store; ihr Zustand läuft über
  die Sync-Brücken in `src/native/` (`windowBridge.ts`: erst ganz, dann nur geänderte Felder als Patch).
