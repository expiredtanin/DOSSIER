---
title: "Oberfläche"
linkTitle: "Oberfläche"
weight: 2
---

![Die Oberfläche: oben Menü und Ansichtsleiste, links Werkzeuge und Attribute, Mitte Zeichenfläche mit Reitern und Befehlszeile, rechts Objekt-Info und Ausschnitte, unten Statusleiste](/img/app-grundriss.webp)

## Die Bereiche

| Bereich | Inhalt |
|---|---|
| **Menüleiste** (oben links) | *Datei*, *Bearbeiten*, *Ansicht*, *Fenster*. Auf dem Mac zusätzlich die native Menüleiste. |
| **Ansichtsleiste** (oben) | Umschalter Grundriss · Schnitt/Ansicht · 3D; *Ebenen-Kombination* und *Zeichnungs-Kombination*; *Detailgrad* (grob, mittel, fein); *Darstellung* (farbig, schwarz-weiss …); Massstab und Zoom. |
| **Zeichnungs-Reiter** (über der Zeichenfläche) | Offene Zeichnungen; „+“ öffnet einen weiteren Reiter, „×“ schliesst einen. |
| **Zeichenfläche** | Grundriss, Schnitt, Ansicht, 3D oder Layout-Blatt, mit Linealen in Metern (auf dem Blatt in Papier-mm). |
| **Befehlszeile** (unter der Zeichenfläche) | Befehle, Koordinaten und Optionen tippen, siehe [Befehlszeile](../befehlszeile/). |
| **Dock links und rechts** | Panels, als Reiter gestapelt; jedes Panel lässt sich lösen, verschieben und wieder andocken. |
| **Statusleiste** (unten) | Aktiver Befehl, Linien-Darstellung *Display/Print*, *Fang* mit Einstellungen, *Achsen* (Wandachsen ein/aus), Cursor-Koordinaten X/Y, Einheit, aktives Geschoss und aktive Ebene. |

## Die Panels

| Panel | Wofür |
|---|---|
| **Werkzeuge** | Alle Zeichen- und Bauteil-Werkzeuge als Liste oder Symbole. |
| **Attribute** | Eigenschaften für das nächste Element: Ebene, Stift, Linientyp, Schraffur, aktiver Wand-, Decken-, Fenster- oder Türtyp. |
| **Objekt-Info** | Eigenschaften der Auswahl: Masse, Höhen, Typ, Material, Bezüge; Änderungen wirken sofort und sind ein Undo-Schritt. |
| **Zeichnungsebenen** | Geschosse, Schnitte, Ansichten und Detailzeichnungen; Höhen, Ansichtsbereich, Vorlage, Bezugsgeschoss ±0.00. |
| **Ebenen** | Kategorie-Ebenen (Wände, Decken, Möblierung, Beschriftung …): sichtbar, gesperrt, drucken, Stift; Ebenen-Kombinationen. |
| **Elemente** | Baum aller Elemente nach Geschoss und Art, zum Finden und Auswählen. |
| **Ausschnitte** | Gespeicherte Ansichten mit Massstab, Ebenen und Vorlage, in Ordnern. |
| **Mappe** | Layoutblätter, Masterlayouts und Publikationssätze. |
| **Lage** | Georeferenz, Gelände, Baurecht (Parzelle, Baulinien, Abstände), Sonne und Schatten. |
| **Flächenbilanz** | Kennzahlen, SIA-416-Flächen, IVHB, Raumprogramm Soll/Ist, Listen. |
| **Verlauf** | Alle Schritte des Projekts; ein Klick springt zu einem früheren Stand. |
| **Kollision** | Kollisionsprüfung zwischen Bauteilen. |
| **BCF** | Themen aus BCF-Dateien (Koordination mit Fachplanern). |

Der **Ressourcen-Manager** (*Fenster → Ressourcen*, auf dem Mac ein eigenes
Fenster) verwaltet die Bibliotheken des Projekts: Bauteil-Aufbauten (Wand,
Decke, Dach), Fenster- und Türtypen, Schraffuren, Linientypen, Stiftsätze,
Materialien, Blöcke, Ansichtsvorlagen, Raumstempel. Mit **Standards laden**
ergänzt man fehlende Standard-Baustoffe, -Schraffuren und -Linientypen, ohne
eigene zu überschreiben.

## Zeichnungs-Reiter und Ausschnitte

Seit November 2026 sind beide Dinge getrennt [136]:

- Ein **Reiter** ist nur ein Fenster auf das Modell. Er merkt sich, was er
  zeigt (Geschoss, Zoom, Ebenen, Darstellung), wird aber **nicht** im Projekt
  gespeichert und erzeugt keinen Undo-Schritt. Man kann beliebig viele
  öffnen, auch mehrere vom selben Ausschnitt. „×“ schliesst nur den Reiter –
  nie den letzten und nie den Ausschnitt.
- Ein **Ausschnitt** ist eine gespeicherte Ansicht im Projekt (Panel
  *Ausschnitte*): Klick zeigt ihn im aktiven Reiter, Doppelklick oder „↗“
  öffnet ihn in einem neuen Reiter. Ändert man danach Zoom oder Ebenen, bleibt
  der Ausschnitt unverändert, bis man ausdrücklich **Ausschnitt aktualisieren**
  wählt. Ausschnitte lassen sich duplizieren (⧉) und in Ordnern ordnen.
- Wird ein Ausschnitt gelöscht, bleiben seine Reiter offen.

Noch nicht fertig: Beim Öffnen eines Projekts startet Dossier mit einem
Reiter; die Reiter selbst werden nicht mitgespeichert.

## Auswahl

- Klick wählt, Shift+Klick erweitert, Rahmen von links nach rechts wählt
  Ganzes, von rechts nach links auch Angeschnittenes.
- Cmd+Klick (Mac) bzw. Strg+Klick wählt das nächste Objekt **unter** dem
  Cursor, wenn mehrere übereinander liegen.
- Cmd/Strg+A wählt alles auf der aktiven Ebene; Esc hebt die Auswahl auf.
- Rechtsklick öffnet das Kontextmenü: Eigenschaften kopieren/einfügen,
  Ebene ausblenden oder isolieren, sperren, Reihenfolge, Boolesche
  Operationen, Punkte einfügen oder löschen.

## Einstellungen

*Fenster → Einstellungen* hat drei Reiter:

- **Allgemein:** Erscheinungsbild (hell/dunkel), Farben für Auswahlrahmen und
  Fang, Strichstärken nach Massstab, Höhe ±0.00 in m ü. M., eigene
  Tipp-Kürzel für die Befehlszeile, Offline-Modus (kein Netzzugriff, etwa für
  swisstopo), KI-Zugriff.
- **Tastenkürzel:** alle Tastenkombinationen ansehen und ändern
  ([Tastenkürzel](../tastenkuerzel/)).
- **Update:** Version und Aktualisierung der Desktop-App.

## Speichern und Sicherheit

- `.obp` ist das Projektformat (JSON). Beim Öffnen sperrt Dossier die Datei,
  damit sie nicht zweimal gleichzeitig bearbeitet wird; bei einer Sperre
  fragt es nach.
- Gespeichert wird atomar (Zwischendatei, dann Umbenennen); die vorige
  Fassung bleibt als `datei.obp~` liegen.
- Automatische Sicherung alle 30 Sekunden; nach einem Absturz bietet Dossier
  die Wiederherstellung an.
- Stösst der Rechenkern auf einen Fehler, startet er neu und lädt den letzten
  Stand, statt die App mitzureissen – *teilweise* [118].
