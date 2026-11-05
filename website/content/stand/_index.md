---
title: "Stand und Änderungen"
description: "Wo Dossier steht: Version, was fertig ist, was offen ist, die wichtigsten Änderungen der letzten Wochen."
---

**Version 0.1.0, vor der ersten öffentlichen Beta.** Dossier wird täglich
weiterentwickelt. Die vollständige, stets aktuelle Arbeitsliste mit Stand je
Punkt (✅ vorhanden · ◐ teilweise · ○ offen) ist
[`TODO.md`](https://github.com/expiredtanin/DOSSIER/blob/master/TODO.md) im
Repository; jeder Commit beginnt mit den Nummern der Punkte, die er betrifft.
Die Nummern in eckigen Klammern unten verweisen dorthin.

Alle Änderungen im
[Commit-Verlauf auf GitHub](https://github.com/expiredtanin/DOSSIER/commits/master).

## Meilensteine

### November 2026

- **5.11.** Zeichnungs-Reiter und gespeicherte Ausschnitte entkoppelt [136];
  Wandöffnungen werden beim Kopieren mitgenommen [134]; Kommandozeile zeichnet
  Schraffuren in SVG [135]; Skizzenstil [67]; Vorsprünge im Baurecht [63];
  Aussenbemassung an schiefen Fassaden [81]; Decken und Dächer im
  Ansichtsbereich [36].
- **4.11.** Bezugsgeschoss ±0.00 und Untergeschosse mit negativen Koten [131];
  Texte in Papiergrösse [37]; Detailgrad je Ansicht [35]; Ausschnitte
  duplizieren [40]; Explosionsaxonometrie [65]; Präsentations-, Eingabe- und
  Ausführungsvorlagen [66]; Zauberstab [77].
- **3.11.** Architektur-Durchsicht: absturzsicheres Speichern [116],
  Content-Security-Policy [117], Wiederanlauf nach einem Fehler im Kern [118],
  Referenz-Ausgaben (Golden-Tests) für Grundriss, Schnitt und Ansicht [119],
  macOS in der CI [120].

### Oktober 2026

- **30.10.** Ansichtsvorlagen [34], Ansichtsbereich [36], assoziative
  Bemassung [38], Baugrube [68], U-Wert [71], Publikationssätze [79], PDF mit
  Ebenen [80], Legenden [82], Tabellen auf Blättern [111], Achsraster [112],
  Wände wie Linien bearbeiten [113], Musterhaus komplex [114], gebogene Wände,
  Gelände aus Höhenlinien, Manifold für robuste Körper-Booleans [107].
- **29.10.** Rust-Port des Kerns abgeschlossen: Dokument, Ops und Verlauf im
  Kern [K4]; Zeichnen auf dem Layout-Blatt wie im Grundriss [93];
  Fenster- und Türliste [97]; Standard-Baustoffe und Linientypen nach SIA 400
  [100]–[102]; Konstruktionsdetails für Fenster und Türen [94], [95].
- **28.10.** IFC-Import als Kontext und als Bauteile [B3], [B4]; DXF/DWG in
  Rust [C1], [C2]; Flächentabellen SIA 416 und IVHB [70]; PDF-Vektoren mit Fang
  [76]; Punktwolken lesen [B9]; UI-Tests mit Playwright [49].
- **27.10.** Entscheid: der ganze Kern wandert nach Rust, die Oberfläche
  bleibt React/TypeScript. Baulinien und Grenzabstände [63], Sonnenstand und
  Schatten [64], Georeferenz im IFC [69], automatische Aussenbemassung [81].

## Bekannte Lücken

Die wichtigsten offenen Punkte; Details in der Arbeitsliste und unter
[Probleme und Grenzen](/docs/anleitung/probleme/).

- Keine signierten Installer; Linux ohne Release-Build.
- Schatten im 3D, Varianten, Nur-Lese-Link fürs Web.
- Zeichnungs-Reiter werden nicht mit dem Projekt gespeichert [136].
- IFC-Import zu Bauteilen erkennt noch nicht alles [B4]; Punktwolken nur zur
  Anzeige [27].
- Englische Oberfläche vorhanden, englische Dokumentation folgt.
