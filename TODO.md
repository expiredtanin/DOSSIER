# Dossier — Arbeitsliste

Stand 9.11.2026. Die vollständige bisherige Liste mit allen Details, Messwerten und Befunden steht
unverändert in [`doc/archiv/TODO-bis-2026-11-08.md`](doc/archiv/TODO-bis-2026-11-08.md) (rund 4500 Zeilen).
Wer zu einer ID mehr wissen will (Entscheide, Tests, Bilder), sucht dort nach `**[ID]`.

## Regeln

- **Stand:** ◐ teilweise · ○ offen. Erledigtes steht nur in der Liste „Erledigt“ am Ende. Abgelehnte Ideen
  stehen im Archiv („Bewusst nicht übernommen“).
- **Grösse** (eine Person mit Agenten): S ≤ 1 Tag · M ≤ 1 Woche · L ≤ 1 Monat · XL > 1 Monat.
  Steht keine Grösse im Archiv, ist sie hier geschätzt.
- **IDs sind stabil.** Neue ID = nächste freie Zahl nach der höchsten im Archiv und hier (aktuell 163);
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

- ◐ **[133]** Musterhaus komplex: Rest. Skalieren-Kopie lässt `position`/Breite unverändert; Vollflächen-/Bildschraffur
  und Schraffur-Löcher beim Ausbreiten fehlen (`src/export/planToSvgString.ts`, Kern `plan/svg.rs`; wegen paralleler
  Arbeit an `svg.rs` (Bögen) am 10.11. nicht angefasst). (10.11.: Skalieren skaliert `position`/`width` der Wandöffnungen
  bei Kopie und Original, Test `skalieren_skaliert_oeffnungen`.) · S
- ◐ **[140]** Plandarstellung. (9.11.: Stempel in Tusche ohne farbige Auszeichnung, eigene Stempel ab 1:200
  verkleinert, IFC-Räume ohne festen Anker, Schatten-Reihenfolge geprüft; Rest der Liste war schon erledigt.)
  Offen: Fang-Punkt des Stempels rechnet mit Detail „mittel“; Deckenspiegel-Stempel ohne Hindernisse; Mac-Gegenprobe
  (Kern `plan/domains.rs`, `plan/extras.rs`). · S
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
- ◐ **[150]** Gelände im Grundriss am Gebäude. Raumstempel ausserhalb ihres Raums sind kein Hindernis für
  Höhenlinien-Beschriftungen; Beschriftungen an Bündeln fehlen statt versetzt zu werden. · S
- ◐ **[153]** Strichmuster in Papier-mm. Bögen mit Phase seit 9.11. ([169]: Plan-/Druck-SVG, PDF, Bogen-Shader; seit
  10.11. auch Ellipsenbögen, Länge numerisch),
  Kreise ohne (geschlossen), DXF/DWG ohne Phase je Objekt,
  Metal-Chunks verketten nur über das Ketten-Flag, React-SVG-Ansicht ohne Phase. · M
- ◐ **[155]** Treppensymbol. Raumstempel weichen den neuen Linien nicht aus; Lauflinie über Bruchlinie ausgezogen;
  Absturzsicherung nur im Grundriss (kein Geländer-Bauteil in 3D/IFC); Ende eines freien Lochrings ohne Gehrung;
  dichtes Belagsmuster in 1:100. · M
- ◐ **[156]** Bodenbelag-Muster massstabsgerecht. Möbel nur als Blöcke/Körper (geschlossene 2D-Formen der Kategorie
  „Möbel“ sparen nicht aus); Deckenspiegel-Untersicht unverändert (alte Ausdünnung). Nassraum nach Name ist durch
  [158] ersetzt. · S
- ◐ **[158]** Raumbuch. Keine IfcCovering-Bauteile (nur Pset-Texte); Wandoberfläche nicht je Wandseite, keine Sockel-/
  Leibungsflächen; lichte Höhe ohne Dachschrägen; Belagsmuster am ersten Umrisspunkt ausgerichtet; Belag im 3D und
  im Deckenspiegel nicht nach Raum. · M
- ◐ **[157]** Plan-Review Musterhaus komplex (Schweizer Praxis). Offene Befunde: Marken von Ansichten Nord/West bzw.
  Süd/Ost treffen sich im 1:500 an den Ecken; „B-B“ steht bis 2.5 m neben seiner Marke; „Detail und Situation“ auf
  Masskette/Höhenkote; Raumstempel verlieren beim Ausweichen die Nutzungszeile; Achsblasen ab 1:200 über Höhenkoten;
  Bogenwand-Fenster im Schnitt 1:50 nur Umriss; Höhenkoten im CLI-Schnitt zu weit links. · M
