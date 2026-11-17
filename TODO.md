# Dossier — Arbeitsliste

Stand 17.11.2026. Die vollständige bisherige Liste mit allen Details, Messwerten und Befunden steht
unverändert in [`doc/archiv/TODO-bis-2026-11-08.md`](doc/archiv/TODO-bis-2026-11-08.md) (rund 4500 Zeilen).
Wer zu einer ID mehr wissen will (Entscheide, Tests, Bilder), sucht dort nach `**[ID]`.

## Regeln

- **Stand:** ◐ teilweise · ○ offen. Erledigtes steht nur in der Liste „Erledigt“ am Ende. Abgelehnte Ideen
  stehen im Archiv („Bewusst nicht übernommen“).
- **Grösse** (eine Person mit Agenten): S ≤ 1 Tag · M ≤ 1 Woche · L ≤ 1 Monat · XL > 1 Monat.
  Steht keine Grösse im Archiv, ist sie hier geschätzt.
- **IDs sind stabil.** Neue ID = nächste freie Zahl nach der höchsten im Archiv und hier (aktuell 272);
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

- ◐ **[266]** Wettbewerb einmal ganz durchgespielt und das Ergebnis fachlich beurteilt (16.11.): eigenes Projekt im Browser-Build (Chromium/Linux, 1440×900, Playwright über Befehlszeile): Kataster-DXF, Parzelle 1003 mit AZ 0.5/ÜZ 0.3/Höhen, Einfamilienhaus 12 × 10 m (Achsen), 2 Geschosse à 2.60 m, Aussenwand 34.5 cm, Innenwände 15 cm, Treppe mit Deckenloch, 23 Fenster/Türen, Satteldach 30°, 9 Räume, Raumprogramm-CSV, Schnitt B, Ansichten Nord/Ost/West, Massstab 1:200, Kennzahlen, Kosten, Plakat A1 hoch anonym „FALKE 7“ als PDF, DXF, IFC. Pläne als CLI-SVG `--hatch` und PDF-Seiten (`pdftoppm`) angesehen, Flächen von Hand nachgerechnet; Bilder `doc/review-266/`. **Behoben 16.11.:** (1) Raum umbenennen (Objekt-Info) änderte den Stempel nicht, im Plan stand „Raum 1…9“: der Befehl `raum` legt den Stempel als Kopie des Namens an, er folgt jetzt dem Namen, solange er nur den alten Namen trägt (`elementAttributesHost.ts`, Test dort); (2) **Flächen SIA 416 falsch bei verschiedenen Wanddicken:** der lichte Raum wurde um die *mittlere* Dicke aller Wände versetzt (hier 13 cm statt 17.25 bzw. 7.5 cm), Räume ragten in die Aussenwand, an Innenwänden blieben Spalten: GF 125.10 statt 127.71 m² je Geschoss (= 12.345 × 10.345, −2 %), NGF 108.12 statt 108.99 m². Jetzt je Kante die halbe Dicke der eigenen Wand, Absatz bei Wänden verschiedener Dicke in einer Flucht (`kernel2d/src/rooms.rs`, Tests in `kernel2d/src/tests.rs`; Goldens Musterhaus komplex Grundrisse: Raumränder/Bodenbelag an den echten Wandflächen); (3) Präsentationsplan: Geschosse nur mit Bauteilen galten als „(leer)“ (Prüfung kannte nur `levelId`, Bauteile tragen `floorId`) und wurden nicht vorgewählt — das Plakat hatte keine Grundrisse (`levelHasContent`); (4) Plakat-Situation 1:500 zeigte nach dem Kataster-Import mit den Vorgaben (neue Zeichnungsebene) nur Parzelle und Gebäude ohne Nachbarn/Strassen: sie nimmt jetzt die freie Zeichnungsebene, deren Inhalt das Gebäude umgibt (`situationLevelId` in `presentationSheet.ts`); (5) „Auf Plan einpassen“/Zoom/Massstab der Oberleiste waren ausserhalb des Geschoss-Grundrisses gesperrt (Kataster-Zeichnung direkt nach dem Import, Schnitt, Ansicht), obwohl dort eine Plan-Ansicht läuft (`planViewMounted` in `state/planViewport.ts`). Tests: vitest `presentationSheet.test.ts`, `elementAttributesHost.test.ts`, `planViewport.test.ts`; Rust kernel2d (55) und Kern (1768) grün. **Offen (nach Wichtigkeit, Befund · wo · Vorschlag · Grösse):**
  1. ~~**GV ohne Dachraum:** GV = GF × Geschosshöhe (664 m³), das Satteldach (≈ 12.3 × 10.3 m, 3.1 m hoch ≈ 200 m³) fehlt → GV, BMZ und Kosten je m³ GV ≈ 23 % zu tief · Kern `flaechen.rs` `area_table` (`gv = gf * height`) · GV aus dem Hüllkörper des 3D-Modells (Manifold-Volumen über ±0.00) oder Dachkörper über dem obersten Geschoss addieren · M.~~ **Erledigt 16.11.:** GV nach SIA 416 (Hülle bis Oberkante Dach, ohne Dachvorsprünge/Vordächer/Brüstungen) = je Geschoss GF × Geschosshöhe plus Dachraum-Korrektur aus Manifold-Körpern (neu `core/building_volume.rs`, Abgrenzung im Modulkopf): Raum unter den Dachflächen (obere Hülle mehrerer Dächer, Gauben über ihrem Loch) über Dachumriss ∩ Geschossgrundriss, Teile eines Kniestock-Geschosses über der Dachfläche abgezogen; Dächer über offenen Flächen (Carport) zählen nicht. Neue Felder `roofGv` je Zeile und `roofGvAboveGround` (Baumasse/BMZ); Summenzeile = GV der Tabelle, also Kennzahlenleiste, Kosten CHF/m³, Baurecht-Nachweis, CSV/PDF, Blatt-Tabelle und IFC (`Qto_*`/`CH_Qto_SIA416`) mit demselben Wert. Dabei: freie Körper sind das GV nur noch im reinen Massenmodell (ohne Geschossflächen) — im Musterhaus komplex machten Brunnen/Loft/Rotationskörper im Garten das GV zu 4.1 m³. Zahlen (CLI `kennzahlen --sia416`): Demo-Haus 74.7 → 89.0 m³ (Dachraum 14.2), Musterhaus komplex 4.1 (Körper) → 2’336.4 m³ (Geschosse 1’993.3 + Dachraum 343.1: Hauptdach/DG 219.5, Anbau/OG 123.6), Wettbewerb (Flachdach) unverändert 2’273.7 m³. Tests: Rust `building_volume::tests` (Quader+Flachdach exakt, Sattel/Walm/Pult/Kniestock von Hand, UG nicht in der Baumasse, Carport/Überstand, Gaube, doppeltes Dach, Unsinn, Musterhaus komplex von Hand plausibilisiert, Fixture `tests/fixtures/gv_musterhaus_komplex.json`), `flaechen` (kleine Körper ersetzen das Gebäude nicht), vitest `kennzahlen.test.ts`. Offen: Studienkörper als Anbau NEBEN einem Haus aus Wänden zählen nicht mit (Entscheid Koordinator 16.11., vorläufig; besser später: Körper ausserhalb der Gebäudehülle addieren); Bodenplatte unter dem untersten Geschoss fehlt weiter (Geschosshöhen OK–OK); Innenhöfe ohne Dach werden im Dachraum-Grundriss gefüllt; das [266]-Durchlaufprojekt selbst nicht neu gerechnet (nicht im Repo).
  2. ~~**Plakat A1 halb leer**~~ **behoben 16.11.:** der Kern verteilt freien Platz am Fuss eines Blatts gleichmässig als Weissraum vor, zwischen und nach den Zeilen (je Lücke höchstens 12 % der Satzspiegelhöhe, Zeilen mit Tabellen/Bild rücken gemeinsam; `presentation_poster.rs::spread`), und das 3D-Bild ist höchstens so gross wie der grösste Grundriss (Höhe, Breite ≥ 4:3, rechtsbündig neben der Situation; `Grid::image_max`); Massstab bleibt fest, Überlauf ⇒ zweites Plakat. Test: Rust `presentation_poster` (`bild_hoechstens_so_gross_wie_der_plan`, `leerer_fuss_wird_gleichmaessig_verteilt`), vitest `presentationSheet.test.ts`. **Offen:** ein sehr kleines Haus bei 1:200 lässt das Plakat trotzdem weit leer (Lücken gedeckelt, Plan klein), ein Massstab-Vorschlag 1:100 bei kleinen Häusern fehlt; Tabellen wandern auf ein zweites Blatt, wenn rechts neben der letzten Zeile die Höhe fehlt, obwohl weiter oben Spalten frei sind.
  3. ~~**Keine Schnittmarken in den Plakat-Grundrissen**~~ **behoben 16.11.:** zeigt das Plakat Schnitte oder Ansichten, blendet der Präsentationsplan die Klasse „91 Schnittmarken“ in den Grundrissen ein, und der Ausschnitt reicht bis zu den Linien der gewählten Schnitte/Ansichten samt Marke (höchstens 40 mm Papier über das Haus hinaus; Kern `marks_box`, Anfrage `marks`). **Offen:** Marken ungewählter Schnitte erscheinen mit (der Plan kennt keine Marken je Viewport); beim gewöhnlichen Blatt ohne Plakat bleiben die Marken aus (kein Hausausschnitt, weit entfernte Marken würden die Pläne aufblähen); Linien weiter als 40 mm Papier (8 m bei 1:200) vom Haus werden beschnitten, dafür wächst das Plakat bei weit entfernten Ansichtslinien (Beispiel Wettbewerb: 2 Blätter statt 1).
  4. ~~**Nur ein Schnitt aufs Plakat**~~ **behoben 16.11.:** `PresentationOptions.sectionIds`, im Dialog Haken je Schnitt mit eigenem Massstab (vorgewählt alle).
  5. ~~**Grundrisse 1:200 ohne Masse**~~ **behoben 16.11.:** Option `autoDim` (Dialog „Aussenbemassung der Grundrisse ergänzen“, Vorgabe an): für jedes gezeigte Geschoss ohne `autodim-<Ebene>-…`-Ketten legt der Präsentationsplan die Aussenbemassung an (derselbe Kern-Befehl wie `autodim`, Klasse 81, im Massstab des Blatts); vorhandene Ketten bleiben. Kurzanleitung Abschnitt 10 und RELEASE-1.0 13.18 nennen den Weg. **Offen:** die Plakat-Grundrisse zeigen alle Ketten (Öffnungen, Vor-/Rücksprünge, Gesamtmass), nicht nur das Gesamtmass der Modelldarstellung „Wettbewerb 1:200“ (die Vorlage „Präsentation“ bindet keine Modelldarstellung).
  6. ~~**Situation: Nordpfeil und Massstabsbalken auf Parzelle/Strasse**~~ **behoben 16.11. (Plakat):** die Situation des Plakats blendet die Klasse „84 Planzeichen“ aus, Nordpfeil und Massstabsbalken stehen am Rahmenrand im Band unter dem Plan (wie beim ersten Grundriss; bei schmalem Rahmen steht der Pfeil in der oberen rechten Ecke), der Platzhalter des 3D-Bilds passt seine Schrift dem Rahmen an. **Offen:** eigenständige Situations-Layouts (Vorlage „Situation WBW“ ohne Plakat) setzen die Zeichen weiter unter die Lage; Kataster-Gebäude unter dem eigenen Fussabdruck (Bestandsbau 1003) werden nicht ausgeblendet.
  7. ~~**Ansichtslinien heissen „Ansicht B/C/D“**~~ **behoben 16.11.:** neue Ansichten heissen nach der Gebäudeseite („Ansicht Süd“: Linie südlich des Hauses, Blick nach Norden, Plan oben = Norden; wie die Beispielprojekte), bei gleicher Richtung „… 2“; Kern `cmd_solid.rs::elevation_side`/`elevation_name`, Namen über `t()` (`cmd.sectionline.dir.*`). Der Befehl `ansichten` in einem anderen Branch soll `elevation_side` mitbenutzen. **Offen:** Marken überlagern sich weiter (Punkt 8).
  8. ~~**Marken überlagern sich im Grundriss:** Ansichtsmarke „Süd“ auf der Schnittmarke B, Ansichtsmarke Nord auf dem anderen Ende von Schnitt B · Kern Planmarken (`plan/`) · Marken gegeneinander ausweichen lassen · S.~~ **Behoben 17.11. ([270]).**
  9. ~~**Treppe ohne Deckenloch** läuft im Schnitt in die Decke, ohne Hinweis; das Loch muss von Hand (`deckenloch`, zwei Gegenecken) gesetzt werden · `cmds/stair.ts`, Kern `stair_guard` · beim Setzen einer Treppe unter einer Decke Aussparung anlegen oder anbieten · S–M.~~ **Erledigt 16.11.:** `stair_hole_ops` (`cmd_solid.rs`) legt im selben Commit wie die Treppe (ein Undo-Schritt) eine Aussparung in der Form des Treppenumrisses in die Decke des Geschosses, wenn die Treppe aufwärts über die volle Geschosshöhe läuft, der Umriss ganz in der Decke liegt und dort noch kein Loch ist; Test `treppe_legt_deckenloch_an` (`cmd_create.rs`). Offen: Wendeltreppen (Umriss aus Linien/Bögen) behalten das Loch von Hand (`deckenloch`); Treppen nach unten und mit Teilhöhe bekommen keins.
  10. ~~**Neues Projekt: Geschosshöhe 2.60 m, Decke 30 cm → lichte Höhe 2.30 m** (unter den üblichen 2.40 m für Wohnräume) · Vorlage des leeren Projekts · Vorgabe 2.90–3.00 m · S.~~ **Erledigt 16.11.:** Vorgabe 2.90 m (CH-Wohnbau 2.80–3.00 m; bei 30 cm Decke 2.60 m lichte Höhe, ≥ 2.40 m), `EMPTY_FLOOR_HEIGHT` in `sampleProject.ts` für `emptyProject` und „Geschoss hinzufügen“; Beispielprojekte bleiben 2.60 m. Test `emptyProjectHeight.test.ts`.
  11. ~~**Projektname nicht änderbar** (im Browser-Build kein Feld gefunden; bleibt „Leeres Projekt“ in Dateinamen nicht anonymer Exporte und im Kennzahlen-/Kosten-PDF) · Panel Mappe (neben „Projektnummer“) · Feld „Projektname“ · S.~~ **Erledigt 16.11.:** Feld „Projektname“ im Abschnitt Publikation (Panel Mappe, über „Projektnummer“), übernommen bei Enter/Verlassen, über Ops (`onSetProjectName`, ein Undo-Schritt, leer = unverändert). Test `projectName.test.ts`, e2e `projectName266.spec.ts` (Screenshot angesehen).
  12. ~~**3D-Bild nicht prüfbar**~~ **behoben 16.11. (3D-Dokument):** Kern `plan/axo.rs` zeichnet das Modell aus einer beliebigen Kamera als Vektorzeichnung mit verdeckten Kanten (Archicad „3D-Dokument“): Flächen wie die Projektion des Schnitts (`section::model_view_faces`, aus `projection_edges` herausgelöst), exakte Sichtbarkeit `hlr.rs`, Silhouette (Kante gegen den Hintergrund) 0.35 mm, Kanten 0.18 mm, verdeckte gestrichelt auf Wunsch, Flächen nach Lage zum Licht hellgrau (`hlr_fill.rs`, Vorauswahl über ein Tiefenraster 1200 Zellen, sonst 4 s statt 0.2 s). Parallel (Isometrie, Kamera-Parallelprojektion, Militär 45°/45° und 30°/60° als schiefe Projektion mit Normalen über M⁻ᵀ) und Perspektive (Nahebene/Bildrahmen zugeschnitten, projektiv, Ebenen bleiben eben). Abfrage `axoPlan` (Kamera `camera`, Kamera-Element `cameraId` [213], Vorgabe `view` southeast/southwest/northeast/northwest oder `View3d`), Budget 400 000 Flächen / 30 000 getönte; Klassen der Bauteile ([180]). Modell: `ViewSnapshot.doc3d` (Kamera, Projektion, verdeckte Kanten, Tönung, Kontext); jeder 3D-Ausschnitt (Ansichtstyp „perspektive“) zeigt auf dem Blatt, im PDF und Kern-Viewport (`sheet_viewports::doc3d_buf`) diese Zeichnung; *Ansicht → 3D-Dokument erstellen* legt aus der Kamera der 3D-Ansicht Ausschnitt + Blatt A3 an (`state/doc3dAction.ts`); Präsentationsplan setzt die Axonometrie Südost in den Bild-Rahmen, wenn kein Layout-Bild da ist (`posterAxo`, Platzhalter nur noch, wenn auch sie scheitert); CLI `axo` (SVG/JSON/DXF). Musterhaus komplex: 13 900 Flächen, 0.45 s nativ, 0.7–1.1 s CLI/WASM. Tests: Rust `plan/axo_tests.rs` (Würfel 9 Kanten/6 Umriss in allen vier Isometrien, verdeckter Würfel, Militär unverzerrt, Kamera Parallel/Perspektive/Kamera-Element, Satteldach First/Traufe, leeres Projekt/NaN/1e300, Klassen, Blatt-Ausschnitt), `robustness_web` (Eintrag `axoPlan`), vitest `toAxo.test.ts`, `doc3dAction.test.ts`, `presentationSheet.test.ts`, Golden `muster-axo-southeast`. **Offen:** nicht auf dem Mac geprüft (passt die Zeichnung zur Kamera im 3D-Fenster? Achsen/Spiegelung: das 3D-Fenster bildet Bauteile auf Welt (x, Höhe, y) ab); kein eigener Reiter fürs 3D-Dokument (nur Blatt-Viewport); Live-Schnitt/Schnittkörper des 3D-Fensters nicht übernommen; Fenster als Löcher ohne Rahmen/Glas; verdeckte Kanten nur verdeckter zugewandter Flächen (keine Rückseiten); Gelände-Element nicht, Kontext-Netze nur mit `context`; Flächen unter 1/1200 Bildbreite ungetönt; Snapshot „Axonometrie Südost“ des Musterhauses komplex nutzt `isoFrontLeft` (= von Nordwest gemäss Kamera-Abbildung).
  13. ~~**Getippte LV95-Koordinaten** hinterlassen Gleitkomma-Reste im Modell (Deckenloch bei 53.200000000186) · Umrechnung LV95 → lokal in der Befehlszeile · auf 1e-6 m runden · S.~~ **Erledigt 16.11.:** `fromWorldInput` rundet auf mm (`parseInput.ts`, Test dort).
  14. ~~**IFC-Räume ohne Nummer:** `IfcSpace.Name` = interne Id („RM-…“), Name in `LongName`; die Objekt-Info hat kein Feld „Nummer“ für Räume aus `raum` · Kern IFC-Export, Objekt-Info Raum · Nummernfeld, `Name` = Nummer · S.~~ **Erledigt 16.11.:** `Name` = Raumnummer (Stempel), sonst Raumname statt interner Id; `LongName` = Raumname (`ifc_data.rs`, Test `exportIfc.test.ts`). Die Objekt-Info hat das Feld „Nummer“ schon (Raumstempel-Abschnitt).
  15. ~~**Auto-Linie „Schnitt A“ liegt auf der Achse der OG-Innenwand** (y = 51) und schneidet sie der Länge nach (schwarze Fläche im Schnitt) · Kern Auto-Schnittlinie (`autoLine`) · Wandachsen meiden · S.~~ **Erledigt 16.11.:** `auto_lines::place` weicht Wandachsen aus (parallele Achsen < 0.5 m → in 0.25-m-Schritten zur Seite, nächster freier Platz); Test `schnitt_meidet_wandachsen`.
  Geprüft und in Ordnung: Anonymität (Plakat-PDF Titel „FALKE 7“, Producer leer, Datum 2000, Schriften eingebettet, `pdftotext` ohne Projekt-/Büronamen; Kennzahlen-PDF nach „anonym“ ebenso; DXF/IFC ohne Projektnamen), Ansichten/Schnitt stimmig zum Grundriss (Fensterlagen nachgemessen), Kennzahlen-Tabelle Plakat = Flächenbilanz, ÜZ 127.71/900, Kosten 2’844 CHF/m² GF plausibel (mit Befund 1), IFC mit Georeferenz LV95 (IfcMapConversion). **Nicht geprüft:** Tauri-App/Mac (Metal, 3D-Bild, Schatten, Rendering), Mausbedienung (alles über Befehlszeile und Test-Naht), Druck des A1-Plakats, DXF/IFC in Fremdsoftware. · M (Reste)

- ◐ **[270]** Blickrichtungen überall gleich, Marken weichen aus (17.11.). **Befund:** das 3D-Fenster (render3d, Browser und Metal) zeigte das Modell **gespiegelt**: Bauteile liegen in der Welt (x, Höhe, y), ein Achsentausch (Determinante −1), und `look_at` ist rechtshändig — von Süden gesehen lag der Erker im Osten links, die Draufsicht stand kopfüber (Süden oben). Gelände, Importe/Verbau und Punktwolken negierten y (Fix 24.9. „swisstopo gespiegelt“) und lagen damit an y = 0 gespiegelt unter dem Haus. Vektor-Axonometrie, Cycles, Blender, glTF/OBJ und die Ansichten Nord/Ost/Süd/West waren seitenrichtig, aber die Namen widersprachen sich: `iso` = von Nordost (3D, Axo-Alias), von Südwest (Cycles/Blender); `front` = von Norden (3D, Axo) bzw. Süden (Cycles); „Axonometrie Südost“ im Musterhaus komplex stand auf `isoFrontLeft`. **Behoben:** eine Tabelle `render3d/src/view_dir.rs` für 3D-Presets (`math::preset_camera`), Axonometrie (`plan/axo.rs::preset`), Cycles (`cycles_scene.rs::preset`, CLI `render --view` nimmt auch `southeast` …), Blender-Skript (Kopie, per vitest geprüft): vorne = Süden, rechts = Osten, `iso` = Südost, `isoFrontLeft` = Südwest, `isoBackRight` = Nordost, `isoBackLeft` = Nordwest, `top` mit Norden oben; Beschriftungen „Isometrie Südost“, „Südwest“ … Die Spiegelung gleicht die Kamera an einer Stelle aus (`math::view_matrix`: Bild-rechts = oben × Blick; Culling `FrontFace::Cw`; Pathtracer-Strahlen; TS `screenRight`/`orbitRight` für Pick-Strahl, Griffe, Pan, Zoom zum Cursor, Begehen, Orbit-Richtung); Gelände/Import/Punktwolke/Luftbild ohne y-Negation. Ausschnitt „Axonometrie Südost“ → `iso`. **Marken ([266]/8):** Ansichtsmarken werden nach den Schnitten gesetzt und weichen Schnittlinien, -pfeilen und anderen Ansichtsmarken aus (zusätzlich seitlich entlang ihrer Linie, bis 15 mm; `plan/context.rs::view_marker`); Schnittpfeile sind Hindernis für Beschriftungen. Tests: Rust render3d `kamera_zeigt_modell_seitenrichtig` (vorher rot), `aussenflaechen_erscheinen_im_uhrzeigersinn`, `view_dir::tests`; Kern `axo::testhaus_seitenrichtig_in_allen_vorgaben`, `cycles_scene::voreinstellungen_heissen_wie_im_3d`, `context::ansichtsmarken_weichen_schnittmarken_aus` (vorher rot); vitest `view270.test.ts`, `viewDirections.test.ts`. Bilder und Testhaus (Erker Ost, Garage West, Turm Nordwest; `testhaus.py`) in `doc/review-270/`. **Offen:** 3D-Bild nur numerisch (Kameramatrix, Pick-Strahl) geprüft, kein Bild aus render3d unter Linux, nicht auf dem Mac/Metal (Prüfschritt `doc/RELEASE-1.0.md` 13.36); natives Spike-Fenster `src-tauri/src/native.rs` (Orbit-Richtung) nicht angepasst; gespeicherte Ausschnitte mit `isoBackRight`/`isoFrontLeft` zeigen jetzt die Richtung ihres Namens (keine produktiven Projekte). · M
- ◐ **[271]** Umbaufilter wie Archicad (Wunsch Maintainer 17.11.). **Modell:** `renovation: {status: existing|demolish|new, phase?}` an Wand, Öffnung (ohne eigenen Status folgt sie der Wand), Decke, Dach, Treppe, Stütze, Körper und Raum (Raum nur Sichtbarkeit/Flächen, keine Farbe — kein Bauteil); `Project.renovation` (Etappen, Farben, eigene Filter); `DrawingLevel`/`ViewTemplate`/`ViewSnapshot.renovationFilter`+`renovationPhase` (der Filter gehört zur Ebene wie die Modelldarstellung [173], damit je Reiter/Ausschnitt/Vorlage). **Kern** `renovation.rs` (ein Ort, `doc/ARCHITEKTUR.md` 3.8): Vorgaben Bestand/Abbruch/Neubau/Umbauplan/Endzustand, SIA-400-Farben (Bestand grau, Abbruch gelb gestrichelt, Neu rot, anpassbar), Etappen „bis n“ (Neues früherer Etappen = Bestand, Abbruch früherer weg, spätere Neue fehlen), Öffnung neu in Bestandswand = Abbruch-Stück bzw. zugemauerte Öffnung = Ausfachung (Wand zu, wo die Öffnung ausgeblendet ist). Umbau-Farben bleiben auch in Tusche (Schwarz-Weiss, `extras::KeepColors`); gefüllt werden nur Schnittflächen (Wand, Stütze), Symbole (Fenster, Türflügel, Tritte) nur in Linienfarbe. Angebunden: Grundriss, Schnitt, Ansicht, Vektor-Axo, 3D-Fenster (Filter der aktiven Ebene) und `model3d`, Kennzahlen/Flächen (Zustand Bestand/Endzustand im Panel), DXF (Layer `<Klasse>_Abbruch`/`_Neu`), IFC (`Status` NEW/EXISTING/DEMOLISH im `Pset_*Common`, Etappe in `Dossier_Umbau`). **Bedienung:** Objekt-Info/Objekteinstellungen „Umbau“ + „Etappe“ (Mehrfachauswahl, ein Undo-Schritt), Statusleiste „Umbau: …“ (Zeichen-Status neuer Bauteile, Vorgabe Bestand, Kern `commands::stamp_renovation`; Umbaufilter und Etappe der Ansicht; mit der Pausfolie im Überlauf „⋯“), Befehl `umbau` (B/A/N; die Befehlszeile nimmt getippte Options-Kürzel jetzt auch mit Enter an, `engine.ts`), Ressourcen-Tab „Umbau“ (Etappen, Farben), Vorlage „Beispiel Umbau“ (`model/sampleProjectUmbau.ts`, CLI `:umbau`), CLI `--renovation`/`--phase` (plan, section, elevation, axo, model3d, kennzahlen). Tests: Kern `renovation_tests.rs` (19), Robustheit, vitest `model/renovation.test.ts`, `commands/cmds/renovation.test.ts`, e2e `renovation271.spec.ts` (2× grün, Port 5195; dazu `uxReview263`, `objectSettings`, `modelViews`, `release10`, `editing` grün); Bilder `doc/review-271/` (CLI-SVG `--hatch` in Chromium, App-Screenshot). **Offen:** 3D-Fenster nur im Code angebunden (Kern-Teile per Test geprüft, Bild nicht angesehen: kein render3d unter Linux); Ersatzstücke der Öffnungen nur im Grundriss (Schnitt/Ansicht: Öffnung fehlt bzw. ist da, ohne gelbes/rotes Stück); Linien der Projektion im Schnitt und Öffnungen in der Ansicht ohne Umbau-Farbe; Bogenwände ohne Ersatzstück; Cycles/Blender und Explosionsaxonometrie ohne Filter; Picken im 3D trifft ausgeblendete Bauteile; 2D-Zeichnungen, Bäume (eigener Status [149]) und Bibliotheksobjekte ohne Status; Ansichtsleiste/Werkzeugleiste ohne eigene Filter-Wahl (Statusleiste und Panel Umbau); eigene Filter nur im Modell (keine Bearbeitung in der Oberfläche); Tauri/Mac nicht geprüft (Prüfschritt `doc/RELEASE-1.0.md` 13.37). **Nachtrag 17.11. (Panel):** eigenes Dock-Panel „Umbau“ (`panels/RenovationPanel.tsx`, Reiter rechts oben neben Objekt-Info/Flächenbilanz, Layout v16): Zeichen-Status Bestand/Abbruch/Neu mit SIA-Farbmuster + Etappe, Umbaufilter der aktiven Ansicht als Liste mit Vorschau je Status (wie gezeichnet/ausgeblendet/Umbau-Farbe) + „bis Etappe“, Status der Auswahl (gemischt-Marke) mit Setzen und Etappe (ein Undo-Schritt), „Nach Status wählen“ (Geschoss), Etappenliste (anlegen, umbenennen, Reihenfolge, Löschen mit Rückfrage über `ui/ConfirmDialog`, Verweis auf die Farben in den Ressourcen). Statusleisten-Popover und Objekt-Info teilen Zustand und Aktionen mit dem Panel (`state/renovationHook.ts`, keine Doppelspur) und lesen nur schmale Teile des Projekts: behebt die 45 Renders je Wand-Änderung in `renderCount.spec.ts` (jetzt 42, Grenze unverändert; `RenovationField` ist `memo`). Filter-Vorschau der eingebauten Filter spiegelt `renovation::builtin` in `model/renovation.ts` (vitest prüft gegen den Plan des Kerns; sauberer wäre, die Anteile in `filter_list` mitzuliefern). Tests: vitest `model/renovation.test.ts` (+3), e2e `renovationPanel271.spec.ts` (Port 5193); Bild `doc/review-271/05-panel-umbau.png`. Nicht geprüft: Tauri/Mac. **Offen:** Panel-Bild nur hell/1280×800 angesehen (dunkel ebenfalls ok, schmale Leiste nicht eigens). · M
- ◐ **[269]** Pläne schöner, Befunde aus Screenshots des Koordinators (16.11.; CLI `plan|section|elevation --hatch --template "Eingabeplan 1:100"`, SVG → Chromium; Bilder vorher/nachher `doc/review-269/`). **Behoben 17.11.:** (1) **Ausschnitt mit Parzelle:** das Plan-Ausmass endet bei Parzelle + 5 m (`SITE_MARGIN_M`) vereinigt mit Haus ± Marken-Reichweite und den nicht weitreichenden Zeichnungen (Titel, Massstab, Bemassung; Kataster/Strassen/Höhenlinien/Bäume/Kontext-Klassen zählen nicht, `drawings::is_far_class`); keine Beschneidung im Situationsplan und bei sichtbarem Schatten (`extras::site_clip`, in beiden Puffer-Wegen von `domains.rs`). Wettbewerb EG 1:200: SVG 85 × 54.9 m → 46 × 37.9 m; Musterhaus komplex EG 99 × 63.6 → 55 × 46.6 m. Layout-Viewports/Plakat croppen schon über [208] (`crop`, Haus + 20 mm) und ändern sich praktisch nicht; Einpassen beim Öffnen nutzt `house`. Die Linien ausserhalb bleiben im SVG (werden von der viewBox abgeschnitten), nicht geometrisch gekappt. (2) **Gartenkörper:** Brunnen, Loft, Rotationskörper im Musterhaus komplex lagen auf „20 Wände“, jetzt Klasse „24 Fahrzeuge & Freiflächen“ (`GARDEN_CLASS`) — in Grundriss, Schnitt und Ansicht ausschaltbar. Die Vorlage „Eingabeplan 1:100“ blendet 24 NICHT aus (würde auch Parkfelder/Fahrzeuge im Grundriss ausblenden; fachlicher Entscheid offen für den Maintainer); im Nachher-Bild `--hide …,24`. Der Standard für neue freie Körper bleibt die aktive Klasse. (3) **Dachziegel/Ansichtsschraffur:** Musterlinien in der Ansicht nie enger als 2.5 mm Papier (`PATTERN_MIN_PAPER_MM`, dünnt bei 1:100 und 1:200 gleich aus, vorher 0.7 mm), Standardstärke 0.05 statt 0.1 mm (höchstens 0.09), Vorgabefarbe unverändert. (4) **Hinweistext:** im Beispiel jetzt im Wohnraum über der Hebeschiebetür mit kurzer Führungslinie; Führungslinien setzen vor Masszahlen, Texten und Koten aus (`cut_at_gaps`, mit Wächter gegen Rekursion in der Hindernisberechnung — erste Fassung stürzte im WASM mit Stack-Überlauf ab, im nativen Test nicht); Titel „Erdgeschoss“ und Massstabsbalken rücken ans Haus. Tests: Rust `ausmass_endet_an_parzelle_plus_rand`, `fuehrungslinie_setzt_vor_masszahlen_aus`, `ansichtsschraffur_massstabsgerecht_und_fein`; Goldens `komplex-ansicht-ansicht-sued`, `komplex-grundriss-eg-100/-50` (Hinweis/Titel/Massstab verschoben, Ansichtsschraffur dünner und seltener). **Offen:** Ausschnitt nur Linux/CLI angesehen (nicht in der App/Metal), Beschriftung am Rand (z. B. „Kat.-Nr. 1188“) kann angeschnitten sein; Schnitt/Ansicht-Ausmass nicht beschnitten (Gelände); Eingabeplan-Klasse 24 s. o.; Stossfugen-Muster (Läuferverband) in der Ansicht nicht eigens geprüft. · S
- ◐ **[268]** Review der Änderungen vom 15./16.11. auf echte Fehler vor der Beta (16.11.; [256] [260] [261] [262] [263] [264] [265] [266] [267] [170] [30]). **Behoben 16.11.:** (1) **Datenverlust nach Sprachwechsel** ([264] `LanguageRoot` baut die App neu auf): zuletzt gespeicherter Stand, Pfad, Lock und Autosave-Stand lagen in `useRef` von `useProjectFileActions` und wurden zurückgesetzt — danach galten ungespeicherte Änderungen als gespeichert, Neu/Öffnen/Fenster schliessen verwarfen sie ohne Rückfrage, Cmd+S fragte neu nach dem Pfad, der Lock der offenen Datei blieb liegen; zudem erschien die Autosave-Kopie der laufenden Sitzung als „Ungesicherte Arbeit gefunden“. Jetzt Sitzungszustand ausserhalb von React (`FileSession`), Suche nach Kopien einmal je Seitenladen; e2e `languageSwitch268.spec.ts` (vorher rot, beide Fälle). (2) **Release-Skript** (`scripts/release-gitea.mjs`): jeder Fehler beim Lesen von `versions.json` (Netz, 5xx, Proxy) galt als „leer“ — `--publish` überschrieb den Versionsverlauf mit nur der neuen Version; ein nicht lesbares `SHA256SUMS.txt` der anderen Plattform fiel stillschweigend aus den Prüfsummen. Jetzt nur 404 = leer, sonst Abbruch (`fetchExisting`, `parseSums` in `release-gitea-lib.cjs`, Test `releaseGitea.test.ts`). **Offen (Verdacht ohne Nachweis, Befund · Ort · Szenario · Grösse):** ~~a.~~ **Behoben 16.11. (Electron-Links):** `setWindowOpenHandler` (nie ein Kindfenster; https/mailto → `shell.openExternal`, sonst verwerfen), `will-navigate`/`will-redirect` nur im App-Ursprung (`dossier://app`, Dev-Server `localhost:5187`; fremdes https → System-Browser), CSP in `onHeadersReceived` nur für den App-Ursprung; Entscheide als reine Funktionen in `scripts/electron-links.cjs` (im Paket, `electron-builder.yml`), Test `src/native/electronLinks.test.ts` und e2e `linuxApp170.spec.ts` („Externe Links“: `window.open`/Navigation erzeugen kein Fenster, `shell.openExternal` im Hauptprozess abgefangen; mit gebautem AppImage grün). `openExternalUrl` (Fehler melden, Blender laden) nutzt unter Electron `window.open` und landet damit im System-Browser, keine App-Änderung nötig. Offen: Tauri/Mac unberührt (dort `plugin-shell`), echter Browser-Start nicht geprüft (nur Hook). b. Sprachwechsel setzt weiteren UI-Zustand zurück: Fang-Einstellungen (`useDrawingToolState`, `DEFAULT_SNAP`), aktives Werkzeug, laufender Befehl, Element-Zwischenablage (`useSelectionState`), offene Dialoge ausser Einstellungen · kein Datenverlust, aber z. B. ausgeschalteter Ortho-Fang ist danach wieder an · S. ~~c.~~ **Behoben 16.11.:** `uploadAsset` lädt beim Ersetzen erst unter `<name>.upload-<ms>` hoch, löscht dann den alten Anhang und benennt per PATCH um (`latest.json` fehlt nie; Rest `.upload-…` bei Abbruch in Gitea löschen; gegen echte Gitea-API nicht geprüft, nur `--dry-run`). ~~d.~~ **Behoben 16.11.:** ohne `--publish` auf ein veröffentlichtes Release Abbruch, bewusst mit `--replace-published` (`preflight` in `release-gitea-lib.cjs`, läuft vor dem Anlegen des Entwurfs). ~~e.~~ **Behoben 16.11.:** `--publish` ohne Mac-Pakete (weder im Ordner noch am Release) bricht ab, bewusst nur Linux mit `--linux-only`; Tests `releaseGitea.test.ts`, README „Release auf Gitea“ nachgeführt. **Geprüft ohne Befund:** `elevation_set.rs` (Faltung, Namen, vorhandene Seiten), `kernel2d/src/rooms.rs` (Offset je Kante, NaN), `standards_names.rs`/Standards-Abgleich (kein Duplikat, „Aktualisieren“ hält englische Namen), `stamp_place.rs` `cut_out` (NaN ohne Panic), [262] Offline-Pfade und Host-/CSP-Listen (Overpass, http-Fähigkeit Gitea), [261] `build-number.cjs`, Kurzanleitung (`miniMarkdown` ohne HTML), Dock-Einklappen (`reconcileLayout`), Electron-Argumentdatei (`take-open-file` einmalig). Nicht geprüft: Mac/Tauri, Electron-Paket, GPU-Renderer über mehrere Sprachwechsel (Speicher), [216] Erker und [208] DXF-MTEXT im Detail.
- ◐ **[263]** Visuelle und UX-Prüfung des Referenz-Ablaufs (15.11., Wunsch Maintainer „prüfe auch visuell und UX“): Chromium/Linux, Screenshots 1280×800 (de hell, de dunkel, en hell, 1440×900 und 1920×1080 stichprobenweise) von Start, Neues Projekt, allen Dock-Reitern, Menüs, Einstellungen/Über/Kürzel/Ressourcen/Verlauf/BCF/3D-Bild/Rendering/DXF-/IFC-Export/Standort-Import, Musterhaus, Musterhaus komplex, Wettbewerb (Plan, Objekt-Info, Taste T, Mappe, Plakat-Blatt, Publikationssatz). Automatisch geprüft: Symbolknöpfe ohne Tooltip (0 Funde), rohe Übersetzungs-Schlüssel (0), abgeschnittene Texte, Esc/Enter an Dialogen (alle modalen Dialoge schliessen mit Esc). **Behoben 15.11.:** (1) unbekannter Befehl in der Befehlszeile tat nichts, jetzt Meldung „Unbekannter Befehl …“ (`engine.ts`, `cmd.unknown`); (2) Layout-Werkzeugleiste: Tabellen-Auswahl auf den Pfeil geschrumpft und „Einpassen“ ausserhalb, jetzt Umbruch; (3) Attribute-Panel: Quellen-Auswahl neben der Strichstärke zeigte „e ▾“ (Label-Spalte höchstens 42 %); (4) Standort-Import: Platzhalter der Bezugspunkt-Felder abgeschnitten; (5) Ansichtsleiste: Ausblendung am rechten Rand, wenn dort noch Bedienelemente liegen; (6) Schreibweise: de „Schließen/Maßstab/Außen“ gemischt mit „Schliessen/Massstab/Aussen“ → überall Schweizer „ss“ (Test `src/i18n/spelling.test.ts`), „Snap-/Endpunkt-Farbe“ → „Fang-“, en „room program“/„colour“ → „room programme“/„color“. e2e: `e2e/uxReview263.spec.ts`. **Nachtrag 17.11. (Statusleiste, in GitHub Actions rot):** Der Wertcluster schnitt bei breiteren System-Schriften (ubuntu-latest) Felder ab. Jetzt kürzt sich die Leiste nach Priorität (`StatusBar.tsx`, gemessen per `scrollWidth`/ResizeObserver, kein Abschneiden mehr): 1 Beschriftungen weg (Tooltip bleibt, X/Y und LV95 behalten sie) · 2 Einheit und Build weg · 3 Linien-Darstellung, 4 Pausfolie, 5 Fang und Referenzlinien in ein Überlauf-Menü „⋯“ (Popover nach oben, Esc schliesst); Geschoss und Ebene bleiben immer. Der Cluster-Rand ist nicht mehr `overflow: hidden` (Popover wurden sonst beschnitten). e2e simuliert die CI-Schrift (DejaVu Sans + Zeichenabstand) bei 1280, 1440 und 1024 px (vorher rot). Nicht auf dem Mac geprüft. **Offen (nach Wichtigkeit, Grösse):**
  1. ~~Ansichtsleiste bei 1280/1440 px: Massstab, Zoom, Einpassen, Skizze, Schrift liegen hinter unsichtbarem Horizontal-Scroll (nur Trackpad/Rad; auch bei 1920 px ist die Schriftgruppe nicht ganz sichtbar). Vorschlag: Zoom/Massstab ins Plan-Fenster oder Überlauf-Menü „⋯“, M.~~ **Erledigt 16.11.:** Überlauf-Menü „⋯“ (Tooltip „Weitere Einstellungen“) am rechten Ende der Ansichtsleiste, kein Scrollen mehr: was nicht passt, wandert nach Priorität ins Menü (zuerst Schrift, Skizze, Schatten, Kombinationen, Detailgrad/Darstellung, Ansicht; Massstab/Zoom zuletzt), neu gerechnet per ResizeObserver (`overflowHidden` in `TopBar.tsx`); Menü als Portal, Enter/Leertaste öffnet, Esc schliesst, Pfeile wechseln die Bedienelemente. Bei 1280 px bleiben Ansicht + Massstab/Zoom in der Leiste, bei 1440 px zusätzlich Detailgrad; bei 1920 px liegt nur die Schriftgruppe (≈ 710 px) im Menü — alles in der Leiste bräuchte ≈ 2500 px Fensterbreite. Test: vitest `TopBar.overflow.test.ts`, e2e `uxReview263.spec.ts`. Nicht auf dem Mac geprüft.
  2. ~~Rechtes Dock bei 800 px Höhe: zwei Panels je ≈ 250 px, Gelände/Baurecht/Raumprogramm/Kennzahlen nur scrollend lesbar. Vorschlag: Teiler merken, aktives Panel grösser, „Maximieren“-Knopf, M.~~ **Erledigt 16.11.:** jede Dock-Gruppe (links wie rechts) lässt sich über einen Pfeil-Knopf am Ende der Tab-Leiste einklappen (`aria-expanded`, Enter/Leertaste; eingeklappt bleibt nur die Leiste, die andere Gruppe bekommt die Höhe: bei 1280×800 rechts ≈ 680 px statt ≈ 290 px); ein Klick auf einen Reiter der eingeklappten Gruppe klappt sie wieder auf. Zustand `collapsed` je Gruppe im gespeicherten Layout (localStorage, wie Breiten und Gewichte; ohne Versionssprung). Der Trenner zwischen den Gruppen war schon ziehbar und gemerkt (`resizeGroups`). Test: vitest `layoutCollapse.test.ts`, e2e `dockCollapse263.spec.ts`. Nicht auf dem Mac geprüft; dunkle Darstellung nicht eigens angesehen (gleiche Farb-Variablen).
  3. ~~Neu aus Vorlage „Musterhaus“: Plan nicht eingepasst (1:179, Haus ≈ 110 px breit), „komplex“ rechts angeschnitten (Ansicht des Vorgängerprojekts bleibt). Vorschlag: nach Projektwechsel einpassen (`planFitKey(level, projectEpoch)` in `viewportContent.tsx`), S.~~ **Erledigt 15.11.:** Das Einpassen nach Projektwechsel lief schon (`planFitKey` mit `projectEpoch`; eine gespeicherte Ansicht pro Projekt gibt es nicht, nur Reiter/Ausschnitte ohne Zoom), Ursache war der Mindestausschnitt von 30 m ([147], gedacht für das leere Projekt) auch für kleine Häuser und ein zu knapper Rand (Bemassungsketten ausserhalb `houseBounds`). Jetzt: mit Bauteilen Mindestausschnitt 8 m (`HOUSE_FIT_EXTENT_M`), Startansicht mit 6 % Rand. Test: `geometry.test.ts`, e2e `initialZoom.spec.ts` (Musterhaus < 1:90, komplex samt Rand sichtbar).
  4. Kein Sprachumschalter (nur `?dossierTest&lang=en`); englische Oberfläche zeigt Projektvorgaben deutsch („Leeres Projekt“, „Erdgeschoss“, „Süd“, „Schnitt A“, Ebenen „20 Wände“, „Gebäude“ …). Vorschlag: Umschalter in Einstellungen, Vorgabenamen beim Anlegen über `t()`, M.
  5. ~~Raumprogramm in der Flächenbilanz (320 px Panel): Name- und Gruppenfeld abgeschnitten („Wohnen/“, „Wohnunge“). Vorschlag: zweizeilige Zeilen oder Tooltip/Breite, S.~~ **Erledigt 15.11.:** zweizeilige Zeilen (Name über die ganze Breite, darunter Fläche/Anzahl/Gruppe/Stand), Tooltip mit vollem Text.
  6. ~~Statusleiste bei 1280 px: Hinweistext (z. B. „1/4 Treffer — erneut klicken …“) schrumpft auf „1..“, sobald X/Y-Koordinaten stehen. Vorschlag: Hinweis mit `title`, Koordinaten verdichten, S.~~ **Erledigt 15.11.:** Hinweis mindestens 170 px mit `title`, Wertcluster schrumpfbar, unter 1500 px engere Abstände und ohne Build-Nummer (steht im Über-Dialog).
  7. ~~Ressourcen-Fenster: Reiterleiste (… „Dachtypen“ …) bei 1280 px abgeschnitten, ohne Scroll-Hinweis; Zeilennamen („Holzwerkstoff (OSB/Spanplatte)“) ohne Tooltip. Vorschlag: gleicher Rand-Fade, `title`, S.~~ **Erledigt 15.11.:** Reiter umbrechen, Zeilennamen mit `title`.
  8. ~~Begriffe/Menüs: Ansicht-Menü „Perspektive“ steht zweimal (3D-Ansicht vs. Projektion; Vorschlag „3D-Ansicht“); Datei „Projekt öffnen“ ohne „ …“ (Startbildschirm mit), „DXF/DWG importieren…“ ohne Leerzeichen; Quellen-Auswahl „eigener Wert“ im Attribute-Panel bei 280 px als „eigen…“ gekürzt, S.~~ **Erledigt 15.11. („eigen…“ im Attribute-Panel: erledigt 16.11., Zahlenfeld gibt nach, Label-Spalte 36 %, Drehpfeile der Zahlenfelder im Panel ausgeblendet; „eigener Wert“ steht voll innerhalb des Panels, e2e `uxReview263.spec.ts`):** Ansicht-Menü „3D-Ansicht“ (Ansichtsart) statt zweimal „Perspektive“; „Projekt öffnen …“; Konvention „ …“ (Leerzeichen davor) für Menü-/Befehlstexte de+en vereinheitlicht, Test `spelling.test.ts` (Fortschrittstexte „Suche…“ und Platzhalter ausgenommen).
  9. ~~Hilfe-Menü hat nur „Tastaturkürzel …“; „Über dossier“ nur über Klick auf die Wortmarke (nicht auffindbar), keine Kurzanleitung/Fehler-melden-Eintrag. Vorschlag: Einträge „Über dossier“, „Kurzanleitung“ (Test `kurzanleitung.test.ts` existiert), S.~~ **Teilweise erledigt 15.11.:** Hilfe → „Über dossier …“ (Browser/Electron; Hook `state/aboutDialogHook.ts`); im nativen Tauri-Menü steht „Über“ im App-Menü (macOS), dort nichts geändert. **Erledigt 16.11.:** Hilfe → „Kurzanleitung …“ (Overlay-Dialog `QuickGuideDialog.tsx`, Inhalt von `doc/KURZANLEITUNG.md` beim Build gebündelt samt Bildern, kleiner Markdown-Leser `miniMarkdown.ts`, kein Netz; Text bleibt deutsch, im en-Titel „(German)“) und „Fehler melden …“ (öffnet `https://git.openbureau.ch/karim/dossier/issues/new` über `openExternalUrl`, vorbefüllt nur mit Version und Build, `update/bugReport.ts`); im nativen Tauri-Menü (Hilfe) dieselben Einträge. Nicht in der Tauri-App geprüft (System-Browser-Öffnung dort ungeprüft).
  10. ~~Rückmeldungen: „Publiziert (Dateien): 1“ nennt weder Dateiname noch Ort; CSV-Nachweis im leeren Projekt exportiert Nullen ohne Hinweis; schwebende Paletten (Verlauf, BCF, Objekteinstellungen mit T ausgenommen) schliessen nicht mit Esc, S.~~ **Teilweise erledigt 15.11.:** Meldung „Publiziert: «Name.pdf»“ (bei mehreren Dateien mit Anzahl; Ort wählt der Speichern-Dialog bzw. Download-Ordner); Verlauf, BCF und Kollisionen schliessen schwebend mit Esc (`closeOnEscape`, Fokus im Fenster). **Erledigt 16.11.:** CSV und PDF des Flächen- und Kennzahlen-Nachweises brechen im Projekt ohne Bauteile ab und melden „Noch keine Bauteile — der Nachweis wäre leer. Es wurde nichts exportiert.“ (`isAreaReportEmpty`); die übrigen Tabellen-Exporte (Raumbuch, Kosten …) unverändert. e2e: `uxReview263.spec.ts`. Nicht auf dem Mac geprüft.
  **Nicht geprüft:** Tauri/Mac (Nebenfenster, native Menüs, Metal), 3D-Ansicht und Zeichenfläche pixelgenau (SwiftShader), Layout-Inhalt im Druck, englisch/dunkel bei 1440, Tab-Reihenfolge/Screenreader ausserhalb der Dialoge ([249]). Dunkles Thema: Kontrast der Panels und Dialoge ohne Befund; der Plan bleibt als Papier hell (Absicht?). Grösse S–M.
- ◐ **[261]** Version und Buildnummer (15.11., Entscheid Maintainer): Anwender-Version semver **1.0.0-beta.1** (`package.json`, `tauri.conf.json`, App-`Cargo.toml`, `website/hugo.toml`; Kern-Crates bleiben 0.1.0, nichts Sichtbares). Interne Buildnummer **`JJMMTT.N`** aus `scripts/build-number.cjs`: Env `DOSSIER_BUILD` gewinnt, sonst Datum + Anzahl Commits des Tages (`git log --since=midnight`), ohne Git `JJMMTT.0`. Eingebacken über Vite-`define` (`__DOSSIER_BUILD__`, `src/update/buildInfo.ts`; Browser/Electron/Tauri) und `scripts/build-cli.mjs` (`dossier-cli --version`); Anzeige „1.0.0-beta.1 (Build 261115.1)“ in Über-Dialog, Einstellungen, Startbildschirm, macOS-Info-Fenster (shortVersion) und dezent in der Statusleiste; `tauri:build` setzt `bundle.macOS.bundleVersion` (CFBundleVersion). Tests: `src/update/buildNumber.test.ts`. **Offen:** nicht in der Tauri-App/auf dem Mac geprüft (Prüfschritt 13.35); ~~Electron-`buildVersion` nicht gesetzt~~ (16.11. gesetzt, [170]: aus `dist/build-info.json`, gleiche Nummer wie die Oberfläche); Projektdatei trägt (noch) kein Feld für die schreibende App-Version/Build (bräuchte Modellfeld in Rust + `KNOWN_KEYS` + Fassade, S); Zähler zählt Commits, nicht Builds (zwei Builds ohne Commit dazwischen = gleiche Nummer; Abhilfe `DOSSIER_BUILD=261115.3`). Grösse S.
- ◐ **[260]** Fenster/Türen im Grundriss: Darstellungsart **symbolisch** oder **geschnitten** wählbar (15.11., Entscheid Maintainer). Symbolisch = Öffnungssymbol nach Norm unabhängig von der Schnitthöhe (heutiges Verhalten für Öffnungen im Schnitt, Brüstungen/Stürze über/unter Schnitt als Symbol); geschnitten = Darstellung nach der tatsächlichen Schnitthöhe (Öffnung über dem Schnitt: Wand geschlossen, Öffnung als Linie über Schnitt). Einstellbar im Objekteinstellungsfenster (Taste T) je Fenster/Tür bzw. Typ, Vorgabe aus Modelldarstellung.
  **Umgesetzt 15.11.:** Modell `OpeningPlanMode` (`symbolisch` | `geschnitten`) als `Opening.planMode`, `WindowType.planMode`, `DoorType.planMode` und
  Modelldarstellung `walls.openingPlanMode` (Kern `generated.rs`, `npm run gen:types`); Rangfolge Element > Typ > Modelldarstellung > symbolisch
  (`WallOpts::opening_plan_mode`). Kern `plan/walls.rs`: symbolisch ⇒ Öffnung immer als geschnitten (Wandlücke + Symbol), Formöffnungen mit
  voller Breite statt der Sehne auf Schnitthöhe ([G3] gilt nur noch für „geschnitten“; Entscheid Maintainer 15.11. bestätigt); geschnitten ⇒ wie bisher nach Ansichtsbereich, neu auch
  ohne eigenen Bereich: ganz über dem Schnitt Wand geschlossen + strichpunktiert, darunter gepunktet, auf schwarzer Wand hell ([256]
  `contrastOnSolid`). Eine Stelle für Bildschirm, Plan-SVG, Druck-SVG/PDF und DXF (alle aus den Plan-Primitiven); Bemassung unverändert.
  UI: Objekteinstellungen (T) Feld „Im Grundriss“ (Wie Typ/symbolisch/geschnitten, „gemischt“-Marke) über den neuen Host-Handler
  `onSetOpeningPlanMode` — anders als die Art-eigenen Felder für ALLE gewählten Öffnungen, Fenster und Türen, ein Undo-Schritt; das macOS-Nebenfenster
  bekommt ihn über die bestehende Handler-Weiterleitung (`remoteHost`). Fenster-/Türtypen (Ressourcen) Feld „Im Grundriss“, Modelldarstellung
  Option „Fenster/Türen im Grundriss“. Tests: Rust `plan/opening_plan_mode_tests.rs` (Badfenster ab 1.10 m als Symbol, Kellerfenster; geschnitten:
  Wand geschlossen + Linie über/unter Schnitt hell; Rangfolge; Türtyp), bestehende Tests [36]/[G3]/[256] auf „geschnitten“ gestellt plus
  Gegenprobe symbolisch; vitest `elementAttributesHost.test.ts` (Fenster + Tür, ein Undo-Schritt); e2e `e2e/openingPlanMode260.spec.ts` (O1 wählen, T,
  Brüstung 1.10, „geschnitten“ ⇒ Linie über Schnitt, ⌘Z). Goldens: nur Musterhaus komplex (UG/EG/OG/DG 1:100/1:50), weil dessen Geschosse einen
  eigenen Ansichtsbereich haben und Bad-/Réduit-/Rund-/Lichtschachtfenster über der Schnitthöhe bisher die Wand schlossen — jetzt Symbol in der
  Lücke (je Plan 1 Polygon/Polylinie mehr, Hash neu); Musterhaus einfach und CLI-Goldens unverändert. Vorher/Nachher CLI-SVG `--hatch` 1:100 EG/DG
  in Chromium angesehen (Linux). Offen: auf dem Mac nicht geprüft (Metal-Fläche, natives Objekteinstellungsfenster, PDF/DXF; `doc/RELEASE-1.0.md` 13.29);
  **15.11. (später):** Typ-Feld „Im Grundriss“ jetzt auch im Fenster-/Türeditor (Bereich „Objekt“, Kategorie Basis; Wert und Texte aus `src/ui/planModeOptions.ts`,
  gemeinsam mit den Ressourcen-Tabs), Änderung über `onPatchWindowType`/`onPatchDoorType` (eine Op, ein Undo-Schritt, im macOS-Nebenfenster über die
  bestehende Handler-Weiterleitung). Tests: vitest `OpeningEditor.render.test.ts`, e2e zweiter Fall in `openingPlanMode260.spec.ts`. Offen: Mac-Prüfung (s. o.). · M
- ◐ **[253]** Standard-Objektbibliothek 2D (14.11., Wunsch Maintainer). Stand 14.11.: parametrische Objekte statt starrer `BlockDef`s —
  `Drawing2DGeom::Libobj { libId, at, rotation, params, seed }`; der Kern (`furniture_lib.rs`) erzeugt die Linien zur Plan-Zeit nach Detailgrad
  (grob/mittel/fein wie bei Türen/Fenstern), Definition (Parameterliste, Einfügepunkt, Klasse) getrennt von der Erzeugung, Register für
  spätere eigene Objekte [254] (`doc/ARCHITEKTUR.md` 3.7). 48 Objekte: Sanitär (WC wand/Kasten, Lavabo, Handwasch, Doppel, Dusche, Wanne,
  Urinal, WM/Tumbler), Küche im 55er-Raster (Unterbau, Spüle, Kochfeld, GS, Kühlschrank, Hochschrank, Zeile mit n Modulen, Insel), Tische
  (mit/ohne Stühle, Anzahl und „Unordnung“ per Seed, gleicher Seed = gleiche Stühle), Stuhl, Sofa, Sessel, Salontisch, Betten, Nachttisch, Schränke,
  Garderobe, Regal, Auto+Parkfeld, Velo, Wendekreis Ø 150 (gestrichelt). Klassen Möbel „22“, Sanitär „23“, Fahrzeuge & Freiflächen „24“
  (Standards laden ergänzt sie, Setzen legt sie im selben Undo-Schritt an); Möbel/Sanitär sparen den Belag aus ([156]). Palette: Dock-Panel
  „Objekte“ (Tab neben den Werkzeugen), Befehl `libobj` (R drehen, M spiegeln, Vorschau am Cursor); Objekt-Info baut die Felder generisch aus
  der Parameterliste („Neu würfeln“). Unbekannte Id = Platzhalter-Rahmen. 14.11. (abends): Ziehen aus der Palette ohne HTML5-Drag&Drop — Zeigerdruck startet `libobj`, Zeiger-Capture am Paletten-Knopf, Bewegen/Loslassen über die Zeichenfläche gehen durch das angemeldete Ablageziel (`state/planDropTarget.ts`, Anmeldung in `planView/usePlanDropTarget.ts`) in dieselben `toolHandlers` wie ein Zeiger auf dem SVG-Overlay (das auch über der nativen Fläche liegt); Loslassen daneben/Esc bricht ab; vitest + e2e „ziehen und loslassen“. 14.11. (später): e2e `e2e/objectLibrary253.spec.ts` (Palette, WC + Esstisch, R/M, Objekt-Info, Breite,
  Neu würfeln, Undo samt Klasse; Test-Naht `libobjs`), Rust-Test Belag-Aussparen ([156]: Möbel/Sanitär ja, Auto/Parkfeld/Wendekreis nein),
  DXF als `BLOCK` `DOSSIER_<id>_<hash>` + `INSERT` (gleiche Parameter = ein Block, `doc/DATEIFORMATE.md`). Offen: auf dem Mac nicht geprüft; Ziehen aus der Palette: in Chromium geprüft, mit dem nativen Metal-Renderer unter Tauri nicht ([RELEASE-1.0] 13.17);
  3D nach 1.0 (Trait hat Platz für `geometry3d`); Symbole nur im CLI-SVG/Chromium angesehen, nicht in der Tauri-App; DXF-Block ohne Attribute (Id/Parameter nur im Blocknamen). 14.11. UI-Review (Chromium, de/en, 1440×900 und 1024×700, hell/dunkel): Palette ohne Wortbruch mitten im Wort (weiche Trennstriche), Objekt-Info-Zeile „Objekt“ nicht mehr abgeschnitten. Offen: Klassen-Namen der Objekt-Klassen („23 Sanitär“) bleiben auch im englischen UI deutsch (Projektdaten); Palette im 900-px-Fenster war nur ca. 270 px hoch: behoben 14.11. (spät) — Dock links oben 1,6 : 1 (Layout v15, ca. 480 px bei 900 px) und Gruppen merken offen/zu (`localStorage` `cad.objlib.open`); Mac nicht geprüft. Klassennummern 22/23/24 vom Maintainer bestätigt (15.11.). · M

## Phase 1 (13.–19.11.): Stabil und baubar
  Konsolen-Audit (14.11.): `node scripts/console-audit.mjs [--gpu]` (Vite-Server auf `E2E_PORT`, `?dossierTest&gl=0` bzw. WebGPU/SwiftShader) spielt Musterhaus/komplex/Wettbewerb, 3D, Layout, Panels, Wand setzen, Ressourcen-Manager und PDF durch und zählt alle Meldungen ab warning. Wichtigster Befund: die Standard-Suite läuft gegen den Produktions-Build, React-Entwicklungswarnungen (Key, „Cannot update a component“, act) sind dort unsichtbar. Ganze e2e-Suite einmal gegen `vite dev` (Worktree mit node_modules-Symlink: `server.fs.allow` auf den Hauptcheckout, sonst 403 auf die Schriftdatei): 0 React-Warnungen, 0 Key-Warnungen, 0 404; einzige echte Ursache: die Tauri-Attrappe in `nativeOverlaySync.spec.ts` ohne `__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener` (behoben). Fixture `e2e/app.ts`: React-/Deprecation-Warnungen zählen jetzt als Fehler, `E2E_WARN_LOG=<datei>` schreibt alle Warnungen. Bleibt (alles nur headless/SwiftShader, kein Produktfehler): „WebGPU-Gerät verloren“/„Renderer ausgefallen“/„Init fehlgeschlagen → SVG“/„recursive use of an object“ (Folgepanik nach Geräteverlust)/„A valid external Instance reference…“ (~2300 Meldungen in 182 Tests, ~40 im Audit mit WebGPU; **behoben 14.11. spät, s. [118] Geräteverlust**), `[longtask]` 200–300 ms beim Laden grosser Beispiele (11 im Audit, Produktions-Build; im Dev-Build bis 11 s). `csp.spec.ts` schlägt gegen `vite dev` erwartungsgemäss fehl (kein CSP-Meta nur im Build). Nicht geprüft: Tauri/Metal-Konsole auf dem Mac.
- ◐ **[206]** Referenz-Ablauf als e2e-Spec (Browser) und als Checkliste für die Mac-Abnahme (`doc/RELEASE-1.0.md`): jeder Schritt
  oben ein Test; was fehlt, wird hier als Aufgabe eingetragen. · M
  Umgesetzt (12.11.): `e2e/release10.spec.ts` spielt leeres Projekt → Kataster-DXF (LV95) → Baurecht → Wände/Decke/Dach → Raum +
  Raumprogramm → SIA 416/Kennzahlen (CSV/PDF) → 1:200 → Schnitt → Axonometrie/Schatten → Präsentationsplan A1 → Publikation PDF → DXF/IFC
  → Speichern in 13 Schritten durch; fehlende Schritte als `test.fixme` ([207] [208] [211] [222] [223] [224] seit 13.11. aktiv; [209], [221] und [225] seit 12.11. aktiv). 13.11.: [207] (Situation WBW/Schwarzplan: Füllfarben im Kern über Test-Naht `templateFills`, Kataster-DXF-Gebäude gefüllt), [208] (Plakat, Kennwort, anonymes PDF ohne Projektnamen, Gegenprobe; PDF-Helfer in `e2e/pdf.ts`) und [211] (Dialog im Browser: ZIP-Paket mit `model.glb` + `scene.json`) als echte Tests; Pathtracer-Zähler ([212]) als `fixme` (SwiftShader: Panic in wgpu `create_buffer` beim ersten Pathtrace-Bild, nur mit `DOSSIER_PATHTRACE=1` aktiv). `doc/RELEASE-1.0.md` um Abschnitt 13 (Mac-Prüfschritte) ergänzt. Behoben: GV in der
  15.11.: Lücken 3.6 (OG: Wände kopieren, ⌘6/⌘5, GF steigt um die Konstruktionsfläche der Wände), 4.3 (Raum → „Atelier“ über Objekt-Info, Programmzeile 0/1 → 1/1), 11.3 (Ausgabe „DXF mit Layouts“ → Binär-DXF) und 1.3 (Höhenlinien-DXF → „Gelände erzeugen“ → Geländenetz) als Schritte 4/11/14/15 der Spec; in der App ging alles, nichts war zu beheben. Offen: DXF-Inhalt je Blatt (Layouts) nur am Kopf geprüft, Gelände nicht im Schnitt; Stand Browser/Linux, nicht auf dem Mac.
  14.11. (spät): e2e `kataster.spec.ts` „über 600 Stützpunkten“ gelegentlich rot in der ganzen Suite (Objekt-Info ohne „Breite“): der Klick direkt nach dem Import ging unter Last ins Leere (Plan-Puffer/viewBox noch nicht fertig). Jetzt `selectAt` (wartet auf festgeschriebene Ansicht, klickt bis die Objekt-Info das Element zeigt). Lokal nicht reproduziert (8× einzeln, Suite mit 10 Specs, `--workers=4`); Ursache aus dem Ablauf abgeleitet.
  Kennzahlenleiste war ohne freie Körper 0 m³, neue Decken bekamen den Aussenwand-Aufbau statt eines Deckentyps. 14.11.: Spec um [253] (Schritt 4b: WC und Esstisch aus dem Panel „Objekte“, Plan-Linien), [255] (6b: AZ/ÜZ/Fassadenhöhe max. → Nachweis in der Flächenbilanz mit erfüllt/Reserve; 10c: Blatt-Tabelle aufs Plakat), [208] (12b: Raum = Projektname → Anonymitäts-Dialog → Abbrechen → umbenennen → Export ohne Dialog) und [252] (Ctrl+Tab im Schritt 9) ergänzt; Checkliste 13.15/13.16. Offen: Durchlauf
  der Checkliste auf dem Mac (Maintainer); 3D-Bild headless nicht prüfbar; Blender-Lauf von [211] nur auf dem Mac; Pathtracer unter SwiftShader (s. o.).

- ◐ **[258]** Robustheit: kein Kern-Panic im Referenz-Ablauf (14.11.). `src-tauri/core/tests/robustness.rs`, deterministisch, Release < 1 min: (1) die vier
  Beispielprojekte (`tests/fixtures/robust/*.json`, aus `dossier-cli :beispiel|:wettbewerb|:gross|:musterhaus-komplex migrate`; Komplex ohne `context`)
  durch den Lader und alle Ableitungen (Grundrisse je Geschoss 1:20–1:500 samt SVG/Druck-SVG/DXF/Szene/Texte, Schnitt, Ansicht, 3D, ~50 Abfragen,
  IFC-/Netz-Sammler, Kennzahlen, Baurecht, Objekt-Info, Griffe, Befehle), (2) Mutationsrunde mit festem Seed (Zahlen auf 0/1e-9/-1/1e300/null/Text,
  NaN-Marken, verschieben, löschen, duplizieren, Undo/Redo), nach jedem Schritt neu rechnen, (3) kaputte Projektdateien (abgeschnitten, falsche
  Typen, fehlende/leere/doppelte Felder, Verweise ins Leere, Zahlen 1e300). Jeder Aufruf unter `catch_unwind`, alle Panics gesammelt gemeldet
  (`ROBUST_STEPS/SEED/ONLY/TRACE/SLOW`, Kopf der Datei). Behoben (je mit Begründung im Commit): i_overlay-Panic bei Koordinaten ≥ 2^500
  (`polygon_bool::COORD_LIMIT`), Speicher-Abbruch bei `wingCount` 1e300 (Elevation/Schnitt/Plan), Gitter über riesige Räume (`room_area::label_point`,
  `room_book::height_bands`), Ansichts-Zellraster (`mesh_cull`), `partial_cmp().unwrap()` auf NaN in render3d/hatchgen/Kern. **Nachsuche 14.11.:** Endlosschleifen
  `while sweep <= 0 { sweep += 2π }` bei Winkeln ±1e300 (`svg.rs`, `stamp_place`, `drawing_recognize`, `magic_wand`, `stair_symbol`) durch
  `rem_euclid` ersetzt; Obergrenzen für Massstabsbalken-Segmente, Strahlen der Böschungsschraffur, Höhenlinien-Beschriftung, Strichzerlegung
  (`dxf::dash_seg`), Blasen-Verschiebung, Wendeltreppen-Vorschau, Raster in `context_ground` (Koordinaten ~1e17). Je ein `regression_*`-Fall.
  **Bindungen 14.11.:** `src-tauri/core/tests/robustness_web.rs` (Feature `web`; `web` ist dafür `pub`+`doc(hidden)`, die wasm-bindgen-Funktionen laufen nativ
  als gewöhnliche Rust-Funktionen) ruft ALLE 190 `#[wasm_bindgen]`-Einstiege in `src/web/*.rs` je Seed-Lauf N-mal mit kaputten Eingaben (leere/abgeschnittene/
  verdorbene Flat-Puffer, Zähler -1/1e9/NaN/∞, Zufallsbits, ungültiges/abgeschnittenes/verdorbenes Projekt-JSON, falsche Handles/ids, Zufallsbytes) unter `catch_unwind`
  samt 30-s-Wächter (Endlosschleife) auf; `jede_bindung_ist_abgedeckt` schlägt fehl, wenn eine neue Bindung nicht in `CALLS` steht (`ROBUST_WEB_N/SEED/ONLY/SKIP/TRACE/DUMP`,
  Kopf der Datei; von Hand mit `ulimit -v 6000000`, dann wird ein Speicher-Abbruch zur Meldung statt Absturz des Rechners). Gefunden und behoben (je `regression_*`):
  usize-Überlauf bei gesättigten Zählern (`grip_coincident`, `contour_marks`, `decode_step`, `smooth_grid`: 1e300 → `usize::MAX`, `1 + 2·n` lief über → Slice-Panic);
  Schraffur (`hatchgen`): Schleifen mit `k += 1.0` bei Indizes ≥ 2^53 (Linienschar, Zufallslinien, Erde/Kies/Streuung, Band-/Punktmuster) → Zählschleife `fseq`/Grenzen,
  Linienschar/Strichzerlegung/Zickzack/Motiv mit Obergrenzen, Streuraster bei langen dünnen Flächen (Milliarden Zellen in einer Zeile); Dach: Skelett-Wellenfront lief in einen
  Rundungszyklus (Ecken-Obergrenze `32·n+256` → Degeneration/Rückfall); Treppe: `split_steps` sättigte bei Lauflänge `f64::MAX` zu `i64::MAX` Tritten (Speicher-Abbruch);
  Delaunay: Koordinaten > 1e60 (Hülle inkonsistent, Endlosschleife). Dazu `render2d/tests/robustness.rs` (Szene lesen → `compile_scene`, Textzeilen, WOFF2, Zerlegung, Strichphase)
  und `render3d/tests/robustness.rs` (verdorbenes Teile-Update → `Scene::apply`/`chunk_data`/`cut_section`): beide sauber (100000 bzw. 30000 Läufe je Seed), keine Befunde.
  **Op-Fuzzer 14.11.** (`tests/robustness/op_fuzz.rs`, Test `op_fuzzer`, ~30 s Release; `FUZZ_STEPS/EPISODES/SEED/DERIVE/ONLY/TRACE`): zustandsbehaftet, aus dem
  aktuellen Dokument heraus gültige Ops aller Arten (add mit `at`, replace/Patch mehrerer Felder, remove samt Abhängigen, reorder auch Teilmenge, setField für
  Klassen/Skalare/Objekte/neues Feld mit Position/Liste, Gruppen, add+replace+remove in einem Commit, `replace` unbekannter Elemente) und ungültige (doppelte id, NaN-Marke,
  gültige Op + doppelte id), über `Document::commit`/`undo`/`redo`/`history_jump`/`begin_group_keyed`, mit Coalesce-Schlüsseln. Nach jedem Schritt: Verlaufsmodell
  (Dokument bei jeder Undo-Tiefe exakt wie gemerkt, Verschmelzung genau wie erwartet, Redo-Rest gelöscht, Abgelehntes ohne Spur in Dokument und Verlauf), `validate_project`,
  keine neuen hängenden Verweise (`dangling_refs`); alle 6 Schritte: fortgeschriebenes Dokument = frisch gelesenes (typisierte Sicht, Plan als SVG, Kennzahlen, 3D),
  Speichern → Laden, alle Ableitungen; am Ende Undo bis zum Anfang = Ausgangsdokument, Redo bis zum Ende = Endzustand. Befund (behoben, `regression_absturzsicherung_riesiges_loch`):
  Deckenloch mit Eckpunkt bei y = 1e5 → Absturzsicherung mit Hunderten Millionen Rohren (Speicher-Abbruch beim 3D-Modell, `stairs3d::guard_mesh` jetzt begrenzt). Sonst keine
  Verstösse des Kerns (Läufe mit 8 Seeds, bis 300 Schritte × 10 Episoden). Nicht abgedeckt: Ops, die nur die TS-Leseansicht betreffen; Wurzelfeld-Reihenfolge nach Laden (Datei schreibt `formatVersion` zuerst, gewollt).
  **Offen:** Speicher-Abbruch (`handle_alloc_error`) lässt sich nicht per `catch_unwind` fangen (der Test bricht dann den ganzen Lauf ab; im WASM ein Trap wie ein Panic);
  `WebModelRenderer`/`WebRenderer` (GPU, Canvas: `set_model`, `set_scene_bin` …) nur über ihre GPU-freien Leser abgedeckt, nicht als Ganzes; die Ausgangsdaten der Bindungsläufe sind
  flach/zufällig; TS-Seite nicht abgedeckt; Rust-Panic im WASM selbst nicht gemessen ([118] bleibt Wiederanlauf). · M
- ◐ **[116]** Datensicherheit, Audit (14.11.): Speichern/Autosave/Wiederherstellen/Schliessen. Test zuerst, Befunde behoben: (1) **Schliessen ohne Rückfrage:**
  Fenster zu, Cmd+Q, Electron-Schliessen und Browser-Tab verwarfen ungespeicherte Änderungen (nur die 30-s-Kopie blieb). Jetzt `registerCloseGuard`
  (`native/projectFile.ts`): Tauri `onCloseRequested` → Overlay „Ungespeicherte Änderungen" (wie Neu/Öffnen), danach `destroy`; Cmd+Q ist ein eigener
  Menüeintrag (`onQuitApp`, `quitApp`), weil der vordefinierte „Quit" ohne Fenster-Schliessen beendet; Electron: Hauptprozess hält `close` an
  (`window:close-requested`, `forceClose`); Browser `beforeunload`. Rechte `core:window:allow-destroy`, `process:allow-exit`. (2) **Autosave-Schlüssel nach
  „Speichern unter":** Kopie lag unter dem alten Pfad (`openedProjectPathRef`), Wiederherstellen am neuen Pfad fand nichts, am alten bot es fremden Inhalt an
  → Schlüssel = `savePathRef`; Speichern räumt alten, neuen und „unbenannt". (3) **Beschädigte Kopie:** wurde angeboten, Wiederherstellen scheiterte, die Kopie
  blieb für immer → zwei Stände (`#prev`, im Speicher rotiert), Angebot nur der neuesten LESBAREN (Kern-Prüfung), beschädigte gelöscht, Hinweis (`recover.damaged*`).
  (4) **Autosave-Fehler still:** Kontingent voll / kein IndexedDB schluckte alles, der Stand galt als gesichert → `writeAutosave` meldet, Stand wird erneut versucht,
  einmalige Meldung `autosave.failed`. (5) **Speichern-Dialog-Fehler** fiel unter Tauri auf Browser-Download zurück und galt als gespeichert → `SaveError`.
  (6) Öffnen: Lese-/Dialogfehler (nativ, Vorlage, FileReader) nur in der Konsole → `notify`. (7) Meldungen am Startbildschirm unsichtbar (`<Toast />` fehlte dort).
  Geprüft ohne Befund: `save_atomic` (Temp + fsync + Umbenennen + `~`; 3 neue Rust-Tests), Fehler → `SaveError` → `notify`, Projekt bleibt ungespeichert;
  Rundreise aller Beispiele und der Robustheits-Fixtures samt Libobj/`fill`/`identifiers`/Baurecht (`src/io/projectRoundtrip.test.ts`); Autosave `sampleProjectBig`
  (1.7 MB) Serialisieren ≈ 35 ms, Prüfen ≈ 33 ms (headless gemessen). Tests: `autosave.test.ts`, `closeGuard.test.ts`, `saveFile.test.ts`, `e2e/datensicherheit116.spec.ts`
  (Browser). **Fortsetzung 14.11. (8):** (8) **Exporte atomar** (Tauri): `saveBinaryFile`/`saveTextFile`/OBJ+MTL schreiben über den Rust-Befehl `save_export`
  (Rohkörper, Pfad prozent-kodiert im Header; Temp + fsync + Umbenennen, keine `~`), vorher `writeFile`/`writeTextFile` des Plugins; Fehler → `setExportErrorReporter`
  (in `useProjectFileActions` an `notify` gehängt, `export.save.failed`), kein Download-Ersatz, Ziel bleibt heil. (9) **Electron:** Projekt-Speichern atomar im
  Hauptprozess (`scripts/electron-files.cjs`, `window.dossierFiles`: `saveAtomic`, `saveAs` mit Dialog, `backupExists`, `readBackup`, `pathForFile`); Pfad aus
  Kommandozeilen-Start oder gewählter Datei, sonst Dialog. (10) **`.obp~`-Wiederherstellung:** lässt sich die Datei nicht laden, die Sicherung aber, bietet
  `BackupOfferDialog` „Vorige Fassung (.obp~) öffnen" (Lock bleibt bis zur Antwort; geöffnete Sicherung gilt als ungespeichert); Datei-Menü „Vorige Fassung
  wiederherstellen …" (AppMenuBar + natives Menü, immer aktiv, ohne Sicherung Hinweis `backup.none`); Rust `backup_exists`/`read_backup`. Tests: `atomic_save.rs`
  (Export, Prozent-Dekodierung, Sicherung lesen), `saveFile.export.test.ts`, `electronFiles.test.ts`, `projectBackup.test.ts`. **Offen:** nichts davon in der
  Tauri-App/Electron geprüft — `doc/RELEASE-1.0.md` Abschnitt 14 (14.14–14.19; Mac); Fenster für Dialoge/Menü nur per tsc; Menüpunkt nicht ausgegraut; Electron-Kommandozeilen-
  Start setzt keine Zuletzt-geöffnet-Einträge; Autosave ist ein Fenster-Zustand der Webview
  (Löschen der Webview-Daten löscht die Kopien); Autosave serialisiert im Hauptfaden (≈ 35 ms bei Grossgebäude, bei viel grösseren Projekten Worker erwägen). · S
- Release-Notes-Entwurf `doc/RELEASE-NOTES-1.0.md` (14.11.), offene Fragen an den Maintainer dort markiert (`**[Frage M: …]**`); nach dem Mac-Durchlauf [206] Einschränkungen nachführen.
- [30] Release-Workflow lauffähig: macOS universal signiert/notarisiert, Updater, Versionsnummer 1.0.0-beta; [57]/[120] CI auf GitHub grün.
- „Mac-Gegenprobe“ (Sammelpunkt unten) für alles im Referenz-Ablauf abarbeiten (Maintainer), Befunde sofort beheben;
  [194] Texte synchron, [195b] Objektfenster, [190] Cmd+J auf dem Mac bestätigen.
- Datensicherheit: Speichern/Autosave/Wiederherstellen auf dem Mac ([116], Audit 14.11. s. o.; Mac-Prüfschritte `doc/RELEASE-1.0.md` Abschnitt 14), Öffnen alter Beispielstände (Rundreise-Test grün), kein Kern-Panic im Ablauf.

### Phase 2 (20.–26.11.): Wettbewerb lückenlos
- ◐ **[226]** Schriftfamilien im GPU-Text (13.11., Nachfolger [218]/[194]): Der Glyphen-Pass (`render2d/src/glyph.rs`, WebGPU und Metal) kannte nur
  Inter; die in Stempel/Textfeldern gewählte Familie wirkte nur in SVG/PDF/DXF. **Stand 13.11.:** Szenenformat: Familien-Kennung (Index in
  `TEXT_FONTS` + 1, 0 = Inter) ab Bit 16 des Text-Codes (`plan/scene.rs`, `plan_screen_texts`, `scene_bin.rs`, `text_lines.rs`; Kern
  `text_layout::font_family_id`, Test gleicht mit `src/text/fontList.ts` ab). Atlas je Familie/Schnitt lazy: `GlyphText::needed_fonts` →
  Webview lädt `/fonts/<slug>/…woff2` (`src/text/glyphFonts.ts`, `wasmRendererSession`) → `add_font`; render2d entpackt WOFF2 selbst
  (`woff2.rs`, brotli-decompressor, nur untransformierte Pakete — die 56 Dateien in `public/fonts` wurden so neu gepackt). Rückfall Inter bei
  fehlender Familie, bei fehlendem Schnitt (Manrope/Outfit/Space Grotesk kursiv) der aufrechte der Familie. Messung: `text_metrics.rs`
  (erzeugt von `scripts/gen-text-metrics.py` aus `hmtx`, 4 Schnitte je Familie) über `text_width_em_in` für Stempelblock/Ausrichtung;
  Inter und alle anderen Aufrufer (Masse, Marken) unverändert. Bildtest `headless::schriftfamilien_im_glyphen_pass` (Breite gezeichnet =
  Breite gemessen ±4 %). Mac: `native2d_font`/`native2d_needed_fonts` (`lib.rs`, `native_embed.rs`, `useNativePlanRenderer.ts`) nach Muster
  geschrieben, NICHT kompiliert/geprüft. **Offen:** Mac-Gegenprobe; je Zeile zählt nur die Familie des ersten Laufs (Mischzeilen); Textfelder
  mit Drehung (Vektor-Glyphen `vtext.rs`, Systemschrift) und SVG-Overlay-Texte unverändert; Kerning nicht in der Kern-Messung. · S
- ◐ **[218]** Raumstempel bearbeiten im Objekteinstellungsfenster (13.11., Wunsch Maintainer): **Stand 13.11.:** Der Overlay-Dialog
  („Fenster im Fenster“, `RoomStampEditor`/`RoomStampEditorHost`, samt Alt-Rich-Text-Dialog `TextEditorDialog`) ist weg. Doppelklick auf einen
  Raumstempel (oder den Raum) wählt den Raum und öffnet die Objekteinstellungen mit dem neuen Abschnitt „Raumstempel“
  (`panels/objectInfo/RoomStampSection.tsx`, Fokus-Abschnitt wie bei T, `openObjectSettings(deps, "roomStamp")`); unter Tauri im nativen
  Nebenfenster über die bestehende Spiegelung ([195b], Abschnitt schreibt über Store-Ops). Schrift wählbar: Modell `RoomStampFont`
  (Familie aus den gebündelten Schriften, Grösse pt, fett, kursiv, Farbe) am Stempel (`font`, ganzer Stempel) und je Zeile (`nameFont`,
  `line2Font`, `numberFont`, `areaFont`, `usageFont`); Auflösung im Kern `plan/domains.rs::stamp_line_marks`: Zeile > Stempel > bisherige
  Vorgabe (Name 12 pt fett, Zeile 2 9 pt kursiv, Nummer 9 pt, Zusatzzeilen 0.8 × Grundschrift); Zusatzzeilen tragen `StampLine.marks`
  (Grösse bezogen auf Grundschrift 10 pt, folgt dem Massstab 7/10 und dem Einpassen), `text_layout::stamp_block*` und alle Ausgaben
  (Anzeige-Szene `plan/text.rs` mit den gemessenen Grundlinien, SVG, Druck-SVG/PDF, DXF, HTML-Block) lesen sie. Mehrfachauswahl: gemischte
  Werte „gemischt“, Änderung für alle gewählten Räume in EINEM Undo-Schritt (`state/roomStampEdit.ts`); Nummer/Namen bleiben je Raum. Bezugspunkt und Masse
  (Breite/Höhe/Drehen, bei allen Elementarten) erscheinen nur noch im Objekt-Info-Panel, nicht im Fenster (`ObjectInfoPanel showPlacement=false`).
  **Offen:** Die Schriftfamilie zeigt der GPU-Glyphen-Pass (WebGPU/Metal, `render2d/glyph.rs`) noch nicht — er kennt nur das eingebettete Inter
  (Grösse, fett, kursiv, Farbe wirken); Familie sichtbar in SVG/PDF/DXF/HTML; Mac-Nebenfenster nicht geprüft (nur Linux-Container). · M
- ◐ **[216]** 3D-Darstellungsfehler (12.11., Screenshots Maintainer, Musterhaus komplex): (1) Rundfenster im Giebel: Wandloch
  quadratisch statt rund, Leibung mit Streifen; dazu ein senkrechtes Band im Giebel vom Fenster bis zur Decke; (2) Flächenmuster
  (Fassade, Dach) im 3D nicht auf die Fläche beschnitten — Linien ragen über Giebel/Ortgang hinaus in die Luft; (3) Rundbogen-Öffnung:
  Leibungs-/Sturzflächen mit Streifen-/Backsteinmuster, Bogen-Leibung nicht sauber geschnitten; (4) Dachfenster in der Darstellung
  „ohne Material“ als offener Schlitz ohne Glas. · M
  Stand 12.11.: (1)–(4) umgesetzt (Wandkörper per Manifold `core/src/model3d/wall_body.rs` + TS `splitWallBodies`; Wandmuster am Giebel/Öffnungsumriss
  beschnitten `surface_pattern3d.rs`; Glas im Shader), nur im Linux-Container per render_png geprüft. Offen: Mac-Gegenprobe (Metal, Texturen);
  3D-Live-Schnitt durch Formfenster zeigt Rechteck-Loch; Dachmuster an Kehlen nicht beschnitten; einzelne
  Körper mit inneren Stossflächen (Überlappung 0,1 mm mildert).
  Stand 13.11.: Bogenwände (Erker) bekommen ebenfalls EINEN Körper je Band (`wall_body.rs`, `band_solid(…, arc)`): die Sehnen-Stücke stiessen
  an radialen Stirnflächen zusammen, im 3D als senkrechte Linie je Sehne sichtbar (auch quer über Fensterbank/Leibung). Manifold verschmilzt
  die Stirnflächen nur bei gleichen Ecken — die Stücke einer Bogenwand werden dafür auf 1e-7 m gerastert vereinigt (gerade Wände nicht),
  nicht unterteilt. Test `bogenwand_ein_koerper_ohne_sehnen_fugen`; Golden `komplex-model3d` (+11 Körper, −613 Erker-Stücke), Musterhaus
  per render_png verglichen (Linux). Offen: Formöffnungen in Bogenwänden behalten Rechteck-Loch + Füllkörper; zwischen ungleich langen
  Sehnen (Rand der [106]-Einzug-Sehne) ist die radiale Gehrung nicht Winkelhalbierende, die Bänder treffen sie ~2e-5 m versetzt (Restkante
  möglich, wie bisher bei den Stücken); Leibungsstücke berühren Nachbarn teils nur auf einer Kante (wie bei geraden Wänden).
  Stand 13.11. (3)+(4) nachgeprüft: (4) Dachfenster in „ohne Material“ (white/hidden) zeigt das Glas mit dem Shader-Aufhellen aus [216]
  (kein offener Schlitz mehr; render_png, Linux). (3) Flächenmuster liegen nicht auf Leibung/Sturz (Musterlinien am Öffnungsumriss
  beschnitten, per Auswertung des Puffers geprüft); das „Stein-/Streifenmuster“ waren die Leibungsstücke des Schichteinzugs [106]: ein
  Quader je Bogenkante, im 3D mit Kanten als Fugenraster sichtbar. Jetzt je Stück und Seite EIN Körper über dem Kantenzug
  (`openings.rs` `reveal_meshes`, glatt schattiert wie der Rahmenring); die Quader bleiben für Export/IFC (`with_fill`). Test
  `formoeffnung_leibungsstuecke_ein_koerper_je_kantenzug`; Golden `komplex-model3d` (−69 Netze). Offen: Bogenwände (Erker) behalten
  Quader-Leibungen; Mac-Gegenprobe.
  Stand 14.11.: (a) Formöffnungen in Bogenwänden schneiden die echte Form (`wall_body.rs`): ohne Schichteinzug ein gebogenes Prisma
  (abgewickelt gebaut, unterteilt, auf den Bogen gelegt; Leibungen radial), mit Schichteinzug [106] ein gerades Prisma auf der Sehne
  über `reveal_zone` (die zweite Rechnung in `walls.rs` legt dafür die Sehne ohne Loch an, `zone_only`); die Öffnungsteile
  (`openings.rs`) haben keine Füllkörper mehr, die Leibungsstücke laufen als ein Körper je Kantenzug wie bei geraden Wänden (damit
  auch keine Quader-Leibungen im Erker). Test `formoeffnung_in_bogenwand_mit_echter_form` (Rund/Spitzbogen gebogen, Rundbogen/Rund
  mit Einzug; Punkt-in-Körper an Öffnungsmitte und Rechteck-Ecken). (b) Dachmuster verschnittener Dächer (Kehle, Gauben) enden
  an der Kehle: Musterlinien jeder Dachfläche auf die nach `roof_assembly` übrigen Flächen der Eindeckung beschnitten
  (Verankerung unverändert); Zwischenspeicher-Schlüssel mit den Ständen der Nachbardächer. Test `dachmuster_endet_an_der_kehle`.
  Goldens unverändert (Musterhaus komplex: Erker-Fenster sind Rechtecke, Muster nicht im `model3d`-Golden). Nur per Rust-Test und
  Puffer-Auswertung geprüft, nicht angesehen (Linux ohne Metal). Offen: Mac-Gegenprobe; 3D-Live-Schnitt durch Formfenster zeigt
  Rechteck-Loch (`render3d/section.rs` schneidet die Stücke, nicht den Körper); Rahmen/Glas gebogener Formöffnungen bleiben
  Sehnen zwischen den Ecken (wie Rechteck-Einbauteile in Bogenwänden).
  Stand 14.11. (abends): Einbauteile in Bogenwänden nach Modell entschieden (kein Feld gebogen/gerade): mit Schichteinzug [106]
  liegen Wandloch UND Teile gerade auf der Sehne über `reveal_zone` (gerades Fenster mit sauberem Anschluss, wie bisher — so die
  Erker-Fenster im Musterhaus komplex, `mk-fe-dk` hat `layerReveals`); ohne Schichteinzug folgen Rahmen, Flügel, Glas, Fensterbank
  (Rechteck- und Formöffnungen) dem Bogen, sobald die Pfeilhöhe der Öffnung am Aussenradius > 1 cm ist (`follows_arc`,
  `BEND_SAGITTA`; r = 2 m ab ≈ 0,4 m Breite), schmalere bleiben gerade. Umsetzung `openings.rs`: Netze der abgewickelten Wand an den
  Teilstellen der Wand (gleiche Teilung wie `chord_walls` + Laibungen) zerschnitten (`slice_x`, ohne T-Stösse) und stückweise
  linear auf die Sehnen gelegt (`bend_on_arc`), Facetten glatt (Knickwinkel 20°). Tests `fenster_in_bogenwand_folgt_dem_bogen`
  (jeder Punkt eines Teils quer im Bereich seiner Ecken, dicht), `slice_x_quader_bleibt_geschlossen`. Grundriss (Linien mit
  konstantem Querversatz als Bögen, `bend_prims`) und Schnitt ([157] tangential an der Schnittstelle) zeigten das Symbol schon im
  Bogen. Nur per Rust-Test geprüft (Linux, kein Metal, nicht angesehen). Offen: Mac-Gegenprobe; mit Schichteinzug zeigt der
  Grundriss das Symbol gebogen, 3D gerade auf der Sehne.
  Stand 14.11. (spät): (a) 3D-Live-Schnitt durch Wandkörper: die Körper-Wände (Formöffnung, Bogenwand, Giebel [231]) erreichten
  render3d nur als Netz — ihre Stücke fehlten im Schnitt ganz (keine Schnittfläche, Wand hohl). Jetzt trägt das Netz den
  Schnitt-Stil der Schicht (`MeshInput.section` = Schraffur + `cut`, TS `splitWallBodies`), und render3d schneidet das Netz selbst
  (`section_mesh.rs`: Dreieck × Ebene → Strecken, Fläche gerade-ungerade als waagrechte Trapeze, Umriss = die Strecken, ohne Fugen):
  echte Öffnungsform (rund, Bogen, Spitzbogen, frei, gebogen in Bogenwänden) in jeder Schnittrichtung. Bänder STRIKT höherer
  Priorität (Decke) schneiden Fläche und Umriss weg; der Körper schneidet umgekehrt keine Bänder (Rechteck-Dominanz). Tests
  `laengsschnitt_zeigt_rundes_loch`, `querschnitt_neben_der_mitte_folgt_dem_kreis`, `live_schnitt_mit_koerper_netz_und_dominanz`
  (Punkt-in-Fläche). (b) Grundriss mit Schichteinzug in Bogenwänden wie das 3D: `Unroll` kennt die Sehnen-Zonen (`reveal_zone`),
  Wand und Symbol liegen dort gerade auf der Sehne (Lage linear, quer senkrecht zur Sehne; an den Zonenenden radial gehrt, ≈ 2 mm
  Stufe zum Bogen), Linien an den Zonengrenzen geteilt (Bogen/Gerade). Test
  `fenster_mit_schichteinzug_in_bogenwand_gerade_auf_der_sehne`. Nur Linux (Rust-Tests, WASM gebaut), Live-Schnitt nicht im
  Browser/Metal angesehen. Offen: Mac-Gegenprobe; Schnitt/Ansicht (2D) zeigen Erker-Fenster mit Schichteinzug weiter gebogen
  (tangential, [157]) — erledigt 15.11., s. unten.
  Stand 15.11.: Schnitt und Ansicht (2D) legen Fenster in Bogenwänden wie 3D und Grundriss. EINE Entscheidung
  `model3d::arc_placement` (`ArcPlacement::Zone/Follow/Chord`, nutzt `reveal_zone` und `follows_arc`/`BEND_SAGITTA`; das 3D
  `emit_opening_meshes_with` ruft sie jetzt auch). Ansicht (`plan/elevation/openings.rs`): je Bogen-Öffnung eine Gruppe, in
  einer Hilfsansicht abgewickelt gerechnet (x = Bogenlänge) und Punkt für Punkt auf die 3D-Lage gelegt (`ArcMap`: Sehne der
  Einzug-Zone, Bogen oder Sehne der Laibungen), dann orthogonal projiziert — Flügelteilung schräg gesehen nach der Lage auf dem
  Bogen verkürzt; sichtbare Seite nach der Tangente in Öffnungsmitte. Schnitt (`section/bands.rs` `arc_section_opening`, auch
  für Leibungs-Einzug und Formöffnungs-Umriss): mit Einzug auf der Zonen-Sehne, gebogen tangential an der Schnittstelle, schmal
  auf der Laibungs-Sehne. Die Wand selbst liegt in Schnitt/Ansicht (Eingabe ohne Schichtbänder) jetzt ebenfalls auf der
  Zonen-Sehne (`WallIn::chord_zones` → `chord_walls`); Pfeiler/Brüstung/Sturz der Zonen-Teilwand bekommen die radiale Gehrung
  nur am Ende vor/hinter dem Loch. Tests `fenster_in_bogenwand_wie_im_3d` (Glas-Ausdehnung = 3D-Glas auf der Aussenfläche
  projiziert, Flügelteilung auf Bogen/Sehne; gerade, gebogen, mit Einzug) und `fenster_mit_schichteinzug_in_bogenwand_auf_der_sehne`
  (Wandschnitt = Sehnen-Band, Rahmen darin wie bei gerader Wand). Golden `komplex-ansicht-ansicht-sued` (Erker-Fenster und
  -Wand auf der Sehne), `komplex-model3d` unverändert. Musterhaus komplex Ansicht Ost/Süd und Schnitt B-B per CLI-SVG `--hatch`
  in Chromium verglichen (Linux): Fenster sitzen im Wandloch (vorher schräg gesehen ≈ 1–2 cm daneben). Offen: Mac-Gegenprobe;
  Deckenstirn im Erker folgt weiter dem Bogen und ragt im Schnitt an der Zonen-Sehne ≈ 2,5 cm in die Dämmung (wie im 3D);
  an den Zonenenden zeigt die Ansicht senkrechte Kanten (Stufe Sehne/Bogen ≈ 2 mm, wie im 3D) — erledigt 15.11. (später), s. unten.
  **15.11. (Entscheid Maintainer):** UG-Erkerfenster `ug-f4` über `eg-f5`/`og-f6` gelegt (Lage 1.2, Breite 1.0): getrennte 1-m-Sehnen statt der 2-m-Facette, der Erker bleibt rund. Goldens komplex (Grundriss UG/EG/OG, Ansicht Süd, 3D) nachgeführt; CLI-SVG UG/EG 1:100 in Chromium angesehen (Linux), Mac offen.
  Stand 15.11. (später): Erker-Geometrie stimmig. (1) EINE Quelle der Sehnen-Zonen `model3d::arc_zones`: je Öffnung mit
  Schichteinzug ihre `reveal_zone`, vereinigt über alle deckungsgleichen Bogenwände (gleicher Mittelpunkt, Bänder radial
  überlappend — die Erkerwände aller Geschosse); Öffnungen ohne Einzug, die eine Zone anschneiden, erweitern sie und liegen
  dann ganz auf der Sehne. Entscheid Vereinigung statt Raster: ein Raster lässt verschieden breite oder versetzte Fenster
  weiter auf verschiedenen Sehnen (waagrechte Kante bleibt), die Vereinigung gibt durchgehende senkrechte Facetten über alle
  Geschosse, auch die Decke dazwischen liegt auf der Flucht. Folge im Musterhaus komplex: UG-Fenster (2.2–3.1) und EG/OG-Fenster
  (1.2–2.2) überlappen mit Zuschlag → eine 2-m-Facette (Pfeilhöhe ≈ 25 cm) über alle drei Geschosse, die zweite Facette
  (3.6–4.6) läuft auch durchs UG. Wer runder will, legt die Fenster übereinander. `arc_placement`, `chord_walls`
  (`WallIn::chord_zones` jetzt auch mit Schichtbändern, mehrere Öffnungen je Zone, Zone ohne Öffnung = gerade volle Wand),
  `wall_body`, Grundriss (`Unroll`) und Einbauteile lesen sie. (2) Deckenrand/Auflager [178]: Kern-Aussenkante in der Zone
  gerade (`wall_arc::face_polyline`, Abzugs-Streifen `bearing::arc_cutters`), Decken „wie Deckenumriss“ und der Deckenrand im
  Grundriss verlieren die Kappe zwischen Sehne und Bogen (`bearing::zone_caps`, `plan_ceiling_ring`) — 3D, Schnitt, Ansicht,
  Grundriss. (3) Stufe an den Zonenenden: Gehrung zwischen zwei Sehnen jetzt auf der Winkelhalbierenden (alle Versätze
  treffen sich dort; an Laibungen weiter radial), Teilstellen knapp neben einem Zonenende entfallen (kurze Stücke mit gekreuzten
  Gehrungen: ifcopenshell verlor sonst einen Körper); im Grundriss enden Sehne und Bogen im Schnittpunkt der
  Sehnen-Parallelen mit dem Versatzkreis (`wall_arc::zone_face_end`). (4) IFC: Mengen der Bogenwand mit Zonen (Kreissegmente,
  `ifc_quantities::arc_wall_quantities`), Öffnungskörper in der Zone auf der Zonen-Sehne in der Rahmenlage. 3D-Cache:
  Schlüssel einer Bogenwand mit den Ständen aller Bogenwände und ihrer Öffnungen, Auflager-Memo mit den Zonen. Tests
  `model3d/arc_zone_tests.rs` (Zonen fluchten, Decke nicht vor der Kern-Aussenkante in 3D/Schnitt/Grundriss ± 0,1 mm, keine
  Stufe > 0,1 mm zwischen Nachbarstücken, kein Stück mit gekreuzten Gehrungen, Zonenende auf Bogen und Sehne),
  `bogenwand_mengen_mit_sehnen_zone`. Goldens `komplex-grundriss-*` (Erker: Facetten, Deckenrand), `komplex-ansicht-ansicht-sued`,
  `komplex-model3d` nachgeführt. Musterhaus komplex Grundriss EG/UG, Ansicht Ost, Schnitt B-B per CLI-SVG `--hatch` in
  Chromium angesehen (Linux). Offen: Mac-Gegenprobe (3D/Metal nicht angesehen); UG und EG haben verschiedene Wandtypen
  (Dicke), darum bleibt an der Geschossgrenze eine Kante der Aussenfläche und die Facetten-Knicke liegen wenige cm versetzt;
  Dachrand `dach-erker` folgt weiter dem Bogen (Rand im Modell gezeichnet, nicht an die Wand gekoppelt); IFC-Profil-Weg
  (Bogenwand ohne Dachanschluss) schreibt den Körper weiter als reinen Bogen (Facetten nur im Netz-Weg).
- ◐ **[228]** In Blender öffnen / .blend speichern (12.11., Wunsch Maintainer; Stand 13.11.: umgesetzt und mit bpy 5.3 im Linux-Container geprüft, Mac-Gegenprobe offen). Skript `render_dossier.py` hat Modus `save` (`scene.json` `mode`, Argument `--mode`): Szene wie fürs Rendering bauen, Objekte in Collections nach Bauteil (Geschosse, Wände, Decken, Dächer, Fenster und Türen, Treppen, Stützen, Extrusionen, Bäume, Gelände, Kontext, Dossier) mit lesbaren Namen (`Wand eg-aw-s`; Zuordnung aus Knotenname/`extras` des GLB, keine Export-Änderung nötig, `doc/RENDER-SZENE.md`), Kamera `Dossier-Kamera`, Himmel `Dossier-Himmel`, `pack_all`, `save_as_mainfile`; 3D-Fenster der Datei in Material-Vorschau mit Blick durch die Kamera. Dialog: «Als .blend speichern …» (Blender im Hintergrund, dann nativer Speichern-Dialog) und «In Blender öffnen» (Datei im Arbeitsordner bauen, dann Blender MIT Oberfläche auf die Datei, ohne Warten); Browser: ZIP mit Anleitung für `--mode save`. Neuer Tauri-Befehl `blender_open`, Electron `blender:open`. CLI `dossier-cli … blend --out x.blend`. Abweichung: «Öffnen» startet Blender nicht mit dem Skript, sondern mit der fertigen .blend (zuverlässiger, selbe Datei wie «Speichern», Layout steckt in der Datei). Offen: Mac/Windows-Gegenprobe der Start-Befehle (`blender_open` nur im Linux-Container kompiliert/getestet), Blender-GUI nicht gesehen (Linux ohne Anzeige); Datei liegt nach «Öffnen» im Temp-Ordner (in Blender «Speichern unter»). · S
- ◐ **[227]** Kontextgebäude auf dem Gelände, Baugrube im Rendering ausblenden (12.11., Befunde der Mac-Gegenprobe [211]). (1) Kern
  `context_ground.rs`: jedes zusammenhängende Gebäude eines Netzes (`importedMesh`, auch mehrere Häuser in einem Netz) wird senkrecht auf den
  tiefsten Punkt des gewachsenen Geländes unter dem Fussabdruck gesetzt (Fusspunkte, Fusskanten, Raster innen; Sockel reicht bis dorthin, kein
  Spalt talseitig); Befehl `contextToTerrain {ids}` (`cmd_context.rs`, ein `Replace` je Netz); Store `groundContextObjects`; Knopf „Aufs
  Gelände setzen“ in der Objekt-Info der Netze (`ContextObjectProps`); beim Hinzufügen eines Geo-Imports (Kataster/swisstopo/OSM,
  `isGeoBuildingMesh`) automatisch im selben Undo-Schritt wie der Import (`siteSlice.addToContext`). Musterhaus komplex: Nachbarn ruhen auf dem
  Gebäude ganz ausserhalb des Netzes (bis 50 m) nehmen die Randhöhe des nächsten Netzrands (13.11.); Gelände; die Höhenlinien reichen dafür bis x −44 … 54 (vorher −16 … 32, Nachbarn lagen ausserhalb des Netzes; Goldens `komplex-*` neu). (2)
  Rendering: Option „Baugrube ausblenden (hinterfüllt)“ (Vorgabe an; `RenderOptions.backfilled`, `scene.backfilled`, CLI `--excavation` lässt
  sie stehen): das Paket enthält das gewachsene Gelände ohne Aushub (`MeshOptions.backfilled`, Kern `mesh_data.rs`, 4. Argument von
  `meshExportData`, `excavation::terrain_original_mesh`), das normale 3D und die Klasse „07 Baugrube“ bleiben unberührt. Geprüft: Rust-Tests
  (`context_ground`, `mesh_data`), vitest (Paket, Szene, Store, Beispielprojekt), echter Cycles-Lauf mit `bpy` (CPU) vorher/nachher.
  14.11.: Nordhäuser des Musterhauses stehen bereits auf der Randhöhe (−0.35 m, Netzrand y = 21, Häuser bei y 34–43; Angabe „z = 0“ war veraltet);
  Test „teilweise ausserhalb“ ergänzt (nur der Teil im Netz bestimmt den Fuss). Hinterfüllt schneidet das Gelände nicht mehr durchs Haus:
  `terrain_original_mesh` schneidet es innerhalb der untersten Bodenplatten (Decken mit UK ≤ tiefste UK + 1 m) senkrecht auf deren UK aus
  (`excavate` mit künstlicher Spundwand-Baugrube; Test `hinterfuellt_schneidet_nicht_durchs_haus`). **Offen:** Fortsetzung des Geländes
  ausserhalb des Netzes ist flach (Randhöhe), keine Neigungsfortsetzung; Bodenplatten mit Löchern/Wand-Fundamente schneiden nicht aus;
  nicht in der Tauri-App/auf dem
  Mac, Dialog nicht im Browser geklickt. · S
- ◐ **[207]** Schwarzplan / Situationsplan 1:500 (12.11.): Modelldarstellung mit `situation` (`ModelViewOption.situation`, Kern
  `plan/situation.rs`) ersetzt im Grundriss die Bauteile durch den gefüllten Umriss des eigenen Gebäudes (Wände/Decken/Körper ab
  Erdgeschoss + Dächer mit Überstand, Klasse „83 Situation Gebäude"), gefüllte Grundfläche der Kontextnetze ([181], auf ihrer Klasse;
  grau, im Schwarzplan schwarz) und Nordpfeil + Massstabsbalken (Klasse „84 Planzeichen"); Raster/Wände/Möbel/Text/Masse/Koten/
  Schnittmarken über die Klassen der Vorlage aus, Parzelle, Strassen, Höhenlinien (enden an den Gebäuden) und Bäume bleiben. Standard-
  Ressourcen „Situation WBW 1:500"/„Schwarzplan 1:500" (Vorlagen + Modelldarstellungen, Ressourcen-Tab „Modelldarstellung"),
  Musterhaus komplex: Ausschnitt „Situation 1:500" nutzt sie, mit fünf Nachbargebäuden (Schnitte/Ansichten blenden Klasse 12 aus); CLI `plan --snapshot "Situation 1:500" --hatch`.
  Kataster 2D (13.11.): geschlossene Polylinien/Rechtecke der Klasse „Gebäude" (Code „12" oder Name mit Gebäude/Building) werden wie
  Kontextgebäude gefüllt (grau, im Schwarzplan schwarz), die der Klasse „Gewässer" („17") hellblau; Ring ganz in einem anderen derselben
  Klasse = Innenhof als echtes Loch (gerade/ungerade, `polygon_bool::nest_even_odd`, i_overlay), auch bei eigenem Gebäude und Netzen
  jetzt Brücken-Ring statt weisser Fläche darüber. DXF-Import: Layer „Gebaeude/Gebäude", „Strassen/Strassennamen", „Gewaesser/Gewässer"
  (u. ä., `import_context::known_context_class`) landen auf den Klassen 12/11/17 (gleichnamige Projekt-Kategorie geht vor);
  Strassennamen = Text auf der Klasse „Strasse" (kein eigener Code: TS-Tabelle `contextCategories.ts` müsste mit). Test: Fixture
  `src/io/testdata/kataster.dxf`, Rust (`situation_tests`, `import_drawing_tests`, `polygon_bool`), vitest `katasterImport.test.ts`.
  Benennung Zahlen-Layer (13.11.): rein numerische Layer-Namen bekommen beim Import „Code Bezeichnung"
  (`import_context::layer_display_name`, Tabelle `NUMERIC_LAYER_LABELS`); Tabelle noch LEER (das Beispiel „1110 Gebäude“ stammte vom
  Koordinator, nicht vom Maintainer, und ist nicht belegt) — Codes erst eintragen, wenn die Layer-Liste eines echten Kataster-DXF vorliegt; Bezeichnung ist Projektdaten-Text
  (Rust, kein `t()`/en). Zweiter Import (13.11.): der Abgleich findet
  eine Kategorie „4711 Bezeichnung" auch unter dem Roh-Layer „4711" (`layers::add_code_prefixes`, ganzer Name geht vor), keine Doppelanlage.
  Reste (13.11.): Gewässer als feine waagrechte Parallelschraffur (1.2 mm Abstand auf dem Papier, Diagonal-Muster Winkel 90, `situation::water_hatch`) —
  in Tusche bleibt die Schraffur (Post: bunte Fläche → Papier, bunte Linien → Tinte), farbig hellblau mit blauer Schraffur; Begründung: Plangrafik-Brauch
  für Wasser, und Tusche kennt sonst nur Grau/Schwarz/Weiss (Grau würde mit Kontext-Gebäuden verwechselt). Kataster-Umrisse: gefüllte Ringe
  (Gebäude, Gewässer) zeichnen im Situationsplan keine Zeichnungslinien mehr (`situation::drawing_is_filled`), die Fläche trägt den feinen
  Umriss wie die Kontextnetze (Situation grau 0.1 mm, Schwarzplan schwarz). Ausschnitte: neu angelegte Klassen (z. B. 17 durch den
  Kataster-Import) werden im Import in allen `viewSnapshots` eingeblendet (fehlender Code = aus), Beispiel-Ausschnitte „Situation 1:500" mit „17";
  die Standard-Vorlagen „Situation WBW"/„Schwarzplan" blenden 11/12/17 nicht aus (Test). Strassennamen = Text auf Klasse 11, sichtbar mit ihr.
  Strassennamen entlang der Achse (14.11.): Einzeltext auf Klasse „11“ mit Linie/Polylinie/Bogen derselben Klasse und Ebene in der Nähe
  (≤ 4 Schrifthöhen, Richtung ≤ 35° von der DXF-Drehung) wird in `plan/text_curve.rs` Zeichen für Zeichen auf die Kurve gesetzt (mittig auf dem
  nächsten Abschnitt, Grundlinie parallel im DXF-Abstand, nie kopfüber, Vorschub = Schriftbreite) und von `plan/drawings.rs` als gedrehte
  `drawingText`-Primitive je Zeichen ausgegeben: Szene, SVG, Druck-SVG/PDF und DXF lesen dasselbe; gerade Achse, keine Achse, Mehrzeiler/Spalte/Hinweislinie
  bleiben ein gerader Text. Schrifthöhe wie bisher (`paperHeight` oder DXF-Höhe). Test: `text_curve::tests`, `drawings::tests::strassenname_folgt_der_achse`.
  14.11. Zeichnungs-Cache: der Stand eines Einzeltexts der Klasse „11“ schliesst den Stand aller Achs-Kandidaten (Klasse „11", Linie/Polylinie/Bogen) seiner Ebene ein
  (`drawings::road_axes_stamp`, in `domains.rs` wie bei Achsrastern): Achse ändern/dazu/weg rechnet den Namen neu, Wand verschieben lässt alle Stücke stehen
  (Test `cache::tests::strassenname_folgt_achse_im_cache`; Goldens unverändert).
  Offen: Bildschirm-Szene der nativen Fläche zeichnet gedrehte Einzeltexte nicht im Glyphen-Pass ([194], Webview/Vektor-Glyphen springen ein; nicht auf dem Mac
  geprüft);
  echte Kataster-DXF (Layer-Namen je Kanton) nicht geprüft; nicht in der Tauri-App/auf dem Mac geprüft. · M
- ◐ **[208]** Wettbewerbs-Abgabe (12.11.). Umgesetzt: **Bild-Element im Layout** (`Layout.images`, `LayoutImage`: PNG/JPEG als Data-URL wie
  `ContextImage.src`, Rahmen in Papier-mm, Zuschnitt als Anteile; Kern `layout_image.rs`: Dateikopf, Seitenverhältnis, Zeichen-/Klipp-Rechteck,
  dpi; Blatt: Knopf „Bild“, verschieben, Ecke skalieren mit festem Seitenverhältnis, HUD mit Breite, Zuschnitt, dpi-Warnung unter 100;
  PDF: Original unverändert eingebettet, JPEG ohne Neukompression, auf den Rahmen geklippt). Rendering-Dialog: „Ins Layout einsetzen“
  (Ziel-Blatt wählbar, vorgewählt das offene). **Plakat-Vorlagen** A0/A1 hoch/quer (`MasterLayout.template`, `posterHeader`,
  `viewportScaleLabels`, `guides`; Kern `layout_poster.rs`: Ränder, Spalten 4–8, Hilfslinien nur am Bildschirm, Kopfzeile mit Kennwort-Feld
  und „Plan x/n“ unter den Plakat-Blättern, Massstab unter jedem Viewport), wählbar im Dialog „Neues Layout“. **Anonymität**
  (`Project.competition`: anonym + Kennwort; Mappe, Abschnitt Publikation): Plankopf zeigt das Kennwort statt Projekt/Bearbeiter, PDF-Info
  nur Titel = Kennwort, Producer/Datum längengleich neutralisiert (`export/pdfInfo.ts`; jsPDF schreibt sie sonst immer), Dateinamen und
  Schriftfeld des Einzelplan-PDF mit Kennwort. **Publikationssatz „WBW-Abgabe“** (Knopf in der Publikation): alle Plakate als ein PDF,
  Format über den Satz-Editor auf Einzeldateien umstellbar. Tests: Rust (`layout_image`, `layout_poster`, Titelblock anonym), vitest
  (`layoutImages`, `posterTemplates`, `layoutPdf.images`), e2e `competition` (A1 quer aus Vorlage, Bild, anonym, PDF). Anonymität vollständig (13.11., zentral `export/competitionIdentity.ts` + Kern `competition.rs`): Berichte (Fläche, Raumbuch, Kosten,
  Öffnungen, Bauteile, Programm) mit Kennwort im Kopf/CSV und anonymem PDF; IFC4/2x3 (Kern-Sammler: Kennwort statt Projektname in
  IfcProject/IfcBuilding und Dateiname, fester Zeitstempel; Schreiber `fileio/ifc_export`: leerer Zeitstempel = anonym → Organisation/Person/
  Anwendung „-“, Kopf ohne Autor/Programm), DXF/DWG (Header war schon neutral, Blattnamen der Projekt-Layouts → „Blatt n“), STEP (Zeitstempel fest),
  Blender-`scene.json`, Dateinamen (Panels, CLI, Export-Dialog). Geprüft ohne Befund: SVG, Druck-SVG, OBJ/MTL/STL/glTF/GLB, CSV-Bauteilliste, PNG (Bild-Export
  schreibt keine tEXt-Chunks). Test `competitionAnonymous.test.ts` (alle Formate, Gegenprobe ohne Anonymität). Blatt-Oberfläche (13.11.): **Hilfslinien als Fang** (Viewport, Bild, Tabelle,
  Aufziehen: Kanten und Mitten rasten auf Linien ein, 8 Bildschirm-Pixel, Alt = aus; gefangene Linie hervorgehoben; `ui/sheetSnap.ts`),
  **frei setzbar** (aus dem Lineal ziehen, Zug ausserhalb des Blatts oder Doppelklick löscht, Panel „Hilfslinien“ mit Zahlenfeldern;
  am Masterlayout gespeichert, `MasterLayout.guides` — kein neues Modellfeld, gilt für alle Blätter des Masters, ohne Master nicht setzbar),
  **Bild-Zuschnitt durch Ziehen** (Knopf „Zuschneiden“ oder Doppelklick, Griffe am Ausschnitt, Original bleibt stehen, ein Undo-Schritt je Zug).
  Tests: vitest `sheetSnap`, `sheetGuides`, e2e `competition`. Offen: Legenden-Verschieben (Legende hat keinen Zug am Blatt); Hilfslinien je Blatt statt je Master; Bild in DXF/IFC-Exporten nicht; Eigenschaftssatz-Namen `Dossier_Qto_…` im IFC (Programmkonvention) bleiben; Download-Namen im Browser ohne Tauri-Dialog; grosse Bilder: jede
  Blatt-Änderung (Viewport verschieben …) ersetzt das ganze Layout samt Data-URL im Op und im Verlauf (wie `ContextImage`) — bei vielen MB Bilder
  in eine eigene Sammlung auslagern; nicht in der Tauri-App/auf dem Mac geprüft. · M
  **Freie Texte auf dem Blatt (15.11.)**: nichts Neues gebaut — die Textspalte (`textbox`, Rich-Text auf der Blatt-Ebene, Papier 1:1) war schon da und
  lag auf Ebene + Klasse; ergänzt: Knopf „Text“ in der Blatt-Leiste (startet die Textspalte), Vorgabe-Schrift wächst mit dem Blatt (A2 5 mm, A1 7 mm, A0 10 mm statt
  immer 3.5 mm; `sheetTextHeightM`), **Blocksatz** (`Align::Justify`; Kern `text_layout::justify_fragments`: umbrochene Zeilen ausser der letzten des
  Absatzes, Wörter an festen Lagen nach den Metriken der gebündelten Schriften; Bildschirm-Szene und Druck-SVG/PDF), Ausrichtung auch in der Werkzeugleiste des
  Inline-Editors (die Kopfleiste ist beim Tippen vom Hintergrund verdeckt; links/zentriert/rechts/Blocksatz), **Umbruch nach echten Schriftbreiten** statt 0.55 × Zeichen
  (Spalte füllt sich wie im Editor), zentriert/rechtsbündig in der Spalte auch am Bildschirm (stand vorher am Anker), **Fang**: Papierrand, Hilfslinien des Masters und
  Rahmen von Viewports/Bildern/Tabellen als Objektfang der Blatt-Ebene (`model/sheetFang.ts` → `setSheetSnapSegments`; gilt für Textspalte und alle Zeichenwerkzeuge,
  Endpunkt/Mitte/Kante/Schnitt, nicht nur 8-px-Einrasten), **Anonymitäts-Prüfung** erkennt Namen/E-Mail, die über Run-Grenzen laufen („Atelier“ + fett „Brunner AG“).
  Tests: Rust `text_layout` (Blocksatz), `plan::text` (Spalte, Blocksatz in der Szene), `competition` (Rich-Text über Runs); vitest `sheetFang`, `state/sheetText`
  (Textspalte → Ops → Undo/Redo, Klasse, Vorgabegrösse), `planToPrintSvg.sheetText`; e2e `sheetText` (Knopf, Rahmen, tippen, Blocksatz, Undo, PDF `pdftotext`, Schrift
  eingebettet, Umbruch). DXF (15.11., [200]): Textspalten/Absätze als `MTEXT` (Breite, Anhängepunkt, Absatz-Ausrichtung inkl. Blocksatz `\pxqj;`, Schrift/fett/kursiv in Teilen), zentrierte/rechte Einzelzeile als `TEXT` mit 72/11. Offen: nicht in AutoCAD/BricsCAD geöffnet (CAD bricht nach eigenen Metriken um);
  Blocksatz am Bildschirm im Editor per CSS, in Szene/PDF per Metrik ohne Kerning (±1 mm Abweichung zum Editor möglich); Objektfang an Tabellen nur mit fester Höhe,
  Legenden fehlen; die vier Griffe an der gewählten Textspalte (Plan-Ansicht) sind sichtbar, das Breite-Ziehen damit ist nicht geprüft (Objekt-Info zeigt für Text Breite/Höhe 0); Vorgabe-Klasse ist die aktive Klasse (nicht eigene „Beschriftung“); nicht in der Tauri-App/auf dem Mac geprüft.
  **Anonymitäts-Prüfung des Freitexts (14.11.)**: vor PDF-/SVG-/DXF-Export, Direkt-Export (CSV/IFC/OBJ/STL/GLB) und Publikationssatz einer
  anonymen Abgabe sucht der Kern (`competition.rs`, Bindung `anonymity_findings`, TS-Fassade `export/competitionCheck.ts`, Tor
  `state/anonymityGate.ts`) in jeder Zeichenkette des Projekts (Raum-, Geschoss-, Ebenen-/Klassen-, Gruppen-, Block-, Layout-/Blattnamen, Textobjekte,
  Bild-Dateinamen, Bauteil-/Schraffurnamen …; ausser Ids, Data-URLs und den Quellfeldern selbst) nach Projektname, -nummer, Titelblock-Büro/-Bearbeiter,
  Adresse des Standort-Bezugs, Projekt-Dateiname und der neuen Liste `competition.identifiers` („Weitere Angaben“ in der Mappe: Büro, Namen, E-Mail,
  Telefon), dazu E-Mail-Adressen und Telefonnummern an sich. Ganze Wörter, Gross-/Kleinschreibung, Umlaute (ä = ae = a) und Trenner egal; Phrase ab 3,
  Einzelwort ab 5 Zeichen, allgemeine Wörter („Haus“, „Wohnen“ …) und blosse Zahlen zählen nicht. Dialog `ui/AnonymityDialog.tsx` listet Bereich,
  Fundstelle, Text, Begriff; „Trotzdem exportieren“ / „Abbrechen“ (Overlay, kein `window.confirm`). Kopfdaten waren schon leer (PDF-Info nur Kennwort,
  Producer/Datum neutralisiert — auch „Dossier“ bleibt weg, weil Programm + Version + Datum die Herkunft eingrenzen; IFC-Kopf/IfcOwnerHistory, DXF-Kopf, STEP):
  keine Lücke gefunden. Tests: Rust `competition` (Treffer je Textort, Fehlalarme, Umlaute), vitest `competitionCheck`, e2e `competition`. **Nachtrag (14.11., spät)**: das Tor
  hängt jetzt an allen Export-Einstiegen der Oberfläche: Berichte (Fläche, Raumbuch, Kosten, Öffnungen, Bauteile, Programm, Flächenbilanz) als CSV und PDF,
  3D-Bild-PNG, Rendering (PNG, .blend, Blender-Paket), Kamerafahrt-Video, Layout-Ordner-PDF, KI-Werkzeug-Speichern; `runWithAnonymityGate` für
  Knopf-Handler, Dateiname der Ausgabe wird mitgeprüft. Bild-/Video-/Rendering-Dateinamen nutzen jetzt den Kennwort-Namen (`exportProjectName`)
  statt `project.name`. Vitest `state/anonymityGate.entries.test.ts` gleicht ab: jede Oberflächen-Datei mit Datei-Ausgabe ruft das Tor auf
  (neue Einstiege fallen dort auf). CLI: bei anonymer Abgabe prüfen plan/section/elevation/dxf/dwg/ifc/obj/stl/glb/gltf/step/schedule/kennzahlen/
  raumprogramm/render/blend/model3d den Freitext, Treffer auf stderr, Exit-Code 3, `--ignore-anonymity` übergeht (Test in `cli.test.ts`);
  KI-/MCP-Werkzeug `export` ohne `save` liefert bei Treffern nichts aus (Argument `ignoreAnonymity`). Der Projekt-Dateiname ist auch nach
  Autosave-Wiederherstellen und Browser-/Electron-Start-Öffnen Suchbegriff, beim „Neu“ wird er gelöscht. Offen: `dossier-cli convert` prüft nicht;
  BCF-Export bewusst ohne Tor; nicht in der Tauri-App/auf dem Mac geprüft (Dialog-Weg nur per Code-Abgleich, kein e2e für die neuen Knöpfe).
  UI-Review 14.11.: Anonymitäts-Dialog: Anführungszeichen einheitlich („…“ / “…”), englische Bereichsnamen gross geschrieben; Fokus startet auf „Abbrechen“, Tab-Reihenfolge ×, Abbrechen, Trotzdem exportieren. Fundstelle lesbar (14.11. spät): Elementart „Name“ · Feld, z. B. Material „Wärmedämmung“ · Name (`ui/anonymityPlace.ts`, Mapping der Kern-Pfade mit `t()`, Test de/en; Kern liefert weiter den Pfad).
  **Abgabe-Review 14.11. (Beispiel „Wettbewerb“, Plakat A1 quer aus Vorlage, Präsentationsplan 1:200, anonym „FALKE 7“, PDF per Playwright/Chromium, mit `pdftoppm` angesehen; nicht auf dem Mac geprüft).**
  Behoben: (1) Grundriss im Plakat-Viewport links/oben beschnitten: der Rahmen (Kern `presentationSheet`) wurde ohne die verknüpfte Ansichtsvorlage
  gerechnet, die Schattenstudie des Projekts (Grundriss zeichnet sie, Kern-Ausmass nicht) sprengte ihn — Grundrisse des Präsentationsplans
  blenden die Klasse „Schatten“ (08) aus, die Abfrage bekommt die Vorlage (`template`); Test `presentationSheet.test.ts`. (2) Massstabsangabe des Masters
  („1:200“) lag auf dem Titel unter dem Viewport — Titel steht jetzt rechts daneben auf derselben Grundlinie (`scaleLabelMetrics`).
  Offen (nach Gewicht): a) Plakat enthält weder Situation 1:500 noch Kennzahlen-/Baurecht-Tabelle noch 3D-/Axonometrie-Bild — der Präsentationsplan
  setzt nur Grundrisse, Ansichten, Schnitt; Situation und Tabelle müssten als Viewport/Tabelle mit ins Plakat ([207], [255]). b) Anordnung nutzt das Raster
  nicht: Inhalt klein und mittig geballt, grosse Leerflächen (A1 bei 1:200 ≈ 40 % belegt), Zeilen nicht an Spalten ausgerichtet; Schriftfeld des Masters
  (70 × 30 mm, Text ~2 mm) steht zusätzlich zur Plakat-Kopfzeile unten rechts und ist redundant. c) Schriften nicht eingebettet (jsPDF Standard-14: Helvetica/Times/
  Courier ohne Einbettung; Druckereien verlangen oft eingebettet; BEHOBEN 14.11., s. unten); keine PDF-Ebenen-Prüfung am Plotter. d) Ansichten: keine Terrain-/Bodenlinie, Kotenmarken
  winzig (< 1 mm Schrift), Fenster grau ohne Rahmenzeichnung; Massketten im Grundriss überlagern sich vereinzelt („12.39“/„4.80“ links, „1.20“ in der Wand E.09).
  e) Anonymitäts-Dialog zu Recht bei „Hofwiesenstrasse“ in der Kontext-Zeichnung des Beispiels (Adresse) — Beispiel enthält die Adresse im Klartext.
  f) Schwarzplan/Nachbarn grau nicht beurteilbar (Situation nicht auf dem Plakat). Dateigrösse 98 KB (ohne Bild), Rand/Satzspiegel (Raster 6 Spalten) in Ordnung,
  Kennwort-Feld und „Plan 1/1“ lesbar, kein Projektname/Büro im PDF (Gegenprobe e2e `[208]`).
  **Plakat als Grundgerüst (14.11., zu a/b/f)**: Präsentationsplan mit Plakat-Vorlage setzt jetzt auf dem Spaltenraster (Kern `presentation_poster.rs`, Skyline-Packung,
  Rahmen = ganze Spalten): Situation 1:500 (Vorlage „Situation WBW“, Erdgeschoss-Ebene, Nordpfeil/Massstabsbalken aus der Modelldarstellung) zuerst oben links, Grundrisse/
  Ansichten/Schnitt im festen Massstab (Vorgabe 1:200), Blatt-Tabellen Kennzahlen SIA 416 (HNF/NNF/NF/VF/FF/GF/GV) und Baurecht-Nachweis ([255]) mit Titel, dazu ein Rahmen fürs
  3D-Bild (letztes Layout-Bild des Projekts, sonst beschrifteter Platzhalter „3D-Bild hier einsetzen“, nichts erfunden); Dialog-Abschnitt „Plakat-Inhalt“ (je abwählbar).
  Zu viel Inhalt ⇒ zweites Plakat („Plan 2/2“), nie kleinerer Massstab. Wettbewerb-Beispiel A1 quer: ein Blatt, > 70 % der Satzspiegelfläche belegt (Test). Schriftfeld des Masters
  entfällt bei Plakat-Vorlagen (Kopfzeile mit Kennwort + „Plan x/n“ genügt; Bildschirm und PDF). Tests: Rust `presentation_poster`, vitest `presentationSheet.test.ts`.
  Offen: Rahmen sind so breit wie der Inhalt samt Masskette/Kontext (Musterhaus komplex: 2 Spalten je Grundriss, viel Weissraum im Rahmen, 2 Blätter); Anordnung mischt
  Gruppen (Pläne neben Situation, Ansichten darunter) statt strenger Zeilen; Tabellen-Spaltenköpfe „Reserve/Erfüllt“ eng; Baurecht-Zeilen mit „—“ bei fehlenden Vorgaben;
  Lage der Tabellen/des Bildes nicht von Hand fixiert (Neuberechnung nur durch Neuerstellen); nicht in der Tauri-App geprüft.
  **Plakat in strengen Zeilen (14.11., zu den Offen-Punkten oben)**: `presentation_poster.rs` neu: Zeile 1 Situation (3D-Bild rechts daneben), Zeile 2 Grundrisse,
  Zeile 3 Schnitte + Ansichten, Tabellen rechts neben der letzten Zeile (sonst eigene Zeile); Gruppen brechen ausgeglichen um (4 Grundrisse ⇒ 2 + 2), passt eine
  Gruppe nicht mehr aufs angefangene Blatt, beginnt sie ganz auf dem nächsten. Rahmen so breit wie der Inhalt, links an einer Spaltenkante (nicht volle Spalten).
  Neues Modellfeld **`LayoutViewport.center`** (Bildmitte im Modell; Kern `viewport_center`, Blatt `LayoutSheet`, PDF `layoutPdf` mit Klipp auf den Rahmen):
  Grundrisse haben gleiche Rahmengrösse und gemeinsame Mitte (deckungsgleich), Schnitte/Ansichten gleiche Höhe und Höhenmitte (±0.00 einer Zeile auf einer Linie).
  Ausschnitt = Inhalt, beschnitten auf Bauteile (`house`-Ausmass des Plan-Puffers) ± 20 mm Papier (Bemassung), Situation ± 80 mm um das Haus (1:500 ⇒ 40 m) —
  Kontext/Gelände wird beschnitten statt den Rahmen aufzublasen. Baurecht-Tabelle: „Erfüllt“ mittig (`Col.center`, Ausrichtung „c“ in Blatt/PDF/DXF), Zellen-Innenabstand
  wächst mit der Schrift. Tests: Rust `presentation_poster` (Zeilen, Umbruch, Gruppen nicht zerreissen), `presentation_sheet` (Ausschnitt, deckungsgleich/gleiche Höhe),
  `sheet_viewports::eigene_bildmitte`, `sheet_table::baurecht_tabelle_plakat_koepfe_mit_luft`; vitest `presentationSheet.test.ts` (Wettbewerb + Musterhaus komplex: Gruppen je Zeile,
  Spaltenkanten, deckungsgleich, ±0.00, Weissraum im gemeinsamen Grundriss-Rahmen < 15 %). Angesehen: Wettbewerb-PDF A1 vorher/nachher (Chromium, `pdftoppm`), Musterhaus komplex am Blatt
  (2 Plakate: Situation + Bild, Grundrisse 2 × 2 | Ansichten, Schnitt, Tabellen). Offen: Musterhaus komplex — Grundrisse ~164 mm breit belegen je 2 von 6 Spalten, rechts bleibt ein
  Drittel frei (feineres Raster oder 8 Spalten prüfen); Plakat 2 nur halb gefüllt; Situation/Bild-Verhältnis fest (Bild nimmt den Rest der Zeile); Plakat-Inhalte weiter nur
  beim Erstellen berechnet; Baurecht-Zeilen mit „—“; nur Linux/Chromium, nicht in der Tauri-App.
  **Schriften im PDF eingebettet (14.11., zu c)**: alle jsPDF-Ausgaben (Blatt-/Plakat-/Ordner-PDF `layoutPdf.ts`, Einzelplan `exportPdf.ts`, Berichte `areaReport.ts`,
  Blatt-Tabellen) betten Inter und die im SVG gewählten Familien aus `public/fonts` ein (OFL, `NOTICE`): `export/pdfFonts.ts` lädt die WOFF2 (App: `fetch` auf App-Dateien,
  CLI/Tests: `setPdfFontLoader`), der Kern wandelt sie in TTF (`woff2_to_sfnt`, `core/src/woff2.rs` — Datei von render2d mitbenutzt, nicht doppelt), jsPDF bettet nur die
  benutzten Glyphen ein (`putOnlyUsedFonts`: auch die 14 Standardschriften entfallen); `font-family`-Listen im Druck-SVG werden auf die erste gebündelte Familie, sonst Inter,
  abgebildet. `buildAreaReportPdf` ist jetzt `async`. `pdffonts`: Inter „emb yes“, Umlaute/ß/²/³/±/Ø/–/„“ per `pdftotext` geprüft (vitest `pdfFonts.test.ts`). Plakat
  e2e: 59,6 KB (vorher ~48 KB, +11 KB für Inter normal+fett). Text steht im PDF nur noch als Glyphen-Nummern: e2e-/vitest-Prüfungen lesen ihn über `pdftotext`
  (`e2e/pdf.ts`, `export/pdfText.testing.ts`). Offen: kein Schnitt-/Kursiv-Rückfall für Glyphen ausserhalb der Latin-Teilmenge (z. B. Σ ≈ − im Bericht werden ersetzt, im SVG-Text
  fehlende Zeichen bleiben leer); PDF/X-Prüfung am Plotter nicht möglich; nur im Linux-Container/Chromium geprüft, nicht in der Tauri-App.
  14.11. Nachtrag Sicherheitsnetz: Poppler fehlt nicht mehr still — `check.yml` installiert `poppler-utils` (Jobs check + e2e); fehlt es in der CI (`CI=true`), scheitern die PDF-Text-Tests hart (`needPoppler()` in `pdfText.testing.ts`/`e2e/pdf.ts`), lokal werden sie übersprungen (vitest `it.runIf(RUN_POPPLER_TESTS)`, e2e `skipWithoutPoppler()`, im Referenz-Ablauf nur der Teil). Anonymitäts-/Kennwort-Prüfung (`competitionAnonymous`, `layoutPdf.images`) zusätzlich ohne Poppler über die an jsPDF übergebenen Zeichenketten (`captureJsPdfText`, Ereignis `preProcessText`).
  **Abgabe-Review d) behoben (14.11., Ansichten/Grundrisse 1:200, CLI-SVG `--hatch` in Chromium, nur Linux)**: (1) Bodenlinie der Ansicht ohne Geländenetz
  kräftig (0.5, bei 1:200 mit Massstabs-Stärken 0.38 mm; auch die Gelände-Silhouette) auf ±0.00 (Bezugsgeschoss), beidseits 10 mm Papier (mind. 2 m) über
  das Gezeichnete hinaus; Sockel/UG darunter weiss gedeckt; auf Klasse „02 Gelände" (ausgeblendet ⇒ ohne). Vorher dünn auf der Unterkante des Baus = unsichtbar
  (`elevation/mod.rs::ground_line`, Test `bodenlinie_auf_null_mit_ueberstand`). (2) Automatische Höhenkoten in Papiergrösse (2 mm Schrift wie das Element
  `kote`, vorher fest 0.2 m = 1 mm bei 1:200): `level_markers(…, scale)`, Abfrage `levelMarkers` mit 5. Argument, `levelMarkerPrimitives(…, scale)`,
  Blatt-Viewports (`sheet_viewports`); Test `hoehenkoten_in_papiergroesse`. (3) Fenster der Ansicht 1:200 mit Rahmen, Flügel, Glas und Laibungsschatten
  ([184] „mittel"): Ursache war die automatische Vergröberung des Grundrisses (mittel ab 1:200 = grob, [140]); in der Ansicht gilt sie erst ab 1:500, bei 1:200
  entfallen nur die gestrichelten Öffnungssymbole; Test `ansicht_fenster_bei_1_200_mit_rahmen`. (4) Masszahl „1.20" (Fenster Treppenhaus, Wettbewerb OG Süd)
  stand eine Zeile höher in der Wand: passt eine Zahl weder ins Segment noch daneben, rückt jetzt die Zahl des Nachbarsegments in dessen Segment weg
  („1.20 3.00"); geht auch das nicht und läge „eine Zeile höher" zum Gebäude hin (Ketten Süd/Ost), steht sie unter der Linie (`dim_auto_offsets*` mit
  `offset`, gleich in Plan, Griffen, DXF; Test `masszahl_weicht_nach_aussen_statt_in_die_wand`). Goldens: Ansicht muster (Ausmass +2 m je Seite) und komplex
  (Linienstärke). „12.39"/„4.80" links (14.11., BEHOBEN): nicht svg2pdf — gedrehte Texte landen im PDF genau wie im Druck-SVG (geprüft mit Testseite und
  `pdftotext -bbox`). Ursache im Kern: `dim_text_frame` wählte die Leserichtung senkrechter Ketten nach dem Vorzeichen von `cos` (≈ ±6e-17); schon
  1e-13 m Rauschen in x machte aus „aufwärts, Zahl links der Linie“ ein „abwärts, Zahl rechts“ — die Zahl der äusseren Kette sass im Zwischenraum Rücken an
  Rücken mit der Nachbarzahl (nur im Viewport-Plan, im CLI-SVG war x exakt). Jetzt `plan::drawings::dim_read_angle` (|cos| < 1e-9 = senkrecht, liest in
  Zeichenrichtung; auch DXF-Export und Radius-/Durchmessermass); Test `masszahl_senkrecht_unabhaengig_vom_rauschen`. Goldens unverändert. Nicht in der Tauri-App/auf dem Mac.
  **Nachtrag 14.11.**: (5) Schnitt: Bodenlinie ohne Geländenetz wie in der Ansicht kräftig (0.5) auf ±0.00 mit Überstand (gemeinsame Logik
  `elevation::ground_ref/ground_extent/ground_stroke`, `Output.ground`; Klasse „02 Gelände" ausgeblendet ⇒ ohne); UG/Sockel darunter bleibt geschnitten
  (keine weisse Fläche im Schnitt); Geländeschnittlinie mit Netz ebenfalls 0.5 (`SECTION_GROUND_MM`); Test `section::tests::bodenlinie_auf_null_mit_ueberstand`.
  Goldens: komplex-/muster-schnitt-a (komplex: Klasse „Gelände" dort aus ⇒ Bodenlinie entfällt wie in der Ansicht). (6) „Wettbewerb 1:200": `windows.simplified`
  (3 Linien) ist Absicht für den Grundriss (und Schnitt: Fenster als Linie); die Ansicht ignoriert die Option unter 1:500 und zeigt Rahmen/Glas wie ohne Vorlage
  (`elevation/mod.rs`, Test `ansicht_wettbewerb_vorlage_zeigt_rahmen`). Nur Linux, CLI-SVG in Chromium geprüft.
- [61] Raumprogramm gegen Modell und Flächennachweis SIA 416 als Tabelle/Layout-Element ([70]); Kennzahlen (GF, GV, HNF/GF, Fassadenanteil).
- 3D-Bilder für die Abgabe: hochaufgelöster PNG-Export (Perspektive, Axonometrie, Schatten), Sonnenstand; [205] Pausfolie.
- [199]/[204] Plan- und App-Review-Reste im Darstellungsbereich 1:500/1:200 schliessen.
- ○ **[211]** Rendern mit Blender/Cycles (Entscheid Maintainer 12.11.: zuerst Brücke, danach eigener Renderer [212]): Knopf/Befehl
  „Rendering…“ übergibt Modell (glTF mit Normalen/UV), Materialien (Farben, ambientCG-Texturen, Glas), Kamera der 3D-Ansicht und
  Sonnenstand/Himmel an ein installiertes Blender (`blender -b --python`, eigener Prozess, GPL bleibt getrennt), rechnet im Hintergrund
  mit Cycles (Metal auf dem Mac), zeigt Fortschritt und lädt das PNG zurück (als Bild ins Layout einsetzbar). Ohne Blender: klarer Hinweis
  mit Download-Link. · M
- ○ **[213]** Kameras und WASD (12.11., Wunsch Maintainer): Kameras als Modell-Elemente (Name, Standpunkt, Ziel, Augenhöhe,
  Brennweite/Bildwinkel, Perspektive/Axo, Uhrzeit für Sonne), im Grundriss als Kamerasymbol mit Griffen (Standpunkt, Ziel,
  Öffnungswinkel; Klasse „Kameras“ nach [180]), Liste im Navigator; „Aus aktueller Ansicht anlegen“, „Kamera öffnen“, Rendering [211]
  wählt eine Kamera. 3D-Navigation: WASD/Pfeile laufen, Q/E hoch/runter, Maus schauen, Shift schneller (Begehen-Modus wie Archicad/Spiele),
  Augenhöhe halten; auch im nativen Mac-3D. · M
- ○ **[214]** 3D-Engine optimieren (12.11., Wunsch Maintainer: „render3d hat sich sehr früh entwickelt, Leistung könnte besser sein“).
  Zuerst messen (Bildzeit, Draw-Calls, Upload-Zeit, Neu-Vernetzen je Änderung, Speicher; Musterhaus komplex + Grossgebäude
  `buildBigSampleProject` + grosser Kontext-Import), dann der Reihe nach: nur geänderte Elemente neu vernetzen/hochladen (statt ganzes
  Modell, auch Geisterschicht [180]), Puffer wiederverwenden, Draw-Calls bündeln (ein Puffer je Material/Durchgang, Instancing für
  Wiederholtes wie Fenster/Bäume), Sichtkegel-Culling, Schatten-Map nur bei Änderung von Licht/Modell, Kantenpass günstiger, LOD für
  Kontext/Gelände. Messbar machen (Bench in `dossier-cli bench` bzw. render3d-Test) und vorher/nachher belegen. Opus. · L
- [211] Rendering mit Blender/Cycles (◐, Eintrag unter „Import und Export“): Mac-Gegenprobe (Tauri, Metal), Blender 3.6/4.x, Dialog im Browser klicken.
- [213] Kameras und Begehen/WASD (◐, Eintrag unter „Grundriss“): Mac-Gegenprobe (IFC entfällt: keine Kamera-Entität).
- ◐ **[214]** 3D-Engine optimieren (12.11., Wunsch Maintainer). Messung: `BENCH_3D=1 BENCH_3D_OUT=<dir> npx vitest run
  src/viewport/render3d.bench.test.ts` (Kern/TS je Änderung wie `updateModel`, Szenen komplex/gross/kontext) und
  `render_png --bench <dir>/<szene>` (Aufbau, Bildzeit, Draw-Calls, Teil-Update, GPU-Speicher); Kern-Profil `model3d_cache::tests::bench214`.
  Umgesetzt (12.11.): Geisterschicht als Teile (`GhostLayerSync`, `set_ghost_parts`, eigene Szene in render3d) statt ganzem Modell-JSON +
  Prüfsumme je Änderung; Kern-Cache hält Decken/Dächer/Kontext (zweite Abfrage mit Geister-Filter rechnet nichts), Deckenauflager mit
  bekannten Fugen und Schichtfunktion je Wand einmal; texturierter Pfad ohne zweites Netz (UV im Shader); unveränderte 2D-Spuren/Muster/Hülle
  nicht neu hochgeladen. Wand verschieben, Kern/TS je Änderung (WASM, Container): gross 1388 → 285 ms (Teile 668 → 138, Geisterschicht
  877 → 141), komplex 146 → 176 (Rauschen, Geisterschicht 74 → 79), kontext 253 → 277 (Rauschen); GPU-Puffer komplex 57 → 42 MB,
  kontext 175 → 123, gross 131 → 118; Aufbau render3d komplex 517 → 263 ms, gross 396 → 203. Schattenpass lief schon nur bei Änderung,
  Bild-CPU je Frame 0.3–1.5 ms (Draw-Calls 64/275). Bilder byte-gleich, Geisterschicht ≤ 8/255 auf ~1 % (Mischreihenfolge der
  durchscheinenden Flächen je Klumpen). Nicht auf dem Mac/Metal und nicht in der App angesehen.
  Weiter (13.11.): (1) Übrige Gruppen (Decken, Kontext, Stützen, Treppen, Dächer, Körper) und der Öffnungs-Rest (Dach-/Deckenfenster) mit
  Laufnummer (`restKeys`, `tailKey` in `model3dPartsDelta`): der Kern vergleicht neu gerechnete Gruppen dem Wert nach (auch über einen
  verworfenen Cache hinweg), merkt je Gruppe die gefilterten Fassungen (Maske je Klassen-Filter, gleicher Inhalt = gleiche Nummer) und
  schickt nur Neues; TS hält die Gruppen der letzten drei Antworten, der Viewer bekommt sie als unveränderliche Teile (kein `JSON.stringify`-
  Vergleich). Ohne Abzugskörper keine Wand-/Decken-Kopie für `voidMeshes`. (2) Deckenauflager je Decke gemerkt (`bearing_outlines_memo`,
  Schlüssel = Stand + Schnittlinien der Wände im Höhenbereich der Platte), für Geschoss-Kontexte und Decken. (3) render3d: Kanten-Index mit
  schnellem Hasher, Beiträge je Teil nach (Hash, Beitrag) sortiert und je Kante einmal eingetragen. Wand verschieben, Kern/TS je Änderung
  (WASM, Container; Summe mit Geisterschicht als Teile): komplex 120 → 53 ms (Teile 43 → 13, Abgleich 20 → 0.5, Geisterschicht 49 → 31),
  gross 155 → 41 (Teile 89 → 20, Geisterschicht 64 → 18), kontext 234 → 63 (Teile 112 → 23, Abgleich 54 → 0.6, Geisterschicht 59 → 32);
  Kern nativ gross (`bench214`) 65 → 15 ms. Engine (`render_png --bench`, nativ, lavapipe-Container, verrauscht): Aufbau Renderer komplex
  291 → 215 ms, gross 204 → 165, kontext 962 → 813; Geisterschicht als Teile gross 1979 → 1546 ms (Geschosswechsel), komplex 276 → 210;
  Änderung parsen + Renderer gross 13 → 7 ms. Bilder byte-gleich (`render_png --bench … --png`, alt/neu, drei Szenen). Pathtracer [212]: im
  normalen Stil keine Kosten (Baum nur beim ersten Bild im Stil `Pathtrace`, ein Teil-Update setzt nur `pt_dirty`; Materialtabelle 0.2 ms).
  Tests: Kern `model3d_cache::tests::uebrige_gruppen_mit_laufnummer` (+ Gegenstelle mit Rückfall wie TS), vitest
  `toWalls3d.incremental.test.ts` (Viewer-Stand nach Teil-Updates = Neubau, Haupt/Geist im Wechsel), render3d
  `scene::tests::kanten_gruppen_auch_bei_hash_kollision`; e2e `renderCount`, `views` u. a. grün (Linux, Chromium). Nicht auf dem Mac/Metal,
  nicht auf echter GPU, nicht in der Tauri-App. Offen, nach Messwert: (a) Flächenmuster je Änderung ganz neu (komplex 8 ms Haupt + 15 ms
  Geisterschicht, je Wand cachen, Schlüssel inkl. Geschoss-Kontext); (b) Geisterschicht beim Geschosswechsel immer noch 1.5 s (gross,
  nativ): Kanten-Index (≈ 0.7 s für 2.8 M Beiträge) und Entscheid aller Kanten; (c) GPU-Bildzeit nur auf lavapipe gemessen, Culling/LOD/
  Instancing erst nach Messung auf echter GPU (Mac); (d) Draw-Calls der Geisterschicht je Klumpen (gross 465), ggf. bündeln; (e) Pathtracer
  nutzt seit [212] Etappe 5 `Bvh::refit` bei gleicher Topologie; ändert sich die Topologie (Gehrungen der Nachbarwände), baut er den Baum neu. · M
  Flächenmuster-Cache (13.11., `surface_pattern3d::PatternCache`, `Document::surface_pattern_lines`): Linien je Wand/Decke/Dach unter dem
  Element-Stand, Wand zusätzlich nach gehosteten Öffnungen und Geschoss-Kontext (Decken-Eingabe, Dächer: Oberkante unter dem Dach); Hauptmodell
  und Geisterschicht (anderer Klassen-Filter) teilen die Einträge. Wand verschieben, Flächenmuster je Änderung (WASM, Container, beide
  Aufrufe): komplex 24 → 1,5–2 ms, kontext 8 → 1,5 ms (Rauschen ±), gross unverändert ~1 ms (keine Muster). Test
  `zwischenspeicher_gleich_neubau` (60 gemischte Änderungen, Undo/Redo, Filter, Explosion: gleich dem Neubau; Wandänderung rechnet 1 Wand).
  Offen, nach Messwert: (1) Rest-Gruppen ohne
  JSON-Rundreise (Laufnummer je Gruppe statt `JSON.stringify`-Vergleich: kontext 69 ms, komplex 27 ms je Änderung); (2) Kern: Geschoss-
  Kontexte aller Geschosse je Abfrage (gross 29 ms nativ, zweimal je Änderung), Kontext-Netze je Objekt als Teil statt eine Gruppe;
  (3) Vernetzen in render3d (komplex 324 ms/147k Dreiecke kalt, Geisterschicht gross 2 s beim Geschosswechsel); (4) GPU-Bildzeit nur auf
  lavapipe gemessen (komplex ~150–570 ms Software), Culling/LOD/Instancing erst nach Messung auf echter GPU (Mac); (5) Draw-Calls der
  Geisterschicht je Klumpen (gross 275 → 465), ggf. bündeln. · M

### Phase 3 (27.11.–3.12.): Vorprojekt
- ◐ **[234]** 3D: Rundbogen-Fenster der OG-Südwand (`og-f1`, Musterhaus komplex) ragte mit dem Bogenscheitel über die Wandoberkante ins
  Gesims/Deckenband darüber. Stand 13.11.: Ursache war das Beispiel, nicht der Kern: Brüstung 0,9 + Höhe 1,6 = 2,5 m, die Decke c-og
  beginnt aber schon bei 2,43 m (Wandoberkante 2,8 m); jetzt Höhe 1,5 (wie `og-f2`, Oberkante 2,4 m). Der Kern kappt Formöffnungen
  (Leibung, Rahmen, Glas, Wandkörper) wie Rechtecke an der Wandoberkante; Test `formoeffnung_ueber_wandoberkante_ragt_nicht_ueber_die_wand`
  (Rund-/Spitzbogen, Höhe 1 m über der Wand). Goldens (Ansicht Süd, Schnitt A, 3D-Modell) nachgeführt. Offen: Öffnungen, die in eine Decke
  hineinragen (unter der Wandoberkante), werden nicht gekappt; Bild der Ansicht aus [216](3) nicht identisch nachgestellt.
  Stand 14.11. (abends): Öffnungen, die unter der Wandoberkante in eine Decke ragen, enden an der Deckenunterkante
  (`Project::opening_top_under_ceilings`: Decke mit UK über der Brüstung und unter dem Sturz, Wand an Anfang/Mitte/Ende der Öffnung
  — Mitte und knapp innerhalb beider Flächen — im Deckenumriss, nicht in einer Aussparung). Gilt überall, wo der Sturz an der
  Wandoberkante gekappt wurde: 3D-Wandloch, Wandkörper, Einbauteile, Pick, Taschen, Schichteinzug, Flächenmuster, Plan/Schnitt
  (`view_range`, `section/bands`), Ansicht, IFC, Sonne. Test `oeffnung_in_die_decke_endet_an_der_deckenunterkante` (Beispiel
  `og-f1`: Brüstung 0,9 + 1,6 bei Decke ab 2,43 m; Rechteck/Rundbogen, gerade/Bogenwand; ohne Decke volle Höhe). Formöffnungen werden
  wie an der Wandoberkante gestaucht (Umriss über die gekappte Höhe), nicht abgeschnitten.
  Stand 14.11. (spät): gekappte Formöffnungen (Wandoberkante wie Deckenunterkante) werden ABGESCHNITTEN: `opening_outline` baut die
  Form über die volle Höhe der Öffnung und schneidet sie bei der gekappten Höhe gerade ab (konvex bleibt konvex) — eine Stelle für
  3D-Wandkörper, Einbauteile, Grundriss-Sehne, Schnitt, Ansicht, Flächenmuster, IFC und Mengen. Test
  `formoeffnung_in_der_decke_wird_abgeschnitten_nicht_gestaucht` (Rundbogen: Kämpfer bleibt auf 1,1 m, Breite an der Oberkante
  wie der volle Bogen, Punkt-in-Körper). Die Breite wird nicht gekappt (Öffnung über das Wandende hinaus bleibt gestaucht). · S
- 1:100-Pläne in Abgabequalität (Bemassung, Koten, Raumstempel, Öffnungen nach Detailgrad) — Plan-Review-Runde 4 nach [199].
- ◐ **[256]** Plan-Review Runde 4 (1:100 Vorprojekt, 14.11., beide Musterhäuser + Wettbewerb, alle Grundrisse, Schnitt A-A, Ansicht Süd, 1:200
  Gegenprobe; CLI-SVG `--hatch` in Chromium, nur Linux). Behoben: (1) Raumstempel im Ersatz (Grundschrift/umbrochen/Nummer/gekürzt) verloren
  das Fett des Namens („Treppenhaus", „Eingang", „Wohnen/Essen/Küche" dünn neben fetten Nachbarn) — Marken je Zeile bleiben, nur die eigene
  Grösse entfällt (`fit_room_stamp_with`, Test `raumstempel_ersatz_behaelt_fett`); (2) oberste Höhenkote sass auf dem höheren Nachbargebäude
  („+12.00" statt „+9.50", Wettbewerb Schnitt/Ansicht) und der Kotenturm stand links vom Nachbarn statt am Haus (komplex Ansicht Süd) — Kontext-Netze
  auf Umgebungsklassen zählen nicht zum Gebauten (`level_marker_bounds` + TS `levelMarkers.ts`, Tests `koten_ohne_nachbargebaeude`, vitest);
  (3) „±0.00 = 441.30" lief in die Aussenwand — Kotenreihe rückt um die Textbreite (`level_markers`, Test `kotentext_endet_vor_dem_gebauten`);
  (4) DG komplex ohne Aussenbemassung (Beispiel: `autodim` auch im DG); (5) Wettbewerb: Zimmer/Bad/Diele ohne Türen, Wohnungstür Ost schlug ins
  Treppenhaus (Beispiel: Innentüren, Anschlag). Goldens (komplex EG/OG/DG) nachgeführt. Offen: Kamera-Sichtkegel „Südost" quer durch den EG-Grundriss
  (Klasse 92 im Abgabeplan aus?); Nachbargebäude im Schnitt als schwarze Schnittfläche, schwebend über dem Geländeende, im Grundriss schwarz
  (grau/Umriss?); Sonnenschatten im 1:100-Grundriss (Wettbewerb, komplex); DG-Fenster über der Schnitthöhe bemasst, aber nicht gezeigt (gestrichelt?);
  Stempel „Schlafen" DG auf 80 %; Treppe im Grundriss ohne Schnitt-Bruchlinie über die Laufbreite; Höhenlinien-Koten/Revisionstext auf Masszahlen
  (komplex EG Süd); Kotenwerte doppelt gerechnet in TS und Kern (`levelMarkers.ts` ↔ `level_marker_bounds`, Doppelspur seit [199]). Nicht in der
  Tauri-App/auf dem Mac angesehen.
  **14.11. (Fortsetzung):** (a) Nachbargebäude über den Klassen-Stil: neues Modellfeld `LayerCategory.fill` (Vorgabe-Füllung der Klasse),
  „12 Gebäude" hellgrau `#d9d9d9` (Kern-Tabelle `import_context`, TS `contextCategories.ts`, Beispiele); geschnittene Netze auf einer Klasse mit
  Füllung im Grundriss (`mesh_plan`) und Schnitt (`CutRules::class`) hellgrau mit Umriss in Klassenfarbe/-stärke statt schwarz, ohne schwere
  Schnittkante; eine Füllungs-Regel ([33]) geht vor; Situation/Schwarzplan unverändert. Höhenlinien enden an gefüllten Nachbarn
  (`filled_context_rings`). Im Schnitt enden Netze auf Umgebungsklassen am Geländeende (`clip_context_meshes_to_terrain`; komplex: der
  schwebende Nachbar entfällt). Tests `nachbargebaeude_im_grundriss_nach_klassenstil`, `nachbargebaeude_hellgrau_und_nur_ueber_dem_gelaende`,
  `hoehenlinien_enden_am_gefuellten_nachbarn`. (b) Treppen-Bruchlinie war da, aber ihr Zickzack (fest ≤ 6 cm) las sich bei 1:100 als
  weitere Trittkante: jetzt in Papiergrösse (2 × 1.5 mm, `RunOpts::break_mm`, Test `bruchlinie_zickzack_in_papiergroesse`). (c) Geländekote und
  Revisionstext im Beispiel komplex lagen von Hand auf den (später erzeugten) Auto-Massketten — unter die Ketten verschoben (vitest
  `sampleProjectComplex.test.ts`); Höhenlinien-Beschriftungen wichen den Massen schon aus. Von Hand gesetzte Texte verschiebt der Kern
  bewusst nicht. (d) Standard-Vorlagen: Kameras (92) aus in Präsentation, Eingabe, Ausführung, Situation, Schwarzplan; Sonnenschatten (08) aus
  in Eingabe/Ausführung, an in der Präsentation (Test `abgabe_vorlagen_ohne_kameras_schatten_nur_praesentation`); komplex: „Grundriss 1:100/1:50"
  und „Brandschutzplan" ohne 08/92, der Arbeitsplan ohne Vorlage zeigt beides. Goldens (komplex Grundrisse, Situation, Schwarzplan, muster
  EG, CLI-Grundriss) nachgeführt. Geprüft nur Linux/CLI-SVG in Chromium. **Offen:** DG-Fenster über der Schnitthöhe — sie werden
  „über Schnitt" strichpunktiert gezeichnet, aber in der schwarzen 1:100-Wand unsichtbar (DG Rundfenster 1.8 m; EG Bad 1.1 m, Rundfenster 1.2 m
  liegen ebenfalls über 1.0 m): nicht zu bemassen hätte auch diese Bad-Fenster aus den EG/OG-Ketten genommen — Entscheid nötig (hell auf
  schwarz zeichnen oder Schnitthöhe/Bemassung); Wettbewerb: Geschosse ohne Vorlage, Schatten kommt vom eingeschalteten Sonnenstand
  (`sunStudy.show`), unverändert; Wettbewerb-Schnitt ohne Gelände: Nachbar bleibt (hellgrau) weit neben dem Haus; `levelMarkers.ts`-Doppelspur
  (braucht eine Kern-Abfrage mit Plan-Puffer als Eingabe); Stempel „Schlafen" DG 80 %. **14.11. (spät):** Klassen-Füllung im Klassen-Dialog
  editierbar (Farbwähler + „keine", Inline-Editor und macOS-Ebenenfenster; Ziehen = ein Undo-Schritt; Test `categoryFill.test.ts`); nur vitest/tsc,
  nicht in der Tauri-App angesehen. **14.11. (Befund 6, Vorschlag umschaltbar, Entscheid Maintainer offen):** Öffnungen über/unter der
  Schnitthöhe in geschlossener Wand (DG-Rundfenster 1.8 m, EG-Bad-Fenster, EG-Rundfenster) bleiben strichpunktiert, der Teil auf der
  schwarzen 1:100-Sammelfläche wird weiss (SIA-Praxis), ausserhalb unverändert, Bemassung bleibt. Über die Plan-Primitive (`plan/contrast.rs`:
  Linien/Bögen an dunklen Flächen zerlegt, helle Stücke über allen Füllungen) — Bildschirm, Plan-SVG, Druck-SVG/PDF, DXF (Echtfarbe weiss)
  bekommen dieselben Stücke; 1:50 (helle Schichten) unverändert. Abschaltbar: Modelldarstellung `walls.contrastOnSolid` (Basis an).
  Tests `contrast::tests`, `ueber_schnitt_hell_auf_schwarzer_wand`; Goldens nachgeführt. Geprüft nur Linux/CLI-SVG `--hatch` in Chromium. · M
  UI-Review 14.11.: Ebenen-Editor (Füllung): schwebender Editor wird nach dem Aufbau am Fensterrand geklemmt (lag vorher rechts/unten ausserhalb, Messung während der Einblend-Animation).
  **15.11. (Stempel, Baulinie):** Stempel „Schlafen" DG komplex: Ursache war kein Möbel, sondern Querlinien (Gauben-Umriss, Achsen, Kote): zwischen
  Gaubenkante und Achse bleiben 1.6 m, der volle Stempel braucht 1.66 m; das 24er-Kandidatenraster (0.25 m) traf die Lücke nie. Jetzt (a) Lagen aus den
  Hindernis-Koordinaten (`gap_candidates`: anstossend oder mittig in der Lücke) vor jedem Verkleinern/Überdecken, (b) Zwischenstufe 90 % vor 80 %
  (`ROOM_STAMP_MID`): „Schlafen" steht jetzt in 90 % statt 80 % (volle Schrift passt dort nicht, 6 cm zu eng; Überdecken der Achse bleibt
  die schlechtere Wahl, [199]). (b) Die gestrichelte Baulinie/Parzellengrenze lief im Wettbewerb-EG durch die Masszahlen („2.69", „1.20", „20.39"):
  ihre Linien setzen jetzt vor Texten/Masszahlen der Zeichnungen aus (`cut_site_lines`, `Obstacles::cut_out`, 0.5 mm Rand). Tests
  `raumstempel_rueckt_in_luecke_statt_zu_schrumpfen`, `baulinie_setzt_vor_masszahlen_aus`; Golden komplex EG/OG/DG. Geprüft nur Linux/CLI-SVG
  in Chromium. **Offen:** Kote „±0.00" (komplex EG Zimmer) und „+5.70" (DG) stehen auf/neben Achslinien; Handmass „5.73" quert den Zimmer-Stempel
  nicht, aber die Wohnen/Essen/Küche-Beschriftung steht unter Revisionswolke und Sichtkegel (ohne Abgabe-Vorlage); Raumstempel nicht >90 %, wenn
  Linien die Räume zerschneiden — **Entscheid Maintainer 15.11.: so lassen** (90 % statt Achse überdecken, keine Freistellung).
  **15.11. (Hilfslinien vor Text):** Die Kote „±0.00“/„+5.70“ (komplex, alle Geschosse bei x = 3) stand nicht auf einer Achse, sondern auf der
  Schnittlinie A-A; Koten sind von Hand gesetzt (der Kern verschiebt sie bewusst nicht). Entscheid nach SIA 400 (Schrift hat Vorrang, Linien
  setzen aus): Achsen, Schnittlinie (strichpunktierter Teil), Baulinie/Parzelle und Höhenlinien setzen vor Masszahlen, Texten, Detailverweis-Blasen
  und je Höhenkote vor dem Rechteck über Dreieck und Wert aus (0.5 mm Papier Rand; `DrawnObstacles::gaps`, `Ctx::cut_at_gaps`; Symbole/Blöcke nicht).
  Damit laufen auch die Höhenlinien nicht mehr durch „1.79“, „3.60“, „17.39“, „Hebeschiebetür …“ (komplex EG Süd). Stand der Achsraster-Stücke folgt
  den Ständen der Masse/Texte/Koten (vorher nicht: Blasen-Versatz konnte veralten). Tests `schnittlinie_und_achse_setzen_vor_kote_aus`,
  `hoehenlinien_setzen_vor_masszahlen_aus`; Goldens komplex Grundrisse (A-A in 3 Stücke: Masszahl „5.73“ und Kote). Sonnenschatten (08) geprüft:
  in `vt-gr100`, Eingabe, Ausführung aus, in der Präsentation an (Wettbewerb, komplex) — kein Fehler, unverändert. Geprüft nur Linux/CLI-SVG in
  Chromium. **Offen:** Hinweis-Führungslinie und Kamera-Kegel (92, nur ohne Vorlage) queren „17.39“ (von Hand gesetzt bzw. Arbeitsplan);
  Höhenlinien-Beschriftung „-2.7“ an der Terrassenkante (komplex EG Südost).
- Fachplaner-Austausch: DXF/DWG je Geschoss/Schnitt/Ansicht ([200]), IFC mit Räumen/Psets ([201]); Rundreise in Archicad/Revit einmal
  real prüfen ([C9]).
- ◐ **[259]** IFC-Export für Fachplaner (Vorprojekt, 14.11.). Alle drei Beispielprojekte mit ifcopenshell 0.9 geprüft: `validate-ifc.py`
  0 Befunde, neue inhaltliche Prüfung `scripts/check-ifc-fachplaner.py` (Project → Site → Building → Storey, jedes Bauteil genau einmal
  eingeordnet, Öffnungen gefüllt und im Geschoss des Wirts, Räume mit Nummer/Name/Psets/Qto/SIA-416, Wandschichten, Mengen ±1 % gegen die
  Geometrie, Georeferenz) in `src/export/exportIfc.fachplaner.test.ts`. Behoben: (1) Geometrie lag in LV95-Millionen — jetzt lokal,
  `IfcMapConversion` mit Versatz des Ursprungs und OrthogonalHeight = ±0.00 m ü. M. (`referenceElevationMasl`, = `IfcSite.RefElevation`);
  (2) Bögen in Decken-/Raumumrissen an der Sehne gespiegelt (Bulge-Vorzeichen Modell ↔ DXF-Sinn) und mit nur kartesischer Trimmung von
  ifcopenshell als Sehne gelesen — jetzt Punkt + Winkel, PARAMETER (Erker komplex: Raum 51.5 → 57.4 m² = Flächenbilanz); (3) Geschoss-GF
  war gleich NGF (KGF 0) — jetzt aus der Flächentabelle mit Konstruktionsfläche, dazu GrossHeight/GrossVolume und Gebäudesummen
  (`Qto_BuildingBaseQuantities`); (4) Wandmengen: Bogenwände (volle Höhe über alle Schichten, +5 bis +23 %) und Formöffnungen (Rechteck statt
  Umriss) neu; (5) Netz-Wände mit mehreren Bändern bzw. Formöffnungs-Füllkörpern als ein Körper (Manifold), Füllkörper nach aussen gewickelt,
  Netze verschweisst (kleinere Dateien). Neu: Option „Kontext mitgeben" (Dialog, CLI `--kontext`, Vorgabe aus): Gelände → `IfcGeographicElement`
  TERRAIN, Netze auf Umgebungsklassen → Proxy „Kontext", am IfcSite. Entscheid: 2D-Objektbibliothek ([253]) wird NICHT exportiert (kein
  falscher Körper, kein geometrieloses IfcFurniture). Grösse/Zeit (Linux, unter Last): komplex 1.6 MB / 2.5 s, Wettbewerb 0.9 MB / 0.5 s,
  Stress-Beispiel `sampleProjectBig` 19.8 MB / 5.8 s. **Offen:** nicht in Archicad/Revit/Solibri/BIMcollab geöffnet (Prüfzeile 13.14 in
  `doc/RELEASE-1.0.md`); IFC2x3 nur über die bestehenden Tests. **14.11. (spät):** Anbauwand OG Ost (komplex, unter dem
  Pultdach mit Fenster) behoben — ihre Stücke um das Fenster (je eigene Dach-Oberkante) lagen als verschweisste Schalen im Face-Set (Kanten
  3–4-fach), ifcopenshell rechnete beim Abzug 30.4 statt 7.5 m³. Jetzt der vereinigte 3D-Körper je Band (`RWall::body`, `union_bodies`), Ecken auf das 1e-6-Ausgaberaster gelegt (sonst
  blieb zwischen Nachbarbändern ein Spalt von 1e-15 m und zwei Schalen, Wettbewerb OG2 Ost), dicht nach dem Verschweissen geprüft, sonst Schalen wie bisher;
  `--known` aus der Prüfung entfernt, komplex 0 Befunde; zwei weitere Dachwände und eine Wand mit Formöffnung genauer (Abweichung NetVolume ↔
  Geometrie 0.9 % → 0). Test `wand_unter_dem_dach_mit_fenster_als_ein_koerper`. **15.11.:** (a) Ebenen: `IfcPresentationLayerAssignment` je Klasse (`20_Wände` wie im DXF; ohne Sichtbarkeit, `IfcPresentationLayerWithStyle` verlangt in IFC4 Geometrie-Items), alle Darstellungen eines Bauteils samt Treppenteilen auf genau einer Ebene (Prüfung in `check-ifc-fachplaner.py`); (b) Raum: Körper und `Qto_SpaceBaseQuantities.Height` = lichte Höhe wie Raumbuch, `FinishCeilingHeight` und `Dossier_Qto_RoomBook.ClearHeightMean` = mittlere, `ClearHeightMin` = kleinste Höhe unter Dachschrägen, Boden an der Oberkante der Decke darunter; Test gegen `roomBook` ±1 cm. Offen: Archicad/Revit/Solibri-Sicht der Ebenen ungeprüft; Dachraum-Körper füllt die Schräge nicht aus. · M
- ◐ **[255]** Baurecht-Nachweis: Ausnützung gegen Modell als Tabelle (14.11.). Kern `site_proof.rs` (Abfrage `siteProof`) stellt die Vorgaben
  der Parzelle den Kennzahlen gegenüber: GFZ, AZ, BMZ, ÜZ, GZ (min.), Gesamt-/Fassadenhöhe, Grundfläche ausserhalb Grenzabstand/Baulinie,
  Gebäudeprofil; je Zeile zulässig · Projekt · Reserve/Überschreitung · erfüllt, fehlende Vorgabe als „—“ (nichts erfunden), dazu Grundlagen
  (aGSF, zulässige Fläche, GF, aGF, aGbF, Baumasse, Grünfläche) mit Quelle. Neue Modellfelder `SiteRules.maxGfz/maxAz/maxBmz/maxUz/minGz/
  maxFacadeHeight` (Eingabe im Lage-Panel, Baurecht). Ausgabe: Flächenbilanz-Panel (zwei Abschnitte im Berichtsmodell, daher auch CSV/PDF/SVG),
  Blatt-Tabelle Quelle „siteProof“ (wie [209]), CLI `kennzahlen --nachweis`. Tests: `site_proof::tests`, `sheet_table::tests::baurecht_nachweis_tabelle`,
  `src/analysis/siteProof.test.ts`. Offen: Blatt-Tabelle nimmt aGSF/Grünfläche nicht aus den Panel-Eingaben (nur Parzellenfläche/-grenze),
  Grünfläche nur per Eingabe, Grenzabstand als Verstossfläche statt kleinster Abstand, Fassadenhöhe nur über ±0.00, Mac/Tauri nicht geprüft. · S
  UI-Review 14.11.: Flächenbilanz-Panel: Tabellen brechen Text/Köpfe um (Nachweis- und Grundlagen-Tabelle jetzt in 340 px ganz sichtbar, de/en); die breite Flächentabelle (11 Spalten) scrollt nicht mehr: in der schmalen Dock-Spalte (Container ≤ 460 px) wird jede Zeile zur Karte (Geschoss oben, Kennwerte 5 je Zeile mit Kopf über der Zahl; `.area-table.wide`, de/en bei 340 px vollständig lesbar, CSV/PDF unverändert); Fenster-/Türliste (15–20 Spalten) und Raumbuch (12–16) nutzen dasselbe Muster als gemeinsame Komponente `src/panels/CardTable.tsx` (Köpfe per Effekt als `data-label`, lange Textzellen belegen 2–3 Rasterspalten, leere Zellen entfallen; Container-Query ≤ 460 px, sonst normale Tabelle; 14.11. spät, Chromium de/en, 303 px Dock, kein waagrechtes Scrollen mehr; Kosten- und Bauteil-Tabelle (≤ 6 Spalten) scrollten nicht und blieben). Icon-Schrift „settings“ als Text: Schrift ist lokal gebündelt (npm `material-symbols`, `main.tsx`, NOTICE [117]) — Ursache war nur der verlinkte `node_modules` im Worktree (Vite `/@fs` 403), kein App-Fehler. Blatt-Tabelle Baurecht (14.11. spät, als Primitive in Chromium angesehen, nicht in der Blatt-Ansicht der App): Kopf „Reserve (+) / Überschr. (−)“ und „Zulässig“/„Erfüllt“ wurden mit „…“ gekürzt → kurzer Blatt-Kopf „Reserve“, Spaltenbreiten neu (Köpfe passen ab 100 mm Rahmenbreite, Test `baurecht_tabelle_koepfe_passen`); lange Zeilentexte kürzen bei < 150 mm weiterhin mit „…“ (kein Umbruch im Blatt-Tabellenkern).

- ◐ **[272]** Varianten wie Archicad „Design Options“ (17.11., Wunsch Maintainer, für 1.0). **Stand 17.11.:** Modell (Rust, gen:types, KNOWN_KEYS): `Project.designOptionSets` (Sätze, Varianten, Hauptvariante), `designOption: {set, option}` an Wand, Öffnung, Decke, Dach, Treppe, Stütze, Körper, Raum, 2D-Element (samt Bibliotheksobjekt), Kombination `designOptions` an Ebene/Vorlage/Ausschnitt/Layout-Viewport. Sichtbarkeit im EINEN Kern-Ort `renovation::View` (Kombination neben dem Umbaufilter, `doc/ARCHITEKTUR.md` 3.9): Grundriss, Schnitt, Ansicht, Vektor-Axo, 3D-Fenster (Kombination der aktiven Ebene), Kennzahlen, Kosten, Baurecht, Raumbuch, DXF (über den Plan), IFC/Netz-Exporte (Hauptvarianten bzw. JSON-Text), PDF/Blatt (Viewport-Kombination + Titelzusatz). Kern `design_options.rs`: Übernehmen, Satz/Variante löschen, Zuweisen, In Variante kopieren (je ein Undo-Schritt), Zeichen-Variante neuer Elemente, Vergleich (Kreuzprodukt ≤ 24). Oberfläche: Panel „Varianten“ (Kombination, neue Elemente zeichnen in …, Zuweisen/Kopieren, Sätze verwalten, Übernehmen, Vergleich), Chip „Variante: …“ in der Statusleiste (öffnet das Panel, Überlauf „⋯“), Objekt-Info „Variante“, Ressourcen-Tab „Varianten“, Befehle `variante`/`variantekopieren`, Varianten-Vergleich + CSV in der Flächenbilanz, Viewport-Wahl je Satz im Blatt; Vorlage „Beispiel Varianten“ (CLI `:varianten`); CLI `--options`, `designoptions`. Tests: Kern `design_options_tests.rs` (13), Robustheit, vitest `model/designOptions.test.ts`, `commands/cmds/designOption.test.ts`, e2e `designOptions272.spec.ts` (2× grün, Port 5195); Bilder `doc/review-272/`. **Offen:** Blatt-Tabelle (`sheet_table.rs`) für den Vergleich fehlt (nur Panel + CSV); App-IFC-Export und Cycles-Szene nehmen die Hauptvarianten, nicht die Kombination der Ansicht; Variantensatz-Wahl in Ansichtsvorlagen/Ausschnitten nur im Modell (keine Oberfläche ausser Ebene und Viewport); nicht geprüft, ob Wandanschlüsse im Grundriss Wände anderer Varianten noch berücksichtigen (gleicher Weg wie die Regel „Ausblenden“); 3D-Bild und Tauri/Mac nicht geprüft (Prüfschritt `doc/RELEASE-1.0.md` 13.38). · M–L
### Phase 4 (4.–12.12.): Härten und veröffentlichen
- Nur noch Fehler aus dem Referenz-Ablauf; Leistung mit grossen Kontext-Importen; keine neuen Funktionen.
- Release 1.0.0: Tag, signierte Pakete, Release-Notes (ehrlich: was nicht geht), Download-Seite.

- ◐ **[262]** Netzzugriffe und Datenschutz (15.11., Phase 4): Inventar aus dem Code steht in `doc/RELEASE-NOTES-1.0.md` («Netzzugriffe und Datenschutz»); keine Telemetrie/Analytics/Crash-Reporting gefunden. Behoben: (a) Update-Check beim Start und Versionsverlauf (Tauri-Plugins, an `netFetch` vorbei) ignorierten den Offline-Modus, jetzt geprüft (`update/checkForUpdate.ts`, `versionHistory.ts`); (b) Overpass-URL zeigte auf `maps.mail.ru`, das weder in `ALLOWED_HOSTS` noch in der CSP stand, der OSM-Import scheitert ohne Proxy also stets, jetzt `overpass-api.de`; (c) unbenutzter Host `nominatim.openstreetmap.org` aus Host-Liste/CSP/`tauri.conf.json` entfernt; (d) Bild-Fallback in `viewport/materialTextures.ts` umging bei abgelehnter URL `netFetch`. Test: `src/update/offline.test.ts`. **Erledigt 16.11. (Entscheid Maintainer, Frage 11):** Update-Prüfung beim Start ist standardmässig AUS; Einstellungen → Update → „Beim Start nach Updates suchen“ (`getUpdateCheckOnStart`/`checkForUpdateOnStart`, localStorage `dossier.updateCheckOnStart`, einmal je Seitenladen, offline nie); Pausen-Auswahl nur bei eingeschalteter Prüfung; der Versionsverlauf wird erst beim Öffnen des Reiters „Update“ abgerufen (vorher beim Öffnen der Einstellungen); Knopf „Nach Updates suchen“ bleibt. Tests: vitest `update/startupCheck.test.ts`, e2e `updateOnStart262.spec.ts`. **Offen:** `spherePreview.ts` lädt `new Image().src` ohne `netFetch` (heute nur blob-/Asset-URLs, S); Update-Plugin und Tauri-HTTP-Plugin (`git.openbureau.ch`) laufen ausserhalb der CSP/Host-Liste, nur mit Offline-Schalter gesperrt; nicht in der Tauri-App und nicht gegen die echten Dienste geprüft. Grösse S.
- ◐ **[257]** Leistung mit grossen Kontext-Importen (14.11., Phase 4). Messung: `dossier-cli :beispiel bench --context [--footprints N --buildings N --triangles N --extent m] [--save-obp datei]`
  importiert synthetischen Wettbewerbs-Kontext (`model/sampleContext.ts`, deterministisch, keine echten Daten: Kataster-DXF mit Parzellen/Umrissen/Strassen,
  Höhenlinien-DXF → Gelände, Gebäudenetze als OBJ, Standard 300 Gebäude/100k Dreiecke/900 Umrisse) wie die App (Parser, Kern-Import, „Gelände erzeugen“, „Aufs
  Gelände setzen“) und misst Import, Grundriss 1:100/1:50, Schnitt, Ansicht, 3D, Undo/Redo und Ableitungen nach einer Wandänderung, Speichern/Laden; Test
  `cli/contextBench.test.ts` (kleine Grösse, Schwellen ≥ 10-fach, fängt Quadratisches). Hotspots (Profil Node-CPU + native Zeitmessung): (1) `hlr::intersection_edges`
  prüfte in Ansichten alle Flächen-Paare im Raster, auch zwischen Hunderten Kontextgebäuden, die sich nicht berühren (Ansicht 300k Dreiecke: 380 ms) — jetzt
  Vorfilter über die 3D-Hüllen der Körper (`near_solids`), Ausgabe unverändert; (2) „Aufs Gelände setzen“: je Gebäude Raster × Dreiecke und je Gebäude das Gelände neu
  abgefragt/gehasht (`context_ground.rs`: Raster über die Dreiecks-Hüllen, `Grounder` einmal je Befehl, Id-Tabelle statt linearer Suche) und die Ops reisten als
  JSON zweimal durch JS (`groundContextObjects` nimmt jetzt `commitCmd`). Messwerte (Median von 3 Läufen, Container unter Last, ms; vorher → nachher): 100k Dreiecke:
  Aufs Gelände setzen 830 → 340, Ansicht 435 → 354, Ansicht nach Wandänderung 539 → 438; 300k Dreiecke: Ansicht 1630 → 1258, nach Wandänderung 1580 → 1191, Gelände
  setzen (Rust) 1197 → 704. Unverändert: Plan/Schnitt/Ansicht/3D/Projektdatei byte-gleich (CLI-Ausgaben vor/nach), Goldens. Kein Neurechnen des Kontexts bei
  Änderungen am eigenen Haus: Undo/Redo 0.1 ms, 3D nach Wandänderung ≈ 4 ms (100k) / 15 ms (300k), Grundriss ohne Gelände 3 ms. **Offen:** `HLR` (feature_edges, Sichtbarkeit)
  bleibt linear in den Kontext-Flächen (Schnitt 120–170 ms bei 100k, 620 ms bei 300k, jede Änderung rechnet es neu: Teil-Cache des Kontexts wäre der nächste Schritt);
  `Silhouette::of` (Raster) und `mesh_faces_needed` ≈ 100–230 ms bei 300k; Grundriss mit Gelände nach Änderung am Fussabdruck 50–60 ms (Höhenlinien neu beschnitten);
  DXF-Export eines Geschosses mit Gelände: **14.11. behoben** (3134 → 374 ms, Median aus 3): nicht `arc_fit` selbst war quadratisch (900-Punkte-Zug 0.4 ms), sondern `plan/dxf.rs` — bei einer Kette aus Einzel-Linien ohne Bogen rechnete der Export für jede Linie den Rest-Zug neu an (Höhenlinien mit 500–900 Segmenten × tausende Ketten); jetzt wird ein bogenloser offener Zug samt allen Resten einmal geprüft (exakt gleich, `arc_fit` entscheidet je Anfangspunkt nur über den Zug dahinter; Tests `offener_zug_ohne_bogen_hat_keinen_bogen_im_rest`, `lange_kette_ohne_bogen_ist_schnell`; DXF des Kontext-Projekts byte-gleich mit/ohne Änderung); „Gelände aus Höhenlinien“ 250–300 ms (5000 Punkte);
  Netz-Import/Ops tragen ganze Netze als JSON (300k: Import 550 ms + Gelände annehmen 650 ms); synthetische Fassaden sind feiner unterteilt als echte swissBUILDINGS3D;
  Mac/Metal nicht gemessen (Anzeige-Engines), keine echten Daten, Tauri-App nicht geprüft. · M
- ◐ **[212]** Eigener GPU-Pathtracer in `render3d` als progressive Vorschau im Viewport (Entscheid Maintainer 12.11.: „beides“ —
  eigener Pathtracer für die schnelle Vorschau, Cycles [215] für Endbilder): BVH, PBR-Materialien (diffus/glänzend/Glas), Himmel + Sonne
  aus dem Sonnenstand, Entrauscher (Intel Open Image Denoise, Apache-2.0), WebGPU + Metal, läuft auch im Browser. Nach 1.0. · L
  **Stand 13.11. (Etappe 1):** Darstellungsart „Pathtracing (Vorschau)“ (Oberleiste, `RenderMode` `"pathtrace"`, render3d
  `RenderStyle::Pathtrace`). BVH auf der CPU aus denselben Szenen-Dreiecken wie die schattierte Ansicht (`render3d/src/bvh.rs`,
  Binned-SAH, flache Arrays, Doppelseiten einmal; Tests gegen Brute-Force, leere/kaputte Eingaben), WGSL-Compute (`pathtrace.rs`,
  `gpu_pathtrace.rs`): ≤ 5 Abpraller, Russian Roulette, Akkumulation über Bilder mit Neustart bei Kamera/Modell/Sonne/Grösse, Obergrenze
  1024 Samples, grosse Ansichten intern ≤ 1.2 MPx, ACES + sRGB. Materialien aus der Vertexfarbe: diffus, glänzend (Lambert unter GGX,
  Rauigkeit 0.3, heute nur Stahlrahmen `PART_RGB[4]`), Glas als dünne Scheibe ohne Brechung (Fresnel, für Schattenstrahlen durchsichtig).
  Sonne der Sonnenstudie (sonst Standardlicht) als Kegel 0.5° mit NEE, Himmel als Gradient mit Aureole, Farbe nach Luftmasse. Viewport:
  Zähler „Samples · /s“ unten links, zeichnet je Bild ein Sample bis fertig. Headless: `render_png --style pathtrace --samples N`.
  Geprüft: `cargo test` render3d (auch `--features render` mit lavapipe: Akkumulation/Neustart/Grenzen), WGSL mit naga validiert und
  nach MSL übersetzt (Metal-Tauglichkeit ohne Mac), Chromium-WebGPU (SwiftShader) kompiliert und rechnet ohne Fehler (Bild headless
  nicht auslesbar), Bilder Musterhaus komplex mit lavapipe (≈ 2–5 Samples/s bei 800×520). **Offen:** echte GPU und Mac/Metal
  (`native3d` reicht nur den Stil durch; `cargo check --features native3d` unter Linux grün, auf dem Mac nicht gebaut), Klick im Browser/Electron, Entrauscher (OIDN oder A-Trous), Bildkarten/Texturen und
  Materialtabelle (Rauigkeit/Metall je Baustoff wie [211]), Glas mit Brechung, Schnitt, Geisterschicht und Linien im Pathtracing,
  Nacht/Sonne unter dem Horizont (heute Standardlicht), Bild-Export [223] rechnet nur 1 Sample, BVH-Neubau bei jeder Änderung (Teil-Update).
  **Stand 13.11. (Etappe 2, Vorschau brauchbar):** (1) Entrauscher `render3d/src/denoise.rs`: À-trous nach SVGF ohne
  Zeit-Reprojektion als Compute-Pässe (prep + 5 × À-trous, Schritt 1…16); der erste Treffer schreibt Hilfspuffer (Albedo,
  Normale, Tiefe, Luminanz² als Summen), gefiltert wird das demodulierte Licht (Texturfarbe/Kanten der Grundfarbe bleiben),
  Gewichte Normale/Tiefe-Gradient/Luminanz-Varianz (aus den Samples, bei < 4 räumlich). Nur in der Anzeige (Akkumulation
  unberührt), bis 32 Samples voll, dann log2 ausgeblendet bis zum Ziel (am Ziel roh). Schalter `Renderer::set_pathtrace_denoise`
  / `web::set_pathtrace_denoise` (Standard an; keine UI). OIDN für Endbilder bleibt für später ([215]). (2) Materialtabelle
  `pt_material.rs`: Transport über die schon vorhandene Material-Ebene je Vertex (`materialIndex`, Reihenfolge
  `wallMaterialColorMaps`) — kein neues Feld im Modell, Goldens unverändert; Tabelle `[{name, map}]` aus `pathtraceMaterials`
  (`plan/toWalls3d.ts`) über `web::set_pathtrace_materials` bzw. `ptMaterials` im CLI-`model3d`. Looks nach Baustoffname und
  Bildkarten-Ordner wie der Blender-Leser [211] (Ziegel, Blech/Stahl metallisch, Beton, Holz, Kies, Putz …), aufgelöst ins
  BVH-Dreieck (Art, Rauigkeit, Metall statt Füllfeld); Farbe nur für ungesetzte (weisse) Bauteile: mittlere Farbe der dekodierten
  Bildkarte, sonst die der Tabelle. BRDF mit Metall-Anteil (F0 = Grundfarbe). (3) Glas: Fresnel-Spiegelung als fester Anteil
  (kein Zufall) mit `reflected` (Himmel, oder getroffene Fläche mit Sonne + Himmelslicht statt Schwarz), Durchlicht getönt;
  Glas-Durchgänge verbrauchen keinen Abpraller und kein Russian Roulette (≤ 8 je Pfad). (4) Bild-Export [223] im Stil Pathtracing:
  N Samples in einem `render` (Dialog-Feld „Samples je Pixel“, Vorgabe 64, 1…1024; `imageExport.exportSamples`), intern bis
  4 MPx statt 1.2, ohne Transparenz (Hintergrund ist der Himmel). (5) Sonne der Studie unter dem Horizont: Nachthimmel
  (`night_sky`, Belichtung 14) statt Standardlicht. Nebenbei behoben: achsparallele Strahlen (orthografische Ansichten
  vorn/hinten/oben) trafen im Shader nichts (`1e30 · sign(0) = 0`). `render_png --denoise off`, `--pt-goal` (Ziel wie im Viewport,
  Standard 1024). Geprüft: `cargo test --release` render3d (auch `--features png` mit lavapipe: GPU-Entrauscher = CPU-Referenz,
  Tests Kante/Fläche/Himmel, Materialzuordnung, Nacht), WGSL nach MSL, `cargo check --features window` (was `native3d` zieht;
  die Tauri-App selbst wegen Platte nicht gebaut), tsc, vitest (Viewport, UI, CLI, i18n, Goldens unverändert), Chromium-WebGPU
  (SwiftShader) ohne Konsolenfehler (Bild headless nicht auslesbar), Bilder Musterhaus komplex mit lavapipe (800×520, nah ≈ 2.8
  Samples/s, vorher 3.2; der Entrauscher kostet wenig). **Offen:** echte GPU und Mac/Metal, Dialog-Feld nicht im Browser geklickt,
  Bildkarten/Texturen im Pathtracer (nur mittlere Farbe), Glas mit Brechung, Schnitt/Geisterschicht/Linien im Pathtracing,
  Gelände ohne Material (Wiese wie [211] fehlt), Nachthimmel ohne Lichter/Mond, BVH-Teil-Update, OIDN.
  **Stand 13.11. (Etappe 3, schöner):** (1) Bildkarten im Pathtracer: dasselbe Textur-Array wie der Stil „textured“
  (group 1 im Compute-Shader, Sampler mit Wiederholung), UV je Dreieck im Parallel-Puffer `bvh::GpuTriTex` (32 B, nur beim
  Treffer gelesen; UV der Ecken in Metern nach `mesh::planar_uv`, derselben Regel wie der Shader der schattierten Ansicht,
  baryzentrisch interpoliert), Massstab 1 / `sizeM` (neu `size` in `pathtraceMaterials`; die schattierte Ansicht kachelt
  weiter 1 m). Albedo = Grundfarbe · Texel / Kartenmittel (ungesetzte Bauteile zeigen die Karte, gesetzte Farben behalten
  ihren Ton); der Entrauscher demoduliert mit der texturierten Albedo der ersten Fläche (auch hinter Glas) — Ziegelfugen und
  Holzmaserung bleiben scharf. Headless: `render_png --textures public` liest die JPEG-Karten (zune-jpeg, nur Feature `png`,
  Flächenmittel auf 256²), `--test-texture` erzeugt eine Mauerwerks-Karte. (2) Gelände: ohne Material und ohne Luftbild Wiese
  (`mesh::mesh_layer` → Ebene −2, der Stil „textured“ klemmt sie wie −1 aufs Schachbrett), Looks Wiese/Kies/Asphalt mit
  prozeduraler Textur, wenn keine Bildkarte da ist; Gelände mit `materialIndex` bekommt Farbe und Look der Tabelle (die
  Geländefarbe des Kerns gilt als ungesetzt). (3) Glas: Schattenstrahlen werden je Glasfläche auf 0.9 gedämpft statt
  verlustfrei; Brechung bewusst nicht — die Scheiben sind dünne planparallele Platten, der Strahl tritt nur um Millimeter
  versetzt aus. (4) Nacht: warmes Innenlicht auf Flächen hinter Glas (`Sky::room_light`, erleuchtete Fenster als Stimmung)
  und Leuchten (`MAT_EMISSIVE`: Baustoff mit „Leuchte“/„Lampe“ im Namen). (5) Bild-Export Pathtracing in Häppchen
  (`renderPathtraceChunks`, ≈ 250 ms je Häppchen, `web::gpu_idle` wartet auf die GPU), Fortschritt „Sample x von y“ und
  „Rendering abbrechen“ im Dialog; das letzte Häppchen läuft wie bisher im selben Task wie das Auslesen, das Fenster-Zeichnen
  pausiert so lange. Geprüft: `cargo test --release` render3d (auch `--features png` mit lavapipe: Streifen-Karte erscheint
  als Streifen, Kachel 2 m, Wiese grün mit Struktur; UV-Interpolation, Texturzugriff, Materialzuordnung Gelände, Innenlicht),
  WGSL nach MSL, `cargo check --features window`, render3d-WASM gebaut, tsc, vitest (Export-Häppchen mit Abbruch,
  `pathtraceMaterials`, Viewport, i18n, Goldens unverändert), Bilder Musterhaus komplex mit lavapipe (800×520, 64 Samples:
  Iso ≈ 2.4 Samples/s wie vorher, Nahsicht mit Karten ≈ 1.6 statt 2.2 — Texturzugriff in Software-Vulkan). **Offen:** echte
  GPU und Mac/Metal, Dialog-Abbruch und Fortschritt nicht im Browser geklickt (WebGPU headless ohne Bild), Rauigkeits-/
  Normalenkarten, Gelände-Material im Modell (`TerrainMesh` hat kein Material-Feld; render3d nimmt `materialIndex` am
  Gelände schon an), Wiesen-Bildkarte `Grass005` fürs Gelände (heute prozedural), Mipmaps (ferne Karten flimmern nur ohne
  Akkumulation), Innenlicht bei Kamera im Haus, Mond, BVH-Teil-Update, OIDN.
  **Stand 13.11. (Etappe 4, Oberflächen):** (1) Normalen- und Rauigkeitskarten (`ComponentMaterial.normal`/`.roughness`,
  OpenGL-Konvention wie `normal.jpg`/`…_NormalGL`): `pathtraceMaterials` gibt sie je Ebene mit (`normal`, `rough`), der
  Viewer dekodiert sie neben den Farbkarten (`materialTextures.ts`, `web::set_material_detail_textures`), render3d packt sie
  zu einem zweiten Textur-Array (`render3d/src/pt_texture.rs`: RG = Normale xy, B = Rauigkeit, A = Normale z; group 1
  binding 3). Tangentenrahmen aus den UV-Ableitungen der planaren Projektion (eindeutig, beide Windungen gleich; Rückseite
  kippt), Rauigkeit je Texel = Tabelle · Karte / Kartenmittel, Toksvig aus der Länge der gemittelten Normale; eine Ebene mit
  Detail-Karte bekommt die glänzende Schicht. Der Entrauscher nimmt die gestörte Normale (Vergleich bei 8 Samples: Ziegelkanten
  scharf, mit der geometrischen verschmiert; Rauschen gleich). (2) Mip-Stufen für beide Arrays (Farbkarten in linearem
  Licht gemittelt), LOD je Abfrage nach Strahlkegel (Pixelwinkel bzw. Pixelgrösse ortho, nach diffusem Abpraller breit,
  √cos-Verzerrung); die prozeduralen Texturen blenden feine Frequenzen nach dem Fussabdruck zum Mittel aus. Nebenwirkung
  gewollt: der Stil „textured“ sampelt die Karten jetzt mit Mip-Stufen (ruhiger in der Ferne). (3) Gelände-Material:
  `TerrainMesh.componentId` (Rust-Modell, `npm run gen:types`), Objekt-Info des Geländes „Material“ (Bauteil-Auswahl,
  Standard Wiese), Kern setzt Farbe und `materialIndex` (Farbkarte hinten in `materialMaps`, Gebäude-Ebenen unverändert) →
  texturierte Ansicht und Pathtracer; Blender-Paket nimmt die Karten des Bauteils statt der Wiese (`terrainRenderMaterial`).
  Gelände ohne Material: `pathtraceMaterials` hängt die Wiese `Grass005` (Kachel 4 m, `terrain: true`) an; geladen ersetzt sie
  die prozedurale Wiese (Grundfarbe Wiesengrün, Struktur aus der Karte, dazu die grossen Flecken der prozeduralen Wiese gegen
  sichtbares Kacheln). (4) Leistung (lavapipe, 800×520, 32 Samples, abwechselnd je zweimal gemessen, Maschine durch
  Parallel-Build belastet): nah 2.47/2.54 → 2.53/2.54 Samples/s, fern 3.39/3.27 → 3.43/3.32 — unverändert; Bildkarten
  trotzdem nur bis zum ersten Abpraller (`TEX_BOUNCES`), danach Grundfarbe (= Kartenmittel). Geprüft: `cargo test --release`
  render3d (auch `--features png` mit lavapipe: Mip-Stufe nach Strahlkegel, Normalenkarte zur Sonne heller, ohne Karte wie
  flach; Tangenten, LOD, Packung, Materialzuordnung, Gelände-Bildkarte), WGSL nach MSL, `cargo check --features window`,
  `cargo test` Kern (Gelände-Material im 3D), Kern- und render3d-WASM gebaut (`--no-opt`), tsc, vitest (Tabelle, Rundreise
  Datei, Objekt-Info-Op mit Undo, Blender-Paket, Viewport, Goldens unverändert), Bilder Musterhaus komplex mit lavapipe.
  **Offen:** echte GPU und Mac/Metal, im Browser nicht angesehen (Detail-Karten im Viewer nur über den Build geprüft),
  texturierte Ansicht zeigt für Gelände ohne Material weiter kein Gras, Höhen-/AO-Karten, Anisotropie (Böden sehr flach
  gesehen leicht unscharf), Innenlicht bei Kamera im Haus, Mond, BVH-Teil-Update, OIDN.
  **Stand 13.11. (Etappe 5, Innenräume und Tempo):** (1) Absturz im Browser behoben (Chromium/SwiftShader: Panic in wgpu
  `create_buffer` beim ersten Bild — Puffer mit `mappedAtCreation` wirft im Browser synchron und legt das WASM-Modul lahm): der
  Pathtracer legt alle Puffer leer an und füllt sie per `write_buffer`, Grössen gegen `max_buffer_size`/`max_storage_buffer_binding_size`
  geprüft; zu gross = nur Himmel und Hinweis „Modell zu gross“ im Viewport; höchstens 8 Speicher-Puffer je Stufe (WebGPU-Vorgabe).
  e2e `release10` [212] wieder aktiv (mit altem render3d-WASM rot, mit neuem grün, prüft jetzt auch die Regler), Rust-Test mit
  künstlich kleinen Grenzen. (2) Innenraum: Next-Event-Estimation auf eine Lichtliste (`render3d/src/pt_lights.rs`): Fensterscheiben
  als Portale des Himmels wie Cycles' „Portal“ (je Scheibe eine Fläche, Normale zum Himmel per Probestrahlen, Glas ohne Himmel fällt
  weg), Leuchten (`MAT_EMISSIVE`), nachts Raumlicht an den Deckenuntersichten je Geschoss (waagrecht/geneigt nach unten mit 1.8…6 m
  freiem Raum darunter — nicht die verdeckten Schichten des Deckenpakets, nicht Tische/Gelände; nur NEE, für Blick und BRDF unsichtbar,
  Reichweite 8 m; nur ohne Leuchten im Modell; Schalter „Raumlicht“). Ersetzt das Innenlicht hinter Glas der Etappe 3. Auswahl in zwei
  Stufen (räumlich sortierte Gruppen zu 16, vorgerechnete Lichtsätze), Power-Heuristik gegen die BRDF (Portal-Dichte über alle
  gekreuzten Scheiben, Licht-Index im Dreieck); Portale und Raumlicht nur „drinnen“ (Kamera im Raum per CPU-Probestrahlen XOR
  ungerade Zahl gekreuzter Portale), letzte Pfad-Ecke mit vollem Lichtgewicht. (3) Belichtungsautomatik (`render3d/src/exposure.rs`:
  Histogramm über log-Luminanz, 40.–95. Perzentil, Ziel `KEY`/Mittel, Tag ¼…32×, Nacht ¼…1× der Himmelsbelichtung, im Viewport je
  Bild sanft nachgeführt, Export/headless sofort) und im Viewport unten links „Belichtung“ (−3…+3 Blenden, Doppelklick 0), „Auto“,
  „Raumlicht“ (Ansichtszustand, kein Op; de/en). (4) Tempo: Zeitstempel je Abschnitt (`render_png --timing`; lavapipe kann sie):
  Samples ≫ Entrauscher (6 Pässe ≈ 5–10 % eines Samples, einmal je Bild) ≫ Belichtung + Anzeige (≈ 10 ms); Bildkarten kosten nicht
  messbar (`--pt-notex` gleich), Abpraller ab dem zweiten den Grossteil (1 Abpraller ≈ 22 % der Zeit). Baum als breite Knoten
  (`GpuWideNode`, Hüllen beider Kinder im Elternknoten, ein Ladevorgang je Schritt; Wanduhr −17 %, in CPU-Zeit nicht sicher von
  Rauschen zu trennen); Stapel mit Eintrittsabständen ausprobiert, nicht schneller, verworfen. Lichtwahl zuerst über alle Lichter:
  nachts aussen 3× langsamer → Gruppen + „nur drinnen“: aussen bei Nacht wie vorher, am Tag +25 %, innen +40 % je Sample bei
  deutlich weniger Rauschen (Innenraum ohne Sonne im Raum, 32 Samples roh: relatives Rauschen 0.233 → 0.153, also Varianz /2.3 bei
  1.4× Zeit; mit Sonne im Raum 0.170 → 0.129 — das indirekte Licht der Sonnenflecken bleibt der Hauptteil). Messung über die
  CPU-Zeit von lavapipe (die Maschine war durch Parallel-Builds stark belastet, Wanduhr ±50 %). (5) Teil-Update des Baums:
  Dreiecke je Klumpen zwischengespeichert (nur geänderte Klumpen neu gelesen), `Bvh::refit` bei gleicher Topologie (Hüllen neu,
  Neubau wenn SAH > 1.3× oder Topologie anders), Bildkarten-Wechsel ohne Baum. Neubau Musterhaus komplex (165 k Dreiecke, inkl.
  Lichtliste) ≈ 0.5 s. `render_png --eye/--fov` (Innenansicht), `--portals off`, `--room-light off`, `--exposure`,
  `--auto-exposure off`, `--timing`. Geprüft: `cargo test --release` render3d (auch `--features png` mit lavapipe: Portale
  Erwartungswert gleich bis 0.02 %, Varianz /3.9, auch mit Kamera draussen; GPU-Belichtung = CPU-Referenz; Refit eines verschobenen
  Objekts, kleine Grenzen; breite Knoten = Brute-Force), WGSL nach MSL, `cargo check --features window`, render3d-WASM (`--no-opt`),
  tsc, vitest (Viewport, i18n), e2e [212] in Chromium/SwiftShader, Bilder Musterhaus komplex mit lavapipe (Innen Tag/Nacht/ohne
  Sonne, Aussen Tag/Nacht, je 32 Samples vorher/nachher). **Offen:** echte GPU und Mac/Metal; im Browser nur der e2e-Klickweg, Bild
  nicht angesehen; Raumlicht fällt nicht aus den Fenstern aufs Gelände (Absicht, Tempo), erleuchtete Fenster von aussen bei wenigen
  Samples körnig; indirektes Licht der Sonnenflecken (NEE auf beleuchtete Flächen, Cache) fehlt; Refit greift selten (Wände ändern
  beim Verschieben meist die Gehrungen der Nachbarn = andere Topologie); Leuchten im Modell (Bibliothek) gibt es nur über den
  Baustoffnamen; AO-/Höhenkarten (`*_AmbientOcclusion`, `*_Displacement`) nicht angefangen; Mond, OIDN.
- ◐ **[215]** Cycles eingebaut für Endbilder (Entscheid Maintainer 16.11.: **vor 1.0**, damit man Blender nicht braucht): Cycles-Standalone (Apache-2.0, aus dem Blender-Projekt) als mitgeliefertes
  Hilfsprogramm (Sidecar) der Desktop-App, Metal auf Apple Silicon, OIDN-Entrauscher; Szene direkt als Cycles-XML aus dem Kern (statt glb + Python wie die Blender-Brücke [211], die als Option bleibt).
  Build-Kette macOS (C++, Abhängigkeiten) in CI, Herkunft in `NOTICE` ([51], seit 16.11. eingetragen). · L
  **Stand 16.11. (Spike, Plan in `doc/CYCLES.md`, noch kein App-Umbau):** Linux-CPU-Build gelingt, ohne Blender-Vorbau (12–25 GB): Cycles 5.3.0 + Embree + OIDN 2.5.0, `cycles` 7,3 MB, mit 21 Bibliotheken
  **111 MB entpackt / 58 MB `tar.xz`**, nur permissive Lizenzen; Bau 8 min bei 4 vCPU (`scripts/cycles/build-linux.sh`, ganz durchgelaufen; Patch `scripts/cycles/patches/no-ocio.patch`: OCIO optional;
  eigenes schlankes OpenImageIO und libtiff, weil Ubuntus 430 MB/GPL-jbig mitbringt). Testhaus (`scripts/cycles/spike-scene.py`: Quader, Satteldach, Nishita-Himmel mit Sonne, Principled BSDF, Box-Textur) gerendert und angesehen:
  Start 0,7 s, 1280×720 mit 64 Samples + OIDN **29 s** (ruhig, 4 vCPU; unter Last 51 s), 256 Samples 86 s. Gelernt: Kamera blickt +Z, Matrix spaltenweise; Himmel braucht Hintergrundlicht (`use_mis`); kein Tonwert im
  Standalone (EXR → Belichtung/Tonwert/sRGB macht Dossier); ohne OCIO nur „auto“/Non-Color als Farbraum. **Empfehlung:** Cycles einbauen, Pathtracer [212] bleibt Vorschau; Aufwand **12–16 Tage**
  (Bauskripte/CI 2, Mac/Metal/Signieren 3 (Mac), XML-Schreiber im Kern 4–5, Job/Dialog/CLI 1–2, Tonwert/PNG 1–2, Feinschliff 1–2). Mac-Skript `scripts/cycles/build-macos.sh` nur Entwurf (nichts ausgeführt).
  **Offen:** gesamter Mac-Weg (Metal, Kernel-Übersetzung beim ersten Start, Zeiten), älterer Linux-Unterbau für AppImage, kleinerer Embree/OIDN, grosse Modelle, Tonwert-Look gegen den Blender-Leser (AgX), Sonnen-Drehsinn prüfen.
  **Stand 17.11. (Teil 1: Szene + CLI):** Kern schreibt die Cycles-XML-Szene (`cycles_scene.rs`, Abfrage `cyclesScene`; gleiche Netze wie glTF/3D, Materialien, Glas, Box-Texturen, Kamera, Sonne/Nishita, Belichtung), Tonwert im Kern (`cycles_post.rs`), TS `src/export/cyclesRender.ts` (EXR lesen, PNG), CLI `render --engine cycles` (`--engine blender` bleibt Standard). Tests: Rust 18, vitest (Ersatz-`cycles`, EXR/PNG), Integrationstest nur mit `DOSSIER_CYCLES`. Echte Läufe `:beispiel`, `:musterhaus-komplex`, `:wettbewerb` (1280×720, 64 Samples: 44–249 s auf ausgelasteten 4 vCPU) angesehen, Bilder in `doc/review-215/`; Details `doc/CYCLES.md` Abschnitt 11. **Offen:** Dialog/Sidecar/Mac (Teil 2), Normalenkarten, Mac/Metal ungeprüft, Standard-Engine der CLI auf Cycles umstellen sobald das Programm ausgeliefert wird.

  **Stand 16.11. (Teil 2: Bau und Auslieferung, `doc/CYCLES.md` Abschnitt 10):** `.github/workflows/cycles.yml` (Linux ubuntu-24.04, macOS-14 arm64; Pakete `cycles-<os>-<arch>-<version>.tar.xz` als Artefakt und am Gitea-Release
  `cycles-<version>`, `scripts/cycles/{pack.sh,upload-gitea.mjs,fetch.mjs,get.sh}`), `release.yml` lädt das Paket vor dem App-Bau; `build-macos.sh` fertig geschrieben (Dylibs, RPATH, Metal-`source/`, Lizenzen), Lizenztexte im Paket, `NOTICE`.
  Mitgeliefert: Electron `extraResources` → `resources/cycles/` (`DOSSIER_CYCLES_DIR`/`--cycles=` für lokale Ordner), Tauri `externalBin` + `resources` über `src-tauri/tauri.cycles.conf.json`; Fassade `src/native/cyclesRuntime.ts`
  (`cyclesAvailable`, `runCycles` mit Fortschritt und Abbruch; Browser false), Hauptprozess/Rust prüfen Argumente und starten nur das Paketprogramm. **Geprüft:** vitest, `rustc --test` (cycles.rs, blender.rs), echtes AppImage mit dem Linux-Paket:
  `test:linux-app` rendert das Testhaus (8 Samples, PNG, Fortschritt, Abbruch); AppImage 185 → 252 MiB (+ 70 MB). **Nicht geprüft:** beide Workflows (nie gelaufen, kein GitHub im Container), gesamter Mac-Weg (Bau, Tauri-Befehle — Tauri-Crate
  im Container nicht übersetzbar —, Resources-Syntax, Signieren/Notarisieren der Mach-O-Dateien, universale App mit arm64-Sidecar), Linux-Lizenzschritt nur in Teilen. **Offen (Rest von [215]):** XML-Schreiber im Kern, Dialog „Rendering“ mit Cycles, Tonwert/PNG, CLI `cycles`.

  **Stand 17.11. (Teil 3: Dialog „Rendering …“ mit Cycles):** `ui/RenderDialog.tsx` bietet „Renderer: Eingebaut (Cycles) / Blender“ (Vorgabe eingebaut, wenn `cyclesAvailable()`, sonst Blender; Browser: Option ausgegraut mit
  „Nur in der Desktop-App“, Paket-ZIP wie bisher). Cycles-Einstellungen: Grösse (neu „Vorschau 960 × 540“ plus Full HD/4K/A4–A2 bei 300 dpi, Kante ≤ 8192), Qualität Vorschau 32 / Normal 128 / Hoch 512 oder eigene Samples, Entrauschen, Belichtungskorrektur (EV, 0 = automatisch),
  Kamera (aktuelle 3D-Ansicht oder gespeicherte [213], mit Sonnenzeit), Datum/Uhrzeit, Kontext an/aus, Baugrube ausblenden. Ablauf `state/cyclesAction.ts` (`renderWithCycles`, Abhängigkeiten austauschbar): Szene über den Kern → `prepareCyclesScene` → `runCycles` →
  EXR → Tonwert → PNG (Zlib im Webview: `pako`, neu als direkte Abhängigkeit); Fortschritt „Sample n von N“, verstrichene Zeit und Restzeit-Schätzung (aus dem Takt seit dem ersten Sample), Abbrechen-Knopf, Vorschau, „Bild speichern …“, „Ins Layout einsetzen“ (wie [211]/[223]);
  Fehler (Programm fehlt, Start abgelehnt, Absturz mit Code, kein Bild, leeres Modell) als Meldung im Dialog und `notify()`; Arbeitsordner wird in jedem Fall gelöscht (neu `cleanupCyclesScene`, Electron-IPC `cycles:cleanup` nur direkt unter `dossier-render`, Tauri `fs:allow-remove`).
  Dialogtitel/Menü jetzt „Rendering …“. **Geprüft:** vitest (`cyclesAction.test.ts`: Vorgaben, Restzeit, Fortschritts-Parser, Abbruch, alle Fehlerpfade, Aufräumen; `cyclesRuntime`/`electronCycles`: Cleanup), Browser-e2e (`release10.spec.ts`: Option ausgegraut mit Hinweis),
  **echtes AppImage mit Cycles** (`e2e/linuxApp170.spec.ts`, Musterhaus komplex: 320 × 180 mit 8 Samples → Fortschritt gesehen, Bild 320 × 180, ins Layout eingesetzt, Temp-Ordner leer; Abbrechen bei 960 × 540 / 512 Samples beendet den Prozess, danach neuer Lauf), Bilder `doc/review-215/dialog-*.png`.
  **Offen:** Mac/Tauri/Metal nicht geprüft (Tauri-Weg `fs.remove`, Berechtigungen, Kernel-Übersetzung beim ersten Start: Hinweistext im Dialog steht, Dauer unbekannt); Tonwert-Look (Filmic) nicht wählbar im Dialog; Belichtungskorrektur wirkt erst beim Rendern (kein Nachbelichten des fertigen Bildes);
  EXR/Tonwert laufen synchron im Webview (A2 bei 300 dpi blockiert die Oberfläche kurz); CLI-Standard bleibt Blender (Umstellung nach Auslieferung des Pakets auf dem Mac).

### Nicht in 1.0 (bewusst später)
Ausführungsplanung 1:50/1:20-Details, [42] Varianten, [11] Bibliothek per GUID, [88] Web-Link, [G7] Booleans-Ausbau,
Punktwolken/BCF-Ausbau, Windows-Paket, [C5]/[C7]/[15] Kern-Umbauten — ausser sie blockieren den Referenz-Ablauf.

---

## Grundriss

- ◐ **[213]** Kameras und Begehen im 3D (12.11., Wunsch Maintainer; ersetzt den offenen Eintrag in „Release 1.0“). Umgesetzt: Modell `Project.cameras`
  (Rust `Camera`: Name, Geschoss, Standpunkt + Augenhöhe über Geschoss, Ziel + Zielhöhe, Bildwinkel/Brennweite, Perspektive/Axonometrie/Parallel,
  Sichthöhe, Sonnenstand als ISO-Zeit; Klasse „Kameras“ Code 92, `standards::CAMERA_CATEGORY`); Ops über die gewöhnlichen Helfer. Grundriss-Symbol im Kern
  (`plan/cameras.rs`: Gehäuse mit Objektiv, Sichtkegel bzw. Streifen, Ziel mit Blicklinie, Name; Pick-Bänder `@camera:<id>`, nur Gehäuse/Kanten/Ziel,
  nicht der ganze Kegel); Griffe im Kern (`camera.rs`/`grips.rs`: Standpunkt, Ziel, Bildwinkel bzw. Sichtbreite, `cameraGrip`/`cameraBy`);
  Objekt-Info-Abschnitt `CameraSection` (Werte, Brennweite ↔ Bildwinkel, Sonne, „Kamera öffnen“, „Aus aktueller Ansicht“, „Isometrisch“); Liste mit Anlegen/Öffnen/Löschen im
  Panel „Ausschnitte“ (`CamerasGroup`); 3D: Knopf „Kamera+“ legt aus der aktuellen Ansicht an, Doppelklick auf das Symbol im Grundriss bzw. „Kamera öffnen“ setzt die 3D-Ansicht
  exakt (Reiterwechsel, Sonnenstudie übernimmt `sunWhen`); `viewport/cameraView.ts::cameraToView(project, camera)` liefert dieselbe `ViewCamera` wie `getCamera()`
  (Anschluss für das Rendering [211]: `cameraToView` statt der Live-Ansicht). Begehen: Umschalt+F bzw. Knopf „Begehen“, darin W/A/S/D und Pfeile gehen (horizontal, Augenhöhe bleibt),
  Q/E runter/hoch, Umschalt ×4, Alt ×0.25, Maus (links oder rechts) schaut um den Augpunkt, Esc beendet; die Tasten gelten nur im Modus (sonst kollidieren sie mit S/D/Q, [190]), pro Frame mit
  gekapptem Zeitschritt (`viewport/walk.ts`). Beispiel: Kamera „Südost“ im Musterhaus komplex. Bearbeiten (13.11.): Kameras gehen in Verschieben/Kopieren/Reihe/Drehen/Spiegeln/Skalieren (Kern `cmd_transform.rs::mv_camera`: Standpunkt und Ziel
  werden abgebildet, Augen-/Zielhöhe, Bildwinkel, Sichthöhe bleiben; gesperrte bleiben; Kopie = neue id `camera-…` und Name „… Kopie“, nummeriert bei Kollision; Vorschau mit Blicklinie),
  in die Mehrfachauswahl (`cameraIds` in `TransformSelection`/`CommandSelection`) und in die Element-Zwischenablage (Ctrl/Cmd+C/V, `cmd_paste.rs`, auf dem aktiven Geschoss, Name „… Kopie“).
  Gruppen (13.11.): Kameras sind Gruppenmitglieder (`Group.cameraIds` im Rust-Modell, `groups.rs` `KINDS`/`Membership`, Warnung `project_refs.rs`, `groupActions.ts`/`model/groups.ts`, Sperr-Helfer, Klick/Rahmen/Isolation inkl. Dimmen über `@camera:<id>`); eine Kamera in der Auswahl zieht ihre Gruppe nach, daher gehen Verschieben/Kopieren/Zwischenablage einer Gruppe samt Kameras (Kopie: neue id, „… Kopie“). Entf nimmt gelöschte Elemente (alle Arten, nicht nur Kameras) aus ihren Gruppen (`pruneGroupMembers`). Nebenbei: `Project::set_field` kannte `cameras` nicht (typisierte Sicht ohne Kameras bei Laden/Ops), nachgeführt.
  IFC: Kameras werden bewusst nicht exportiert (IFC kennt keine Kamera als Bauteil). Offen: nicht in der Tauri-App geprüft (3D headless leer, Kamera-Brücke nur per Zustand); nativer Mac-3D ohne
  Begehen/Kameras (`native.rs` ist Linux/winit); Stil „Sonne am Tag“ (Datum/Uhrzeit-Dialog) und Animation entlang mehrerer Kameras. Kollision und Bodenfolge im Begehen: [245]. · M
  Begehen/Kameras (`native.rs` ist Linux/winit); Stil „Sonne am Tag“ (Datum/Uhrzeit-Dialog). Kamerafahrt durch mehrere Kameras: erledigt als [246]. · M
- ◐ **[205]** Pausfolie/Referenz wie Archicad „Trace & Reference“ (12.11., Wunsch Maintainer). Umgesetzt (12.11.): **Entscheid:** die Pausfolie ist UI-Zustand je Reiter (`state.trace`, Typ `TraceReference` aus dem Rust-Modell; mit dem Reiter in `uiState.viewTabs` und im Ausschnitt `ViewSnapshot.trace` gespeichert, kein Op, kein Undo, nie im Druck/Export). Die Quelle rechnen die bestehenden Abfragen (`planDomains`, `sectionPlan` + eigene 2D-Elemente, `elevationPlan`), die TS-Fassade `plan/trace.ts` schickt sie als Teil-Abfragen an die neue Kern-Abfrage `tracePlan` (`plan/trace.rs`): Ausrichtung nach Koordinatenraum (Schnitt/Ansicht hinter Grundriss an der Schnittlinie aufgeklappt, u längs der Linie, jenseits des Grundrisses; Grundriss hinter Schnitt wie bisher die Unterlage `underlay.rs`; gleicher Raum deckungsgleich, Schnitt hinter Schnitt höhengleich), dann Verschieben/Drehen (Starrkörper), Auswahl-Ids weg, Farbe nach Deckkraft zur Papierfarbe aufgehellt in den Primitiven selbst — alle drei Zeichenwege (WebGPU, Metal, SVG) ohne eigene Logik; `withTrace` legt sie unter/über den Plan. **Vereinheitlicht:** die [203]-Überlagerung anderer Geschosse über den Modus „Andere grau“ entfällt im Grundriss (Modus wirkt nur noch im 3D), die Grundriss-Unterlage `DrawingLevel.planUnderlayId` (Objekt-Info Schnittlinie, Abfrage `planUnderlay`) entfällt, Schnitt/Ansicht hinter freien Zeichnungen über das Auge entfällt — alles nur noch als Pausfolie; Auge/Modus komponiert weiter Geschoss ↔ freie Zeichnung. **Bedienung:** Navigator-Kontextmenü „Als Pausfolie zeigen“, Statusleiste „Pausfolie“ (Ein/Aus, ▴: Quelle, Farbe, Deckkraft, über/unter, Versatz, Drehung, Verschieben/Drehen per Klick, Zurücksetzen), Kürzel Cmd/Ctrl+Shift+T (rebindbar, Menü Ansicht), Befehle `tracemove`/`tracerotate`. Tests: Rust `plan::trace` (9), vitest `plan/trace.test.ts`, `state/traceRef.test.ts`, `levelTrace203` angepasst, e2e `trace205`. Offen: Fang auf der Pause nur im Schnitt/in der Ansicht (im Grundriss nicht); Blatt/Layout als Quelle und Pause im Layout; nicht in der Tauri-App/auf dem Mac (Metal) geprüft. Opus. · L
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
  Ansicht per CLI vor/nach byte-gleich. Nachtrag (12.11.): Linien des Standort-Imports (OSM/swisstopo-Umrisse:
  Strassen, Parzellen, Gewässer, Gebäudeumrisse …) sind jetzt einzelne `drawing2d`-Polylinien (offen/geschlossen) auf der
  Klasse ihrer Kategorie, auf der aktiven Ebene, Stift aus der Klasse – einzeln wähl-, verschieb-, lösch-, editierbar
  (`io/geoContext.ts::featuresToImport`, `siteSlice.addContextObjects(objs, lines)`, ein Undo-Schritt; Dialog und
  Fenster-Brücke reichen `lines` durch). `contourSet` bleibt nur für echte Höhenlinien (mit z). Tag-Namen
  `importedMesh`/`terrainMesh` bewusst belassen: die zwei Arten tragen verschiedene Felder (Gelände: Höhenfarben,
  Intervall, Erdtiefe, Glättung, Quell-Id; Netz: Farbe, Glättungswinkel, IFC-GlobalId), ein gemeinsamer Typ `mesh` mit Rolle
  wäre eine Union mit vielen Option-Feldern und würde ~360 Stellen in ~94 Dateien berühren, ohne Code zu sparen; der Name
  ist nur ein Tag. Offen: Mac-Gegenprobe. · L
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
  Grau im 3D (12.11.): Klassen im Darstellungsmodus „grau" fehlen im Hauptmodell und erscheinen als Geisterschicht
  (Kern `ClassFilter`, Text `{"grey", "lock", "ghost"}`: `ghost` liefert nur die grauen Elemente, Öffnungen grau mit
  Klasse oder Wirt, ausgeblendet geht vor; render3d `ghost.rs` + `set_ghost_model`: gleiche Vernetzung wie das Modell,
  hell entsättigt, durchscheinend (Alpha 0.2) mit hellgrauen Kanten, Pipeline der zulässigen Hülle); anwählbar wie im
  Grundriss (grau ja, „grau + gesperrt"/„gesperrt" nicht, `lock`); Einpassen zählt graue mit; natives 3D-Fenster
  (`native.rs`, Linux/winit — ein Mac-3D-Fenster gibt es nicht) bekommt Darstellungsmodus und Geisterschicht (`ghost`
  im Push); CLI `model3d --grey …` + `render_png` zeichnen sie. Tests `model3d/classes.rs`
  (`grau_klasse_in_der_geisterschicht`, `grau_oeffnungen_folgen_klasse_und_wirt`), `model3d_cache.rs::grey_class_ghost_split`,
  `render3d/ghost.rs`, `toWalls3d.classes.test.ts`, `view3dFilter.test.ts`.
  Grau im 3D, Reste (12.11.): graue Geschosse (Zeichnungsebenen-Modus „grau", `greyedFloorIds`) laufen als `greyFloors`
  durch dieselbe Weiche wie graue Klassen (`ElementSelection::grey_floors`, Text `{"greyFloors": [ids]}`; Öffnungen folgen
  dem Wirt, Geschoss-Auge aus und ausgeblendete Klassen gehen vor, anwählbar wie im Grundriss); 2D-Spuren und
  Flächenmuster grauer Klassen/Geschosse kommen mit dem Geister-Filter aus denselben Kern-Abfragen und stehen
  gedämpft (Kantenfarbe der Geisterschicht, `ghost::mute_lines`/`mute_pattern`, render3d `set_ghost_lines`; Muster mit
  derselben Abstands-Auswahl wie das Hauptmuster); Teil-Update: `ghostSync.ts` bildet eine Prüfsumme aus Modell-Text und
  Linien-Puffern, `set_ghost_model`/`set_ghost_lines` laufen nur bei geänderter Schicht (Renderer-Wechsel setzt zurück);
  CLI `model3d --grey-floor <id|Name>` (+ `ghostDrawing`/`ghostPattern` für `render_png`). Tests `model3d/classes.rs`
  (`graues_geschoss_in_der_geisterschicht`), `render3d/ghost.rs`, `toWalls3d.classes.test.ts`, `view3dFilter.test.ts`,
  `ghostSync.test.ts`. Offen: render3d vernetzt die Geisterschicht bei Änderung weiterhin ganz neu (nur das Auslassen
  bei Gleichheit, kein Teil-Update einzelner Elemente); `native.rs` nicht kompiliert (Feature `native3d`, Platte); Datei-Exporte (OBJ/glTF/IFC/STEP) bleiben vollständig; kein e2e (3D-Pick headless unzuverlässig);
  nicht in der Tauri-App/auf dem Mac geprüft. · M
- ◐ **[193]** Anwählen/Bearbeiten von Gelände & Co. (12.11., Maintainer, PRIO; Stand 11.11.): **erledigt** — Cmd+A nimmt Gelände, Höhenlinien, Baugrube, Netze, Bilder mit (sichtbare, nicht gesperrte Klasse; reine Funktion `state/selectAll.ts`) und die Schattenfläche der Sonnenstudie (`site: sunStudy`); Entf löscht sie in einem Undo-Schritt (Schatten: blendet `sunStudy.show` aus). Die „nicht lösch-/anwählbare Schraffur" war der Schatten der Sonnenstudie (abgeleitet aus den Geschossen, die Cmd+A nicht erfasst, Loch = Treppenöffnung); er war schon anwählbar ([137]), aber Entf tat nichts. Verschieben/Kopieren/Drehen/Spiegeln für Kontext-Elemente (Kern `cmd_transform.rs`, `contextIds`; Baugrube, Höhenlinien, Netze, Bild); Objekt-Info: Höhenversatz für Gelände/Netz/Höhenlinien/Baugrube und Höhe je Höhenlinie (`state/contextHeight.ts`, TS-Hilfe, später in den Kern). Baugrube war im Grundriss schon anwählbar (Kern-Pick) und hat Eckgriffe (`useGripEditing`); e2e `selectAllContext.spec.ts`. **Update 11.11. (Rest):** Höhen-Helfer nach Rust (`cmd_context.rs`: `contextOffset`/`contourZ`, TS-Fassung `contextHeight.ts` gelöscht; Store `offsetContextHeight`/`setContourHeight`); Maus-Ziehen im Plan für gewählte Kontext-Elemente (Baugrube, Höhenlinien, Netze, Bild: Vorschau und Ops aus dem Kern-Transform, Fang auf den ersten Punkt, ein Undo-Schritt, `moveContextBy`); Höhenlinien-Punkte als Griffe (`contourGrip`/`contourInsert` in `grips.rs`, Einfüge-Rauten wie [26], ein Undo-Schritt je Zug; ab 600 Punkten keine Griffe, ab 100 keine Rauten); Entf und Cmd+A auf den Ansichts-Schlagschatten (`viewShadows`) blenden `shadows` der Ansicht aus. e2e `contextDrag.spec.ts`. **Update 12.11. (Rest):** Höhenlinien-Punkt löschen im Rechtsklick-Menü („Ecke löschen", gleiche Mechanik wie [26]: `ringDelete`/`ringTidy` mit `kind: "contours"`, Kern `grips.rs::contour_ring_edit`, Minimum offen 2 / geschlossen 3); eingefügte oder gezogene Punkte, die auf einem Nachbarn oder der Nachbargeraden landen, entfallen beim Setzen im selben Undo-Schritt. Gelände-Netz (`terrainMesh`/`importedMesh`): Netzpunkte als Griffe im Grundriss (`meshGrip`, bis 600 Punkte, grössere Netze ohne Griffe), Höhe je Netzpunkt in der Objekt-Info (Nummer + Höhe, Befehl `meshPointZ`), Zuschneiden auf die Parzelle (Befehl `meshCrop`, Schwerpunkt-Test, Punkte und `vertexColors` werden bereinigt; Knopf in der Objekt-Info). **Update 12.11. (Netz-Reste):** Klick auf einen Netzpunkt-Griff macht ihn zum aktiven Punkt (`activeMeshPoint`; die Objekt-Info füllt Nummer und Höhe vor), Rechtsklick auf den Griff: „Höhe setzen …" (Overlay-Eingabe, `meshPointZ`) und „Netzpunkt löschen" (Kern `cmd_context.rs::mesh_point_delete`, Befehl `meshPointDelete`: Dreiecke um den Punkt entfallen, das Loch wird per Ohr-Triangulation neu vernetzt; am Netzrand schliesst die Sehne, entartete Dreiecke entfallen; auch als Knopf in der Objekt-Info); grosse Netze (>600 Punkte) bekommen Griffe für die Punkte im sichtbaren Ausschnitt (+50 % Rand, höchstens 600, der Mitte nächste; `geometry/meshPick.ts`, Ausschnitt-Brücke `state/planViewport.ts` aus `PlanView`, 150 ms verzögert); eigener Hinweis „Mindestens zwei Punkte bleiben" für offene Höhenlinien; Befehl `meshcrop` („Netz zuschneiden": Polygon oder zwei Ecken = Rechteck, Knopf „Auf Polygon zuschneiden …" in der Objekt-Info). **Offen:** Löschen mehrerer Netzpunkte auf einmal; Netz-Ausdünnen/Aufräumen. Nicht in der Tauri-App getestet. · M
- ◐ **[200]** DXF-Export: Stifte je Element, Schnitt/Ansicht (12.11., Paritäts-Doku `doc/DATEIFORMATE.md`). (1) Entitäten tragen eigene Farbe (True-Color 420 + nächste ACI 62) und Strichstärke (370, auf CAD-Stufe gerastet), wenn Linie/Bogen/Kreis/Umriss vom Ebenen-Standard abweichen, sonst ByLayer: neuer Satz `ENTPEN` (27) in der flachen Zeichnung (`plan/dxf.rs::Pen`, `fileio/export.rs`), gilt für DXF, Binär-DXF und DWG; Blöcke beginnen ByLayer; 3-stellige Ebenenfarben (`#000`) werden jetzt wie 6-stellige gelesen. (2) Schnitt und Ansicht als DXF/DWG: App-Export-Dialog folgt der aktiven Ebene (`viewportLevelPlan`, Beschriftung Plan/Schnitt/Ansicht), CLI `section|elevation <Name> --format dxf|dxfbin|dwg`. Tests: Rust (`fileio` `stift_je_element_…`, Kern `stift_je_element_vor_der_entitaet`), vitest `exportDxf.ezdxf.test.ts` (ezdxf, DXF und Binär), `exportDxf.section.test.ts`, `cli.test.ts`. (3) 13.11.: Klassen-Stil beim Export aufgelöst (Tür-/Fenster-/Achslinien: Klassenfarbe, sonst Tinte `#1a1a1a`, wie `scene::stroke_color_for`; Stärke kam schon aus `weightMm`), auch im Blockinhalt von Türen/Fenstern/Blöcken (Vergleich gegen die Ebene der Einfügung, vorher dort alles ByLayer); Texte (Einzeltext, Raumstempel) mit Farbe der ersten Textstrecke, ohne Stärke; Schnitt/Ansicht laufen durch denselben Sammler, daher gleich. Tests: Kern `klassen_stil_und_textfarbe_im_dxf`, vitest `exportDxf.pens.test.ts` (ezdxf, Blöcke über `validate-dxf.py`). (4) 14.11.: gedimmte (`greyed`, 0,3) Elemente und Objekt-Deckkraft als DXF-Transparenz (Gruppe 440, `0x02000000 | Deckkraft`) auf Linien, Bögen, Kreisen, Umrissen und Füllung/Schraffur: `ENTPEN` trägt als 3. Wert die Deckkraft 0–255 (−1 = nach Ebene; `Pen.alpha` in `plan/dxf.rs`, `fileio/export.rs`); Tests Kern `gedimmt_und_deckkraft_im_dxf`, fileio `deckkraft_je_element_als_transparenz`. (5) 15.11.: mehrzeilige Texte (Textspalten, Absätze, Auszeichnung) als `MTEXT` mit Rahmenbreite, Anhängepunkt, Absatz-Ausrichtung/Blocksatz, Schrift/fett/kursiv/Grösse/Farbe in Teilen (Datensatz `MTEXT` = 28), ausgerichtete Einzelzeile als `TEXT` mit 72/11 (s. `doc/DATEIFORMATE.md`); Tests Kern `textspalte_als_mtext_und_ausgerichteter_text`, fileio `dxf_mtext_…`, vitest `exportDxf.ezdxf` (ezdxf). **Offen:** Texte ohne Transparenz; Öffnen in AutoCAD/BricsCAD nicht geprüft (auch MTEXT); nicht in der Tauri-App geklickt. · S
- ◐ **[199]** Plan-Review Runde 3 (12.11., CLI-SVG `--hatch`, Chromium, nur Linux). Behoben: (1) Gaubenwange fehlte in der Seitenansicht (komplexes Haus Ost, Schleppgaube schwebte über der Dachfläche): die Wangen sind senkrechte Flächen; `elevation_geom::roof_faces` richtete jede Fläche nach "Normale nach oben" aus, bei senkrechten ist das Vorzeichen Rundungsrauschen, die Wange fiel je nach Zufall als Rückseite weg (3D war schon richtig, Wand-Körper geschlossen). Jetzt zeigen senkrechte Dachflächen (aus den zugewandten Dreiecken) zum Betrachter; Test `gaubenwange_in_der_seitenansicht` (flach/schlepp/sattel). (2) Schnitt A einfaches Haus, "U-Rahmen um die Treppe": kein Fehler, es ist die Fensteröffnung O2 (1.4 × 1.3, Brüstung 0.9) der Nordwand W3 hinter dem Schnitt; die Treppe verdeckt Oberkante und Seiten teils (ohne O2 verschwindet der Rahmen, geprüft). Bleibt so (Ansichtskanten hinter der Ebene). Offen, falls gewünscht: Fenster hinter dem Schnitt mit Glas/Rahmen statt nur Leibungslinie. (3) Schnitt A-A komplex, "Balken frei im DG": der Sturz über Tür T21 (`dg-t2` in Wand `dg-iw-y6`), weil die Schnittlinie x = 3 genau auf der Türkante lag; Beispiel korrigiert (Tür bei 3.6). Nicht auf dem Mac/3D (`render_png` nur Metal) geprüft, 3D nur über Kern-Tests. Goldens geprüft. · S
- ◐ **[198]** T-Stoss: gleiche Schichten verschmelzen (12.11.). Ursache: jede Wand zeichnete ihre Umriss-/Fugenlinie einzeln, am T-Stoss blieb ein Stück Wandumriss der Durchgangswand unter dem Innenputz des Abzweigs (Putz an Putz). Jetzt streicht `plan/seams.rs` nach dem Zeichnen alle Linien/Polygonkanten, die zwei Flächen gleichen Stils (Füllung + Schraffur ohne Ursprung) VERSCHIEDENER Bauteile trennen (Probe beidseits, Linie muss auf dem Rand beider Flächen liegen); Teilstücke werden zu Linien `wall-outline`/`section-joint`. Grundriss (`walls.rs`, Bänder + schwarze Sammelfläche ab 1:100), Schnitt (`section/primitives.rs`, feine Fugen; schwere Schnittkante unberührt) — Bildschirm, Druck, SVG gleich (gleiche Primitive). Materialwechsel und Fugen eigener Schichten einer Wand bleiben. Tests `plan/wall_merge_tests.rs` (T, Ecke, Kreuzung, Gegenprobe, Materialwechsel), `section/tests.rs`; Goldens nachgeführt. Nachtrag 13.11.: Flächen vereinigt — `seams::union_bands` (i_overlay) legt die Schichtbänder gleichen Stoffs verschiedener Wände (Füllung, Schraffur samt Richtung/Massstab, Deckkraft; Winkel modulo 180°, ohne Muster ohne Winkel) zu EINER Fläche zusammen (T, L, Kreuzung, Überlappung, Bogen an Gerade bei Schichten ohne Muster): eine Schraffur mit Lage/Ursprung der Hauptwand (grösstes Band, gerade vor Bogen), Löcher über Brücken, Einfügestelle am ersten Band. Die Bänder bleiben als unsichtbare Pick-Flächen (Wand-Id, Füllung „none“) — Klick, Rahmen-Auswahl und Hervorhebung je Wand unverändert; die vereinigte Fläche trägt keine Wand-Id. Läuft zuletzt in `domains.rs` (`merge_wall_bands`, nach Abzugskörpern und Stützen-Aussparung, die nur Flächen mit Wand-Id bearbeiten — sonst füllte die Vereinigung z. B. die Durchreiche im Musterhaus). Durchlaufende, nicht verbundene Wände (Überlappung): Linien quer durch eine gleich gestaltete Fläche entfallen (oberste Fläche je Probe-Seite; bei Bogenwänden nur am Stoss, Sehnenpfeil), gleicher Stoff einmal gefüllt/schraffiert. Tests `wall_merge_tests.rs` (T-Putz eine Fläche + Pick-Flächen, Ecke/Kreuzung, Mischmaterial, Überlappung, Bogen an Gerade); Test-Helfer `filled()`/Flächen-Summen zählen die Pick-Flächen. Offen: schraffierte Bogenwand an gerader Wand bleibt getrennt (polare vs. parallele Schraffur; Cmd+J verbindet Bögen seit 14.11., [190], die Flächen bleiben trotzdem getrennt); verschieden ausgerichtete Schraffur (z. B. 45°-Wand an 0°-Wand) bleibt bewusst getrennt mit Linie (Richtung trägt Bedeutung, [166]); Schnitt nur Linien, keine Flächen-Vereinigung; Musterhaus sah schon vorher fugenlos aus (Schraffur ab Weltnullpunkt) — sichtbarer Unterschied nur bei Überlappungen; Ansicht nicht angesehen; nicht in der Tauri-App/auf dem Mac (Pick/Hervorhebung dort ungeprüft). · M
- ◐ **[195b]** Objekteinstellungen als ECHTES Nebenfenster (Wunsch Maintainer, 12.11.). **Stand 12.11.:** Unter Tauri öffnet T (bzw. Menü) das native Fenster `object-settings` (`native/objectSettingsWindow.ts`, Fensterseite `ObjectSettingsWindowApp.tsx`, Protokoll `objectSettingsSync.ts`); Browser/Electron behalten das schwebende Panel. Architektur (schlankste ohne Doppelspur): das Fenster lädt denselben Store als SPIEGEL (Projekt-Leseansicht als Feld-Differenz `projectDelta` + Laden ins eigene Kern-Dokument, Auswahl, aktive Ebene, Wert-Felder des Panel-Hosts, Fokus-Abschnitt von T) und rendert unverändert `ObjectSettingsPanel`; Store-Änderungen dort rechnen ihre Ops auf dem Spiegel und gehen über `state/changeSink.ts` ans Hauptfenster (`applyChange`, Undo je Änderung, `coalesceKey` bleibt), Host-Handler per Proxy (`remoteHost`) ebenso; Cmd+Z/Shift+Cmd+Z im Fenster wirken auf den Verlauf des Hauptfensters, Meldungen erscheinen dort. Auswahlwechsel und Undo im Hauptfenster kommen als Sync (30 ms gebündelt, nur bei offenem Fenster, ohne React-Abo in `App`). Mehrfachwerte: Schraffur (Attribute) und Wandtyp/Dicke („gemischt“), Wandtyp gilt für alle gewählten Wände (ein Schritt). **Stand 12.11. (2):** „gemischt“ auch für Decke (Typ/Dicke/UK/OK), Dach (Typ/Neigung), Öffnung (Typ/Breite/Höhe/Brüstung) und Wand-UK/OK (`mixedValues.ts`, Marke `MixedMark`); die Setter dafür (`elementAttributesHost`, `patchAll`) ändern alle gewählten Elemente gleicher Art in EINEM Undo-Schritt (Dicken per `groupChanges`; Dach nur Typ/Neigung), ein nicht angefasstes gemischtes Feld bleibt unverändert; `deriveSelection` führt bei mehreren Decken/Öffnungen/Dächern mit dem ersten Element (vorher: keine Info, also kein Abschnitt). `OpeningEditorDialog` ist weg: der Editor ist der Abschnitt „Fenster-/Türeditor“ im Bereich „Objekt“ (`panels/objectInfo/OpeningEditor.tsx`, ⚙ klappt ihn auf; Host-Handler `onPatchWindowType/DoorType/onSaveOpeningStyle`; „Als Stil speichern“ mit Eingabezeile statt `window.prompt`); `setOpeningEditorId`/Dialog-State entfernt. **12.11. Ops-Strom:** das Hauptfenster schickt die vom Kern-Dokument angenommenen Ops (Commit/Griff/Befehl/Import/Undo/Redo, `ProjectDocument.onChange`) mit laufender Nummer `seq`; das Fenster führt sie ohne Verlauf nach (`applyRemote` = `doc_apply` + `applyOps`, kein Rust nötig). Rückfall Feld-Differenz + Vollabgleich bei Laden/Neu, grossem Verlaufsschritt ohne Ops; Lücke in `seq` oder abgelehnte Ops → Fenster fordert den ganzen Stand an. Messung Grossgebäude (1832 Wände, Linux-Container): Sync einer Wandänderung 0.4 ms statt 56 ms. Tests `native/objectSettingsSync.test.ts`, `objectSettingsWindow.render.test.ts`, `state/mixedValues.test.ts`, `panelHost/elementAttributesHost.test.ts`. **Stand 12.11. (3):** Mehrfachauswahl setzt jetzt auch Referenzlinie/Fugen-Versatz/Terminierung/Dachanschluss/Aussen+tragend (Wand, Decke), alle Öffnungs-Felder (nur Öffnungen GLEICHER Art Fenster/Tür; Position und Dach-/Deckenfenster-Lage bewusst nur das erste), den Fenster-/Türeditor (`onPatchOpening`, Typ-Zuweisung; ein Undo-Schritt), Treppe, Raum (SIA, Nutzung, Oberflächen; der Name bleibt je Raum eigen, Feld gesperrt), Stütze und Körper (`patchAll`/`mapAll`, `targetIds` im `elementAttributesHost`); `deriveSelection` führt auch bei mehreren Treppen/Räumen/Körpern/Stützen mit dem ersten Element; „gemischt“ für Referenzlinie, Treppe (Typ/Form/Breite/Stufen/Steighöhe), Öffnungs-Anschlag/Aufschlag/Richtung/Flügel, Raum-SIA, Höhe von Stütze/Körper. Dach-Kanten, Gauben und Innenhöfe sind dachspezifisch: nur bei EINEM Dach angeboten. Tests `native/objectSettingsSync.test.ts`, `objectSettingsWindow.render.test.ts`, `state/mixedValues.test.ts`, `panelHost/elementAttributesHost.test.ts`, `objectInfo/OpeningEditor.render.test.ts`. **Offen:** NICHT auf macOS gebaut/getestet (nur vitest/tsc im Linux-Container; Capability `object-settings` ergänzt, kein Rust); kein Messwert (Live-Mass) im Fenster; Gelände/Baugrube haben keinen Setter im Objekt-Info (nichts umgestellt). **Stand 12.11. (4):** Dach: bei Mehrfachauswahl gelten ALLE Felder für alle gewählten Dächer (Form, Firstrichtung, Dicke, Traufhöhe, Überstände, Mansarde, Halbwalm, Attika; ein Undo-Schritt je Änderung) ausser den dachspezifischen Umriss/Breite/Tiefe, Kanten, Gauben, Höfe; „gemischt“ für alle diese Felder (`selectionRoofValues`). Decke geprüft: Aussen/tragend und Randlage wirken schon auf alle, Öffnungen (Aussparungen) sind je Decke eigen und bleiben beim ersten. · L
- ◐ **[194]** Texte exakt synchron beim Zoomen (12.11., Maintainer Mac: Texte immer leicht verzögert; Nachfolger [145]).
  12.11.: Die native Fläche zeichnet die Plan-Texte selbst im selben Frame wie die Linien: Raumstempel und waagrechte
  Textfelder/Masszahlen/Beschriftungen (mehrzeilig, Umbruch, fett/kursiv, Ausrichtung) über denselben Glyphen-Pass
  wie im Browser (`render2d/src/glyph.rs`, eingebettetes Inter; Zeilen aus dem Kern `plan_screen_texts`, Befehl
  `native2d_scene_texts`), gedrehte Einzeiler wie bisher als Vektor-Glyphen; Overlay nur noch gedrehte Mehrzeiler,
  Text auf Pfad, Editor, Griffe. Offen: auf dem Mac prüfen (Takt, Schärfe auf Retina, Bild gegen SVG); Griffe nativ;
  gemischte Schnitte innerhalb einer Zeile (Schnitt des ersten Laufs gilt). · M
- ◐ **[190]** Verbinden wie Archicad + Kürzel (12.11., Wunsch Maintainer). Umgesetzt (12.11.): Cmd/Ctrl+J („join") schliesst bei
  gewählten Wänden auch Ecken: nicht parallele gerade Wände eines Geschosses, deren Enden bis 0.5 m (bzw. 2 × Wanddicke)
  vom Achsschnittpunkt liegen (Lücke oder Überstand), werden dort verlängert/gekürzt (L-Ecke, beide Enden); Ende nahe einer
  anderen Wand, deren Achse im Innern getroffen wird, ergibt einen T-Stoss (nur dieses Ende rückt). Mehr als zwei Wände: alle
  Paare, nahe Paare zuerst, jedes Ende höchstens einmal; kollinear wie bisher zusammengefasst (dann nicht noch einmal
  angefasst). Gehrung/Anschluss aus `joins.rs`; Öffnungen und Bemassung führt `cmd_wall_edit::commit` nach (wie Trim/Extend:
  Öffnungen bleiben im Plan stehen, [188]), ein Undo-Schritt; ohne Wirkung Hinweis `cmd.join.nothing`. Kern
  `cmd_wall_edit.rs::connect_ops`; Tests `verbinden_*`; e2e `wallJoin190.spec.ts`. Das Tastenkürzel reagiert jetzt auch bei
  reiner Wandauswahl. Neue umbelegbare Kürzel (Einstellungen): Cmd+D Duplizieren (Kopie 0.5 m versetzt, danach gewählt),
  Cmd+L Sperren/Entsperren, Cmd+Shift+H Ebenen der Auswahl ausblenden, Cmd+Shift+A alle Ebenen einblenden, Cmd+0 alles
  einpassen, Cmd+Shift+F auf Auswahl einpassen (ohne Plan: 3D-Kamera); alle im nativen Menü (`state/selectionActions.ts`).
  Nachtrag (13.11., Meldung Maintainer „Cmd+J geht bei Wänden nicht" in der Mac-App): T-Stoss endet jetzt an der dem Abzweig
  zugewandten Fläche der Durchgangswand (Referenzlinie beachtet; `joins.rs` schneidet dort sauber, Test gegen `compute_joins`),
  nicht mehr an der Achse. Hinweis ohne Wirkung nennt den Grund (`cmd.join.far` mit Abstand/Toleranz, `.met`, `.cross`,
  `.parallel`, `.arc`, `.locked`, `.floors`, `.few`; Kern `join_hint`, Zahlen als `Schlüssel|arg|arg` im `notice`). Mac-Weg:
  das native Menü (Accelerator CmdOrCtrl+J) fängt die Taste ab, das Fenster bekommt kein keydown; der Menü-Weg und das
  Tastenkürzel laufen nun über `state/selectionJoin.ts` (Auswahl frisch aus dem Store, nicht aus der Render-Closure; auch der
  Engine-Kontext liest sie frisch), e2e `wallJoinMenu190.spec.ts` löst `selectionAction("join")` wie der Menüpunkt aus.
  Eine veraltete Closure war im Code nicht nachweisbar; die genaue Mac-Ursache ist ungeprüft (kein macOS hier).
  Nachtrag 14.11.: Bogenwände werden mitverbunden (L-Ecke, T-Stoss in beide Richtungen, Bogen/Bogen): Achsschnitt
  Gerade × Kreis bzw. Kreis × Kreis (`connect_hits`, tangentiale Berührung bis 1e-6 m zählt als Berührpunkt), von bis zu zwei
  Lösungen gilt die nächst den Wandenden (Toleranz entlang der Achse = Bogenlänge); der Bogen behält Mittelpunkt und
  Radius, nur sein Winkelbereich ändert sich (`Axis::piece`, Drehsinn bleibt, nie Vollkreis); T-Stoss an der zugewandten
  Fläche (Versatzkreis bzw. -gerade). Gleicher oder konzentrischer Kreis: nichts (Verketten); Hinweis `cmd.join.arc` jetzt
  nur, wenn Bogen und Wand sich auch verlängert nicht treffen. Tests Kern `verbinden_bogen_*`, `verbinden_t_stoss_*_bogen*`,
  `verbinden_tangentialstoss`, `verbinden_flacher_bogen_wie_gerade`, `verbinden_gegenrichtungen_bogen_gerade` (Gehrung über
  `compute_joins`), vitest `commands/cmds/join.arcWalls.test.ts`. Nicht in der Tauri-App/auf dem Mac geprüft, Plan nicht angesehen.
  Offen: „Auswahl ausblenden" im Grundriss
  schaltet Ebenen (persistent, undo-bar), nicht einzelne Elemente temporär; kein Cmd+E/F2 (keine Funktion dahinter);
  nicht in der Tauri-App geprüft. · S
- ◐ **[191]** Runde Decken/Dächer (12.11., Maintainer-Screenshot Erker 3D). 11.11.: Umriss-Ringe tragen Bögen je Kante
  (`Ceiling.outlineBulge`/`openingsBulge`, `Roof.outlineBulge`/`holesBulge`, `Room.boundaryBulge`); Ableitungen über
  `ring_arc.rs` (fein geteilt ≥ 48/Halbkreis, Pfeilhöhe ≤ 0.25 mm, Punkte exakt auf dem Kreis → Plan/Schnitt/SVG/PDF/DXF
  als echte Bögen über `arc_fit`), Flächen exakt (Objekt-Info, Bauteil-/Wärmeschutzliste, Raum, Kennzahlen, Flächenbilanz),
  3D-Plattenrand mit geteilten Normalen (`render3d::extrude_slab`, Knick < 10°, Kanten ≤ 1 m), Griffe: Scheitel-Griff
  (`ringArc`), Einfügen teilt/Löschen fügt Bögen zusammen, Spiegeln kehrt sie; Raum „innen" an Bogenwänden übernimmt den
  Bogen (`ring_arc::fit_arcs`); Attika-Innenring bleibt am Bogen rund; Musterhaus komplex: Erker-Decken, Spindel-Loch,
  Erker-Dach und die drei Erker-Räume als echte Bögen. Offen:
  Dach-Kantenneigung an Bogen-Teilkanten nur geerbt (Kanten-Griffe/Objekt-Info kennen den Bogen
  als eine Kante). 12.11.: `roofGeometry` (TS-Fassade) reicht `outlineBulge`/`holesBulge` an den Kern (Anhang der flachen
  Eingabe, `roof.rs::densify_rings`), 3D-Griffe/Firstgriff/Gauben sehen dieselbe Geometrie wie die Ableitungen; IFC:
  Decken und Räume mit Bögen als `CEILING_ARC`/`SPACE_ARC` (Profil = IfcCompositeCurve aus IfcPolyline/IfcTrimmedCurve auf
  IfcCircle, auch Aussparungen), ifcopenshell-Validierung an der komplexen Probe grün (Dach bleibt Netz). Bogenwände im 3D weiter 7.5°-Sehnen (Plattenrand feiner); keine Kante gerade → Bogen per Objekt-Info; nicht in der
  Tauri-App/auf dem Mac geprüft. Nachlauf 12.11. (Schatten): `sun.rs::collect` nahm für Decken den rohen Umriss (Sehne statt
  Bogen), die Aussparungen aber fein geteilt — Spindel-Loch im Erker lag halb ausserhalb der Abdeckung, im EG-Grundriss fiel
  Sonnenschatten ins Loch. Jetzt `ce.ring()` (Bogen fein geteilt) für Abdeckung, Werfer und Empfänger; Test
  `decke_mit_bogenumriss_deckt_den_erker_ab`; Goldens komplex EG 100/50, OG 50, Ansicht Süd. Ein „verschwundenes
  Schattendreieck am Erker" liess sich im Vergleich (Bögen als Polygone vs. Bögen) nicht nachstellen; nicht in der App geprüft.
  12.11. Baugrube mit Bögen: `Excavation.outlineBulge`; EINE Stelle teilt fein (`ExSpec::of` über `Excavation::ring_marked`,
  Pfeilhöhe 5 mm, Punkte auf dem Kreis; `edgeSlopes`/`edgeShoring` je Modell-Kante auf die Teilkanten), Böschung, Mengen,
  Gelände-Netz, Schnitt, 3D, Pick rechnen darauf; Plan-Sohle als echter Bogen ([169]). Böschungsschraffur läuft über den
  Bogen im gleichen Abstand (radial, kein Fächer an Teilknicken; Fächer erst ab 5° Knick), Arbeitsraum/Verbau-Versatz ohne
  Schwalbenschwänze an einspringenden Ecken neben Bögen (`offset_ring_clean`), Verbau als EIN Band je zusammenhängender
  verbauter Kanten (Plan-Polygon, 3D-Körper dicht, Schnitt paarweise Durchgänge). Griffe: Scheitel-Griff/Einfüge-Raute auf
  dem Bogen, Spiegeln kehrt; Kontextmenü „Kante als Bogen"/„Kante gerade" an einer Umriss-Kante (Decke, Raum, Dach,
  Baugrube). Musterhaus komplex: Baugrube folgt dem Erker. Nicht in der App/auf dem Mac geprüft (nur CLI-SVG). · L
- ◐ **[187]** Griffe im Schnitt/in der Ansicht (12.11., Maintainer): angewählte Elemente haben dort kaum Fasspunkte (Decken, Gelände, Dächer …). Wie Archicad: Decke OK/UK (Höhe/Dicke), Wand OK (Höhe), Öffnung Brüstung/Sturz, Dach Traufe/First bzw. Neigung, Treppe An-/Austritt, Gelände-Profilpunkte (falls Modell es erlaubt); ein Undo-Schritt je Zug, Fang + Tab-Eingabe wie im Grundriss. · L **Update 12.11. (Teil 3):** Höhenlinien-Sätze (`contourSet` ohne daraus erzeugtes Netz) erscheinen im Schnitt: Geländelinie aus den Schnittpunkten der Linien mit der Schnittebene (`terrain::contour_crossings`, nach Lage sortiert, linear verbunden, Bezugshöhe wie das Netz-Gelände) samt Erdreich-Schraffur, Klasse = die des Satzes, Pick = Satz; Griff je Schnittpunkt (`contourLine`, `sheet_height::contour_marks`, Blatt-Höhe + Bezug → Höhe der Linie). Treppen-Antritt: Modellfeld `baseOffset` (Antritt über der Geschoss-Basis, Austritt bleibt auf `totalRise`; Kern `stair_vertical_extent`, damit 3D/Schnitt/Plan/IFC), Griff `stairBottom` im Schnitt, Objekt-Info-Feld. Geprüft: cargo test (Kern), vitest, tsc, Schnittbild per CLI; e2e `sectionGrips.spec.ts` (Antritt) erweitert. **Offen:** Höhenlinien-Griffe ohne Obergrenze (viele Schnittpunkte = viele Griffe); Gelände-Profilpunkte von Netzen.
  Teil 1 (12.11.): Höhen-Griffe im Schnitt/in der Ansicht für Decke (OK = Höhenlage über die `top`-Bindung, bei gebundener UK ändert sie die Dicke; UK = Dicke über den Deckentyp wie in der Objekt-Info bzw. UK-Bindung), Wand (OK, neu UK mit festgehaltener OK) und Öffnung (Brüstung, Sturz). Rechnung im Kern (`sheet_height.rs`, Griff-Anfrage `sheetHeight`, ein Undo-Schritt je Zug, Mindestmasse, gesperrte Bauteile ohne Griffe), Fang auf Geschoss-Koten (8 px) und Geometrie des Schnitts, Tab tippt die Kote (absolutes Z), Zug-Anzeige „Kote · Höhe". Wand-UK-Griff ändert nur die Bindung `bottom` (Verbund mit Nachbarwänden nicht bedacht). · L
  Teil 2 (12.11.): Griffe für Dach (Traufe = `baseElevation`, das ganze Dach wandert; First = Neigung wird aus Firsthöhe und Spannweite gerechnet, Sekantenverfahren auf `roof_ridge_height`; Flachdach: Attika-Höhe `parapetHeight`), Treppe (Austritt = `totalRise`) und Gelände (Netz/importiertes Netz: alle z um die Differenz; Baugrube: Sohle) im Schnitt/in der Ansicht — Kern `sheet_height.rs` (`roofEave`, `roofTop`, `parapetTop`, `stairTop`, `contextTop`/`contextBottom`, `contourLine`), Griff sitzt an der sichtbaren Kante des Schnitts, der Kern zählt den Zug relativ zur Griffhöhe (`b`); Wand-UK unter der Geschoss-Basis (Kellerwand) war schon erlaubt, über der OK hält die Mindesthöhe 0.30 m und das HUD weist darauf hin. Offen: Treppen-Antritt (Modell hat keinen Versatz, Antritt = Geschoss-Basis); Höhenlinien-Sätze zeichnet der Schnitt nicht, daher kein Griff (der Kern kann `contourLine` Höhe je Linie, aber ohne UI); bei Dächern mit `edgePitchDeg` ändert der First-Griff nur die Hauptneigung; nicht in der Tauri-App geprüft. · L
  (Navigator, Kürzel, Ebenen-Panel) behält Zoom und Ausschnitt exakt — Geschosse teilen sich den Einpass-Schlüssel
  (`viewTabs.ts::planFitKey`, `PlanView` `fitKey`; Schnitt/Ansicht/Zeichnung/neues Projekt passen weiter ein).
  Cmd/Ctrl+5 Geschoss tiefer, Cmd/Ctrl+6 höher im Grundriss- und 3D-Reiter (`stepFloor`/`adjacentFloorId`, nach
  `baseElevation`); Cmd/Ctrl+3 „Auswahl in 3D zeigen" (wechselt/öffnet den 3D-Reiter, Titel „3D · Auswahl", Kamera
  passt ein; ohne Auswahl wieder alles), Cmd/Ctrl+4 blendet die Auswahl im 3D aus (nicht anwählbar, Auswahl leer).
  Zustand rein UI (`state/view3dFilter.ts`, nicht in der Datei, kein Undo; Projektwechsel setzt zurück); Kern
  `model3d::ElementSelection` im `ClassFilter` (Text `{"only", "hideIds"}`: Teile, Cache, Pick, Spuren, Muster;
  gewählte Wand zeigt ihre Öffnungen, gewählte Öffnung bringt ihren Wirt mit). Kürzel umbelegbar (Einstellungen,
  Gruppe „Navigation"), natives Menü Ansicht mit denselben Kürzeln. Nebenbei: `PlanViewHandle.pxPerMeter` las die
  erste viewBox (Reiter/Ausschnitte merkten den Start-Zoom statt des aktuellen), jetzt aus der Ref. Tests `model3d/classes.rs`
  (`element_auswahl_*`), `viewTabs.test.ts`, `view3dFilter.test.ts`, `toWalls3d.classes.test.ts`, e2e
  `navigation185.spec.ts`. Offen: natives Mac-3D-Fenster kennt den Element-Filter nicht; Ebenen-Panel-Wechsel nicht
  einzeln e2e geprüft; nicht in der Tauri-App/auf dem Mac geprüft (Menü-Kürzel vs. Browser-Kürzel). · M
- ◐ **[186]** Schatten (12.11., Maintainer). (2) Grundriss: Lücke zwischen Fassade und Schatten kam von der Abdeckung —
  Dachvorsprung (Musterhaus komplex: Traufe 0.6 m, Ortgang 0.35 m), Carport-, Anbau-Dach galten als „abgedeckt“, darunter
  wurde der Schatten weggeschnitten. Neu deckt nur ab, was innerhalb der Hülle der geschnittenen Wände liegt
  (`sun.rs::filled_envelope`, Decken/Dächer ∩ Hülle); im Freien (Vorsprung, Balkon, Vordach, Carport) gilt der echte
  Schatten. Dazu Sockel: Wände bis 1 m über dem Gelände werfen ab dem Gelände (`plinth_bottom`), Auskragungen nicht.
  Beides steckt in Werfern/Abdeckungen und damit im Schatten-Schlüssel ([179]). Tests `schatten_schliesst_an_die_wand_an`,
  `schatten_unter_dem_dachvorsprung_an_der_fassade`, angepasst `vordach_wirft_schatten`/`schatten_auf_tiefere_platte`/
  `schatten_auf_tieferem_dach_im_og_plan`, TS `analysis/sun.test.ts` (Musterhaus EG), `generatePlan.sunShadow.test.ts`
  (Beispielhaus OG: Balkon unter dem Vorsprung jetzt beschattet). Goldens: komplex EG 1:100/1:50. (1) 3D: zwei Kaskaden
  (`render3d/shadow.rs::cascades`): 0 eng aufs Gebäude (Wände/Decken + berührende Netze), in der Nahsicht auf den
  sichtbaren Ausschnitt (`view_region`/`view_box`, Raster + Hysterese, Tiefenpass nur beim Wechsel); 1 über alle eigenen
  Bauteile (nur wenn nötig). Kaskade 0 4096 Texel (vorher 2048 über alles): Musterhaus ≈ 8 mm/Texel, Erker-Nahsicht
  ≈ 4 mm (vorher ≈ 16 mm); Fenster auf Texel-Raster gerastet, in 0.5-m-Stufen. Im Linux-Container mit `render_png`
  (Software-Vulkan) vorher/nachher angesehen: Schatten unter der Erker-Attika und in der Leibung jetzt scharf statt
  verwaschen. Offen: auf dem Mac (Metal, App/WebGPU) nicht angesehen; Speicher Schattentexturen 64 MB (+16 MB Kaskade 1);
  PCF unverändert (3×3). · M
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
  Ansicht) (Kern `plan/domains.rs`, Bearbeiten: `src/panels/objectInfo/RoomStampSection.tsx`, [218]). · S

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
- ◐ **[145]** Texte beim Zoomen synchron. Raumstempel/Textfelder zeichnet seit 12.11. die native Fläche selbst ([194]). 9.11.: `clampInside` nur noch im Kern (`grip_clamp_inside`,
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
- ◐ **[199]** Plan-Review Runde 3 (12.11., beide Musterhäuser, Grundrisse aller Geschosse, Schnitte, Ansichten 1:200/1:100/1:50,
  CLI-SVG `--hatch` in Chromium, nur Linux). Behoben (Test je Fix, Goldens nachgeführt): oberste Höhenkote im Schnitt/in der
  Ansicht sass an den Achsblasen statt am First („+13.13" 1.4 m über dem Dach, komplex A-A/B-B/alle Ansichten) — jetzt Oberkante
  des Gebauten ohne Achsraster, Bäume, Gelände (`levelMarkers.ts` `builtMaxY`; Blatt-Ausschnitte über `drawings::level_marker_bounds`,
  dort jetzt auch links neben dem Gebauten wie in der App); Raumstempel mit eigener Schriftgrösse (Name 12 pt, Nummer 9 pt) bei auf
  2 mm verkleinerter Grundschrift: Name und Nummer überdeckten sich (komplex DG „Schlafen" 1:100) — Zeilenvorschub mindestens nach
  der grössten Schrift der Zeile, Block misst die erste Zeile nach ihrer Schrift (`text_layout::stamp_block_refs`); Achsblasen
  zwischen zwei Massketten bzw. auf Masszahlen (komplex OG oben, UG Ost „4.37" auf Blase B) — Reihe einer Seite gemeinsam gesucht,
  frei für JEDE Blase und mit einem Durchmesser Luft dahinter (`drawings::bubble_shift`); Verbauwand (Rühlwand) der UG-Grube lief
  im EG quer durch den Anbau „Eingang" über Wände, Boden und Raumstempel — endet jetzt am Fussabdruck wie Sohle/Böschung
  (`context::excavation_lines`); einfaches Musterhaus: Stempel „Wohnen" auf der Zwischenwand W9 und der Schnittlinie A (Anker
  in den Daten, jetzt im Westteil). 12.11. behoben: (1) 1:200 Masszahlen der Aussenbemassung überdeckten sich zwischen den
  Ketten (komplex EG/OG Nord/Ost: „5.39" auf „1.10", „1.00"/„5.00"; Kettenabstand 0.7 m Modell = 3.5 mm Papier) — beim Zeichnen
  liegen die Ketten einer Seite jetzt mindestens 7 mm Papier (bzw. 2.8 Schrifthöhen) auseinander, die äusseren rücken hinaus
  (`drawings::autodim_layout`, im Modell bleibt `offset`; 1:100/1:50 unverändert, Goldens gleich); ausweichende Zahlen stehen
  nicht auf Hilfslinien äusserer Ketten und rücken notfalls hinter das nächste Hindernis statt eine Zeile höher
  (`dim_auto_offsets_avoiding`); Ansichtsmarker rückt von der Bemassung weg (`context::view_marker`). Test
  `plan/autodim_text_tests.rs` (Zahlen-Kästen beider Musterhäuser 1:200/100/50, Fixture `autodim_musterhaus_komplex.json`).
  Offen dazu: Griffe (`grips.rs`) und DXF-Export kennen den Zeichen-Versatz nicht (wie schon die Böschungs-Verschiebung [157]).
  12.11. (Achsen): Masszahlen der Aussenbemassung stehen nicht mehr auf Achslinien und Achsblasen (komplex UG Ost „19.24"/„4.37"
  auf Achse B) und nicht neben dem Pfeil-Schenkel einer Schnittlinie („19.24" neben „B-B") — dieselben Streifen wie bei den
  Schnittmarken (`drawings::grid_strips`/`axis_cross_strips` neben `section_mark_strips`, Mechanik `dim_auto_offsets_marks`);
  eine Achse mit Blase gilt bis hinter alle Ketten (die Blase rückt vor sie, [157]; die genaue Blasenlage hängt von den Massen ab,
  daher nicht verwendet). Test `achsstreifen_auf_der_masslinie`, `schnittpfeil_neben_der_masslinie`; `autodim_text_tests` prüft jetzt
  auch Achsen/Blasen (komplex mit Raster, 1:100/1:50). Offen: bei 1:200 (eng) und bei Bogenmassen (kein Ausweichen) liegen
  einzelne Zahlen noch auf Achsen (komplex UG/EG/OG, 5 Fälle); einfaches Musterhaus hat kein Raster.
  12.11. (Forts.): (1) Raumstempel schrumpfte auf 2 mm, sobald Schnittlinie, Achse, Gaube und Kote den Raum querten (komplex DG
  „Schlafen"): Anderer Planinhalt verkleinert die Schrift jetzt nur noch bis 80 % der Grundschrift (`ROOM_STAMP_KEEP`,
  `fit_room_stamp`); 2 mm nur noch, wenn der Raum auch das nicht fasst. Findet sich keine freie Lage, steht der Stempel an der
  Lage mit der geringsten Überdeckung und mit Freistellung (weisses Rechteck in Papierfarbe unter dem Text, `stamp_knockout`);
  Rechteck + Text liegen dann am Ende der Gruppe `sections` (über Schnittlinie, Achsen, Koten, Zeichnungen), Stempel mit
  eigenem Anker bleiben unverändert. Gleich in Anzeige, SVG und Druck-SVG/PDF (normale Polygon-/Text-Primitive, keine neue Art).
  Test `raumstempel_behaelt_schrift_mit_freistellung`. (2) Schnittmarke B-B stand auf der Gesamtmass-Zahl „19.24" (komplex UG/EG
  Ost, auch West): die Zahlen weichen den Schnittmarken aus (`drawings::section_mark_strips`, `dim_auto_offsets_marks`): passt eine
  Zahl ins Segment, rückt sie darin neben die Marke (±6 mm Papier an Schenkel/Pfeil, ±1 mm wo nur die Linie quert); Test
  `masszahl_weicht_schnittmarke_aus`. Offen: Zahlen weichen den Achslinien weiterhin nicht aus (komplex UG Ost „4.37"/„19.24" liegen
  auf der Achse B); Mac/Tauri nicht geprüft.
  Offen (nach Schwere): (2) Raumstempel schrumpft auf 2 mm, sobald
  Schnittlinie, Achse, gestrichelte Gaube und Kote den Raum queren (komplex DG „Schlafen" 1:100; Archicad legt ihn darüber) —
  dünne Strich-Punkt-/Projektionslinien als weiche Hindernisse? (3) Ansicht Ost: Gaubenwange der Flachdachgaube fehlt (Gaubendach
  „schwebt" über der Dachfläche). (4) Schnitt A einfaches Musterhaus: um die geschnittene Treppe ein U-förmiger Rahmen
  (Herkunft unklar), Giebel über OG offen (Wände nicht ans Dach geführt, Daten); OG ohne ankommende Treppe/Treppenloch (Daten).
  (5) Schnittmarke B-B (UG/EG Ost) steht auf der Gesamtmass-Zahl „19.24"; (6) Gesamtmass „17.39" und Kote „▽-2.71" Süd (Daten,
  schon [171]); Radiusmass „R 2.00" auf der Wendeltreppe im Erker (Daten); kleiner geschnittener Balken frei im DG (Schnitt A-A,
  Herkunft prüfen). Nicht in der Tauri-App/auf dem Mac angesehen. · M
- ◐ **[142]** Sonnenschatten im Grundriss (`sun.rs`, Kern `plan/extras.rs`, Klasse 08). Stand 11.11.: Decken/Balkone/Vordächer
  und Dächer werfen eigenen Schatten (Dächer in echter Form, nicht-konvex; Tests `vordach_wirft_schatten`,
  `nichtkonvexes_dach`, `flachdach_l_schatten`, war schon gebaut, TODO-Text veraltet). Neu: Wandöffnungen lassen Licht durch
  — Wand mit Öffnungen als Prismen ohne die Öffnungsquader (`wall_pieces`/`wall_gaps`, gerade und Bogenwände; Glas zählt
  als Lücke; Formöffnungen als Streifen mit kleinster Höhe), Teile gehen in den Schatten-Schlüssel ([179]) ein. Im Musterhaus
  komplex kaum sichtbar (Licht durch Fenster fällt meist ins abgedeckte Innere). Offen: Kronen bleiben konvexe Hülle (Form der
  Krone selbst ist konvex); Schatten aufs Gelände tieferer Terrassen nur über Decken/Dächer als Empfänger; nicht in der
  Tauri-App angesehen. · M
- ◐ **[64]+[59]** Sonnenstand/Schatten. Schatten im 3D (`render3d`, Shadow-Mapping) ist gebaut, aber nicht auf Metal
  und nicht in der App angesehen; zwei Kaskaden + Nahsicht seit [186]. · S
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
  (14.11., [208]) Zu kurze Segmente: Nachbarzahl rückt im eigenen Segment weg, sonst unter die Linie statt in die Wand (s. [208] Abgabe-Review d).
- ◐ **[172]** Masszahl der Bemassung „snappy" und mittig. (10.11.) Vorgabe: Zahl wirklich mittig (bisher hing sie mit ihrem Anfang an der Segmentmitte, jetzt
  um die Breite halbiert zurückgesetzt, auch Bogenlänge) über jedem Segment im festen Abstand (Grundlinie 0.6 Schrifthöhe); passt sie nicht zwischen die Hilfslinien, weicht sie nach aussen (erstes Segment links, letztes rechts,
  mittlere zum längeren Nachbarn, bei Überdeckung eine Zeile höher) — `dim_auto_offsets` in `plan/drawings.rs`, gilt für
  manuelle und automatische Bemassung, Griff steht an derselben Stelle. Masszahl-Griff rastet an Mitte · innen links/rechts ·
  aussen links/rechts · über/unter der Linie ein, frei mit gehaltener Alt-Taste (`grips.rs::dim_text_slot`; Objektfang
  entfällt beim Ziehen). Gespeichert bleibt `textOffsetsMm` (kein neues Feld); (0,0) = Vorgabe, frei verschobene Texte alter
  Projekte bleiben stehen. „Text zurücksetzen" in Objekt-Info und Kontextmenü. DXF/DWG-Export setzt die Textposition der DIMENSION an die ausgewichene Lage (`plan/dxf.rs`, 10.11.). Radius-/Durchmesser-/Bogenlängenmass: Zahl mittig über dem Ankerpunkt; Masszahl-Griff der Rundmasse rastet wie bei linearen Massen ein (10.11.: Mitte · innen/aussen links/rechts entlang der Masslinie · über/unter, Alt = frei; ein Griff an der Zahl selbst, `grips.rs::round_dim_label`, Versatz in `textOffsetsMm[0]`, im Plan `plan/drawings.rs::round_label`; „Text zurücksetzen" gilt mit). Offen: DXF/DWG-Export setzt die Textposition der Rundmasse noch nicht an den Versatz; in der App nicht geklickt. · S
- ◐ **[154]** Bauteile aus Zeichnung erkennen (Befehl `erkennen`). Stösse von Bogenwänden, schräg anstossende Enden,
  Treppen/Decken, Fenster über der Schnitthöhe (5 von 6 fehlenden Öffnungen im Musterhaus komplex), Wanddurchbruch
  mit Schwellen-Rechteck wird Fenster, Schiebetüren in Bogenwänden, Blöcke. 14.11.: Fenster mit Schichteinzug in Bogenwänden
  (Grundriss seit [216] gerade auf der Sehne der Zone) werden wieder erkannt (`chord_window`: Fensterlinien parallel zur
  Sehne, Pfosten daraus); Rundreise-Test Musterhaus komplex wieder grün (Öffnungen 0.76 → > 0.85). · L
- ◐ **[136]** Reiter und Ausschnitte entkoppelt. (9.11.) Offene Reiter (Reihenfolge, aktiver, je Reiter Ansicht/Zoom/
  Ausschnitt-Bezug) gehen beim Speichern als `uiState.viewTabs` in die Projektdatei (optionales Rust-Feld
  `Project.uiState`, nicht über Ops, kein Undo; `serializeProject(p, ui)` ersetzt es nur im Datei-Text) und kommen
  beim Öffnen zurück; Reiter auf gelöschte Ausschnitte fallen weg, alte Projekte: ein Reiter wie bisher
  (`src/state/viewTabs.ts`). Offen: nicht in der Tauri-App/Browser geprüft (Wiederherstellung des Zooms läuft
  verzögert über `applyViewState`); Autosave-Wiederherstellung bringt die Reiter mit, ändert aber nicht den Dirty-Stand. · S
- ◐ **[131]** Untergeschosse unter ±0.00 (`DrawingLevel.zeroLevel`). Nur die Mac-Gegenprobe fehlt. · S

## Schnitt und Ansicht

- ◐ **[184]** Fenster/Türen im Schnitt und in der Ansicht nach Detailgrad wie im Grundriss (11.11., Wunsch Maintainer).
  EINE Auflösung `model_view::Options::opening_detail`/`section_look` (Element-Detailgrad > Stufe > Basis; Fenster
  „Vereinfacht" = grob; ohne Stufe der Massstab-Detailgrad des Grundrisses, mittel ab 1:200 = grob, `for_view_scaled`).
  Schnitt grob: NUR ein Strich in der Öffnung (Rahmenmitte), kein Rahmen/Fensterbank/Sturz-Fläche/Storen (Sturz und
  Brüstung = Wandschnitt); Tür grob: Öffnung + Blatt als ein Strich. Mittel: Rechteck-Rahmen oben/unten + Glaslinie,
  Fensterbank als einfache Fläche, Tür-Blatt als Fläche. Fein: volles Profil wie bisher. Storenkasten im Schnitt nur
  mit `windows.shadingBox` (Basis aus). `sectionDetail` der Stufe ist jetzt optional (ja = voll, nein = höchstens
  mittel, fehlt = Detailgrad). Ansicht: Fensterteilung folgt dem Detailgrad (grob/vereinfacht: keine), `elevationDivision`
  geht vor. 11.11. Nachbesserung: grob = Sturz unten und Brüstung oben im Wandschnitt FLACH (kein Anschlag, keine Nase,
  kein Schichteinzug [168]; `Visibility.flat_openings` aus `section_look == Line`, im Cache-Schlüssel, `section/bands.rs`
  `section_reveal`, `parallel_reveal_cuts`); Grundriss grob: Leibung gerade, keine Anschlag-Nasen (Wand-Nasen in
  `walls.rs`, Tür-Nasen in `plan/openings.rs`). 11.11. (3): Ansicht nach Detailgrad (`plan/elevation/mod.rs`, `opening_detail`): grob = nur Öffnungsumriss mit Glas-/Blattfläche (kein
  Rahmen, Fensterbank, Teilung, Laibungsschatten, Flügelsymbole), mittel = Rahmen + Teilung und Laibungsschatten, aber ohne Fensterbank, fein wie bisher;
  Storenkasten über der Öffnung nur mit `windows.shadingBox`. Ressourcen-Tab: „Schnittdetail Tür/Fenster" als Wahl „Wie Detailgrad /
  Voll / Vereinfacht" mit Tooltip. Nicht in der Tauri-App geprüft.
  (14.11., [208]) Ansicht: Vergröberung mittel → grob erst ab 1:500 (1:200 zeigt Rahmen/Flügel/Glas, ohne Öffnungssymbole).
- ◐ **[178]** Deckenauflager an Aussenwänden (11.11., Wunsch Maintainer). Decke endet an der Aussenkante des Kerns
  ([33] `layer_positions`), Aussendämmung/Putz laufen an der Stirn durch — abgeleitet, Umriss bleibt
  (`model3d/bearing.rs`: Platten-Umriss minus Aussenschicht-Streifen, wo vor der Wand keine Decke liegt → `emit_slabs`
  für 3D/Schnitt/Ansicht und `floor_context` für die 3D-Wandbänder). Schalter je Decke `Ceiling.edgeAtOutline`
  (Objekt-Info „Auflager bis Kern“, aus = wie Umriss). Bogenwände seit 11.11. ([191]: Kreisringsektor bis Kern,
  2 cm über die Aussenfläche). Offen: Deckenkante im Grundriss folgt noch dem Umriss; Platte ohne Wand in gleicher Höhe (UG-Decke über Lichtschacht/kurzer Fundamentwand im
  Musterhaus komplex) bleibt bis Umriss; nicht in der Tauri-App/auf dem Mac geprüft. · S
- ◐ **[G4]** Exakte Sichtbarkeit (HLR, Kern `hlr.rs`). 11.11.: Füllungen der Ansicht aus der exakten Sichtbarkeit
  (`hlr_fill.rs`: je Fläche Umriss minus die näheren Teile der anderen, Halbebene der Tiefendifferenz, i_overlay;
  ganz verdeckte Flächen entfallen), Ansichtsschraffur auf die sichtbaren Teile ihrer Fläche beschnitten (Dachraster
  lief über die Gauben), Schlagschatten nur auf sichtbaren Wandteilen (Fugen der Erker-Facetten); Durchdringungslinien
  zugewandter Flächen verschiedener Bauteile (`hlr::intersection_edges`, Raster-Vorauswahl; Kamin/Körper ↔ Dach/Wand,
  Erker ↔ Fassade). Tests `kamin_hinter_dachmitte_fuellung_wie_kanten`, `koerper_durch_wand_zeigt_durchdringungslinie`;
  8×8-Wächter ~0.3 s, 16×16 ~4 s (release, Linux). Offen: Gelände als Flächen in der Projektion (bleibt Silhouette +
  Maske, [T6]); Durchdringungslinien im Projektionsteil des Schnitts (`section/projection.rs` vergibt keine Körper);
  Öffnungen bleiben Maler-Ordnung; über 20 000 Flächen (grosse Netze) weiter Maler-Ordnung; Ortgang der Sattelgaube
  zeigt nur die äussere Dachschicht ([G5]); nicht in der Tauri-App/auf dem Mac geprüft. · XL
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
  exakt; keine Intensitäts-Einstellung; keine Hand-Schraffur. (13.11., [236]) Meldung „Text doppelt, Schatten/Baumkronen schwarz“ im
  Skizzenstil am Stand master NICHT reproduziert (Musterhaus komplex EG: CLI-SVG und App im Browser/SwiftShader zeigen Text einfach,
  Schatten durchscheinend, Füllungen wie ohne Skizze); vermutlich älteres AppImage. Regressionstest `src/plan/sketchStyle.test.ts`.
  Nicht geprüft: Mac/Metal. · S
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
- ◐ **[68]** Baugrube/Geländebearbeitung (Kontext-Objekt `excavation`). (11.11.) Verbau ist jetzt eine echte Wand:
  Modellfelder `shoringKind` (Spundwand/Rühlwand/Bohrpfahlwand) und `shoringThickness` (Vorgabe 0.2/0.3/0.6 m), im
  Schnitt geschnittene Fläche mit Schraffur der Art (Stahl/Holz/Beton), unten Sohle − 1 m Einbindung, Erdreich-Band
  spart sie aus; im Grundriss Wandband an der Kante (Klasse der Baugrube, Pick = Baugrube); Sohlenfläche bei
  überlappenden Gruben exakt (i_overlay); Arbeitsraum-Prüfung `working_space_check` (enge Nischen, gekappte Gehrung):
  rotes Kreuz im Plan, Warnung im Panel. (11.11., 2) Einbindetiefe als Feld `shoringEmbed` (Vorgabe 1 m, Panel);
  Verbau auch im 3D (Körper je Kante in Farbe der Verbauart, Klasse der Baugrube, Pick = Baugrube; `excavation::
  shoring_solids`) und in der Ansicht (Netz-Flächen mit exakter Sichtbarkeit `hlr_fill`, Klasse/Pick wie 3D);
  Erdreich-Band im Schnitt lässt die Wand nur aus, wenn deren Klasse sichtbar ist (kein Loch bei ausgeblendeter
  Klasse). Geprüft: cargo test (Kern), vitest, Goldens; nicht in der App/Metal angesehen. Offen: Verbau je Kante
  nur eine Art, Ansicht ohne Verbau-Schraffur (nur Farbfläche); IVHB-Terrain nach kantonalem Recht. · M
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

- ◐ **[202]** Treppe verschieben: Deckenloch wandert mit (12.11., Befund Maintainer „Wendeltreppe verschwindet“). Griff `stairBy` (`grips::run_doc`) und Bewegen/Drehen/Spiegeln/Skalieren (`cmd_transform`) nehmen die Löcher der Decke mit, auf der die Treppe ankommt (Aussparung `Ceiling.openings` samt Bögen und Deckenöffnungs-Element `hostCeilingId`; `stair_guard::carried_holes`), im selben Op-Satz; Loch mit einer anderen Treppe, gesperrte Decke/Öffnung und mitgewählte Decke/Öffnung bleiben. Ankommende Treppe ohne Loch wird oben unbeschnitten gezeichnet (`arrivals_in_plan`), Absturzsicherung (3D/IFC) nur mit Loch. Tests: Rust (`stair_guard` [202]-Tests, `plan/domains.rs`), e2e `stairHole202`. Weitere Wege geprüft: Objekt-Info ändert den Antritt nicht, Pfeiltasten nur als Achs-Sperre im 3D-Griff (Wände/Zeichnungen), Kopien lassen das Loch beim Original. Vorschau des Bewegen/Drehen/Spiegeln/Skalieren-Befehls zeigt den Lochumriss an der neuen Lage mit (`cmd_transform::carried_hole_preview`, gleiche `carried_holes`; nicht bei Kopien); der Bewegpunkt-Griff wendet die Ops schon beim Ziehen an, seine Live-Vorschau zeigt das Loch also ohnehin. Kein Hinweistext in Objekt-Info/Kontextmenü (keine natürliche Stelle). **Offen:** nicht in der Tauri-App geprüft. · S
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
- ○ **[254]** Eigene parametrische Objekte (nach 1.0, Wunsch Maintainer 14.11., Vorbild Archicad-GDL/Grasshopper): Objekte mit Parametern, 2D je Detailstufe grob/mittel/fein und später 3D **einfach selbst bauen** — als Knoten-Editor mit logischen Bausteinen (Grasshopper-artig: Parameter, Zahl/Rechnen, Linie, Rechteck, Kreis, Bogen, Reihe/Array, Spiegeln, Wenn/Detailstufe, Zufall mit Seed); der Graph wird als Daten im Projekt gespeichert und im Rust-Kern ausgewertet (gleiche Schnittstelle wie die eingebauten Objekte aus [253]). Textform als zweiter Weg: eingebettete Skriptsprache im Kern (z. B. Rhai, reines Rust, WASM-tauglich, abgeschottet) und/oder Python über `dossier-cli`/MCP; Python in der App (Pyodide) nur, falls Grösse/Tempo vertretbar. GDL-Dateien (.gsm) werden nicht eingelesen (Entscheid Maintainer). · L
- ○ **[42]** Varianten. · L
- ○ **[39]** Auswahl gehört zum Modell. · M

## Import und Export

- ◐ **[211]** Rendering mit Blender/Cycles (12.11.). Export-Paket `model.glb` + `scene.json` + `textures/` (`export/blenderRender.ts`, Format renderer-neutral in `doc/RENDER-SZENE.md`, Leser für Cycles-Standalone [215] vorgesehen): Kamera der aktiven 3D-Ansicht (`getCamera`) oder Voreinstellung, Sonne aus Sonnenstand/Ort, Materialtabelle (Farbe, Rauheit, Metall, Glas mit Transmission/IOR, Bildkarten aus `Component.material`). Texturen ohne UVs per Box-Projektion (Kachel `sizeM`); keine UVs im GLB. Skript `scripts/blender/render_dossier.py` (Cycles, Nishita/Mehrfachstreuung-Himmel, Denoiser, GPU/Metal wenn vorhanden). App: Dialog „Rendering mit Blender" (Befehl `rendering`, Menü Ansicht, Pfad in Einstellungen), Fortschritt „Sample x von y", Abbrechen, Vorschau, Bild speichern; Tauri `src-tauri/src/blender.rs` + Capabilities (fs nur `$TEMP/dossier-render`), Electron `scripts/electron-blender.cjs`, Browser: Paket als ZIP. CLI `render --out bild.png [--view --when --samples --size --cpu --blender]`. Geprüft: vitest (Szene, Paket, Prozess gemockt, CLI mit Blender-Ersatz), Rust-Logik `blender.rs` (rustc --test, 6 Tests), `cargo check` der Tauri-App (Linux), echter Lauf mit `bpy` 5.3 (CPU) am Musterhaus komplex, Sonnenrichtung per Schattentest. **Offen:** nicht in der Tauri-App/auf dem Mac geprüft (Berechtigungen, Metal-GPU, Ereignisse), nicht mit einem installierten Blender 3.6/4.x; „Als Bild ins Layout" entfällt (Layouts haben keine Bildelemente); Dialog nicht im Browser geklickt; ambientCG-Web-Texturen lädt die CLI nicht. **Stand 12.11. (Bildwirkung, Kamerawahl):** Nishita mit Sonnenstärke 1.0 und automatischer Belichtung nach Sonnenhöhe (gemessen: weisse besonnte Fläche ≈ 45 bei 60°, Tabelle `SUNLIT_WHITE` im Skript), AgX, Albedo ≤ 0.8, Wiese `Grass005` fürs Gelände (Rückfall Wiesengrün), Dachschichten je Baustoff (`splitRoofMaterials`: vorher hingen Ziegel/Kies/Blech am gleichen „Dach“-Material), Kontext hellgrau, Glas mit Transmission und durchsichtig für Schattenstrahlen, leichte Umgebungsverdeckung. Kamera im Dialog („Aktuelle 3D-Ansicht“ oder gespeicherte Kamera, Sonnenzeit der Kamera), CLI `--camera <Name|id>`. Geprüft: vitest (Materialzuordnung, Kamerawahl, CLI), echter Lauf mit `bpy` 5.3 (CPU) an Musterhaus komplex, Iso und Kamera „Südost“. **Offen:** Mac/Tauri-Gegenprobe, Blender 3.6/4.x (Mix-Knoten per Platz, `light_settings.ao_factor` nur in 5.x geprüft), Dialog nicht im Browser geklickt, Gelände hat kein Material im Modell (immer Wiese), Dachtyp-Schichten ohne Bildkarte (z. B. Faserzement) nur nach Namen. · M
 Mac-Gegenprobe 12.11. (Maintainer, Blender 4.x, Metal): läuft, Bild kommt zurück; erster Lauf übersetzt die Metal-Kernel (Minuten, „Sample 0“ — Fortschritt jetzt auch im 4.x-Format). Befunde aus dem ersten Bild: Nachbargebäude schweben über dem geneigten Gelände (Kontextnetze nicht aufs Gelände gesetzt), Baugrube erscheint als Loch im Rasen (im Rendering ausblenden bzw. hinterfüllt zeigen).
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
- ◐ **[201]** IFC-GlobalId-Rundreise, Normalen in glTF/OBJ (12.11.). Erledigt: `ifcGlobalId` an Wand, Öffnung (IfcDoor/IfcWindow), Decke, Stütze,
  Dach, Treppe, Raum, Extrusionskörper — der IFC-Import setzt sie (`import_ifc.rs`), der Export schreibt sie zurück (Datensatz `GUIDS`,
  `ifc_export/`), doppelte/ungültige fallen auf die abgeleitete GUID zurück; Kopieren/Einfügen/Reihe/Spiegeln/Wand teilen setzen sie
  NICHT mit (`json_util::as_copy`); BCF-Zuordnung (`bcfMatch.ts`) nimmt sie. glTF/GLB mit `NORMAL` (geteilt bis 30° Knickwinkel, Funktion
  `hatchgen/src/mesh_normals.rs` wie die 3D-Anzeige), OBJ mit `vn`, `usemtl` und `.mtl` (zweiter Speichern-Dialog; CLI schreibt beide
  Dateien). Offen: GlobalId von Bäumen und IfcOpeningElement/-Beziehungen (bleiben abgeleitet); OBJ-Normalen/MTL im Tauri-Dialog
  (zweiter Dialog) und IFC nicht in Revit/ArchiCAD geprüft; keine UVs/Texturen. · S
- ◐ **[C11]** glTF/GLB-Export (`fileio/src/mesh_export.rs`). Keine Texturen/Instanzen; Gelände ohne Vertex-Farben;
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

- ◐ **[204]** App-Review im Browser (12.11.): beide Musterhäuser wie in Archicad bedient (Playwright, Linux/Chromium, Rendering
  per SVG-Rückfall). Behoben (e2e `review204.spec.ts`, vitest): Esc in modalem Dialog (DXF-Export) mit Auswahl schloss ihn nicht
  und hob die Auswahl dahinter auf (Aufheben lief im Mikro-Task → sofortiges Neurendern meldete später registrierte Esc-Listener
  ab; jetzt nach dem Ereignis und nie bei offenem `aria-modal`, `useKeyboardShortcuts.ts`); Cmd/Ctrl+5/6 im Reiter eines
  Ausschnitts behielt dessen Titel („EG 1:100" zeigte das OG, „Ausschnitt aktualisieren" hätte das OG in den EG-Ausschnitt
  geschrieben) → Reiter löst sich (`unlinkActiveTab`); „Ausschnitt aktualisieren" lief über den Umbenennen-Knopf; Status-Leiste
  zählte nur Wände (Tür → „Auswahl", Wand+3 Öffnungen → „1 Wand"); Werkzeugliste zweimal „Schnittlinie" (→ „Ansichtslinie").
  Offen (je Reproduktion): (a) Objekt-Info „Masse" einer Wand = Achs-Rechteck ohne Dicke: Musterhaus, W2 (x=5) wählen →
  Breite 0.000, Höhe 4.000; bei der Tür D1 heisst die Wanddicke „Höhe 0.345" (Türhöhe 2.10 steht weiter unten) · S;
  (b) ERLEDIGT 12.11. (b): Die dünne gestrichelte Linie war das gewachsene Terrain der Baugrube ([T6], `append_terrain_profiles`),
  das quer durch die UG-Räume lief (kein Gelände-Netz hinter dem Schnitt: Ansichtsbereich zeichnet kein Gelände); jetzt
  `outside_building` (`plan/section/meshes.rs`): Schnittflächen zu Gebäudegruppen vereint, innerhalb der Spanne einer Gruppe
  (Höhenband ±2,5 m wegen Fensterlücken) fällt die gestrichelte Linie weg, vor/hinter dem Haus in der Grube bleibt sie ·
  (c) Objekteinstellungen (T): Esc schliesst die Palette nicht,
  Kopf „Objekteinstellungen" doppelt (Fenstertitel + Panelkopf) · S; (d) Objekt-Info einer Ansicht („Ansicht Süd") heisst
  „Schnittlinie" mit „Schnitt-Tiefe", „Schnittlinie löschen" · S; (e) ERLEDIGT 12.11.: Startansicht (Öffnen, Geschoss-/Plan-Wechsel ohne gemerkten Zoom) passt auf das GEBÄUDE ein
  (Musterhaus komplex 1:121/83 % statt 1:375/27 %): der Kern schreibt das Bauteil-Ausmass (Wände, Decken, Dächer, Räume,
  Treppen; ohne Kontext, Gelände, Raster, Zeichnungen, Schnittmarken) in den Plan-Puffer (Kopf 20 Wörter, Flag 4, `Plan.houseBounds`),
  `PlanView.startView`. Cmd+0 und Zoom-Grenzen bleiben bei ALLEM (Archicad „Alles einpassen"; sonst nicht bis zum Kataster
  herauszoomen) · (f) nach Einfügen (Cmd+V) einer Wand mit Öffnungen zeigt die
  Objekt-Info „Öffnung · Typ gemischt" statt der Wand · S; (g) „Overrides" im Ausschnitt-Fuss und Ressourcen-Reiter unübersetzt
  (de) · S; (h) Punkt-Griff bleibt nach Ziehen+Loslassen „bewaffnet" (HUD `L:/W:` folgt dem Zeiger bis zum nächsten Klick) —
  so gewollt (VW-Stil), weicht aber von Archicad ab; Tür-Griff rastet beim Greifen auf den Zeiger (D1 rückt 5 cm) · S.
  Nicht geprüft: 3D-Ansicht (headless kein WebGPU), Tauri/Mac. Headless verschwand der Plan im Vollbild-Screenshot zeitweise
  (Element-Screenshot zeigt ihn) — Compositing von SwiftShader, kein App-Fehler. · M
  Nachtrag 12.11.: behoben (e2e `review204b.spec.ts`, vitest): (a) Objekt-Info „Maße“ zeigt bei Wand Länge/Dicke/Höhe, bei Öffnung Breite/Höhe/Brüstung (`panels/objectInfo/elementDims.ts`, nur Anzeige) statt Bounding-Box; (c) Esc schliesst die schwebende Objekteinstellungen-Palette (`useCloseObjectSettingsOnEscape`; nicht bei laufendem Werkzeug/Befehl, Eingabefeld, modalem Dialog), schwebende Fenster zeigen den Titel nur noch in der Titelleiste (`PanelFrame showTitle`); macOS-Nebenfenster unverändert (nicht in Tauri geprüft); (d) Ansicht heisst „Ansichtslinie“, „Ansichts-Tiefe“, „Ansichtslinie löschen“; (f) Wand samt Öffnungen gewählt: die Wand führt die Objekt-Info (`leadingOpeningId`); (g) „Overrides“ → „Überschreibungen“ (de). Offen aus [204]: (b), (e), (h). · S

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
  14.11.: Begehen/Pathtracer rot wegen `pkg3d` ohne Feature `web` (480-Byte-Stub, 3D-Init „reading 'new'“); `globalSetup` und
  `loadEngine3d` brechen jetzt mit Bauhinweis ab (`npm run build:engine3d`).
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
  **WebGPU-Geräteverlust (14.11., mit [206]):** Ursache der Konsolenflut: headless verliert SwiftShader das Gerät beim ersten Präsentieren ins Canvas
  (auch mit reinem JS nachgestellt, offscreen-Rendern verliert es nicht); „A valid external Instance reference no longer exists“ ist Chromiums eigene
  Verlust-Meldung (Grund „unknown“), nicht unsere Abbau-Reihenfolge (wgpus WebGPU-`Drop` sind No-ops). render3d hatte gar keine Verlust-Behandlung
  (kein `device.lost`, wgpus paniernder Vorgabe-Fehlerhandler) → `createBuffer(mappedAtCreation)` warf auf dem toten Gerät, wgpu paniert („unreachable“),
  danach jeder Aufruf „recursive use of an object …“; render2d baute ohne Pause im Kreis neu auf, „Init fehlgeschlagen“ kam vom sofortigen Neuaufbau.
  Behoben: `render2d|render3d/src/device_health.rs` (Rust-Tests: Verlust einmal melden, eigener Abbau still, Fehlermeldungen begrenzt); render3d wie render2d mit
  `is_lost`/`set_lost_callback`, frühem Return in allen GPU-Methoden, `uncapturederror` → Warnung; beide geben das Gerät beim Freigeben per `destroy()` frei.
  TS: `engine/gpuRecovery.ts` (gemeinsames Budget der Seite, Backoff 0,5/2/8 s, danach WebGPU aus; `guardRenderer`: Abbruch → gesperrtes Objekt nie wieder
  anfassen, `Result::Err` als Zeichenkette bleibt gewöhnlicher Fehler), `engine/gpuRendererSlot.ts` (3D: Neuaufbau, Viewport spielt alles neu ein),
  `wasmRendererSession.ts` (Verlust-Rückruf erst im nächsten Takt, gescheiterter Neuaufbau = weiterer Verlust); Renderer werden beim Abbau des Canvas freigegeben.
  Begehen-Tasten laufen auch ohne GPU (`failed`). Tests: vitest `gpuRecovery`/`gpuRendererSlot`/`wasmRendererSession`, e2e `gpuDeviceLost206.spec.ts`
  (erzwingt `GPUDevice.destroy()` + wirft wie Chromium bei `mappedAtCreation`; schlug mit dem alten Stand fehl). Zahlen ganze Suite (`E2E_WARN_LOG`, schreibt jetzt
  auch Fehler): 2444 → 866 Meldungen; wgpu-Panics 7 → 0, „recursive use“ 152 → 0, „Init fehlgeschlagen“ 180 → 0; Audit `--gpu`: 39 → 14 (davon 8 `[longtask]`).
  Offen: Rest ist Chromiums eigene Verlust-Meldung (~3 je Seite) plus je eine Zeile von uns; der Pathtracer-Test ([212]) wird headless jetzt übersprungen
  (zählte vorher auf dem toten Gerät); Idee: Testnaht „offscreen statt Canvas“ für echte GPU-Läufe in e2e. Nicht in WKWebView/auf dem Mac geprüft
  (`doc/RELEASE-1.0.md`, „Nur auf dem Mac“); Wettlauf „Gerät tot, `device.lost` noch nicht gemeldet“ fängt nur `guardRenderer` (Panic-Zeile bleibt dann).
  **Nachtrag 14.11. (e2e `renderCount` rot, 141 statt < 45 Renders je Wand-Änderung):** Mit dem Backoff liefen die Neuaufbauten headless über ~5 s statt in
  wenigen ms; jeder schaltete `ready` kurz an und wieder aus, also die ganze Plan-Ansicht SVG → WebGPU → SVG — fiel das in das Messfenster, zählte der Test
  die volle Plan-Ansicht. Behoben: `wasmRendererSession.ts` meldet einen NACH Verlust neu aufgebauten Renderer erst nach einer Bewährungszeit (`probationMs`,
  1 s ohne erneuten Verlust) als `ready` (zeichnet aber schon) — headless bleibt der Plan durchgehend beim SVG (vitest dazu). Dabei gefunden ([121]): drei
  `setState` mit unverändertem Wert (`setSelected(null)` je Plan, `setPickList(null)` je Ausschnitt, `setHoverEdge` je Zeigerschritt) renderten die Plan-Ansicht
  je nach React-Interna ein zweites Mal; jetzt nur bei echter Änderung. Zahlen: Wand-Änderung 42, Zoom-Schritt 8 → 7, 5 Zeiger-Schritte 20. Offen: render3d
  (`gpuRendererSlot.ts`) hat noch keine Bewährungszeit (Viewport braucht den Renderer zum Einspielen); nicht auf dem Mac geprüft.
  **Nachtrag 15.11. (e2e `camera.spec.ts:21`/`:67` rot, `window.__dossierCamera` fehlte):** Der 3D-Viewport meldete seine Kamera erst bei `ready` an (Effekt
  `if (!ready) return`) und der Orbit-Zustand wurde nur mit lebendem Renderer angelegt; headless (Gerät verloren, WebGPU aufgegeben) gab es deshalb keine Kamera-Brücke,
  „Kamera aus der 3D-Ansicht anlegen“/„Kamera öffnen“ gingen nicht. Behoben: Anmeldung vom Renderer entkoppelt — `viewport/viewportCameraApi.ts` (read/write auf dem
  Orbit, zeichnet nur wenn ein Renderer lebt; `snapshot`/`image` ohne Renderer null), `Wasm3DViewport` meldet an, solange er gemountet ist (kein `ready` in den
  Abhängigkeiten, also keine Abmelde-Lücke beim Neuaufbau), und legt den Orbit auch ohne Renderer an (Fit-Rückfall in TS). Tests: vitest `viewportCameraApi.test.ts`;
  e2e `camera` 3x, `gpuDeviceLost206`, `walk`, `renderCount`, `a11yNewDialogs` grün. Offen: Kamera bleibt nach einem Neuaufbau nicht erhalten (Preset wird neu
  angewandt); nicht auf dem Mac geprüft.
  **Nachtrag 15.11. (3D: Bewährungszeit und Kamera über den Neuaufbau):** `GpuRendererSlot` (`probationMs`, Vorgabe 1 s) macht einen NACH Verlust neu aufgebauten
  render3d erst nach 1 s ohne erneuten Verlust als `renderer`/`ready` bekannt (erster Aufbau unverändert; Verlust in der Probezeit gibt das Objekt frei und baut
  weiter mit Backoff neu) — die 3D-Ansicht flackert headless nicht mehr zwischen Hinweis und Bild. Kamera: `Wasm3DViewport` wendet das Preset nur beim ersten
  Aufbau oder bei Preset-Wechsel an; ist der Orbit aktiv (Ziehen, Brücke, Begehen), zeichnet der neue Renderer ihn nur noch (`cameraAfterReady` in
  `viewportCameraApi.ts`: Standpunkt, Ziel, Projektion und Begehen-Zustand bleiben, da sie im Orbit-Ref des Viewports liegen). Tests: vitest `gpuRendererSlot`
  (Probezeit, Verlust in der Probezeit), `viewportCameraApi` (`cameraAfterReady`); e2e `gpuDeviceLost206` prüft „Kamera bleibt nach Geräteverlust erhalten“
  (headless wird der Renderer nie bekannt, die Prüfung deckt dort nur die Brücke ab; der Neuaufbau-Pfad ist durch vitest abgedeckt), `camera`, `walk`,
  `renderCount`, `a11yNewDialogs` grün. Nicht in der Tauri-App/auf dem Mac mit echtem Geräteverlust geprüft. Noch offen: ein Preset, das der Nutzer nicht
  verändert hat, wird nach dem Neuaufbau neu eingepasst (gewollt).
  **Nachtrag 15.11. (e2e `walk:17`/`a11yNewDialogs:263` flackerten, Taste G wirkungslos):** Ursache: der Tasten-Hörer des Begehens (G, WASD, Umschalt+F) hing an `walkInput = ready || failed`; in der Probezeit nach Geräteverlust ist beides falsch, der Hörer war abgemeldet. Behoben: Effekt nur noch von `render` abhängig (kein Renderer-Zustand; `render` tut ohne Renderer nichts). Test: vitest `walkKeysLifecycle.test.ts` (Quell-Wächter, kein DOM-Test möglich); e2e `walk`+`a11yNewDialogs:263` 5x mit `--workers=2`, `gpuDeviceLost206`, `camera`, `renderCount` grün. Nicht auf dem Mac geprüft.
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
  16.11.: Updater-Endpunkt und Versionsverlauf zeigen auf `git.openbureau.ch/karim/dossier` (statt `DOSSIER-STANDALONE`; Entscheid Maintainer: nur Gitea). Release-Skript `npm run release:gitea` (`scripts/release-gitea.mjs`, reine Teile in `release-gitea-lib.cjs`, Test `src/update/releaseGitea.test.ts`): Entwurf `v<version>` je Plattform füllen, `--publish` führt `latest.json`/`versions.json` nach; nur `--dry-run` und API-Lesezugriff im Container geprüft. 16.11. (Entscheid Maintainer: GitHub als Bau-Rechner): `release.yml` legt Mac- und Linux-Pakete zusätzlich als Entwurf auf Gitea ab (Secret `GITEA_TOKEN` in GitHub nötig). Offen: Secret setzen, erster Tag-Lauf, Updater-Signaturschlüssel.
- ◐ **[170]** Linux-Paket (9.11.; ab 1.0 offiziell, Entscheid 16.11.). AppImage x86_64 mit electron-builder (`electron-builder.yml`,
  `npm run build && npm run electron:pack` über `scripts/electron-pack.cjs`, Buildnummer [261] aus `dist/build-info.json` als `buildVersion`/`dossierBuild`):
  Desktop-Eintrag, MIME `application/x-dossier-project`, `dossier datei.obp`, gepackt über `dossier://app`; Job `linux` in `release.yml`.
  **16.11. im Container geprüft** (`npm run test:linux-app` = `e2e/linuxApp170.spec.ts` mit Playwright-Electron, Xvfb, über FUSE, ohne FUSE und entpackt):
  Start, Kern, Wand per Befehlszeile, Speichern atomar mit `.obp~`, Strg+S, Öffnen per Dialog und per Argument, PDF/DXF auf Platte, Autosave nach `kill -9`
  (`doc/RELEASE-1.0.md` Abschnitt 15). Behoben: `electron-files.cjs` fehlte im Paket (App startete nicht), Öffnen per Argument blieb hinter dem
  Startbildschirm, Strg+S/O fehlten ohne natives Menü, Datei → „Exportieren: PDF“ fehlte im Browser/Electron. **Offen:** echte GPU/Wayland,
  GTK-Dialoge von Hand, Sandbox als normaler Benutzer, Desktop-Integration im System, Flatpak (`packaging/linux/ch.dossier.cad.yml`) nie gebaut,
  deb/rpm, `--no-sandbox` im Desktop-Eintrag (AppImage-Vorgabe), Workflow nicht auf GitHub gelaufen. · M
- ◐ **[57]** Tests bei jedem Push (`check.yml`). Nicht auf GitHub gelaufen. 14.11.: Umfang geprüft — `npm run check` fährt nun auch `cargo test --features web --test robustness_web` im Kern ([258]; mit `CARGO_PROFILE_DEV_OVERFLOW_CHECKS=false`, sonst melden Debug-Überlauf-Panics, die im Release/WASM wrappen: `roof.rs:664`, `web/geo_mesh.rs:65`); CI installiert zusätzlich numpy (IFC-Mengenprüfung, [259]). Render2d/render3d/kernel2d/hatchgen-Tests liefen schon, e2e läuft als eigener Job. Offen: `exportIfc.fachplaner.test.ts` (komplex/Erker) meldet lokal mit ifcopenshell 0.9 `NetVolume 7.5 ≠ Geometrie 30.4` an Wand #3971 — klären, bevor CI es sieht; Debug-Überlauf in `roof.rs`/`geo_mesh.rs` ggf. mit `wrapping_mul` entschärfen. · S 14.11.: CI installiert `poppler-utils` (Job check und e2e, [208]-Text-Prüfungen).
- ○ **[C6]** `cargo xtask ci`: Formatierung, Clippy, Tests, Crate-Schichtung, Asset-Herkunft, WASM-Build in einem
  Befehl. · M
- ◐ **[C9]** Ehrliche Paritäts-Doku `doc/DATEIFORMATE.md` (12.11.2026): je Format hin/zurück/verloren mit Belegen aus dem Code; Test
  `src/export/dateiformateDoku.test.ts` hält die Formatliste aktuell. Offen: Rundreisen in Fremdsoftware (AutoCAD, Revit, ArchiCAD, Acrobat)
  ungeprüft; mit „ungeprüft" markierte Zeilen (Layer-Zustände im DXF-Import, PDF-Schriften, Stifte im PDF, OSM-Lizenzhinweis) nachlesen. · S

## Mac-Gegenprobe (Sammelpunkt)

Auf dem Mac (Tauri/Metal) noch nicht angesehen oder geprüft; bisher nur Linux-Container, CLI-SVG, Chromium oder
Unit-Tests: [116] (atomares Speichern), [117] (CSP unter `tauri://`), [118], [122], [123], [126], [110], [101],
[102], [131], [133], [136], [140], [145], [194], [146], [153], [64], [T2], [T4], [34], [108], [65], [169], [113], [181], [G1], [214], [209], [210], [266]. Je Punkt ansehen, dann hier und
im jeweiligen Eintrag streichen. · M (gesamt)

---

## Erledigt

Einzeilig mit ID, Titel, Datum (2026). Kleine Reste erledigter Punkte (z. B. [T7] Achse beliebig im Raum, [T8]
exakte Durchdringung, [61] Zuordnung per Hand, [63] Profil je Kante, [70] Flächentabelle als Layout-Element,
[80] Einzelplan-PDF ohne Ebenen, [82] Legende per Ziehen) stehen im Archiv beim jeweiligen Eintrag.

- [267] Ansichten aller Seiten in einem Schritt (16.11., Release-Checkliste 5.4; Chromium/Linux, nicht in der Tauri-App geprüft): Befehl `ansichten` (Alias `elevations`, `fassaden`) und Menü Ansicht → „Ansichten aller Seiten erzeugen“ legen um das Gebaute (Wände, Decken, Dächer, Stützen, Treppen, Räume, Körper; nicht Kontext/Gelände) je eine Ansichtslinie für Nord, Ost, Süd, West an — Kern `elevation_set.rs`, Brücke `state/elevationSet.ts`. Hauptrichtung = minimal umschliessendes Rechteck der konvexen Hülle (< 0.5° gilt als achsparallel; L-Form folgt ihrem Rechteck), Linie 2 m bzw. 10 % der Ausdehnung vor der Fassade, über deren Enden hinaus. **Entscheid Namen:** es gibt im Modell keinen Nordwinkel (Plan oben = Norden, wie „Ansicht Süd“ der Vorlage); eine Fassade heisst nach der nächsten Himmelsrichtung ihrer Aussennormalen — nie „Nordost“, weil die vier Normalen 90° auseinander liegen und so jede Seite eindeutig bleibt. Vorhandene Ansicht gleicher Blickrichtung (< 45° Abweichung) zählt als diese Seite und wird nicht doppelt angelegt (Meldung nennt sie); ohne Gebäude Meldung; ein Undo-Schritt. Der Präsentationsplan ([224]) nimmt die neuen Ansichten mit. **Offen:** Nordwinkel im Projekt (Namen und Nordpfeil bei gedrehtem Plan), Mac-Gegenprobe. Tests: Rust `elevation_set.rs` (rechtwinklig, gedreht 30°/60°, L-Form, Schiefstand, vorhandene Süd, Blickrichtung), vitest `commands/cmds/elevations.test.ts`, e2e `elevations267.spec.ts`.
- [265] „Vorschau“-Kennzeichnung unfertiger Funktionen (16.11., Entscheid Maintainer, Release-Notes Frage 7; Chromium/Linux, nicht in der Tauri-App geprüft): eine gemeinsame Stelle `ui/PreviewBadge.tsx` (Marke „Vorschau“/„Preview“, Tooltip „Noch nicht fertig — Ergebnisse können abweichen“, für Screenreader verborgen, damit Namen stabil bleiben). Zeigt sich bei Pathtracing (Darstellungsart-Zeile und -Auslöser), Rendering mit Blender (Ansichtsmenü, Dialogtitel; natives macOS-Menü als Suffix „· Vorschau“), Kamerafahrt/Video (beide Knöpfe im Kameras-Panel samt Tooltip, Dialogtitel) und Geist-Modus (Punkt am Knopf, Tooltip, Zeile in der Begehen-Hilfe). `Dropdown`/`DropdownItem` haben dazu das Feld `preview`. Kameras-Panel: Kopfzeile bricht jetzt um, die beiden Textknöpfe sind keine 20-px-Kreise mehr. Schlüssel `preview.*`; „Pathtracing (Vorschau)“ heisst jetzt „Pathtracing“ + Marke. Tests: vitest `ui/PreviewBadge.test.ts`; e2e `previewBadge265.spec.ts`.
- [264] Sprachumschalter (16.11., Entscheid Maintainer; Chromium/Linux, nicht in der Tauri-App geprüft): Einstellungen → Allgemein → Darstellung → Sprache „Automatisch (System) / Deutsch / English“ (`i18n/languagePref.ts`, localStorage `dossier.language`; Automatisch = erste Systemsprache de/en, sonst Deutsch). Wirkt sofort: `LanguageRoot` baut die App bei Sprachwechsel neu auf (viele `memo`-Komponenten lesen `t()` ohne Abo); Projekt, Verlauf, Auswahl und Boot-Phase bleiben, der Einstellungsdialog öffnet wieder, Pläne/Zoom der Ansicht werden neu eingepasst. Natives Einstellungsfenster: Sprachwahl in der Sync-Brücke (`languagePref`/`onLanguagePrefChange`). Neue Projekte („Neu“) legen Name, Geschosse, Schnitt, Ansicht und alle Vorgabe-Ebenen in der UI-Sprache an (`model/newProjectNames.ts`, Schlüssel `newProject.*`); bestehende Projektdaten werden nie übersetzt. **Standards (16.11.):** Neue Projekte bekommen die Standard-Bibliothek in der UI-Sprache: Baustoffe, Schraffuren, Linienstile, Wand-/Decken-/Dachaufbauten, Ansichtsvorlagen, Modelldarstellungen, Symbol/Override-Bausteine und die Klassen „Leuchten“, Schatten/Koten/Marken/Kameras/Situation/Planzeichen und Objektbibliothek (Möbel, Sanitär, Fahrzeuge & Freiflächen). Der Kern hält die englischen Namen (`standards_names.rs`, Tabelle nach Standard-Kennung, `Lang`; ein Test prüft, dass jeder Standard einen hat) und nimmt die Sprache als Text-Argument der Wurzel-Abfragen `standardsMergeOps`/`standardsUpdatePlan`/`standardsUpdateOps` (`withStandards(p, lang = getLanguage())`); Kennungen, Werte und Verweise sind gleich, ein Eintrag gilt bei deutschem wie englischem Namen als vorhanden (kein Duplikat beim Sprachwechsel, „Aktualisieren“ meldet englische Namen nicht als umbenannt). Bestehende Projektdaten werden nie übersetzt; Beispielprojekte (Musterhaus, Komplex, Wettbewerb) bleiben deutsch (`withStandards(…, "de")`). Native Fenstertitel (Einstellungen, Ressourcen, Zeichnungsebenen, Ebeneneinstellungen, Standort importieren) über `t()` beim Öffnen; ein schon offenes Fenster behält seinen Titel bis zum Neuöffnen. **Offen:** Kürzel der Baustoffe (BE, STB …) bleiben deutsch; Objekt-Info-Texte, die Namen aus Daten zeigen, folgen den Daten; „Ebene einfügen“-Klasse beim Setzen eines Bibliotheksobjekts in ein Projekt ohne die Klasse (`cmd_draw.rs::libobj_ops`) legt sie noch deutsch an; Titel und Menü der Tauri-App nicht in der App geprüft. Die Vorlagen-Ressourcen des Leeren Projekts (Linienstile, Schraffuren, Bauteile, Aufbauten, Tür-/Fenster-/Treppentypen) übersetzt `newProjectNames.ts` über `newProject.res.<Liste>.<id>`. Tests: vitest `languagePref`, `newProjectNames`, `standardsLang`; Rust `standards::englische_standards_nur_namen`, `standards_names`; e2e `language264.spec.ts`.
- [252] Englisch „Geschoss“ = **floor** durchgehend (`en.ts`: storey/storeys → floor/floors; IFC-Schema-Namen und Bezeichner unberührt), Tab immer Befehlszeile (Ctrl+Tab / Ctrl+Umschalt+Tab = Ansichts-Reiter zyklisch, fest verdrahtet, auf dem Mac Ctrl; in Overlay-Dialogen bleibt Tab bei deren Feldern; `tabKeyAction`, `cycleTab`, Kürzel-Übersicht de/en, e2e `tabKey252.spec.ts`); UI-Review 14.11.: Kürzel-Übersicht zeigt im englischen UI „Ctrl/Shift/Del“ statt „Strg/Umschalt/Entf“ (`formatCombo`) (14.11.; nicht auf dem Mac geprüft, e2e nicht gelaufen, falls nicht anders vermerkt)
- [244] Darstellungsarten-Menü im 3D übersichtlicher (13.11., Wunsch Maintainer, folgt auf [240]): gemeinsames `Dropdown` rückwärtskompatibel erweitert (optionale `group`, `icon`, `hint`, `shortcut` je Option; `optionRows`/`DropdownRows` exportiert, Überschriften und Trennlinien, Zweitzeile + Tooltip, Kürzel rechts). 3D-Menü (`renderModeOptions` in `TopBar.tsx`): Linien (Drahtgitter, Kanten, Nur Konturen) · Flächen (Schattiert, mit Kanten, Texturiert, Weiss) · Rendern (Pathtracing) mit Material-Symbols-Icons und Erklärung („Pathtracing: Physikalisch, rechnet fortlaufend“); de + en. Kürzel gibt es für die Stile keine. 2D-Plan (Farbig/Tusche) unverändert. Geprüft: tsc, vitest `src/ui src/i18n src/viewport`, e2e overridesTab, roomStamp218, viewTemplates, [212]-Pathtracer-Test (Chromium, Port 5194), Screenshots hell/dunkel vorher/nachher. Nicht in der Tauri-App/macOS geprüft.
- [245] Begehen wie im Architektur-Walkthrough (13.11., Wunsch Maintainer; zu [213]). Nur TS/Viewport. `viewport/walkCollision.ts`: Raster (Zelle 2 m, Grundrissebene) aus `projectToModel3d(…, { forWalk: true })` (ohne Türflügel/Rahmen/Handläufe): Wände als Kapseln entlang der Achse mit Löchern (Loch bis zur Wand-UK = Tür, frei; Loch mit Brüstung = Fenster, Glasebene sperrt), Decken-/Trittkanten und senkrechte Netz-Dreiecke (Stützen, Körper) als Hindernisse, Oberseiten von Decken/Tritten und flache Dreiecke (Gelände, Dächer, Rampen) als Boden. Person: Zylinder r 0.25 m, 1.8 m hoch, Stufen bis 0.25 m; Bewegung in Teilschritten, hinausgeschoben (gleitet an Wänden). `walk.ts::stepWalkCollide`: Fusshöhe folgt dem Boden (ein Boden-Test je Bild, Aufstieg geglättet, Absturz sanft mit Fallgrenze 5 m/s), Q/E ändern die Augenhöhe (0.5–2.3 m); Takt läuft weiter, bis die Höhe angekommen ist. G = Geist (Kollision/Bodenfolge aus), auch als Knopf neben „Begehen“ und in der Tastenhilfe. Tests: `walkCollision.test.ts` (Wand, Gleiten, Tür/Fenster, Stufe 0.4/0.2, Treppe, Kante), `ViewportToolbar3d.test.ts`, e2e `walk.spec.ts`. 13.11. Grenzen verbessert: (1) Tür oder Fenster entscheidet `Opening.kind` (`walkInputFrom`, Loch über die Achslage der Öffnung zugeordnet): Fenster sperren auch mit Brüstung 0, Türen (auch Schiebe-/Hebeschiebetüren; „Fenstertür“ ist im Modell eine Tür, es gibt kein eigenes Kennzeichen) sind frei; ohne Treffer (Bogenwand, keine Zuordnung) gilt weiter die Höhe. (2) Für das Begehen kommen die Wandstücke mit Rechteck-Loch statt der Formöffnungs-Körper (`projectToModel3d` mit `forWalk` ohne `splitWallBodies`): Rund-/Bogentür ist über ihr umschreibendes Rechteck passierbar, ein Fenster bleibt gesperrt. (3) Die Decken tragen ihre Aussparungen im Umriss (Brücke, [202]): Deckenunterseite begrenzt den Kopf (`WalkWorld.headBlocked`), ausser über Löchern; Treppentritte zählen nicht. 13.11. (b) Bogenwände und Dachschrägen: (4) Bogenwand (bulge): die Lochlage wird über die Bogenlänge auf die Achse gebracht (Winkel um den Mittelpunkt, `axisPosition`), die Zuordnung zur Öffnung gilt nach Anteil des Lochs, den die Öffnung überdeckt (ein Loch im Sehnenstück ist oft nur ein Teil der Öffnung); Erker im Beispiel komplex: Fenster sperren. (5) Dachschrägen: `projectToModel3d` kennzeichnet im Begehen-Modell die Dachnetze (`RMesh.roof`, nur `forWalk`); deren nach unten zeigende Dreiecke (Unterseite) sind eine Kopfgrenze wie die Deckenunterseite (`headBlocked`): Schritt in Kopfhöhe unter 1.8 m (Kniestock) wird zurückgenommen, wer schon darunter steht, bleibt beweglich. Gauben/Dachfenster: das Kern-Netz führt sie als Löcher (Hauptdach − Loch), unter dem Gaubendach gilt dessen Unterseite. Tests: `walkCollision.test.ts` (Satteldach mit Kniestock, Gaube, Beispiel komplex mit tiefer Traufe, Bogenwand). Im Beispiel komplex ist der Kniestock im DG 1.8 m, dort gibt es also nichts zu begrenzen. Offen: keine echte 3D-Anzeige im Container: Bewegung nur per Test belegt, nicht am Mac/in der Tauri-App gesehen.
- [246] Kamerafahrt (13.11., Folge aus [213]; nur TS, Chromium; Mac/Tauri nicht geprüft): Knopf „▶ Kamerafahrt“ in der Kamera-Gruppe (Panel „Ausschnitte“) fährt im 3D-Viewport in Listenreihenfolge durch die Kameras (Catmull-Rom „flüssig“ oder „geglättet“ mit Smoothstep, Bildwinkel linear, Dauer je Abschnitt Vorgabe 4 s; Esc oder Klick bricht ab; Kameras bleiben unverändert, kein Op); „Video …“ öffnet den Dialog mit Dauer, Interpolation, Format (WebM, MP4 nur wenn `MediaRecorder` es kann), Auflösung = Viewport, 30 Bilder/s, Fortschritt und Abbruch, Speichern über `saveBinaryFile`. Code: `viewport/cameraTour.ts` (Interpolation), `cameraTourPlayer.ts`, `videoRecorder.ts`, `state/cameraTourActions.ts`, `ui/CameraTourDialog.tsx` + `cameraTourDialogState.ts`; Tests vitest je Modul, e2e `cameraTour.spec.ts`. Offen: Aufnahme unter Tauri/WKWebView (fehlt `MediaRecorder` auf dem Canvas, meldet der Dialog per `notify`), Bildinhalt der Aufnahme nicht gesehen (headless WebGPU leer), im Stil Pathtracing nur Vorschau-Qualität.
- [248] Kurzanleitung: Begehen mit Kollision ([245]: Wände/Glas sperren, Türen frei, Treppen, G = Geist), Kamerafahrt ([246]: Knöpfe, Dauer, Fahrt, Video WebM/MP4, Esc) und gegliedertes Darstellungsarten-Menü mit Pathtracing unter „Rendern“ ([244]) beschrieben (13.11.); `kurzanleitung.test.ts` bleibt grün (keine neue Angabenart). Nicht in der App geprüft.
- [249] Tastatur und Fokus in den neuen Dialogen und Leisten (13.11.; nur TS/CSS). Neue gemeinsame Hülle `ui/modalFocus.ts` (`useModalFocus`: erstes Feld fokussiert, Tab-Falle auch bei Fokus auf dem Dokument, Esc, Enter im Eingabefeld = Hauptaktion, Fokus zurück zum Auslöser, Fokus kehrt in den Dialog zurück, wenn ihn die Befehlszeile sich nach dem öffnenden Befehl holt) für Kürzel-Übersicht, Kamerafahrt, 3D-Bild und Rendering (die übrigen Overlay-Dialoge hatten bisher keine Falle). Hintergrund-Kürzel: `isEditableTarget` (`useKeyboardShortcuts`), Zifferntasten, Begehen (`walkKeyAllowed`) und die Blatt-Tasten (`LayoutSheet`) ignorieren Ziele in `aria-modal`-Dialogen (`state/modalScope.ts`); vorher sprang Tab auf einem Dialogknopf in die Befehlszeile dahinter. 3D-Leiste: stabiler Name + `aria-pressed` statt wechselndem `aria-label`, Tab bleibt in der Leiste (Ausnahme vom Tab = Befehlszeile). Dropdown: Gruppen als benannte `role="group"`, `aria-activedescendant`/`aria-controls`, Home/End, Tab schliesst, Fokus zurück zum Trigger (auch nach Mausauswahl). Hilfslinien-Panel und Bild-HUD: `role="group"`, beschriftete Felder, Fokus ins Positionsfeld, Esc schliesst (Fokus zurück zum Knopf), Esc im Zuschnitt-Feld beendet den Zuschnitt, Enter übernimmt Zeilenwerte, Liste scrollt bei vielen Linien. Rendering/3D-Bild: Auswahlfelder beschriftet, Fokus auf „Abbrechen" während der Arbeit. Objekt-Info-Gruppen: `aria-controls`. Fokusring-Token `--focus-ring` (hell/dunkel) für Dialoge, Blatt-HUDs, Gruppenköpfe, Dropdown-Trigger. Geprüft: tsc, vitest `src/ui src/viewport src/panels src/i18n src/state`, e2e `a11yNewDialogs` (9) plus cameraTour, walk, competition, release10, commandKeys, objectSettings, roomStamp218, layoutSheet, viewTemplates, overridesTab, presentationSheet (Chromium, Linux). Offen: Tab ausserhalb von Feldern, Dialogen und der 3D-Leiste springt weiter in die Befehlszeile (Entscheid Maintainer: Dock-Knöpfe per Tab erreichbar machen?); die 3D-Leiste steht im Tab-Lauf hinter Dock-Reitern; übrige ältere Overlay-Dialoge ohne Falle/Fokus-Rückkehr; nicht auf dem Mac/in der Tauri-App, nicht mit VoiceOver geprüft.
- [250] Ältere Overlay-Dialoge auf die Hülle aus [249] (13.11.; nur TS). `useModalFocus` jetzt auch in Export (IFC/OBJ/…, DXF/DWG, PDF), Import (Zeichnung/PDF, IFC + Bericht, Mesh, Punktwolke, Kontext, Raumprogramm), Einstellungen, Standards-Update, Neues Layout/Masterlayout, Präsentationsplan, Eingabe-Dialog, Über, Ungespeicherte Änderungen, Autosave-Wiederherstellung, Sperr-Konflikt: Fokus beim Öffnen im Dialog (bei Rückfragen auf „Abbrechen"/„Später", nie auf Verwerfen/Überschreiben), Tab-Falle, Fokus zurück zum Auslöser, Hintergrund-Kürzel gesperrt. Esc und Enter blieben wie bisher in den Dialogen selbst (keine zweite Enter-Aktion, keine bei Löschen/Überschreiben). `autoFocus` in Export-/Eingabe-Dialog durch `data-autofocus` ersetzt (autoFocus lief vor der Hülle und machte das Feld zum „Auslöser"). Namen für Felder ohne Label: Layout-Format/Plakat/Master, Präsentationsplan (Schnitt, Blatt, Massstab, Papier, Massstab je Ansicht), Dateiname, Massstab-Freitext, Kürzel-Auswahl, Eingabefeld = Frage. Geprüft: tsc, vitest `src/ui src/panels src/state src/i18n`, e2e `a11yNewDialogs` (13, 4 neue) plus aiBridge, commandKeys, competition, io, levelZero, presentationSheet, release10, roomprogram, layoutSheet, kataster (Chromium, Linux). Offen: Enter-Hauptaktion nur dort, wo schon vorhanden (Eingabe-, Export-Dateiname-, Layout- und Präsentations-Dialog); im Layout-Dialog löst Enter auch auf „Abbrechen" die Erstellung aus (bestehendes Verhalten, `window`-Listener); Dialoge ohne eigene Prüfung im e2e: Mesh/Punktwolke/Kontext/Raumprogramm/IFC-Import, Standards-Update, Sperr-Konflikt, Autosave, Über, Eingabe-Dialog (gleiche Hülle, nur per tsc/Aufrufer-Specs abgedeckt); nicht auf dem Mac/in der Tauri-App, nicht mit VoiceOver geprüft.
- [251] Enter in Dialogen mit `window`-Listener (14.11.; nur TS). Neu-Layout/Masterlayout (`DialogFrame`) und Präsentationsplan lösten die Hauptaktion auch bei Fokus auf „Abbrechen“/„×“ aus. Jetzt `enterConfirmsDialog` (`ui/modalFocus.ts`): Enter bestätigt nur im Eingabe-/Auswahlfeld oder auf dem Dokument; auf einem Knopf gilt dessen eigene Aktion (der Hauptknopf löst per Klick aus). Übrige Dialoge geprüft: Enter dort nur als `onKeyDown` am Feld, Ifc-Bericht schliesst nur (Knöpfe schliessen ebenfalls). e2e `a11yNewDialogs` (5 neue, 18): Enter auf Abbrechen/× erstellt nichts, auf „Erstellen“ erstellt (Layout, Masterlayout, Präsentationsplan); Fokus/Tab-Falle/Esc/Fokus zurück für Eingabe-Dialog (N Kopien), Über, Standards-Update, Raumprogramm-Import, Kontext-Import. Nicht per e2e erreichbar ohne Dateien/Netz: Mesh-/Punktwolken-/IFC-Import, Sperr-Konflikt, Autosave-Wiederherstellung. Offen: Esc im Standards-Update schliesst zugleich das Ressourcen-Fenster (bestehend, Fokus-Rückkehr dort deshalb nicht prüfbar); nicht auf dem Mac/in der Tauri-App. Geprüft: tsc, vitest `src/ui src/panels`, e2e a11yNewDialogs, layoutSheet, competition, presentationSheet (Chromium, Linux).
- [247] Kurzanleitung passt zur App (13.11.): Bedienangaben in `doc/KURZANLEITUNG.md` gegen de.ts, Menüs (`appMenu.ts`, `AppMenuBar`), Befehls-Registry und Kürzel belegt; Test `src/i18n/kurzanleitung.test.ts` prüft Menüpfade, fette/„quotierte“ Bedienelemente, Befehle in Backticks und ⌘-Kürzel. Korrigiert: Browser-Menü (kürzer, anders benannt), „Vorsprünge bis“, Dachform „Flachdach“ als Auswahlfeld im Panel Objekt-Info (+ Wahl in der Befehlszeile `rf`), Geschoss kopieren per ⌘C/⌘6/⌘V (⌘D dupliziert nur mit Versatz auf demselben Geschoss), „Objekt-Info“, Ressourcen als Fenster. Ergänzt: Begehen (Umschalt+F) und Kameras. Offen: Begehen mit Kollision/Geist (G), Kamerafahrt/Video und Gruppen im Darstellungs-Menü stehen in diesem Stand nicht im Code und fehlen in der Anleitung. Geprüft: tsc, vitest `src/i18n`; nicht in der App angesehen.
- [243] Qualität der neuen UI-Texte seit 12.11. (13.11.): Durchsicht aller neuen de/en-Schlüssel ([209] Kosten, [211] Blender, 3D-Bild, Hilfslinien, Körper→Bauteile, Raumstempel …). en: „building parts“ → „components“ (wie übriges en.ts), Kosten-Texte (Subtotal, Key figure, excluding land, attic storeys …), 3D-Bild-Fehler (graphics card returned no image, eye point and target coincide), „Automatic/Common scale“, „To change:“ u. a.; de: „Alt schaltet den Fang aus“, „Standpunkt und Ziel fallen zusammen“, „nicht als Bildschirmfoto“, „Ansichtsvorlage „Präsentation““, „MwSt. (Z)“. Platzhalter de/en geprüft (alle gleich), Schlüssel unverändert. Offen: `vitest src/i18n` und volles tsc im Worktree mangels WASM-Paketen nicht gelaufen
- [240] 3D-Viewport: Knöpfe und Anzeigen schöner (13.11., Wunsch Maintainer). Neue Komponente `src/viewport/ViewportToolbar3d.tsx` (eigener CSS-Block `.vp3t-*`;
  `Wasm3DViewport.tsx` bindet nur noch ein): Icon-Knöpfe (Material Symbols `directions_walk`, `add_a_photo`) in zwei Gruppen oben rechts mit Tooltip
  (Hover und Tastaturfokus, Text + Kürzel über `t()`) und `aria-label`; Begehen mit `aria-pressed` und deutlich aktivem Zustand. Pathtracer-Zähler als
  Statuszeile unten links mit Fortschrittsbalken (Samples / 1024), Zahl höchstens 4× pro Sekunde aktualisiert (kein Flackern). Begehen: Tastenhilfe
  (W A S D, Q/E, Umschalt/Alt, Maus, Esc) blendet nach 6 s aus. Grund halbtransparent mit Unschärfe, Farben hell/dunkel über Variablen; Bewegung entfällt bei
  „weniger Bewegung“. Test `ViewportToolbar3d.test.ts`. Geprüft: tsc, vitest `src/viewport src/ui src/i18n`, Playwright-Screenshots hell/dunkel
  (Chromium, ohne WebGPU: 3D-Fläche leer, Pathtracer-Zeile dort aus denselben Klassen nachgebaut). Nicht geprüft: Mac/Tauri/Metal, echte 3D-Anzeige,
  Kontrast über echtem 3D-Bild. Das Darstellungsarten-Dropdown in der Oberleiste (`TopBar`, geteilt mit 2D) blieb unverändert. · S
- [242] Doku nachgeführt (13.11.): `src-tauri/render3d/README.md` neu (Pathtracer-Module, Belichtung/Raumlicht als `Sky`-Felder in `pathtrace.rs`), Crate-Tabellen (`ear_clip.rs`, Pathtracer), Anonymitäts-Zeile in ARCHITEKTUR 3.4, READMEs `viewport`/`state`/`ui` (`imageExport`, `shortcutOverview`, `sheetSnap`, Blatt-HUDs); `doc/KURZANLEITUNG.md` um Volumen → Bauteile, Pathtracing, Plakat-Hilfslinien/Zuschnitt, anonyme Abgabe, Kataster-Schwarzplan ergänzt; erledigte ✓-Einträge des Release-Abschnitts nach „Erledigt“ verschoben. Beim Zusammenführen ergänzt: `pt_lights.rs`, `exposure.rs` (Etappe 5), `ViewportToolbar3d.tsx` ([240]).
- [217] Kern-Panics aus dem Robustheitstest (12.11.): `wall_top_at` nutzte `f64::clamp(base, base+height)` — bei negativer/NaN-Höhe
  min > max bzw. NaN → Panic in `wall_piece_mesh` (und über 3D/Exporte, u. a. `exportIfcSpf`). Neu `jsnum::clamp_safe`/`ClampSafe`
  (Grenzen tauschen, NaN wie JS); 28 weitere `.clamp(` mit berechneten Grenzen in Kern-Modulen umgestellt. „Zufall 13“-Timeout war
  Last (je Fall < 1 s, ganze Datei ~30 s), keine Endlosschleife. Regressionstests: Rust `wandkoerper_mit_kaputter_hoehe_ohne_panic`,
  `jsnum::clamp_ohne_panic`, vitest in `robustness.test.ts`. Offen: ganzzahlige `usize::clamp` mit berechneten Grenzen nicht einzeln geprüft.
- [222] Volumenstudie → Bauteile (12.11., aus [206]; umgesetzt 13.11.): Befehl `solidtoparts` (`koerperinbauteile`, Werkzeuge 3D
  neben „Körper verschneiden“) wandelt den gewählten Körper (sonst Klick in den Körper) in einem Undo-Schritt um: je Geschoss eine
  Aussenwand je Umrisskante (aktiver Wandtyp, Referenz „left“ = Aussenfläche auf der Körperkante, wächst nach innen, `isExternal`),
  Decken zwischen den Geschossen (Deckentyp wie beim Zeichnen), Flachdach ohne Vorsprung bündig mit der Körper-OK; der Körper entfällt
  (GV sonst doppelt). Geschosse: Körper-UK muss auf einem Geschoss oder der Stapel-OK stehen; bestehende Geschosse werden genutzt, fehlende
  obenauf angelegt (Höhe des obersten, gleichmässig auf den Rest verteilt), Reste < 0.5 m verlängern das oberste. Prismen auch nicht-
  rechteckig/konkav, dazu Quader/Zylinder des Befehls „Körper“. Abgelehnt mit Meldung: verjüngt, Kugel/Kegel/Torus/Rotation/Verschneidung,
  verrundete/gefaste Ecken, Abzugskörper, selbstschneidender Grundriss, UK zwischen Geschossen, < 0.5 m. Kern `cmd_massing.rs` (Decke/Dach
  über `ceiling_item`/`roof_item` aus `cmd_create.rs`), Befehl `commands/cmds/solidToParts.ts`. Tests: Rust `cmd_massing::tests` (5),
  vitest `solidToParts.test.ts`, e2e `release10.spec.ts` [222] (aus fixme). Angesehen: CLI-Plan/Schnitt eines L-Körpers mit schräger Kante,
  Browser-App (Linux). Offen: Mac/Tauri nicht geprüft; keine Bodenplatte unter dem untersten Geschoss; keine Innenwände/Öffnungen;
  Körper mit Löchern (gibt es im Modell nicht) und Bogenkanten (Zylinder wird zum 48-Eck aus Einzelwänden). · M
- [229] Cycles-Rendering: Streifen/Dreiecke auf der Hauptdachfläche (12.11., Maintainer, Musterhaus komplex Iso). Ursache: Das GLB hat keine
  UVs; der Normal-Map-Knoten (Tangentenraum) bekam je Dreieck einen anderen Tangentenrahmen und zeichnete die Gauben-Fan-Triangulierung als
  helle/dunkle Diagonalen. Nicht im Netz: GLB geprüft (Normalen der Dachdreiecke an der Oberseite max. 0.0002 rad neben der Flächennormalen,
  keine verdrehte Wicklung, Schichten 12 mm Abstand ohne Koplanarität); Rendern ohne Normalenkarte beseitigt es. Lösung `render_dossier.py`
  `add_textures`: keine Normalenkarte, stattdessen Rauigkeitskarte als Höhenfeld (Bump, Stärke 0.3, rahmenfrei). Test:
  `blenderRender.test.ts` (Skript ohne Normal-Map-Knoten). Geprüft: echter Lauf `bpy` 5.3 (CPU) vorher/nachher. Offen: Mac/Blender 3.6/4.x;
  echte Normalenkarten bräuchten UVs im GLB-Export. · S
- [239] Objekt-Info mit einklappbaren Abschnitten durchgängig (13.11., UI-Sichtprüfung): Wand/Decke/Dach … waren schon Gruppen ([189]), aber
  Bezugspunkt, Masse und beim Gelände Einstellungen (Material, Höhenversatz, Netzpunkt, Zuschneiden) + Georeferenzierung (LV95) waren feste
  Blöcke — beim Gelände musste man scrollen. Jetzt alle `InfoGroup` (Klick/Enter/Leertaste auf den Kopf, Pfeil, `aria-expanded`); neue Gruppen
  `refpoint`, `dimensions`, `contextProps`, `georef` (`objectInfo/groups.ts`). Zustand je Abschnitts-Art in localStorage `dossier.objinfo.groups`
  (nur Abweichungen vom Standard; `infoGroupState.ts`), nicht im Projekt. Standard: alles offen ausser „Georeferenzierung“ (`georef`: Herkunft +
  LV95 — reine Auskunft, selten gebraucht, Kopf bleibt sichtbar); Bedienbares und Masse bleiben offen. Das Fenster Objekteinstellungen nutzt
  dasselbe `ObjectInfoPanel` (ohne Bezugspunkt/Masse) und damit dieselben Gruppen und denselben Zustand. Geprüft: vitest `src/panels src/ui
  src/i18n` (neu `infoGroupState.test.ts`), tsc, e2e objectSettings/objectSettingsWindow/roomStamp218, Screenshots hell/dunkel (Gelände,
  Wand; Tastatur Enter/Leertaste). Nicht geprüft: Mac/Tauri, natives Nebenfenster. · S
- [241] Objekt-Info Gelände/Kontextobjekte, Kamera, Baum: Raster wie die übrigen Gruppen (13.11., Chromium hell/dunkel, Musterhaus komplex; Mac/Tauri
  nicht geprüft). Befund: „Höhe des Punkts (m)“ vierzeilig, Felder 64 px; Ursache auch, dass `.objinfo-site` (nur `> `-Kind-Selektor) seit der Gruppierung ([239])
  nicht mehr griff — der Gelände-Block hatte wieder eigenen Scroll und 8 px Polster, Zeilen („Material“, Verbau) waren abgeschnitten. Jetzt Zeilen als
  `.objinfo-field` (Label 104 px | Feld | Einheit hinter dem Feld, `ContextObjectProps.tsx`), kurze Labels (Einheit nicht mehr im Label, Hinweise als
  Tooltip: `site.earthDepth.hint`, `site.excavation.shoringEmbed.hint`), Knöpfe umbrechend in `.site-actions`, Verbau-Kanten umbrechend; Gleitkomma-Rauschen
  im Feld (0,0499999…) auf 12 Stellen gerundet (nur Anzeige). Kamera: Labels gekürzt (Augenhöhe, Bildwinkel vert., Brennweite KB, Sonne), Label-Spalte
  104 px statt 56 px (auch `.objinfo-tree`). Gemessen (Playwright): Gelände, Höhenlinien, Baugrube, Nachbargebäude, Kamera ohne mehrzeilige/abgeschnittene
  Labels, `scrollWidth ≤ clientWidth`. Funktion unverändert. Geprüft: tsc, vitest `src/panels src/ui src/i18n`. Nicht visuell geprüft: Baum (im
  Musterhaus keiner; nur dieselbe CSS-Regel wie Kamera). · S
- [235] `update-dossier` brach nach der Commit-Liste stumm ab (13.11., Maintainer, Void): `git log … | head -20` lieferte bei mehr als 20 neuen
  Commits SIGPIPE, mit `set -euo pipefail` endete das Skript ohne Meldung — weder WASM noch AppImage wurden gebaut, `dossier` startete das alte
  AppImage. Lösung: `git log -20`; `dossier` warnt, wenn das AppImage älter ist als der Checkout. Geprüft: Ursache nachgestellt (Exit 141), Syntax. · S
- [230] Sonnenschatten im Grundriss mit weissen Löchern, je nach Uhrzeit (13.11., Maintainer, Linux). Ursache: Das Ear-Clipping
  (dreifach vorhanden: Kern `gpu_compile`, `render2d`, `render3d`) brach bei den abgetasteten Geländeschatten-Stücken (viele fast kollineare
  Ecken, Ring berührt sich längs einer Geraden) ab und liess den Rest leer — 651 von 4149 Stücken im Musterhaus komplex über ein Jahr.
  Lösung: eine robuste Fassung `hatchgen/src/ear_clip.rs` für alle drei (flache/doppelte Ecken vorab und nach jedem Ohr entfernen,
  Diagonal-Test mit Spiel, zweite Stufe streng, erst dann erzwungen; Spiel = Ausdehnung·1e-7); Probe danach 0 Fehler in f64 und f32. Tests `ear_clip::tests`.
  Geprüft nur im Linux-Container (Probe + Tests), nicht auf dem Mac. · S
- [231] Fenster im Giebel in 3D sauber eingeschnitten (13.11., Maintainer, Musterhaus komplex: Ost-/Westgiebel DG, Anbau-Giebel).
  Ursache: (1) Unter einer Dachfläche zerlegte `wall_bands::emit_top_piece` die Wand um jede Rechteck-Öffnung in Pfeiler/Brüstung/Sturz
  mit eigener schräger Oberkante (sichtbare Fugen von der Öffnung bis zum Dach); (2) im [216]-Wandkörper wurden die Stücke je einzeln
  unterteilt und um 0,1 mm vergrössert — die Stossfläche am First blieb als innere Fläche stehen (Oculus: Streifen bis zum Boden, Bogen
  halb). Lösung: Jede gerade Wand mit Öffnungen unter einer Dachebene bekommt den Körper je Schicht (`model3d/wall_body.rs`); die
  Stücke dafür rechnet `wall_pieces_with(plain)` mit `WallIn::keep_holes` (Löcher statt Teilung); `band_solid` vereinigt Stücke mit
  Dachebene genau (gleiche Schnittlinie → Manifold verschmilzt), unterteilt erst danach, schneidet dann die Löcher; Leibungsstücke des
  Schichteinzugs kommen vergrössert danach dazu; Bänder ganz ohne Dachebene wie bisher. Tests: Rust `giebelwand_mit_rechteckfenster_ein_koerper`,
  `giebelwand_mit_rundfenster_auf_dem_first_ohne_fuge` (keine inneren Flächen, Lochfläche = Öffnungsfläche), vitest
  `toWalls3d.giebel.test.ts` (Komplex: dg-aw-w, dg-aw-o, og-anbau-n ohne Stücke, Aussenschicht fugenlos); Golden `komplex-model3d` neu.
  Geprüft: render_png (Linux/lavapipe) vorher/nachher, verdeckt + schattiert. **Offen:** Mac/Metal nicht angesehen; Bogenwände unter
  Dach behalten die Streifen; Leibungsstücke berühren innere Schichten an einzelnen Kanten; zwei schwache Scheinkanten auf der OG-Südwand
  in der Fernsicht (verdeckt); `emit_walls` Komplex ≈ 100 → 180 ms (Cache je Wand). · S
- [232] 3D: Netzlinien (Fächer der Triangulierung) auf den Dachflächen sichtbar, v. a. in Schwarz-Weiss und von weitem (13.11.).
  Ursache: nicht die Triangulierung der Fläche (koplanare Dreiecke wurden richtig unterdrückt), sondern die FUGE zweier übereinanderliegender
  Schichten (Dach-, Deckenschichten sind je ein geschlossener Körper): Oberseite der unteren und Unterseite der oberen Schicht liegen
  deckungsgleich mit +n/−n und galten in `render3d/edges.rs` (`draws_crease`, Silhouette) als 180°-Knick — die Diagonalen der Fugenfläche
  (Fächer der Ohrenzerlegung mit Dachfenster-/Gaubenlöchern) wurden als Kante gezeichnet und scheinen mit dem Linien-Tiefenversatz von
  weitem durch die Oberfläche. Lösung: Knickwinkel über den Betrag des Skalarprodukts (entgegengesetzte deckungsgleiche Flächen = koplanar);
  Silhouette überspringt Kanten, deren Flächen alle koplanar sind und gegensinnig stehen. Test `edges::double_sided_tests::stacked_layers_do_not_draw_interface_diagonals`
  (vorher 21 statt 20 Kanten). Geprüft: Wireframe-Draufsicht Musterhaus komplex vorher/nachher (Fächer weg, Wendeltreppe/Wände ruhiger),
  `cargo test` render3d (144 grün). Nicht geprüft: Mac/Metal, Tauri-App, Vergleich in der App von weitem. · S
- [233] 3D: Oberflächenmuster-Striche (Fassadenschalung/Dachziegel) ragen über Dachrand und Traufe hinaus (13.11.).
  Ursache: `surface_pattern3d::wall_top_profile` mass die Wandoberkante unter dem Dach auf der Wandachse; die geneigte Dachfläche
  schneidet die Wand aber quer zur Achse an Aussen- und Innenseite verschieden hoch — auf der Traufseite ragten die senkrechten Striche
  bis 15 cm (dg-aw-s/-n im Musterhaus komplex, 5 cm bei og-anbau) über den Wandkörper. Lösung: Profil und Fläche je Wandseite
  (Messlinie im Abstand der Seite). Test `wandmuster_endet_an_der_wandseite_unter_dem_dach` (vorher 0,10 m Überstand, nachher 0).
  Dachziegel-Muster geprüft: Linien enden an den Dachflächen-Polygonen (Ansichten, keine Abweichung gefunden). Geprüft: Probe über alle
  Wände des Musterhauses komplex (0 Wände mit Überstand), `cargo test` Kern (surface_pattern, 15 grün). Nicht geprüft: Bild nachher
  (WASM-Kern im Container nicht neu gebaut, Platte knapp), Mac/Metal, Tauri-App. · S
- [210] Kurzanleitung und Wettbewerbs-Beispiel (13.11.): `doc/KURZANLEITUNG.md` (deutsch, Schritt für Schritt entlang [206], Bilder in `doc/kurzanleitung/`: Plan EG/OG 1:200, Situation 1:500, Schnitt, Ansicht); Beispielprojekt `src/model/sampleProjectWettbewerb.ts` (Mehrfamilienhaus, 3 Geschosse, Flachdach, Baurecht, 30 Räume mit Raumprogramm, Schnitte/Ansichten, Situation, Präsentationsplan A1; Datei → Neu aus Vorlage → Wettbewerb, CLI `:wettbewerb`; Test `sampleProjectWettbewerb.test.ts`); Hilfe → Tastaturkürzel … (Overlay `ShortcutOverviewDialog`, Liste aus `SHORTCUT_DEFS` und `ALIASES` abgeleitet, `state/shortcutOverview.ts`, Test dazu; neues Hilfe-Menü in Browser-Leiste und nativem Menü). Offen: keine 3D- und keine Präsentationsplan-Bilder (Linux-Container ohne WebGPU/Metal), Hilfe-Menü und Dialog nicht in der Tauri-App/auf dem Mac geprüft, Anleitung nicht von einer zweiten Person durchgespielt
- [209] Kostenschätzung grob (12.11.): Kennwert-Methode Menge × Kennwert je eBKP-H-Hauptgruppe B–J (Bezug m³ GV oder m² GF je Methode, wahlweise HNF/Fassade/Dach/pauschal), Honorare/Reserve/MwSt in %, Genauigkeit ±, Region- und Index-Faktor, Preisstand; `Project.costEstimate`, Kern `kosten.rs` (Mengen aus der SIA-416-Flächentabelle, eine Quelle mit [225]). Panel im Flächenbilanz-Panel, Blatt-Tabelle Quelle „costs", CSV/PDF wie der Flächen-Nachweis; e2e-Schritte 5b/10b in `release10.spec.ts`. Vorgaben sind Beispielwerte (≈ 800 CHF/m³ GV bzw. 2'600 CHF/m² GF, keine offizielle Quelle) und als solche markiert; belegt nur MwSt 8.1 % und die SIA-102-Genauigkeiten. Offen: Varianten nebeneinander, Kennwerte aus einer echten Quelle (Büro/CRB), Mac-Gegenprobe
- [185] Navigation wie Archicad (12.11.): Geschosswechsel behält den Ausschnitt, Cmd+5/6 Geschoss runter/hoch, Cmd+3 „3D · Auswahl", Cmd+4 Auswahl im 3D ausblenden.
- [195] Objekt-Einstellungsfenster (12.11.): Taste T öffnet die Objekteinstellungen (Objekt + Darstellung) für alle Bauteile; Weiterführung als natives Nebenfenster in [195b].
- [197] Cmd+3/4: Kamera bleibt stehen (`fitSeq` entfällt, Einpassen nur Cmd/Ctrl+Shift+F); bei „nur Auswahl" bleiben Dachfenster/Deckenöffnungen nicht mehr stehen (Öffnungen folgen ihrem Wirt Wand, Dach oder Decke, `classes.rs::opening_hosts`); Rust-Test + e2e (`navigation185`: Pick-Öffnungen nur der gewählten Wand). Nicht geprüft: Kamera im echten 3D (headless kein WebGPU) und nicht in der Tauri-App (12.11.)
- [196] (1) Raster-Bodenschraffur im EG: war der Bodenbelag der Decke über dem UG (`floor_finishes`, Linien ohne Besitzer) → unsichtbare Fläche mit Pick = Decke (anderes Geschoss), anwählbar und mit Entf löschbar (Cmd+A nimmt sie weiter nicht mit); (2) Auge einer Ansicht in „Nur aktive"/„Alle anzeigen" blendet nicht mehr alle Geschosse ein (Flags werden vorher auf den Modus eingefroren, `frozenLevelFlags`); (3) Geschoss-Auge aus → Geschoss fehlt im 3D und im Pick (`ElementSelection.hide_floors`, Text `hideFloors`). Tests: Rust, vitest `levelEye196`, e2e `levels196`. Nicht in der Tauri-App/auf dem Mac geprüft (12.11.)
- [203] Geschoss-Grundriss zeigt nur sein Geschoss (12.11., Befund e2e): Musterhaus komplex, Ausschnitt „EG 1:100" zeigte Räume/Stempel aller Geschosse (U./O./D.) und doppelte Achsblasen. Ursache: `generateVisibleLevelsPlan` überlagerte im Zeichnungsebenen-Modus „Ausgewählte" (Standard) jedes Geschoss mit Auge an farbig, und das Auge ist für alle Geschosse an (es steuert das 3D, [196]); das Raster (in allen Geschossen) kam so je Geschoss einmal. Jetzt wie Archicad: andere Geschosse nur als bewusst eingeschaltete Pausfolie, d. h. wenn der Modus sie gedimmt zeigt („Andere grau", „Andere grau & gesperrt"), sonst nie (auch nicht „Alle anzeigen"/„Andere gesperrt"); freie Zeichnungsebenen überlagern wie bisher. Achsraster nur einmal: überlagerte Ebenen bekommen `traceOf` (Kern `PlanArgs.trace_of`, Cache-Schlüssel) und lassen Raster weg, die auch im aktiven Geschoss stehen. Beispielprojekte unverändert (Auge an = 3D richtig). Tests: Rust `pausfolie_ohne_doppeltes_raster`, vitest `levelTrace203`, `generateVisibleLevelsPlan`, e2e `levelTrace203` (Test-Naht `planStamps`), Goldens unverändert. Offen: Pausfolie zeigt alle sichtbaren Geschosse (keine Auswahl genau eines Referenz-Geschosses wie Archicad-Trace); nicht in der Tauri-App/auf dem Mac geprüft
- [188] Wand am Anfang kürzen/verlängern: Öffnungen bleiben im Plan stehen (Position ab Wandanfang wird beim Griff-Zug nachgeführt, gerade Wände; `grips.rs::openings_keep_place`) (12.11.)
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
- **[189]** Panels neu ordnen + Einstellungsdialog (12.11.): Attribute-Panel nur noch Gestaltung (Stift, Linienenden, Bemassungs-Darstellung, Füllung); Typ/Aufbau/Masse/Raum/Dach/Treppe/Verweise, Achsraster, Schnittlinie und „Neues Bauteil" (Wandtyp des Werkzeugs) in der Objekt-Info als einklappbare Gruppen (`panels/objectInfo/groups.ts`, `InfoGroup.tsx`; Zustand in localStorage); die doppelte Maß-Anzeige (Ausdehnung X/Y) im Attribute-Panel entfällt. Taste T (rebindbar, `objectSettings`): Fenster/Tür → Öffnungs-Dialog, sonst Abschnitt der Objekt-Info aufgeklappt und fokussiert, ohne Auswahl bei Wand-/Decken-Werkzeug „Neues Bauteil"; macOS-Menü „Bearbeiten > Objekteinstellungen…" ohne Kürzel (ein nacktes T würde das Tippen abfangen). Wand/Decke/Dach/Treppe haben keinen eigenen Typ-Dialog (nur Objekt-Info). Offen: Menüpunkt in der Browser-Menüleiste; nicht in der Tauri-App geprüft. 12.11.
  - 14.11.: e2e „Taste T … ohne Auswahl“ wartete nicht auf das verzögerte Aufheben der Auswahl durch Esc ([204], setTimeout) — Test wartet jetzt auf „Kein Objekt gewählt“; App unverändert.

- **[192]** Ebenen schnell schalten (11.11.): Rechtsklick auf eine Zeile im Ebenen-Panel „Nur diese Ebene anzeigen“ / „Diese Ebene ausblenden“ / „Alle Ebenen einblenden“; im Kontextmenü von Objekt und leerer Fläche (Plan, Schnitt, Ansicht, 3D) „Ebene des Objekts isolieren/ausblenden“ und „Alle Ebenen einblenden“. Sichtbarkeit bleibt `layers[].visible` über Ops (`state/layerIsolate.ts`, ein Undo-Schritt je Aktion); Isolieren lässt Elternklassen an; „Alle einblenden“ stellt den Zustand vor dem ersten Isolieren wieder her (gemerkt je Sitzung/Projekt-Epoche), sonst alles an. Kürzel (umbelegbar): Cmd/Ctrl+Shift+L Ebene der Auswahl isolieren (Cmd+Shift+I ist Boolean-Schnitt), Cmd/Ctrl+Shift+E alle Ebenen einblenden. Test: vitest `layerIsolate.test.ts`, e2e `layerIsolate.spec.ts` (Linux-Chromium; nicht in der Tauri-App geprüft; das native Menü hat keinen Eintrag).
- **[51]** Herkunft übernommenen Codes (12.11.): Inventur; `NOTICE` ergänzt um delaunator/robust-predicates (`core/delaunay.rs`), polylabel (Verfahren, `room_area.rs`), Manifold (Urheber, `solid_bool.rs`), ambientCG-Texturen (CC0), Tango-/Material-Farbwerte; Dateiköpfe `Herkunft:` in `delaunay.rs`, `solid_bool.rs`, `ifc_nurbs.rs` (csg.rs, skeleton.rs hatten ihn schon); Test `src/core/notice.test.ts` (Datei mit `Herkunft:` im Kopf muss in NOTICE stehen, NOTICE-Pfade existieren, jede Schrift hat OFL.txt). Offen/ungeklärt: Herkunft und Lizenz der App-Icons (`src-tauri/icons`) und der Website-Bilder nicht belegt; Mapbox-Copyright ohne Jahr übernommen (die LICENSE im Upstream nennt ein Jahr, das nach Vorlage aussieht); Lizenztexte der Rust-/npm-Abhängigkeiten liegen nur in den Paketen (cargo-deny prüft die Lizenzart, keine Attribution-Datei im Produkt).
- **[223]** 3D-Bild für die Abgabe (13.11.): Befehl `bild3d` (Alias `3dbild`, `bildexport`) und Menü Ansicht → „3D-Bild exportieren …“ öffnen
  `ui/ImageExportDialog.tsx`: Auflösung Ansicht / Full HD / 4K / A4–A2 bei 300 dpi / eigene Grösse, transparenter Hintergrund, Kamera live
  oder gespeichert ([213], `cameraToView`), Speichern als PNG oder „Ins Layout einsetzen“ (`layoutImageActions`, wie [211]). render3d
  zeichnet direkt in der Zielgrösse (`useWasm3dRenderer.exportImage`, Kante begrenzt auf `IMAGE_MAX_EDGE`), mit der aktuellen
  Darstellung; Transparenz aus zwei Durchgängen auf Schwarz/Weiss (`imageExport.matteFromBlackWhite`, `WebModelRenderer::set_clear_color`).
  Nicht in Tauri/Metal geprüft; headless kein WebGPU-Bild → e2e (`release10.spec.ts`) prüft Dialog/Grössen/Einsetzen über `__dossierImageMock`.
- **[224]** Präsentationsplan für den Wettbewerb (13.11.): leere Geschosse nicht vorgewählt (Markierung „leer“), nur vorhandene Ansichten
  (einzeln wählbar) und Schnitte, Massstab gemeinsam (Vorgabe 1:200) und je Viewport wählbar, Plakat-Vorlage ([208]) als Ziel
  (eigener Rand/obere Kante unter der Kopfzeile); Kern `presentation_sheet.rs` (`choose_fixed`, `scale`/`scales`/`marginMm`/`topMm`). Fehlende
  Ansichten N/O/W werden nicht automatisch erzeugt (Befehl `viewline` von Hand). e2e `release10.spec.ts` und `presentationSheet.spec.ts`.
- **[221]** LV95-Projekte (12.11.): Entscheid: das Modell bleibt lokal um einen Projekt-Nullpunkt, statt Landeskoordinaten
  (≈ 2.6 Mio. m) im Modell zu führen — f32 in 3D/GPU (≈ 25 cm Raster bei LV95), das Ganzzahlraster der Booleans und alle
  Ausmass-Rechnungen vertragen das nicht. Der DXF/DWG-Import „an DXF-Koordinaten" in LV95 setzt ohne Standort-Bezug den
  Kilometerpunkt unter der Mitte als `geoAnchor` (Modell-x = Landeskoordinate ohne Kilometer, z. B. E 2 600 048 → 48) und
  verschiebt Zeichnungen, Höhenlinien und Meshes; mit Bezug rechnet er auf dessen Ursprung (Kern `import_drawing::lv95_origin`).
  Exporte rechneten schon zurück (`projectToWorldCoords`); getippte Landeskoordinaten werden auf den Nullpunkt gerechnet
  (`parseInput.ts::fromWorldInput`), die Statusleiste zeigt im Grundriss zusätzlich LV95 des Zeigers. Schnitt A/Ansicht Süd
  des leeren Projekts tragen `autoLine` und folgen im selben Undo-Schritt dem Gebauten (ab 1 × 1 m Ausmass, sonst der Parzelle) — Schnitt quer
  durch die Mitte, Ansicht davor —, bis man die Linie bearbeitet (Kern `auto_lines.rs`, wie die assoziative Bemassung im
  `commit`). Schnitt-/Ansichtsmarken weit weg vom Gebauten zählen nicht mehr zum Ausmass (`domains::merge_marks`): kein
  „Einpassen" auf 1:10 Mio. mehr. Tests: Rust (`auto_lines`, `import_drawing_tests`, `ferne_schnittmarken_nicht_im_ausmass`),
  vitest (`parseInput.test.ts`, `dxfBulgeImport`), e2e `release10` Schritt 3b + Datei-Prüfung, `kataster.spec` auf lokale
  Koordinaten. Offen: IFC-/Mesh-/STEP-Import setzen noch keinen Bezug (rechnen nur auf einen vorhandenen); Lineale zeigen
  lokale Koordinaten; alte Dateien mit Landeskoordinaten ohne Bezug bleiben, wie sie sind (Befehl „Neuer Bezugspunkt");
  Schnitt A ist ein Längsschnitt (parallel zur Linie des leeren Projekts), nicht quer zum First; nicht in der Tauri-App geprüft.
- **[225]** Kennzahlenleiste = Flächentabelle (12.11.): `kennzahlen::compute` liest die Flächentabelle und die IVHB-Ziffern
  (`flaechen::area_table`/`ivhb` mit den Vorgaben der Tabelle: aGF = NGF oberirdisch, aGSF aus Parzellenfläche/-grenze):
  GF = NGF + KF (Testgebäude 127.7 m² statt 112.5), ÜZ = aGbF/aGSF, dazu NGF, HNF, KF in der Abfrage. Tests: Rust
  `leiste_gleich_flaechentabelle`, vitest Musterhaus, Musterhaus komplex und Referenz-Ablauf-Gebäude, e2e `release10` Schritt 5
  (Kachel GF = Summenzeile GF). Offen: die Eingaben der Tabelle (aGSF, Basis der aGF, Untergeschosse) wirken nur auf die
  Tabelle, die Leiste rechnet mit den Vorgaben.
- [237] Sichtprüfung der Oberflächen vom 13.11. im Browser (13.11., Chromium, hell und dunkel; Mac/Tauri nicht geprüft): Kürzel-Übersicht, Vorlage Wettbewerb, Körper → Bauteile, Plakat-Blatt (Hilfslinien, Lineal, Bild, Zuschnitt), Publikation, 3D-Darstellungsarten, Gelände-Objekt-Info, Bild-Export. Korrigiert: Publikation „Publizieren“ war ein 20-px-Kreis und abgeschnitten (`.nav-add-text`, auch „WBW-Abgabe anlegen“); Objekt-Info Gelände/Baugrube: Abschnitt schrumpfte auf eine Zeile Höhe und die Felder (Glättung, Material …) liefen horizontal über die Spalte (`.objinfo-site`, `minmax(0,1fr)`), Material jetzt eigene Zeile; Bild-Export: Breite/Höhe/Samples in 16 px und mit 22 px Einzug (`.imp-field-label`, `.imp-input-flush`); Kürzel-Suchfeld mit Checkbox-Einzug; undefinierte CSS-Variablen (`--text`, `--text-dim`, `--fg`, `--hover`, `--ink-dim`, `--accent-soft`, `--panel-3`, `--mono`) auf die echten Tokens umgestellt (Listen-Hover, Fortschrittsdialog, Menüleiste, Nebenfenster); Wettbewerb-Vorlage meldete „documentFor“-Fehler in der Konsole (Präsentationsplan ohne `withDocument`); Meldung Körper → Bauteile ohne „1 Geschosse/1 Decken“ („Erzeugt: Geschosse n · Aussenwände n · Decken n · Flachdach.“, e2e `release10` angepasst). Die grösseren Befunde (Dock-Höhe Flächenbilanz, Kopfleiste Blatt, Zuschnitt-HUD, Render-Dialog, Objekt-Info Gelände, Darstellungs-Menü) sind in [238] erledigt. Offen: Pathtracing-Vorschau in SwiftShader ohne Bild (bekannt).
- [238] Sichtprüfung 13.11., grössere Befunde aus [237] (13.11., Chromium hell/dunkel, vorher/nachher nach `scratchpad/ui2`; Mac/Tauri nicht geprüft): Standard-Dock rechts 1,6 : 1 statt 1 : 1,5 (Layout v13; Flächenbilanz samt Raumprogramm ohne Scrollen sichtbar, Höhe merkt wie bisher der Gruppen-Splitter); Kopfleiste des Layout-Blatts 12 px statt 15 px (`.layout-sheet-toolbar .nav-add`, ebenso die Knöpfe der Blatt-HUDs); Zuschnitt-HUD mit fester Breite, Knopf „Zuschneiden“/„Fertig“ mit fester Breite und Hinweiszeile immer reserviert, Knopf bleibt an derselben Stelle (vorher x 385→466, y 754→737); `RenderDialog.tsx`: Breite/Höhe/Datum/Blender-Pfad mit `.imp-field-label`/`.imp-input-flush`; Objekt-Info Gelände: Panel scrollt (nur Dock-Höhe), unterer Rand läuft jetzt aus (`.objinfo-panel::after`, sticky, am Scrollende im Polster, nichts verdeckt), am Scrollende ist jede Zeile lesbar (Dock bleibt für den langen Gelände-Block zu niedrig: offen, ob Auswahl-Abschnitte einklappbar werden sollen); Darstellungs-Menü im 3D: z-index 1100 und deckender Grund (`--panel-2`), kein CSS-Fehler, der Screenshot traf die 0,1-s-Einblendung (`ctx-pop`), mit 700 ms Wartezeit deckend.
