# Dateiformate: was geht hin, was kommt zurück, was geht verloren

Stand 12.11.2026 ([C9]). Ehrliche Bestandsaufnahme aus dem Code und den Tests, keine Zusage. Jede Aussage nennt
ihren Beleg (Datei, Funktion oder Test). „ungeprüft" heisst: im Code nicht nachgelesen oder nie mit einem
Fremdprogramm geöffnet. Sämtliche Rundreisen wurden nur mit Tests im Linux-Container belegt, nicht in
AutoCAD, Revit, ArchiCAD oder Acrobat. Wer ein Format ändert, führt die Tabelle im selben Commit nach
(`src/export/dateiformateDoku.test.ts` prüft nur, dass jedes Export-Format hier vorkommt).

Das Modell (`Project`) ist die einzige Wahrheit. Alle Formate ausser `.obp` sind **Ableitungen**: sie
kennen nur einen Teil des Modells, und beim Import entstehen daraus gewöhnliche Elemente (`doc/ARCHITEKTUR.md` §8,
„Importe werden Elemente").

## Übersicht

| Format | Export | Import | Rundreise verlustfrei? |
|---|---|---|---|
| `.obp` / `.obpt` (Projekt, Vorlage) | ja | ja | ja, bis auf Undo-Verlauf, Punktwolken, BCF-Themen |
| IFC4 / IFC2x3 (`.ifc`) | ja (Bauteile) | ja (Bauteile, sonst Netz) | nein: Bauteile ja, alles Grafische nein |
| DXF / Binär-DXF / DWG | ja (Geschoss-Plan, Schnitt, Ansicht) | ja (2D-Zeichnung, Netze) | nein: Plan wird zur Zeichnung, nicht zum Modell |
| STEP (`.stp`) | ja (B-Rep, nur Geometrie) | ja (als Netz) | nein |
| OBJ, STL, glTF/GLB | ja (Dreiecksnetz) | ja (Netz) | nein: Netz, keine Bauteile |
| PDF, SVG (Plan, Blätter) | ja | PDF-Vektor und -Raster | nein: Ausgabeformat |
| CSV (Listen) | ja | Raumprogramm (`.xlsx`, `.ods`, `.csv`) | nein |
| swisstopo, OSM | nein | ja (Netz, Gelände, Luftbild) | nicht anwendbar |
| Punktwolken (LAS, LAZ, E57, PLY, XYZ, PTS) | nein | ja (nur Anzeige) | nicht anwendbar |
| BCF (`.bcfzip`) | ja | ja | eigene Datei, nicht im Projekt |

## Projektdatei `.obp` / `.obpt`

JSON, Einrückung 2, `formatVersion` vorn (`project_format.rs::serialize_project`, Zeichen für Zeichen wie
`JSON.stringify`). `.obpt` ist dasselbe Format als Vorlage (`PROJECT_TEMPLATE_EXT`, `src/native/projectFile.ts`).
Alte `.json`-Projekte bleiben lesbar (Kopf von `src/state/useProjectFileActions.ts`).

| Was | Verhalten | Beleg |
|---|---|---|
| Alle Modellfelder | gespeichert; unbekannte Felder bleiben erhalten und werden als Warnung gemeldet | `parse_project_object`, Test `unbekannte_felder_bleiben_und_werden_gemeldet` |
| Neuere Datei in älterem Programm | **abgelehnt** (Format 5 ist aktuell) | `PROJECT_FORMAT_VERSION`, Test `neuere_und_kaputte_dateien_werden_abgelehnt` |
| Ältere Datei | migriert (Türen werden Öffnungen, Blatt-Annotationen werden Zeichnungen, Strichstärken wandern an die Verwender); rückwärts nicht | `parse_project_object`, Tests `alte_datei_wird_migriert_und_ergaenzt`, `tueren_werden_zu_oeffnungen` |
| Ansichts-Reiter | als `uiState.viewTabs` gespeichert und beim Öffnen wiederhergestellt; Reiter auf gelöschte Ausschnitte fallen weg | `uiStateForSave`, `restoreViewTabs` (`src/state/viewTabs.ts`), Test `ui_state_beim_speichern` |
| Luftbilder, Bilder | als Data-URL **in** der Datei (Dateigrösse wächst) | `src/io/swissImage.ts` (Kopf), `src/io/imageAsset.ts` |
| Undo/Redo-Verlauf | **nicht gespeichert**, nach dem Öffnen leer | `CLAUDE.md` („Kern lädt, Verlauf leer"), `serialize_project` schreibt nur das Dokument |
| Punktwolken | **nicht gespeichert**, nach dem Neuladen weg | `src/io/pointCloud.ts` (Kopf), `TODO.md` [27]; kein Feld `pointClouds` in `model/generated.rs` |
| BCF-Themen | nicht im Projekt, eigene Datei | `src/io/bcf.ts` (Kopf) |
| Auswahl, Zoom, Panel-Layout | nicht gespeichert (nur Reiter, s. oben) | ungeprüft im Einzelnen |
| Schreib-Lock | Sidecar `<datei>.obp.lock` unter Tauri; im Browser kein Lock | `acquire_project_lock`, `src/native/projectFile.ts` |
| Speichern | atomar (Tauri, bekannter Pfad) | `writeFileAtomic`, `saveProjectFile` ([116], auf dem Mac ungeprüft) |

## IFC (Export)

Schema IFC4 (Vorgabe) oder IFC2x3; optional eBKP-H- und Ebenen-Klassifikation. Sammler `ifc_data.rs::ifc_export_data`,
Schreiber `fileio/src/ifc_export/mod.rs`, Aufruf `src/export/exportIfc.ts`.

| Modell | Wird zu | Verlust / Vereinfachung | Beleg |
|---|---|---|---|
| Geschosse (`floor`) | `IfcBuildingStorey`; verwaiste Bauteile am Gebäude | Zeichnungs-Ebenen (`kind: drawing`) fehlen | `ifc_data.rs` (Kopf) |
| Wände | Extrusion je Schichtband + `IfcOpeningElement`; sonst öffnungsgenaues Netz | Bogenwand: Profil-Extrusion mit Kreisachse, sonst Netz; Wandtyp nur als Materialschichten | `ifc_data.rs::emit_walls`-Abschnitt, Datensätze `WALL_SOLIDS`/`WALL_MESH`/`WALL_ARC_SOLID` |
| Decken, Räume | `IfcSlab`, `IfcSpace` (SIA 416, Raumbuch-Psets) | Bögen im Umriss bleiben echte Bögen (`CEILING_ARC`, `SPACE_ARC`) | `ifc_data.rs`, Tests `exportIfc.test.ts` |
| Türen, Fenster | `IfcDoor`/`IfcWindow` mit Rahmen, Blatt, Glas als getrennte Körper | nur die im Modell parametrisierten Teile; ohne Teile (Wandöffnung) keine Füllung | `fileio/src/ifc_openings.rs`, Kopf `ifc_export/mod.rs` |
| Treppen | `IfcStair` mit Läufen, Podesten, Geländern (`IfcRelAggregates`); Ersatzquader nur ohne Teile | – | `ifc_stairs.rs` |
| Dächer | `IfcRoof`, ein Netz je Dach | **Netz statt Parametrik**: Neigung, Typ, Traufe nicht rückholbar | `ifc_data.rs` (Dächer), Datensatz `ROOF` |
| Stützen, Bäume, Achsraster, Extrusionskörper | `IfcColumn`, `IfcGeographicElement` (IFC2x3: Proxy), `IfcGrid`, `IfcBuildingElementProxy` | Baum: zwei Netze Stamm + Krone | `ifc_data.rs` |
| Psets / Mengen | `Pset_*Common` und `Qto_*BaseQuantities` nur mit **Modellwerten**; `CH_Qto_SIA416`, `Dossier_*` | keine frei definierbaren Eigenschaften | Kopf `ifc_data.rs`, Pset-Namen dort und in `ifc_quantities.rs` |
| Georeferenz | ganze Geometrie in LV95, wenn `geoAnchor` gesetzt | – | `geo_rebase`, Kopf `ifc_data.rs` |
| GUIDs | `ifcGlobalId` des Bauteils, wenn gesetzt (Import, [201]; Wand, Decke, Dach, Stütze, Treppe, Raum, Extrusion, Tür/Fenster); sonst deterministisch aus der Modell-id. Doppelte oder ungültige GlobalIds fallen auf die abgeleitete zurück | Bäume, `IfcOpeningElement` und Beziehungen bleiben abgeleitet | `ifc_data.rs` (Datensatz `GUIDS`), `ifc_export::ifc_guid` |
| **Nicht exportiert** | 2D-Zeichnungen (ausser Raster), Texte, Bemassungen, Schraffuren, Layouts/Blätter, Ebenen als Sichtbarkeit, Stifte, Gruppen, Gelände, Netzkörper, Möbel/Blöcke, Ansichtsausschnitte | Im Sammler wird nur über Bauteile iteriert, `context` und `drawings2d` (ausser `Grid`) kommen nicht vor | `ifc_data.rs` (`grep context` leer) |

Geprüft mit IfcOpenShell nur, wenn `ifcopenshell` installiert ist (`src/export/exportIfc.validate.test.ts`); ob
Revit/ArchiCAD alles wie gewünscht lesen: ungeprüft.

## IFC (Import)

`fileio/src/ifc_semantic.rs` erkennt Bauteile an der **Form** des Körpers; was nicht sicher passt, bleibt Netz
(`ifc_import.rs`). Aufbau der Modell-Elemente: `core/src/import_ifc.rs`.

| IFC | Wird zu | Verlust | Beleg |
|---|---|---|---|
| `IfcWall(StandardCase)` | Wand mit Achse, Dicke, Höhe, Wandtyp aus Materialschichten | Giebel-/Pultwände, Gehrungen jenseits der Rechteck-Toleranz, Wände mit nicht abbildbarer Öffnung bleiben **Netz** | Kopf `ifc_semantic.rs` |
| Öffnungen, `IfcDoor`, `IfcWindow` | Tür/Fenster/Durchbruch; Anschlag und Teilung aus `OperationType`/`PartitioningType` | Rahmen- und Glasgeometrie der Quelle gehen verloren (Dossier-Rahmen aus Parametern) | Test `ifcImport.elements.test.ts` („Tür-Anschlag …") |
| `IfcSlab`, `IfcColumn`, `IfcSpace`, `IfcBeam`, `IfcStair`, `IfcRoof` | Decke, Stütze, Raum, Extrusionskörper, Treppe (gerade/L/Wendel), Dach (Flach/Pult/Sattel/Walm) | Nur Prismen bzw. achsparallele Dächer; Tonnendach bleibt Netz | Kopf `ifc_semantic.rs`, Kommentar zu `fit_roof` |
| Geschosse | Geschosse (Höhe ±5 mm wiederverwendet) | – | `import_ifc.rs::LEVEL_TOL` |
| Psets | nur `IsExternal`, `LoadBearing`, `ThermalTransmittance`, Brand-/Schall-/Einbruchschutz, Raumbuch-Felder; **übrige Psets gehen verloren** | frei definierte Eigenschaften, Mengen (`Qto_*`) werden neu gerechnet | `import_ifc.rs` (`info.flag/text`), Tests „[98] Pset_*Common", „[158] Raumbuch" |
| Klassifikation | nur **gezählt** im Bericht, nicht im Modell gespeichert | eBKP-H/Uniclass-Codes gehen verloren | `import_ifc.rs` (`classified`) |
| GlobalId | an jedem erkannten Bauteil `ifcGlobalId` (Wand, Öffnung, Decke, Stütze, Dach, Treppe, Raum, Träger/Extrusion) und am Netzkörper | Kopien (Einfügen, Kopieren, Reihe, Spiegeln, Wand teilen) bekommen keine; der Export schreibt sie zurück, Rundreise über GUID möglich | `import_ifc.rs` (`set_gid`), Tests `ifcGlobalIdRoundtrip.test.ts`, „Kontext-Mesh: Farbe und GlobalId" |
| Rest (Möbel, Haustechnik, Freiformen, Gelände) | Netzkörper `importedMesh` bzw. Gelände `terrainMesh` mit Klasse nach Herkunft | Nur Dreiecke und Farbe; Booleans und Öffnungen via BSP (`csg.rs`), bei Budget-Überschreitung fällt der Import auf den ersten Operanden zurück | `ARCHITEKTUR.md` §8, `CLAUDE.md` („3D-Booleans, wer wo") |
| Klasse (`categoryCode`) | feste Codes je Bauteilart (Wand 20, Öffnung 21, Decke 30, Dach/Träger 35, Treppe 40, Stütze 50, Raum 60) | Eigene Ebenen der Quelle werden nicht übernommen | Konstanten in `import_ifc.rs` |

Rundreise Dossier → IFC → Dossier (Demo-Haus): gleiche Wände, Öffnungen, Decke, Raum, Typ und Volumen
(Tests `ifcImport.elements.test.ts`, `ifcImport.test.ts`). Dächer und Treppen: Tests „[151] Treppe …". Fremdsoftware-Dateien:
nur mit externen Beispielen (`DOSSIER_IFC_SAMPLES`), im Repo nicht enthalten.

## DXF / DWG (Export)

Der **Plan eines Geschosses** (`generatePlan`) sowie **Schnitt und Ansicht** (`viewportLevelPlan`, [200]: dieselbe Ableitung
wie Ansicht und PDF-Blatt, durch denselben Sammler), Modell-Space in Metern, 1:1; DXF und DWG je R2018 (Binär-DXF
zusätzlich). Sammler `core/src/plan/dxf.rs`, Schreiber `fileio/src/export.rs` (acadrust), Aufruf
`useExportHandlers.ts::onExportDxf`, Publikationssätze `publishRun.ts`.

| Modell/Plan | Wird zu | Verlust / Vereinfachung | Beleg |
|---|---|---|---|
| Kategorien (Ebenen) | `LAYER` `Code_Name` mit Farbe und Strichstärke; Hierarchie **flach**; Sammel-Ebenen `SYMBOLS`, `HATCH`, `CONTEXT`, `PLAN`, `SECTIONS`, `EXTRUSION` | Baum der Ebenen und Sichtbarkeits-Regeln gehen verloren; verbotene Zeichen im Namen werden `_` | `dxf.rs::collect` (Schritt 1), `sanitize_layer_name` |
| Farbe, Strichstärke | Ebene: Farbe und Strichstärke; **Entität: eigene Farbe** (True-Color 420 + nächste ACI 62) **und Strichstärke** (370, auf CAD-Stufen gerastet), wenn Linie, Bogen, Kreis oder Umriss vom Ebenen-Standard abweichen, sonst `ByLayer` ([200]) | Der Klassen-Stil wird beim Export aufgelöst (wie die Anzeige: Klassenfarbe > Elementfarbe > Tinte `#1a1a1a`), auch in Tür-/Fensterblöcken (Vergleich gegen die Ebene der Einfügung); Texte tragen die Farbe ihrer ersten Textstrecke (420 + ACI), nie eine Strichstärke. Schraffuren tragen keine Stärke. **Gedimmt und Deckkraft:** gedimmte (`greyed`, Faktor 0,3 wie Plan/PDF) Elemente und Objekt-Deckkraft (Produkt, nur unter 1) gehen als DXF-Transparenz (Gruppe 440 = `0x02000000 \| Deckkraft 0–255`) an Linien, Bögen, Kreise, Umrisse und deren Füllung/Schraffur (HATCH); die Farbe bleibt ungedimmt (Dimmung ist in der Anzeige Deckkraft, keine eigene Farbe). Texte tragen keine Transparenz; Stiftsätze als Ganzes gibt es nicht, nur die aufgelösten Werte | `dxf.rs` (`Pen`, `apply_pen`, `block_content`, `text_pen`), `scene.rs::cls_stroke`, `export.rs` (`REC_ENTITY_PEN`), Tests `exportDxf.ezdxf.test.ts`, `exportDxf.pens.test.ts` ([200]) |
| Geschosse, Schnitt, Ansicht | eine Ebene je Datei (App: aktive Ebene, Dialog beschriftet Plan/Schnitt/Ansicht); CLI: `dxf`/`dwg` je Geschoss, `section`/`elevation <Name> --format dxf\|dxfbin\|dwg` | Schnitt/Ansicht: Zeichnung in Metern (x entlang der Linie, y = Höhe), nicht am Modell verankert | `useExportHandlers.ts` (`viewportLevelPlan`), `src/cli/main.ts`, Test `exportDxf.section.test.ts` |
| Wände, Decken, Umrisse | `LINE`, `LWPOLYLINE` (mit Bulges), `ARC`, `CIRCLE`, `ELLIPSE` | Aneinanderstossende Einzellinien werden zu Bögen **zusammengesetzt**, verrauschte Ringe zu Ausgleichskreisen: leichte Abweichung möglich | `dxf.rs` (`arc_fit`, REC 24–26), Test `exportDxf.arcs.test.ts` |
| Schraffuren | `HATCH` (Vollfläche, Linienmuster, Verlauf); Kurven-/Schichtmuster und polare Schraffur als **Polylinien**; Zufallsstriche als `LINE`; **Bild-Schraffuren fehlen** | Optional abschaltbar (`includeHatches`) | `dxf.rs` (Hatch-Zweig), Test `exportDxf.gradient.test.ts` |
| Linienstile | Linientypen mit Strichmuster in Modell-Metern | Zickzack/Motiv-Linien werden zu Polylinien | `dxf.rs` (`zigzag`, `motif`) |
| Bemassungen | `DIMENSION` + Anonymblock + `DIMSTYLE` (Linearmass); Radius-/Durchmesser-/Bogenmass als Linien, Bögen, Text | Assoziativität zum Modell geht verloren | `dxf.rs` (`Drawing2DGeom::Dimension`), Test `exportDxf.cad.test.ts` |
| Türen, Fenster, Blöcke | `BLOCK` + `INSERT` mit Attributen (ID, Typ, Breite, Höhe, Brüstung) | Block-Geometrie ist der Plan-Zustand (Detailgrad, Massstab) | `dxf.rs` (Öffnungs-Block), Test `exportDxf.cad.test.ts` |
| Objekte der Bibliothek ([253]) | je Objekt-Id und Parametersatz ein `BLOCK` `DOSSIER_<id>_<hash>` (bei Objekten mit Zufall, z. B. Tisch mit Stühlen, zusätzlich je Seed), je Objekt ein `INSERT` mit Lage und Drehung; Ebene des `INSERT` = Klasse (Möbel/Sanitär/Fahrzeuge), Inhalt auf Ebene „0" | Parameter und Objekt-Id stehen nur im Blocknamen/Hash, nicht als Attribute; Inhalt ist der Plan-Zustand (Detailgrad, Massstab) | `dxf.rs::block_instance` (Fall `Libobj`), Test `libobj_als_block_und_insert` |
| Texte | `TEXT` mit Textstil (Schriftname); Raumstempel zeilenweise | Einzeiliger `TEXT`: Zeilenumbrüche werden zu Leerzeichen, Absätze setzt der Kern in Zeilen/Wörter um; Schrift nur als Name | Kopf `dxf.rs`, `export.rs::sanitize_text` |
| Layouts | optional ein Papierbereich mit Ansichtsfenster; je Projekt-Layout ein Papierbereich | Papier-Export bleibt in **lokalen** Koordinaten | `dxf.rs::sheets`, `useExportHandlers.ts` (Kommentar) |
| Georeferenz | echte LV95-Koordinaten, wenn `geoAnchor` gesetzt | – | `projectToWorldCoords`, Test `exportDxf.georef.test.ts` |
| **Nicht exportiert** | 3D, Texturen, Gruppen, Bild-Schraffuren, `noPrint`-Elemente (werden ausgelassen) | – | `useExportHandlers.ts` (`forPrint: true`) |

Gegengelesen mit ezdxf (Auditor), libredwg und dem eigenen Import (Tests `exportDxf.*.test.ts`). Öffnen in
AutoCAD/BricsCAD/Vectorworks: ungeprüft. DWG-R2018 öffnen CAD-Programme vor 2018 nicht (Kopf `export.rs`).

## DXF / DWG (Import)

`fileio/src/import.rs` liest, `core/src/import_drawing.rs` macht daraus Ops (ein Undo-Schritt). DWG R13 bis 2018.

| DXF-Inhalt | Wird zu | Verlust | Beleg |
|---|---|---|---|
| Linien, Polylinien (Bulge), Bögen, Kreise | `drawings2d` (`line`, `polyline` mit Bulge, `arc`, `circle`) | Ellipsen, Splines, HATCH-Ränder werden **tesselliert** (Segment ≈ 5,6°, max. 256) | Kopf `import.rs`, `import_drawing.rs::contour_geom` |
| HATCH | gefüllte geschlossene Kontur in **einer** Füllfarbe (Ebenenfarbe oder `#c8c8c8`) | **Schraffurmuster und Verläufe gehen verloren** | `import_drawing.rs` (`DXF_HATCH_FILL`) |
| Ebenen | Kategorien (je DXF-Layer, Farbe und Strichstärke der Ebene), flach unter einer Eltern-Kategorie | Layer-Zustände (eingefroren, gesperrt, Linientyp) ungeprüft | `import_drawing.rs::import_ops`, `layers::plan_import` |
| Linientypen | **nicht übernommen** (nur Strichmuster aus PDF-Import werden Linienstile) | gestrichelte DXF-Linien kommen durchgezogen an | `import_drawing.rs` (`layer_dashes` nur aus PDF), `import.rs` kennt keine Linientypen |
| INSERT / Blöcke | rekursiv aufgelöst (Tiefe 8), Ebene „0" erbt die Ebene der Referenz | Blockdefinitionen, Attribute (ausser als Text) und Instanzen als Objekte gehen verloren | `import.rs` (`MAX_INSERT_DEPTH`) |
| TEXT, MTEXT, ATTRIB | `shape: text` je Zeile; Formatcodes entfernt | Schriftart, Breitenfaktor, Absatzformat ungeprüft | Kopf `import.rs` |
| DIMENSION, LEADER, MULTILEADER | Linien und Text (Anonymblock bzw. aus Definitionspunkten) | **keine Bemassungsobjekte**, nicht mehr änderbar | Kopf `import.rs` |
| 3DFACE, Polyface, MESH | Netzkörper `importedMesh` (nur wenn „Netze importieren") | z-Höhe von 2D-Konturen geht verloren (ausser erkannte Höhenlinien → Gelände) | `import_drawing.rs` (`import_meshes`, `terrain_contours`) |
| Einheiten | `$INSUNITS` wird angewendet | 0/unbekannt = Faktor 1 | Kopf `import.rs` |
| Papierbereich | einzelnes Layout lesbar (`import_layout`) | **Viewport-Inhalt (Modellansicht im Layout) fehlt** | Kopf `import.rs` |
| Bauteile | nur auf Wunsch: Wände, Öffnungen, Stützen, Räume aus Linien **erkannt** (Heuristik, mit Bericht und „unklaren Stellen") | Nicht erkanntes bleibt Linie | `src/io/recognizeDrawing.ts`, `drawing_recognize.rs`, Test `recognizeDrawing.roundtrip.test.ts` |
| Muster-/Linientyp-Dateien | `.pat` (Schraffur) und `.lin` (Linientypen) lesbar | – | `src/io/patParser.ts`, `linParser.ts` |

Rundreise Dossier → DXF → Dossier: Linien/Bögen/Texte kommen wieder, Wände sind danach **Linien**, nicht Wände
(Test `exportDxf.roundtrip.test.ts` liest nur zurück, keine Bauteile).

## STEP

| Richtung | Inhalt | Verlust | Beleg |
|---|---|---|---|
| Export | B-Rep: Wände (je Materiallage, Öffnungen als Löcher/Kerben), Decken, Treppentritte (als Prismen), Dächer (Platte der Gesamtdicke), Extrusionskörper (ohne Abzugskörper) | **Keine Stützen, Bäume, Gelände, Netzkörper, Türen/Fenster als Körper**; Treppen nur Tritte (Geländer ungeprüft); keine Namen, Farben, Ebenen, Geschosse (`SolidSpec` trägt nur Geometrie); Dach als Platte ohne Schichten; Körper, die truck nicht baut, werden übersprungen (Meldung) | `solid_specs.rs::project_solid_specs` (kein Bezug auf `columns`, `trees`, `context`), Test `exportStep.test.ts` („Decke + Tritte"), `exportStep.ts::exportProjectStep` |
| Import | tessellierte Körper → Netzkörper (relativ 0,05 % der Diagonale) | Feature-Baum und exakte Flächen gehen verloren | `readStepFlat`, `useModelImport.ts`, Test `stepImport.test.ts` |

## OBJ, STL, glTF/GLB

| Richtung | Inhalt | Verlust | Beleg |
|---|---|---|---|
| Export OBJ/STL | Dreiecke; ein Objekt je Bauteil; Y-up rechtshändig, Meter. OBJ mit `vn` (je Ecke geteilt bis 30° Knickwinkel wie die 3D-Anzeige, scharfe Kanten bleiben kantig), `usemtl` je Material und `.mtl` mit Farbe (`Kd`) und Deckkraft (`d`) | **OBJ ohne UVs/Texturen**; STL ohne Farbe. Die MTL ist eine zweite Datei: im Speichern-Dialog der App folgt ein zweiter Dialog (Browser: zweiter Download), CLI `obj --out haus.obj` schreibt `haus.mtl` mit, `--no-mtl` oder `--out -` nur das OBJ (Farben dann als Kommentar im Kopf, ohne `mtllib`) | `fileio/src/mesh_export.rs::write_obj`/`write_mtl`, `saveTextWithCompanion` |
| Export glTF/GLB | Knoten je Bauteil (`extras`: Typ, id), Material je Primitive (Farbe, Transparenz), optional nach Geschoss gegliedert | `NORMAL` je Ecke (wie OBJ geteilt bis 30°; Eckpunkte an scharfen Kanten getrennt). Keine Texturen, UVs; im UI nur **GLB** wählbar (`.gltf` per Funktion) | Kopf `mesh_export.rs`, `ExportSaveDialog.tsx` |
| Quelle der Dreiecke | wie das 3D; Extrusionen mit Verjüngung als **Prisma-Näherung** | Dächer, Treppen, Stützen, Bäume (Stamm + Krone), Gelände und Netzkörper sind enthalten (Optionen `context`, `openingParts`) | Kopf `core/src/mesh_data.rs` |
| Import OBJ(+MTL), STL, PLY (mit Flächen), glTF/GLB | Netzkörper je Objekt mit Name, Gruppe und Farbe; Achse und Einheit wählbar bzw. erkannt | **Texturen, Skinning, Morphing, Draco/Meshopt** nicht unterstützt; Dreiecksbudget 6 Mio. (Rest abgeschnitten) | Kopf `mesh_import.rs`, `mesh_import_gltf.rs` |

## PDF und SVG (Ausgabe)

| Weg | Inhalt | Verlust / Grenze | Beleg |
|---|---|---|---|
| Plan-PDF | Vektor (Pfad- und Textoperatoren) aus derselben Szene wie der Bildschirm, A4/A3, Massstab, optionales Schriftfeld | **Eine Seite**; PDF-Ebenen (Optional Content) nur in Blatt-/Publikations-PDF; Schrift Helvetica/Arial (kein Einbetten eigener Schriften, `addFont` nicht im Code) | `exportPdf.ts`, `sceneToPrintSvg.ts`, `pdfLayers.ts` |
| Plan-SVG | dasselbe Druck-SVG ohne jsPDF | – | `exportSvg.ts` |
| CLI-SVG | ohne Schraffurlinien (nur Grundfüllung), ohne Bilder; mit `--hatch` Linien | gedacht für Diffs, nicht für Druck | Kopf `planToSvgString.ts` |
| Blatt-PDF, Publikationssatz | alle Layouts eines Ordners als Mehrseiten-PDF mit Ebenen; DXF/DWG mit Papierbereichen | – | `layoutPdf.ts`, `publishRun.ts` |
| Rasterbilder im Plan | als `<image>` ins Druck-SVG | Auflösung = Quelle | `sceneToPrintSvg.ts::appendImage` |

Unbekannt: wie Acrobat/Preview Umlaute und Sonderzeichen in Planzeichnungen darstellen (ungeprüft).

## PDF-Import (Unterlage)

| Weg | Inhalt | Verlust | Beleg |
|---|---|---|---|
| Vektor | Pfade, Texte einer Seite → 2D-Zeichnung, Ebenen nach Strichstärke und Farbe (`PDF 0.35 #000000`); Massstab über zwei Punkte kalibrieren; Kreise/Bögen aus Bézier-Folgen | Schriften nur als Text, Bilder im PDF nicht übernommen (ungeprüft) | Kopf `pdfVector.ts`, `pdf_vector.rs` |
| Raster | Seite als Bild (Data-URL, pdfjs) | nicht fangbar | `pdfImport.ts` |

## Swisstopo, OSM

Nur Import, alle Abrufe über `netFetch` (`src/net`).

| Quelle | Wird zu | Grenze | Beleg |
|---|---|---|---|
| swissBUILDINGS3D | Netzkörper, Dach als eigene Klasse | v3 nur DWG, in Städten >150 MB je Kachel: Rückfall auf v2 | Kopf `swissBuildings3d.ts` |
| swissALTI3D | Höhenraster → Gelände | bei >400 000 Zellen **dezimiert** | `MAX_GRID_CELLS` in `swissAlti3d.ts` |
| SWISSIMAGE | Luftbild als Bild in der Projektdatei | 0,2 m/px | `swissImage.ts` |
| swisstopo VEC25 | Gebäude-Grundrisse **ohne Höhe**, pauschal 9 m | Höhe geraten | `swissTopo.ts`, `DEFAULT_BUILDING_HEIGHT` |
| OSM (Overpass) | Gebäude, Strassen, Wasser, Grün, Parkplätze, Bahn, Wald als Polylinien | Höhe aus `height`, sonst `building:levels` × 3 m, sonst 9 m; Quellenhinweis/Lizenzangabe im Projekt: ungeprüft | `osm.ts`, `geoContext.ts` |

## Punktwolken (LAS 1.0–1.4, LAZ, E57, PLY, XYZ, PTS)

| Aspekt | Verhalten | Beleg |
|---|---|---|
| Lesen | streamend ausgedünnt (Voxel/Punktbudget, Vorgabe 5 Mio.); Koordinaten f32 relativ zu einem Ursprung | `pointcloud.rs`, `pointCloud.ts` |
| E57 | alle Scans zusammengeführt, Pose angewendet, ungültige Punkte verworfen | `pointcloud_e57.rs` |
| Verwendung | nur 3D-Anzeige (Stufe 1); **nicht im Projekt gespeichert**; kein Fang, kein Schnitt/Grundriss | `TODO.md` [27] |
| Export | keiner | – |

## Listen und Berichte (CSV, Tabellen)

| Bericht | Inhalt | Verlust / Grenze | Beleg |
|---|---|---|---|
| Bauteilliste (Menü Export, `.csv`) | eine Zeile je Bauteil-Vorkommen (Wand, Decke, Tür, Fenster, Treppe, Extrusion, Dach, Stütze); UTF-8 mit BOM | **Räume nicht enthalten** (eigener Bericht) | `exportSchedule.ts`, `useProjectFileActions.ts::runExport` |
| Flächen, Raumprogramm, Raumbuch, Fenster-/Türliste, U-Werte | CSV, SVG und PDF aus einem Berichtsmodell | je Bericht ungeprüft | `src/export/README.md` |
| Raumprogramm-Import | `.xlsx`, `.ods`, `.csv`/`.tsv`; Spalten werden vorgeschlagen | – | `roomProgramImport.ts`, `sheet_import.rs` |

## BCF

`.bcfzip` 2.1/3.0 lesen und schreiben (Text, Kamera, Komponenten-GUIDs, Snapshots), `src/io/bcf.ts` und `fileio/src/bcf.rs`.
Die Zuordnung GUID zu Bauteil läuft über `bcfMatch.ts`: übernommene `ifcGlobalId` (IFC-Import, [201]) zuerst, sonst die
Dossier-eigene, deterministische GUID. Themen leben in einer eigenen Datei, nicht im Projekt.

## Querschnitt: was nirgends mitreist

| Eigenschaft | `.obp` | IFC | DXF/DWG | STEP | OBJ/glTF | PDF |
|---|---|---|---|---|---|---|
| Ebenen/Klassen | ja | Option „Dossier-Ebenen" als System | Layer, flach | nein | nein | PDF-Ebenen nur im Blatt-PDF |
| Stifte, Strichstärke je Element | ja | – | nur je Ebene | – | – | Strichstärken in Papier-mm aus dem Plan (Stiftsätze im Einzelnen ungeprüft) |
| Gruppen | ja | nein | nein | nein | nein | – |
| Schraffuren | ja | nein | `HATCH`, Kurvenmuster als Linien | – | – | ja |
| Texte, Bemassungen | ja | nein | `TEXT`, `DIMENSION` | nein | nein | ja |
| Layouts/Blätter | ja | nein | Papierbereich (optional) | nein | nein | Blatt-PDF |
| Gelände, Netzkörper | ja | nein | nein | nein | ja | – |