- ◐ **[142]** Schatten in zwei Richtungen. Schatten nur im Geschoss nächst ±0.00; Decken/Dächer werfen keinen eigenen
  Schatten (Auskragungen, Balkone); Wandöffnungen lassen kein Licht durch; Dach-/Kronenschatten als konvexe Hülle
  (`sun.rs`, Kern `plan/`). · M
- ◐ **[64]+[59]** Sonnenstand/Schatten. Schatten im 3D (`render3d`, Shadow-Mapping) ist gebaut, aber nicht auf Metal
  und nicht in der App angesehen; mehrere Kaskaden erst bei grossen Lageplänen. · S
- ◐ **[149]** Baum als eigenes Objekt. Nicht im Auswahlrechteck; keine Art-Beschriftung im Plan; Beschriftung fest
  rechts vom Stamm (kein Ausweichen, kein Griff); Schnitt durch die Krone zeigt die ganze Silhouette; Fuss am
  Gelände der Stammmitte (Hang). · M
- ◐ **[148]** Flach-/Pultdach auf beliebigem Umriss (`roof_geometry`). Pult mit Höfen (Höfe ignoriert); Pult auf
  schiefem Umriss neigt nur entlang x/y (`ridgeAxis`); Attika/Gefälle fehlen im Modell; Dachfenster-Laibung genau auf
  einer Fuge doppelt. · M
- ◐ **[26]** Dächer über beliebige Grundrisse (`core/src/roof*.rs`). Kante im Grundriss hervorheben und Kanten-/
  Hof-Griffe (PlanView); Mansarde mit Hof und verschieden geneigten Kanten (zweite Schicht nicht geschlossen);
  Schattenwurf nimmt die Hülle der Dachfläche. · M
