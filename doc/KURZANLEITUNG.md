# Erster Wettbewerb mit Dossier

Kurzanleitung für die Version 1.0 „Wettbewerb & Vorprojekt“. Sie folgt dem Referenz-Ablauf aus `TODO.md` und
`doc/RELEASE-1.0.md` vom leeren Projekt bis zur Abgabe: Kataster laden, Baurecht prüfen, Volumen bauen, Räume gegen das
Raumprogramm halten, Kennzahlen nach SIA 416 lesen, Pläne 1:200 und Schnitt ableiten, Axonometrie und Schatten
ansehen, den Präsentationsplan auf A1 legen und PDF, DXF und IFC ausgeben.

**Zum Mitlesen:** Das Beispielprojekt **Wettbewerb** hat alle Schritte schon gemacht. Öffnen über
*Datei → Neu aus Vorlage → Wettbewerb* (Browser-Menü: „Neu aus Vorlage: Wettbewerb“). Es ist ein Mehrfamilienhaus mit
6 Wohnungen auf einer fiktiven Parzelle in Winterthur (LV95), 3 Geschosse, Flachdach, 30 Räume mit Raumprogramm,
Schnitte A-A und B-B, Ansichten, Situation 1:500 und ein Präsentationsplan A1. Auf der Kommandozeile:
`node dist-cli/dossier-cli.mjs :wettbewerb kennzahlen`.

Die Menüpfade gelten für die macOS-App (Hauptplattform). Im Browser-Build steht eine kürzere Menüleiste oben („Datei“,
„Bearbeiten“, „Ansicht“, „Fenster“, „Hilfe“); sie heisst dort teils anders (Datei: „Neues Projekt“, „Projekt speichern“,
„Neu aus Vorlage: Wettbewerb“, „Exportieren: DXF“). Es fehlen *Bearbeiten → Kennzahlen und Raumprogramm …* (stattdessen
das Panel **Flächenbilanz**) und *Fenster → Standort importieren* (stattdessen die Schaltfläche **Standort importieren**
im Panel **Gelände**). Alle Tastenkürzel zeigt *Hilfe → Tastaturkürzel …*; dort stehen auch die Kürzel für die
Befehlszeile.

> **Stand der Bilder:** Sie stammen aus dem Linux-Container (CLI-Ausgabe, mit Schraffur, als SVG im Chromium
> aufgenommen). 3D-Bilder fehlen, weil es dort kein WebGPU/Metal gibt. Die Mac-Ansicht (Metal) kann in Strichstärke
> und Schriftbild abweichen.

---

## 0. Befehle eingeben

Dossier hat unten eine **Befehlszeile**. Befehlsnamen oder Kürzel tippen, Enter. Danach fragt die Zeile nach Punkten:
Klick in den Plan oder Koordinaten tippen (`x,y`; relativ mit `r5,3`), Enter beendet den Befehl, Esc bricht ab.
Wichtige Kürzel: `w` (`wand`) Wand · `d` (`decke`) Decke · `rf` (`dach`) Dach · `rm` (`raum`) Raum ·
`schnittlinie` (`sectionline`) Schnitt · `ansichtslinie` (`viewline`) Ansicht ·
`praesentation` Präsentationsplan · `bild3d` 3D-Bild. Eigene Kürzel: *Einstellungen → Tastenkürzel*.

Die Tab-Taste springt immer in die Befehlszeile. Zwischen den Ansichts-Reitern (Grundriss, Schnitt, 3D …) wechselst du mit
Ctrl+Tab (vorwärts) und Ctrl+Umschalt+Tab (rückwärts), auch auf dem Mac mit der Ctrl-Taste. In Dialogen bleibt Tab bei
deren Feldern.

## 1. Leeres Projekt

*Datei → Neu* (⌘N; im Browser „Neues Projekt“). Das neue Projekt hat Erdgeschoss, Obergeschoss, Schnitt A und Ansicht Süd. Gleich speichern:
*Datei → Speichern unter …* (⇧⌘S), z. B. `wettbewerb.obp`. Danach genügt ⌘S.

