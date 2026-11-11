# Dossier — Arbeitsliste

Stand 11.11.2026. Die vollständige bisherige Liste mit allen Details, Messwerten und Befunden steht
unverändert in [`doc/archiv/TODO-bis-2026-11-08.md`](doc/archiv/TODO-bis-2026-11-08.md) (rund 4500 Zeilen).
Wer zu einer ID mehr wissen will (Entscheide, Tests, Bilder), sucht dort nach `**[ID]`.

## Regeln

- **Stand:** ◐ teilweise · ○ offen. Erledigtes steht nur in der Liste „Erledigt“ am Ende. Abgelehnte Ideen
  stehen im Archiv („Bewusst nicht übernommen“).
- **Grösse** (eine Person mit Agenten): S ≤ 1 Tag · M ≤ 1 Woche · L ≤ 1 Monat · XL > 1 Monat.
  Steht keine Grösse im Archiv, ist sie hier geschätzt.
- **IDs sind stabil.** Neue ID = nächste freie Zahl nach der höchsten im Archiv und hier (aktuell 179);
  nie eine ID wiederverwenden oder umnummerieren. Präfix-IDs (`[K]`, `[G]`, `[T]`, `[B]`, `[C]`) bleiben.
- **Pro Punkt:** was fehlt · wo im Code · Grösse. Höchstens ein bis drei Sätze je Punkt;
  Messwerte und Befunde gehören in den Commit.
- **Nachführen** im selben Commit wie der Code: Stand ändern, Datum, was offen bleibt. Ist ein Punkt fertig,
  wandert er mit ID, Titel und Datum in „Erledigt“.
- **Ehrlich:** „nicht in der Tauri-App/auf dem Mac geprüft“ ist ein offener Rest, kein Detail. Alles, was
  nur im Linux-Container (CLI-SVG, Chromium) angesehen wurde, ist unter „Mac-Gegenprobe“ gesammelt.
- Arbeitsablauf, Test zuerst, Commit-Format: `CLAUDE.md`. Gesamtbild des Codes: `doc/ARCHITEKTUR.md`.

## Stand: was Dossier heute kann

- **Modell:** ein semantisches `Project` im Rust-Kern (`src-tauri/core`), Änderungen nur über Ops mit Verlauf
  (Undo/Redo) und Prüfung im Kern; TS hält Oberfläche, Zustand und eine Leseansicht.
- **Bauteile:** Wände (gerade und Bogen, mehrschichtig, Gehrung/T-Stoss), Decken, Dächer (beliebiger Umriss mit
  Höfen, Gauben), Stützen, Treppen (gerade, L, U, Wendel), Fenster/Türen mit Typen, Formöffnungen,
  Dachfenster, Räume, Achsraster, Gelände, Baugrube, Bäume, Kontext-Objekte und -Netze.
- **Ableitungen aus dem Modell:** Grundriss, Schnitt, Ansicht, 3D (Manifold-Booleans), Schatten/Sonnenstand,
  Baurecht-Hülle, Flächen nach SIA 416/IVHB, Raumbuch, Kennzahlen, U-Wert, Fenster-/Türliste.
- **Darstellung:** zwei Rust-Engines `render2d` und `render3d` (WebGPU/Metal), SIA-400-Schraffuren und
  -Linientypen, Objektstile, Ansichtsvorlagen, Ansichtsbereich, Skizzenstil, Explosionsaxonometrie.
- **Planproduktion:** Layout-Blätter mit Viewports, Legenden, Tabellen, Publikationssätze, PDF mit Ebenen,
  Aussenbemassung, assoziative Bemassung.
- **Import/Export:** DXF/DWG, IFC (Import als Mesh oder Bauteile, Export mit Psets/Geometrie), STEP, OBJ/STL/glTF,
  PDF-Vektorfang, Swisstopo, Punktwolken, BCF.
- **Werkzeuge:** Befehlszeile mit Zustandsautomaten, Zeichen- und Bearbeitungsbefehle, Griffe, Fang, Zauberstab,
  Bauteile-Erkennung aus 2D-Linien; `dossier-cli` (Plan, Schnitt, Ansicht, Kennzahlen, IFC, MCP).
- **Plattform:** Tauri/macOS (Hauptplattform), Electron/Linux, Browser-Build; Autosave mit Wiederherstellen,
  atomares Speichern, Tests (Rust, vitest, Golden-Ausgaben, e2e).

---

## Grundriss

