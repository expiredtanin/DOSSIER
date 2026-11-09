# src/panels

Das Panel-System der Hülle: Dock, Registry und die eingebauten Inhalts-Panels. Die Zahlen der Panels rechnet der
Kern; hier stehen Eingabe und Darstellung. Zustand über den Store (`src/state`).

## Gerüst

| Datei | Inhalt |
|---|---|
| `types.ts` | Kerntypen: Panel-Definition, Dock-Layout |
| `registry.ts` | Panel-Registry (`registerPanel`, `getPanel`, `listPanels`): die Naht, über die Panels eingehängt werden |
| `builtinPanels.tsx` | registriert die eingebauten Panels; Symbole in `PanelIcons.tsx` |
| `host.ts` | Host-Vertrag: die Form dessen, was ein Panel über `PanelHostContext` (in `types.ts`) vom Editor bekommt |
| `layout.ts` | Standard-Anordnung und Speichern in `localStorage` |
| `Dock.tsx`, `DockArea.tsx` | angedockte Spalten mit gestapelten Gruppen; `DockArea` ist das Gerüst der App-Mitte samt Andockzonen und schwebenden Panels |
| `FloatingPanel.tsx`, `PanelFrame.tsx`, `TabStrip.tsx`, `panelDrag.tsx` | schwebendes Fenster, Rahmen mit Kopfzeile, Tab-Leiste, Ziehen und Andocken von Tabs |

## Inhalts-Panels

| Datei | Inhalt |
|---|---|
| `ToolsPanel.tsx`, `AttributesPanel.tsx`, `ObjectInfoPanel.tsx` | Werkzeug-Palette, Attribute, Objekt-Info der Auswahl (`ContextObjectProps.tsx`, `UValueRow.tsx`, `SurfacePatternPlacement.tsx` sind Teile davon) |
| `DrawingLevelsPanel.tsx`, `LayersPanel.tsx`, `ElementTreePanel.tsx` | Zeichnungsebenen, Ebenen, Baum Geschoss → Bauteilklasse → Element |
| `LayoutsPanel.tsx`, `PublishSection.tsx`, `ViewSnapshotsPanel.tsx` | Layouts als Baum, Publikationssätze (`[79]`), gespeicherte Ansichten |
| `RoomBalancePanel.tsx` | Flächenbilanz mit den Abschnitten `AreaTableSection.tsx`, `KennzahlenSection.tsx`, `ProgramCompareSection.tsx`, `ElementScheduleSection.tsx`, `OpeningScheduleSection.tsx`, `RoomBookSection.tsx`; Stempel-Editor `RoomStampEditor.tsx` |
| `SitePanel.tsx` | Gelände und Kontext, mit `SiteRulesSection.tsx` (Baurecht), `SunStudySection.tsx` (Schatten) und `PointCloudSection.tsx` |
| `BcfPanel.tsx`, `ClashPanel.tsx` | BCF-Themen und Kollisionsliste; Sitzungszustand in `bcfSession.ts` und `clashSession.ts` |
| `HistoryPanel.tsx` | Undo-Verlauf mit Sprung auf einen Schritt |

## Reine Helfer

| Datei | Inhalt |
|---|---|
| `areaInputs.ts`, `siteRulesInput.ts`, `sunStudyTime.ts` | Eingaben der Flächenbilanz, Übernahme von Parzelle und Baulinien aus der Zeichnung, Zeit des Schattenreglers |
| `bcfView.ts` | Kamera und Schnittebene zwischen BCF und 3D-Viewport umrechnen |
| `displayMode.ts`, `DisplayModeSelect.tsx` | Darstellungsmodus der Panel-Kopfzeile |
| `downloadFile.ts` | Download einer Datei anstossen (CSV mit BOM) |