## 2. Kataster-DXF laden (LV95)

*Datei → Importieren …* (im Browser „DXF/DWG importieren…“) und die Kataster-Datei wählen. Im Dialog die Vorgaben lassen
(neue Zeichnungsebene, Landeskoordinaten) und **Importieren**. Der Projekt-Nullpunkt liegt dann auf einem runden
LV95-Punkt; die Statusleiste zeigt lokale und LV95-Koordinaten. Parzellen und Gebäude liegen auf der neuen
Zeichnungsebene (Panel **Zeichnungsebenen**). Mit „Auf Plan einpassen“ (⌘0, „Alles einpassen“) siehst du alles.

Online lädt *Fenster → Standort importieren* (Browser: Panel **Gelände**) Gebäude, Gelände und Luftbild von swisstopo. Das ist im Container nicht
geprüft.

## 3. Baurecht

1. Parzellengrenze im Plan anklicken.
2. Panel **Gelände** → Abschnitt „Baurecht der Parzelle“ → **Parzelle aus Auswahl**. Es erscheint z. B.
   „Parzelle 880 m² · zulässig …“.
3. **Grenzabstand** setzen, bei Bedarf je Kante, **Baulinie aus Auswahl** für die Strassenseite.
4. **Gesamthöhe max.** eintragen, optional **Profilwinkel** und **Vorsprünge bis**. Mit „Hülle im 3D“ zeigt Dossier die
   zulässige Hülle durchscheinend; Verstösse sind rot.

Die Prüfung steht darunter („Gebäude innerhalb der zulässigen Fläche“, „Höhe 9.50 m ≤ 12.00 m“). Im Beispiel:
Abstände 4/4/5/4 m, 12 m Gesamthöhe, Parzelle 880 m².

## 4. Volumen: Wände, Decke, Dach

Zuerst das Geschoss wählen (Panel **Zeichnungsebenen**, „Erdgeschoss“; ⌘5/⌘6 wechseln das Geschoss).

- **Wände:** `w`, Ecken klicken oder als LV95 tippen, mit dem Startpunkt schliessen, Enter.
- **Decke:** `d`, die vier Ecken, Enter. Die Decke bekommt den Deckentyp des Projekts.
- **Dach:** `rf`, zwei Ecken; vorgegeben ist ein Satteldach. Die Dachform lässt sich schon in der
  Befehlszeile wählen („Flachdach“ unter den Optionen). Nachträglich: Dach wählen, Panel **Objekt-Info** → Abschnitt „Dach“
  → **Dachform** „Flachdach“; dann erscheint **Attika Höhe (m)** (0 = keine Attika), wie im Beispiel. Die Dachform ist ein
  Auswahlfeld, kein Schalter.
- **Wände verbinden:** Zwei oder mehr Wände wählen, Cmd+J (Windows/Linux: Ctrl+J). Dossier schliesst Ecken (L-Stoss) und
  T-Stösse, auch bei Bogenwänden (Erker). Liegen die Enden zu weit auseinander, nennt ein Hinweis den Grund.
- Obergeschosse: Wände wählen, ⌘C, mit ⌘6 („Geschoss höher“) das Geschoss wechseln, ⌘V: Die Kopie liegt auf dem aktiven
  Geschoss an denselben Koordinaten. (⌘D „Duplizieren“ legt dagegen eine Kopie mit Versatz von 0.5 m auf demselben
  Geschoss an, nicht auf einem anderen.)

**Volumen → Bauteile:** Hast du die Volumenstudie als freien Körper gezeichnet (`koerper`, senkrechter Quader, Zylinder
oder Prisma), wandelt der Befehl `solidtoparts` („Körper in Bauteile umwandeln“, auch `koerperinbauteile`; im Panel
**Werkzeuge** in der Gruppe 3D neben „Körper verschneiden“) ihn um: Körper wählen (oder in ihn klicken), und es entstehen je
Geschoss Aussenwände, Decken zwischen den Geschossen und ein Flachdach; fehlende Geschosse legt Dossier obenauf an, der
Körper entfällt. Alles ist ein Undo-Schritt. Was nicht geht (verjüngte oder geneigte Körper, Kugel, Kegel, Verschneidungen,
Unterkante zwischen zwei Geschossen), lehnt der Befehl mit einer Meldung ab.

