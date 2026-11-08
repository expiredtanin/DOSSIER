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
| `mesh_plan.rs` | importierte Netze im Grundriss: geschnitten, darunter, darüber |
| `ceiling_plan.rs` | Deckenspiegel als eigene Ebenen-Art |
| `floor_finish.rs` | Bodenbelag-Muster nach Massstab |
| `trees.rs` | Bäume in Grundriss, Schnitt und Ansicht |
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
| `section.rs` | Schnitt: `compute_section()`, `section_primitives_at()`, geschnittene Öffnungen, Abfrage `section_plan_buf()` |
| `section_bands.rs` | Vereinigung achsparalleler Schnitt-Rechtecke, Dach-Schnittspur |
| `elevation.rs` | Ansicht: `elevation_primitives_with()`, Stil, Maler-Ordnung, Abfrage `elevation_plan_buf()` |
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
| `dxf.rs` | DXF/DWG-Sammler; die Datei schreibt `src-tauri/fileio/src/export.rs` |
| `text.rs` | Texte der Ausgaben (Raumstempel, Einzeltexte) |

## Tests

Die meisten Dateien haben `mod tests` am Ende. Eigene Testdateien: `wall_join_tests.rs` (Wandknoten im
Grundriss), `section_mesh_tests.rs` (importierte Netze im Schnitt), `perf_tests.rs` (Leistung, von Hand:
`cargo test --release --lib bench159 -- --ignored --nocapture`, siehe Dateikopf).
