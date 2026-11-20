# Dossier — Arbeitsliste

Stand 20.11.2026 (gekürzt). Die vollständige bisherige Liste mit allen Details, Messwerten und Befunden steht
unverändert in [`doc/archiv/TODO-bis-2026-11-08.md`](doc/archiv/TODO-bis-2026-11-08.md) (rund 4500 Zeilen);
der ungekürzte Stand vom 20.11.2026 in [`doc/archiv/TODO-bis-2026-11-20.md`](doc/archiv/TODO-bis-2026-11-20.md).
Wer zu einer ID mehr wissen will (Entscheide, Tests, Bilder), sucht dort nach `**[ID]`.

## Regeln

- **Stand:** ◐ teilweise · ○ offen. Erledigtes steht nur in der Liste „Erledigt“ am Ende. Abgelehnte Ideen
  stehen im Archiv („Bewusst nicht übernommen“).
- **Grösse** (eine Person mit Agenten): S ≤ 1 Tag · M ≤ 1 Woche · L ≤ 1 Monat · XL > 1 Monat.
  Steht keine Grösse im Archiv, ist sie hier geschätzt.
- **IDs sind stabil.** Neue ID = nächste freie Zahl nach der höchsten im Archiv und hier (aktuell 317);
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

## Release 1.0 — Wettbewerb & Vorprojekt (Ziel 12.12.2026)

Fokus der nächsten vier Wochen (Entscheid Maintainer 12.11.): eine erste Version, mit der man einen Wettbewerb (WBW) und
ein Vorprojekt (SIA 31) durchgehend auf dem Mac bearbeiten und abgeben kann. Alles andere wartet. Neue Aufgaben nur, wenn
sie einen Schritt dieses Ablaufs blockieren. **Abnahme:** der Maintainer spielt den Referenz-Ablauf ([206]) auf dem Mac
von leerem Projekt bis zur Abgabe ohne Absturz, Datenverlust oder Umweg durch.

**Referenz-Ablauf WBW/Vorprojekt:** Grundstück/Kontext laden (swisstopo, Kataster) → Baurecht/Hülle → Volumenstudie →
Raumprogramm gegen Modell → Grundrisse/Schnitte/Ansichten 1:200 (Vorprojekt 1:100) → Situation 1:500 mit Schwarzplan →
3D-Bilder/Axonometrie/Schatten → Flächen/Volumen SIA 416 und Kennzahlen → Kostenschätzung grob → Abgabe-Layouts (Plakate A0/A1,
Kennwort, anonym) als PDF; Austausch mit Fachplanern über DXF/IFC.

