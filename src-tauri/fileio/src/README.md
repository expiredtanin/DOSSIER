# src-tauri/fileio/src

Dateiformate von Dossier in Rust: lesen und schreiben ohne Dateisystem, Bytes rein, flache Puffer oder Bytes
raus. Eigenes WASM-Paket (`src/engine/pkgFileIo`), das erst beim Import oder Export nachgeladen wird
(`src/engine/fileioWasm.ts`). Kaputte Dateien ergeben einen Fehlertext oder ein Teilergebnis, nie einen Panic.
Die TS-Seite (`src/io`, `src/export`) besteht aus dünnen Fassaden. Zusammenspiel: `doc/ARCHITEKTUR.md`,
Abschnitt 8.

## Aufbau

`lib.rs` listet die Module. Die Bindungen für WASM (Feature `web`) liegen in `web_*.rs`, je eine pro Leser
(`web_import.rs`, `web_pdf.rs`, `web_pointcloud.rs`, `web_sheet.rs`). Tests grösserer Module stehen in
eigenen Dateien `*_tests.rs`.

## DXF und DWG

| Datei | Inhalt |
|---|---|
| `import.rs` | DXF/DWG lesen (acadrust) zu Kontext-Geometrie: Konturen, Texte, Meshes je Ebene |
| `text.rs`, `annotation.rs` | Texte (MTEXT-Formate, Ausrichtung); Pfeilspitzen, Bemassungen und Führungslinien |
| `split.rs` | teilt eine grosse ASCII-DXF in unabhängige Teile für parallele Web-Worker |
| `common.rs` | Abbildungen für Import und Export (Ebenenfarben, Format-Erkennung) |
| `export.rs`, `export_dim.rs` | flache 2D-Zeichnung als DXF oder DWG schreiben; Bemassung als echte DIMENSION-Entitäten |

## IFC

| Datei | Inhalt |
|---|---|
| `ifc_step.rs` | STEP-Klartext-Leser: zerlegt die Datei in Instanzen |
| `ifc_import.rs` | IFC als Meshes: je Bauteil GlobalId, Klasse, Name, Geschoss, Farbe, Dreiecke |
| `ifc_semantic.rs`, `ifc_shapes.rs` | IFC als echte Bauteile (Wände, Öffnungen, Decken …); Formerkennung für Dächer, Treppen, Bogenwände |
| `ifc_brep.rs`, `ifc_nurbs.rs`, `ifc_sweep.rs` | Freiform-Geometrie lesen: Kanten-Topologie und B-Rep, B-Spline-Flächen, Rotations- und Sweep-Körper |
| `csg.rs` | Boolesche Operationen auf Dreiecksnetzen über BSP-Bäume, nur für den IFC-Import (Öffnungen, IfcBooleanResult, Halbräume); neue 3D-Booleans nie hiermit |

Modul IFC-Export (Dateien mit Präfix `ifc_export` und `ifc_openings`): schreibt IFC4 und IFC2x3 aus der flachen
Bauteilliste, die der Kern sammelt, samt Geometrie der Türen und Fenster. Aufruf von TS: `src/export/exportIfc.ts`.

## Meshes, Punktwolken, PDF, Tabellen, BCF

| Datei | Inhalt |
|---|---|
| `mesh_import.rs`, `mesh_import_gltf.rs` | OBJ (mit MTL), STL, PLY und glTF/GLB als Kontext-Meshes |
| `mesh_export.rs` | OBJ, STL und glTF/GLB aus einer flachen Szene schreiben |
| `pointcloud.rs` | gemeinsamer Kern der Punktwolken-Leser |
| `pointcloud_las.rs`, `pointcloud_e57.rs`, `pointcloud_text.rs` | LAS/LAZ, E57, PLY/XYZ/PTS |
| `pdf_object.rs`, `pdf_vector.rs`, `pdf_geom.rs` | Vektor-PDF lesen (`[76]`): Objekte und Querverweise, Pfade und Texte einer Seite, Kreise und Clip-Pfade |
| `sheet_import.rs`, `sheet_map.rs` | Tabellen lesen (.xlsx, .ods, .csv) und als Raumprogramm abbilden (`[61]`) |
| `bcf.rs` | BCF 2.1 und 3.0: `.bcfzip` lesen und schreiben |
