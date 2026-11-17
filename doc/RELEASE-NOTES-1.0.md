# Dossier 1.0 «Wettbewerb & Vorprojekt» — Release-Notes (Entwurf)

Entwurf vom 14.11.2026 (nachgeführt am Abend) für Anwender:innen (Architekt:innen). Stellen mit **[Frage M: …]** muss der Maintainer entscheiden
oder bestätigen; sie sind unten unter «Offene Fragen an den Maintainer» gesammelt. Grundlage sind `TODO.md`,
`doc/RELEASE-1.0.md` (Abnahme-Checkliste) und `doc/KURZANLEITUNG.md`. Der Durchlauf auf dem Mac steht noch aus: alles,
was hier als «geht» steht, ist bisher im Linux-Container und im Browser-Build geprüft (CLI-Ausgabe, Chromium, Tests),
nicht in der Mac-App.

## Wofür 1.0 gedacht ist

Dossier 1.0 soll einen **Architekturwettbewerb (WBW) und ein Vorprojekt (SIA 31)** vom leeren Projekt bis zur Abgabe tragen.
Der Referenz-Ablauf: Grundstück und Kontext laden → Baurecht und Hülle → Volumenstudie → Raumprogramm gegen Modell →
Grundrisse, Schnitte, Ansichten 1:200 (Vorprojekt 1:100) → Situation 1:500 mit Schwarzplan → 3D-Bilder, Axonometrie,
Schatten → Flächen und Volumen nach SIA 416, Kennzahlen → Kostenschätzung grob → Abgabe-Layouts (Plakate A0/A1, Kennwort,
anonym) als PDF → Austausch mit Fachplaner:innen über DXF und IFC.

Nicht Ziel von 1.0: Ausführungsplanung 1:50/1:20 mit Details, Bibliothek per GUID, Windows-Paket.

Dossier arbeitet mit **einem** Modell: Wände, Decken, Dächer, Treppen, Fenster, Türen, Räume. Grundriss, Schnitt, Ansicht, 3D,
Mengen und Exporte werden daraus berechnet und stimmen nach jeder Änderung wieder überein.

**Plattformen**
- **macOS** (Tauri, Metal): Hauptplattform.
- **Linux** (Electron, AppImage x86_64): offiziell unterstützt (Entscheid 16.11.). Geprüft im Linux-Container (Xvfb, ohne echte GPU):
  Start, Neues Projekt, Wände per Befehlszeile, Speichern (atomar, Vorversion `.obp~`), Öffnen per Dialog und per Argument
  (`dossier datei.obp`), PDF-/DXF-Export, Wiederherstellen nach Absturz (`doc/RELEASE-1.0.md`, Abschnitt 15). Braucht FUSE 2
  (`libfuse2`, Ubuntu 24.04: `libfuse2t64`), sonst `--appimage-extract-and-run`.
- **Browser-Build:** vorhanden (kürzere Menüleiste, Dateien laden/speichern als Download, kein natives Fenster, keine Metal-Anzeige).
- **Windows:** kein Paket in 1.0.

**Systemvoraussetzungen:** Aus dem Repo nicht ersichtlich (kleinste macOS-Version, Prozessor, Arbeitsspeicher, Grafik).
Die 3D-Anzeige braucht WebGPU bzw. Metal. **[Frage M: Systemvoraussetzungen und kleinste macOS-Version?]**
Das Rendering braucht kein Blender mehr: Cycles (Apache-2.0) ist als eigenes Hilfsprogramm in der Desktop-App enthalten (Linux-AppImage ≈ +70 MB). Wer lieber Blender nutzt, wählt im Dialog „Renderer“ → „Blender“ (dann muss es installiert sein).

## Was geht

Entlang des Referenz-Ablaufs (Beispielprojekt zum Mitklicken: *Datei → Neu aus Vorlage → Wettbewerb*; Schritt-für-Schritt-Anleitung
in `doc/KURZANLEITUNG.md`):

1. **Grundstück und Kontext.** Kataster als DXF/DWG in Landeskoordinaten (LV95) laden; Projekt-Nullpunkt und LV95-Anzeige in
   der Statusleiste. Standort-Import von swisstopo (Gebäude, Gelände, Luftbild) und OSM, Kontextgebäude werden aufs Gelände gesetzt.
   Gelände aus Höhenlinien.
2. **Baurecht.** Parzelle aus der Auswahl, Grenzabstand je Kante, Baulinie, Profilwinkel, Gesamthöhe. Die Prüfung steht im Panel
   (z. B. «Höhe 5.72 m ≤ 12.00 m»); die zulässige Hülle lässt sich im 3D zeigen. **Baurecht-Nachweis:** zulässige GFZ, AZ, BMZ, ÜZ, GZ und
   Fassadenhöhe im Panel eintragen; die Flächenbilanz zeigt die Tabelle zulässig/Projekt/Reserve (CSV, PDF, Blatt-Tabelle, CLI `kennzahlen --nachweis`).