- ◐ **[266]** Wettbewerb einmal ganz durchgespielt (16.11., Bilder `doc/review-266/`). Offen: GV (`flaechen.rs`) — Studienkörper (frei, ≥ 9 m², ≥ 2.4 m) zählen nur ausserhalb der Geschossgrundrisse, Bodenplatte zählt von UK bis Fertigboden (FRAGE: SIA-416-Wortlaut zu Fundamenten/Sauberkeitsschicht nicht im Repo, gegen die Norm prüfen; Schwellen 9 m²/2.4 m sind Annahmen, Alternative: Merkmal „Gebäudekörper“). 3D-Dokument (`plan/axo.rs`): nicht auf dem Mac geprüft, kein eigener Reiter, kein Live-Schnitt (Gelände: [307]). Nicht geprüft: Tauri-App/Mac (Metal, 3D-Bild, Schatten, Rendering), Druck des A1-Plakats, DXF/IFC in Fremdsoftware; Plakat-Reste in [296]. · M
- ◐ **[307]** 3D-Dokument: Gelände als helle Fläche mit Randlinie (20.11., Bild `doc/review-307/axo.png`; `plan/axo_terrain.rs`, Netz-Quelle `excavation::terrain_model_mesh` wie 3D/Ansicht, mit Baugruben, Klasse über Sichtbarkeit/Ebene, Parameter `terrain` Vorgabe an). Verdeckt den Keller, wird vom Haus verdeckt. Zu dichte Netze (> 12 000 Dreiecke im Ausschnitt um das Gebäude) werden auf ein ~3000-Zellen-Raster umgerechnet (Baugruben-Böschung dort gröber). Offen: keine Höhenlinien (Linien im Gelände), keine Durchdringungslinie Haus/Gelände; Wettbewerb hat kein Gelände, nur Musterhaus komplex geprüft; Mac/Tauri nicht geprüft. · S
- ◐ **[308]** 3D-Dokument: Gelände als Modellsockel (20.11., Bild `doc/review-308/axo.png`; `plan/axo_terrain.rs`). Zuschnitt auf Parzelle (`siteRules.parcel`, Bounding-Box ∪ Gebäude) + 2 m, ohne Parzelle Gebäude + 5 m; an allen Randkanten senkrechte Seitenflächen bis tiefster Geländepunkt (inkl. Baugrube) − 1 m, dunkler getönt, senkrechte Kanten nur an Ecken. Bildgrösse folgt Haus + Sockel. Option `terrainClip` (`parcel` Vorgabe | `building` | `none` = wie bisher ohne Sockel), CLI `--terrain-clip`. Offen: Rechteck-Hülle und Keller siehe [309]; keine UI-Einstellung für `terrainClip` (nur Doc3d-Extra/CLI); Mac/Tauri nicht geprüft. · S
- ◐ **[309]** 3D-Dokument: Sockelrand gerade, Zuschnitt auf Parzellenumriss, Keller (20.11., Bild `doc/review-309/axo.png`; `plan/axo_terrain.rs`). Zuschnittfläche = Parzellenumriss + 2 m (Gehrung über `kernel2d`, Ecken ≤ 4·d, Selbstschnitte per Vereinigung geheilt, konkave Parzellen) ∪ Gebäude + 2 m, ohne Parzelle Gebäude + 5 m; Dreiecke werden an die Fläche geschnitten (i_overlay), Randkanten nur auf der Zuschnittkante und echtem Netzrand. Deckt das Netz die Fläche nicht oder ist es zu dicht, Raster über der Fläche mit am Netzrand ergänztem (konstant fortgesetztem) Gelände statt gezacktem Rand. Sockel-Unterkante ≤ tiefstes Bauteil − 0.5 m (zusätzlich zu tiefster Geländepunkt − 1 m). Offen: ergänztes Gelände ausserhalb des Netzes ist eine Annahme (nächste Höhe), im Bild nicht gekennzeichnet; keine UI-Einstellung für `terrainClip`; Mac/Tauri nicht geprüft (Haarlinien auf den Sockelseiten: [310]). · S
- ◐ **[317]** Anwählen in Schnitt und Ansicht systematisch geprüft (20.11., Hinweis Maintainer „in Schnitten Elemente nicht anwählbar“). Methode: Test-Naht `viewPickPoints` (`state/testHooks.ts`, PlanView meldet den gezeigten Plan) liefert je Pick-Id einen unüberdeckten Punkt, `e2e/sectionPick317.spec.ts` klickt ihn und prüft die Auswahl; dazu `src/plan/pickIds317.test.ts` (jede Pick-Id gehört zur richtigen Art, vier Beispielprojekte, alle Schnitte/Ansichten). **Behoben:** (a) Stütze/Träger im Schnitt trugen `ceilingId` mit der Stützen-Id → Klick wählte eine nicht vorhandene Decke (`section/primitives.rs`, `Cut::column_id`); (b) Treppe in der Ansicht trug `ceilingId` mit der Treppen-Id (`elevation/mod.rs`, jetzt `stairId`); (c) Rahmen im Schnitt/in der Ansicht nahm Stützen, Träger, Dächer, Fenster/Türen und Körper nicht mit (`MarqueeSelection.columnIds…`, nur mit `sheetBodies`, im Grundriss unverändert). **Geprüft ok** (Klick, Musterhaus komplex Schnitt A-A/B-B, Ansicht Süd/Ost; Wettbewerb/Umbau über Plan-Ids): Wand (geschnitten und dahinter), Decke/Bodenplatte, Dach, Fenster/Tür, 2D-Zeichnung/Entourage, Körper, Baum (`@tree`), Geländer in der Ansicht (`@railing`), Treppe im Schnitt, Gelände. **Offen:** Bauteile unter Geländefläche der Ansicht (UG-Wände, Baugrube, Bodenplatte in Ansicht Ost) wählen das Gelände — liegen sichtbar dahinter, nur über Klick-Zyklus ([137]); Koten/Höhenmarken, Raster, Nordpfeil, Schnittmarken in Ansicht sind abgeleitet und nicht anwählbar; Räume und Treppen in der Ansicht ohne eigene Pick-Fläche an Wand-Stellen nicht gesondert geprüft; Geländer im Schnitt nicht an einem Beispiel getroffen (keins schneidet); Wendeltreppe im Schnitt/Ansicht nur über Pick-Ids, nicht per Klick; Zoom (Rad) im e2e ohne Befund, Pan nicht; Klickpunkte liegen am weitesten vom Rand; nicht auf dem Mac/Tauri geprüft, Kern-WASM nur mit `--no-opt` im Container gebaut. · S
- ◐ **[316]** Ansicht: Schlagschatten aus dem Sonnenstand, Materialfuge (Hinweis Maintainer 20.11., Bild `doc/review-316/ansicht.png`). Schatten = Projektion aller Körperflächen (Wände, Decken, Dächer samt Gauben, Stützen, Geländer ausser Glas) in Lichtrichtung auf jede sichtbare Fläche davor, von der Sonne abgewandte Flächen ganz im Eigenschatten, über Öffnungen durchscheinend, Leibungsschatten nach Lichtrichtung (`plan/elevation/sun.rs`; alte 45°-Stirnschatten `elevation_geom::shadows` entfernt). Licht: Vorgabe Zeichenregel 45° von links vorn oben relativ zur Blickrichtung (Entscheid Koordinator); Sonnenstand aus `sunStudy.when` + Geo-Anker nur mit Modelldarstellung „Schattenlicht: Sonnenstand“ (`elevation.shadowLight`). Waagrechte/senkrechte Linie an jedem Wechsel des Fassadenbaustoffs zwischen bündigen Wandflächen (`patterns.rs` `material_seams`). Offen: nicht in der Mac-App geprüft; Kontext-Netze empfangen/werfen keinen Schatten; Licht durch Fensterlöcher nicht berücksichtigt; keine eigene Schalter-Stelle an der Ansichtsebene (nur Modelldarstellung). · M
- ◐ **[315]** Verbinden (Cmd/Ctrl+J) von Wänden ohne Abstandslimit (Hinweis Maintainer 20.11.): vorher nur bis max(0.5 m, 2 × Wanddicke); `cmd_wall_edit.rs` `spot`/`connect_pair` (sich schon kreuzende Paare bleiben unberührt), Hinweis `cmd.join.far` entfällt. Offen: nicht auf dem Mac geprüft. · S
- ◐ **[314]** Griffe (Eckpunkte) beim Herauszoomen zu gross (Hinweis Maintainer 20.11.): `gripZoomK` (Exponent 0.35, 0.4…1.25) jetzt auch für die Quadrate, dazu `gripCrowdK` (eng liegende Griffe kleiner, bis 40 %), `planView/constants.ts`, `PlanView.tsx`. Offen: nicht auf dem Mac geprüft. · S
- ◐ **[313]** Aus [304]/[266] (20.11.). Pick der Absturzsicherung folgt dem Geschoss der Decke wie die Sichtbarkeit (`PickStairMesh::guard_floor`, `ClassFilter::retain_pick`; angewählt wird weiter die Treppe; Test `absturzsicherung_pick_folgt_dem_geschoss_der_decke`). 3D-Dokument: Flächen < 1/1200 Bildbreite bleiben ungetönt — am Bild `:wettbewerb axo --view southeast --scale 200` geprüft, stört nicht (Fenster, Rad, Bank, Personen lesen sich über Kanten), bewusst so, keine Änderung. Offen: Kern-WASM nicht neu gebaut, kein Mac/Tauri-Lauf. · S
- ◐ **[312]** Aus [311]: Entourage im Schnitt ruhiger (20.11., Bild `doc/review-312/schnitt.png`, Wettbewerb 1:100). Netze der Bibliotheksobjekte zeigen nur Silhouette und Knicke > 35° (`Face::crease_deg` in `hlr.rs`, `ENTOURAGE_CREASE_DEG` in `section/projection.rs`); Personen (`furniture_3d::is_person`) nur als vereinigte Silhouette ohne Netzkanten; Pick-Fläche der Zeichnung (unsichtbares Polygon) auch mit Netzkanten wieder da. Tests: `entourage_schnitt_silhouette_und_pick`, `crease_tests`. Offen: Ansicht/Elevation unverändert; Goldens nicht berührt (vitest src/plan grün), Mac/Tauri nicht geprüft. · S
- ◐ **[311]** Aus [300]: Möbel/Entourage im Schnitt mit Ansichtskanten aus dem 3D-Netz (20.11., Bild `doc/review-311/schnitt.png`, links 1:200 Umriss, rechts 1:100 Kanten; `furniture_3d::imported_meshes`, `section/mod.rs` `compute_plane`, `Visibility::entourage_meshes`). Feiner als 1:200 laufen die Netze der Bibliotheksobjekte durch dieselbe Kanten-/Verdeckungsrechnung wie Netzkörper (`hlr`, Glättung); geschnittene Möbel nur als kräftiger Umriss ohne Fläche/Schraffur, ab 1:200 bleibt der Umriss ([253]). Tests: `entourage_im_schnitt_ansichtskanten`, `entourage_geschnitten_nur_umriss`. Pick: [312]. Offen: Musterhaus komplex hat keine Möbel, Bild am Wettbewerb-Schnitt (Personen); Ansicht/Elevation unverändert; Mac/Tauri nicht geprüft. · S
- ◐ **[310]** 3D-Dokument: Sockelseiten ohne Haarlinien, Durchdringungslinie Haus ∩ Gelände (20.11., Bild `doc/review-310/axo.png`; `plan/axo_terrain.rs`, `plan/axo.rs`). Aufeinanderfolgende, in der Aufsicht gerade Randkanten des Zuschnitts bilden EINE senkrechte Fläche je Seite (vorher ein Viereck je Dreieckskante, Töne an den Fugen verschieden → weisse Haarlinie im SVG). Haus-Flächen tragen die Körper-Nummer 2, Geländeflächen 1: die Kantenrechnung (`hlr::intersection_edges`, [G4]) liefert die Schnittlinie Wand/Körper ∩ Gelände mit Verdeckung wie die Sichtkanten, Linie in der Klasse des Bauteils; keine Linien zwischen Bauteilen. Test: `sockelseite_je_randkante_eine_flaeche`, `durchdringungslinie_haus_gelaende`. Offen: im Musterhaus komplex ergibt sich keine zusätzliche Linie (Fusslinie liegt auf dem Gelände = Wandkante, `near_boundary` zählt sie als Kante), die Linie ist nur am synthetischen Hang geprüft; Mac/Tauri nicht geprüft. · S
- ◐ **[305]** 3D-Dokument: Fenster mit Rahmen und Glas (20.11., Bild `doc/review-305/axo.png`). Offen: Glaskanten meist vom Rahmen gedeckt; Öffnungsteile ohne eigene Id (`plan/axo.rs`, `section::model_view_faces`); Dach-/Deckenfenster ([103]) nicht geprüft; Mac/Tauri und Kern-WASM in der App nicht geprüft. · S
- ◐ **[304]** 3D nur EG: Geländer oben bleibt sichtbar (20.11.). Offen: kein Browser-/Mac-Lauf (Kern-WASM nicht neu gebaut); Pick: siehe [313]. · S
- ◐ **[303]** Aus [300]: Bogenmasskette und Öffnungssymbole in der Ansicht (19.11., Bild `doc/review-303/plan.png`). Offen: Mac/Tauri und Druck-PDF nicht geprüft; Dreh-Linien-Strichlänge (2.2 mm) bei 1:100 unverändert; Treppe-Hilfslinien und Möbel im Schnitt aus [300] offen. · S
- ◐ **[302]** Aus [300]: Schnittspur, freie Kurzlinie, Schnitt B-B am Gelände, Koten (19.11., Bild `doc/review-302/plan.png`). Offen: Koten im Komplex stehen weit links (Carport, `level_marker_bounds`); Mac/Tauri und Druck-PDF nicht geprüft. · S
- ◐ **[301]** Aus [300]: doppelte Masszahlen in benachbarten Ketten (`auto_dimensions.rs`, `plan/model_view.rs`) und Sonnenschatten über Räumen (19.11., Bild `doc/review-301/plan.png`). Offen: Schatten-Befund stammte aus dem Bildschirm-Plan der App und war im Kern nicht reproduzierbar — Wettbewerb mit Sonnenstudie von Hand ansehen (Mac/Tauri nicht geprüft); bestehende Projekte behalten ihre Ketten bis zum nächsten `autodim`. · S
- ◐ **[300]** Planqualität 1:100 für die Vorprojekt-Abgabe geprüft (19.11., Bild `doc/review-300/plan100.png`). Offen: Treppen-Hilfslinien im EG (0.1 mm) auf Papier schwach; Möbel im Schnitt: [311]. Nicht geprüft: Metal/Tauri, Druck-PDF, Massstäbe ausser 1:100. · S
- ◐ **[286]** Umbau: Ecken sanierter Wände schichtweise statt Gehrung (18.11., `joins::layered_corner`, Bild `doc/review-286/ecke.png`). Offen: Fuge zwischen Beton der sanierten Wand und Dämmung des Nachbarn fehlt im Umbauplan; Bogenwände und Knoten mit ≥ 3 Wänden bleiben auf Gehrung; dominante Schicht nicht im Schicht-Editor des Wandtyps; Ecke im 3D und in der Tauri-App nicht geprüft. · S
- ◐ **[287]** UX-Prüfung „wie eine Architektin zeichnen“ (18.11., Bilder `doc/review-287/`). Offen: (1) Griff-/Verschiebe-Zug übernimmt erst beim nächsten Klick (`state/useGripEditing.ts`, M); (6) Objekt-Info bei Mehrfachauswahl zeigt nur das erste Element (`panels/objectInfo`); (7) Anfangsansicht des leeren Projekts 60 × 60 m und zwei Massstabszahlen in der Topbar; (8) Tab „+“ öffnet zweite Ansicht „Erdgeschoss“; (9) Fangmarker klein (`overlays.tsx` `markSize`); (10) Ctrl+V ohne Vorschau; (11) Prompts uneinheitlich (`i18n`, `cmds/*`); (12) Werkzeug-Tooltips ohne Kürzel. Nicht geprüft: 3D umschauen, Layout/Plakat, Umbau-Status, Spiegeln/Drehen, Mac/Tauri. · M
- ◐ **[289]** Linux-App auf Mac-Niveau (18.11., Bild `doc/review-289/linux.png`): Kürzel, Fensterknöpfe, Doppeltext. Offen: Doppeltext nur per Regel-Test belegt (`plan/nativeText.ts`), echte GPU nicht geprüft; Text im Editor bleibt unter dem Editorfeld in der Szene; native Datei-/Kontextmenüs und Desktop-Datei nicht angefasst; Mac/Tauri nicht geprüft. · S
- ◐ **[290]** Linux-App: Schatten zu dunkel (Deckkraft in `plan/scene.rs`), 3D-Last (`viewport/renderOnDemand.ts`), Adapter-Log (18.11.). Offen: im Container nur SwiftShader — echter Adapter (Wayland/„minimal“) und tatsächliche CPU-Last nicht geprüft; Pfadverfolger-Statusschleife läuft im Pathtrace-Modus weiter; Mac/Tauri nicht geprüft. · S
- ◐ **[288]** Fangpunkte und Griffe wie Vectorworks (18.11., Bilder `doc/review-288/`; `tools/snapGlyph.ts`, `planView/overlays.tsx`). Offen: Cmd/Ctrl-Klick als zweiter Weg zur Kantenauswahl fehlt (öffnet die Objektliste [137]); Griff-Zug übernimmt weiter erst beim nächsten Klick ([287] (1)); 3D-Kanten-Anfasser unverändert; nicht in der Tauri-App/auf dem Mac geprüft.
- ◐ **[285]** Referenz-Ablauf zum zweiten Mal durchgespielt (18.11., Bilder `doc/review-285/`). Offen: `raum` legt je Aufruf nur einen Raum an (M); Einheit löschen lässt leere Einheiten und zählt Nummern weiter; Statusleiste „Ebene“/„Geschoss“ uneinheitlich benannt (`ui/StatusBar.tsx`); Projektname bleibt „Leeres Projekt“; Axo: Rampe/Haustür auf der abgewandten Seite fehlen (`plan/axo.rs`); „Als Unterlage“-Vorgabe nur für LV95-DXF; Rampe abwärts: Hinweis-Schwelle offen; Plakat bei sehr kleinen Häusern/unpassendem Axo-Seitenverhältnis mit Leerraum. Nicht durchgespielt: Umbau, Varianten, Rendering-Fenster; nicht auf dem Mac. · M
- ◐ **[270]** Blickrichtungen überall gleich (3D-Spiegelung behoben, Marken weichen aus; 17.11.). Offen: 3D nur numerisch geprüft, nicht auf dem Mac/Metal; natives Spike-Fenster `src-tauri/src/native.rs` (Orbit-Richtung) nicht angepasst. · M
- ◐ **[279]** Geländer als eigenes Bauteil (18.11.; Lücke 7 `doc/VERGLEICH-1.0.md`; `railing.rs`, `plan/railings.rs`; nicht auf dem Mac geprüft). Offen: kein IfcRailing-Import; Loggia-Brüstung an Wänden bleibt Wand. · M
- ◐ **[291]** Geländer: Aufbau je Feld und gebunden an Treppe/Deckenkante (19.11., nach 1.0; `railing::path`, `railing_bound_tests.rs`). Offen: Füllung je Feld in der Objekt-Info nur über Feld-Nr. (keine Auswahl im Plan); runder Handlauf nur angenähert; Wendel ohne Pfosten-Feinheiten; IFC ein Körper (Pfosten nicht als Teile); gebundene Geländer bewegen sich nicht mit „Verschieben“; Mac/Tauri nicht geprüft. · M
- ◐ **[278]** Nutzungseinheiten und Wohnungsspiegel (17.11.; Lücke 6; `unit_schedule.rs`; nicht auf dem Mac geprüft). Offen: Einheiten im Grundriss als farbige Fläche/Stempel auf eigener Klasse ([180]); Summen je Typ/Geschoss als Blatt-Tabelle; Mindestfläche Zimmer und NWF nach kantonaler Definition; Einheit in IFC/DXF. · M
- ◐ **[281]** Geneigte Decken und Rampen (18.11.; Lücke 8; `Ceiling.slope`, Befehl `rampe`; nicht auf dem Mac geprüft). Offen: Wandschichten werden von geneigten Decken nicht eingeschnitten (Wandoberkante: [292]); STEP-Export schreibt die Platte waagrecht; geneigte Decke empfängt keinen Sonnenschatten; Rampenlauf ohne Material im IFC; Gefällelinien-Griffe nicht in der Tauri-App geprüft. · M
- ◐ **[292]** Wand „OK bis Decke“ (19.11.; nach 1.0; Rest von [281]; `Wall.ceilingAttach`, `model3d/walls.rs`, `wall_bands.rs`). Offen: Plan-Ansichtshöhe skalarer Werte (z. B. Kennzahl Wandhöhe) nutzt weiter die Krone; Auswahl jetzt gemeinsam, s. [293]; nicht in der Tauri-App geprüft. · S
- ◐ **[293]** Wand-Oberkante als EINE Auswahl (19.11.; nach 1.0; Rest von [292]; `src/model/wallTop.ts`, `cmd_create.rs`). Offen: skalare Wandhöhe (`u_value.rs` Fläche, `export_schedule.rs` Wandliste) nutzt weiter `Wall.height` statt der tatsächlichen Oberkante; nicht in der Tauri-App geprüft. · S
- ◐ **[280]** Träger/Unterzug als eigenes Bauteil (17.11.; Lücke 9; `Project.beams`, Befehl `traeger`; nicht auf dem Mac geprüft). Offen: `Group` ohne `beamIds` (in betretener Gruppe gezeichneter Träger wird nicht Mitglied); keine Stütze-Träger-Verschneidung; Profile nur als Text; nur rechteckig und waagrecht; Deckenspiegel mit Unterzügen fehlt; IFC-Import liest `IfcBeam` als Körper ([B4]/[B5]); Attribute-Panel (Strich, Schraffur, Poché) für Träger nicht verdrahtet. · M
- ◐ **[276]** Schnitt-/Ansichtslinie im Plan einstellbar wie Archicad (17.11.; `plan/misc.rs`, `plan/context.rs`, `SectionLookFields.tsx`). Offen: nicht auf dem Mac geprüft; Linientyp/Stift in der Modelldarstellung wählbar machen; Marke „Kreis mit Pfeil“ für Ansichten; Marken-Versatz unabhängig von der Linie. · S
- ◐ **[283]** UX-Prüfung der Wettbewerbs-Funktionen [271]–[281] (18.11., Bilder `doc/review-283/`; Befunde behoben). Offen: Statusleisten-Schrift der Mac-Nebenfenster nicht geprüft; nicht in der Tauri-App geprüft. · M
- ◐ **[271]** Umbaufilter wie Archicad (17.11.; Kern `renovation.rs`, Panel „Umbau“, `export/exportView.ts`). Offen: 3D-Fenster nur im Code angebunden, Bild nie angesehen; Blender-Paket ohne Umbau-Farben; keine Filter-Wahl in Ansichts-/Werkzeugleiste, eigene Filter nur im Modell; Filter-Vorschau spiegelt `renovation::builtin` in `model/renovation.ts` (besser: Anteile in `filter_list` mitliefern); Ersatzstück der Öffnung nur, wo die Schnittebene sie trifft; Tauri/Mac nicht geprüft. · M
- ◐ **[274]** Umbau je Schicht: Sanierung mehrschichtiger Wände, Decken, Dächer (17.11.; `renovation::build_up`, Panel „Sanierung“). Offen: Bogenwände ohne gestrichelte Abbruch-Kanten; Schnitt: Abbruch-Kontur schwarz statt gelb; 3D/Ansicht nur Farbe der äussersten Schicht; DXF ohne Umbau-Layer je Schicht; Decken im Grundriss nur Linie ohne Füllung; Endzustand hebt nur die Dachhaut; render3d und Tauri/Mac nicht angesehen. · M
- ◐ **[275]** Umbau-Farben als Farbe oder Stift, gedämpfte Vorgabe, eigene Farben je Etappe (17.11.; `renovation::default_style`, `ui/RenovationStyleEditor.tsx`). Offen: dünnes Strichwerk im Abbruch bleibt auf Papier blass; Etappen-Farben in der Oberfläche nur für Neu/Abbruch; Stift-Strichstärke wirkt nicht; Tauri/Mac und render3d nicht angesehen. · S
- ◐ **[269]** Pläne schöner (16.–18.11.; `drawings.rs::acc_bounds`). Offen: nur Linux/CLI angesehen; Schnitt/Ansicht-Ausmass nicht beschnitten (Gelände); FRAGE MAINTAINER: Vorlage „Eingabeplan 1:100“ blendet Klasse 24 („Fahrzeuge & Freiflächen“) nicht aus — Gartenkörper liegen darauf, aber auch Parkfelder/Fahrzeuge: Klasse ausblenden, eigene Klasse für Gartenkörper, oder so lassen?; Stossfugen-Muster in der Ansicht nicht geprüft. · S
- ◐ **[268]** Review der Änderungen vom 15./16.11. auf echte Fehler vor der Beta (16.11.). Offen: Sprachwechsel setzt weiteren UI-Zustand zurück (`useDrawingToolState`/`DEFAULT_SNAP`, aktives Werkzeug, Element-Zwischenablage `useSelectionState`; kein Datenverlust) · S; `uploadAsset` nur mit `--dry-run` geprüft. Nicht geprüft: Mac/Tauri, Electron-Paket, GPU-Renderer über mehrere Sprachwechsel. 
- ◐ **[263]** Visuelle und UX-Prüfung des Referenz-Ablaufs (15.11., `e2e/uxReview263.spec.ts`). Offen: Projektvorgaben (Namen wie „Leeres Projekt“, „Erdgeschoss“, „Süd“, Ebenen „20 Wände“) erscheinen in englischer Oberfläche deutsch (Vorgabenamen beim Anlegen über `t()`) · M; dunkles Thema: Plan bleibt hell (Absicht?). Nicht geprüft: Tauri/Mac (Nebenfenster, native Menüs, Metal, Hilfe-Einträge), Ansichtsleiste-Überlauf, Dock-Einklappen, 3D pixelgenau, Layout im Druck, Screenreader ausserhalb der Dialoge. · S–M
- ◐ **[261]** Version 1.0.0-beta.1 und Buildnummer `JJMMTT.N` (15.11.; `scripts/build-number.cjs`, `src/update/buildInfo.ts`). Offen: nicht in der Tauri-App/auf dem Mac geprüft; Projektdatei trägt kein Feld für schreibende App-Version/Build (Rust-Modellfeld + `KNOWN_KEYS` + Fassade); Zähler zählt Commits, nicht Builds. · S
- ◐ **[260]** Fenster/Türen im Grundriss symbolisch oder geschnitten (15.11.; `Opening.planMode`, `plan/walls.rs`). Offen: auf dem Mac nicht geprüft (Metal-Fläche, natives Objekteinstellungsfenster, PDF/DXF). · M
- ◐ **[253]** Standard-Objektbibliothek 2D (14.11.): 48 parametrische Objekte (`furniture_lib.rs`, `furniture_3d.rs`, `plan/entourage.rs`, Palette „Objekte“, Befehl `libobj`). Offen: auf dem Mac nicht geprüft (Ziehen aus der Palette mit Metal; nur CLI-SVG/Chromium angesehen); IFC: weitere Möbel über Tisch/Stuhl/Bank hinaus; DXF-Block ohne Attribute (Id/Parameter nur im Blocknamen); Klassen-Namen („23 Sanitär“) bleiben im englischen UI deutsch. · M