**Möbel und Sanitär: Objekte.** Das Panel **Objekte** (neben den Werkzeugen) enthält die 2D-Objektbibliothek: Sanitär, Küche,
Tische, Sitzen, Schlafen, Schränke, Aussenraum (Auto mit Parkfeld, Velo, Rollstuhl-Wendekreis). Objekt wählen, im Plan den
Einfügepunkt klicken (Befehl `libobj`); vor dem Klick dreht R das Objekt, M spiegelt es. Die Vorschau hängt am Cursor.
Ziehen aus der Palette gibt es nicht. Ein gesetztes Objekt wählst du an und änderst es im Panel **Objekt-Info** (Abschnitt
„Objekt“): **Breite**, **Tiefe**, **Anzahl** und weitere Parameter; bei Esstischen mit Stühlen regelt
**Unordnung**, wie schief die Stühle stehen, **Neu würfeln** zieht eine neue Anordnung (gleiche Zahl = gleiche Stühle). Die Zeichnung
folgt dem Detailgrad der Ansicht (grob, mittel, fein). Möbel liegen auf der Klasse 22, Sanitär auf 23, Fahrzeuge und
Freiflächen auf 24 und lassen sich dort ausschalten; Möbel und Sanitär sparen den Bodenbelag aus. Im DXF-Export wird jedes
Objekt als Block mit Einfügung ausgegeben. Die Objekte sind nur 2D; im 3D und im IFC erscheinen sie nicht.

## 5. Räume und Raumprogramm

1. `rm`, ins Gebäude klicken: Dossier erkennt den Raum aus den Wänden. Name und Nummer im Panel **Objekt-Info**
   setzen.
2. Panel **Flächenbilanz** → **Raumprogramm importieren …**: CSV mit den Spalten
   `Raum;Fläche [m²];Anzahl;Flächenart;Gruppe` wählen, Spalten zuordnen, **Importieren**. Das Programm erscheint als
   Soll/Ist-Tabelle (grün = erfüllt, gelb = Abweichung, „fehlt“ = noch kein Raum).
3. **Räume generieren** legt aus dem Programm ein Blatt mit Raumrechtecken an, um das Programm zu schieben.

Im Beispiel sind alle 7 Programmzeilen erfüllt (Toleranz 10 %).

## 6. Flächen und Kennzahlen SIA 416

Das Panel **Flächenbilanz** zeigt die Kennzahlenleiste: GF, aGF, GV, AZ, ÜZ. Darunter der „Flächen- und
Kennzahlen-Nachweis“ (HNF, NNF, VF, FF, KF; IVHB-Ziffern) mit **CSV** und **PDF**. Das Menü
*Bearbeiten → Kennzahlen und Raumprogramm …* gibt dasselbe als Meldung. Beispielwerte aus dem Projekt „Wettbewerb“:
GF 745 m², GV 2’234 m³, AZ 0.75, ÜZ 0.28.

**Baurecht-Nachweis.** Die zulässigen Ziffern trägst du im Panel **Gelände** unter „Baurecht der Parzelle“ ein: **GFZ max.**,
**AZ max.**, **BMZ max.**, **ÜZ max.**, **GZ min.** und **Fassadenhöhe max.** (zusätzlich zu „Gesamthöhe max.“); leer heisst
keine Vorgabe. Im Panel **Flächenbilanz** steht darunter die Tabelle „Nachweis gegen das Baurecht“: je Zeile zulässig, Projekt,
Reserve oder Überschreitung und erfüllt; fehlt die Vorgabe, steht „—“. Darunter die „Grundlagen des Nachweises“. Die Tabelle
geht mit **CSV** und **PDF** hinaus und lässt sich als Blatt-Tabelle („Baurecht-Nachweis (AZ, ÜZ, Höhen)“) auf ein Layout legen.
Auf der Kommandozeile: `node dist-cli/dossier-cli.mjs :wettbewerb kennzahlen --nachweis`. Die Fassadenhöhe misst Dossier
über ±0.00 (Näherung), die Grünfläche gilt nur, wenn du sie eingibst. Die **Kostenschätzung grob** (eBKP-H, CHF/m³ GV oder CHF/m² GF) steht im
selben Panel und lässt sich als Tabelle auf ein Blatt legen.

