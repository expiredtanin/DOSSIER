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

Nicht Ziel von 1.0: Ausführungsplanung 1:50/1:20 mit Details, Varianten nebeneinander, Bibliothek per GUID, Windows-Paket.

Dossier arbeitet mit **einem** Modell: Wände, Decken, Dächer, Treppen, Fenster, Türen, Räume. Grundriss, Schnitt, Ansicht, 3D,
Mengen und Exporte werden daraus berechnet und stimmen nach jeder Änderung wieder überein.

**Plattformen**
- **macOS** (Tauri, Metal): Hauptplattform.
- **Linux** (Electron, AppImage x86_64): vorhanden, im Container geprüft, nicht auf echter Hardware. **[Frage M: offiziell unterstützt?]**
- **Browser-Build:** vorhanden (kürzere Menüleiste, Dateien laden/speichern als Download, kein natives Fenster, keine Metal-Anzeige).
- **Windows:** kein Paket in 1.0.

**Systemvoraussetzungen:** Aus dem Repo nicht ersichtlich (kleinste macOS-Version, Prozessor, Arbeitsspeicher, Grafik).
Die 3D-Anzeige braucht WebGPU bzw. Metal. **[Frage M: Systemvoraussetzungen und kleinste macOS-Version?]**
Für das Rendering mit Blender/Cycles muss Blender selbst installiert sein (eigener Prozess, nicht mitgeliefert).

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
   in der Objekt-Info; Detailstufe grob/mittel/fein; eigene Klassen 22–24 (**[Frage M: Klassennummern 23 (Sanitär) und 24 (Fahrzeuge/Freiflächen) der Objektbibliothek beibehalten oder in das Klassenschema des Büros einordnen?]**); im DXF als Block, nicht im IFC.
4. **Raumprogramm.** CSV/Tabelle importieren, Räume zeichnen, Soll/Ist-Abgleich in der Flächenbilanz; «Räume generieren» aus dem Programm.
5. **Pläne.** Grundriss je Geschoss, Schnitte und Ansichten aus Schnitt- und Ansichtslinien, SIA-400-Schraffuren und -Linientypen,
   Massstab und Detailgrad, Bemassung, Koten, Raumstempel mit wählbarer Schrift.
6. **Situation und Schwarzplan 1:500.** Ansichtsvorlagen «Situation WBW 1:500» und «Schwarzplan 1:500»: eigenes Gebäude und
   Kataster-Gebäude gefüllt, Parzelle, Nordpfeil, Massstabsbalken; alles auf Klassen, einzeln ausschaltbar.
7. **3D und Schatten.** 3D-Viewport mit Live-Schnitt, Axonometrie, Sonnenstand und Schatten (Datum/Uhrzeit), Kameras und
   Kamerafahrt, Begehen mit Kollision, 3D-Bild als PNG in Abgabeauflösung (`bild3d`). Rendering mit Blender/Cycles als Brücke;
   eingebauter Pathtracer als Vorschau.
8. **Flächen und Kennzahlen.** Flächen nach SIA 416 / IVHB (HNF … GF, GFZ, AZ, BMZ, ÜZ), Raumbuch, Flächen- und Kennzahlen-Nachweis
   als CSV und PDF; Kennzahlenleiste und Tabelle rechnen aus derselben Quelle.