## Phase 1 (13.–19.11.): Stabil und baubar
  Konsolen-Audit (14.11., `node scripts/console-audit.mjs [--gpu]`): Rest nur headless/SwiftShader. Offen: Tauri/Metal-Konsole auf dem Mac nicht geprüft.
- ◐ **[206]** Referenz-Ablauf als e2e-Spec (`e2e/release10.spec.ts`) und Checkliste für die Mac-Abnahme (`doc/RELEASE-1.0.md` Abschnitt 13). Offen: Durchlauf der Checkliste auf dem Mac (Maintainer); DXF-Inhalt je Blatt nur am Kopf geprüft; 3D-Bild headless nicht prüfbar; Blender-Lauf von [211] nur auf dem Mac; `kataster.spec.ts` „über 600 Stützpunkten“ gelegentlich rot unter Last. · M
- ◐ **[258]** Robustheit: kein Kern-Panic im Referenz-Ablauf (14.11.; `src-tauri/core/tests/robustness.rs`, `robustness_web.rs`, `tests/robustness/op_fuzz.rs`). Offen: Speicher-Abbruch (`handle_alloc_error`) nicht fangbar (im WASM ein Trap); GPU-Renderer nur über GPU-freie Leser abgedeckt; TS-Seite und Ops der TS-Leseansicht nicht abgedeckt; Rust-Panic im WASM selbst nicht gemessen ([118]). · M
- ◐ **[116]** Datensicherheit, Audit (14.11.): Speichern/Autosave/Wiederherstellen/Schliessen. Offen: nichts davon in der Tauri-App/Electron geprüft (`doc/RELEASE-1.0.md` Abschnitt 14, Mac); Menüpunkt „Vorige Fassung“ nicht ausgegraut; Electron-Kommandozeilen-Start setzt keine Zuletzt-geöffnet-Einträge; Autosave liegt im Webview-Zustand und serialisiert im Hauptfaden (Worker erwägen). · S
- Release-Notes-Entwurf `doc/RELEASE-NOTES-1.0.md` (14.11.), offene Fragen an den Maintainer dort markiert (`**[Frage M: …]**`); nach dem Mac-Durchlauf [206] Einschränkungen nachführen.
- [30] Release-Workflow lauffähig: macOS universal signiert/notarisiert, Updater, Versionsnummer 1.0.0-beta; [57]/[120] CI auf GitHub grün.
- „Mac-Gegenprobe“ (Sammelpunkt unten) für alles im Referenz-Ablauf abarbeiten (Maintainer), Befunde sofort beheben; [194] Texte synchron, [195b] Objektfenster, [190] Cmd+J auf dem Mac bestätigen.
- Datensicherheit: Speichern/Autosave/Wiederherstellen auf dem Mac ([116]; Prüfschritte `doc/RELEASE-1.0.md` Abschnitt 14), Öffnen alter Beispielstände (Rundreise-Test grün), kein Kern-Panic im Ablauf.

### Phase 2 (20.–26.11.): Wettbewerb lückenlos
- ◐ **[226]** Schriftfamilien im GPU-Text (13.11.; `render2d/src/glyph.rs`, Atlas je Familie lazy). Offen: Mac-Gegenprobe (`native2d_font`/`native2d_needed_fonts` in `lib.rs`, `native_embed.rs`, `useNativePlanRenderer.ts` NICHT kompiliert/geprüft); je Zeile zählt nur die Familie des ersten Laufs; gedrehte Textfelder (`vtext.rs`) und SVG-Overlay-Texte unverändert; Kerning fehlt in der Kern-Messung. · S
- ◐ **[218]** Raumstempel bearbeiten im Objekteinstellungsfenster (13.11.; `RoomStampSection.tsx`). Offen: GPU-Glyphen-Pass zeigt die Familie noch nicht ([226]); Mac-Nebenfenster nicht geprüft. · M
- ◐ **[216]** 3D-Darstellungsfehler (12.11., Musterhaus komplex; `model3d::arc_zones`). Offen: Mac-Gegenprobe (Metal, Texturen); Kante der Aussenfläche an der Geschossgrenze bei verschiedenen Wandtypen UG/EG; Dachrand `dach-erker` nicht an die Wand gekoppelt; IFC-Profil-Weg schreibt Bogenwand ohne Dachanschluss als reinen Bogen; einzelne Körper mit inneren Stossflächen. · M
- ◐ **[228]** In Blender öffnen / .blend speichern (12.11.; `render_dossier.py` Modus `save`, Tauri-Befehl `blender_open`, Electron `blender:open`, CLI `blend`). Offen: Mac/Windows-Gegenprobe der Start-Befehle (nur im Container kompiliert/getestet); Datei liegt nach „Öffnen“ im Temp-Ordner. · S
- ◐ **[227]** Kontextgebäude auf dem Gelände, Baugrube im Rendering ausblenden (12.11.; `context_ground.rs`, `terrain_original_mesh`). Offen: Geländefortsetzung ausserhalb des Netzes flach; Bodenplatten mit Löchern/Wand-Fundamente schneiden nicht aus; nicht in der Tauri-App/auf dem Mac, Dialog nicht im Browser geklickt. · S
- ◐ **[207]** Schwarzplan / Situationsplan 1:500 (12.11.; `plan/situation.rs`, `plan/text_curve.rs`). Offen: `NUMERIC_LAYER_LABELS` (`import_context::layer_display_name`) leer, bis die Layer-Liste eines echten Kataster-DXF vorliegt; Strassennamen ohne eigenen Code (TS-Tabelle `contextCategories.ts` müsste mit); gedrehte Einzeltexte der nativen Fläche nicht im Glyphen-Pass ([194]); nicht in der Tauri-App/auf dem Mac geprüft. · M
- ◐ **[208]** Wettbewerbs-Abgabe (12.11.; `competition.rs`, `state/anonymityGate.ts`, `presentation_poster.rs`, `export/pdfFonts.ts`; nur Linux/Chromium geprüft). Offen: Legende hat keinen Zug am Blatt; Hilfslinien je Blatt statt je Master; Bild nicht in DXF/IFC-Exporten; grosse Bilder stehen als Data-URL im Op/Verlauf (bei vielen MB auslagern); Textspalte nicht in AutoCAD/BricsCAD geöffnet; `dossier-cli convert` prüft Anonymität nach Code-Lesung, nicht gelaufen (.obp-Ausgabe ungeprüft, BCF bewusst ohne Tor); Plakat: Raster bei Musterhaus komplex zu schmal, Inhalte nur beim Erstellen berechnet, Baurecht-Zeilen „—“; PDF: kein Rückfall für Glyphen ausserhalb der Latin-Teilmenge, PDF/X und Ebenen am Plotter nicht prüfbar. · M
- [61] Raumprogramm gegen Modell und Flächennachweis SIA 416 als Tabelle/Layout-Element ([70]); Kennzahlen (GF, GV, HNF/GF, Fassadenanteil).
- 3D-Bilder für die Abgabe: hochaufgelöster PNG-Export (Perspektive, Axonometrie, Schatten), Sonnenstand; [205] Pausfolie.
- [199]/[204] Plan- und App-Review-Reste im Darstellungsbereich 1:500/1:200 schliessen.
- ○ **[211]** Rendern mit Blender/Cycles (Entscheid 12.11.): Eintrag mit Stand unter „Import und Export“; Mac-Gegenprobe (Tauri, Metal), Blender 3.6/4.x, Dialog im Browser klicken. · M
- ○ **[213]** Kameras und Begehen/WASD (12.11.): Eintrag mit Stand unter „Grundriss“; Mac-Gegenprobe. · M
- ◐ **[214]** 3D-Engine optimieren (12.11.; Messung `BENCH_3D=1 npx vitest run src/viewport/render3d.bench.test.ts`, `render_png --bench`, `model3d_cache::tests::bench214`). Offen: nicht auf dem Mac/Metal und echter GPU gemessen; Geisterschicht beim Geschosswechsel noch 1.5 s (gross); Geschoss-Kontexte aller Geschosse je Abfrage, Kontext-Netze je Objekt als Teil; Vernetzen in render3d (komplex 324 ms kalt); Culling/LOD/Instancing erst nach Messung auf echter GPU; Pathtracer baut den BVH bei geänderter Topologie neu. · M