## 7. Pläne 1:200

In der Kopfleiste den **Massstab** wählen (Papier-Massstab 1:N anwenden), z. B. 1:200 für den Wettbewerb und 1:100
für das Vorprojekt. Der Detailgrad („grob“, „mittel“, „fein“) passt Strichstärken und Schraffuren an.

![Erdgeschoss 1:200](kurzanleitung/eg.png)

![1. Obergeschoss 1:200](kurzanleitung/og1.png)

Die Situation 1:500 mit Schwarzplan kommt aus der Standard-Ansichtsvorlage „Situation WBW“ (Gebäude schwarz,
Nachbarn grau, Parzelle, Nordpfeil, Massstabsbalken):

![Situation 1:500](kurzanleitung/situation.png)

## 8. Schnitt und Ansicht

`schnittlinie`, Start- und Endpunkt quer durchs Gebäude, Enter: Es entsteht eine neue Ebene „Schnitt B“ in der
Liste der Zeichnungsebenen; anklicken zeigt den Schnitt mit Wänden, Decken, Dach und Koten. „Schnitt A“ und „Ansicht
Süd“ aus dem leeren Projekt folgen dem Gebauten, bis du ihre Linien verschiebst. Weitere Ansichten mit
`ansichtslinie` (Nord, Ost, West).

![Schnitt A-A 1:200](kurzanleitung/schnitt.png)

![Ansicht Süd 1:200](kurzanleitung/ansicht.png)

**Grundriss 1:100: Fenster über der Schnitthöhe.** Öffnungen, die ganz über oder unter der Schnitthöhe in einer Wand liegen
(z. B. ein Rundfenster in 1.8 m), bleiben strichpunktiert; der Teil auf der schwarz gefüllten Wand wird hell gezeichnet
(Bildschirm, SVG, PDF und DXF). Abschalten: *Fenster → Ressourcen*, Reiter „Modelldarstellung“, Option „Öffnungen über/unter
Schnitt hell auf schwarzer Wand“. Treppen zeigen im Grundriss die Bruchlinie über die Laufbreite in Papiergrösse. Die Höhenkoten
im Schnitt und in der Ansicht messen nur das eigene Gebäude, nicht höhere Nachbarn. Das Gesamtbild des 1:100-Plans ist noch nicht
abgeschlossen (Plan-Review läuft).

## 9. Axonometrie und Schatten

Kopfleiste **Axonometrie** öffnet einen Reiter „3D · Erdgeschoss“. Im Panel **Gelände** schaltest du **Schatten im
3D zeigen** ein (auch „Schatten im Grundriss zeigen“) und wählst Datum (Tagundnachtgleiche, Sommer-, Wintersonnenwende)
und Uhrzeit. Mit **Begehen** (Umschalt+F, Knopf in der 3D-Werkzeugleiste „Navigation“) gehst du in Augenhöhe durchs Modell: W/A/S/D
oder Pfeile gehen, Q/E runter und hoch, Umschalt schneller, Alt langsamer, mit gedrückter Maustaste umschauen. Die
aktuelle Ansicht legst du als Kamera ab („Kamera aus aktueller Ansicht anlegen“, Gruppe **Kameras** im Panel
**Ausschnitte**) und öffnest sie später wieder. Ein 3D-Bild in Abgabeauflösung (z. B. A3 bei 300 dpi) erzeugt *Ansicht → 3D-Bild exportieren …* (Befehl
`bild3d`); es lässt sich speichern oder ins Layout einsetzen.

