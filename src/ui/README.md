# src/ui

Dialoge, Leisten und Bausteine der Oberfläche. Rein darstellend; Änderungen am Projekt laufen als Ops über den
Store (`src/state`). Text nur über `t()`, keine Browser-Dialoge (`notify()` oder Overlay-Dialog). Dock-Panels
liegen in `src/panels`, Befehle in `src/commands`.

## Gerüst der App (aus `App.tsx` herausgelöst, `[163]`)

| Datei | Inhalt |
|---|---|
| `AppDialogs.tsx` | Dialoge und Overlays des Editors: Ressourcen, Öffnungs-Editor, Import, Export, Einstellungen |
| `HiddenFileInputs.tsx` | versteckte Datei-Felder für Import und Öffnen, Hosts für Punktwolken und Mesh |
| `BootScreen.tsx` | Start: `SplashScreen.tsx`, dann `StartScreen.tsx`, dann Editor |
| `useTopBarElements.tsx` | Menüleiste (Browser, Electron) und Ansichts-Ribbon |
| `TopBar.tsx`, `AppMenuBar.tsx`, `StatusBar.tsx`, `CommandLine.tsx` | Oberleiste, Menüleiste, Statusleiste, Befehlszeile |
| `ErrorBoundary.tsx`, `BusyOverlay.tsx`, `Toast.tsx`, `WindowControls.tsx` | Fehlerseite samt Kern-Neustart (`[118]`), Warte-Hinweis, Kurzmeldungen, Fensterknöpfe für Electron |

## Allgemeine Dialoge und Bausteine

| Datei | Inhalt |
|---|---|
| `PromptDialog.tsx`, `UnsavedChangesDialog.tsx`, `RecoverAutosaveDialog.tsx`, `LockConflictDialog.tsx` | Ersatz für `window.prompt/confirm`: Eingabe, ungespeicherte Änderungen, Autosave, gesperrte Datei |
| `ContextMenu.tsx`, `Dropdown.tsx`, `EditorField.tsx`, `EyeIcon.tsx` | Kontextmenü, Auswahlliste, beschriftetes Feld, Sichtbarkeits-Symbol |
| `SettingsDialog.tsx`, `AiAccessSection.tsx`, `AiActivityPanel.tsx`, `LayoutMenu.tsx` | Einstellungen, KI-Zugriff und sein Protokoll (`[9]`), Arbeitsumgebungen |
| `ColorMixer.tsx`, `SpectrumPicker.tsx`, `FreeColorPicker.tsx`, `ColorHexField.tsx`, `ColorSwatchCell.tsx`, `PenColorField.tsx`, `PenSwatchPicker.tsx` | Farbwahl: Mischer, Spektrum, freie Paletten, Stiftfarben |
| `hatchPreview.tsx`, `MotifEditor.tsx` | Vorschau von Schraffuren und Linienstilen, Editor eines Wiederhol-Motivs |

## Import und Export

| Datei | Inhalt |
|---|---|
| `ImportDialog.tsx`, `IfcImportDialog.tsx`, `MeshImportDialog.tsx`, `PointCloudImportDialog.tsx`, `ContextImportDialog.tsx`, `RoomProgramImportDialog.tsx` | Import von DXF/DWG/PDF, IFC, Meshes, Punktwolken, Standort, Raumprogramm |
| `PdfCalibrate.tsx` | Zwei-Punkt-Kalibrierung im PDF-Import |
| `ExportPdfDialog.tsx`, `ExportDxfDialog.tsx`, `ExportSaveDialog.tsx`, `PresentationDialog.tsx` | PDF, DXF/DWG, Schnellexport, Präsentationsplan (`[66]`) |

## Layout-Blatt, Text und Öffnungen

| Datei | Inhalt |
|---|---|
| `LayoutSheet.tsx`, `layoutSheetMath.ts`, `LayoutCreateDialogs.tsx`, `SheetTableHud.tsx` | Layout-Blatt im Haupt-Viewport, Treffer- und Resize-Rechnung der Viewports, Erstell-Dialoge, Eigenschaften einer Blatt-Tabelle |
| `TextEditorDialog.tsx`, `RoomStampEditorHost.tsx` | Rich-Text-Editor, Stempel-Editor eines Raums |
| `OpeningDetailPanels.tsx`, `ElevationPreview.tsx` | Detail-Panels des Fenster-/Türeditors (der Editor selbst: `panels/objectInfo/OpeningEditor.tsx`), Ansichtsvorschau |

## Unterordner

| Ordner | Inhalt |
|---|---|
| `resourceManager/` | Reiter des Ressourcen-Managers: je Ressourcenart eine `*Tab.tsx` (Bauteile, Schraffuren, Linien, Wand-/Decken-/Dachstile, Tür-/Fenster-/Treppentypen, Stifte, Paletten, Textstile, Overrides, Ansichtsvorlagen, Materialien); `TypeLibraryTab.tsx` ist der gemeinsame Rumpf der Typ-Bibliotheken, `fields.tsx` die Feld-Bausteine. Das Fenster selbst: `ResourceManager.tsx` |
| `ribbon/` | Symbole für Befehle im Ribbon (`CommandIcon.tsx`) |