### Phase 3 (27.11.–3.12.): Vorprojekt
- ◐ **[234]** 3D: Rundbogen-Fenster ragte über die Wandoberkante (13./14.11.; `Project::opening_top_under_ceilings`, `opening_outline`). Offen: Breite wird nicht gekappt (Öffnung über das Wandende hinaus bleibt gestaucht). · S
- 1:100-Pläne in Abgabequalität (Bemassung, Koten, Raumstempel, Öffnungen nach Detailgrad) — Plan-Review-Runde 4 nach [199].
- ◐ **[256]** Plan-Review Runde 4/5 (1:100 Vorprojekt, 14.–18.11., Bild `doc/review-256/runde5.png`, nur Linux). Offen: von Hand gesetzte Hinweis-Führungslinie und Kamera-Kegel (Klasse 92) queren „17.39“, Beschriftung unter Revisionswolke/Sichtkegel; Höhenlinien-Beschriftung „-2.7“ an der Terrassenkante (komplex EG Südost); Entscheid Maintainer offen: `walls.contrastOnSolid` als Vorgabe bestätigen; Nachbar im Schnitt als Vorgabe Koordinator (`MAX_GAP_PAPER_MM` in `plan/far_context.rs`, ohne Antwort des Maintainers); Tauri/Mac nicht angesehen. · M
- Fachplaner-Austausch: DXF/DWG je Geschoss/Schnitt/Ansicht ([200]), IFC mit Räumen/Psets ([201]); Rundreise in Archicad/Revit einmal real prüfen ([C9]).
- ◐ **[259]** IFC-Export für Fachplaner (14./15.11.; `scripts/check-ifc-fachplaner.py`). Offen: nicht in Archicad/Revit/Solibri/BIMcollab geöffnet (`doc/RELEASE-1.0.md` 13.14); IFC2x3 nur über bestehende Tests; Dachraum-Körper füllt die Schräge nicht aus. · M
- ◐ **[255]** Baurecht-Nachweis gegen Modell als Tabelle (14.11.; `site_proof.rs`, Abfrage `siteProof`). Offen: Blatt-Tabelle nimmt aGSF/Grünfläche nicht aus den Panel-Eingaben; Grenzabstand als Verstossfläche statt kleinster Abstand; Fassadenhöhe nur über ±0.00; lange Zeilentexte kürzen bei < 150 mm Rahmenbreite; Mac/Tauri nicht geprüft. · S

- ◐ **[272]** Varianten wie Archicad „Design Options“ (17.11., für 1.0; `design_options.rs`, Panel „Varianten“). Offen: Blatt-Tabelle „Variantenvergleich“ ohne Umbau-Zustand/Kombination der Ansicht; Variantensatz-Wahl in Ansichtsvorlagen/Ausschnitten nur im Modell; ungeprüft, ob Wandanschlüsse Wände anderer Varianten berücksichtigen; Sperre wirkt nicht auf Fang/Griffe einer schon gewählten Fremd-Auswahl; 3D-Geisterschicht und natives 3D-Fenster (`nativeViewQuery` in `views/plan/nativeSync.ts`) nur im Code geprüft, Tauri/Mac nicht (`doc/RELEASE-1.0.md` 13.38). · M–L
### Phase 4 (4.–12.12.): Härten und veröffentlichen
- Nur noch Fehler aus dem Referenz-Ablauf; Leistung mit grossen Kontext-Importen; keine neuen Funktionen.
- Release 1.0.0: Tag, signierte Pakete, Release-Notes (ehrlich: was nicht geht), Download-Seite.

- ◐ **[262]** Netzzugriffe und Datenschutz (15./16.11.; Inventar in `doc/RELEASE-NOTES-1.0.md`). Offen: `spherePreview.ts` lädt `new Image().src` ohne `netFetch`; Update-Plugin und Tauri-HTTP-Plugin laufen ausserhalb der CSP/Host-Liste (nur Offline-Schalter); nicht in der Tauri-App geprüft. · S
- ◐ **[257]** Leistung mit grossen Kontext-Importen (14.11.; `dossier-cli :beispiel bench --context`). Offen: HLR bleibt linear in den Kontext-Flächen (Schnitt 620 ms bei 300k Dreiecken, Teil-Cache des Kontexts als nächster Schritt); Netz-Import/Ops tragen ganze Netze als JSON; keine echten Daten, Mac/Metal nicht gemessen. · M
- ◐ **[212]** Eigener GPU-Pathtracer in `render3d` als progressive Vorschau im Viewport (Entscheid 12.11.; nach 1.0). Offen: echte GPU und Mac/Metal (`native3d` reicht nur den Stil durch); Schnitt, Geisterschicht und Linien im Pathtracing; Höhen-/AO-Karten; Gelände ohne Material ohne Gras; indirektes Licht der Sonnenflecken, Raumlicht aus Fenstern aufs Gelände; Leuchten nur über Baustoffnamen; OIDN für Endbilder siehe [215]. · L
- ◐ **[215]** Cycles eingebaut für Endbilder (Entscheid 16.11.; `cycles_scene.rs`, `cycles_post.rs`, `.github/workflows/cycles.yml`, `doc/CYCLES.md`). Offen: Secret `GITEA_TOKEN` setzen und `cycles.yml` laufen lassen (Release `cycles-5.3.0` auf Gitea); gesamter Mac-Weg ungeprüft (Bau `build-macos.sh`, Metal, Signieren/Notarisieren, universale App; beide Workflows nie gelaufen); Normalenkarten; Tonwert-Look (AgX/Filmic) nicht wählbar; EXR/Tonwert synchron im Webview; CLI-Standard bleibt Blender. · L

### Nicht in 1.0 (bewusst später)
Ausführungsplanung 1:50/1:20-Details, [42] Varianten, [11] Bibliothek per GUID, [88] Web-Link, [G7] Booleans-Ausbau,
Punktwolken/BCF-Ausbau, Windows-Paket, [C5]/[C7]/[15] Kern-Umbauten — ausser sie blockieren den Referenz-Ablauf.

---

## Grundriss