3. **Volumenstudie.** Wände, Decken und Dach zeichnen; Wände mit Cmd/Ctrl+J verbinden (Ecken, T-Stösse, auch Bogenwände); oder ein Volumen als Körper anlegen und mit dem Befehl `koerperinbauteile`
   in Wände, Decken und Dach je Geschoss umwandeln (ein Undo-Schritt).
   **Objektbibliothek 2D:** 48 parametrische Objekte (Sanitär, Küche, Tische, Sitzen, Schlafen, Schränke, Auto/Parkfeld, Velo,
   Wendekreis) aus dem Panel «Objekte» oder per Befehl `libobj`; R dreht, M spiegelt; Parameter, «Unordnung» und «Neu würfeln»
   in der Objekt-Info; Detailstufe grob/mittel/fein; eigene Klassen 22–24; im DXF als Block, nicht im IFC.
4. **Raumprogramm.** CSV/Tabelle importieren, Räume zeichnen, Soll/Ist-Abgleich in der Flächenbilanz; «Räume generieren» aus dem Programm.
5. **Pläne.** Grundriss je Geschoss, Schnitte und Ansichten aus Schnitt- und Ansichtslinien, SIA-400-Schraffuren und -Linientypen,
   Massstab und Detailgrad, Bemassung, Koten, Raumstempel mit wählbarer Schrift.
6. **Situation und Schwarzplan 1:500.** Ansichtsvorlagen «Situation WBW 1:500» und «Schwarzplan 1:500»: eigenes Gebäude und
   Kataster-Gebäude gefüllt, Parzelle, Nordpfeil, Massstabsbalken; alles auf Klassen, einzeln ausschaltbar.
7. **3D und Schatten.** 3D-Viewport mit Live-Schnitt, Axonometrie, Sonnenstand und Schatten (Datum/Uhrzeit), Kameras und
   Kamerafahrt, Begehen mit Kollision, 3D-Bild als PNG in Abgabeauflösung (`bild3d`). Rendering mit dem eingebauten Cycles (ohne Blender) oder über ein installiertes Blender;
   eingebauter Pathtracer als Vorschau. **3D-Dokument** (16.11., [266]): *Ansicht → 3D-Dokument erstellen* zeichnet die aktuelle
   3D-Kamera (Parallel oder Perspektive) als Vektorzeichnung mit verdeckten Kanten aus dem Kern (Umriss kräftig, Flächen nach Lage
   hellgrau), als Ausschnitt mit Blatt A3; sie rechnet bei Modelländerungen neu und geht ins PDF/SVG/DXF, ohne Grafikkarte. Jeder
   3D-Ausschnitt zeigt auf dem Blatt diese Zeichnung; Vorgaben Südost/Südwest/Nordost/Nordwest als Isometrie oder Militär 45°/45° bzw.
   30°/60°; CLI `axo`. Der Präsentationsplan setzt die Axonometrie Südost in den Bild-Rahmen, wenn kein gerendertes Bild da ist.
8. **Flächen und Kennzahlen.** Flächen nach SIA 416 / IVHB (HNF … GF, GFZ, AZ, BMZ, ÜZ), Raumbuch, Flächen- und Kennzahlen-Nachweis
   als CSV und PDF; Kennzahlenleiste und Tabelle rechnen aus derselben Quelle. **GV nach SIA 416 inklusive Dachraum:** je Geschoss
   GF × Geschosshöhe, dazu der Raum unter Steildach und Gauben bis Oberkante Dach (ohne Dachvorsprünge, Kniestock-Geschosse nur bis
   zur Dachfläche); BMZ, Kosten je m³ GV, Baurecht-Nachweis, IFC-Mengen und Blatt-Tabellen zeigen denselben Wert. Freie Körper zählen
   nur im reinen Massenmodell (ohne Geschossflächen).