- ◐ **[182]** Tabs/Ansichten wie Archicad (11.11., Wunsch Maintainer). Umgesetzt: Reiter-Arten Grundriss · 3D · Schnitt · Ansicht ·
  2D-Zeichnung/Layout werden nie gemischt (`navigateToLevel`/`switchViewKind` in `state/viewTabs.ts`, Anwendung in
  `state/tabNavigation.ts`): Geschoss im Navigator behält die Art (3D bleibt 3D, nur das Geschoss wechselt); Schnitt/Ansicht/Zeichnung/
  Layout/Ausschnitt anderer Art öffnen einen eigenen Reiter bzw. springen zum offenen; Grundriss-/3D-Knöpfe und Menü sind in jedem
  Reiter aktiv und wechseln/öffnen den 3D- bzw. Grundriss-Reiter (Titel „3D · Geschoss"). Der 3D-Live-Schnitt „3D im Schnitt-Reiter"
  entfällt damit als Einstieg (toter Auto-Schnitt in `useSectionLineState` entfernt; der Live-Schnitt per Schalter im Objekt-Info der
  Schnittlinie bleibt im 3D-Reiter). Knopf „Grundriss" nur im Grundriss-Reiter hervorgehoben (`isPlanKindActive`, 11.11.). Offen: nicht in der Tauri-App geprüft. · S
- ◐ **[181]** Importe als eigenständige Elemente (11.11., Wunsch Maintainer). Umgesetzt (11.11.): Gelände, Höhenlinien,
  Netzkörper (Nachbargebäude, IFC/OBJ/STEP/DXF-Netze), Luftbilder, Baugruben sind normale Elemente mit Pflicht-Klasse
  (`categoryCode: String`); Sichtbarkeit nur über die Klasse (kein „ohne Kategorie immer sichtbar", kein `hidden`, kein
  Gruppierungs-`layer`); Herkunft nur als Auskunft `source` (Objekt-Info). IFC-Gelände (`IfcSite`/Name) wird beim Import ein
  Gelände-Element (`import_context::ifc_meshes`), `mesh_view::is_terrain` entfällt. Panel „Gelände" ohne Import-Liste (nur
  Aktionen); Auswahl im Elemente-Panel (Knoten „Gelände & Umgebung"), Klasse im Kopf der Objekt-Info änderbar. Entwurf in
  `doc/ARCHITEKTUR.md` Abschnitt 8. Geprüft: Rust/vitest/e2e, Musterhaus komplex mit Nachbarnetzen Grundriss 1:200/Schnitt/
  Ansicht per CLI vor/nach byte-gleich. Offen: Linien des Standort-Imports (OSM/swisstopo-Umrisse) bleiben je Klasse ein
  `contourSet` statt einzelner 2D-Zeichnungen; Tag-Namen `importedMesh`/`terrainMesh` historisch; Mac-Gegenprobe. · L
- ◐ **[180]** Alles Sichtbare auf Ebene/Klasse (11.11., Vorgabe Maintainer). Umgesetzt (11.11.): Audit-Tabelle in
  `doc/ARCHITEKTUR.md` 3.6; Standard-Klassen der abgeleiteten Darstellung `08 Schatten` (Sonnenschatten Grundriss,
  Schlagschatten Ansicht), `81 Auto-Bemassung` (Befehl `autodim`, je Kette änderbar), `82 Höhenkoten` (automatische
  Koten Schnitt/Ansicht), `91 Schnittmarken` (statt `90`) in `standards.rs` („Standards laden", neue Projekte,
  Musterprojekte; fehlt die Klasse ⇒ sichtbar); Körper/Abzugskörper mit Pflicht-Klasse (`ExtrudedSolid.categoryCode`,
  Objekt-Info änderbar); Schnitt: Projektionskanten und Raster nach Klasse; Ansicht: Klassen wirken auch ohne
  Darstellungsmodus (Blatt-Ausschnitte zeigten ausgeblendete Klassen), Öffnungen (samt Wirt), Treppen, Raster, Dachmuster
  nach Klasse (Nebenwirkung: kein doppeltes Ziegelraster mehr auf dem Hauptdach, Golden Ansicht Süd); CLI `--hide`;
  Tooltip im Ebenen-Panel (de/en). Tests `plan/derived_class_tests.rs`, `src/plan/derivedCategories.test.ts`. Nachtrag (11.11.):
  ausgeblendete Klassen (`invisible`/`norender`) nehmen im Schnitt an Dominanz und Verdeckung nicht mehr teil
  (`compute_section_vis`: Schnittbänder, Körper, Netze, HLR-Flächen), Schnitt-Cache mit den ausgeblendeten Klassen im
  Schlüssel; Ansicht: ausgeblendete Dächer kappen keine Wände mehr (`cull_under_roofs`); grau verdeckt weiter. Tests
  `section/tests.rs` (`ausgeblendete_klasse_verdeckt_nicht`, `schnitt_cache_kennt_ausgeblendete_klassen`); Golden
  Schnitt A komplex (Carport-Dachlinie ohne Lücken bei Klasse 25 aus).
  3D (11.11.): jedes Teil kennt sein Element (`RMesh`/`RRoofLayer.owner`, Wände/Decken/Treppen über ihre id), Filter
  `model3d::ClassFilter` (Ebenen-Baum samt Elternklassen, dazu `hide` = was der Darstellungsmodus nicht zeichnet) NACH
  dem Cache: Wände, Öffnungen (auch mit dem Wirt), Decken, Dächer, Stützen, Bäume, Treppen samt Geländer, Kontext,
  2D-Spuren, Flächenmuster, truck-Körper fehlen in Viewer, Explosion, Pick und `model3dParts` (CLI `model3d`);
  `layers` zählt im 3D-Cache nicht als globale Änderung, Teil-Updates halten ausgeblendete Einträge (`wallKeep`/
  `openingKeep`), Öffnungs-Varianten je Wand gemerkt; Schatten im 3D nach `08`, zulässige Hülle nach `01`. Tests
  `model3d/classes.rs`, `model3d_cache.rs::class_filter_without_rebuild`, `src/plan/toWalls3d.classes.test.ts`.
  Offen: grau im 3D noch nicht
  gedämpft (render3d hat nur `set_ghost` für die Hülle); natives Mac-3D-Fenster bekommt nur den Ebenen-Baum, nicht
  den Darstellungsmodus; Datei-Exporte (OBJ/glTF/IFC/STEP) bleiben vollständig; kein e2e (3D-Pick headless unzuverlässig);
  nicht in der Tauri-App/auf dem Mac geprüft. · M
- ○ **[185]** Navigation wie Archicad (12.11., Wunsch Maintainer): Grundriss-Geschosswechsel behält Zoom/Ausschnitt exakt; Cmd+5 Geschoss runter, Cmd+6 hoch; Cmd+3 mit Auswahl (aus Grundriss/Schnitt/3D) → 3D-Tab nur mit der Auswahl (Tab-Titel „3D · Auswahl“), ohne Auswahl → wieder alles; Cmd+4 blendet gewählte Objekte im 3D temporär aus (zurück mit Cmd+3). Sonnet. · M
- ◐ **[133]** Musterhaus komplex: Rest. Skalieren-Kopie lässt `position`/Breite unverändert (10.11.: Skalieren skaliert
  `position`/`width` der Wandöffnungen bei Kopie und Original, Test `skalieren_skaliert_oeffnungen`). 11.11.: Schraffur-
  Ausbreiten: Vollfläche füllt in Schraffurfarbe, Bild-Schraffur als `<pattern>`/`<image>` (CLI `--hatch`; Druck/PDF hatte
  beides schon), eine gemeinsame Linien-Funktion `print_svg::hatch_runs`; Löcher (Ring mit Brücke) liefen schon richtig,
  jetzt per Test belegt (`plan/hatch_fill_tests.rs`, Szene/CLI/Druck). Bildschirm (render2d) zeichnet Vollflächen-/Bild-
  Schraffur nicht selbst (Füllung des Erzeugers) und Verläufe fehlen in allen Ausgaben. Nur im Linux-Container geprüft. · S
- ◐ **[140]** Plandarstellung. (9.11.: Stempel in Tusche ohne farbige Auszeichnung, eigene Stempel ab 1:200
  verkleinert, IFC-Räume ohne festen Anker, Schatten-Reihenfolge geprüft; Rest der Liste war schon erledigt.)
  Offen: Fang-Punkt des Stempels rechnet mit Detail „mittel“; Deckenspiegel-Stempel ohne Hindernisse; Mac-Gegenprobe
  (Kern `plan/domains.rs`, `plan/extras.rs`). · S
- ◐ **[177]** Raumstempel im Archicad-Stil (10.11., Wunsch Maintainer). Standard jetzt linksbündig (Block um den Stempelpunkt,
  Zeilen links im Block), Aufbau Name (gross, fett) · Nummer (eigene Zeile darunter) · Fläche; die SIA-416-Kategorie steht
  nicht mehr im Stempel (Attribut des Raums; nur mit „SIA-Kategorie anzeigen“ = `showUsage`, neue Stempel Vorgabe aus), neue
  Option `showDivider` (Trennlinie unter dem Namen); Ausrichtung je Zeile bleibt wählbar. Bestehende Stempel mit
  `showUsage: true` behalten die Zeile, fehlende Ausrichtungen gelten jetzt als links. Offen: Mac-Gegenprobe (Metal/native
  Ansicht) (Kern `plan/domains.rs`, `src/panels/RoomStampEditor.tsx`). · S

- ◐ **[141]** Wandecken. 9.11.: Wand und Stütze überlappen nicht mehr — runde Stütze an der Kontur, Wand durch
  bzw. breiter als die Stütze, Stütze kürzer als die Wand (3D: `model3d::carve_at_columns`, Streifen an den
  Konturkanten; Grundriss: `wall_columns::carve_walls_under_columns`, Stütze unter der Schnitthöhe als Ansichtskante),
  Längsschnitt in einer Wand zeigt die getroffene Schicht (`split_layers_along`). IFC (9.11.): Stütze mit
  mehreren Höhenabschnitten (`column_pieces`) als Satz `COLUMN_PIECES` (20) → EIN IfcColumn mit je einer
  Extrusion pro Abschnitt in einer SweptSolid-Darstellung, Menge = Summe (`column_pieces_quantities`); ein
  Abschnitt bleibt `COLUMN` (10). Offen: Längsschnitt ohne Anschlag-Nasen/Schichteinzug; Muster bei ungeraden Maschen;
  Schnitt genau in einer Wand-Stirnfläche: Lücke in der Projektionskante über den Streifen. · M
- ◐ **[166]** Dämm-Striche (EPS/XPS, „Dämmstoffe (SIA-Linien)") quer zur Wand. 9.11.: Szene/PDF und CLI-/Druck-SVG/DXF
  lasen den Schraffur-Winkel um 90° verschieden (Standard 0°↔90° hin und her); jetzt alle über `hatch::build_hatch_runs`
  (DXF 90° − Winkel), Standard 0°, Laden stellt 90° zurück, Bogenwand-Nasen polar; Test `plan/hatch_dir_tests.rs`.
  Offen: render3d-Live-Schnitt und Mac nicht angesehen. · S
- ◐ **[169]** Runde Formen als echte Kreise/Bögen. 9.11.: Ausgaben erkennen Bögen in Vielecken/Linienzügen (Kern
  `plan/arc_fit.rs`: ≥ 4 Punkte auf einem Kreis ± 10 µm, Schritt ≤ 25°, Pfeilhöhe ≥ 0.5 mm): Plan-SVG/Druck-SVG/PDF
  `<circle>` bzw. `<path>` mit `A`, DXF/DWG CIRCLE bzw. LWPOLYLINE mit Bulges (fileio Satz 24, auch Linienzüge aus
  Einzel-Linien), Bildschirm fein nachtesselliert (Szene ≤ 2°, Metal-Pfad nach Zoom); Schraffur am Bogen beschnitten.
  Runde Stütze 48–256-Eck (Pfeilhöhe ≤ 0.5 mm), im 3D glatt. Tests `plan/arc_output_tests.rs`. 10.11.: Ellipsenbögen
  (achsparallel, ≥ 6 Punkte ± 10 µm, ≥ 45°): schräg gesehene Rundbogen-/Rundfenster und ovale Rundfenster in der
  Ansicht als SVG-`A` mit zwei Radien bzw. DXF ELLIPSE (fileio Satz 26); verrauschte Ringe (auf mm gerundeter
  Erker-Umriss, Versatz um das Wendeltreppen-Loch) stückweise als Ausgleichskreise (± 1 mm, ≥ 6 Punkte, Schritt
  2°–25° gleichmässig, erst nach den genauen Bögen); DXF/DWG-HATCH-Ränder mit Bulges (Satz 25, Kreis = zwei
  Halbkreise); Bogenwände im 3D glatt (render3d `WallInput.arcCenter`: radiale Normalen am Mantel, Knick 30° wie
  Stütze); Dachstirn eines gekrümmten Dachrands (Erker-Flachdach) in Ansicht/Schnitt-Projektion ohne Facettenfugen
  (Glättungsgruppe je Dach, nur senkrechte Flächen). Tests `arc_fit.rs`, `elevation/tests.rs`, render3d
  `bogenwand_glatt_schattiert`, fileio `schraffur_rand_mit_bulges`/`ellipsenbogen`. Offen: Ellipsen in
  Schraffur-Rändern bleiben Vielecke (HATCH ohne Ellipsenkanten); Bogenwand-Schraffur (polar) weiter als
  Polylinien; Ellipsen nur achsparallel (keine geneigten Ebenen); 3D-Glättung und Bildschirm (WebGPU, Metal)
  nicht angesehen (Linux-Container, kein render_png). · M
- ◐ **[168]** Schichteinzug/Anschlag-Nase als Teil der Schicht (9.11.). Grundriss: Nasen gehen als Zusatzstücke in die
  Poché (`walls.rs` `take_noses`/`append_nose_reveals` → `wall_poche::adjusted_segment`), je Schicht EINE Fläche
  (i_overlay, Ecken zurückgerastet), Umriss/Fugen aus dem Raster — keine Linie zwischen Schicht und Einzug, gleiche
  Schraffur; Schnitt: Band + Einzug auch ohne Nase ein Umriss (`section/bands.rs`). Vorgabe bei Aussendämmung, wo
  nichts gesetzt ist (`opening_detail::default_frame_inset`/`reveal_rules`): Rahmen in der Leibung der tragenden
  Schicht, kein Anschlag, Dämmung überdämmt 3 cm — Grundriss, Schnitt, Ansicht, 3D, IFC (Wand mit Stücken als EIN
  Manifold-Körper, Öffnungskörper in der Rahmenlage; Import erkennt so gelochte Wände). Tests `walls.rs`
  `schichteinzug_ein_stueck_mit_der_schicht`, `opening_detail.rs` `aussendaemmung_vorgabe_rahmen_in_der_leibung`,
  `ifc_data.rs` `schichteinzug_wand_als_ein_koerper`. Offen: schwarze Sammelfläche (ab 1:100) ohne Einzug/Nase wie
  bisher; Fenster ohne Typ ohne Vorgabe; Aussenputz bleibt an der Rohbaukante (nur die Dämmung überdeckt); nicht in
  der Tauri-App/auf dem Mac (render2d nativ, 3D) angesehen. · S
- ◐ **[145]** Texte beim Zoomen synchron. Falls der Mac noch nachläuft: Raumstempel nativ zeichnen (vtext kann nur
  einzeilig/linksbündig, eine Schrift, kein Fett). 9.11.: `clampInside` nur noch im Kern (`grip_clamp_inside`,
  Fassade `clampInside` in `src/core`); die Öffnungs-Vorschau beim Setzen zeigt die geklemmte/gerückte Lage
  (`placed_gap`, Test `oeffnung_vorschau_zeigt_gerueckte_lage`). Offen: Dach-/Deckenöffnung hat beim Setzen keine
  eigene Vorschau; Raumstempel setzt ohne Klemmung (nichts zu zeigen). · S
- ◐ **[146]** Linienenden/-ecken. Druck-SVG achtet seit 9.11. auf `noStrokeEdges` (offene Kantenzüge, Test
  `ungestrichene_kante_ohne_strich`); Nähen in Metal-Chunks nur innerhalb eines Chunks (Kern `plan/line_ends.rs`, `render2d`). · M
- ◐ **[153]** Strichmuster in Papier-mm. Bögen mit Phase seit 9.11. ([169]: Plan-/Druck-SVG, PDF, Bogen-Shader; seit
  10.11. auch Ellipsenbögen, Länge numerisch). (11.11.) Vollkreise: Muster auf ganze Wiederholungen über den Umfang
  gestreckt (`line_pattern::fit_closed`, Naht schliesst) in Plan-SVG, Druck-SVG/PDF (`sceneToPrintSvg.ts` für Ringzüge
  der Szene), Bildschirm-Szene (`scene.rs`), DXF/DWG (eigener Linientyp je Radius `…_R<mm>`) und React-SVG-Ansicht
  (`dashVb.ts`: Phase für Linien/Bögen/Zug, Ring gestreckt). DXF/DWG kennen keine Musterphase je Objekt (Muster beginnt am
  Entitätsanfang; Linientyp-Skalierung nur über Gruppe 48, die das flache Format nicht trägt) — Linien/Bögen bleiben dort
  ohne Phase, begründet. (11.11.) Geschlossene Züge (Rechtecke, Vielecke, Raum-/Decken-Umrisse, tessellierte Ellipsen:
  aneinander anschliessende Linien, Ende = Anfang) strecken das Muster wie Kreise über den Gesamtumfang
  (`fit_closed`; Phase läuft über die Ecken): Plan-SVG (`flush_dash_run`), Druck-SVG (`flush_dash`), Szene (`flush`),
  React-SVG (`DrawingRunShape`, `sceneToPrintSvg.ts`); DXF/DWG: ein geschlossener LWPOLYLINE-Satz mit Flag
  „Muster durchlaufend" (plinegen, Gruppe 70 Bit 128; Satz-Flag 3) und Linientyp `…_U<mm>` je Umfang. Tests
  `gestricheltes_rechteck_schliesst_an_der_naht`, `gestricheltes_rechteck_dxf_plinegen`,
  `closed_linientyp_mit_ganzen_wiederholungen`. Offen: Metal-Chunks verketten nur über das Ketten-Flag (nicht mit
  Metal geprüft); nur im Linux-Container geprüft. · M
- ◐ **[155]** Treppensymbol. (10.11.) Lauflinie hinter der Bruchlinie gestrichelt wie die Tritte (Pfeil bleibt ausgezogen); Raumstempel weichen allen Treppen-Linien aus (`stamp_obstacles_with` nimmt `d.stairs` ganz, Test `stempel_weichen_den_treppenlinien_aus`). (11.11.)
  Freier Lochring ohne Wand und Austritt: geschlossener Zug mit Gehrung an der Naht (`offset_polyline` erkennt geschlossene
  Züge, 3D-Rohr ohne Deckel; Test `freier_ring_ist_geschlossen_mit_gehrung`); offene Enden stehen rechtwinklig. (11.11.)
  Absturzsicherung am Deckenloch auch in 3D (Körper aus Pfosten, Handlauf, Stäben, `stairs3d::guard_mesh`; Lage aus dem
  gemeinsamen `stair_guard.rs`, gleiche Quelle wie der Grundriss; Teil der Treppen-Handläufe, pickbar mit der Treppe) und im
  IFC (eigenes IfcRailing GUARDRAIL an der IfcStair, Länge als Basismenge; Wire-Format STAIR: `n_rails` statt `has_rail`). Offen:
  Ende eines freien Lochrings ohne Gehrung; dichtes Belagsmuster in 1:100; 3D-Darstellung nur als Zahlen/Golden
  geprüft (Metal nur macOS). (11.11.) Im Explosionsbild folgt die Sicherung dem Geschoss der Decke mit dem Loch, Handläufe
  der Treppe (`explode3d::parts`/`pick_geometry`, `emit_stair_guards_on`, `pick_stair_railings_split`). · M
- ◐ **[156]** Bodenbelag-Muster massstabsgerecht. Möbel sparen den Belag aus als Blöcke, Körper und (11.11.) geschlossene
  2D-Formen (Rechteck, Kreis, Ellipse, geschlossene Polylinie) der Kategorie „Möbel“ (nach Kategoriename;
  `drawings::furniture_shape_footprints`; Bogensegmente der Polylinie gelten als gerade). Offen: Deckenspiegel-Untersicht
  behält die alte Ausdünnung (0.7 mm, eigene Strichstärke/Farbe — eigene Darstellung der Untersicht, kein Belag; Umstellung
  änderte das Bild ohne klaren Gewinn). Nassraum nach Name ist durch [158] ersetzt. · S
- ◐ **[158]** Raumbuch. Stand 11.11.: lichte Höhe unter Dachschrägen (kleinste/mittlere Höhe, Fläche < 1.0 m / 1.0–1.5 m /
  ≥ 1.5 m nach SIA 416, Raster über dem Raum mit den Dächern des eigenen Geschosses; `room_book::height_bands`);
  Wandoberflächen je Wandseite (`wall_sides`, Raumseite der Wand abzüglich Öffnungen), Leibungsflächen und Sockellänge
  (Umfang − Türbreiten) in Zeile und Panel/Bericht; Belagsmuster im Plan an der längsten Raumkante ausgerichtet
  (`floor_finish::pattern_frame`; Räume haben keinen eigenen Bezugspunkt). Offen: keine IfcCovering-Bauteile (nur
  Pset-Texte); Bogenwände liefern keine Wandseite (Kante läuft unter „ohne Wand“); Belag im 3D und im
  Deckenspiegel nicht nach Raum. (11.11.) Wandfläche unter Schrägen = mittlere Dachunterkante-Höhe entlang der Wandseite
  (Stützstellen alle ~10 cm, `room_book::edge_mean_height`; `wall_area` = Summe der Wandseiten); Blatt-Tabelle
  (`sheet_table.rs`) mit den Spalten Höhe min/Ø, Fläche < 1.0 / 1.0–1.5 m (nur wenn ein Raum eine Schräge hat),
  Leibungen, Sockel (wählbar). · M
- ◐ **[157]** Plan-Review Musterhaus komplex (Schweizer Praxis). Stand 10.11. (CLI-SVG `--hatch`, Chromium, nur Linux):
  behoben: Raumstempel verlieren beim Ausweichen keine Zeile mehr (erst frei, dann mit geringster Überdeckung, Zeilen
  entfallen nur noch, wenn das Rechteck im Raum nirgends passt; `fit_room_stamp`); Schnitt-/Ansichtsbeschriftung („B-B“)
  nach Abstand zur Marke gesucht, auch auf der Gegenseite der Blickrichtung (`plan_section_lines`); „Detail und Situation“
  (Detailverweis im Beispielprojekt) von Masskette/Höhenkote weg; Achsblasen weichen auch den Höhenkoten (Kote-Zeichnungen)
  aus; Höhenkoten im CLI-Schnitt stehen neben dem Gebauten (schon [171], geprüft); Fenster in Bogenwänden sitzen im Schnitt
  tangential in der geschnittenen Wand statt auf der Sehne (`arc_cut_opening`). Offen: Marken von Ansichten Nord/West bzw.
  Süd/Ost treffen sich im 1:500 an den Ecken (Ansichtsmarker macht [176]); Kontrolle der Bogenwand-Fenster im Schnitt
  1:50 nur im Test, nicht in der App; Achsblasen-Ausweichen gegen Texte/Detailverweise nicht geprüft. · M
- ◐ **[176]** Schnitt-/Ansichtsmarken im Grundriss nach SIA-Praxis (10.11.): kräftige Endstücke (12 mm, 0.5 mm) mit dünner
  Strich-Punkt-Linie dazwischen, an jedem Ende Schenkel (8 mm) in Blickrichtung mit gefülltem Dreieck, Beschriftung 3.5 mm
  waagrecht vor der Spitze; alles fest in Papier-mm (vorher Massstab-abhängig, √-Faktor ab 1:200); Ansicht: ganze Linie dünn,
  nur Schenkel + Dreieck kräftig. Kern `plan/misc.rs` (`section_line_sized`) + `plan/context.rs`, gleicher Pfad für Bildschirm/Druck/CLI.
  Rest (10.11.): Ansichtsmarker als eigenes Symbol (nur flaches gefülltes Dreieck, Basis 6 mm, Höhe 3 mm in Blickrichtung, Bezeichnung
  waagrecht dahinter, kein Kreis, keine Linie, `misc.rs` `view_marker_sized`, Pick-Band über Dreieck+Text); Modell `DrawingLevel.bendPoints` (optional, Knickpunkte zwischen
  `linePoints[0]`/`[1]`, altes 2-Punkt-Format liest weiter, verschiebt mit Georeferenz) und Darstellung im Grundriss
  (`section_polyline_sized`: kräftige 6-mm-Stücke an jedem Knick). Geknickter Schnitt fertig (10.11.): Abwicklung im Kern
  (`plan/section/unfold.rs`): je Segment eigene Ebene, Schnittflächen auf den u-Bereich, Projektion an den Winkelhalbierenden
  der Knicke zugeschnitten, Teilbilder aneinander (u = abgewickelte Länge), dünne Knicklinie (0.13 mm) je Knick; Öffnungen,
  Achsen je Segment geschnitten, Bäume nach Mitte zugeordnet. Werkzeug: Schnitt nimmt weitere Klicks als Knicke, Enter/Doppelklick
  beendet (Ansicht weiter zwei Klicks); Griffe an Anfang, Knicken, Ende (`grips.rs` `sectionLineGrip`). Knick einfügen/löschen (10.11.):
  Mittel-Griff je Segment (Ziehen fügt den Knick ein, `sectionBendInsert`), Kontextmenü „Knick einfügen/löschen" (`sectionBendDelete`),
  nach dem Ziehen entfallen Knicke auf einem Nachbarpunkt/der Geraden auch im Modell (`sectionLineTidy`, 5 mm bzw. 6 Bildschirm-Pixel); je Aktion ein Undo-Schritt
  (gemeinsamer coalesceKey). Grundriss-Unterlage im Schnitt (`plan/underlay.rs` `underlay_for_level`) folgt den Knicken (je Segment
  abgewickelt, an den Winkelhalbierenden zugeschnitten, `unfold::clip_plan_prims`). Offen: 3D-Live-Schnitt folgt der
  Endpunkt-Verbindung; Mittel-Griffe jetzt als kleine gefüllte Raute (10.11., `.plan-grip-insert`); optionale dünne Ansichtsebene; Mac-/Tauri-Ansicht nicht geprüft.
  L-Marke (10.11., Wunsch Maintainer): Markentyp
  `DrawingLevel.markerStyle` ("arrow" Basis | "lAngle") mit Vorgabe `ModelViewOption.sectionMarks.style` (Ebene > Modelldarstellung >
  Pfeil; `Options::section_marker`); L = je Ende kräftiger langer Schenkel (12 mm) längs der Linie nach innen + kurzer (6 mm) in
  Blickrichtung, keine Linie dazwischen, kein Dreieck, Bezeichnung waagrecht aussen neben dem kurzen Schenkel, Knickstücke bleiben
  (`misc.rs` `section_polyline_styled`, `context.rs` `plan_section_lines`); Auswahl in Objekt-Info (Schnitt) und Ressourcen-Tab
  Modelldarstellung („Schnittmarken"). Goldens: nur die Ansichtsmarker ändern sich. · M
- ◐ **[171]** Plan-Review Runde 2 (10.11., beide Musterhäuser, CLI-SVG `--hatch` in Chromium, nur Linux). Behoben (Kern,
  Test je Fix): Sonnenschatten auf Flächen unter dem Ansichtsbereich (grauer Fleck über dem Carport im OG/DG,
  `sun::shadow_polygons_plan_in`); Flächenzeile nach Rundungsschritt („16.0 m²“ statt „16 m²“); Schnitt genau am Rand
  eines Rundfensters ohne Rechteck-Loch (B-B, DG West); Wand von unten ohne Wand darüber endet unter der Rohdecke,
  Bodenaufbau läuft durch (`bands::end_below_floor_buildup`; einfaches Musterhaus W9, komplex OG/UG-Innenwände);
  Rundfenster in der Ansicht ohne Quadrat, Fassadenmuster bis an den Rahmen; OG-Ecken unter dem Dach in der Ansicht
  verlängert (keine Eckstreifen mit Fuge/Schatten, einfaches Musterhaus); Höhenkoten im Schnitt/in der Ansicht neben
  dem Gebauten (`levelMarkerPrimitives` mit Primitiven). Offen: Raumstempel „Wohnen“ (einfaches Musterhaus) liegt auf
  Zwischenwand W9 und Schnittlinie A (Anker/Raumumriss in den Daten); Revisionswolken-Text und „▽-2.71“ auf der
  Bemassung Süd (Daten); Höhenlinien-Beschriftung („-2.7“) knapp an Masszahlen; Raumstempel ohne Maske über
  Schnittlinie (einfaches Musterhaus). Nachtrag 10.11. (Reste): Dämm-Polylinien mit Sehnenfehler ≤ 0.5 mm Modell
  (≙ 0.05 mm Papier ab 1:10) statt festen 5° (DG 1:50 komplex 14 MB → 2.6 MB); Haarstrich gegen Fugen
  `SEAM_MM` 0.05 → 0.12 (graue Schichtfugen in der schwarzen Schnittfläche 1:100 bei Zoom ≥ 12 px/mm); Stempel-Kürzung
  nach Wörtern (10.11. weiter: Reihenfolge bei Platzmangel erst Name auf zwei Zeilen umbrechen, dann Schrift bis 2 mm,
  dann nur die Raumnummer, erst zuletzt Wortenden kürzen, je Wort ≥ 3 Buchstaben + Punkt — „Wohn./Ess./Küche“ statt
  „Wo./Ess./Küc.“; `fit_room_stamp`/`abbreviate`); Reststrich rechts am Rundfenster (Ansicht West) — Lochkanten im
  Band um den Rahmen entfallen (`drop_hole_edges`). Holzwand-Ecke DG 1:50 (10.11.): die Musterphase sitzt jetzt an der
  Schichtfläche statt an der Wandfläche (`anchor_band_pattern`), die Gehrung geht an der Innenseite durch einen ganzen Bogen
  bzw. eine Spitze, beide Wände bilden dort eine gefaltete Schlaufe. Eckquadrat (10.11., Dämmschlange/Zickzack/Welle an
  Gehrungen zweier gleich geschichteter Wände, Winkel 50°–130°): das Quadrat der Schicht gehört der längeren Wand
  (Gleichstand: zuerst gezeichnet) — ihr Muster läuft gerade bis zur Aussenkante durch, die andere endet stumpf an
  der Quadratgrenze; Muster in beiden Wänden an der jeweiligen Endlinie verankert (`corner_square`,
  `WallCuts::pattern_corner`), Flächen unverändert (nur die Polygone der Schicht tauschen die Ecke). Spitzere/stumpfere
  Winkel, Bogenwände: bisher (Spiegelung an der Gehrung). Weiter offen:
  Ansicht Ost: Schatten-Keile neben dem Erker mit Lücken je Geschoss und Strichreste am Erker. Nicht in der Tauri-App/auf dem Mac
  angesehen. · M
- ◐ **[142]** Sonnenschatten im Grundriss (`sun.rs`, Kern `plan/extras.rs`, Klasse 08). Stand 11.11.: Decken/Balkone/Vordächer
  und Dächer werfen eigenen Schatten (Dächer in echter Form, nicht-konvex; Tests `vordach_wirft_schatten`,
  `nichtkonvexes_dach`, `flachdach_l_schatten`, war schon gebaut, TODO-Text veraltet). Neu: Wandöffnungen lassen Licht durch
  — Wand mit Öffnungen als Prismen ohne die Öffnungsquader (`wall_pieces`/`wall_gaps`, gerade und Bogenwände; Glas zählt
  als Lücke; Formöffnungen als Streifen mit kleinster Höhe), Teile gehen in den Schatten-Schlüssel ([179]) ein. Im Musterhaus
  komplex kaum sichtbar (Licht durch Fenster fällt meist ins abgedeckte Innere). Offen: Kronen bleiben konvexe Hülle (Form der
  Krone selbst ist konvex); Schatten aufs Gelände tieferer Terrassen nur über Decken/Dächer als Empfänger; nicht in der
  Tauri-App angesehen. · M
- ◐ **[64]+[59]** Sonnenstand/Schatten. Schatten im 3D (`render3d`, Shadow-Mapping) ist gebaut, aber nicht auf Metal
  und nicht in der App angesehen; mehrere Kaskaden erst bei grossen Lageplänen. · S
- ◐ **[149]** Baum als eigenes Objekt (11.11.): Auswahlrechteck, Gruppen, Art-Beschriftung (`species`/`showLabel`), Beschriftungs-Griff; Beschriftung weicht aus (`plan/trees.rs::plan_tree_labels`, nach allem anderen Inhalt: Masse, Stempel, Höhenlinien-Beschriftungen, Wände, Kronen/Beschriftungen anderer Bäume; Lagen: neben dem Stamm, rechts/links/über/unter der Krone; mit Griff verschobene bleiben); Schnitt durch die Krone zeigt Kronen-/Stammquerschnitt (Sehne, Schnittstärke 0.35, `TreeGeom::cut_silhouette`), Teile vor der Ebene entfallen, dahinter die Silhouette (Ansicht unverändert); Fuss am Gelände der Stammmitte in 3D/Schnitt/Ansicht war schon über `tree::bases`, neu reicht die Stamm-Unterkante (`foot`) am Hang bis zum tiefsten Stammrand. Offen: Ansicht ohne Schnitt-Logik (Baum vor der Ansichtslinie wird ganz gezeigt); Schnittfläche der Krone ohne Schraffur. · S
- ◐ **[148]** Flach-/Pultdach auf beliebigem Umriss (`roof_geometry`). Pult mit Höfen (Höfe ignoriert); Pult auf
  schiefem Umriss neigt nur entlang x/y (`ridgeAxis`); Dachfenster-Laibung genau auf einer Fuge doppelt. Attika
  (11.11.): Dachfelder `parapetHeight`/`parapetWidth`/`parapetComponentId` am Flachdach (`roof_parapet.rs`; 3D-Ringkörper in
  `emit_roofs`, Schnitt mit Bauteil-Schraffur, Ansicht, Grundriss-Innenkante `roof-parapet` auf der Dach-Ebene, Objekt-Info;
  Musterhaus komplex: Erker). Offen: Gefälle der Dachhaut (nur Darstellung im Schnitt); Attika bei Pult, an Höfen und bei
  verschnittenen Dächern; Live-Schnitt im 3D (`roofCutLayers`) ohne Attika; Ansicht orientiert Aussenflächen am
  Dachschwerpunkt (konkave Umrisse), Attika in Dachfarbe statt Bauteilfarbe. · M
- ◐ **[26]** Dächer über beliebige Grundrisse (`core/src/roof*.rs`). Grundriss-Griffe (11.11.): am einzeln gewählten Dach
  Eck-Griffe und Kanten-Anfasser an Umriss UND Höfen (Kern-Ops `roofVertex`/`roofEdge`, flacher Index Umriss→Höfe,
  Umriss bleibt frei, Vorschau + ein Undo-Schritt je Zug), Kante unter dem Anfasser wird hervorgehoben (`plan-edge-hover`,
  auch bei Decke/Raum/Baugrube). Ecke einfügen/löschen (11.11.), einheitlich für Dach (Umriss + Höfe), Decke, Raum, Baugrube und
  geschlossene Polylinie: Kern-Ops `ringInsert`/`ringDelete`/`ringTidy` (`grips.rs`, `ring_edit`; Polylinie nutzt `insertPoint`/`deletePoint`,
  Aufräumen nur an geraden Segmenten); Raute (`plan-grip-insert`) bei 25 % der Kante (die Mitte gehört dem Kanten-Anfasser), Ziehen fügt
  die Ecke ein, auf der Geraden/auf dem Nachbarn entfällt sie (auch nach normalem Eck-Zug), Kontextmenü „Ecke löschen" (mind. 3 bleiben),
  ein Undo-Schritt je Aktion; `edgePitchDeg` (Dach) bzw. `edgeSlopes`/`edgeShoring` (Baugrube) laufen mit (neue Kante erbt die geteilte).
  Offen: Raute an Decken-`openings`; Kanten-Neigung/Giebel per Kontextmenü am
  Griff (heute im Objekt-Info), Hover-Hervorhebung in der App nicht angesehen; Mansarde mit Hof und verschieden geneigten Kanten (zweite Schicht nicht geschlossen);
  Schattenwurf nimmt die Hülle der Dachfläche. · M
- ◐ **[137]** Alles Sichtbare anwählbar. (10.11. bewusst nicht anwählbar, mit Begründung: Punktwolken sind kein
  Modellelement (Sitzungszustand, Millionen Punkte) — Ausblenden/Entfernen im Lage-Panel („Punktwolken"); Baurechts-Hüllkörper
  ist Anzeige-Option der Baurecht-Einstellungen (`showEnvelope`), im Plan über die Pseudo-Auswahl `site`/`siteRules` erreichbar,
  im 3D nur Schalter; eine Schnittbox gibt es (noch) nicht.) Nicht anwählbar: Höhenkoten im Schnitt; Geschosse als Auswahl-Art; Achsraster im Blatt nicht verschiebbar; Texte im 3D nur anwählbar,
  nicht gezeichnet; Klick auf Griff an der Stelle des letzten Klicks schaltet statt zu bewaffnen. · M
- ◐ **[77]** Zauberstab (Befehl `wand`). (11.11.) e2e `e2e/wand.spec.ts` (Rechteck zeichnen, Zauberstab in die Mitte → neuer Verlaufsschritt, Undo/Redo; Klick ins Leere legt nichts an) – Chromium headless, nicht in der Tauri-App geklickt. (10.11.: Splines sind schon Begrenzung — der Fang-Sammler `snap_model` tesselliert sie; Test `spline_als_rand`.) · S
- ◐ **[81]** Automatische Aussenbemassung (`auto_dimensions`). (9.11.) Schiefe Ketten kreuzen den Grundriss nicht mehr
  (sonst vor alles im Streifen hinausgerückt), getrennte Gebäude eigene Seitenketten (`south2` …), Erker-Facetten ohne
  Stufe. (11.11.) Schiefe Ketten rücken hinaus, bis
  sie keine achsparallele und keine andere schiefe Kette kreuzen (Masslinie, Hilfslinien; Musterhaus komplex, alle Geschosse 1:100/1:50
  frei: `MK_FILE=mk.obp cargo test --lib autodim_musterhaus -- --ignored`); je Bogenwand der Hülle ein Radiusmass
  (`autodim-<Ebene>-radius-<Wand>`, Klasse 81, an der Wand verankert; entfällt, wenn die Wand schon ein eigenes Radiusmass hat;
  in „Aussen/Gesamtmass"-Ansicht ausgeblendet wie das Bogenmass); eine auf eine andere Klasse gelegte Auto-Kette bleibt beim
  erneuten `autodim` auf ihrer Klasse. Offen: nicht in der App geklickt. · S
- ◐ **[172]** Masszahl der Bemassung „snappy" und mittig. (10.11.) Vorgabe: Zahl wirklich mittig (bisher hing sie mit ihrem Anfang an der Segmentmitte, jetzt
  um die Breite halbiert zurückgesetzt, auch Bogenlänge) über jedem Segment im festen Abstand (Grundlinie 0.6 Schrifthöhe); passt sie nicht zwischen die Hilfslinien, weicht sie nach aussen (erstes Segment links, letztes rechts,
  mittlere zum längeren Nachbarn, bei Überdeckung eine Zeile höher) — `dim_auto_offsets` in `plan/drawings.rs`, gilt für
  manuelle und automatische Bemassung, Griff steht an derselben Stelle. Masszahl-Griff rastet an Mitte · innen links/rechts ·
  aussen links/rechts · über/unter der Linie ein, frei mit gehaltener Alt-Taste (`grips.rs::dim_text_slot`; Objektfang
  entfällt beim Ziehen). Gespeichert bleibt `textOffsetsMm` (kein neues Feld); (0,0) = Vorgabe, frei verschobene Texte alter
  Projekte bleiben stehen. „Text zurücksetzen" in Objekt-Info und Kontextmenü. DXF/DWG-Export setzt die Textposition der DIMENSION an die ausgewichene Lage (`plan/dxf.rs`, 10.11.). Radius-/Durchmesser-/Bogenlängenmass: Zahl mittig über dem Ankerpunkt; Masszahl-Griff der Rundmasse rastet wie bei linearen Massen ein (10.11.: Mitte · innen/aussen links/rechts entlang der Masslinie · über/unter, Alt = frei; ein Griff an der Zahl selbst, `grips.rs::round_dim_label`, Versatz in `textOffsetsMm[0]`, im Plan `plan/drawings.rs::round_label`; „Text zurücksetzen" gilt mit). Offen: DXF/DWG-Export setzt die Textposition der Rundmasse noch nicht an den Versatz; in der App nicht geklickt. · S
- ◐ **[154]** Bauteile aus Zeichnung erkennen (Befehl `erkennen`). Stösse von Bogenwänden, schräg anstossende Enden,
  Treppen/Decken, Fenster über der Schnitthöhe (5 von 6 fehlenden Öffnungen im Musterhaus komplex), Wanddurchbruch
  mit Schwellen-Rechteck wird Fenster, Schiebetüren in Bogenwänden, Blöcke. · L
- ◐ **[136]** Reiter und Ausschnitte entkoppelt. (9.11.) Offene Reiter (Reihenfolge, aktiver, je Reiter Ansicht/Zoom/
  Ausschnitt-Bezug) gehen beim Speichern als `uiState.viewTabs` in die Projektdatei (optionales Rust-Feld
  `Project.uiState`, nicht über Ops, kein Undo; `serializeProject(p, ui)` ersetzt es nur im Datei-Text) und kommen
  beim Öffnen zurück; Reiter auf gelöschte Ausschnitte fallen weg, alte Projekte: ein Reiter wie bisher
  (`src/state/viewTabs.ts`). Offen: nicht in der Tauri-App/Browser geprüft (Wiederherstellung des Zooms läuft
  verzögert über `applyViewState`); Autosave-Wiederherstellung bringt die Reiter mit, ändert aber nicht den Dirty-Stand. · S
- ◐ **[131]** Untergeschosse unter ±0.00 (`DrawingLevel.zeroLevel`). Nur die Mac-Gegenprobe fehlt. · S

## Schnitt und Ansicht

- ◐ **[178]** Deckenauflager an Aussenwänden (11.11., Wunsch Maintainer). Decke endet an der Aussenkante des Kerns
  ([33] `layer_positions`), Aussendämmung/Putz laufen an der Stirn durch — abgeleitet, Umriss bleibt
  (`model3d/bearing.rs`: Platten-Umriss minus Aussenschicht-Streifen, wo vor der Wand keine Decke liegt → `emit_slabs`
  für 3D/Schnitt/Ansicht und `floor_context` für die 3D-Wandbänder). Schalter je Decke `Ceiling.edgeAtOutline`
  (Objekt-Info „Auflager bis Kern“, aus = wie Umriss). Offen: Deckenkante im Grundriss folgt noch dem Umriss;
  Bogenwände unverändert; Platte ohne Wand in gleicher Höhe (UG-Decke über Lichtschacht/kurzer Fundamentwand im
  Musterhaus komplex) bleibt bis Umriss; nicht in der Tauri-App/auf dem Mac geprüft. · S
- ◐ **[G4]** Exakte Sichtbarkeit (HLR, Kern `hlr.rs`). Füllungen der Ansicht bleiben Maler-Ordnung (bei Gauben liegt
  eine Füllung über einer verdeckten Kante); Durchdringungslinien sich schneidender Körper fehlen; Gelände/
  Kontext-Netze nicht in der Projektion. · XL
- ◐ **[G6]** Allgemeine Polygon-Dominanz im Schnitt. 3D-Live-Schnitt (`render3d/section_boolean.rs`) rechnet nur
  Rechtecke, Ring mit Loch bleibt unbeschnitten; dort fehlt auch der Schraffur-Deckel von Abzugskörpern (aus [G8]). · M
- ◐ **[G1]** Ebenenschnitt beliebiger Körper (`plan/mesh_plan.rs::plan_bodies`, `plan/extras.rs`). 11.11.: Grundriss aller
  freien Körper über das Kern-Netz (`solid_mesh.rs`): Poché = Ebenenschnitt auf Schnitthöhe (B-Rep, Eckenradius/Fase,
  Löcher, Verjüngung), darunter Aufsicht, darüber Überkopf; `ExtrudedSolid.componentId` (Objekt-Info „Bauteil")
  gibt Füllung/SIA-Schraffur in Grundriss und Schnitt; Abzugskörper beliebiger Form sparen Wände/Stützen (Ebenenschnitt)
  und Decken (Grundriss im Plattenband, Manifold + i_overlay) aus; Kreis-Körper ohne `points` bauen. 11.11. (2): Abzugskörper zeigen ihren echten
  Schnittumriss (Ebenenschnitt des Kern-Netzes) als Strich-Punkt-Linie, Diagonalkreuz nur beim Durchbruch durch eine Decke
  (`extras::void_pierces_slab`); Treppen (alle Formen) des Geschosses darüber erscheinen im Deckenloch als gestrichelte
  Untersicht (`stairs.rs::underside`, `RunOpts.no_break`; ohne Loch nicht). Offen: Körper verdecken keine
  importierten Netze (getrennte Sichtbarkeitsrechnung); nicht in der Tauri-App geprüft. · M
- ◐ **[G2]** Wand an Dach. Ansicht bleibt Painter + Verdeckungstest (→ [G4]); fast achsparallele Grenzen im Band nur
  genähert; Fenster, das ins Dach ragt, verliert seinen Sturz; Dachgeometrie im 3D-Live-Schnitt unverändert
  (`wall_bands.rs`). · M
- ◐ **[G3]** Öffnungen beliebiger Form (`Opening.shape`). Projektion bei schräg zur Ebene stehender Wand nur mit
  Umriss der zugewandten Fläche (Leibungskanten fehlen); Abzugskörper beliebiger Form. · M
- ◐ **[G5]** Dächer untereinander, Gauben, Wand ↔ Decke. Wand ↔ Dach/Decke per Boolean (Wände müssten als Netze
  statt `RWall` gehen), 3D-Live-Schnitt-Deckel verschnittener Dächer, IFC-Mengen der Gaube, Kehlen symmetrisch je
  Schicht, Wand ↔ Decke für beliebige Polygone ([G6]). · L
- ◐ **[132]** Ansichten/Schnitte aus [114]. Haarlinien an Dreiecksfugen (SVG-Kantenglättung); Carport bleibt Pultdach 3°. · S
- ◐ **[115]** Schnitt/Ansicht wie Grundriss. 11.11.: Freie Körper (`extrudedSolids`) fangen im Grundriss mit ihrem Umriss
  (`snap_model.rs`, Klasse/Ausnahmen wie jedes Bauteil; Test `freie_koerper_fangen_nach_klasse`). Im Schnitt-Viewport fängt
  der Fang die Schnitt-Primitive (Körper-Schnittflächen/Kanten sind dort drin, nicht geprüft in der App). 11.11.: Körper-Netze
  rechnet der Kern selbst (`solid_mesh.rs`, Tessellierung der B-Rep-Beschreibung, Booleans über Manifold; Entscheid in
  `doc/ARCHITEKTUR.md`): Ansicht (Flächen mit Körper-Id, Verdeckung, Klasse), Blatt-Viewports (Schnitt + Ansicht, Fang) und
  CLI zeigen freie Körper; `computeSection` baut keine truck-Netze mehr. 11.11.: EINE Quelle — auch 3D-Bild, Pick, Explosion,
  Abzugskörper an Wänden/Decken und die Kennwerte der Objekt-Info nehmen die Kern-Netze (`model3d/solids.rs`, Teil
  `solidMeshes` mit `Owner::Solid` für den Klassen-Filter; `solid_specs::void_meshes`; `solid_mesh::solid_props`); fürs 3D
  ≥ 48 Facetten je Vollkreis (Fugen unter dem 15°-Kantenwinkel, glatt schattiert), Farbe/Textur aus `componentId`; volle
  Verjüngung ergibt jetzt eine Pyramide (Netz-Spezifikation, auch Grundriss/STEP). TS-truck-Pfad (`toWalls3d/extrusions.ts`,
  `TRUCK_MESH_READY_EVENT`, truck-Booleans in `voids3d.ts`) entfernt; truck bleibt für STEP und Kollision (Begründung in
  `doc/ARCHITEKTUR.md`). Ein OBJ-/glTF-Export existiert nicht. 11.11.: 3D-Auswahl-Hervorhebung freier Körper und importierter Netze zeigt die Feature-Kanten des Kern-Netzes
  (`highlight3d.rs::mesh_edges`: Randkanten + Knick > 15° wie render3d; Zylinder = zwei Kreise ohne Facettenfugen, verjüngter
  Körper = schräge Kanten; Gelände bleibt Hüllquader; Prisma nur noch ohne Netz). Offen: 3D-Ausschnitt im Viewport; nicht in der Tauri-App und nicht mit Metal geprüft. · S
- ◐ **[36]** View Range (`plan/view_range.rs`). Dach/Decke über/unter Schnitt verfeinern, Raum/Fenster eigenständig,
  Tiefe nur ganzes Bauteil (kein Clip an der Ebene). 11.11.: Öffnung ganz unter der Schnittebene schliesst die Wand auch
  ohne eigenen Bereich (Symbol gepunktet, `walls.rs`). · M
- ◐ **[34]** Ansichtsvorlagen (`Project.viewTemplates`). Vorlage wirkt vollständig auch für Schnitt und Ansicht (10.11.):
  Blatt-Viewports (App, PDF, Kern-Puffer `sheet_viewports::snapshot_project`) und CLI (`--template`, sonst die an der
  Ebene verknüpfte Vorlage) setzen Ebenen-Felder, Detailgrad, Massstab, Tusche/Farbe, Kategorien, Override-Regeln und
  Strichstärken-Skalierung; der Schnitt-Viewport im Kern übernimmt jetzt auch den Detailgrad. Offen: die App-Ansicht
  selbst folgt weiter über den Anzeigezustand der aktiven Ansicht (`syncUi`; manuelle Abweichung bleibt möglich); der
  Detailgrad hat in der Ansicht (Fassade) keine Wirkung; `showTerrain`/`floorFinish` wirken nur im Grundriss; nicht in
  der Tauri-App geprüft. · S
- ◐ **[173]** Modelldarstellung (≙ Archicad „Model View Options"), Wunsch Maintainer: grob/mittel/fein als wählbare und
  (11.11.) Fenster im Grundriss grob = CH-Praxis 1:200: drei Linien (Leibung aussen/innen über die Öffnung, Strich in der
  Fenstermitte = Rahmenmitte, Klasse `window-frame`), keine Anschlagnasen/Verbreiterungen; neue Fenster-Option „Vereinfacht
  (3 Linien)" (`windows.simplified`, auch über mittel/fein), Stufe Wettbewerb 1:200 setzt sie; Storenkasten (Untersicht) im
  Grundriss neu Basis AUS, zuschaltbar je Stufe (`windows.shadingBox`; kein Element-/Typ-Schalter). Goldens: keine
  Änderung (kein Golden mit grobem Fenster/Storenkasten). Nicht in der Tauri-App geprüft.
  eigene Stufen mit Einfluss auf alle Bauteile. Etappe 1 (10.11.): `Project.modelViewOptions` (Basis-Detailgrad +
  Abschnitte Türen/Fenster/Treppen/Wände/Decken-Böden/Gelände, jede Option „wie Basis" = heute), Wahl über
  `DrawingLevel.modelViewOptionId` (Werkzeugleiste: Detailgrad-Liste = Stufen; Ansichtsvorlage als Ebenen-Feld),
  `ViewSnapshot.modelViewOptionId` (Kern-Blattpuffer), CLI `--model-view`. Kern `plan/model_view.rs` (Rangfolge Element >
  Typ > Stufe > Basis, ARCHITEKTUR 3.5). Etappe 2 (10.11.): Schnitt (Schichten je Wände/Decken/Dächer alle/vereinfacht/
  nur Kern, Bodenaufbau als eine Fläche, Tür-/Fensterdetail, Treppen hinter dem Schnitt und Handlauf, Stützen-Füllung;
  `section_primitives_mv`), Grundriss (Decken Umriss/Ansichtsschraffur, Dachrand über Schnitt und Dachaufsicht-Schraffur,
  Stützen Schraffur/schwarz/leer, Schwelle aus/Hebeschiebetür/alle, Sturzlinie der Fenster, „nur Kern" = tragende Schicht
  in echter Dicke), Ansicht (Schatten Ebene > Stufe > aus, Materialschraffur, Fensterteilung), Blatt-Ausschnitt-Stufe
  auch in der App (`viewportLevelPlan`), TS `levelArg` gibt die Stufe an Schnitt/Ansicht weiter (fehlte in Etappe 1),
  3D über `model3dParts`-Text (`Model3dOptions.modelView`: Öffnungsdetail nach Basis, Handlauf aus); Ressourcen-Tab mit
  Abschnitten Dächer/Stützen/Ansicht; Lauflinie (Wunsch Maintainer) neu von der Antritts- bis zur Austrittskante in allen
  Formen (vorher um eine halbe Stufe bzw. 15 % der letzten eingerückt, `kernel2d::stair_geometry`; der Grundriss verlängert sie
  in `stair_symbol::run_line_to_edges`, 3D/IFC unverändert), Stufen-Optionen Versatz Anfang/Ende (Papier-mm) und
  Antrittspunkt; Detailgrad-/Stufenwahl der Werkzeugleiste jetzt auch in Schnitt und Ansicht; Tests
  `plan/model_view_tests2.rs`, e2e Schnitt-Fall. Goldens: nur Grundrisse mit Treppen (Lauflinie) neu, Schnitt/Ansicht gleich.
  10.11. (Reste): „nur Kern" bei Steildach/Holzständerwand war nur die 15-mm-Beplankung — [33] `layer_positions`: eine nur
  aus dem Baustoff tragende Schicht unter 3 cm (`MIN_CORE_THICKNESS`) zählt nicht; ohne andere tragende Schicht gilt die
  dickste Konstruktionsschicht (nie Eindeckung/Bekleidung, Luft, Folie, Putz, Belag), ausdrücklich als tragend markierte
  Schichten immer (wirkt auch auf [33]-Kriterium „Lage"). Geschnittene Dächer im Grundriss neu mit Schichtstreifen je
  Dachfläche nach Stufe (alle/vereinfacht/nur Kern, ab 1:100 schwarz; `domains.rs::roof_cut`). Offen: der 3D-Viewer übergibt
  keine Stufe (nur Kern/Fassade; die Stufen-Abfrage rechnet ohne den inkrementellen Cache, im Viewer zu teuer); Schwelle ohne Vorgabe „an" bei Hebeschiebetür (Basis aus, damit Pläne ohne Stufe gleich
  bleiben — Wert „nur Hebeschiebetüren" wählbar); Stützen haben im Modell keine Schichten (ein Bauteil) — „Schichten der
  Stützen" erst mit Stützen-Aufbau (Bekleidung/Brandschutz); Dachschnitt im Grundriss ohne Dachfenster-Löcher und ohne
  Verschneidung (Kehlen, Gauben); Fensterteilung im 3D. Etappe 3 (10.11.): Raumstempel-Zeilen nach Stufe (Nummer, Fläche,
  SIA-Kategorie, lichte Höhe, Belag, Trennlinie; Stempel > Stufe > Basis), Bemassung (Ketten der automatischen
  Aussenbemassung alle/ohne Öffnungen/nur Gesamtmass, Höhenkoten im Plan und in Schnitt/Ansicht, Ebene geht vor),
  Stufennummern der Treppe, mitgelieferte Stufen Wettbewerb 1:200/Baueingabe 1:100/Ausführung 1:50/Rohbau-Statik in
  den Standards („Standards laden"/„aktualisieren", Ressourcen-Tab: Vorlagen übernehmen); Tests
  `plan/model_view_tests3.rs`, Goldens unverändert (komplex EG/DG weichen schon auf dem Stand 1b9e01b ab, nicht von hier). Offen: 3D-Viewer übergibt weiter keine Stufe (Cache, s. o.);
  Stufen einzeln zwischen Projekten austauschen (kein Ressourcen-Import, nur Projektvorlagen); Stempel-Schalter
  Fläche/SIA-Kategorie am Stempel sind jetzt optional (10.11.; fehlend = wie Stufe, gesetzt geht vor; Editor: Dreifach-Wahl
  „wie Modelldarstellung/an/aus", neue Stempel lassen sie offen; bestehende Projekte tragen die Werte ausdrücklich und
  sehen gleich aus, ohne Stufe ändert sich nichts); Stufennummer unter der Pfeilspitze der Lauflinie wird seitlich versetzt
  oder entfällt; Fang-Punkte der Stempel (`room_stamp_spots`) rechnen ohne Stufe. Nicht in der Tauri-App/auf dem Mac geprüft. · M
- ◐ **[33]** Objektstile mit Rangfolge (Override-Regeln). „Ausblenden“ lässt Elemente im Grundriss anwählbar/fangbar;
  Schlagschatten und Gelände nicht über Regeln steuerbar; Linienstil auf Polygon-Umrissen (Wand-Umriss, Decken)
  ohne Wirkung; Linienstil-Aktion in der Ansicht ohne Wirkung; Öffnungen selbst ausblenden nicht möglich. · M
- ◐ **[65]** Explosionsaxonometrie (`explode3d.rs`). Abzugskörper (truck-Booleans) werden bei reiner Abstandsänderung neu
  gerechnet (Cache ohne Abstand fehlt). (11.11.) Absturzsicherung ([155]) wandert mit dem Geschoss der Decke mit dem
  Loch, nicht mit dem der Treppe. · S
- ◐ **[67]** Skizzenstil (`plan/sketch.rs`). Kompakte Linien-Unterlage (grosse DXF-Unterlagen), Bögen und Kreise bleiben
  exakt; keine Intensitäts-Einstellung; keine Hand-Schraffur. · S
- ◐ **[152]** Importierte Netze in Schnitt, Ansicht, Grundriss (`core/src/mesh_view.rs`). Der Archiv-Eintrag nennt keinen
  ausdrücklichen „Offen“-Teil. (11.11., [181]) IFC-Gelände wird beim Import ein Gelände-Element und läuft damit in Grundriss,
  Schnitt, Ansicht und 3D als Gelände; offen: Baugruben auf geschlossenen Gelände-Netzen (Platte) nicht geprüft, Grundriss
  zeigt ohne Äquidistanz nur den Rahmen. · S

## 3D

- ◐ **[T1]** Polyeder-Körper (`trucksolid::polyhedron`). Mehrteilige Netze und Hohlräume als mehrere Shells; Entscheid
  zu import-Netzen im STEP-Export (`solid_specs.rs`) offen; Komplanarität streng, f32-Importe ergeben mehr Flächen. · M
- ◐ **[T2]** Bogenwände. Teilen/Trimmen/Verrunden/Fasen/Verketten an Bogenwänden mit [113] (10.11.). Griffe (10.11.):
  Start/Ende einer Bogenwand laufen auf dem Kreis (Mittelpunkt/Radius fest, anderes Ende fest, Bulge nachgeführt;
  Kern `grip_drag::arc_wall_endpoint`), Tab = Bogenlänge ab dem festen Ende (nur Längenfeld, `arc_wall_point_at_length`);
  Randpunkte von Radius-/Durchmesser-/Bogenmassen bleiben auf dem Kreis um den Mittelpunkt (`grips.rs`). Öffnungen in
  Bogenwänden liefen schon über Bogenlänge ([144]). Geprüft: Rust-Tests; nicht in der App angesehen.
  (10.11.) Scheitel-Griff: Shift = Radius mit festem Mittelpunkt (Öffnungswinkel bleibt, Enden wandern radial,
  `grip_drag::arc_wall_radius_fixed_center`; im Zug über `free`), ohne Shift Endpunkte fest wie bisher; Tab = Radius
  (fester Mittelpunkt: Strahl Mitte → Cursor; feste Endpunkte: Klein-/Grossbogen, Seite und Gross/Klein vom Cursor,
  `arc_wall_radius_target`). Bogenlänge per Tab auch über dem Halbkreis: Seite eindeutig aus dem Cursor, Öffnungswinkel
  genau l/r (`arc_wall_resize`, `moveGrip` mit `arcLength`); Vorschau mit echtem Bulge. Geprüft: Rust-/vitest-Tests; nicht in der
  App geklickt (Shift-Griff, Tab-Feld „Radius", HUD). · M
- ◐ **[T4]** Import-Meshes glätten oder kantig. Metal-Pfad nicht gebaut/gesehen. · S
- ◐ **[T6]** Glattes Gelände aus Höhenlinien (`terrain.rs`). Natural-Neighbour/Clough-Tocher statt Hermite-Teilung;
  Erdreich-Band nicht „bis zur Planunterkante“; Glättung ohne Kantenerhalt; Baugrube ist eigene Kategorie und
  bleibt beim Ausblenden von „02“ stehen; gespeicherte Ansichten übernehmen beim Öffnen ihre `layerVisibility`. · L
- ◐ **[68]** Baugrube/Geländebearbeitung (Kontext-Objekt `excavation`). Verbau als echte Wand im Schnitt mit Dicke/
  Schraffur; Überlappung der Sohlenfläche nur gerastert; Arbeitsraum an konkaven Ecken ohne Prüfung; IVHB-Terrain
  nach kantonalem Recht. · M
- ◐ **[143]** Baugrube erstellen. (9.11.) DXF/DWG-Höhenlinien werden beim Import erkannt (Layer-Name Höhenlinie/HL/
  Contour/Kote …, Erhebung Gruppe 38, 3D-Polylinien mit konstantem Z, sonst Höhentexte nahe der Linie) und als
  `contourSet` „02 Gelände“ statt als 2D-Zeichnung übernommen: Kern `import_terrain.rs`, Option „Höhenlinien als Gelände
  übernehmen“ im Import-Dialog (Vorgabe an, wenn erkannt), Zähler in Dialog und Meldung; „Gelände erzeugen“ geht damit im
  leeren Projekt. Geprüft: Rust (fileio, Kern), vitest `src/io/dxfTerrainImport.test.ts`; nicht in der Tauri-App/im
  Dialog angesehen, DWG nur über denselben Pfad. Offen: Option „Baugrube aus Gebäudegrundfläche“; Höhenlinien aus
  Splines/Bögen und mit abweichender Texthöhe-Zuordnung (Text weiter als 2.5× Höhe von der Linie) werden nicht erkannt. · S
- ◐ **[27]** Punktwolken Stufe 1 (render3d `points.rs`). Beim Neuladen sind die Wolken weg (Stufe 2: Modellfeld
  `Project.pointClouds` + Asset, Vorschlag unter [B9]/`src/state/pointCloudStore.ts`); Speicher doppelt; Grundriss/
  Schnitt (Punkte in Scheibe), Fang an Punkten, Clip-Box. · L
- ◐ **[107]** Manifold-Booleans (`core/src/solid_bool.rs`). Abzugskörper beliebiger Form ([G1]/[G3]) über `solid_bool`;
  Ebenen-Zusammenfassung der Ausgabe (`simplify`); Schnittkanten für Plan/Schnitt aus dem Ergebnisnetz;
  `NOTICE` ([51]). Version ist gepinnt (`=0.19.1`). · M
- ◐ **[127]** 3D-Booleans klären. `fileio/csg.rs` (BSP) bleibt nur für den IFC-Import; stilllegen, wenn der IFC-Import
  im Kern liegt. · S
- ○ **[G7]** Robuste Booleans bei bündigen Flächen: laufende Aufgabe, wächst mit jeder Phase; Manifold löst die
  gemessenen Fälle (14/14), truck-B-Rep nicht. · L (laufend)
- ◐ **[G10]** render2d-Punkte f32 (`render2d::types::Scene`, ~0.25 m Auflösung bei LV95). Overlay ohne Ursprung-Verschiebung:
  Lineal (`PlanRulers`), Hover-Kreis einer Kreis-Zeichnung, HUD-Kasten; CLI-SVG (`plan --out`) schreibt
  Landeskoordinaten; Vergiftung nach Panic dauerhaft. · M

## Modell und Bauteile

- ◐ **[94]** Fenster/Türen: Konstruktionsdetails. Brüstung als eigenes Bauteil; Anschlag/Leibung in den Ressourcen-Tabs
  (nur im Bearbeiten-Dialog). · M
- ◐ **[95]** Fenster/Türen: mehr Bauarten. (10.11.) Hebeschiebetür in der Ansicht mit Bandseite: festes Feld auf der
  Bandseite (`hinge`), Schiebefeld mit Pfeil zum festen Feld, beide Flügelrahmen, Stoss überlappend. Fenster-Brüstungsfeld
  unter einem Riegel (`bottomPanelHeight`, Einteilung `bottomSashes`): Ansicht und 3D (Riegel, Pfosten, eigene Scheibe).
  Öffnungslinien wählbar (`sashSymbols`: Dreh-/Kipp-Dreiecke in der Ansicht; `planSwingArcs`: Aufschlagbogen der
  Drehflügel im Grundriss) am Fenstertyp und an der Öffnung (Objekt-Info, Ressourcen, Fenster-Dialog). Offen: Brüstungsfeld
  nicht im Schnitt (Riegel nicht geschnitten), nicht im IFC; Öffnungslinien im 3D immer an; nicht in der Tauri-App geprüft. · S
- ◐ **[105]** Fenster/Türen: Rahmen-Detail, Anschlag je Seite, Zargen. (10.11.) Zarge (Vorgabe) und Blockrahmen bei Dreh-/
  Pendeltüren mit eigenem Profil (`opening_detail::door_frame_of`): Zarge über die ganze Leibung, Falz 1.5 × 4 cm auf der
  Aufschlagseite, Bekleidung beidseitig; Blockrahmen nach Typlage hinter dem Maueranschlag. Blatt im Falz der Aufschlagseite in
  Grundriss (Drehpunkt an der Falzkante, fein als Rechteck mit Blattdicke), Schnitt, Ansicht, 3D und IFC (`fileio`
  `fill_geometry`: Blatt bündig mit der Rahmenfläche, Rahmen im Blattband um den Falz ausgespart). Das schmale Rahmenband quer
  über die Öffnung entfällt bei Drehtüren (bleibt bei Schiebetüren); nach aussen aufgehende Türen mit Viertel- statt
  Dreiviertelbogen. Sturzlinie wählbar (`lintelLineStyle` an Türtyp/Öffnung: gestrichelt, punktiert, durchgehend, keine;
  Strichmuster [153]); Öffnungswinkel bleibt in der Objekt-Info (`swingAngle`). Offen: Pendeltür ohne eigenes Profil (liegt ebenfalls im Falz); nicht in der Tauri-App/auf dem Mac
  (Metal, 3D-Bild) angesehen. · S
- ◐ **[106]** Schichteinzug je Wandschicht. Plantabelle (`sheet_table.rs`) ohne Leibungsspalten; Stufen-Fläche der
  Nachbarschicht beim Rücksprung nicht gezählt; Dachfenster ohne Schichteinzug; Schnitt parallel zur Wand durch
  Formöffnungs-Leibungen; 3D ohne Schichten zeigt an Leibungen keinen Rücksprung. · M
- ◐ **[103]** Dachfenster und Öffnungen in Dach/Decke. Griffe in Schnitt/Ansicht; Eindeckrahmen nur flacher Ring; Lukarnen;
  Umriss-Griffe eines Dachs können ein Fenster ausserhalb lassen (Prüfung meldet nichts); Wandkopien kopieren
  ihre Öffnungen nicht mit (Dach-/Decken-Wirt mit [134] erledigt); U-Wert: ungleichartige Schichten (kein
  Flächenanteil-Feld), Wärmebrücken, Gefälledämmung, Boden gegen Erdreich. · L
- ◐ **[113]** Wände bearbeiten (Trim, Extend, Teilen, Bruch, Verketten, Verrunden, Offset; 10.11. dazu Verrunden mit
  Radius an Bogenwänden, Fasen, gegenläufiges Verketten, 2D-Kurven an Wänden stutzen/verlängern, `cmd_wall_edit.rs`).
  Offen: gegenläufig verkettete Öffnungen kehren nur Aufschlag/Scharnier, nicht seitenbezogene Daten (`layerReveals`);
  nicht in der Tauri-App geprüft. · S
- ◐ **[108]** Schräge Wandanschlüsse exakt (T/L/X). 3D nur per Rust-Test (kein Metal-Render). · S
- ◐ **[151]** Treppenformen U und gerade mit Podest (`Stair`, `kernel2d`, `stairs3d.rs`). Kein Wendelpodest/Wendelstufen am
  Podest; Doppellinie ab 1:50 fest (keine Einstellung). · M
- ◐ **[100]** Standard-Baustoffe/Ansichtsschraffur (SIA 400). Deckenspiegel: Unterzüge (kein Modell-Element), UK unter
  Gauben, kein Leuchten-Werkzeug; waagrechte Flächen in Schnitt/Ansicht nicht sichtbar; Decken ohne
  `surfacePatternAngle/Offset`. · M
- ◐ **[109]** SIA-400-Schraffuren. render3d-Ribbons nicht visuell geprüft; SVG-PlanView-Rückfall ohne Strichmuster
  der Musterlinien; Porenbeton, Keramik, Faserzement, Erdreich, Kies ohne SIA-Sinnbild (Konvention); Dämmschlange in
  1:100 sehr dicht. · M
- ◐ **[102]** Linientypen SIA 400 / ISO 128. CPU-Rückfall (> 8 Einträge) verliert Punkte. · S
- ○ **[11]** Bibliothek per GUID. · M
- ○ **[42]** Varianten. · L
- ○ **[39]** Auswahl gehört zum Modell. · M

## Import und Export

- ◐ **[B4]** (= [25], zweite Stufe) IFC-Import zu echten Bauteilen (`io/ifcImport*`, `fileio`). Dächer, Treppen mit 3+ Podesten, Träger, schräge/
  gekrümmte Wände, Wände mit Profiländerung, Decken aus Netzen mit T-Stössen, Tür-Anschlag, Typen aus
  IfcDoorType/IfcWindowType, Farbe der Bauteile; LEFT/RIGHT nur gegen den eigenen Export geprüft. · L
- ◐ **[B3]-Rest** IFC-Geometrie-Import: IfcAdvancedBrep (NURBS), IFC4.3-Ausrichtung, IfcGridPlacement, B-Spline-Kurven,
  Profil-Kantenradien; CSG bei > 200 000 Dreiecken übersprungen; Farbe von Kontext-Meshes im 3D
  (`plan/toWalls3d.ts::emitMeshes` setzt fest `IMPORTED_RGB`). · M
- ◐ **[B5]** IFC-Export (Kern `ifc_data.rs`, `ifc_export/`). Wand/Decke-Felder ohne UI; Reference-Rückimport fehlt;
  IFC2x3 nicht gesondert geprüft; nicht in Revit/ArchiCAD geöffnet. · M
- ◐ **[BCF]** BCF (`fileio/src/bcf.rs`). Kamera im nativen Metal-Fenster; Schnittebene aus dem Live-Schnitt übernehmen;
  Kamera-Roll; schräge Schnittebenen nur angezeigt; `extensions.xml`, Farbgruppen/Linien, BimSnippet, Dokument-
  Referenzen und verwandte Themen gehen beim Speichern verloren. · M
- ◐ **[C11]** glTF/GLB-Export (`fileio/src/mesh_export.rs`). Keine Normalen/Texturen/Instanzen; Gelände ohne Vertex-Farben;
  Abzugskörper-Booleans und truck-Extrusionen nicht wie im 3D. · M
- ◐ **[C12]** Allgemeiner Mesh-Import. Keine Texturen/UVs/Normalen/Vertex-Farben, keine `EXT_mesh_gpu_instancing`,
  Sparse-Accessors, Draco/Meshopt. · M
- ◐ **[76]** Vektorfang auf PDF (`fileio/pdf_vector.rs`). Muster/Schattierungen und Soft-Masks, Clip-Pfade mit Text,
  Kreise in Linienzügen, Strichphase. · M
- ◐ **[79]** Publikationssätze (`Project.publishSets`). DXF/DWG: Papier-/Massstab-Übersteuerung wirkt nur als Export-
  Massstab; Satz je Ordner; Protokoll als Export. · M
- ◐ **[C4]** CLI-Skripte (`src/cli/convert.ts`). `run --script`; `--cmd` ohne gemeinsames Projekt; DXF/DWG-Import in
  `convert` ohne Dialog-Optionen; `convert` nach pdf/svg. · M
- ◐ **[B10]** Kleine Ideen. `pat.rs`: `;%UNITS=` und `;%TYPE=` lohnen erst mit vollwertigen PAT-Mustern (M). · S
- ○ **[88]** Nur-Lese-Link fürs Web. · M

## App und UI

- ◐ **[121]** `App.tsx` zerlegen, Neurendern stoppen. 9.11.: Panels lesen Projekt/Objekt-Info selbst aus dem Store
  (`useSelectionInfo`), Panel-Host stabil und in `src/state/panelHost/` zerlegt, Docks u. a. memoisiert, Nebenfenster
  senden Patches; Wand-Änderung 55 → 42 Renders (Zoom 8, Zeiger 20). 9.11. (Teil 3): `App` abonniert das Projekt
  nicht mehr (Griffe, Zifferntasten, Befehlszeile in `src/views/ViewportCenter.tsx`; Kontextmenü, Dialoge und
  `src/ui/ProjectSync.tsx` lesen selbst; Handler über `getState()`; Panel-Host baut lazy), einige Panels schmal;
  Wand-Änderung 42 → 40, `App` 0× (e2e prüft es). Offen: Panels mit echtem Projektbezug (Objekt-Info, Elementbaum,
  Attribute, Site, BCF, Publizieren …) abonnieren weiter `s.project`; `canUndo` rendert `App` beim ersten Schritt.
  Nicht in Tauri geprüft (Nebenfenster-Patches und Ressourcen-Fenster-Abgleich nur per Unit-Test/Code). · L
- ◐ **[130]** Kleinkram. PlanView/`useGrip3dEditing` nutzen lokale `selected…Ids`-Namen statt `Selection`. · S
- ◐ **[128]** Restlogik nach Rust. Griffe: Zusammenstellen der Griff-/Kanten-Listen (`gripOwners`), Höhen-Griff-Lagen,
  Vorschau, Zug-Anwendung bleiben in `useGripEditing.ts`; nächster Schritt: Griff-Listen als Dokument-Abfrage. · L
- ◐ **[124]** Kern typisiert. Rohes JSON noch in `selection_info` (~200 Zeilen), `grips` (~145), `cmd_solid` (~90),
  `cmd_transform` (~80), `cmd_create` (~60), `cmd_edit` (~45), `cmd_draw` (~40), `cmd_split` (~25), `geo_translate`,
  `pens`, `layers`, Importe; `selection_info`/`grips` brauchen eigene Tests (undefined ≠ null). · L
- ◐ **[9]** MCP-Brücke (`dossier-cli mcp --app`, `core/aiTools.ts`). In Tauri/macOS und Electron nicht getestet; kein
  Ereignis-Strom; Undo/Redo und Ansichten als Werkzeuge; [C3]: `screenshot`, `ui_click`, `render` fehlen. · M
- ◐ **[138]** Dokumentation und Website. Pages in den Repo-Einstellungen einschalten (Settings → Pages → GitHub
  Actions); eigene Domain: erst DNS (`dossier.openbureau.ch` CNAME), dann `website/static/CNAME`. · S
- ◐ **[160]** Entwickler-Doku (`doc/ARCHITEKTUR.md`, READMEs; schliesst [21] ein, `docs/areas/` ist damit ersetzt).
  Stand 9.11.: READMEs für `src/views`, `src/panels`, `src/viewport`, `src/io`, `src/export`, `src/ui`,
  `src-tauri/fileio/src`, `render2d/src`, `render3d/src` angelegt und in `doc/ARCHITEKTUR.md` verlinkt;
  Website `docs/entwickler/` abgeglichen (Modulkarte durch Verweis ersetzt, Goldens sind Text-Digests, Plattformen
  korrigiert). Offen: veraltete Kopf-Kommentare korrigieren (Liste in `doc/ARCHITEKTUR.md`, Abschnitt 13); READMEs
  nachführen, wenn `kernel2d/src/lib.rs` und `fileio/src/ifc_export.rs` aufgeteilt sind. · S
- ◐ **[49]** UI-Tests wie ein Mensch (`e2e/`). Debug-Hook für den Store fehlt (`window.__dossierStore` nur bei `?e2e`);
  Pixel/Rendering headless nicht prüfbar; Strichstärken, Text, Block, Raum, PDF-Export, Schnitt/Ansicht ohne UI-Test. · M
- ◐ **[C10]** Kleinigkeiten: Log-Rotation über `RUST_LOG`, isoliertes Profil per Umgebungsvariable. · S
- ○ **[55]** `IDEAS.md`. · S

## Kern und Leistung

- ◐ **[179]** Leistung messen und gezielt optimieren (11.11.2026, Linux-Container, `bench159`, Musterhaus komplex, Mittel ms).
  Erledigt: Raster-Hindernisse (Masse/Koten, Zeichnungen, Achsblasen) und Gebäuderinge je Plan einmal im `Ctx` statt je Raster
  und je Aufrufer neu; Masse/Koten und Zeichnungen in einem Durchgang. eg 1:100 83→57, 1:50 90→~62, mit Schatten 116→~90,
  Schnittlinien 14.6→6.8, Zeichnungen 11.9→10; Wand verschieben + Plan 90→65 / 67→43. Goldens byte-gleich.
  Etappe 2 (11.11., Container, Mittel ≥3 Läufe, ohne LTO gebaut): `Primitive` von 952 auf 400 Byte (Schraffur im Polygon als
  `Box<HatchRender>`), `cls`/`color` der Linien/Bögen als geteilte `Sstr` (Arc, Clone = Zähler); Cache-Treffer der Höhenlinien
  reserviert Luft (vorher verdoppelte das Anhängen der Pick-Flächen den 30k-Puffer: 16 ms). Kontext/Gelände 1:100 24→4 ms,
  1:50 18→6, mit Schatten 22→7; eg 1:100 61→41, 1:50 65→43, mit Schatten 88→83 (Maschine ausgelastet, Schatten schwankt). JSON/Puffer
  byte-gleich (Goldens ungeändert).
  Etappe 3 (11.11., Container, Mittel aus 3 Läufen à 8, ohne LTO, Maschine ausgelastet, ±20 %): (a) Plan-Schatten (`sun.rs`) nach
  Inhalts-Schlüssel gemerkt (128 Bit über Werfer, Dachflächen, Kronen, Abdeckungen, Empfänger, Sonne, Schnitthöhe, Gelände-Schlüssel;
  die letzten 6): gleiche Eingaben (Massstabs-/Ansichtswechsel, Zeichnung/Raum geändert, Innenwand nicht im Schatten-Schlüssel)
  rechnen nichts; Geländeschatten-Teile zusätzlich je Prisma und für alle Dachflächen gemerkt, so projiziert eine bewegte Wand nur
  sich neu (Strahlabtastung 20 von 32 ms). (b) Raumstempel: `Obstacles::clearance_capped` (ferne Hindernisse nach Hüllrechteck
  übersprungen, Abbruch unter dem bisher besten Abstand) und Abbruch der Lagesuche bei vollem Abstand – gleiches Ergebnis (Test
  gegen `clearance`). Höhenlinien-Cache war schon nach Inhalt geschlüsselt (Gelände, Fussabdruck, Hindernisse): ändert sich nur der
  Fussabdruck (Aussenwand), ist das Ergebnis tatsächlich ein anderes, nicht zu vermeiden. Goldens und CLI-Goldens byte-gleich.
  | bench159 (ms) | vorher | nachher |
  |---|---|---|
  | Domänen eg 1:50: Räume/Stempel | 14.2 | 1.2 |
  | Domänen eg 1:100 mit Schatten: Schatten/Baurecht (Treffer) | 38.6 | 3.6 |
  | eg 1:100 mit Schatten, Plan ohne Cache | 74 | 37 |
  | eg 1:50 Plan ohne Cache | 46 | 38 |
  | ug 1:50 Plan ohne Cache | 21 | 5.7 |
  | Innenwand verschieben + Plan, eg 1:100 mit Schatten | 75 | 57 |
  | Innenwand verschieben + Plan, eg 1:50 | 45 | 34 |
  Unverändert (Rauschen): Aussenwand verschieben + Plan (eg 1:100 76/86, 1:50 151/186, mit Schatten 119/110: Fussabdruck, Höhenlinien
  und Schatten ändern sich wirklich), eg 1:100 ohne Schatten 42/44. Offen: kalter Schatten ~32 ms (Vereinigung der ~690 Teile 13 ms, Dächer
  8 ms nach Dachänderung), kleine Änderung baut die übrigen Domänen noch voll (Schnittlinien 6.7, Zeichnungs-Hindernisse 4.5,
  Kontext 4.2 ms), kein Teil-Cache je Domäne. Mac nicht gemessen. · M
- ◐ **[58]** Inkrementelle Ableitung. 3D ist inkrementell; Schnitt/Ansicht (~100 ms) und Plan-Szene (`planToRenderScene`
  ~30 ms) noch voll; Gehrung über alle Wände je Update (~9 ms); Explosion ohne Cache; Upload/Frame mit echter GPU
  nicht gemessen. · L
- ◐ **[159]** Leistung nach den Darstellungs-Änderungen. Gelände-Schatten 30–35 ms (Cache je Werfer denkbar);
  Höhenlinien-Primitive kopieren 6–19 ms; Raumstempel 1:50 15 ms; Puffer schreiben 5–9 ms; Rest-Cache feiner nach
  Domäne; Schnitt/Ansicht nativ 2–4× langsamer als am 31.10. (nicht untersucht). Nicht auf macOS gemessen. · M
- ◐ **[20]** Performance-Benchmark (`dossier-cli … bench`). Messung auf macOS, Verlauf in CI, Plan/3D-Messung mehrerer
  Geschosse. · M
- ○ **[15]** Kostenbudget: Zeit-/Schrittbudget je WASM-Geometrie-Operation, Booleans im Worker. · M
- ◐ **[7]** Zentrale Validierung nach jedem Befehl (`ops.rs`). Weitere Regeln (Bezüge, Geometrie). · M
- ◐ **[14]** „Never crash“. Wächter für render3d/render2d/Kern; Lints `unwrap_used`/`expect_used`/`panic` auf `deny`;
  Obergrenzen; Hülle (Panels/Editoren) nicht gefuzzt. · M
- ◐ **[118]** Wiederanlauf nach Kern-Panic. Panic mitten in Undo/Redo stellt den Stand davor wieder her (erneutes Undo
  trifft denselben Schritt). · M
- ◐ **[3]** Darstellungswege reduzieren (vier 2D-Pfade: render2d, glPlan, SVG, native2d; zwei 3D-Pfade). · L
- ◐ **[17]** Ergebnisse über die Ausgabe testen. Golden-Ausgaben für 3D fehlen. · M
- ◐ **[19]** Beispielgebäude als Skript: `sampleProject.ts` + Kontrollmodell. · S
- ○ **[C5]** Copy-on-Write-Elementspeicher für billiges Undo (Vorlage für das Modell in Rust). · M
- ○ **[C7]** Text in Rust (Layout, OpenType-Shaping, Unicode-Bidi), wenn `text/` nach Rust wandert. · M

## Infrastruktur

- ◐ **[120]** macOS in CI (`.github/workflows/macos.yml`). Bildvergleich Metal ↔ WebGPU (gleiche Szene per
  `render2d::headless` und Chromium, Pixeltoleranz aus `tests/golden.rs`); Golden-Bilder für 3D in der CI ([R1]). · M
- ◐ **[30]** Release-Workflow (`release.yml`). 10.11.: erstes Tag `v0.1.0` gesetzt (Entwurf, unsigniert). Updater-Endpunkt (zeigt auf git.openbureau.ch), Secrets setzen,
  Linux-Job (AppImage, [170]) ergänzt; nicht auf GitHub gelaufen. Zielbild laut [C8]: macOS universal signiert/notarisiert, Windows MSI,
  Linux AppImage/Flatpak/deb/rpm, `SHA256SUMS.txt`. · M
- ◐ **[170]** Linux-Paket (9.11.). AppImage x86_64 mit electron-builder (`electron-builder.yml`, `npm run electron:pack`
  nach `npm run build`): Desktop-Eintrag (Graphics;Engineering;), MIME `application/x-dossier-project` für `.obp`,
  `dossier datei.obp` / Doppelklick (Hauptprozess liest die Datei, einzige Instanz, `useProjectFileActions`);
  gepackt lädt die App `dist` über das Schema `dossier://app`, WebGPU-Flags unverändert; Job `linux` in `release.yml`.
  Geprüft nur im Container (Xvfb, SwiftShader): entpacktes Paket startet, Oberfläche rendert, `navigator.gpu` liefert
  einen Adapter, AppImage enthält Desktop-Datei, MIME und Icon. Offen: Start des AppImage selbst (FUSE) und echte
  AMD-GPU/ANGLE-Vulkan, Öffnen einer gültigen `.obp` per Argument, Flatpak-Manifest (`packaging/linux/ch.dossier.cad.yml`)
  nie gebaut, deb/rpm, `--no-sandbox` im Desktop-Eintrag (AppImage-Vorgabe) ersetzen, Workflow nicht auf GitHub gelaufen. · M
- ◐ **[57]** Tests bei jedem Push (`check.yml`). Nicht auf GitHub gelaufen. · S
- ○ **[51]** Herkunft übernommenen Codes: Dateikopf + `NOTICE` je übernommene Datei; fällig für Manifold ([107]). · S
- ○ **[C6]** `cargo xtask ci`: Formatierung, Clippy, Tests, Crate-Schichtung, Asset-Herkunft, WASM-Build in einem
  Befehl. · M
- ○ **[C9]** Ehrliche Paritäts-Doku (`docs/file-format-parity.md`, `docs/gaps.md`): was beim Speichern verloren geht. · S

## Mac-Gegenprobe (Sammelpunkt)

Auf dem Mac (Tauri/Metal) noch nicht angesehen oder geprüft; bisher nur Linux-Container, CLI-SVG, Chromium oder
Unit-Tests: [116] (atomares Speichern), [117] (CSP unter `tauri://`), [118], [122], [123], [126], [110], [101],
[102], [131], [133], [136], [140], [145], [146], [153], [64], [T2], [T4], [34], [108], [65], [169], [113], [181], [G1]. Je Punkt ansehen, dann hier und
im jeweiligen Eintrag streichen. · M (gesamt)

---

## Erledigt

Einzeilig mit ID, Titel, Datum (2026). Kleine Reste erledigter Punkte (z. B. [T7] Achse beliebig im Raum, [T8]
exakte Durchdringung, [61] Zuordnung per Hand, [63] Profil je Kante, [70] Flächentabelle als Layout-Element,
[80] Einzelplan-PDF ohne Ebenen, [82] Legende per Ziehen) stehen im Archiv beim jeweiligen Eintrag.

- [183] Elemente-Panel: Dachfenster/Deckenöffnungen ohne Wirtswand bekamen kein Geschoss (leere Gruppe); `export_schedule` nimmt Dach bzw. Decke als Wirt (12.11.)
- [K0] Lader und Grenze (27.10.) · [K1] 2D-Geometrie inkl. Straight Skeleton [B2] (28.10.) · [K2] Geometrie-Ableitungen
  (27.10.) · [K3] Plan, Schnitt, Ansicht in Rust (29.10.) · [K4] Modell und Ops in Rust (29.10.)
- [1] Kernel nach Rust, [2] Modell im Rust-Kern (mit [K1]–[K4], 29.10.) · [6] Aktion = Befehl/Ops (29.10.) ·
  [8] Undo über Befehle (29.10.) · [84] Undo-Verlauf als Liste (29.10.)
- [R1] 3D headless nativ rendern (27.10.) · [46]/[R2] Grafik-Meldung bei fehlendem WebGPU, bewusst ohne
  Fallback-Renderer (27.10.)
- [116] Speichern absturzsicher (3.11.) · [117] CSP setzen (3.11.) · [119] Referenz-Ausgaben/golden (3.11.) ·
  [122] Zweites Kern-Dokument abgeschafft (3.11.) · [123] Doppelte Transformation gestrichen (3.11.) ·
  [125] Doppelte Schnitt-Dominanz (3.11.) · [129] Grenze schärfen (3.11.)
- [5] `Door[]`/`Opening[]` aufgelöst (27.10.) · [12] Dateien tolerant lesen (27.10.) · [13] Autosave mit
  Wiederherstellen (27.10.) · [47] Netzwerk in einem Modul (27.10.) · [16] Befehle mit Unsinn füttern ·
  [22] Fester Check vor Abschluss · [4] Kern headless als `dossier-cli` · [10] IDs und GUIDs trennen (28.10.) ·
  [18] IFC gegen IfcOpenShell (27.10.) · [50] Test für fehlende Übersetzungen · [23] Ergebnis anschauen ·
  [53] Grössengrenze `CLAUDE.md` · [54] Roadmap mit Grössen
- [G8] Abzugskörper senkrechte Prismen · [G9] Dach-Gehrung an Walm-/Zeltspitzen (27.10.) · truck 0.6 mit
  B-Rep-Grundkörpern, Booleans, STEP · [T5] Import reparieren (30.10.) · [T7] Rotationskörper/Loft im UI (30.10.) ·
  [T8] Kollisionsprüfung im 3D (30.10.)
- [41] Massenmodelle · [61] Raumprogramm gegen Modell (27.10.) · [62] Kennzahlenleiste (27.10.) ·
  [70] Flächentabellen SIA 416/IVHB (28.10.) · [63] Baulinien, Grenzabstände, Hülle (27.10.) ·
  [31] Stiftstärken in Papier-mm · [32] Linienstärken pro Massstab (27.10.) · [69] Georeferenz im IFC
- [35] Detailgrad pro Ansicht (4.11.) · [37] Beschriftung in Papiergrösse (4.11.) · [38] Assoziative Bemassung
  (30.10.) · [40] Ansichten duplizieren (4.11.) · [78] Autotext im Plankopf (27.10.) · [93] Zeichnen auf dem
  Layout-Blatt (29.10.) · [99] Esc/Enter in jedem Befehl gleich (29.10.) · [80] PDF mit Ebenen (30.10.) ·
  [82] Grafische Legenden (30.10.) · [66] Präsentationspläne mit einem Klick (4.11.)
- [97] Fenster- und Türliste (29.10.) · [98] Pset IsExternal/LoadBearing/U-Wert im IFC (29.10.) · [71] U-Wert aus
  dem Schichtaufbau (30.10.) · [111] Tabellen auf Layout-Blättern (30.10.) · [112] Achsraster (30.10.) ·
  [114] Musterhaus komplex (30.10.) · [134] Wandöffnungen beim Kopieren (5.11.) · [135] CLI-SVG mit Schraffur (5.11.) ·
  [139] Kleine Fehler aus der Doku (5.11.) · [144] Öffnungen verschieben (6.11.) · [147] Plan öffnet zu stark
  gezoomt (6.11.)
- [B1] IFC-Prüfung in der CI (27.10.) · [B2] Straight Skeleton (28.10.) · [B3] IFC-Import als Mesh (28.10.) ·
  [B8] Bogenwände, schneller Weg (30.10.) · [B9] Punktwolken-Leser (28.10.) ·
  [C1] DWG über `acadrust` (28.10.) · [C2] DXF als eigenes Rust-Crate (28.10.)
- [162] Grosse Rust-Dateien geteilt, reines Verschieben: `plan/section.rs` → `plan/section/`, `model3d.rs` →
  `model3d/` (9.11.); übrige Dateien > 2000 Zeilen offen (Vorschläge in `doc/ARCHITEKTUR.md`, Abschnitt 13)
- [164] `kernel2d/src/lib.rs` → 9 Module + `tests.rs`, `fileio/src/ifc_export.rs` → `ifc_export/` (`format`, `reader`,
  `types`, `builder`, `tests`; `build_ifc` bleibt in `mod.rs`), reines Verschieben, Testzahl gleich (9.11.)
- Gestrichen als überholt oder Regel: [24] Test first, [60] Nur versprechen, was getestet ist (jetzt Regel in
  `CLAUDE.md`), [B6] Wand unter Dach (analytisch gelöst in [G2]), [B7] Dach-Verschneidung (per Booleans in [G5]),
  [C3] (in [9]), [C8] (in [30]), [21] (in [160]), [R2] (in [46]).
- [163] `App.tsx` weiter zerlegt, ohne Verhaltensänderung: Hooks und Teil-Komponenten (9.11.; Liste in
  `doc/ARCHITEKTUR.md` Abschnitt 13; nicht in der Tauri-App geprüft)
- [165] Grosse Dateien geteilt, reines Verschieben (9.11.): `PlanView.tsx` 3902 → rund 1400 Zeilen (Hooks `usePlan*` in
  `src/views/plan/planView/`), `plan/elevation.rs` → Ordner `plan/elevation/`, `ObjectInfoPanel.tsx` 2847 → rund 370
  Zeilen (Abschnitte in `src/panels/objectInfo/`); Liste in `doc/ARCHITEKTUR.md` Abschnitt 13. Rust-Testzahl gleich;
  Plan-Ansicht nur im Browser-Test (Chromium/e2e) geprüft, nicht in der Tauri-App
- [150] Gelände im Grundriss am Gebäude (11.11.): Raumstempel ausserhalb ihres Raums (eigener Anker im Gelände) sind
  Hindernis der Höhenlinien-Beschriftungen (Räume werden vor dem Kontext gesetzt, `outside_stamps`); Beschriftungen an
  dichten Bündeln fehlen nicht mehr, sondern rücken entlang der Linie auf freie Stellen (Abschnitt, dann ganze Linie, erst
  zuletzt auf dem Bündel; `contour_prims`)
- [T3] Handlauf-Profil im Modell (11.11.): `Stair.railProfile` (rund / rechteck / flach), `railWidth`, `railHeight`, dazu
  Pfosten `postProfile`, `postWidth`, `postDepth`; gilt für alle Treppenformen und die Absturzsicherung am Deckenloch
  (`stairs3d::RailSpec`, `sweep` statt Rundrohr; Pfostenbreite in Richtung des Handlaufs). Grundriss-Doppellinie nutzt die
  halbe Handlaufbreite, IFC-Basismenge `CrossSectionArea`, Objekt-Info (Profil + Masse). Ohne Angabe Rundrohr wie bisher
  (Netze bit-gleich). Offen: Profil am Treppentyp (nur am Element), Profil nur für Handlauf/Pfosten, Stäbe der
  Absturzsicherung bleiben rund; in der App nicht geklickt
