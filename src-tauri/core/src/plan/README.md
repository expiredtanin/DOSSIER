# src-tauri/core/src/plan

Plan-Ableitungen im Kern: Grundriss, Deckenspiegel, Schnitt, Ansicht und ihre Ausgaben (render2d-Szene,
SVG, Druck-SVG, DXF). Alles arbeitet auf dem typisierten Projekt aus dem Dokument und erzeugt
`Primitive` (`prim.rs`), die als Plan-Puffer (`buf.rs`) zu den Verbrauchern reisen. Der Weg Schritt für
Schritt: `doc/ARCHITEKTUR.md`, Abschnitte 3 bis 5.

Viele Dateien beginnen mit „Rust-Gegenstück zu …ts" und nennen TS-Dateien, die es nicht mehr gibt. Das ist
Herkunft, kein Wegweiser.

## Grundriss: Einstieg und Domänen

| Datei | Inhalt |
|---|---|
| `domains.rs` | Einstieg: `PlanArgs`, `Ctx`, `plan_domains_buf()`, `plan_domains_cached()`; Domänen Decken, Dächer, Räume mit Stempel, Stützen, Körper; Reihenfolge `GROUPS` |
| `cache.rs` | Caches der Plan-Erzeugung (übrige Domänen, Zeichnungs-Stücke), Schlüssel aus `Revs` des Dokuments |
| `walls.rs` | Wände und Öffnungen: Filter, Verschneidung, Stil, Pick-Ids (`plan_walls()`) |
| `wall_poche.rs` | Geometrie der Wand-Poché (Segmente zwischen Öffnungen, Gehrungsbänder, Schichtfugen), Decken-Umriss gegen Wand-Fussabdrücke |
| `wall_columns.rs` | Wand endet an einer Stütze: wer dominiert |
| `openings.rs` | Tür- und Fenstersymbol im Grundriss (Geometrie aus `../opening_geom.rs`) |
| `stairs.rs`, `stair_symbol.rs` | Treppen: Filter und Stil; Symbol (Tritte, Lauflinie, Pfeil, Bruchlinie) |
| `drawings.rs` | freie 2D-Zeichnungen (Linie bis Bild, Bemassung, Blöcke), Zeichnungs-Stücke, kompakte Linien-Unterlage |
| `context.rs` | Kontext (Höhenlinien, Fussabdrücke importierter Gebäude, Gelände) und Schnittführungs-Symbole |
| `mesh_plan.rs` | importierte Netze und ([G1]) freie Körper über ihr Kern-Netz im Grundriss: geschnitten, darunter, darüber |
| `ceiling_plan.rs` | Deckenspiegel als eigene Ebenen-Art |
| `floor_finish.rs` | Bodenbelag-Muster nach Massstab |
| `model_view.rs` | Modelldarstellung ([173]): Optionen je Bauteilart über dem Detailgrad, Rangfolge Element > Typ > Stufe > Basis |
| `trees.rs` | Bäume in Grundriss, Schnitt und Ansicht |
| `cameras.rs` | [213] Kameras im Grundriss: Gehäuse, Sichtkegel, Ziel, Name, Pick-Bänder (Klasse „Kameras“) |
| `stamp_place.rs` | Hindernisse für die Lage der Raumstempel |
| `view_range.rs` | Ansichtsbereich: Schnitthöhe, Ober- und Unterkante der Sicht |
| `extras.rs` | Zutaten: Schatten und Baurecht, Abzugskörper, Strichstärken nach Massstab, Schwarz-Weiss, Ausmass |
| `sketch.rs` | Skizzenstil (wirkt beim Schreiben des Puffers) |
| `misc.rs` | kleine Bausteine: Kontext-Fussabdruck, Schnittführungs-Symbol, Linienenden |

## Stil und Regeln

| Datei | Inhalt |
|---|---|
| `style.rs` | Attribut- und Schraffur-Auflösung (By-Layer, By-Object), Massstabsregeln wie `solid_cut()` |
| `overrides.rs` | Override-Regeln: `effective()` je Element, `effective_layer()` je Bauteilschicht |
| `line_pattern.rs` | Strichmuster in Papier-mm |
| `line_ends.rs` | Linienenden und -ecken (eine Projekt-Einstellung für alle Ausgaben) |

## Schnitt und Ansicht