- ◐ **[137]** Alles Sichtbare anwählbar. (10.11. bewusst nicht anwählbar, mit Begründung: Punktwolken sind kein
  Modellelement (Sitzungszustand, Millionen Punkte) — Ausblenden/Entfernen im Lage-Panel („Punktwolken"); Baurechts-Hüllkörper
  ist Anzeige-Option der Baurecht-Einstellungen (`showEnvelope`), im Plan über die Pseudo-Auswahl `site`/`siteRules` erreichbar,
  im 3D nur Schalter; eine Schnittbox gibt es (noch) nicht.) Nicht anwählbar: Höhenkoten im Schnitt; Geschosse als Auswahl-Art; Achsraster im Blatt nicht verschiebbar; Texte im 3D nur anwählbar,
  nicht gezeichnet; Klick auf Griff an der Stelle des letzten Klicks schaltet statt zu bewaffnen. · M
- ◐ **[77]** Zauberstab (Befehl `wand`). In der App nicht geklickt. (10.11.: Splines sind schon Begrenzung — der Fang-Sammler `snap_model` tesselliert sie; Test `spline_als_rand`.) · S
- ◐ **[81]** Automatische Aussenbemassung (`auto_dimensions`). (9.11.) Schiefe Ketten kreuzen den Grundriss nicht mehr
  (sonst vor alles im Streifen hinausgerückt), getrennte Gebäude eigene Seitenketten (`south2` …), Erker-Facetten ohne
  Stufe. Offen: schiefe Kette kann eine achsparallele Kette kreuzen; Radius von Bogenwänden nicht automatisch. · S
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

- ◐ **[G4]** Exakte Sichtbarkeit (HLR, Kern `hlr.rs`). Füllungen der Ansicht bleiben Maler-Ordnung (bei Gauben liegt
  eine Füllung über einer verdeckten Kante); Durchdringungslinien sich schneidender Körper fehlen; Gelände/
  Kontext-Netze nicht in der Projektion. · XL
- ◐ **[G6]** Allgemeine Polygon-Dominanz im Schnitt. 3D-Live-Schnitt (`render3d/section_boolean.rs`) rechnet nur
  Rechtecke, Ring mit Loch bleibt unbeschnitten; dort fehlt auch der Schraffur-Deckel von Abzugskörpern (aus [G8]). · M
- ◐ **[G1]** Ebenenschnitt beliebiger Körper (`plan/meshSection.ts`, `plan/domains.rs`). Poché für B-Rep-Körper im Grundriss
  (kein Netz im Kern), Eckenradius/Fase in der Poché, `ExtrudedSolid` ohne Material-Feld (keine SIA-Schraffur),
  Abzugskörper beliebiger Form im Grundriss, Untersicht von Wendel-/Podesttreppen. · L
- ◐ **[G2]** Wand an Dach. Ansicht bleibt Painter + Verdeckungstest (→ [G4]); fast achsparallele Grenzen im Band nur
  genähert; Fenster, das ins Dach ragt, verliert seinen Sturz; Dachgeometrie im 3D-Live-Schnitt unverändert
  (`wall_bands.rs`). · M
- ◐ **[G3]** Öffnungen beliebiger Form (`Opening.shape`). Projektion bei schräg zur Ebene stehender Wand nur mit
  Umriss der zugewandten Fläche (Leibungskanten fehlen); Abzugskörper beliebiger Form. · M
- ◐ **[G5]** Dächer untereinander, Gauben, Wand ↔ Decke. Wand ↔ Dach/Decke per Boolean (Wände müssten als Netze
  statt `RWall` gehen), 3D-Live-Schnitt-Deckel verschnittener Dächer, IFC-Mengen der Gaube, Kehlen symmetrisch je
  Schicht, Wand ↔ Decke für beliebige Polygone ([G6]). · L
- ◐ **[132]** Ansichten/Schnitte aus [114]. Haarlinien an Dreiecksfugen (SVG-Kantenglättung); Carport bleibt Pultdach 3°. · S
- ◐ **[115]** Schnitt/Ansicht wie Grundriss. Freie Körper (`extrudedSolids`, truck-Netze aus TS) fehlen im Fang des
  Schnitt-Viewports; 3D-Ausschnitt im Viewport. · S
- ◐ **[36]** View Range (`plan/view_range.rs`). Dach/Decke über/unter Schnitt verfeinern, Raum/Fenster eigenständig,
  Tiefe nur ganzes Bauteil (kein Clip an der Ebene); Öffnung ganz unter der Schnittebene bleibt mit Lücke. · M
- ◐ **[34]** Ansichtsvorlagen (`Project.viewTemplates`). Vorlage wirkt vollständig auch für Schnitt und Ansicht (10.11.):
  Blatt-Viewports (App, PDF, Kern-Puffer `sheet_viewports::snapshot_project`) und CLI (`--template`, sonst die an der
  Ebene verknüpfte Vorlage) setzen Ebenen-Felder, Detailgrad, Massstab, Tusche/Farbe, Kategorien, Override-Regeln und
  Strichstärken-Skalierung; der Schnitt-Viewport im Kern übernimmt jetzt auch den Detailgrad. Offen: die App-Ansicht
  selbst folgt weiter über den Anzeigezustand der aktiven Ansicht (`syncUi`; manuelle Abweichung bleibt möglich); der
  Detailgrad hat in der Ansicht (Fassade) keine Wirkung; `showTerrain`/`floorFinish` wirken nur im Grundriss; nicht in
  der Tauri-App geprüft. · S
- ◐ **[173]** Modelldarstellung (≙ Archicad „Model View Options"), Wunsch Maintainer: grob/mittel/fein als wählbare und
  eigene Stufen mit Einfluss auf alle Bauteile. Etappe 1 (10.11.): `Project.modelViewOptions` (Basis-Detailgrad +
  Abschnitte Türen/Fenster/Treppen/Wände/Decken-Böden/Gelände, jede Option „wie Basis" = heute), Wahl über
  `DrawingLevel.modelViewOptionId` (Werkzeugleiste: Detailgrad-Liste = Stufen; Ansichtsvorlage als Ebenen-Feld),
  `ViewSnapshot.modelViewOptionId` (Kern-Blattpuffer), CLI `--model-view`. Kern `plan/model_view.rs` (Rangfolge Element >
  Typ > Stufe > Basis, ARCHITEKTUR 3.5): Türen (Sturz, Winkel, Bogen, Zarge, Blatt), Fenster (Flügelrahmen, Bank,
  Aufschlagbögen; Öffnungslinien in der Ansicht), Treppen (Lauflinie, Pfeil, Bruchlinie, über Schnitt, Handlauf),
  Wände (alle/vereinfacht/Kern, Schwelle mm, Schichteinzug), Schnittflächen, Bodenbelag, Gelände; Ressourcen-Tab
  „Modelldarstellung". Etappe 2: Schnitt (Schichten `section::merge_thin_cuts`, Tür-/Fensterdetail), Deckenaufbau,
  Dächer, Stützen, Schatten der Ansicht, 3D (`detail` in `projectToModel3d`), Schwelle (fehlt im Grundriss), Sturzlinie
  Fenster, „nur Kern" als echte Kerndicke statt Kern-Material über die ganze Wand; App-Blattansicht nimmt die
  Ausschnitt-eigene Stufe noch nicht (nur Vorlage/Ebene). Etappe 3: Stufen-Bibliothek in Standards/Vorlagen,
  Stempel/Bemassung nach Stufe, Stufennummern der Treppe. Nicht in der Tauri-App/auf dem Mac geprüft. · M
- ◐ **[33]** Objektstile mit Rangfolge (Override-Regeln). „Ausblenden“ lässt Elemente im Grundriss anwählbar/fangbar;
  Schlagschatten und Gelände nicht über Regeln steuerbar; Linienstil auf Polygon-Umrissen (Wand-Umriss, Decken)
  ohne Wirkung; Linienstil-Aktion in der Ansicht ohne Wirkung; Öffnungen selbst ausblenden nicht möglich. · M
- ◐ **[65]** Explosionsaxonometrie (`explode3d.rs`). Abzugskörper (truck-Booleans) werden bei reiner Abstandsänderung neu
  gerechnet (Cache ohne Abstand fehlt). · S
- ◐ **[67]** Skizzenstil (`plan/sketch.rs`). Kompakte Linien-Unterlage (grosse DXF-Unterlagen), Bögen und Kreise bleiben
  exakt; keine Intensitäts-Einstellung; keine Hand-Schraffur. · S
- ◐ **[152]** Importierte Netze in Schnitt, Ansicht, Grundriss (`core/src/mesh_view.rs`). Der Archiv-Eintrag nennt keinen
  ausdrücklichen „Offen“-Teil; bekannt: IFC-Gelände ist nur im Schnitt eine Geländelinie, Ansicht und Grundriss
  behandeln es weiter als Netz. · S

## 3D

- ◐ **[T1]** Polyeder-Körper (`trucksolid::polyhedron`). Mehrteilige Netze und Hohlräume als mehrere Shells; Entscheid
  zu import-Netzen im STEP-Export (`solid_specs.rs`) offen; Komplanarität streng, f32-Importe ergeben mehr Flächen. · M
- ◐ **[T2]** Bogenwände. Teilen/Trimmen/Verrunden/Fasen/Verketten an Bogenwänden mit [113] (10.11.). Griffe (10.11.):
  Start/Ende einer Bogenwand laufen auf dem Kreis (Mittelpunkt/Radius fest, anderes Ende fest, Bulge nachgeführt;
  Kern `grip_drag::arc_wall_endpoint`), Tab = Bogenlänge ab dem festen Ende (nur Längenfeld, `arc_wall_point_at_length`);
  Randpunkte von Radius-/Durchmesser-/Bogenmassen bleiben auf dem Kreis um den Mittelpunkt (`grips.rs`). Öffnungen in
  Bogenwänden liefen schon über Bogenlänge ([144]). Geprüft: Rust-Tests; nicht in der App angesehen. Offen: Radius-Griff
  mit festem Mittelpunkt (Option; der Scheitel-Griff ändert den Radius bei festen Endpunkten), Bogenlänge > Halbkreis
  per Tab (nächstliegender Bogen gewinnt). · M
- ◐ **[T3]** Wendeltreppe. Kein Handlauf-Profil im Modell (rund fest). · S
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
  Podest; Handlauf-Profil fest rund; Doppellinie ab 1:50 fest (keine Einstellung). · M
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
[102], [131], [133], [136], [140], [145], [146], [153], [64], [T2], [T4], [34], [108], [65], [169], [113]. Je Punkt ansehen, dann hier und
im jeweiligen Eintrag streichen. · M (gesamt)

---

## Erledigt

Einzeilig mit ID, Titel, Datum (2026). Kleine Reste erledigter Punkte (z. B. [T7] Achse beliebig im Raum, [T8]
exakte Durchdringung, [61] Zuordnung per Hand, [63] Profil je Kante, [70] Flächentabelle als Layout-Element,
[80] Einzelplan-PDF ohne Ebenen, [82] Legende per Ziehen) stehen im Archiv beim jeweiligen Eintrag.

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
