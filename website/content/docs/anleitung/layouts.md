---
title: "Layout und Publikation"
linkTitle: "Layout und Publikation"
weight: 8
---

Planblätter heissen in Dossier **Layouts**. Ein Layout ist ein Blatt Papier
mit **Ansichtsfenstern** (Viewports), die Ausschnitte des Modells in einem
Massstab zeigen, dazu Plankopf, Texte, Legenden und Tabellen. Alles liegt im
Panel **Mappe**.

![Layoutblatt „Grundrisse UG / EG“ (A1 quer) mit zwei Ansichtsfenstern 1:100, Legende und Plankopf; rechts die Mappe mit Layouts, Masterlayouts und Publikationssätzen](/img/app-layout-blatt.webp)

## Layout anlegen

1. Panel **Mappe** → *Neu …* → **Layout erstellen**. Name, Papierformat
   (A- und B-Reihe, A0 bis A6), Ausrichtung hoch/quer und optional ein
   Masterlayout wählen.
2. Doppelklick öffnet das Blatt in der Zeichenfläche. **Zurück zum Modell**
   (oben links) führt zurück.
3. Ordner (*Ordner erstellen*) gliedern die Mappe, etwa „Baueingabe“ und
   „Ausführung“. Ein ganzer Ordner lässt sich als mehrseitiges PDF ausgeben.

## Ansichtsfenster

- **Viewport aufziehen**: Rechteck auf dem Blatt ziehen, dann einen
  **Ausschnitt binden**. Der Viewport übernimmt Massstab, Ebenen,
  Darstellung und Vorlage des Ausschnitts.
- In der Objekt-Info: Lage und Grösse in Millimetern, Massstab (oder
  *Massstab vom Ausschnitt*), anderer Ausschnitt, entfernen.
- Der Inhalt bleibt live: Ändert sich das Modell, ändert sich das Blatt.
- Geschosse, Schnitte, Ansichten, Deckenspiegel und Details lassen sich
  frei mischen.

## Zeichnen auf dem Blatt

Auf dem Blatt zeichnet man **genau wie im Grundriss** – dieselben Befehle,
derselbe Fang, dieselben Griffe [93]. Der Unterschied: Einheit ist der
Millimeter auf dem Papier, y zeigt nach unten wie auf dem Blatt, und die
Lineale zeigen Papier-mm. Der Fang greift auch auf den Inhalt der
Ansichtsfenster, etwa um eine Beschriftung an eine Wandecke zu hängen.

## Masterlayouts und Plankopf

Ein **Masterlayout** enthält, was auf vielen Blättern gleich ist: Rahmen und
Plankopf. Layouts, die einen Master verwenden, zeigen
dessen Inhalt im Hintergrund.

Der Plankopf füllt sich mit **Autotext** [78]: Projekt, Projektnummer,
Blattname, Plannummer (laufend oder fest), Massstab, Datum, Bearbeiter und
**Index** (Revision). Massstab „automatisch“ nimmt den Massstab der
Ansichtsfenster.

## Legenden

**+ Legende** setzt eine grafische Legende aufs Blatt [82]. Ihre Einträge
entstehen automatisch aus dem, was die Ansichtsfenster zeigen: Baustoffe
der Wand-, Decken- und Dachaufbauten und Stützen, Schraffuren und Linientypen
der Zeichnungen, sichtbare Kategorien. Titel und Arten (Schraffur/Material,
Linientyp, Kategorie) sind wählbar; Einträge lassen sich auch von Hand
festlegen.

## Tabellen auf dem Blatt

**+ Tabelle** setzt eine Liste aufs Blatt, die mit dem Modell mitgeht [111]:

- **Fenster und Türen** (Fenster-/Türliste, auch gefiltert),
- **Flächen** nach SIA 416,
- **Raumprogramm** Soll/Ist,
- **Bauteile** mit U-Wert.

Spalten, Textstil und Grösse stellt man in der Objekt-Info ein.

## PDF

- **Datei → Exportieren → PDF** gibt die aktuelle Ansicht oder das offene
  Blatt aus; ein Ordner der Mappe wird zum mehrseitigen PDF.
- Das PDF ist vektoriell, mit echten Strichstärken in Millimetern, Texten als
  Text und Schraffuren als Linien.
- **PDF-Ebenen** [80]: je Ansichtsfenster und Kategorie eine Ebene, die man
  in Acrobat oder einem anderen Betrachter ein- und ausschalten kann; gleiche
  Namen auf mehreren Seiten bilden eine gemeinsame Ebene.
- Farben werden auf dem Mac über ICC-Profile verwaltet.

## Publikationssätze

Ein **Publikationssatz** bündelt Blätter für eine Abgabe – etwa
„Baueingabe“ oder „Ausführung 1:50“ – und gibt sie in einem Schritt aus [79].
Im Panel *Mappe* unter **Publikation**:

| Einstellung | Bedeutung |
|---|---|
| **Blätter** | Layouts in der gewünschten Reihenfolge; dazu optional gespeicherte Ansichten. |
| **Ausgabe** | PDF (ein Dokument oder je Blatt eines), DXF oder DWG mit Layouts. |
| **Dateiname** | Muster mit Platzhaltern `{Projektnummer} {Projekt} {Blattnummer} {Blattname} {Index} {Datum} {Satz}`. |
| **Papier, Massstab** | „wie Blatt“ oder für den ganzen Satz übersteuert. |
| **Index** | im Titelblock und Dateinamen ausgeben; beim Publizieren automatisch erhöhen (A → B → … → Z → AA, bzw. 2 → 3). |
| **PDF-Ebenen** | Ebenen je Kategorie im PDF. |

**Publizieren** schreibt die Dateien und trägt die Ausgabe ins
**Publikationsprotokoll** ein (Datum, Blätter mit Nummer und Index,
Dateien). *Teilweise:* einige Kombinationen (etwa Übersteuerungen bei
DXF/DWG) sind noch nicht vollständig.

## Tipps für Schweizer Planstände

- Baueingabe 1:100: Vorlage *Eingabeplan 1:100* an die Ausschnitte binden,
  Flächenbilanz und Raumprogramm als Tabelle aufs Blatt, Situation 1:500 mit
  Parzellen und Baulinien.
- Ausführung 1:50: Vorlage *Ausführungsplan 1:50*, Detailgrad fein,
  Fenster-/Türliste als Tabelle, automatische Aussenbemassung.
- Der Index (Revision) steht im Plankopf; das Protokoll zeigt, welche
  Fassung wann an wen ging.