- ◐ **[213]** Kameras und Begehen im 3D (12.11.; `Project.cameras`, Panel „Ausschnitte“, Begehen Umschalt+F). Offen: nicht in der Tauri-App geprüft; nativer Mac-3D ohne Begehen/Kameras (`native.rs` ist Linux/winit); Stil „Sonne am Tag“ (Datum/Uhrzeit-Dialog). · M
- ◐ **[205]** Pausfolie wie Archicad „Trace & Reference“ (12.11.; UI-Zustand je Reiter, Kern-Abfrage `tracePlan` in `plan/trace.rs`, Statusleiste, Cmd/Ctrl+Shift+T). Offen: Fang auf der Pause nur im Schnitt/in der Ansicht (nicht im Grundriss); Blatt/Layout als Quelle und Pause im Layout; nicht in der Tauri-App/auf dem Mac (Metal) geprüft. · L
- ◐ **[182]** Tabs/Ansichten wie Archicad (11.11.): Reiter-Arten Grundriss · 3D · Schnitt · Ansicht · Zeichnung/Layout werden nie gemischt (`state/viewTabs.ts`, `state/tabNavigation.ts`). Offen: nicht in der Tauri-App geprüft. · S
- ◐ **[181]** Importe als eigenständige Elemente (11.11.): Gelände, Höhenlinien, Netzkörper, Luftbilder, Baugruben mit Pflicht-Klasse; Entwurf `doc/ARCHITEKTUR.md` Abschnitt 8. Offen: Mac-Gegenprobe. · L
- ◐ **[180]** Alles Sichtbare auf Ebene/Klasse (11./12.11., Vorgabe Maintainer; Audit-Tabelle `doc/ARCHITEKTUR.md` 3.6, `model3d::ClassFilter`). Offen: render3d vernetzt die Geisterschicht bei Änderung ganz neu; `native.rs` (Feature `native3d`) nicht kompiliert; Datei-Exporte bleiben vollständig; nicht in der Tauri-App/auf dem Mac geprüft. · M
- ◐ **[193]** Anwählen/Bearbeiten von Gelände & Co. (11./12.11.; Cmd+A, Entf, Verschieben/Kopieren, Höhenlinien- und Netzpunkt-Griffe, `meshCrop`, `meshPointDelete`). Offen: Löschen mehrerer Netzpunkte auf einmal; Netz-Ausdünnen/Aufräumen; nicht in der Tauri-App getestet. · M
- ◐ **[200]** DXF-Export: Stifte je Element, Schnitt/Ansicht (12.–15.11.; `ENTPEN`, Transparenz, `MTEXT`; Paritäts-Doku `doc/DATEIFORMATE.md`). Offen: Texte ohne Transparenz; Öffnen in AutoCAD/BricsCAD nicht geprüft (auch MTEXT); nicht in der Tauri-App geklickt. · S
- ◐ **[199]** Plan-Review Runde 3 (12.11., CLI-SVG `--hatch`, Chromium, nur Linux; Gaubenwange behoben). Offen, falls gewünscht: Fenster hinter dem Schnitt mit Glas/Rahmen statt nur Leibungslinie; 3D nur über Kern-Tests (`render_png` nur Metal), nicht auf dem Mac. · S
- ◐ **[198]** T-Stoss: gleiche Schichten verschmelzen (12./13.11.; `plan/seams.rs`, `merge_wall_bands`). Offen: schraffierte Bogenwand an gerader Wand bleibt getrennt (polar vs. parallel); Schnitt nur Linien, keine Flächen-Vereinigung; Ansicht nicht angesehen; nicht auf dem Mac (Pick/Hervorhebung). · M
- ◐ **[195b]** Objekteinstellungen als ECHTES Nebenfenster (12.11.; unter Tauri Fenster `object-settings`). Offen: NICHT auf macOS gebaut/getestet (nur vitest/tsc); kein Live-Mass im Fenster; Gelände/Baugrube ohne Setter im Objekt-Info; Dach-Kanten, Gauben, Höfe nur bei EINEM Dach. · L
- ◐ **[194]** Texte exakt synchron beim Zoomen (12.11.; native Fläche zeichnet Plan-Texte im Glyphen-Pass `render2d/src/glyph.rs`, Kern `plan_screen_texts`, `native2d_scene_texts`). Offen: auf dem Mac prüfen (Takt, Schärfe auf Retina, Bild gegen SVG); Griffe nativ; gemischte Schnitte innerhalb einer Zeile (Schnitt des ersten Laufs gilt). · M
- ◐ **[190]** Verbinden wie Archicad + Kürzel (12.–14.11.; `cmd_wall_edit.rs::connect_ops`, `state/selectionJoin.ts`). Offen: „Auswahl ausblenden“ schaltet Ebenen statt einzelner Elemente; kein Cmd+E/F2; Mac-Ursache von „Cmd+J geht bei Wänden nicht“ ungeprüft (natives Menü fängt die Taste); nicht auf dem Mac geprüft. · S
- ◐ **[191]** Runde Decken/Dächer (11./12.11.; `ring_arc.rs`, `outlineBulge`/`holesBulge`/`boundaryBulge`). Offen: Dach-Kantenneigung an Bogen-Teilkanten nur geerbt; Bogenwände im 3D weiter 7.5°-Sehnen; nicht in der Tauri-App/auf dem Mac geprüft. · L
- ◐ **[187]** Griffe im Schnitt/in der Ansicht (12.11.; Kern `sheet_height.rs`). Offen: Höhenlinien-Griffe ohne Obergrenze; Gelände-Profilpunkte von Netzen; bei Dächern mit `edgePitchDeg` ändert der First-Griff nur die Hauptneigung; Wand-UK-Griff ändert nur die Bindung `bottom`; nicht in der Tauri-App geprüft. · L
- ◐ **[185]** Navigation wie Archicad (12.11.; Geschosswechsel behält Ausschnitt `planFitKey`, Cmd+5/6, Cmd+3/4 „Auswahl in 3D“ über `model3d::ElementSelection`, `state/view3dFilter.ts`). Offen: natives Mac-3D-Fenster kennt den Element-Filter nicht; Ebenen-Panel-Wechsel nicht einzeln e2e geprüft; nicht in der Tauri-App/auf dem Mac geprüft (Menü-Kürzel vs. Browser-Kürzel). · M
- ◐ **[186]** Schatten (12.11.; Grundriss: Hülle statt Abdeckung `sun.rs::filled_envelope`, Sockel; 3D: zwei Kaskaden `render3d/shadow.rs::cascades`). Offen: auf dem Mac (Metal, App/WebGPU) nicht angesehen; Speicher Schattentexturen 64 MB (+16 MB Kaskade 1); PCF unverändert (3×3). · M
- ◐ **[133]** Musterhaus komplex: Rest. Offen: Bildschirm (render2d) zeichnet Vollflächen-/Bild-Schraffur nicht selbst (Füllung des Erzeugers), Verläufe fehlen in allen Ausgaben; nur im Linux-Container geprüft. · S
- ◐ **[140]** Plandarstellung. Offen: Fang-Punkt des Stempels rechnet mit Detail „mittel“; Deckenspiegel-Stempel ohne Hindernisse; Mac-Gegenprobe (Kern `plan/domains.rs`, `plan/extras.rs`). · S
- ◐ **[177]** Raumstempel im Archicad-Stil (10.11.; `showUsage`, `showDivider`). Offen: Mac-Gegenprobe (Metal/native Ansicht); Kern `plan/domains.rs`, `RoomStampSection.tsx` ([218]). · S
- ◐ **[141]** Wandecken (9.11.; Wand/Stütze überlappen nicht, IFC `COLUMN_PIECES`). Offen: Längsschnitt ohne Anschlag-Nasen/Schichteinzug; Muster bei ungeraden Maschen; Schnitt genau in einer Wand-Stirnfläche: Lücke in der Projektionskante über den Streifen. · M
- ◐ **[166]** Dämm-Striche quer zur Wand (9.11.; `hatch::build_hatch_runs`). Offen: render3d-Live-Schnitt und Mac nicht angesehen. · S
- ◐ **[169]** Runde Formen als echte Kreise/Bögen (9./10.11.; `plan/arc_fit.rs`). Offen: Ellipsen in Schraffur-Rändern bleiben Vielecke; Bogenwand-Schraffur (polar) weiter als Polylinien; Ellipsen nur achsparallel; 3D-Glättung und Bildschirm nicht angesehen. · M
- ◐ **[168]** Schichteinzug/Anschlag-Nase als Teil der Schicht (9.11.; `walls.rs`, `opening_detail.rs`). Offen: schwarze Sammelfläche (ab 1:100) ohne Einzug/Nase; Fenster ohne Typ ohne Vorgabe; Aussenputz bleibt an der Rohbaukante (nur die Dämmung überdeckt); nicht in der Tauri-App/auf dem Mac (render2d nativ, 3D) angesehen. · S
- ◐ **[145]** Texte beim Zoomen synchron (Raumstempel/Textfelder native seit [194]). Offen: Dach-/Deckenöffnung hat beim Setzen keine eigene Vorschau; Raumstempel setzt ohne Klemmung. · S
- ◐ **[146]** Linienenden/-ecken. Offen: Nähen in Metal-Chunks nur innerhalb eines Chunks (Kern `plan/line_ends.rs`, `render2d`). · M
- ◐ **[153]** Strichmuster in Papier-mm (Bögen, Kreise, geschlossene Züge gestreckt `line_pattern::fit_closed`). Offen: Metal-Chunks verketten nur über das Ketten-Flag (nicht mit Metal geprüft); DXF/DWG ohne Musterphase je Linie/Bogen (Format trägt keine, begründet); nur im Linux-Container geprüft. · M
- ◐ **[155]** Treppensymbol (Lauflinie, freier Lochring, Absturzsicherung 3D/IFC). Offen: Ende eines freien Lochrings ohne Gehrung; dichtes Belagsmuster in 1:100; 3D-Darstellung nur als Zahlen/Golden geprüft (Metal nur macOS). · M
- ◐ **[156]** Bodenbelag-Muster massstabsgerecht (Möbel sparen Belag aus). Offen: Deckenspiegel-Untersicht behält die alte Ausdünnung (0.7 mm, eigene Strichstärke/Farbe; Umstellung ohne klaren Gewinn). · S
- ◐ **[158]** Raumbuch (lichte Höhe unter Schrägen, Wandflächen, Leibungen, Sockel, Blatt-Tabelle). Offen: keine IfcCovering-Bauteile (nur Pset-Texte); Bogenwände liefern keine Wandseite (Kante unter „ohne Wand“); Belag im 3D und im Deckenspiegel nicht nach Raum. · M
- ◐ **[157]** Plan-Review Musterhaus komplex (10.11., CLI-SVG `--hatch`, Chromium, nur Linux). Offen: Marken von Ansichten Nord/West bzw. Süd/Ost treffen sich im 1:500 an den Ecken (Ansichtsmarker [176]/[270]); Kontrolle der Bogenwand-Fenster im Schnitt 1:50 nur im Test, nicht in der App; Achsblasen-Ausweichen gegen Texte/Detailverweise nicht geprüft. · M
- ◐ **[176]** Schnitt-/Ansichtsmarken im Grundriss nach SIA-Praxis, geknickter Schnitt (`plan/section/unfold.rs`), L-Marke (10.11.; Ausbau [276]). Offen: 3D-Live-Schnitt folgt der Endpunkt-Verbindung; optionale dünne Ansichtsebene; Mac-/Tauri-Ansicht nicht geprüft. · M
- ◐ **[171]** Plan-Review Runde 2 (10.11., Chromium, nur Linux). Offen: Raumstempel „Wohnen“ auf Zwischenwand W9/Schnittlinie A und Revisionswolken-Text auf der Bemassung Süd (Daten, einfaches Musterhaus); Höhenlinien-Beschriftung knapp an Masszahlen; Ansicht Ost: Schatten-Keile neben dem Erker mit Lücken je Geschoss; nicht auf dem Mac angesehen. · M
- ◐ **[199]** Plan-Review Runde 3 (12.11., beide Musterhäuser, nur Linux). Offen: bei 1:200 und bei Bogenmassen liegen einzelne Zahlen noch auf Achsen (komplex UG/EG/OG, 5 Fälle); Griffe (`grips.rs`) und DXF-Export kennen den Zeichen-Versatz der Aussenbemassung nicht; Daten-Befunde Musterhaus einfach (Giebel über OG offen, OG ohne ankommende Treppe, Kote „▽-2.71“ Süd); Mac/Tauri nicht geprüft. · M
- ◐ **[142]** Sonnenschatten im Grundriss (`sun.rs`; Decken/Balkone/Dächer werfen Schatten, Wandöffnungen lassen Licht durch). Offen: Kronen bleiben konvexe Hülle; Schatten aufs Gelände tieferer Terrassen nur über Decken/Dächer als Empfänger; nicht in der Tauri-App angesehen. · M
- ◐ **[64]+[59]** Sonnenstand/Schatten. Schatten im 3D (`render3d`, Shadow-Mapping) ist gebaut, aber nicht auf Metal und nicht in der App angesehen; zwei Kaskaden + Nahsicht seit [186]. · S
- ◐ **[149]** Baum als eigenes Objekt (11./17.11.; Auswahl, Beschriftung, Schnitt durch die Krone, Verdeckung im Schnitt/in der Ansicht `trees::occlude_in_section`). Offen: Schnittfläche der Krone ohne Schraffur; Verdecker zählen nur, wenn die Fläche ganz vor der Baum-Ebene liegt (ein langes Dach, das die Tiefe quert, verdeckt nicht); Gelände/Schnittband verdeckt Bäume nicht; Tauri/Mac nicht geprüft. · S
- ◐ **[148]** Flach-/Pultdach auf beliebigem Umriss (`roof_geometry`, `roof_parapet.rs`). Offen: Pult mit Höfen (Höfe ignoriert); Pult auf schiefem Umriss neigt nur entlang x/y (`ridgeAxis`); Attika bei Pult, Höfen und verschnittenen Dächern; Live-Schnitt im 3D (`roofCutLayers`) ohne Attika; Attika in Dachfarbe statt Bauteilfarbe. · M
- ◐ **[26]** Dächer über beliebige Grundrisse (`core/src/roof*.rs`; Eck-/Kanten-Griffe, Ecke einfügen/löschen `ringInsert`/`ringDelete`/`ringTidy`). Offen: Raute an Decken-`openings`; Kanten-Neigung/Giebel per Kontextmenü am Griff (heute Objekt-Info); Hover-Hervorhebung in der App nicht angesehen; Mansarde mit Hof und verschieden geneigten Kanten (zweite Schicht nicht geschlossen); Schattenwurf nimmt die Hülle der Dachfläche. · M
- ◐ **[137]** Alles Sichtbare anwählbar. Offen: nicht anwählbar sind Höhenkoten im Schnitt, Geschosse als Auswahl-Art; Achsraster im Blatt nicht verschiebbar; Texte im 3D nur anwählbar, nicht gezeichnet; Klick auf Griff an der Stelle des letzten Klicks schaltet statt zu bewaffnen (bewusst nicht: Punktwolken, Baurechts-Hüllkörper, Schnittbox gibt es nicht). · M
- ◐ **[77]** Zauberstab (Befehl `wand`; e2e `wand.spec.ts`). Offen: nicht in der Tauri-App geklickt. · S
- ◐ **[81]** Automatische Aussenbemassung (`auto_dimensions`; Radiusmass je Bogenwand). Offen: nicht in der App geklickt. · S
- ◐ **[172]** Masszahl der Bemassung „snappy“ und mittig (`dim_auto_offsets`, `grips.rs::dim_text_slot`, `round_label`). Offen: DXF/DWG-Export setzt die Textposition der Rundmasse noch nicht an den Versatz; in der App nicht geklickt. · S
- ◐ **[154]** Bauteile aus Zeichnung erkennen (Befehl `erkennen`; Fenster mit Schichteinzug in Bogenwänden `chord_window`). Grösse L; Rest: Rundreise-Test Musterhaus komplex Öffnungen > 0.85 (Bogenwand-Stösse, schräg anstossende Enden, Treppen/Decken, Blöcke weiter verbessern). · L
- ◐ **[136]** Reiter und Ausschnitte entkoppelt (`uiState.viewTabs`, `src/state/viewTabs.ts`). Offen: nicht in der Tauri-App/Browser geprüft (Zoom-Wiederherstellung läuft verzögert über `applyViewState`); Autosave-Wiederherstellung bringt die Reiter mit, ändert aber nicht den Dirty-Stand. · S
- ◐ **[131]** Untergeschosse unter ±0.00 (`DrawingLevel.zeroLevel`). Offen: nur die Mac-Gegenprobe. · S

## Schnitt und Ansicht

