# src/export

Export und Berichte. Die Inhalte sammelt der Kern aus dem Projekt-Dokument (Abfragen wie `meshExportData`,
`openingSchedule`, `roomBook`); hier stehen Beschriftung mit `t()`, Berichtsaufbau und das Schreiben der
Dateien. Ein Plan geht über denselben Plan-Puffer in Bildschirm, SVG, PDF und DXF (`doc/ARCHITEKTUR.md`,
Abschnitt 3.4).

## Plan: SVG, PDF, DXF

| Datei | Inhalt |
|---|---|
| `planToSvgString.ts` | Plan als SVG-Text ohne DOM, für `dossier-cli`, KI-Werkzeuge und Goldens; `hatch` breitet Schraffurlinien aus |
| `exportSvg.ts` | SVG-Export des Grundrisses als Datei |
| `sceneToPrintSvg.ts` | Druck-SVG aus der render2d-Szene, Quelle des PDF eines einzelnen Plans |
| `planToPrintSvg.ts` | Druck-SVG aus dem Plan, heute der Weg für Layout-Blätter (`src/ui/LayoutSheet.tsx`, `layoutPdf.ts`, `legendSvg.ts`) |
| `exportPdf.ts` | Vektor-PDF eines Plans (Massstab, Papier, Ausrichtung) mit jsPDF und svg2pdf |
| `layoutPdf.ts` | alle Layouts eines Ordners als Mehrseiten-PDF |
| `pdfLayers.ts` | PDF-Ebenen (Optional Content Groups, `[80]`) |
| `pdfInfo.ts` | PDF-Info-Wörterbuch; bei anonymer Wettbewerbs-Abgabe nur das Kennwort, Producer/Datum längengleich neutralisiert (`[208]`) |
| `exportDxf.ts` | DXF/DWG des Grundrisses in Modellmetern; Schreiben in `src-tauri/fileio/src/export.rs` |
| `legendSvg.ts` | Legende als Plan-/Druck-SVG (`[82]`) |

## Modell: IFC, STEP, Meshes

| Datei | Inhalt |
|---|---|
| `exportIfc.ts` | IFC4 und IFC2x3; der Kern sammelt, Rust (`fileio`, Modul IFC-Export) schreibt |
| `exportStep.ts` | STEP-B-Rep über truck (`trucksolid`) |
| `exportMesh.ts` | OBJ, STL, glTF/GLB; der Kern sammelt (`meshExportData`), Rust schreibt |

## Listen und Berichte

Jeder Bericht hat ein Berichtsmodell, aus dem CSV, SVG und PDF dieselben Zahlen und denselben Seitenaufbau
bekommen.

| Datei | Inhalt |
|---|---|
| `areaReport.ts` | Flächen- und Kennzahlen-Nachweis (`[70]`); Aufbau, den die übrigen Berichte nutzen |
| `costReport.ts` | Kostenschätzung grob als Bericht (CSV/PDF über `areaReport.ts`, [209]) |
| `programReport.ts` | Soll/Ist-Vergleich des Raumprogramms (`[61]`) |
| `elementSchedule.ts` | Bauteilliste mit U-Werten (`[71]`) |
| `openingSchedule.ts` | Fenster- und Türliste (`[97]`) |
| `roomBook.ts` | Raumbuch mit Oberflächen und Mengen (`[158]`) |
| `exportSchedule.ts` | Bauteilaufstellung als CSV, eine Zeile je Bauteil-Vorkommen |
| `sheetTable.ts` | lebendige Listen als Tabellen auf Layout-Blättern (`[111]`) |

## Publikation

| Datei | Inhalt |
|---|---|
| `publishSet.ts` | Publikationssätze (`[79]`): Dateien, Namen, Revisionsindizes und die Ops für Index und Protokoll; ohne DOM |
| `publishRun.ts` | führt einen Satz aus (PDF mit Ebenen und Index, DXF/DWG); braucht ein DOM |
