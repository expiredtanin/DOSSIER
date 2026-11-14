# Release 1.0 — Abnahme „Wettbewerb/Vorprojekt“ auf dem Mac

Checkliste zum Referenz-Ablauf aus `TODO.md` (Abschnitt „Release 1.0“, [206]). Der Maintainer spielt sie in der
Tauri-App auf dem Mac von einem leeren Projekt bis zur PDF-Abgabe durch. **Bestanden** heisst: kein Absturz, kein
Datenverlust, kein Umweg über ein anderes Programm. Jeder Befund kommt als Eintrag mit Reproduktion in `TODO.md`
unter „Release 1.0“.

Derselbe Ablauf läuft automatisch im Browser: `e2e/release10.spec.ts` (ein Test mit 13 Schritten, dazu je ein Test für
[207] Situation, [208] Plakat, [211] Rendering-Paket, [212] Pathtracer, [222]–[224]; Schritte ohne Umsetzung stehen als `test.fixme` mit TODO-ID). Starten mit eigenem Port und Bildern je Schritt:

```
E2E_PORT=5189 DOSSIER_SHOTS=shots/release10 npx playwright test e2e/release10.spec.ts
```

Die Browser-Spec prüft Modell, Tabellen und Dateien, aber keine Pixel: Headless gibt es kein echtes WebGPU, das 3D
und die Zeichenfläche sind dort nicht verlässlich. Was die Spec nicht sieht, steht unten unter „Nur auf dem Mac“.

**Status:** ✅ geht · ◐ teilweise · ❌ fehlt (mit TODO-ID). Stand 12.11.2026, Browser-Build im Linux-Container;
auf dem Mac noch nicht durchgespielt.

**Testdaten offline:** Kataster-Ausschnitt in LV95 `e2e/fixtures/kataster.dxf` (4 Parzellen 30 × 30 m mit Gebäuden,
Strassenparzelle mit Bögen, Grenzpunkte). Testgebäude: 12 × 10 m in der Parzelle oben rechts, Ecken
E 2'600'048 / N 1'200'046 und E 2'600'060 / N 1'200'056. Raumprogramm als CSV (`Raum;Fläche [m²];Anzahl;Flächenart;Gruppe`).

---

## 0. Vorbereitung

| # | Schritt in Dossier | Erwartet | Status |
|---|---|---|---|
| 0.1 | App starten, Startbildschirm „Neues Projekt“ (oder Datei → Neu, ⌘N) | leeres Projekt mit Erdgeschoss, Obergeschoss, Schnitt A, Ansicht Süd | ✅ |
| 0.2 | Datei → Speichern unter … (⇧⌘S) als `wbw-test.obp` | Datei liegt am gewählten Ort, Titel zeigt den Namen | ✅ (Browser: Download) |

## 1. Grundstück und Kontext laden

| # | Schritt in Dossier | Erwartet | Status |
|---|---|---|---|
| 1.1 | Panel **Gelände** → „⤓ DXF importieren“ (oder Datei → Importieren …) → `kataster.dxf`, Vorgaben lassen (neue Zeichnung, Landeskoordinaten) → Importieren | neue Zeichnungsebene „kataster“, Parzellen mit Nummern 1000–1003, Gebäude grau, Parzellen anklickbar mit Griffen; Projekt-Nullpunkt = Kilometerpunkt E 2'600'000 / N 1'200'000 (Standort-Bezug), Statusleiste zeigt X/Y lokal und LV95 | ✅ (Spec Schritt 1, [221]) |
| 1.2 | Gelände → „Standort importieren“ → Adresse/Koordinate, swisstopo-Gebäude, Gelände, Luftbild | Nachbarbauten als Netzkörper, Gelände, Luftbild lagerichtig zum Kataster | ◐ nur online; im Container nicht prüfbar (kein Netz) |
| 1.3 | Gelände → „Gelände erzeugen“ aus Höhenlinien (falls importiert) | Geländemodell, im Schnitt sichtbar | ◐ nicht im Ablauf der Spec |

## 2. Baurecht und Hülle