- ◐ **[184]** Fenster/Türen im Schnitt und in der Ansicht nach Detailgrad wie im Grundriss (11.11.; `model_view::Options::opening_detail`/`section_look`, Ansicht `plan/elevation/mod.rs`). Offen: nicht in der Tauri-App geprüft. · S
- ◐ **[178]** Deckenauflager an Aussenwänden (11.11.; `model3d/bearing.rs`, `Ceiling.edgeAtOutline`). Offen: Deckenkante im Grundriss folgt noch dem Umriss; Platte ohne Wand in gleicher Höhe (UG-Decke über Lichtschacht/kurzer Fundamentwand im Musterhaus komplex) bleibt bis Umriss; nicht in der Tauri-App/auf dem Mac geprüft. · S
- ◐ **[G4]** Exakte Sichtbarkeit (HLR, Kern `hlr.rs`, `hlr_fill.rs`). Offen: Gelände als Flächen in der Projektion (bleibt Silhouette + Maske, [T6]); Durchdringungslinien im Projektionsteil des Schnitts (`section/projection.rs`); Öffnungen und Netze über 20 000 Flächen bleiben Maler-Ordnung; Ortgang der Sattelgaube zeigt nur die äussere Dachschicht ([G5]); nicht auf dem Mac geprüft. · XL
- ◐ **[G6]** Allgemeine Polygon-Dominanz im Schnitt. Offen: 3D-Live-Schnitt (`render3d/section_boolean.rs`) rechnet nur Rechtecke, Ring mit Loch bleibt unbeschnitten; dort fehlt auch der Schraffur-Deckel von Abzugskörpern (aus [G8]). · M
- ◐ **[G1]** Ebenenschnitt beliebiger Körper (`plan/mesh_plan.rs::plan_bodies`, `plan/extras.rs`). Offen: Körper verdecken keine importierten Netze (getrennte Sichtbarkeitsrechnung); nicht in der Tauri-App geprüft. · M
- ◐ **[G2]** Wand an Dach. Offen: Ansicht bleibt Painter + Verdeckungstest (→ [G4]); fast achsparallele Grenzen im Band nur genähert; Fenster, das ins Dach ragt, verliert seinen Sturz; Dachgeometrie im 3D-Live-Schnitt unverändert (`wall_bands.rs`). · M
- ◐ **[G3]** Öffnungen beliebiger Form (`Opening.shape`). Offen: Projektion bei schräg zur Ebene stehender Wand nur mit Umriss der zugewandten Fläche (Leibungskanten fehlen); Abzugskörper beliebiger Form. · M
- ◐ **[G5]** Dächer untereinander, Gauben, Wand ↔ Decke. Offen: Wand ↔ Dach/Decke per Boolean (Wände müssten als Netze statt `RWall` gehen), 3D-Live-Schnitt-Deckel verschnittener Dächer, IFC-Mengen der Gaube, Kehlen symmetrisch je Schicht, Wand ↔ Decke für beliebige Polygone ([G6]). · L
- ◐ **[132]** Ansichten/Schnitte aus [114]. Offen: Haarlinien an Dreiecksfugen (SVG-Kantenglättung); Carport bleibt Pultdach 3°. · S
- ◐ **[115]** Schnitt/Ansicht wie Grundriss (11.11.; freie Körper fangen, Kern-Netze `solid_mesh.rs` als EINE Quelle für Ansicht/3D/Pick/Explosion, truck-TS-Pfad entfernt). Offen: 3D-Ausschnitt im Viewport; nicht in der Tauri-App und nicht mit Metal geprüft. · S
- ◐ **[36]** View Range (`plan/view_range.rs`). Offen: Dach/Decke über/unter Schnitt verfeinern, Raum/Fenster eigenständig, Tiefe nur ganzes Bauteil (kein Clip an der Ebene). · M
- ◐ **[34]** Ansichtsvorlagen (`Project.viewTemplates`; wirken vollständig auch für Schnitt/Ansicht, Blatt-Viewports, CLI `--template`). Offen: die App-Ansicht selbst folgt über den Anzeigezustand der aktiven Ansicht (`syncUi`; manuelle Abweichung bleibt möglich); der Detailgrad hat in der Ansicht (Fassade) keine Wirkung; `showTerrain`/`floorFinish` wirken nur im Grundriss; nicht in der Tauri-App geprüft. · S
- ◐ **[173]** Modelldarstellung (≙ Archicad „Model View Options“; `Project.modelViewOptions`, Kern `plan/model_view.rs`). Offen: der 3D-Viewer übergibt keine Stufe (Stufen-Abfrage ohne inkrementellen Cache, im Viewer zu teuer); Stützen ohne Schichten; Dachschnitt im Grundriss ohne Dachfenster-Löcher und Verschneidung; Fensterteilung im 3D; Stufen nicht zwischen Projekten austauschbar; Stufennummer unter der Lauflinien-Pfeilspitze; Fang-Punkte der Stempel (`room_stamp_spots`) ohne Stufe; nicht auf dem Mac geprüft. · M
- ◐ **[33]** Objektstile mit Rangfolge (Override-Regeln). Offen: „Ausblenden“ lässt Elemente im Grundriss anwählbar/fangbar; Schlagschatten und Gelände nicht über Regeln steuerbar; Linienstil auf Polygon-Umrissen (Wand-Umriss, Decken) ohne Wirkung; Linienstil-Aktion in der Ansicht ohne Wirkung; Öffnungen selbst ausblenden nicht möglich. · M
- ◐ **[65]** Explosionsaxonometrie (`explode3d.rs`). Offen: Abzugskörper (truck-Booleans) werden bei reiner Abstandsänderung neu gerechnet (Cache ohne Abstand fehlt). · S
- ◐ **[67]** Skizzenstil (`plan/sketch.rs`). Offen: kompakte Linien-Unterlage (grosse DXF-Unterlagen); keine Intensitäts-Einstellung; keine Hand-Schraffur; Meldung „Text doppelt, Schatten/Baumkronen schwarz“ ([236]) nicht reproduziert (Regressionstest `src/plan/sketchStyle.test.ts`); Mac/Metal nicht geprüft. · S
- ◐ **[152]** Importierte Netze in Schnitt, Ansicht, Grundriss (`core/src/mesh_view.rs`). Offen: Baugruben auf geschlossenen Gelände-Netzen (Platte) nicht geprüft; Grundriss zeigt ohne Äquidistanz nur den Rahmen. · S

## 3D

- ◐ **[T1]** Polyeder-Körper (`trucksolid::polyhedron`). Offen: mehrteilige Netze und Hohlräume als mehrere Shells; Entscheid zu Import-Netzen im STEP-Export (`solid_specs.rs`); Komplanarität streng, f32-Importe ergeben mehr Flächen. · M
- ◐ **[T2]** Bogenwände (Teilen/Trimmen/Verrunden/Fasen/Verketten [113], Griffe auf dem Kreis, Scheitel-Griff mit Shift/Tab). Offen: Rust-/vitest-Tests, nicht in der App geklickt (Shift-Griff, Tab-Feld „Radius“, HUD). · M
- ◐ **[T4]** Import-Meshes glätten oder kantig. Offen: Metal-Pfad nicht gebaut/gesehen. · S
- ◐ **[T6]** Glattes Gelände aus Höhenlinien (`terrain.rs`). Offen: Natural-Neighbour/Clough-Tocher statt Hermite-Teilung; Erdreich-Band nicht „bis zur Planunterkante“; Glättung ohne Kantenerhalt; Baugrube ist eigene Kategorie und bleibt beim Ausblenden von „02“ stehen; gespeicherte Ansichten übernehmen beim Öffnen ihre `layerVisibility`. · L
- ◐ **[68]** Baugrube/Geländebearbeitung (Kontext-Objekt `excavation`, Verbau als echte Wand `shoringKind`/`shoringEmbed`, `working_space_check`). Offen: Verbau je Kante nur eine Art, Ansicht ohne Verbau-Schraffur (nur Farbfläche); IVHB-Terrain nach kantonalem Recht; nicht in der App/Metal angesehen. · M
- ◐ **[143]** Baugrube erstellen (DXF/DWG-Höhenlinien beim Import erkannt, `import_terrain.rs`). Offen: Option „Baugrube aus Gebäudegrundfläche“; Höhenlinien aus Splines/Bögen und mit abweichender Texthöhe-Zuordnung (Text weiter als 2.5× Höhe von der Linie) werden nicht erkannt; nicht in der Tauri-App/im Dialog angesehen, DWG nur über denselben Pfad. · S
- ◐ **[27]** Punktwolken Stufe 1 (render3d `points.rs`). Offen: Beim Neuladen sind die Wolken weg (Stufe 2: Modellfeld `Project.pointClouds` + Asset, Vorschlag unter [B9]/`src/state/pointCloudStore.ts`); Speicher doppelt; Grundriss/Schnitt (Punkte in Scheibe), Fang an Punkten, Clip-Box. · L
- ◐ **[107]** Manifold-Booleans (`core/src/solid_bool.rs`). Offen: Ebenen-Zusammenfassung der Ausgabe (`simplify`); Schnittkanten für Plan/Schnitt aus dem Ergebnisnetz; Version gepinnt (`=0.19.1`). · M
- ◐ **[127]** 3D-Booleans klären. Offen: `fileio/csg.rs` (BSP) bleibt nur für den IFC-Import; stilllegen, wenn der IFC-Import im Kern liegt. · S
- ○ **[G7]** Robuste Booleans bei bündigen Flächen: laufende Aufgabe, wächst mit jeder Phase; Manifold löst die gemessenen Fälle (14/14), truck-B-Rep nicht. · L (laufend)
- ◐ **[G10]** render2d-Punkte f32 (`render2d::types::Scene`, ~0.25 m Auflösung bei LV95). Offen: Overlay ohne Ursprung-Verschiebung (Lineal `PlanRulers`, Hover-Kreis einer Kreis-Zeichnung, HUD-Kasten); CLI-SVG (`plan --out`) schreibt Landeskoordinaten; Vergiftung nach Panic dauerhaft. · M

## Modell und Bauteile

- ◐ **[202]** Treppe verschieben: Deckenloch wandert mit (12.11.; `stair_guard::carried_holes`, `cmd_transform::carried_hole_preview`). Offen: nicht in der Tauri-App geprüft; kein Hinweistext in Objekt-Info/Kontextmenü. · S
- ◐ **[94]** Fenster/Türen: Konstruktionsdetails. Offen: Brüstung als eigenes Bauteil; Anschlag/Leibung in den Ressourcen-Tabs (nur im Bearbeiten-Dialog). · M
- ◐ **[95]** Fenster/Türen: mehr Bauarten (Hebeschiebetür mit Bandseite, Brüstungsfeld `bottomPanelHeight`, Öffnungslinien `sashSymbols`/`planSwingArcs`). Offen: Brüstungsfeld nicht im Schnitt (Riegel nicht geschnitten), nicht im IFC; Öffnungslinien im 3D immer an; nicht in der Tauri-App geprüft. · S
- ◐ **[105]** Fenster/Türen: Rahmen-Detail, Anschlag je Seite, Zargen (`opening_detail::door_frame_of`, `lintelLineStyle`). Offen: Pendeltür ohne eigenes Profil (liegt ebenfalls im Falz); nicht in der Tauri-App/auf dem Mac (Metal, 3D-Bild) angesehen. · S
- ◐ **[106]** Schichteinzug je Wandschicht. Offen: Plantabelle (`sheet_table.rs`) ohne Leibungsspalten; Stufen-Fläche der Nachbarschicht beim Rücksprung nicht gezählt; Dachfenster ohne Schichteinzug; Schnitt parallel zur Wand durch Formöffnungs-Leibungen; 3D ohne Schichten zeigt an Leibungen keinen Rücksprung. · M
- ◐ **[103]** Dachfenster und Öffnungen in Dach/Decke. Offen: Griffe in Schnitt/Ansicht; Eindeckrahmen nur flacher Ring; Lukarnen; Umriss-Griffe eines Dachs können ein Fenster ausserhalb lassen (Prüfung meldet nichts); Wandkopien kopieren ihre Öffnungen nicht mit; U-Wert: ungleichartige Schichten (kein Flächenanteil-Feld), Wärmebrücken, Gefälledämmung, Boden gegen Erdreich. · L
- ◐ **[113]** Wände bearbeiten (Trim, Extend, Teilen, Bruch, Verketten, Verrunden, Offset; `cmd_wall_edit.rs`). Offen: gegenläufig verkettete Öffnungen kehren nur Aufschlag/Scharnier, nicht seitenbezogene Daten (`layerReveals`); nicht in der Tauri-App geprüft. · S
- ◐ **[108]** Schräge Wandanschlüsse exakt (T/L/X). Offen: 3D nur per Rust-Test (kein Metal-Render). · S
- ◐ **[151]** Treppenformen U und gerade mit Podest (`Stair`, `kernel2d`, `stairs3d.rs`). Offen: kein Wendelpodest/Wendelstufen am Podest; Doppellinie ab 1:50 fest (keine Einstellung). · M
- ◐ **[100]** Standard-Baustoffe/Ansichtsschraffur (SIA 400). Offen: Deckenspiegel: Unterzüge (kein Modell-Element; mit [280] Träger neu bewerten), UK unter Gauben, kein Leuchten-Werkzeug; waagrechte Flächen in Schnitt/Ansicht nicht sichtbar; Decken ohne `surfacePatternAngle/Offset`. · M
- ◐ **[109]** SIA-400-Schraffuren. Offen: render3d-Ribbons nicht visuell geprüft; SVG-PlanView-Rückfall ohne Strichmuster der Musterlinien; Porenbeton, Keramik, Faserzement, Erdreich, Kies ohne SIA-Sinnbild (Konvention); Dämmschlange in 1:100 sehr dicht. · M
- ◐ **[102]** Linientypen SIA 400 / ISO 128. Offen: CPU-Rückfall (> 8 Einträge) verliert Punkte. · S
- ○ **[11]** Bibliothek per GUID. · M
- ○ **[254]** Eigene parametrische Objekte (nach 1.0, Vorbild Archicad-GDL/Grasshopper): Objekte mit Parametern, 2D je Detailstufe und später 3D selbst bauen — Knoten-Editor (Graph als Daten im Projekt, im Rust-Kern ausgewertet, gleiche Schnittstelle wie [253]) oder Textform (eingebettete Skriptsprache im Kern, z. B. Rhai). GDL-Dateien (.gsm) werden nicht eingelesen (Entscheid Maintainer). · L
- ○ **[42]** Varianten. · L (siehe [272])
- ○ **[39]** Auswahl gehört zum Modell. · M