9. **Kostenschätzung grob.** Kennwert-Methode je eBKP-H-Hauptgruppe B–J (CHF/m³ GV oder CHF/m² GF), Honorare, Reserve, MwSt,
   Bandbreite; CSV/PDF und als lebendige Tabelle auf dem Blatt. **Die Kennwerte sind Beispielwerte (rund 800 CHF/m³ GV bzw.
   2'600 CHF/m² GF), keine offizielle Quelle; sie sind in der Tabelle als solche markiert.**
10. **Abgabe.** Layout-Blätter mit Viewports, Legenden, Tabellen; Präsentationsplan A1 in einem Schritt; Plakat-Vorlagen A0/A1 (hoch/quer)
    mit Raster-Hilfslinien (nur am Bildschirm), Kennwort-Feld und Bild-Element mit Zuschnitt; der Präsentationsplan füllt ein Plakat auf dem Spaltenraster
    (Situation 1:500, Pläne, Ansichten, Schnitt, Tabellen Kennzahlen und Baurecht-Nachweis, Rahmen fürs 3D-Bild; «Plakat-Inhalt» im Dialog, bei Platzmangel
    ein zweites Plakat statt kleinerem Massstab, ohne Schriftfeld); alle PDF-Schriften sind eingebettet; Publikationssätze als ein PDF
    (mit PDF-Ebenen), «WBW-Abgabe» für alle Plakate. **Freie Texte auf dem Blatt** (15.11., [208]): Knopf «Text» in der Blatt-Leiste, Schriftgrösse nach
    Blattformat, Blocksatz, Fang an Papierrand, Hilfslinien und Rahmen; im DXF als MTEXT ([200]).
11. **Anonyme Abgabe.** Mit «Wettbewerb (anonym)» und Kennwort zeigen Plankopf und Dateinamen nur das Kennwort. Geprüft für PDF,
    Berichte, IFC, DXF/DWG, STEP, SVG, OBJ/STL/glTF und das Blender-Paket. **Freitext-Prüfung:** Vor jedem Export (Oberfläche und Kommandozeile) sucht
    Dossier in allen Namen und Texten des Projekts nach Projektname, -nummer, Büro, Bearbeiter:in, Adresse, Dateiname, eigenen Begriffen
    («Weitere Angaben») sowie E-Mail-Adressen und Telefonnummern; der Dialog «Anonymität prüfen» nennt Bereich, Element, Feld und Begriff
    der Fundstelle. «Trotzdem exportieren» bzw. `--ignore-anonymity` übergeht ihn. Die Prüfung findet nur, was sie kennt (siehe unten).
12. **Austausch.** DXF/DWG (Geschoss, Schnitt, Ansicht; LV95), IFC4/IFC2x3 mit Wänden, Decken, Dächern, Räumen, Öffnungen, Treppen und
    Psets (inkl. `CH_Qto_SIA416`; Bauteile auf IFC-Ebenen je Klasse, Raumhöhe = lichte Höhe), STEP, OBJ/STL/glTF, SVG, PDF. **IFC für Fachplaner:innen:** Geometrie lokal um den Projekt-Nullpunkt,
    LV95-Lage als Georeferenz (Versatz und ±0.00 m ü. M.), Räume mit Nummer, Name, Fläche und SIA-416-Kategorie, Geschossflächen und
    Gebäudesummen; Mengen stimmen mit der Geometrie überein (mit ifcopenshell gegengeprüft, alle drei Beispielprojekte ohne Befund). Option
    «Kontext mitgeben (Gelände, Nachbargebäude)» im Export-Dialog bzw. `--kontext` (Vorgabe aus). Die Objektbibliothek (Möbel, Sanitär) wird nicht ins IFC geschrieben. Was in welche Richtung verloren geht, steht in `doc/DATEIFORMATE.md`.

**Erker und Wiederanlauf (15.11.).** Fenster in Bogenwänden (Erker) sitzen in Schnitt und Ansicht wie im 3D und im Grundriss auf der Sehne; die Sehnen-Zonen
gelten über alle Geschosse, der Deckenrand folgt der Sehne ([216]). Raumstempel rücken in Lücken zwischen den Linien, bevor sie schrumpfen; die Baulinie setzt vor
Masszahlen aus ([256]). Fällt die Grafikkarte aus, baut Dossier die Anzeige mit Pausen neu auf: der Plan bleibt beim SVG, das 3D zeigt nach mehreren
Fehlschlägen einen Hinweis, die Kamera bleibt erhalten, das Begehen läuft auch ohne GPU ([118], [206]).

**Darstellung im Plan (Stand 14.11.).** Nachbargebäude erscheinen über den Stil ihrer Klasse (Füllung einstellbar im Ebenen-Editor, in den
Standard-Situationsplänen grau); Treppen haben im Grundriss eine Bruchlinie in Papiergrösse; die Standard-Vorlagen Präsentation, Eingabe,
Ausführung, Situation und Schwarzplan blenden Kamera-Sichtkegel (Klasse 92) und Sonnenschatten (08) aus; im 1:100-Grundriss werden Fenster
und Türen nach Wahl symbolisch (Vorgabe: Öffnungssymbol unabhängig von der Schnitthöhe, auch Badfenster ab 1.10 m und Oberlichter) oder
geschnitten (nach der Schnitthöhe: Wand geschlossen, Öffnung als Linie über/unter Schnitt, auf schwarzer Wand hell) gezeichnet — je Element
(Taste T), je Fenster-/Türtyp oder als Vorgabe der Modelldarstellung (~~Frage M: Fenster über Schnitt~~ — erledigt durch [260], Entscheid 15.11.). Höhenkoten messen nur das eigene Gebäude. In der schmalen
Seitenleiste werden die breiten Tabellen (Flächenbilanz, Fenster-/Türliste, Raumbuch) zu Karten statt seitlich zu scrollen.

**Leistung.** Mit grossen Kontext-Importen (300 Gebäude, 100 000 Dreiecke) wurden Ansicht, «Aufs Gelände setzen» und der DXF-Export deutlich
schneller (im Container gemessen, z. B. DXF eines Geschosses mit Gelände 3.1 s → 0.4 s); Änderungen am eigenen Haus rechnen den Kontext nicht
neu. Schnitt und Ansicht bleiben mit sehr grossem Kontext spürbar (ca. 0.1–0.6 s je Änderung) ([257]).

**Robustheit.** Ein Testlauf mit beschädigten Projektdateien, absurden Zahlen und zufälligen Änderungen hat im Rechenkern mehrere
Abstürze und Endlosschleifen aufgedeckt, die behoben sind ([258]). Eine Garantie ist das nicht; sollte der Kern doch abstürzen, startet er neu (s. [118]).

**Bedienung.** Tab öffnet immer die Befehlszeile; Ctrl+Tab und Ctrl+Umschalt+Tab wechseln die Ansichts-Reiter.

**Datensicherheit** ([116]). Speichern und Exportieren schreiben atomar (Tauri; Projekt-Speichern auch unter Electron): bei einem Fehler bleibt die
vorhandene Datei heil und eine Meldung erscheint; die vorige Fassung bleibt als `.obp~` liegen. Fenster schliessen, Cmd+Q, Neu und Öffnen fragen bei
ungespeicherten Änderungen nach. Solange es ungespeicherte Änderungen gibt, legt Dossier alle 30 Sekunden eine Kopie ab (zwei Stände, nur lesbare
werden angeboten) und bietet sie nach einem Absturz beim nächsten Start an (Wiederherstellen · Verwerfen · Später); schlägt das Schreiben der Kopie
fehl, meldet Dossier das einmal. *Datei → Vorige Fassung wiederherstellen …* öffnet die `.obp~`; lässt sich eine Datei nicht laden, wird sie
angeboten. Die Kopien liegen im Speicher der Webview: Löschen der Webview-Daten löscht sie. Eine Sperrdatei
(`<datei>.obp.lock`) verhindert gleichzeitiges Bearbeiten unter Tauri; im Browser gibt es keine. Der Undo/Redo-Verlauf wird nicht
gespeichert. Für Abstürze im Rechenkern gibt es einen Wiederanlauf (nicht überall geprüft, s. [118]).

**Dateiformat.** Projekte sind `.obp` (Vorlagen `.obpt`). Eine Datei aus einer neueren Dossier-Version lehnt eine ältere ab;
ältere Dateien werden beim Öffnen migriert. Ab 1.0.0 öffnet jede 1.x-Version alle Dateien aus 1.x; Stände aus den Betas sind nicht garantiert öffenbar.

**Lizenz.** GNU Affero General Public License v3.0 oder später (`LICENSE`), © 2026 Karim Gabriele Varano. Fremdkomponenten behalten ihre Lizenzen
(`NOTICE`: u. a. acadrust MPL-2.0, Manifold Apache-2.0, i_overlay MIT/Apache-2.0); mitgelieferte ambientCG-Materialien sind CC0.
Wer Dossier verändert und als Netzwerkdienst anbietet, muss den Quellcode offenlegen.

## Bekannte Einschränkungen

Ehrlich vorweg: **Der Durchlauf des ganzen Referenz-Ablaufs auf dem Mac ist noch nicht gemacht** ([206], «Mac-Gegenprobe» in
`TODO.md`). Fast alles unten gilt dort nur als «im Linux-Container/Chromium geprüft».

**Allgemein**
- Die Anzeige (Metal, native Fenster, Menüs, Dialoge) wurde bisher fast nur im Container und im Browser angesehen. Ungeprüft auf dem Mac
  sind u. a. atomares Speichern ([116]), Sicherheitsrichtlinie der Webview ([117]), Wiederanlauf nach Kern-Panic ([118]), Texte beim Zoomen
  ([194], [145]), Objekteinstellungen als eigenes Fenster ([195b]), Linienenden ([146]), Cmd+J Verbinden ([190]).
- 3D-Bilder konnten headless nicht verglichen werden: Es gibt dort kein echtes WebGPU. Aussehen von 3D, Schatten und Hülle ist auf dem Mac zu prüfen ([206]).
- 3D-Dokument ([266]): verdeckte Kanten zeigt es nur, wo zugewandte Flächen verdeckt sind (keine Rückseiten); Fenster sind Öffnungen ohne Rahmen und
  Glas; Flächen kleiner als etwa 1/1200 der Bildbreite bleiben ungetönt; Gelände und Kontext-Netze nur auf Wunsch (`--context`), Gelände-Element
  gar nicht. Ob die Zeichnung zur Kamera im 3D-Fenster des Mac passt (Achsen, Spiegelung), ist nicht geprüft.
- Leistung mit grossen Kontext-Importen ist nur im Container gemessen, nicht auf echter GPU ([214]).
- Linux: das AppImage ist nur im Container geprüft (Xvfb, SwiftShader, als root mit `--no-sandbox`). Ungeprüft: echte Grafikkarte
  (Mesa-Vulkan), Wayland nativ, die GTK-Dialoge für Speichern/Export von Hand, Start mit Chromium-Sandbox als normaler Benutzer, Menüeintrag
  und Doppelklick auf `.obp` nach der Desktop-Integration (AppImageLauncher o. ä.), Rendering mit Blender. Keine Update-Prüfung unter Linux;
  Flatpak, deb und rpm gibt es nicht ([170]). Windows gibt es nicht.
- Update- und Signier-Weg (macOS signiert/notarisiert, Updater, CI) sind noch nicht lauffähig nachgewiesen ([30]).

**Grundstück, Situation**
- Echte Kataster-DXF verschiedener Kantone sind nicht geprüft; Layer-Zuordnung (Gebäude, Strassen, Gewässer) folgt gängigen Namen, rein
  numerische Layer bekommen noch keine Bezeichnung ([207]).
- Strassennamen folgen der Achse (Linie, Polylinie, Bogen derselben Klasse und Ebene in Schrifthöhen-Nähe); ohne Achse stehen sie gerade mit der Drehung
  aus dem DXF. Nur im Container und im CLI-SVG angesehen ([207]).
- Standort-Import (swisstopo/OSM) braucht Netz und ist im Container nicht geprüft ([206]).
- Nachbarhäuser ausserhalb des Geländenetzes nehmen die Randhöhe des Netzes, das Gelände setzt sich nicht geneigt fort; im Rendering «hinterfüllt» schneidet
  das Gelände nur innerhalb der untersten Bodenplatten aus (keine Platten mit Löchern, keine Fundamente) ([227]).

**3D, Darstellung**
- Bogenwände und Formöffnungen ([216], [234]): Formöffnungen schneiden die echte Form, Fenster folgen dem Bogen (mit Schichteinzug stehen sie gerade auf der
  Sehne), Öffnungen enden an der Deckenunterkante, der 3D-Live-Schnitt zeigt die echte Öffnungsform. Nur per Rust-Test und im Container geprüft: kein Metal, der
  Live-Schnitt ist nicht angesehen, keine Mac-Gegenprobe; Rahmen und Glas schmaler Öffnungen bleiben gerade.
- Schriftfamilien in Stempeln und Textfeldern erscheinen in SVG/PDF/DXF; im GPU-Plan ist die Mac-Variante nicht kompiliert/geprüft, und
  gedrehte Textfelder zeigen noch die Systemschrift ([226], [218]).
- Begehen: Decken-Unterseiten begrenzen den Kopf nicht; Formöffnungen zählen als volle Wand ([245]). Kamerafahrt-Video: Aufnahme unter
  Tauri/WKWebView nicht geprüft, Bildinhalt nicht gesehen ([246]).
- **Pathtracing ist eine Vorschau** (progressiv, höchstens 1024 Samples, vereinfachte Materialien) und auf dem Mac nicht geprüft ([212]).
  Unter der Software-GPU (SwiftShader) des Test-Containers brach der erste Pathtrace-Lauf mit einem Fehler ab; auf echter GPU nicht geprüft.
- **Rendering mit dem eingebauten Cycles ([215])**: im Linux-AppImage mit CPU geprüft (Dialog, Fortschritt, Bild, Ins Layout einsetzen);
  **auf dem Mac (Metal-GPU, Tauri, erstes Übersetzen der Rechenkerne, Signieren des Hilfsprogramms) nicht geprüft**. Im Browser nicht verfügbar.
- **Rendering mit Blender** (Option im selben Dialog): Lauf mit installiertem Blender nur im Container (bpy 5.3, CPU) geprüft; Mac, Metal-GPU und
  Blender 3.6/4.x offen ([211], [229], [228]). Ohne Blender gibt es nur einen Hinweis.

**Pläne und Abgabe**
- **1:100-Pläne in Abgabequalität** (Bemassung, Koten, Raumstempel, Öffnungen nach Detailgrad) sind noch nicht abgeschlossen (Phase 3, Plan-Review
  nach [199]).
- Ansichten Nord/Ost/Süd/West entstehen in einem Schritt (*Ansicht → Ansichten aller Seiten erzeugen*, Befehl `ansichten`, [267]),
  ausgerichtet an der Hauptrichtung des Gebäudes. Es gibt noch keinen Nordwinkel: der Plan gilt oben als Norden, die Namen
  folgen der nächsten Himmelsrichtung. Der Präsentationsplan nimmt nur vorhandene Ansichten ([224]).
- **Anonymität** ([208]): Die Freitext-Prüfung findet nur Begriffe, die Dossier kennt (Projektangaben und die Liste «Weitere Angaben»); Wörter ohne
  Bezug dazu, Wörter unter 5 Zeichen (Einzelwort), allgemeine Wörter und blosse Zahlen nicht. Vor der Abgabe trotzdem von Hand durchsehen.
  `dossier-cli convert` und BCF-Export prüfen nicht. Programmkonventionelle Namen wie `Dossier_Qto_…` im IFC bleiben. Der Dialog-Weg ist nur
  per Code-Abgleich geprüft, nicht in der Tauri-App.
- **Freie Texte auf dem Blatt und MTEXT** ([208], [200]): Blocksatz am Bildschirm im Editor per CSS, in Szene/PDF per Metrik ohne Kerning (±1 mm zum Editor
  möglich); Objektfang an Tabellen nur mit fester Höhe, Legenden fehlen; Breite-Ziehen an den Griffen der Textspalte nicht geprüft; Vorgabe-Klasse ist die aktive
  Klasse. **Das DXF mit MTEXT wurde in AutoCAD/BricsCAD nicht geöffnet** (nur mit ezdxf geprüft; CAD bricht nach eigenen Metriken um), Texte ohne Transparenz.
  Nur Linux/Chromium, nicht in der Tauri-App.
- **Grafikkarten-Verlust** ([118], [206]): Neuaufbau mit Pausen, Plan bleibt beim SVG, 3D-Hinweis, Kamera bleibt erhalten — **nur headless (SwiftShader) mit erzwungenem
  `GPUDevice.destroy()` geprüft, auf dem Mac (WKWebView/Metal) mit echtem Verlust nicht**; ein unverändertes Preset wird nach dem Neuaufbau neu eingepasst.
- **Erker im Musterhaus komplex** ([216]): Die Vereinigung der Sehnen-Zonen ergibt dort eine 2-m-Facette (Pfeilhöhe ca. 25 cm) über UG, EG und OG, weil die
  Fenster überlappen. **Entscheid Maintainer 15.11.:** das UG-Fenster wird über die EG/OG-Fenster gelegt, damit der Erker rund bleibt (umgesetzt: getrennte 1-m-Sehnen statt der Facette). Nur im Container
  (CLI-SVG in Chromium, Rust-Tests) angesehen; Mac-Gegenprobe, Metal-3D und Live-Schnitt offen; an der Geschossgrenze bleibt eine Kante, wenn UG und EG
  verschiedene Wanddicken haben; der Dachrand `dach-erker` folgt weiter dem Bogen.
- Plakat: Hilfslinien gehören zum Masterlayout, nicht zum Blatt; kein Fang für Legenden; Bilder werden als Data-URL im Projekt gespeichert
  (Dateigrösse und Verlauf wachsen bei grossen Bildern); Bild erscheint nicht in DXF/IFC ([208]).
- Plakat aus dem Präsentationsplan ([208]): Die Rahmen sind so breit wie der Inhalt samt Masskette und Kontext (bei grossen Häusern viel Weissraum, zwei Blätter);
  die Anordnung mischt Gruppen (Pläne neben der Situation, Ansichten darunter) statt strenger Zeilen; Tabellen-Spaltenköpfe («Reserve/Erfüllt») sind eng; die Lage von
  Tabellen und Bild ist nicht von Hand festzuhalten (Neuberechnung nur durch Neuerstellen). Schriften sind eingebettet, aber Zeichen ausserhalb der
  Latin-Teilmenge (z. B. Σ) werden ersetzt oder bleiben leer; PDF/X und Plotter-Ebenen nicht prüfbar. Alles nur im Linux-Container mit Chromium
  geprüft (PDF mit `pdffonts`/`pdftoppm`), nicht in der Tauri-App.
- **Ansicht und Schnitt 1:200** ([208], Abgabe-Review): Bodenlinie auf ±0.00 mit Überstand (Klasse «02 Gelände»), Höhenkoten in Papiergrösse (2 mm),
  Fenster in der Ansicht mit Rahmen und Glas, ausweichende und rauschfest lesbare Masszahlen sind behoben. **Bewusst vereinfacht:** mit der Vorlage
  «Wettbewerb 1:200» zeigen Grundriss und Schnitt die Fenster als Linien (nur die Ansicht zeigt Rahmen/Glas). Nur im Linux-Container (CLI-SVG in Chromium,
  PDF mit Poppler `pdftotext`/`pdftoppm`) angesehen, nicht auf dem Mac.
- Kostenschätzung: Kennwerte sind Beispielwerte; keine Varianten nebeneinander, keine Kennwerte aus Büro- oder CRB-Quelle ([209]).
- Volumen → Bauteile: nur gerade Prismen und Quader/Zylinder; verjüngte Körper, Kugel/Kegel/Torus u. a. werden mit Meldung abgelehnt; keine
  Bodenplatte, keine Innenwände ([222]).
- **Baurecht-Nachweis** ([255]): Fassadenhöhe nur über ±0.00 (Näherung); Grünfläche und aGSF nur per Eingabe; die Blatt-Tabelle übernimmt nur
  Parzellenfläche und -grenze, nicht aGSF/Grünfläche aus den Panel-Eingaben; Grenzabstand als Verstossfläche, nicht als kleinster Abstand;
  auf dem Mac nicht geprüft.
- **IFC für Fachplaner** ([259]): **nicht in Archicad, Revit, Solibri oder BIMcollab geöffnet**, nur mit ifcopenshell (0 Befunde). **IFC-Ebenen** (eine je Klasse, ohne Sichtbarkeit) **sind in Archicad/Revit nicht geöffnet**; der
  Dachraum-Körper füllt die Schräge nicht aus (Höhe = lichte Höhe); Dächer als Netz; IFC2x3 nur über die bestehenden Tests; Datei
  des Stress-Beispiels gross (19.8 MB, ca. 6 s).
- **Plandarstellung 1:100** ([256]): Fenster über der Schnitthöhe — erledigt durch [260] (symbolisch/geschnitten wählbar, Vorgabe symbolisch;
  ~~Frage M: Darstellung Fenster über Schnitt~~); auf dem Mac nicht geprüft. Hilfslinien (Achsen, Schnittlinie, Baulinie/Parzelle,
  Höhenlinien) setzen vor Masszahlen, Texten und Höhenkoten aus — Schrift hat Vorrang (SIA 400); Koten «±0.00»/«+5.70» stehen nicht mehr auf
  der Schnittlinie A-A, Höhenlinien laufen nicht mehr durch Masszahlen (15.11.). Sonnenschatten (Klasse 08) ist in den Abgabe-Vorlagen
  (Eingabe, Ausführung, «Grundriss 1:100») aus und nur in der Präsentation an. Stempel «Schlafen» im DG steht jetzt in 90 % (statt 80 %), die
  Baulinie setzt vor Masszahlen aus (15.11.); Raumstempel schrumpfen bei Platzmangel auf 90 %, statt eine Achse zu überdecken (Entscheid Maintainer 15.11.); nur im Container (CLI-SVG in Chromium) angesehen, nicht auf dem Mac.
- **Datensicherheit** ([116]): Schliessen-Rückfrage, Cmd+Q-Menüeintrag, Autosave mit zwei Ständen, atomare Exporte und «Vorige Fassung wiederherstellen …»
  sind **nicht in der Tauri-App und nicht in Electron geprüft** (nur Tests und Browser, `doc/RELEASE-1.0.md` Abschnitt 14); der Menüeintrag ist nicht
  ausgegraut (ohne Sicherung nur ein Hinweis); bei sehr grossen Projekten serialisiert die Kopie im Hauptfaden.
- **Seitenleiste** ([255], [253]): Karten-Tabellen in der schmalen Seitenleiste nur in Chromium (de/en, 303–340 px) angesehen, nicht in der Tauri-App; Namen der
  Objekt-Klassen bleiben auch im englischen UI deutsch.
- **Objektbibliothek** ([253]): nur 2D, nur abstrakte Symbole im 55er-Raster; Ziehen aus der Palette geht über Zeigerereignisse (nur im Chromium geprüft, nicht mit nativem Metal); im DXF ohne Attribute
  (Id und Parameter stehen nur im Blocknamen); Symbole nur im Chromium/CLI-SVG angesehen, nicht in der Tauri-App. Eigene Objekte [254] gibt es erst nach 1.0.
- **Tastatur** ([252], [190]): Ctrl+Tab/Ctrl+Umschalt+Tab auf dem Mac nicht geprüft (das System oder die Webview könnte die Tasten abfangen);
  Cmd+J bei Bogenwänden: die Schraffurflächen von Bogen und gerader Wand bleiben getrennt.

**Austausch**
- Alle Rundreisen (DXF, IFC) wurden nur mit Tests geprüft, **nicht mit AutoCAD, Archicad, Revit oder Acrobat** ([C9], [200], [201]). Dächer
  gehen im IFC als Netz, nicht als parametrisches Dach. 2D-Zeichnungen, Texte, Bemassungen, Schraffuren, Layouts, Gelände, Möbel und
  Blöcke gehen nicht ins IFC. Punktwolken und BCF-Themen sind nicht im Projekt gespeichert.

## Netzzugriffe und Datenschutz

Dossier arbeitet lokal: Projekte, Pläne und Modelle bleiben auf deinem Rechner und werden nicht hochgeladen. Es gibt **keine Telemetrie, keine
Nutzungsstatistik und keinen Absturzbericht** (im Code nicht vorhanden; geprüft 15.11. durch Suche in Quelltext, Rust-Crates, `package.json`,
Electron-Hauptprozess und `index.html`). Schriften und Icons werden mitgeliefert, es lädt nichts von einem CDN.

| Dienst | Wofür | Wann | Abschaltbar |
|---|---|---|---|
| swisstopo / geo.admin.ch | Adresssuche, Gebäude und Luftbild für den Kontext-Import, 3D-Gebäude und Gelände (STAC) | nur nach Klick im Dialog «Kontext importieren» (Suche, Import) | Offline-Modus |
| OpenStreetMap (Overpass) | Gebäude, Strassen, Wasser, Grün im Kontext-Import | nur nach Klick im Dialog «Kontext importieren» | Offline-Modus |
| ambientCG | Materialtexturen (CC0) | Die Materialbibliothek (Ressourcen → Komponenten) fragt beim Öffnen die Trefferliste ab, Texturen erst nach Klick auf «Textur laden» | Offline-Modus |
| Update-Server (`git.openbureau.ch`) | Suche nach neuer Version; Versionsverlauf in den Einstellungen | Tauri/macOS: **beim Start nur, wenn du es einschaltest** (Einstellungen → Update → «Beim Start nach Updates suchen», Vorgabe aus); sonst nur auf Klick («Nach Updates suchen») und beim Öffnen des Reiters «Update» (Versionsverlauf). Electron/Linux: keine Update-Prüfung | Offline-Modus (ab [262]); Start-Prüfung zusätzlich pausierbar (Einstellungen → Update) |
| KI-Zugriff (MCP-Brücke) | KI-Werkzeuge steuern Dossier | nur mit «KI-Zugriff erlauben»; lokal auf `127.0.0.1`, mit Schlüssel, nicht aus dem Netz erreichbar | Schalter «KI-Zugriff erlauben» |
| Blender | Rendern | startet das lokal installierte Blender; kein Netz. «Blender laden» öffnet nur die Webseite im Browser | – |

Der **Offline-Modus** (Einstellungen → Allgemein) sperrt alle Abrufe der Tabelle. Bereits geladene Daten bleiben nutzbar. Mit Ausnahme des Update-Servers
laufen alle Abrufe über eine Host-Liste: andere Adressen lehnt Dossier ab, die Sicherheitsrichtlinie der App (CSP) erlaubt genau diese Hosts. Beim Abruf
erfährt der jeweilige Dienst deine IP-Adresse und die abgefragte Gegend bzw. Suche (Koordinaten, Adresstext); Dossier sendet keine Projektdateien. Ist ein
Geo-Proxy konfiguriert (`VITE_GEO_PROXY`, Büro-Server), laufen swisstopo/OSM-Abrufe stattdessen über diesen.

## Offene Fragen an den Maintainer

1. ~~Versionsnummer~~ — erledigt durch [261] (15.11.): 1.0.0-beta.N, Build JJMMTT.N (Über Dossier und Statusleiste zeigen beides).
2. **Signierung/Updater — vorläufig entschieden (16.11., Koordinator nach Haltung Maintainer):** Die Betas sind nicht signiert/notarisiert; die Notes erklären
   den Gatekeeper-Weg (Rechtsklick → Öffnen). Notarisierung erst, wenn ein Apple-Entwicklerkonto da ist. **[Frage M: Apple-Entwicklerkonto vorhanden?]**
3. **Download-Ort — entschieden (16.11.):** Releases auf `git.openbureau.ch` (eigener, freier Server statt GitHub); README und Website verweisen dorthin.
4. **Lizenz — entschieden (16.11.):** AGPL-3.0-oder-später unverändert, Hinweis bleibt in den Notes.
5. **macOS-Version/Hardware:** wird aus dem Mac-Durchlauf abgeleitet (WebGPU in der Webview bestimmt die kleinste Version); bis dahin «Apple Silicon, aktuelles macOS».
6. **Linux — entschieden (16.11., Maintainer: «Linux-Prüfungen reichen»):** offiziell unterstützt (AppImage x86_64); Browser-Build nur zum Ausprobieren.
7. **Halbfertiges — entschieden (16.11.):** bleibt sichtbar, aber als «Vorschau» gekennzeichnet (Pathtracing, Rendering mit Blender, Kamerafahrt/Video, Geist-Modus); umgesetzt mit [265] (Marke «Vorschau», Tooltip «Noch nicht fertig — Ergebnisse können abweichen»).
8. **Kostenkennwerte — entschieden (16.11.):** Beispielwerte bleiben als Vorgabe, deutlich als «Beispielwerte, keine Richtwerte» markiert (wie heute).
9. **Dateiformat — entschieden (16.11.):** Betas ohne Zusage; ab 1.0.0 öffnet jede 1.x-Version alle `.obp` aus 1.x (Migration beim Öffnen).
10. **Beispielprojekt — entschieden (16.11.):** wird als fiktives Beispiel ausgeliefert und so benannt.
11. **Netzzugriffe — entschieden (16.11.):** Notes wie im Abschnitt oben; die Update-Prüfung beim Start ist **standardmässig aus** (Datenschutz zuerst, kein
    Netz ohne Zutun), einschaltbar in den Einstellungen; «Nach Updates suchen» bleibt als Knopf. Umgesetzt mit [262] (16.11.).
12. ~~Fenster über Schnitt~~ — erledigt durch [260] (15.11.): Fenster/Türen im Grundriss symbolisch (Vorgabe) oder geschnitten, je Element, Typ oder
    Modelldarstellung; „geschnitten“ zeichnet Öffnungen über/unter Schnitt hell auf schwarzer Wand ([256]).
13. ~~Klassen der Objektbibliothek~~ — erledigt: 22/23/24 bestätigt (15.11.).
14. **Gegenprobe — entschieden (16.11., Maintainer):** Linux-Prüfungen reichen für die Freigabe; der Mac-Durchlauf (`doc/RELEASE-1.0.md`) läuft nebenher, Befunde fliessen als Fehlerbehebungen ein.