**Begehen mit Kollision.** Beim Begehen hält dich das Modell auf: Wände und Fensterglas sperren, du gleitest an ihnen
entlang. Türöffnungen sind frei. Treppen, Stufen und Kanten steigst du mit (bis 25 cm ohne Hindernis), der Boden folgt
Decken, Gelände und Dächern. Die Taste G oder der Knopf „Geist (Wände durchlaufen)“ schaltet die Kollision aus und
wieder ein; im Geist-Modus gehst du durch Wände und Böden. Esc beendet das Begehen.

**Kamerafahrt.** Hast du mindestens zwei Kameras, fährt der Knopf **Kamerafahrt** (Gruppe **Kameras** im Panel
**Ausschnitte**) im 3D-Viewport in Listenreihenfolge durch alle Kameras; die Kameras selbst bleiben unverändert. Esc oder
ein Klick bricht die Fahrt ab. **Video …** öffnet den Dialog „Kamerafahrt“: „Dauer je Abschnitt (s)“ (0,5 bis 60 Sekunden;
die Gesamtdauer steht darunter), „Fahrt“ als „Flüssig (Spline durch alle Kameras)“ oder „Geglättet (sanfter Halt an jeder
Kamera)“ und das „Format“ (WebM, MP4 nur, wenn die Grafikumgebung es aufnehmen kann). Die Auflösung ist die Grösse des
3D-Viewports. **Aufnehmen** zeichnet die Fahrt auf, danach „Video speichern …“ oder „Neu aufnehmen“; „Abspielen“ fährt ohne
Aufnahme, „Abbrechen“ stoppt. Im Stil Pathtracing zeigt die Fahrt nur Vorschau-Qualität.

*Hier fehlen die Bilder: Das 3D läuft nur mit WebGPU (Browser) oder Metal (Mac), nicht im Linux-Container.*

**Pathtracing-Vorschau:** In der Oberleiste öffnet **Darstellung** das Menü der Darstellungsarten, gegliedert in
„Linien“ (Drahtgitter, Kanten, Nur Konturen), „Flächen“ (Schattiert, Schattiert mit Kanten, Texturiert, Weiss) und
„Rendern“. Dort, als einziger Eintrag der Gruppe „Rendern“, steht „Pathtracing (Vorschau)“. Der
Viewport rechnet dann Bild für Bild weiter und wird sauberer; ein Zähler „Pathtracing: n Samples · x/s“ läuft, bis
„(fertig)“ dasteht. Die Sonne der Sonnenstudie liefert Licht und Himmel; steht sie unter dem Horizont, wird es Nacht, und
in den Räumen brennt ein Raumlicht (unten links abschaltbar). Die Belichtung stellt Dossier selbst ein („Auto“); unten links
im 3D gibt es dazu einen Regler von −3 bis +3 Blenden. Steht die Kamera im Raum, holt Dossier das Tageslicht gezielt durch
die Fenster. Materialien und Bildkarten
folgen den Baustoffen der Bauteile. Für die Abgabe: *Ansicht → 3D-Bild exportieren …* mit **Samples je Pixel
(Pathtracing)**; das Bild rechnet mit Fortschrittsanzeige und lässt sich abbrechen. Mehr Samples = weniger Rauschen, dafür
längere Rechenzeit. Es bleibt eine Vorschau; Endbilder gehen über das Rendering mit Blender.

## 10. Präsentationsplan

Panel **Mappe** → **Präsentationsplan erstellen** (oder Befehl `praesentation`). Im Dialog Geschosse, Ansichten und den
Schnitt wählen, Papier **A1**, Massstab 1:200 (Vorgabe) und **Erstellen**. Dossier ordnet alles im gemeinsamen
Massstab, mit Titeln, Nordpfeil, Massstabsbalken und Schriftfeld. Das Beispiel enthält so ein Blatt (3 Grundrisse,
4 Ansichten, Schnitt A-A). Die Ausschnitte folgen der Vorlage „Präsentation“.

## 11. Abgabe: PDF, DXF, IFC