## Import und Export

- ◐ **[211]** Rendering mit Blender/Cycles (12.11.; `export/blenderRender.ts`, `scripts/blender/render_dossier.py`, Dialog, CLI `render`). Offen: nicht in der Tauri-App/auf dem Mac geprüft (Berechtigungen, Metal-GPU), nicht mit installiertem Blender 3.6/4.x (Mix-Knoten, `light_settings.ao_factor` nur in 5.x geprüft); Dialog nicht im Browser geklickt; ambientCG-Web-Texturen lädt die CLI nicht; Dachtyp-Schichten ohne Bildkarte nur nach Namen. · M
- ◐ **[B4]** (= [25], zweite Stufe) IFC-Import zu echten Bauteilen (`io/ifcImport*`, `fileio`; Rundreise eigener Export → Import für Träger, Geländer, Rampen, Dächer, Test `src/io/ifcImport.roundtrip.test.ts`). Offen: Dachtyp-Bezug und Dachfenster der Rundreise (Fenster im Dach bleiben Mesh); Treppen mit 3+ Podesten; Träger mit Profil I/U und schräge Träger; geneigte `IfcSlab` (ausser Rampen); schräge/gekrümmte Wände; Decken aus Netzen mit T-Stössen; Tür-Anschlag; Typen aus IfcDoorType/IfcWindowType; Farbe der Bauteile; Träger-Bezug ignoriert Decken, die schon vor dem Import im Projekt lagen; nicht auf dem Mac geprüft. · L
- ◐ **[B3]-Rest** IFC-Geometrie-Import. Offen: IfcAdvancedBrep (NURBS), IFC4.3-Ausrichtung, IfcGridPlacement, B-Spline-Kurven, Profil-Kantenradien; CSG bei > 200 000 Dreiecken übersprungen; Farbe von Kontext-Meshes im 3D (`plan/toWalls3d.ts::emitMeshes` setzt fest `IMPORTED_RGB`). · M
- ◐ **[B5]** IFC-Export (Kern `ifc_data.rs`, `ifc_export/`; Dach als `IfcRoof`-Aggregat mit je Dachfläche einem `IfcSlab` ROOF, Gauben als eigene Teile). Offen: Wand/Decke-Felder ohne UI; Reference-Rückimport fehlt; Dachfläche bleibt Netz (kein Profil-Sweep), `IfcRoofType` nur IFC4; IFC2x3 nicht gesondert geprüft; nicht in Revit/ArchiCAD geöffnet. · M
- ◐ **[BCF]** BCF (`fileio/src/bcf.rs`). Offen: Kamera im nativen Metal-Fenster; Schnittebene aus dem Live-Schnitt übernehmen; Kamera-Roll; schräge Schnittebenen nur angezeigt; `extensions.xml`, Farbgruppen/Linien, BimSnippet, Dokument-Referenzen und verwandte Themen gehen beim Speichern verloren. · M
- ◐ **[201]** IFC-GlobalId-Rundreise, Normalen in glTF/OBJ (12.11.). Offen: GlobalId von Bäumen und IfcOpeningElement/-Beziehungen (bleiben abgeleitet); Kopieren/Einfügen/Reihe/Spiegeln/Wand teilen setzen sie bewusst nicht mit; OBJ-Normalen/MTL im Tauri-Dialog (zweiter Dialog) und IFC nicht in Revit/ArchiCAD geprüft; keine UVs/Texturen. · S
- ◐ **[C11]** glTF/GLB-Export (`fileio/src/mesh_export.rs`). Offen: keine Texturen/Instanzen; Gelände ohne Vertex-Farben; Abzugskörper-Booleans und truck-Extrusionen nicht wie im 3D. · M
- ◐ **[C12]** Allgemeiner Mesh-Import. Offen: keine Texturen/UVs/Normalen/Vertex-Farben, keine `EXT_mesh_gpu_instancing`, Sparse-Accessors, Draco/Meshopt. · M
- ◐ **[76]** Vektorfang auf PDF (`fileio/pdf_vector.rs`). Offen: Muster/Schattierungen und Soft-Masks, Clip-Pfade mit Text, Kreise in Linienzügen, Strichphase. · M
- ◐ **[79]** Publikationssätze (`Project.publishSets`). Offen: DXF/DWG: Papier-/Massstab-Übersteuerung wirkt nur als Export-Massstab; Satz je Ordner; Protokoll als Export. · M
- ◐ **[C4]** CLI-Skripte (`src/cli/convert.ts`). Offen: `run --script`; `--cmd` ohne gemeinsames Projekt; DXF/DWG-Import in `convert` ohne Dialog-Optionen; `convert` nach pdf/svg. · M
- ◐ **[B10]** Kleine Ideen. Offen: `pat.rs`: `;%UNITS=` und `;%TYPE=` lohnen erst mit vollwertigen PAT-Mustern. · S
- ○ **[88]** Nur-Lese-Link fürs Web. · M

## App und UI

- ◐ **[294]** GUI-Optik-Prüfung (19.11., Linux/Chromium, Dock 240/460 px, hell/dunkel, de/en; Bild `doc/review-294/gui.png`; nur CSS). Offen/nur in WebKit prüfbar: sticky-Verhalten (`.tools-panel`, `.viewsnap-footer`), `mask-image` am Scroll-Container der Objekt-Info, Schattenlage; Geländer-Abschnitt [291] nicht gerendert; Dialoge/Toolbars/Dropdown-Popups nicht einzeln durchgesehen. · S
- ◐ **[295]** e2e „[212] Pathtracer-Stil: Sample-Zähler zählt hoch“ rot unter Last (19.11.; Test prüft jetzt den 3D-Hinweis bei jeder Zähler-Abfrage). Offen: Zähler auf lebendem Gerät headless nie beobachtet (SwiftShader verliert das Gerät nach dem ersten Sample); Mac/Metal von Hand (`doc/RELEASE-1.0.md` 13.1). · S
- ◐ **[296]** Plakat-Reste aus [266] (19.11., Bild `doc/review-296/plakat.png`; `plan/context.rs`, `presentation_poster.rs`). Offen: Schnittmarken-Kürzung (15 mm Überstand) bewusst nur im Plakat, nicht auf gewöhnlichen Blättern (bräuchte Rahmen-Zuschnitt wie beim Plakat, > halber Tag; [66]/[282]-Tests „passt aufs Blatt“ würden sonst fehlschlagen); Mac/Tauri nicht geprüft. · S
- ◐ **[204]** App-Review im Browser (12.11., `e2e/review204.spec.ts`/`review204b.spec.ts`). Offen: Punkt-Griff bleibt nach Ziehen+Loslassen „bewaffnet“ (VW-Stil, weicht von Archicad ab; siehe [287] (1)), Tür-Griff rastet beim Greifen auf den Zeiger (D1 rückt 5 cm) · S; nicht geprüft: 3D-Ansicht, Tauri/Mac. · M
- ◐ **[121]** `App.tsx` zerlegen, Neurendern stoppen (Wand-Änderung 55 → 40 Renders, `App` 0×). Offen: Panels mit echtem Projektbezug (Objekt-Info, Elementbaum, Attribute, Site, BCF, Publizieren …) abonnieren weiter `s.project`; `canUndo` rendert `App` beim ersten Schritt; nicht in Tauri geprüft (Nebenfenster-Patches und Ressourcen-Fenster-Abgleich nur per Unit-Test/Code). · L
- ◐ **[130]** Kleinkram. Offen: PlanView/`useGrip3dEditing` nutzen lokale `selected…Ids`-Namen statt `Selection`. · S
- ◐ **[128]** Restlogik nach Rust. Offen: Griffe: Zusammenstellen der Griff-/Kanten-Listen (`gripOwners`), Höhen-Griff-Lagen, Vorschau, Zug-Anwendung bleiben in `useGripEditing.ts`; nächster Schritt: Griff-Listen als Dokument-Abfrage. · L
- ◐ **[124]** Kern typisiert. Offen: rohes JSON noch in `selection_info` (~200 Zeilen), `grips` (~145), `cmd_solid`, `cmd_transform`, `cmd_create`, `cmd_edit`, `cmd_draw`, `cmd_split`, `geo_translate`, `pens`, `layers`, Importe; `selection_info`/`grips` brauchen eigene Tests (undefined ≠ null). · L
- ◐ **[9]** MCP-Brücke (`dossier-cli mcp --app`, `core/aiTools.ts`). Offen: in Tauri/macOS und Electron nicht getestet; kein Ereignis-Strom; Undo/Redo und Ansichten als Werkzeuge; [C3]: `screenshot`, `ui_click`, `render` fehlen. · M
- ◐ **[138]** Dokumentation und Website. Offen: Pages in den Repo-Einstellungen einschalten (Settings → Pages → GitHub Actions); eigene Domain: erst DNS (`dossier.openbureau.ch` CNAME), dann `website/static/CNAME`. · S
- ◐ **[160]** Entwickler-Doku (`doc/ARCHITEKTUR.md`, READMEs; schliesst [21] ein). Offen: veraltete Kopf-Kommentare korrigieren (Liste in `doc/ARCHITEKTUR.md`, Abschnitt 13); READMEs nachführen, wenn `kernel2d/src/lib.rs` und `fileio/src/ifc_export.rs` aufgeteilt sind. · S
- ◐ **[49]** UI-Tests wie ein Mensch (`e2e/`). Offen: Debug-Hook für den Store fehlt (`window.__dossierStore` nur bei `?e2e`); Pixel/Rendering headless nicht prüfbar; Strichstärken, Text, Block, Raum, PDF-Export, Schnitt/Ansicht ohne UI-Test; `globalSetup`/`loadEngine3d` brechen bei `pkg3d` ohne Feature `web` mit Bauhinweis ab (`npm run build:engine3d`). · M
- ◐ **[C10]** Kleinigkeiten: Log-Rotation über `RUST_LOG`, isoliertes Profil per Umgebungsvariable. · S
- ○ **[55]** `IDEAS.md`. · S

## Kern und Leistung

