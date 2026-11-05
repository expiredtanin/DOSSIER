---
title: "Zeichnen und Bearbeiten"
linkTitle: "Zeichnen und Bearbeiten"
weight: 4
---

Dossier ist auch ein vollständiges 2D-Zeichenprogramm. 2D-Elemente liegen
wie Bauteile auf einem Geschoss (oder einer Detail-/Blattebene) und auf einer
Kategorie-Ebene; sie erscheinen im Grundriss, im PDF und im DXF, aber nicht im
3D. Die Befehle mit allen Kürzeln stehen unter [Befehlszeile](../befehlszeile/#alle-befehle).

## Linien und Formen

- **Linie** (`l`, Taste `2`), **Polylinie** (`pl`, Taste `5`) mit der Option
  *Bogen* für Bogenstücke, **Rechteck** (`rec`, Taste `4`), **Kreis** (`c`,
  Taste `3`) mit mehreren Methoden, **Bogen** (`a`), **Ellipse** (`el`),
  **Vieleck** (`vg`), **Spline** (`sp`), **Bezier** (`bz`).
- **Konstruktionslinie** (`xl`) und **Strahl** (`ry`) sind Hilfslinien ohne
  Ende; man legt sie auf eine eigene Ebene und blendet sie beim Drucken aus.
- **Parallellinien** (`ml`) zeichnet mehrere Linien im Abstand in einem Zug.
- Strichstärke, Farbe und Linientyp kommen aus dem **Stift** bzw. der Ebene
  (Panel *Attribute*); einzelne Elemente können abweichen.

## Flächen, Schraffuren, Masken

- Geschlossene Polylinien, Rechtecke, Kreise und Vielecke können eine
  **Füllung** und eine **Schraffur** tragen (Objekt-Info). Schraffuren kommen
  aus der Bibliothek (Standard nach SIA 400, eigene, oder `.pat`-Dateien).
- **Zauberstab** (`zs`): in eine von Linien umschlossene Fläche klicken –
  Dossier erzeugt den Umriss als geschlossene Polylinie mit Schraffur. Linien,
  Kreise, Bögen und Modellkanten des Geschosses zählen als Grenze. *Teilweise*
  [77]: sehr komplexe Situationen mit Inseln brauchen noch Nacharbeit.
- **Maskenregion** (`wo`) deckt Darunterliegendes ab, etwa hinter einem Text.
- **2D-Booleans**: zwei oder mehr gewählte Flächen vereinigen
  (Cmd/Strg+Shift+U), abziehen (…+D) oder schneiden (…+I).

## Text und Beschriftung

- **Text** (`tx`, Taste `1`): Klick setzt den Text, Doppelklick bearbeitet ihn.
  Texte haben eine **Papiergrösse** in Millimetern (neu im Grundriss 2.5 mm)
  und bleiben in jedem Massstab gleich gross auf dem Plan [37].
- **Textspalte** (`textbox`) bricht innerhalb einer festen Breite um;
  **Text entlang Pfad** (`txp`) folgt einer Kurve; **Vorführungspfeil**
  (`ld`) verbindet Text und Bauteil.
- **Höhenkote** (`kt`), **Detail-/Schnitt-Verweis** (`dr`),
  **Massstabsbalken** (`sb`), **Revisionswolke** (`rv`) und **Punktmarker**
  (`pm`) skalieren mit dem Massstab der Ansicht.
- Raumstempel entstehen mit dem Befehl *Raum*; ihr Inhalt (Name, Nummer,
  Fläche, Nutzung, Höhe) wird im Raumstempel-Editor gestaltet.

## Achsraster

**Achsraster** (`achsraster`): rechtwinklig mit Achsen 1, 2, 3 … und A, B,
C …, beliebigen Abständen und Drehung, oder radial mit Strahlen und Ringen;
Achsköpfe am Anfang, Ende oder beidseitig, Überstand einstellbar. Achsraster
erscheinen auch in Schnitten und Ansichten.

## Bearbeiten

Die Bearbeiten-Befehle wirken auf die Auswahl; ist nichts gewählt, fragen sie
danach.

| Aufgabe | Befehl | Hinweis |
|---|---|---|
| Verschieben | `m` | Basispunkt, Zielpunkt; Taste `m` |
| Kopieren | `cp` | auch mehrfach hintereinander |
| Drehen | `ro` | Drehpunkt, Winkel tippen oder zeigen; Taste `d` |
| Spiegeln | `s` | Spiegelachse mit zwei Punkten; Taste `s` |
| Skalieren | `sc` | Basispunkt, Faktor |
| Feld | `ar` | rechteckige oder polare Reihe |
| Ausrichten | `al` | links, rechts, oben, unten, Mitte, verteilen |
| Versatz | `o` | Abstand tippen, Seite zeigen |
| Stutzen | `tr` | an Schnittkanten abschneiden |
| Verlängern | `ext` | bis zur nächsten Kante |
| Teilen | `teilen` | an einem Punkt oder an Schnittpunkten; Cmd/Strg+S bei 2D-Auswahl |
| Unterbrechen | `br` | Stück zwischen zwei Punkten entfernen |
| Verbinden | `j` | Linien/Bögen zu einer Polylinie; Cmd/Strg+J |
| Verrunden | `fi` | Radius tippen, zwei Elemente wählen |
| Fasen | `ch` | Ecke abschrägen |
| Auflösen | `x` | Polylinie, Block, Bemassung in Einzelteile |

Stutzen, Verlängern, Teilen, Unterbrechen, Verbinden, Verrunden und Versatz
funktionieren auch mit **Wänden**, gerade und gebogen [113].

## Blöcke und Gruppen

- **Block definieren** (`db`) speichert die Auswahl mit Basispunkt als
  Block in der Bibliothek; **Block einfügen** (`bl`) setzt ihn, gedreht und
  skaliert.
- **Gruppieren** (Cmd/Strg+G) fasst die Auswahl zusammen, Cmd/Strg+Shift+G
  löst die Gruppe. Ein Klick wählt die ganze Gruppe.
- Cmd/Strg+C und Cmd/Strg+V kopieren Elemente aller Art.

## Bilder und PDF als Unterlage

Bilder und PDF-Seiten lassen sich als Unterlage importieren. Bei Vektor-PDFs
liest Dossier die Linien und fängt darauf; über *Kalibrieren* bringt man die
Unterlage in den richtigen Massstab (zwei Punkte, bekannte Distanz). Siehe
[Import und Export](../export-import/#pdf).