| Datei | Inhalt |
|---|---|
| `section/mod.rs` | Schnitt: Typen (`LevelSpec`, `Cut`, `Output` …), Override-Regeln der Bänder, Gesamtrechnung `compute_section()` |
| `section/input.rs` | Eingabe des Prismen-Schnitts (`render3d::section`) aus `model3d`, mit der früheren JSON-Rundung |
| `section/bands.rs` | Besitzer und Stil der Bänder (`attach_cut_styles()`, `split_wall_layers()`), Leibungen, Terminierung, Dominanz |
| `section/shapes.rs` | Sonderformen: Formöffnungen, Dach-Schnittspur, Monolith, Treppenläufe, Schnitt parallel zur Wand |
| `section/voids.rs` | Aussparungen: Abzugskörper, Körper mit Abzugs-Rolle, Taschen |
| `section/meshes.rs` | Netze (Körper, importierte Netze), Gelände und Erdreich |
| `section/projection.rs` | Projektion hinter der Ebene (`projection_edges()`, exakte Sichtbarkeit) |
| `section/primitives.rs` | Primitive (`section_primitives_at()`), dünne Schichten, Bausteine `polygon()`/`line()`/`Acc` |
| `section/openings.rs` | geschnittene Fenster und Türen (`section_opening_primitives()`) |
| `section/query.rs` | Abfrage `section_plan_buf()` mit Cache |
| `section_bands.rs` | Vereinigung achsparalleler Schnitt-Rechtecke, Dach-Schnittspur |
| `elevation/mod.rs` | Ansicht: gemeinsame Konstanten, `elevation_primitives_with()` (Stil, Maler-Ordnung), Abfrage `elevation_plan_buf()` |
| `elevation/face.rs` | Flächen der Ansicht (`Role`, `Face`) und Override-Regeln je Fläche und Öffnung |
| `elevation/cull.rs` | Dach als Verdeckung: Stirnflächen (`fascia_quads()`), Flächen unter dem Dach weglassen |
| `elevation/collect.rs` | Flächen aus dem Modell einsammeln und projizieren (Wände, Decken, Dächer, Stützen, Netze), Eck-Verlängerung |
| `elevation/mesh_cull.rs` | importierte Netze: Dreiecke vereinigen, verdeckte Flächen über ein Raster weglassen |
| `elevation/openings.rs` | Fenster und Türen: Verglasung, Flügel, Rahmen, Leibungsschatten, Flächenöffnungen |
| `elevation/silhouette.rs` | Silhouette, Kanten mit exakter Verdeckung, Geländekante |
| `elevation/patterns.rs` | Oberflächenmuster auf Ansichtsflächen |
| `elevation/tests.rs` | Tests der Ansicht |
| `elevation_geom.rs` | Geometrie der Ansicht: Verdeckung, Schlagschatten, Eck-Verlängerung, Öffnungen |
| `grid_view.rs` | Achsraster in Schnitt und Ansicht |
| `underlay.rs` | Grundriss-Unterlage unter Schnitt und Ansicht |

## Puffer und Ausgaben

| Datei | Inhalt |
|---|---|
| `prim.rs` | `Primitive`: das Austauschformat (JSON-Form gleich den TS-Objekten) |
| `buf.rs` | Plan-Puffer v2: `Writer`, `View`; Formatbeschreibung im Kopf |
| `parts.rs` | zusammengesetzter Plan aus Abschnitten mehrerer Puffer |
| `scene.rs` | render2d-Szene (binär für den Bildschirm, f64 für Druck und CLI) |
| `pick.rs` | räumlicher Index für Auswahl und Picken |
| `svg.rs` | Plan-SVG (CLI, Goldens, Vorschau) |
| `print_svg.rs` | Druck-SVG in Papier-mm für Layout-Blätter |
| `arc_fit.rs` | Bögen in Vielecken/Linienzügen erkennen ([169]): Kreis-, Ellipsen- und Ausgleichskreisbögen; Kreis/`A`-Pfad (SVG), Bulges bzw. ELLIPSE (DXF, auch HATCH-Ränder), feine Tessellierung (Bildschirm) |
| `dxf.rs` | DXF/DWG-Sammler; die Datei schreibt `src-tauri/fileio/src/export.rs` |
| `text.rs` | Texte der Ausgaben (Raumstempel, Einzeltexte) |

## Tests

Die meisten Dateien haben `mod tests` am Ende. Eigene Testdateien: `wall_join_tests.rs` (Wandknoten im
Grundriss), `arc_output_tests.rs` (runde Stütze/Bogenwand als Kreis und Bogen in allen Ausgaben), im Ordner `section/` die Tests des Schnitts (`tests.rs`, `mesh_tests.rs` für importierte Netze,
`ts_faelle.rs`, `dach_faelle.rs`, `abzug_faelle.rs`, `wand_an_dach.rs`, Messung `bench.rs`), `perf_tests.rs` (Leistung, von Hand:
`cargo test --release --lib bench159 -- --ignored --nocapture`, siehe Dateikopf).