| # | Schritt in Dossier | Erwartet | Status |
|---|---|---|---|
| 2.1 | Parzellengrenze (1003, oben rechts) im Plan anklicken → Gelände → „Parzelle aus Auswahl“ | „Parzelle 900.0 m² · zulässig 484.0 m²“ (4 m Grenzabstand) | ✅ (Spec 2) |
| 2.2 | Grenzabstand je Kante, „Baulinie aus Auswahl“, Profilwinkel | zulässige Fläche passt sich an; im Grundriss gestrichelt | ✅ (Einzeltests, nicht in der Spec) |
| 2.3 | „Gesamthöhe max.“ = 12 | nach dem Volumen: „Höhe 5.72 m ≤ 12.00 m“, grüner Rahmen | ✅ (Spec 6) |
| 2.4 | „Hülle im 3D“ einschalten | zulässiger Baukörper als Hülle im 3D | ◐ nur auf dem Mac sichtbar |

## 3. Volumenstudie

| # | Schritt in Dossier | Erwartet | Status |
|---|---|---|---|
| 3.1 | Zeichnungsebenen → Erdgeschoss, „Einpassen“ (⌘0) | Statusleiste „Geschoss Erdgeschoss“, Plan zeigt Kataster und Gebäude (≈ 1:100–1:500) | ✅ (Spec 3b; vorher ≈ 1:10 Mio., [221]) |
| 3.2 | Befehl `wand` (Kürzel `w`), Punkte tippen `2600048,1200046` … zurück zum Start, Enter | 4 Aussenwände, Ecken verbunden (getippte Landeskoordinaten landen lokal bei 48/46) | ✅ (Spec 3) |
| 3.3 | Befehl `decke` (`d`), 4 Ecken, Enter | eine Decke mit Deckentyp „Geschossdecke mehrschichtig“ | ✅ (Spec 3; vorher Aussenwand-Aufbau, in [206] behoben) |
| 3.4 | Befehl `dach` (`rf`), zwei Ecken | Satteldach 30°, Vorsprung 0.4 m | ✅ (Spec 3) |
| 3.5 | Volumen als Körper (`koerper`, Form Quader), dann `koerperinbauteile` und in den Körper klicken (oder Körper wählen, dann Befehl) | Aussenwände je Geschoss (aussen bündig mit dem Körper), Decken, Flachdach auf Körper-OK, fehlende Geschosse obenauf; Meldung mit Anzahl; ⌘Z nimmt alles zurück | ✅ (Spec [222]; geneigte/Kugel-/Kegelkörper werden mit Meldung abgelehnt) |
| 3.6 | Obergeschoss: Wände kopieren (⌘5/⌘6 Geschoss wechseln) | OG mit Wänden, GF steigt | ◐ nicht in der Spec |

## 4. Raumprogramm gegen Modell

| # | Schritt in Dossier | Erwartet | Status |
|---|---|---|---|
| 4.1 | Befehl `raum` (`rm`), Klick ins Gebäude | „Raum 1“, 112.53 m² | ✅ (Spec 4) |
| 4.2 | Flächenbilanz → „Raumprogramm importieren …“ → CSV, Spalten zuordnen → Importieren | 2 Programmzeilen, Soll/Ist-Tabelle | ✅ (Spec 4) |
| 4.3 | Raum in „Atelier“ umbenennen (Objekt-Info) | Zeile „Atelier“ grün/gelb statt „fehlt“ | ◐ in der Spec nur „fehlt“ geprüft (Raum headless nicht angeklickt) |
| 4.4 | „Räume generieren“ | neues Blatt mit Raumrechtecken nach Programm | ✅ (`e2e/roomprogram.spec.ts`) |
| 4.5 | Mac: Menü „Kennzahlen und Raumprogramm …“ | Meldung mit Kennzahlen und Programmstand | ◐ nur auf dem Mac |

## 5. Grundrisse, Schnitte, Ansichten 1:200 (Vorprojekt 1:100)