- ◐ **[179]** Leistung messen und gezielt optimieren (11.11., `bench159`, Musterhaus komplex). Offen: kalter Schatten ~32 ms; kleine Änderung baut die übrigen Domänen noch voll (kein Teil-Cache je Domäne); Mac nicht gemessen. · M
- ◐ **[58]** Inkrementelle Ableitung. Offen: 3D ist inkrementell; Schnitt/Ansicht (~100 ms) und Plan-Szene (`planToRenderScene` ~30 ms) noch voll; Gehrung über alle Wände je Update (~9 ms); Explosion ohne Cache; Upload/Frame mit echter GPU nicht gemessen. · L
- ◐ **[159]** Leistung nach den Darstellungs-Änderungen. Offen: Gelände-Schatten 30–35 ms (Cache je Werfer denkbar); Höhenlinien-Primitive kopieren 6–19 ms; Schnitt/Ansicht nativ 2–4× langsamer als am 31.10. (nicht untersucht); nicht auf macOS gemessen. · M
- ◐ **[20]** Performance-Benchmark (`dossier-cli … bench`). Offen: Messung auf macOS, Verlauf in CI, Plan/3D-Messung mehrerer Geschosse. · M
- ○ **[15]** Kostenbudget: Zeit-/Schrittbudget je WASM-Geometrie-Operation, Booleans im Worker. · M
- ◐ **[7]** Zentrale Validierung nach jedem Befehl (`ops.rs`). Offen: weitere Regeln (Bezüge, Geometrie). · M
- ◐ **[14]** „Never crash“. Offen: Wächter für render3d/render2d/Kern; Lints `unwrap_used`/`expect_used`/`panic` auf `deny`; Obergrenzen; Hülle (Panels/Editoren) nicht gefuzzt. · M
- ◐ **[118]** Wiederanlauf nach Kern-Panic (`device_health.rs`, `engine/gpuRecovery.ts`, `gpuRendererSlot.ts`). Offen: erneutes Undo trifft denselben Schritt; Pathtracer-Test [212] headless übersprungen; Wettlauf „Gerät tot, `device.lost` noch nicht gemeldet“ fängt nur `guardRenderer`; nicht in WKWebView/auf dem Mac mit echtem Geräteverlust geprüft (`doc/RELEASE-1.0.md`, „Nur auf dem Mac“). · M
- ◐ **[3]** Darstellungswege reduzieren (vier 2D-Pfade: render2d, glPlan, SVG, native2d; zwei 3D-Pfade). · L
- ◐ **[17]** Ergebnisse über die Ausgabe testen. Offen: Golden-Ausgaben für 3D fehlen. · M
- ◐ **[19]** Beispielgebäude als Skript: `sampleProject.ts` + Kontrollmodell. · S
- ○ **[C5]** Copy-on-Write-Elementspeicher für billiges Undo (Vorlage für das Modell in Rust). · M
- ○ **[C7]** Text in Rust (Layout, OpenType-Shaping, Unicode-Bidi), wenn `text/` nach Rust wandert. · M

## Infrastruktur

- ◐ **[120]** macOS in CI (`.github/workflows/macos.yml`). Offen: Bildvergleich Metal ↔ WebGPU (gleiche Szene per `render2d::headless` und Chromium, Pixeltoleranz aus `tests/golden.rs`); Golden-Bilder für 3D in der CI ([R1]). · M
- ◐ **[30]** Release-Workflow (`release.yml`; `npm run release:gitea`, Pakete als Entwurf auf Gitea). Offen: Secret `GITEA_TOKEN` in GitHub setzen, erster Tag-Lauf, Updater-Signaturschlüssel; Workflow nicht auf GitHub gelaufen (nur `--dry-run` im Container); Zielbild [C8]: macOS universal signiert/notarisiert, Windows MSI, Linux AppImage/Flatpak/deb/rpm, `SHA256SUMS.txt`. · M
- ◐ **[170]** Linux-Paket (AppImage x86_64 mit electron-builder, ab 1.0 offiziell; `npm run test:linux-app`, `doc/RELEASE-1.0.md` Abschnitt 15). Offen: echte GPU/Wayland, GTK-Dialoge von Hand, Sandbox als normaler Benutzer, Flatpak (`packaging/linux/ch.dossier.cad.yml`) nie gebaut, deb/rpm; Workflow nicht auf GitHub gelaufen. · M
- ◐ **[57]** Tests bei jedem Push (`check.yml`). Offen: nicht auf GitHub gelaufen; `exportIfc.fachplaner.test.ts` (komplex/Erker) meldet lokal `NetVolume 7.5 ≠ Geometrie 30.4` an Wand #3971 — klären, bevor CI es sieht; Debug-Überlauf in `roof.rs:664`/`web/geo_mesh.rs:65` ggf. mit `wrapping_mul` entschärfen. · S
- ○ **[C6]** `cargo xtask ci`: Formatierung, Clippy, Tests, Crate-Schichtung, Asset-Herkunft, WASM-Build in einem Befehl. · M
- ◐ **[C9]** Ehrliche Paritäts-Doku `doc/DATEIFORMATE.md` (12.11.; Test `src/export/dateiformateDoku.test.ts`). Offen: Rundreisen in Fremdsoftware (AutoCAD, Revit, ArchiCAD, Acrobat) ungeprüft; mit „ungeprüft“ markierte Zeilen (Layer-Zustände im DXF-Import, PDF-Schriften, Stifte im PDF, OSM-Lizenzhinweis) nachlesen. · S

## Mac-Gegenprobe (Sammelpunkt)

Auf dem Mac (Tauri/Metal) noch nicht angesehen oder geprüft; bisher nur Linux-Container, CLI-SVG, Chromium oder
Unit-Tests: [116] (atomares Speichern), [117] (CSP unter `tauri://`), [118], [122], [123], [126], [110], [101],
[102], [131], [133], [136], [140], [145], [194], [146], [153], [64], [T2], [T4], [34], [108], [65], [169], [113], [181], [G1], [214], [209], [210], [266], [277] (Rendering-Fenster: Fenster öffnen/nach vorne, Fortschritt, Schliessen mit Rückfrage, Lage merken, Bild speichern/ins Layout). Je Punkt ansehen, dann hier und
im jeweiligen Eintrag streichen. · M (gesamt)

---

## Erledigt

Einzeilig mit ID, Titel, Datum (2026); Langfassungen und Reste im Archiv (`doc/archiv/TODO-bis-2026-11-08.md`, „Nachträge bis 18.11.2026“). Kleine Reste erledigter Punkte (z. B. [T7] Achse beliebig im Raum, [T8]
exakte Durchdringung, [61] Zuordnung per Hand, [63] Profil je Kante, [70] Flächentabelle als Layout-Element,
[80] Einzelplan-PDF ohne Ebenen, [82] Legende per Ziehen) stehen im Archiv beim jeweiligen Eintrag.

- [282] PDF-Ebenen: Wände im Erdgeschoss-Viewport; Präsentationsplan, der nicht aufs Blatt passt (18.11.)
- [277] Rendering als eigenes Fenster (17.11.; Rest: Mac-Gegenprobe, Theme-Wechsel bei offenem Fenster)
- [273] Temp-Ordner-Leck (17.11.; Rest: Rust-Tests in `blender.rs` und Skripte unter `scripts/` räumen nicht überall auf)
- [267] Ansichten aller Seiten in einem Schritt, Befehl `ansichten` (16.11.; Rest: Nordwinkel im Projekt)
- [265] „Vorschau“-Kennzeichnung unfertiger Funktionen (16.11.)
- [264] Sprachumschalter und Standards in der UI-Sprache (16.11.; Rest: Baustoff-Kürzel deutsch, `libobj_ops`-Klasse deutsch)
- [252] Englisch „Geschoss“ = floor, Tab = Befehlszeile, Ctrl+Tab Ansichts-Reiter (14.11.)
- [244] Darstellungsarten-Menü im 3D übersichtlicher (13.11.)
- [245] Begehen wie im Architektur-Walkthrough: Kollision, Bodenfolge, Geist-Modus (13.11.)
- [246] Kamerafahrt durch die Kameras (13.11.)
- [248] Kurzanleitung: Begehen, Kamerafahrt, Darstellungsarten-Menü (13.11.)
- [249] Tastatur und Fokus in neuen Dialogen und Leisten, `ui/modalFocus.ts` (13.11.)
- [250] Ältere Overlay-Dialoge auf die Fokus-Hülle aus [249] (13.11.)
- [251] Enter in Dialogen mit `window`-Listener (14.11.)
- [247] Kurzanleitung passt zur App, Test `kurzanleitung.test.ts` (13.11.)
- [243] Qualität der neuen UI-Texte seit 12.11. (13.11.)
- [240] 3D-Viewport: Knöpfe und Anzeigen schöner, `ViewportToolbar3d.tsx` (13.11.)
- [242] Doku nachgeführt: render3d-README, Crate-Tabellen (13.11.)
- [217] Kern-Panics aus dem Robustheitstest (12.11.)
- [222] Volumenstudie → Bauteile, Befehl `solidtoparts` (13.11.)
- [229] Cycles-Rendering: Streifen/Dreiecke auf der Hauptdachfläche (12.11.)
- [239] Objekt-Info mit einklappbaren Abschnitten durchgängig (13.11.)
- [241] Objekt-Info Gelände/Kontextobjekte, Kamera, Baum im Raster der übrigen Gruppen (13.11.)
- [235] `update-dossier` brach nach der Commit-Liste stumm ab (13.11.)
- [230] Sonnenschatten im Grundriss mit weissen Löchern (13.11.)
- [231] Fenster im Giebel in 3D sauber eingeschnitten (13.11.)
- [232] 3D: Netzlinien auf den Dachflächen (13.11.)
- [233] 3D: Oberflächenmuster ragen über Dachrand und Traufe (13.11.)
- [210] Kurzanleitung und Wettbewerbs-Beispiel (13.11.)
- [209] Kostenschätzung grob nach eBKP-H (12.11.)
- [185] Navigation wie Archicad: Geschosswechsel behält den Ausschnitt, Cmd+5/6, Cmd+3/4 (12.11.; Rest siehe oben)
- [195] Objekt-Einstellungsfenster, Taste T (12.11.; Weiterführung [195b])
- [197] Cmd+3/4: Kamera bleibt stehen, Öffnungen folgen ihrem Wirt (12.11.)
- [196] Raster-Bodenschraffur im EG und weitere Befunde (12.11.)
- [203] Geschoss-Grundriss zeigt nur sein Geschoss (12.11.)
- [188] Wand am Anfang kürzen/verlängern: Öffnungen bleiben stehen (12.11.)
- [183] Elemente-Panel: Dachfenster/Deckenöffnungen ohne Wirtswand (12.11.)
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
- [162] Grosse Rust-Dateien geteilt (`plan/section/`, `model3d/`; 9.11.) · [164] `kernel2d/src/lib.rs` → 9 Module,
  `fileio/src/ifc_export.rs` → `ifc_export/` (9.11.) · [163] `App.tsx` weiter zerlegt (9.11.) ·
  [165] `PlanView.tsx`, `plan/elevation/`, `ObjectInfoPanel.tsx` geteilt (9.11.)
- Gestrichen als überholt oder Regel: [24] Test first, [60] Nur versprechen, was getestet ist (jetzt Regel in
  `CLAUDE.md`), [B6] Wand unter Dach (analytisch gelöst in [G2]), [B7] Dach-Verschneidung (per Booleans in [G5]),
  [C3] (in [9]), [C8] (in [30]), [21] (in [160]), [R2] (in [46]).
- [150] Gelände im Grundriss am Gebäude: Raumstempel als Hindernis der Höhenlinien-Beschriftungen (11.11.)
- [T3] Handlauf-Profil im Modell, `Stair.railProfile` (11.11.; Rest: Profil am Treppentyp, Stäbe der Absturzsicherung bleiben rund)
- [189] Panels neu ordnen + Einstellungsdialog (12.11.)
- [192] Ebenen schnell schalten per Rechtsklick (11.11.)
- [51] Herkunft übernommenen Codes, `NOTICE` (12.11.)
- [223] 3D-Bild für die Abgabe, Befehl `bild3d` (13.11.)
- [224] Präsentationsplan für den Wettbewerb (13.11.)
- [221] LV95-Projekte: Modell lokal um einen Projekt-Nullpunkt (12.11.)
- [225] Kennzahlenleiste = Flächentabelle (12.11.)
- [237] Sichtprüfung der Oberflächen im Browser (13.11.)
- [238] Sichtprüfung, grössere Befunde aus [237] (13.11.)
- [297] Deckenloch für Wendel-/Teilhöhen-Treppen und Innenhöfe im GV (19.11., Bild `doc/review-297/wendel.png`)
- [298] Wendel: Lauflinie als Bogen statt Sehnenzug, Pfeil tangential (19.11., `plan/stair_symbol.rs` `arc_run_line`, Bild `doc/review-298/`; Goldens komplex UG/EG nachgeführt; Mac nicht geprüft)
- [299] Situationsplan: Nordpfeil/Massstab dicht unter Haus ∪ Parzelle statt unter dem fernsten Kontext (`plan/situation.rs` `symbol_prims`; Kontext nur ohne Haus/Parzelle), Kataster-Gebäude, die > 1 m² unter dem eigenen Fussabdruck liegen, entfallen (`cadastre_prims`; Kontext-Netze unverändert, Mac nicht geprüft; Bild `doc/review-299/`)
- [284] Review der Stränge seit `9f32c71f` auf echte Fehler vor der Beta (18.11.; Rest: nicht in der Tauri-App geprüft)
- [306] TODO.md auf die Regeln gekürzt, ungekürzter Stand im Archiv `doc/archiv/TODO-bis-2026-11-20.md` (20.11.)