9. **Kostenschätzung grob.** Kennwert-Methode je eBKP-H-Hauptgruppe B–J (CHF/m³ GV oder CHF/m² GF), Honorare, Reserve, MwSt,
   Bandbreite; CSV/PDF und als lebendige Tabelle auf dem Blatt. **Die Kennwerte sind Beispielwerte (rund 800 CHF/m³ GV bzw.
   2'600 CHF/m² GF), keine offizielle Quelle; sie sind in der Tabelle als solche markiert.**
10. **Abgabe.** Layout-Blätter mit Viewports, Legenden, Tabellen; Präsentationsplan A1 in einem Schritt; Plakat-Vorlagen A0/A1 (hoch/quer)
    mit Raster-Hilfslinien (nur am Bildschirm), Kennwort-Feld und Bild-Element mit Zuschnitt; Publikationssätze als ein PDF
    (mit PDF-Ebenen), «WBW-Abgabe» für alle Plakate.
11. **Anonyme Abgabe.** Mit «Wettbewerb (anonym)» und Kennwort zeigen Plankopf und Dateinamen nur das Kennwort. Geprüft für PDF,
    Berichte, IFC, DXF/DWG, STEP, SVG, OBJ/STL/glTF und das Blender-Paket. **Freitext-Prüfung:** Vor jedem Export (Oberfläche und Kommandozeile) sucht
    Dossier in allen Namen und Texten des Projekts nach Projektname, -nummer, Büro, Bearbeiter:in, Adresse, Dateiname, eigenen Begriffen
    («Weitere Angaben») sowie E-Mail-Adressen und Telefonnummern; der Dialog «Anonymität prüfen» nennt Bereich, Element, Feld und Begriff
    der Fundstelle. «Trotzdem exportieren» bzw. `--ignore-anonymity` übergeht ihn. Die Prüfung findet nur, was sie kennt (siehe unten).
12. **Austausch.** DXF/DWG (Geschoss, Schnitt, Ansicht; LV95), IFC4/IFC2x3 mit Wänden, Decken, Dächern, Räumen, Öffnungen, Treppen und
    Psets (inkl. `CH_Qto_SIA416`), STEP, OBJ/STL/glTF, SVG, PDF. **IFC für Fachplaner:innen:** Geometrie lokal um den Projekt-Nullpunkt,
    LV95-Lage als Georeferenz (Versatz und ±0.00 m ü. M.), Räume mit Nummer, Name, Fläche und SIA-416-Kategorie, Geschossflächen und
    Gebäudesummen; Mengen stimmen mit der Geometrie überein (mit ifcopenshell gegengeprüft, alle drei Beispielprojekte ohne Befund). Option
    «Kontext mitgeben (Gelände, Nachbargebäude)» im Export-Dialog bzw. `--kontext` (Vorgabe aus). Die Objektbibliothek (Möbel, Sanitär) wird nicht ins IFC geschrieben. Was in welche Richtung verloren geht, steht in `doc/DATEIFORMATE.md`.

**Darstellung im Plan (Stand 14.11.).** Nachbargebäude erscheinen über den Stil ihrer Klasse (Füllung einstellbar im Ebenen-Editor, in den
Standard-Situationsplänen grau); Treppen haben im Grundriss eine Bruchlinie in Papiergrösse; die Standard-Vorlagen Präsentation, Eingabe,
Ausführung, Situation und Schwarzplan blenden Kamera-Sichtkegel (Klasse 92) und Sonnenschatten (08) aus; im 1:100-Grundriss werden Fenster
über der Schnitthöhe auf der schwarzen Wand hell gezeichnet (**[Frage M: Fenster über Schnitt hell auf schwarzer Wand — als Vorgabe belassen oder
anders lösen (Schnitthöhe/Bemassung)?]**, abschaltbar: Ressourcen → Modelldarstellung). Höhenkoten messen nur das eigene Gebäude. In der schmalen
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
ältere Dateien werden beim Öffnen migriert. **[Frage M: Dateiformat-Zusage für 1.x? Beispielstände vor 1.0 sind nicht garantiert öffenbar.]**

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
- Leistung mit grossen Kontext-Importen ist nur im Container gemessen, nicht auf echter GPU ([214]).
- Linux: AppImage startet im Container; Start des Pakets selbst (FUSE) und echte Grafikkarte sind ungeprüft, Flatpak ist nicht fertig ([170]).
  Windows gibt es nicht.
- Update- und Signier-Weg (macOS signiert/notarisiert, Updater, CI) sind noch nicht lauffähig nachgewiesen ([30]).

**Grundstück, Situation**
- Echte Kataster-DXF verschiedener Kantone sind nicht geprüft; Layer-Zuordnung (Gebäude, Strassen, Gewässer) folgt gängigen Namen, rein
  numerische Layer bekommen noch keine Bezeichnung ([207]).
- Strassennamen folgen gekrümmten Achsen nicht, sie stehen nur mit der Drehung aus dem DXF ([207]).
- Standort-Import (swisstopo/OSM) braucht Netz und ist im Container nicht geprüft ([206]).
- Nachbarhäuser ausserhalb des Geländenetzes stehen auf Höhe 0 statt auf dem Gelände ([227]).

**3D, Darstellung**
- Bekannte Darstellungsfehler im 3D (Musterhaus): Formöffnungen in Bogenwänden behalten ein Rechteck-Loch; Dachmuster an Kehlen sind nicht
  beschnitten; Öffnungen, die in eine Decke hineinragen, werden nicht gekappt ([216], [234]).
- Schriftfamilien in Stempeln und Textfeldern erscheinen in SVG/PDF/DXF; im GPU-Plan ist die Mac-Variante nicht kompiliert/geprüft, und
  gedrehte Textfelder zeigen noch die Systemschrift ([226], [218]).
- Begehen: Decken-Unterseiten begrenzen den Kopf nicht; Formöffnungen zählen als volle Wand ([245]). Kamerafahrt-Video: Aufnahme unter
  Tauri/WKWebView nicht geprüft, Bildinhalt nicht gesehen ([246]).
- **Pathtracing ist eine Vorschau** (progressiv, höchstens 1024 Samples, vereinfachte Materialien) und auf dem Mac nicht geprüft ([212]).
  Unter der Software-GPU (SwiftShader) des Test-Containers brach der erste Pathtrace-Lauf mit einem Fehler ab; auf echter GPU nicht geprüft.
- **Rendering mit Blender/Cycles**: Lauf mit installiertem Blender nur im Container (bpy 5.3, CPU) geprüft; Mac, Metal-GPU und
  Blender 3.6/4.x offen ([211], [229], [228]). Ohne Blender gibt es nur einen Hinweis.

**Pläne und Abgabe**
- **1:100-Pläne in Abgabequalität** (Bemassung, Koten, Raumstempel, Öffnungen nach Detailgrad) sind noch nicht abgeschlossen (Phase 3, Plan-Review
  nach [199]).
- Ansichten Nord/Ost/West entstehen von Hand mit `viewline`; der Präsentationsplan nimmt nur vorhandene Ansichten ([224]).
- **Anonymität** ([208]): Die Freitext-Prüfung findet nur Begriffe, die Dossier kennt (Projektangaben und die Liste «Weitere Angaben»); Wörter ohne
  Bezug dazu, Wörter unter 5 Zeichen (Einzelwort), allgemeine Wörter und blosse Zahlen nicht. Vor der Abgabe trotzdem von Hand durchsehen.
  `dossier-cli convert` und BCF-Export prüfen nicht. Programmkonventionelle Namen wie `Dossier_Qto_…` im IFC bleiben. Der Dialog-Weg ist nur
  per Code-Abgleich geprüft, nicht in der Tauri-App.
- Plakat: Hilfslinien gehören zum Masterlayout, nicht zum Blatt; kein Fang für Legenden; Bilder werden als Data-URL im Projekt gespeichert
  (Dateigrösse und Verlauf wachsen bei grossen Bildern); Bild erscheint nicht in DXF/IFC ([208]).
- Kostenschätzung: Kennwerte sind Beispielwerte; keine Varianten nebeneinander, keine Kennwerte aus Büro- oder CRB-Quelle ([209]).
- Volumen → Bauteile: nur gerade Prismen und Quader/Zylinder; verjüngte Körper, Kugel/Kegel/Torus u. a. werden mit Meldung abgelehnt; keine
  Bodenplatte, keine Innenwände ([222]).
- **Baurecht-Nachweis** ([255]): Fassadenhöhe nur über ±0.00 (Näherung); Grünfläche und aGSF nur per Eingabe; die Blatt-Tabelle übernimmt nur
  Parzellenfläche und -grenze, nicht aGSF/Grünfläche aus den Panel-Eingaben; Grenzabstand als Verstossfläche, nicht als kleinster Abstand;
  auf dem Mac nicht geprüft.
- **IFC für Fachplaner** ([259]): **nicht in Archicad, Revit, Solibri oder BIMcollab geöffnet**, nur mit ifcopenshell (0 Befunde). Raumhöhe = Geschosshöhe
  statt lichter Höhe; keine IFC-Ebenenzuweisung (Ebenen nur als Klassifikation); Dächer als Netz; IFC2x3 nur über die bestehenden Tests; Datei
  des Stress-Beispiels gross (19.8 MB, ca. 6 s).
- **Plandarstellung 1:100** ([256]): Fenster über der Schnitthöhe hell auf schwarzer Wand wartet auf den Entscheid des Maintainers
  (**[Frage M: Darstellung Fenster über Schnitt — hell auf schwarz (jetzt Vorgabe, abschaltbar) oder Schnitthöhe/Bemassung ändern?]**). Offen: Sonnenschatten
  im 1:100-Grundriss, Stempel «Schlafen» im DG auf 80 %, Höhenlinien-Koten auf Masszahlen; nur im Container (CLI-SVG in Chromium) angesehen, nicht auf dem Mac.
- **Datensicherheit** ([116]): Schliessen-Rückfrage, Cmd+Q-Menüeintrag, Autosave mit zwei Ständen, atomare Exporte und «Vorige Fassung wiederherstellen …»
  sind **nicht in der Tauri-App und nicht in Electron geprüft** (nur Tests und Browser, `doc/RELEASE-1.0.md` Abschnitt 14); der Menüeintrag ist nicht
  ausgegraut (ohne Sicherung nur ein Hinweis); bei sehr grossen Projekten serialisiert die Kopie im Hauptfaden.
- **Seitenleiste** ([255], [253]): Karten-Tabellen in der schmalen Seitenleiste nur in Chromium (de/en, 303–340 px) angesehen, nicht in der Tauri-App; Namen der
  Objekt-Klassen bleiben auch im englischen UI deutsch.
- **Objektbibliothek** ([253]): nur 2D, nur abstrakte Symbole im 55er-Raster; kein Ziehen aus der Palette (nur Klick); im DXF ohne Attribute
  (Id und Parameter stehen nur im Blocknamen); Symbole nur im Chromium/CLI-SVG angesehen, nicht in der Tauri-App. Eigene Objekte [254] gibt es erst nach 1.0.
- **Tastatur** ([252], [190]): Ctrl+Tab/Ctrl+Umschalt+Tab auf dem Mac nicht geprüft (das System oder die Webview könnte die Tasten abfangen);
  Cmd+J bei Bogenwänden: die Schraffurflächen von Bogen und gerader Wand bleiben getrennt.

**Austausch**
- Alle Rundreisen (DXF, IFC) wurden nur mit Tests geprüft, **nicht mit AutoCAD, Archicad, Revit oder Acrobat** ([C9], [200], [201]). Dächer
  gehen im IFC als Netz, nicht als parametrisches Dach. 2D-Zeichnungen, Texte, Bemassungen, Schraffuren, Layouts, Gelände, Möbel und
  Blöcke gehen nicht ins IFC. Punktwolken und BCF-Themen sind nicht im Projekt gespeichert.

## Offene Fragen an den Maintainer

1. **[Frage M: Versionsnummer]** Der Stand im Repo ist `0.1.0` (`package.json`, `tauri.conf.json`); [30] nennt als Ziel «1.0.0-beta», der Release-Abschnitt «1.0.0».
   Was steht auf dem Paket? Datum: Ziel 12.12.2026?
2. **[Frage M: Signierung/Notarisierung/Updater]** Wird die Mac-App signiert und notarisiert, und läuft der Updater (Endpunkt zeigt auf `git.openbureau.ch`)? Sonst gehört ein
   Hinweis zu Gatekeeper in die Notes.
3. **[Frage M: Download-Ort]** Wo liegen die Pakete (Download-Seite, git.openbureau.ch, GitHub)? Die README sagt «Fertige Installer gibt es noch nicht».
4. **[Frage M: Lizenz]** Gilt AGPL-3.0-oder-später für die ausgelieferte App unverändert? Soll der Lizenzhinweis in den Notes bleiben?
5. **[Frage M: Unterstützte macOS-Version und Hardware]** Kleinste macOS-Version, Apple Silicon und/oder Intel (Ziel [30] «universal»), Mindest-RAM?
6. **[Frage M: Linux]** Ist Linux (Electron, AppImage) offiziell unterstützt oder «auf eigene Gefahr»? Browser-Build: nur zum Ausprobieren?
7. **[Frage M: Halbfertiges sichtbar lassen?]** Bleiben in 1.0 sichtbar: Pathtracing-Vorschau ([212]), Rendering mit Blender ([211]), Kamerafahrt/Video ([246]), Begehen
   mit Geist-Modus ([245])? Als «Vorschau/Beta» kennzeichnen oder ausblenden?
8. **[Frage M: Kostenkennwerte]** Bleiben die Beispielwerte als Vorgabe, oder sollen sie leer starten, damit niemand sie als Richtwert missversteht?
9. **[Frage M: Dateiformat]** Verspricht 1.0 das Öffnen von `.obp` aus 1.x? CLAUDE.md sagt, es gebe keine produktiven Projekte und keine Migrationspflicht;
   Anwender:innen müssten das in den Notes lesen.
10. **[Frage M: Beispielprojekt]** Das Beispielprojekt «Wettbewerb» ist fiktiv (Winterthur): als Beispiel ausliefern und so nennen?
11. **[Frage M: Netzzugriffe und Datenschutz]** Welche Netzzugriffe nennen die Notes (swisstopo/geo.admin, OSM; Offline-Modus in `src/net`)? Gibt es Telemetrie
    (aus dem Repo nicht ersichtlich)?
12. **[Frage M: Fenster über Schnitt]** ([256]) Fenster über der Schnitthöhe im 1:100-Grundriss hell auf der schwarzen Wand zeigen (Vorgabe jetzt, abschaltbar in der
    Modelldarstellung) oder Schnitthöhe/Bemassung anpassen?
13. **[Frage M: Klassen der Objektbibliothek]** ([253]) Klassennummern 23 (Sanitär) und 24 (Fahrzeuge und Freiflächen) beibehalten?
14. **[Frage M: Gegenprobe vor Release]** Bis wann ist der Mac-Durchlauf ([206], `doc/RELEASE-1.0.md`) fertig? Ergebnisse ändern die Liste der Einschränkungen oben.