- **PDF:** Panel **Mappe** → **Publikationssatz anlegen**, die Blätter anhaken, **Publizieren**. Es entsteht ein PDF
  (mit PDF-Ebenen je Kategorie, wenn eingeschaltet), Index im Titelblock und im Dateinamen.
- **DXF:** Geschoss wählen, *Datei → Exportieren → DXF* (Browser: „Exportieren: DXF“). LV95, Layer je Kategorie.
- **IFC:** *Datei → Exportieren → IFC* (IFC4 mit Wänden, Decken, Räumen). Für Fachplaner:innen liegt die Geometrie lokal
  um den Projekt-Nullpunkt; die LV95-Lage steht als Georeferenz in der Datei (Versatz des Ursprungs, ±0.00 in m ü. M.).
  Räume tragen Nummer, Name, Fläche und die SIA-416-Kategorie, das Geschoss die Flächen und Rauminhalte. Die Option
  „Kontext mitgeben (Gelände, Nachbargebäude)“ im Export-Dialog (Vorgabe aus; Kommandozeile `--kontext`) legt das Gelände und
  die Kontext-Netze am Grundstück mit ab. Die Objektbibliothek (Möbel, Sanitär) kommt nicht ins IFC. Nicht in Archicad
  oder Revit geöffnet.

**Plakat: Hilfslinien und Bild-Zuschnitt.** Im Panel **Mappe** ein Layout anlegen, im Dialog „Neues Layout“ die
**Plakat-Vorlage (Wettbewerb)** wählen (A0/A1, hoch oder quer): Dossier legt ein Raster aus Hilfslinien, eine Kopfzeile mit
Kennwort-Feld und „Plan x/n“ sowie den Massstab unter jeden Viewport. Eigene **Hilfslinien** ziehst du aus dem Lineal auf
das Blatt (Doppelklick auf eine Linie löscht sie; das Panel „Hilfslinien“ hat Zahlenfelder). Sie gehören zum Masterlayout,
gelten für alle Blätter dieses Masters und erscheinen nur am Bildschirm, nicht im PDF. Beim Ziehen rasten Kanten und
Mitten ein (8 Pixel; **Alt** hält den Fang aus). Ein **Bild** (PNG/JPEG) setzt der Knopf „Bild“ auf das Blatt, oder im
3D-Bild-Dialog „Ins Layout einsetzen“. Verschieben, an der Ecke skalieren (Seitenverhältnis bleibt); **Zuschneiden**
(Knopf) zeigt Griffe am Ausschnitt, die Felder Links/Rechts/Oben/Unten geben den Zuschnitt, „Zuschnitt aufheben“ stellt
das Original wieder her. Unter 100 dpi warnt das Bild-HUD („niedrige Auflösung“).

**Anonyme Abgabe.** Im Panel **Mappe**, Abschnitt Publikation, „Wettbewerb (anonym)“ einschalten und das **Kennwort**
eintragen. Dann zeigen Plankopf und Dateinamen nur das Kennwort, und diese Ausgaben enthalten keinen Projekt-, Büro- oder
Bearbeiternamen: PDF (Titel = Kennwort; Autor, Programm und Datum neutral), Berichte (Fläche, Raumbuch, Kosten, Öffnungen,
Bauteile, Programm), IFC, DXF/DWG (Blattnamen „Blatt n“), STEP und das Rendering-Paket für Blender. „WBW-Abgabe anlegen“
fasst alle Plakate in einen Publikationssatz. Vor jedem Export einer anonymen Abgabe (PDF, SVG, DXF, IFC,
CSV, Berichte, 3D-Bild, Rendering, Video, Publikationssatz) prüft Dossier auch den Freitext: Raum-, Geschoss-, Ebenen-,
Block-, Layout- und Blattnamen, Textobjekte und Bild-Dateinamen. Gesucht werden Projektname und -nummer, Büro, Bearbeiter:in,
Adresse, der Projekt-Dateiname, die Begriffe aus „Weitere Angaben, die nicht vorkommen dürfen“ (Panel **Mappe**, neben dem
Kennwort) sowie E-Mail-Adressen und Telefonnummern. Bei Treffern öffnet sich der Dialog „Anonymität prüfen“: Er nennt je
Fundstelle den Bereich, das Element mit Feld (z. B. Material Wärmedämmung · Name), den Text und den Begriff. „Abbrechen“
exportiert nichts; erst umbenennen und neu exportieren, oder „Trotzdem exportieren“. Allgemeine Wörter wie Haus oder Wohnen
und blosse Zahlen zählen nicht. Auf der Kommandozeile bricht ein Export bei Treffern mit Exit-Code 3 ab; `--ignore-anonymity`
übergeht die Prüfung. Die Prüfung ersetzt die Durchsicht vor der Abgabe nicht, `dossier-cli convert` und der BCF-Export
prüfen nicht.

