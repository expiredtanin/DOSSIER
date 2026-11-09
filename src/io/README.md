# src/io

Import und Projektformat. Die meisten Dateien sind dünne Fassaden: Dateien lesen die Rust-Module in
`src-tauri/fileio` (WASM `pkgFileIo`, geladen über `src/engine/fileioWasm.ts`) und der Kern
(`src-tauri/core`); hier stehen Aufruf, Web-Worker und Netzzugriffe. Grosse Dateien liest je ein
Web-Worker, damit die Oberfläche nicht einfriert (Worker `*.worker.ts`, ein Worker je Aufruf).

## Projektdatei

| Datei | Inhalt |
|---|---|
| `projectFormat.ts` | Format `.obp`/`.obpt`: Versionierung, Migration, ein Parser für alle Ladestellen; gerechnet wird in `src-tauri/core/src/project_format.rs` |

## CAD- und Zeichnungs-Import

| Datei | Inhalt |
|---|---|
| `dxfParser.ts`, `dwgParser.ts` | DXF und DWG lesen (`fileio/src/import.rs`); Ergebnis `ParsedImport` |
| `dxfParserAsync.ts`, `dxfParser.worker.ts` | derselbe Weg im Web-Worker, bei sehr grossen Dateien aufgeteilt |
| `dxfImportHook.ts` | verbindet das versteckte Datei-Feld der App mit dem Befehl `import` |
| `importSource.ts` | gelesene Datei als Eingabe für den Kern (`import_drawing.rs`): Zusammenfassung für den Dialog, beim Bestätigen die Ops |
| `recognizeDrawing.ts` | Bauteile aus den Linien eines Grundrisses erkennen (Wände, Öffnungen, Stützen, Räume), Fassade über `drawing_recognize.rs` |
| `pdfVector.ts`, `pdfCalibrate.ts` | Vektor-PDF lesen (Pfade, Texte) und Massstab aus zwei Punkten bestimmen (`[76]`) |
| `pdfImport.ts`, `imageAsset.ts` | PDF-Seiten als Rasterbild (pdfjs), Bilddatei als eingebettete Data-URL |
| `patParser.ts`, `linParser.ts` | AutoCAD-Schraffurmuster (`.pat`) und Linientypen (`.lin`) |

## 3D-, BIM- und Punktwolken-Import

| Datei | Inhalt |
|---|---|
| `ifcImport.ts`, `ifcImport.worker.ts` | IFC als Kontext-Meshes (`[B3]`) oder als Bauteile (`[B4]`) |
| `meshImport.ts`, `meshImport.worker.ts` | OBJ, STL, glTF/GLB, PLY als Kontext-Meshes |
| `pointCloud.ts`, `pointCloud.worker.ts` | LAS, LAZ, E57, PLY, XYZ, PTS |
| `bcf.ts`, `bcfMatch.ts` | BCF-Themen lesen und schreiben; Zuordnung IFC-GlobalId zu Bauteil-ids |
| `roomProgramImport.ts` | Raumprogramm aus `.xlsx`, `.ods`, `.csv` (`[61]`) |

## Standort und Gelände

| Datei | Inhalt |
|---|---|
| `swissTopo.ts` | swisstopo: Ortssuche, Gebäude-Umrisse, Gelände-Profil |
| `swissBuildings3d.ts`, `swissAlti3d.ts`, `swissImage.ts` | swissBUILDINGS3D, Höhenraster swissALTI3D, SWISSIMAGE-Luftbild |
| `stacApi.ts` | gemeinsame STAC-API-Bausteine für die swisstopo-Datensätze |
| `osm.ts` | OpenStreetMap (Overpass) für den Standort-Import |
| `geoContext.ts`, `lv95.ts` | gemeinsame Typen der Standort-Importe; Umrechnung LV95 und WGS84 |

Alle entfernten Abrufe laufen über `src/net` (`netFetch`). Beispieldateien für Tests liegen in `testdata/`.
