# src-tauri/core/src (Crate `dossier-core`)

Der Rust-Kern: Dokument, Ops und Verlauf, Projektformat und alle Ableitungen. Läuft nativ (`cargo test`,
Tauri) und als WASM (`npm run build:core` → `src/engine/pkgCore`). Überblick über das Zusammenspiel:
`doc/ARCHITEKTUR.md`.

Jede Datei beginnt mit einem `//!`-Kommentar; die Nummern in eckigen Klammern verweisen auf `TODO.md`.
Neues Modul: `<modul>.rs` und `mod` in `lib.rs`, Bindungen in `web/<modul>.rs` und `mod` in `web/mod.rs`.

## Dokument, Grenze, Modell

| Datei | Inhalt |
|---|---|
| `lib.rs` | Modul-Liste |
| `document.rs` | `Document`: Projekt als JSON-Baum, typisierte Sicht, `commit()`, Undo/Redo, `Revs` (Änderungsstände für die Caches) |
| `ops.rs` | `Op`, Prüfung (`validate()`), Verlauf (`History`) |
| `queries.rs` | Tabelle der Abfragen: `run()`, `run_doc()`, `run_bin()`, `run_bin_doc()` |
| `project_format.rs` | Projektdatei lesen, migrieren, schreiben; `KNOWN_KEYS` |
| `project_refs.rs` | Warnungen zu einem ladbaren Projekt (`dossier-cli validate`) |
| `model/` | typisiertes Modell: `generated.rs` (Strukturen, von Hand gepflegt), `manual.rs` (Typen mit Tag), `check.rs`, `lenient.rs`, `helpers.rs`, `ts_export.rs` (erzeugt `src/model/types.generated.ts`) |
| `json_util.rs` | Hilfen für den rohen JSON-Baum |
| `flat.rs`, `flat_read.rs`, `flat_write.rs`, `hatch_flat.rs` | flache `f64`-Kodierungen für die WASM-Grenze |
| `export_flat.rs` | gemeinsamer Puffer der Export-Sammler (gelesen von `fileio`) |
| `js_fmt.rs` | Zahlen formatieren wie JavaScript (bitgleiche Ausgaben) |
| `wasm_alloc.rs` | Heap-Wachstum im WASM |
| `web/` | WASM-Bindungen je Modul (Feature `web`); `web/document.rs` mit den `doc_*`-Funktionen |

## Plan, Schnitt, Ansicht

| Datei | Inhalt |
|---|---|
| `plan/` | Grundriss, Deckenspiegel, Schnitt, Ansicht, Ausgaben; eigene `plan/README.md` |
| `gpu_compile.rs` | GPU-Kompilierung von Plan-Puffern (nativer macOS-Weg) |
| `style.rs` | Farben, Schraffur und Schnitt-Linienstil aus dem Modell |
| `standards.rs` | Standard-Bibliothek: Baustoffe mit SIA-400-Schraffur und Kennwerten, Linientypen, Standard-Aufbauten |
| `text_layout.rs`, `rich_text.rs` | Text-Layout (Zeilen, Umbruch) und Bearbeiten von Rich-Text |

## 3D

| Datei | Inhalt |
|---|---|
| `model3d/` | 3D-Ableitung aus dem Projekt: `parts()` in `mod.rs`; je eine Datei für Decken, Stützen und Bäume, Wände, Öffnungen, Treppen, Dächer, Kontext, freie Körper (`solids.rs`, [115]), Zeichnungs-Spuren, Pick-Geometrie, Klassen-Filter (`classes.rs`, [180]); Tests in `tests.rs` |
| `model3d_cache.rs` | inkrementelle 3D-Ableitung (Cache je Wand und Öffnung) |
| `wall_bands.rs`, `wall_mesh_cut.rs` | Schichtbänder einer Wand; Wandnetz mit echtem Loch für Datei-Exporte |
| `ceilings3d.rs`, `columns3d.rs`, `stairs3d.rs`, `openings3d.rs`, `drawing2d_3d.rs`, `mesh3d.rs` | Netze je Bauteilart |
| `explode3d.rs`, `highlight3d.rs`, `surface_pattern3d.rs` | Explosionsaxonometrie, Auswahl-Umrisse, Ansichtsschraffur auf 3D-Flächen |
| `solid_bool.rs`, `solid_specs.rs`, `solid_mesh.rs` | Körper-Booleans über Manifold; B-Rep-Spezifikationen für truck; Netze der freien Körper für Grundriss, Schnitt, Ansicht, 3D und Kennwerte ([115]) |

## Geometrie