| # | Schritt in Dossier | Erwartet | Status |
|---|---|---|---|
| 5.1 | Kopfleiste Massstab → 1:200, Detailgrad „grob“/„mittel“ | Strichstärken und Schraffuren für 1:200 | ✅ (Spec 7) |
| 5.2 | Befehl `sectionline`, Start/Ende quer durchs Gebäude, Enter | neue Ebene „Schnitt B“, Schnitt zeigt Wände, Decke, Dach, Koten | ✅ (Spec 8) |
| 5.3 | „Schnitt A“ / „Ansicht Süd“ aus dem leeren Projekt | zeigen das Gebäude: die Linien folgen dem Gebauten (Schnitt durch die Mitte, Ansicht davor), bis man sie verschiebt | ✅ (Spec 13 prüft die Linien, CLI-Schnitt zeigt Wände/Decke/Dach; [221]) |
| 5.4 | Befehl `viewline` für Ansichten Nord/Ost/West | je eine Ansichtsebene | ◐ geht von Hand, kein automatischer Satz → **[224]** |
| 5.5 | 1:100 mit Bemassung, Koten, Raumstempeln, Öffnungen (Vorprojekt) | abgabefähiger 1:100-Plan | ◐ Plan-Review-Runde 4 (TODO Phase 3) |

## 6. Situation 1:500 mit Schwarzplan

| # | Schritt in Dossier | Erwartet | Status |
|---|---|---|---|
| 6.1 | Ansichtsvorlage „Situation WBW“ | Gebäude schwarz, Nachbarn grau, Parzelle, Nordpfeil, Massstabsbalken | ✅ **[207]** (Spec: Füllfarben im Kern geprüft, Kataster-Gebäude aus dem DXF-Import gefüllt; Bild auf dem Mac prüfen, s. 13) |

## 7. 3D-Bilder, Axonometrie, Schatten, Rendering

| # | Schritt in Dossier | Erwartet | Status |
|---|---|---|---|
| 7.1 | Kopfleiste „Axonometrie“ | eigener Reiter „3D · Erdgeschoss“ | ✅ (Spec 9; Bild nur auf dem Mac prüfbar) |
| 7.2 | Gelände → „Schatten im 3D zeigen“, Datum 21.03./21.06./21.12., Uhrzeit | Schatten im 3D und (Haken) im Grundriss | ◐ Schalter geprüft, Bild nur auf dem Mac |
| 7.3 | 3D-Bild als PNG in Abgabeauflösung | PNG-Datei, z. B. 6000 px breit | ✓ **[223]** Befehl `bild3d` (Mac: Metal-Gegenprobe offen) |
| 7.4 | „Rendering …“ (Blender/Cycles) | PNG zurück, ins Layout einsetzbar | ◐ **[211]** Browser: Dialog erzeugt das Paket `model.glb` + `scene.json` (Spec); Lauf mit Blender nur auf dem Mac (s. 13) |

## 8. Flächen und Volumen SIA 416, Kennzahlen

| # | Schritt in Dossier | Erwartet | Status |
|---|---|---|---|
| 8.1 | Flächenbilanz → Kennzahlenleiste | GF, aGF, GV, AZ, ÜZ mit Werten; GV ≈ GF × Geschosshöhe | ✅ (Spec 5; GV war 0 m³ ohne Körper, in [206] behoben) |
| 8.2 | „Flächen- und Kennzahlen-Nachweis“ → CSV / PDF | Tabelle HNF…GF, IVHB-Ziffern (GFZ, AZ, BMZ, ÜZ), Gesamthöhe | ✅ (Spec 5) |
| 8.3 | Leiste und Tabelle vergleichen | gleiche GF/ÜZ (GF = NGF + KF = 127.7 m²) | ✅ (Spec 5, [225]) |

## 9. Kostenschätzung grob