**Kataster-Schwarzplan.** Nach dem Kataster-Import (Schritt 2) stellst du die Ansicht auf die Ansichtsvorlage „Situation
WBW 1:500“ oder „Schwarzplan 1:500“ (*Fenster → Ressourcen*, Ansichtsvorlagen). Das eigene Gebäude erscheint als gefüllter
Umriss über alle Geschosse, die Kataster-Gebäude und Nachbarn als gefüllte Grundfläche (Situation: grau, Schwarzplan: alles
schwarz), dazu Parzelle, Strassen, Höhenlinien, Nordpfeil und Massstabsbalken. Die Füllung der Nachbargebäude kommt aus dem Stil
ihrer Klasse: Im Ebenen-Editor (Ebene anklicken) stellst du die „Füllung“ der Klasse ein; Höhenlinien enden am gefüllten
Nachbarn. Raster, Wände, Möbel, Text, Masse und
Schnittmarken sind aus. Kamera-Sichtkegel (Klasse 92) und Sonnenschatten (08) sind in den Standard-Vorlagen Präsentation,
Eingabe, Ausführung, Situation und Schwarzplan ausgeschaltet. Alle Teile liegen auf Klassen (83 Situation Gebäude, 84 Planzeichen) und lassen sich dort
ausschalten.

**Sichern und Wiederherstellen.** Schreibt Dossier eine Datei (Projekt oder Export, in der Tauri-App), geht das über eine
Zwischendatei; bei einem Fehler bleibt die vorhandene Datei heil, und eine rote Meldung nennt den Grund. Beim Projekt bleibt
die vorige Fassung als `.obp~` liegen. Hat ein Projekt ungespeicherte Änderungen, fragen Fenster schliessen, ⌘Q, Neu und
Öffnen mit „Ungespeicherte Änderungen“ nach (Speichern · Nicht speichern · Abbrechen). Alle 30 Sekunden legt Dossier eine
Kopie ab, zwei Stände; nach einem Absturz bietet der Start „Ungesicherte Arbeit gefunden“ die neueste lesbare an
(Wiederherstellen · Verwerfen · Später). Lässt sich eine Datei nicht öffnen, bietet Dossier ihre vorige Fassung an; bei
offener Datei holt *Datei → Vorige Fassung wiederherstellen …* sie ebenfalls. Sie ersetzt die Datei erst beim nächsten
Speichern. Meldet Dossier, dass die automatische Sicherung nicht geschrieben werden konnte, das Projekt von Hand speichern.

Zum Schluss ⌘S. Das Projekt (`.obp`) enthält Volumen, Räume, Baurecht, Raumprogramm, Blätter und Publikationssätze.

---

## Noch offen

Das Wettbewerbsplakat ist erst teilweise fertig ([208] in `TODO.md`: die Freitext-Prüfung deckt nur die Namen ab, die Dossier
kennt), das Rendering mit Blender (*Ansicht → Rendering mit Blender …*, [211]) und der Pathtracer ([212]) sind auf dem Mac noch nicht
geprüft. Der Ablauf wurde im Browser-Build automatisch
geprüft (`e2e/release10.spec.ts`); der Durchlauf auf dem Mac steht noch aus (`doc/RELEASE-1.0.md`).