| Datei | Inhalt |
|---|---|
| `joins.rs` | Wandknoten: Gehrung, T-Stoss, Kreuzung, je Schicht nach Priorität (`compute_joins()`) |
| `wall_arc.rs` | Bogenwände |
| `roof.rs`, `roof_skeleton.rs`, `skeleton.rs`, `roof_assembly.rs`, `roof_parapet.rs`, `dormer.rs` | Dächer (Straight Skeleton), Dach an Dach, Attika (Flachdach-Brüstung), Gauben |
| `stair.rs`, `stair_rail.rs`, `stair_guard.rs` | Treppen-Geometrie, Handlauf, Absturzsicherung am Deckenloch (Grundriss, 3D, IFC) |
| `opening_geom.rs`, `opening_shape.rs`, `opening_detail.rs`, `opening_presets.rs`, `opening_preview.rs`, `opening_slide.rs` | Öffnungen: Symbol, Formen, Rahmen, Vorlagen, Vorschau, Verschieben in der Wand |
| `room_area.rs`, `room_boundary.rs` | Raumflächen nach SIA 416; Raum-Erkennung aus Wänden |
| `polygon_bool.rs`, `polygon_holes.rs`, `bulge.rs`, `curves.rs`, `delaunay.rs` | 2D-Booleans (i_overlay), Löcher, Bögen, Kurven, Triangulierung |
| `terrain.rs`, `excavation.rs` | Gelände (TIN aus Höhenlinien), Baugrube |
| `hlr.rs`, `hlr_fill.rs` | exakte Sichtbarkeit (Hidden-Line-Removal, Durchdringungslinien) für Schnitt und Ansicht; sichtbare Teilflächen (Füllungen der Ansicht) |
| `mesh_section.rs`, `mesh_view.rs`, `mesh_repair.rs` | Ebenenschnitt beliebiger Netze; importierte Netze; Netz-Reparatur |
| `voids.rs` | Abzugskörper in Grundriss und Schnitt |
| `surface_pattern.rs` | Ansichtsschraffur (Lattung, Verband, Schindeln …) |
| `grid.rs`, `tree.rs`, `auto_dimensions.rs` | Achsraster, Bäume, automatische Aussenbemassung |

## Befehle, Griffe, Auswahl, Verwaltung

| Datei | Inhalt |
|---|---|
| `commands.rs` | Einstieg der Befehle: `ops()` verteilt eine Anfrage `{cmd, …}` |
| `cmd_create.rs` | Zeichenbefehle für Bauteile: neue Elemente, Vorschau, Treffer |
| `cmd_draw.rs`, `cmd_edit.rs`, `cmd_split.rs`, `cmd_paste.rs` | 2D zeichnen und bemassen, bearbeiten, teilen, einfügen |
| `cmd_transform.rs`, `cmd_wall_edit.rs`, `cmd_solid.rs` | Transformieren; Wände bearbeiten; Körper, Gelände, Sonderbefehle |
| `cmd_context.rs` | [193] Höhenversatz und Höhe je Höhenlinie von Gelände-/Umgebungs-Elementen (`contextOffset`, `contourZ`) |
| `grips.rs`, `grip_drag.rs` | Griffe: Geometrie und Rechnung je Mausschritt |
| `snap.rs`, `snap_model.rs` | Objektfang |
| `selection_info.rs`, `selection_filter.rs` | Objekt-Info der Auswahl; Export „nur Auswahl" |
| `dim_assoc.rs`, `magic_wand.rs`, `polyline_vertex.rs`, `drawing_recognize.rs` | assoziative Bemassung, Zauberstab, Punkttypen, Bauteile aus Zeichnung erkennen |
| `layers.rs`, `levels.rs`, `groups.rs`, `pens.rs`, `reorder.rs`, `folder_tree.rs` | Ebenen, Geschosse, Gruppen, Stiftsätze, Z-Reihenfolge, Ordner |
| `layout_model.rs`, `sheet_viewports.rs`, `sheet_table.rs`, `presentation_sheet.rs` | Layout-Blätter, Viewports, Tabellen, Präsentationsplan |
| `parametric_walls.rs`, `geo_translate.rs`, `geo_rebase.rs` | parametrische Wände; Projekt verschieben; Ursprung für Exporte |

## Analyse

| Datei | Inhalt |
|---|---|
| `sun.rs` | Sonnenstand und Boden-Schatten |
| `site_rules.rs` | Baurecht der Parzelle |
| `kennzahlen.rs`, `flaechen.rs`, `area_report.rs` | Kennzahlen und Flächennachweise nach SIA 416 |
| `room_program.rs`, `room_book.rs` | Raumprogramm (Soll/Ist), Raumbuch |
| `u_value.rs`, `clash_broad.rs` | U-Wert aus dem Schichtaufbau; Vorstufe der Kollisionsprüfung |

## Import und Export

| Datei | Inhalt |
|---|---|
| `import_ifc.rs`, `import_context.rs` | IFC zu Bauteilen bzw. Kontext-Netzen (gelesen hat vorher `fileio`) |
| `import_drawing.rs`, `import_terrain.rs`, `geo_mesh.rs` | DXF/DWG-Zeichnungen ins Projekt (`import_terrain`: Höhenlinien erkennen, [143]); swissBUILDINGS3D-Netze |
| `ifc_data.rs`, `ifc_quantities.rs`, `ifc_stairs.rs` | IFC-Export-Sammler, Basismengen, Treppen |
| `mesh_data.rs` | Sammler für OBJ, STL, glTF |
| `export_schedule.rs`, `opening_schedule.rs` | Bauteilliste, Fenster- und Türliste |

## Tests

`cargo test` in `src-tauri/core`. Tests stehen meist als `mod tests` am Dateiende; grössere als eigene
Dateien (`drawing_recognize_tests.rs`, `import_drawing_tests.rs`, `wall_join3d_tests.rs`, `plan/*_tests.rs`).
Messungen von Hand in `../tests/` (`bench58.rs`, `bench152.rs`) und `plan/perf_tests.rs`.