| # | Schritt in Dossier | Erwartet | Status |
|---|---|---|---|
| 9.1 | Flächenbilanz → „Kostenschätzung grob“: Methode CHF/m³ GV, Kennwert C ändern | Tabelle B–J mit Menge, Kennwert, Betrag; Summe B–J, Honorare, Reserve, Total exkl./inkl. MwSt, Bandbreite ±15 %; Beispielwerte als solche markiert | ✅ (Spec 5b) |
| 9.2 | Methode auf CHF/m² GF umstellen | Beispielwerte der Methode, eigene Kennwerte umgerechnet (Betrag gleich) | ✅ (Spec 5b) |
| 9.3 | „CSV“ / „PDF“ in der Kostenschätzung | CSV mit Zahlen ohne Tausender-Trenner, PDF A4 quer mit Fussnoten (Preisstand, Faktoren, Herkunft) | ✅ (Spec 5b; PDF nur auf %PDF- geprüft) |
| 9.4 | Layout-Blatt → „＋ Tabelle“ → „Kostenschätzung grob (eBKP-H)“ | lebendige Tabelle auf dem Blatt, im Blatt-PDF | ✅ (Spec 10b; Bild auf dem Mac prüfen) |

## 10. Abgabe-Layouts als PDF

| # | Schritt in Dossier | Erwartet | Status |
|---|---|---|---|
| 10.1 | Panel **Mappe** → „Präsentationsplan erstellen“ (Befehl `praesentationsplan`), Schnitt B, A1 | Blatt mit Grundrissen, Ansicht, Schnitt, Nordpfeil, Massstabsbalken, gemeinsamer Massstab | ✓ geht (Spec 10) — [224] erledigt (leere Geschosse nicht vorgewählt, 1:200, Plakat als Ziel) |
| 10.2 | Mappe → Publikation → ＋ Satz, Blatt anhaken, „Publizieren“ | ein PDF (A1, 1 Seite), Index im Titelblock | ✅ (Spec 11) |
| 10.3 | Plakat A0/A1 mit Raster, Kennwort-Feld, anonym (kein Büroname, PDF-Metadaten leer), Bilder im Layout | WBW-Plakat als PDF | ✅ **[208]** (Spec `competition` und Referenz-Ablauf: Kennwort, anonymes PDF ohne Projektnamen; Aussehen auf dem Mac prüfen, s. 13) |

## 11. Austausch mit Fachplanern

| # | Schritt in Dossier | Erwartet | Status |
|---|---|---|---|
| 11.1 | Erdgeschoss aktiv → Datei → Exportieren → DXF | DXF in LV95, Layer je Kategorie; in AutoCAD/Archicad lagerichtig | ✅ Datei (Spec 12); Rundreise in Fremdsoftware offen ([C9]) |
| 11.2 | Datei → Exportieren → IFC | IFC4 mit IfcWall, IfcSlab, IfcSpace | ✅ (Spec 12) |
| 11.3 | Publikationssatz mit Ausgabe „DXF mit Layouts“ | DXF je Blatt | ◐ nicht in der Spec |

## 12. Sichern und Wiederöffnen

| # | Schritt in Dossier | Erwartet | Status |
|---|---|---|---|
| 12.1 | ⌘S, App beenden, Datei öffnen (⌘O) | alles wieder da: Volumen, Raum, Baurecht, Raumprogramm, Blatt, Publikationssatz | ✅ Inhalt der Datei (Spec 13); Wiederöffnen auf dem Mac offen ([116]) |
| 12.2 | App während der Arbeit hart beenden, neu starten | Autosave bietet Wiederherstellen an | ◐ nur auf dem Mac |

## 13. Neu seit 13.11. — Prüfschritte nur für den Mac

Diese Punkte sind im Browser nicht oder nur teilweise prüfbar (kein WebGPU/Metal, kein Blender). Bitte in der Tauri-App durchspielen
und Befunde in `TODO.md` eintragen.

| # | Schritt auf dem Mac | Erwartet |
|---|---|---|
| 13.1 | **Pathtracer:** 3D-Reiter (Axonometrie), Darstellung „Pathtracing (Vorschau)“, Kamera drehen, Sonne ändern | Bild wird nach jeder Änderung neu und körnig, dann glatter; unten links „Pathtracing: N Samples · x/s“ zählt hoch, am Ende „(fertig)“; Fenster bleibt bedienbar; andere Darstellung zurück: normales Bild |
| 13.2 | **Rendering mit Blender (Cycles):** Befehl `rendering`, Blender-Pfad, Kamera „Südost“, Start; danach „Als .blend speichern“ | Fortschritt „Sample x von y“, Abbrechen geht, Bild erscheint und lässt sich speichern bzw. ins Layout einsetzen; Berechtigungen (Temp-Ordner), Metal-GPU |
| 13.3 | **Volumen → Bauteile:** Körper `koerper` → Quader, `koerperinbauteile`, ⌘Z | Wände/Decken/Dach je Geschoss, eine Meldung, ⌘Z nimmt alles in einem Schritt zurück |
| 13.4 | **Hilfslinien/Zuschnitt (Plakat):** Mappe → Layout erstellen → Plakat A1 quer; Bild einsetzen, Zuschnitt in den Prozentfeldern, Bild verschieben | Raster-Hilfslinien nur am Bildschirm (nicht im PDF), Kopfzeile mit Kennwort-Feld, Bild-Zuschnitt und dpi-Anzeige stimmen, Rahmen bleibt im Blatt |
| 13.5 | **Kataster-Schwarzplan:** Kataster-DXF importieren, Ansicht auf „Situation WBW 1:500“ (Ressourcen → Ansichtsvorlagen → anwenden), danach „Schwarzplan 1:500“ | Eigenes Gebäude schwarz, Kataster-Gebäude und Nachbarn gefüllt (Situation grau, Schwarzplan alles schwarz), Parzelle, Nordpfeil, Massstabsbalken; Klassen 12/83/84 lassen sich ausschalten; Metal-Bild gleich wie der SVG-Export |
| 13.6 | **Anonymität aller Exporte:** Mappe → Publikation → „Anonyme Abgabe“, Kennwort `FALKE 7`; dann PDF, DXF, IFC, SVG, CSV, 3D-Bild, Rendering-Paket, STEP exportieren | In keiner Datei Projektname, Büro, Bearbeiter:in, Adresse oder Benutzername; nur „FALKE 7“; PDF-Eigenschaften (Autor, Thema, Stichwörter) leer; Dateinamen beginnen mit dem Kennwort. Gegenprobe ohne Anonymität: Name steht drin. Frei getippte Texte und Ebenennamen prüft die App nicht — von Hand durchsehen |
| 13.7 | **Tastaturkürzel-Hilfe:** Menü Hilfe → Tastaturkürzel … (Browser-Leiste und natives Menü) | Overlay mit allen Kürzeln und Befehls-Aliassen, durchsuchbar, Esc schliesst; Liste stimmt mit der tatsächlichen Belegung überein |
| 13.8 | **Vorlage Wettbewerb:** Datei → Neu aus Vorlage → Wettbewerb | Mehrfamilienhaus (3 Geschosse, Flachdach), Baurecht, Raumprogramm 30 Räume, Schnitte/Ansichten, Situation, Präsentationsplan A1; Kurzanleitung `doc/KURZANLEITUNG.md` Schritt für Schritt durchspielen |
| 13.9 | **Wände verbinden ([190]):** zwei Wände mit Lücke in L-Stellung und eine Bogenwand wählen, Cmd+J, dann ⌘Z | Ecken schliessen, Bogenwand stösst an; ein Undo-Schritt nimmt alles zurück; ohne Wirkung ein Hinweis mit Grund |
| 13.10 | **Tab ([252]):** im Plan Tab drücken; danach zwei Reiter öffnen, Ctrl+Tab und Ctrl+Umschalt+Tab | Tab fokussiert die Befehlszeile; Ctrl+Tab wechselt zyklisch vorwärts, mit Umschalt rückwärts (nicht die System-Fensterwahl) |
| 13.11 | **Objektbibliothek ([253]):** Panel „Objekte“ → WC, im Plan klicken; vor dem Klick R und M; Esstisch setzen, in der Objekt-Info Anzahl, „Unordnung“, „Neu würfeln“; Detailgrad grob/fein | Symbol am Cursor dreht/spiegelt; Stühle ändern sich, gleicher Wert = gleiche Stühle; Linien folgen dem Detailgrad; Klassen 22/23/24 vorhanden und ausschaltbar; ⌘Z je ein Schritt |
| 13.12 | **Objekte im DXF ([253]):** Erdgeschoss mit Objekten als DXF exportieren, in AutoCAD/Archicad öffnen | je Objektart ein Block `DOSSIER_…` mit Einfügungen, lagerichtig |
| 13.13 | **Baurecht-Nachweis ([255]):** Panel Gelände → Baurecht: GFZ/AZ/BMZ/ÜZ/GZ/Fassadenhöhe max. eintragen; Panel Flächenbilanz ansehen, CSV und PDF; Blatt → ＋ Tabelle → „Baurecht-Nachweis“ | Tabelle zulässig/Projekt/Reserve/erfüllt, „—“ ohne Vorgabe; PDF und Blatt-Tabelle zeigen dieselben Werte; Überschreitung ist markiert |
| 13.14 | **IFC für Fachplaner ([259]):** Vorlage Wettbewerb und Musterhaus komplex → Datei → Exportieren → IFC (IFC4, einmal mit „Kontext mitgeben“, einmal IFC2x3); Dateien in Archicad (IFC-Übersetzer „Allgemein“), Revit (Öffnen/Verknüpfen), Solibri oder BIMcollab Zoom öffnen | Geschosse EG/1.OG/2.OG mit Höhen; Wände mit Schichten und Materialnamen, Fenster/Türen in den Öffnungen, Decken, Dach, Treppen; Räume mit Nummer, Name, Fläche (= Flächenbilanz), SIA-Kategorie; Lage: Projektbasispunkt/Vermessungspunkt in LV95 (E 2 697 450 / N 1 261 800, ±0.00 = 441.30 m ü. M.), Gebäude nicht kilometerweit vom Ursprung; Kontext nur mit Option, am Grundstück; keine Möbel/Sanitär-Symbole. Befunde mit Programm und Version in `TODO.md` [259]/[C9] |
| 13.15 | **Anonymitäts-Prüfung Freitext ([208]):** Mappe → Publikation → „Anonyme Abgabe“, Kennwort setzen; einen Raum nach dem Projektnamen benennen (Objekt-Info → Name), PDF exportieren | Dialog „Anonymität“ listet Fundstelle (Raum, Name) und Begriff; „Abbrechen“ exportiert nichts; nach dem Umbenennen läuft der Export ohne Dialog, PDF und Dateiname ohne Projektnamen; „Trotzdem exportieren“ läuft weiter (Dialog bleibt bei jedem Export-Einstieg gleich: PDF, DXF, IFC, CSV, SVG) |
| 13.16 | **Referenz-Ablauf mit Objekten und Nachweis (e2e-Schritte 4b, 6b, 10c, 12b):** im Ablauf nach dem Raumprogramm WC und Esstisch setzen, nach der Baurecht-Prüfung AZ/ÜZ/Fassadenhöhe max. eintragen, Nachweis als Blatt-Tabelle aufs Plakat, vor dem PDF Ctrl+Tab zwischen zwei Reitern | Alle Schritte gehen in einem Zug; Belag unter WC/Tisch ausgespart, Plan 1:100 zeigt Symbole, Nachweis-Tabelle in Flächenbilanz und Blatt gleich |

---

## Nur auf dem Mac (Spec sieht es nicht)

- Bild der Zeichenfläche (Metal) in Grundriss, Schnitt und Layout; Bild im 3D mit Schatten und Baurechts-Hülle.
- Natives Menü (Datei → Exportieren → PDF/DXF, „Kennzahlen und Raumprogramm …“), native Speicher-/Öffnen-Dialoge.
- Standort-Import über swisstopo/geo.admin (Netz) im eigenen Fenster.
- Leistung mit grossem Kontext-Import ([214]).

## Bekannt aus dem Browser-Lauf (nicht Mac-relevant)

- Headless Chromium benennt Downloads mit Umlaut im Namen (z. B. „…-Präsentationsplan.dxf“) als „download“; der Mac speichert über den
  nativen Dialog. Die Spec exportiert den DXF deshalb aus dem Erdgeschoss.
