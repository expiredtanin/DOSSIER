---
title: "Bauteile"
linkTitle: "Bauteile"
weight: 5
---

Bauteile sind die eigentlichen Elemente des Modells. Jedes gehört zu einem
**Geschoss**, hat einen **Typ** oder **Aufbau** aus der Bibliothek und
erscheint in allen Ansichten, in den Mengen und im IFC. Eigenschaften ändert
man in der **Objekt-Info**; Höhen lassen sich an Geschosse binden
(„Gebunden“) oder frei setzen („Eigene“).

## Wände

**Befehl:** `w` / `wand`, Taste `6`.

- Ein Wandzug entsteht Punkt für Punkt; jedes Segment ist eine eigene Wand.
  Die Option **Bogen** macht das nächste Segment zu einer gebogenen Wand
  (Durchgangspunkt, dann Endpunkt), **Tangential** schliesst weich an.
- **Referenzlinie:** aussen (links), Mitte, innen (rechts) oder an einer
  Schichtfuge – die Linie, auf der man zeichnet. Die Wand behält sie beim
  Ändern des Aufbaus.
- **Aufbau:** einschichtig (*Solid*, nur Dicke) oder **mehrschichtig** aus
  einem Wandaufbau der Bibliothek (Schichten mit Baustoff, Dicke, Schraffur,
  Priorität, Funktion tragend/Dämmung/Bekleidung).
- **Höhen:** Unterkante und Oberkante bezogen auf das Geschoss, „An oberes
  Geschoss binden“, „An Decke enden“, „An Dach anschliessen“ (die Wand folgt
  der Dachneigung).
- **Anschlüsse:** L-, T- und X-Stösse rechnet Dossier selbst: Schichten
  gleicher oder höherer Priorität laufen durch, die übrigen stossen an. Auch
  schräge Anschlüsse; bei einigen Sonderfällen mehrschichtiger schräger
  Stösse *teilweise* [108].
- **Bearbeiten wie Linien:** Stutzen, Verlängern, Teilen, Unterbrechen,
  Verbinden, Verrunden, Versatz [113]. Fenster und Türen wandern beim
  Kopieren und Spiegeln mit [134].
- Die Objekt-Info zeigt Länge, Brutto-Fläche und den **U-Wert** des Aufbaus
  (aus den Schichten, Rsi/Rse nach EN ISO 6946).

## Fenster und Türen

**Befehle:** `f` (Fenster, Taste `8`), `t` (Tür, Taste `9`), `oe` (Öffnung
allgemein).

1. Wand anklicken.
2. Lage entlang der Wand zeigen oder den Abstand ab Wandanfang tippen; Tab
   wechselt zu Breite, Brüstung (Fenster) oder Öffnungswinkel (Tür).
3. Optionen: **Art**, **Anschlag** (links/rechts), **Seite** (innen/aussen),
   **Richtung**.

Jede Öffnung hat einen **Typ** aus der Bibliothek (*Fenster → Ressourcen*,
Typen-Editor mit Vorschau). Ein Typ beschreibt:

- Rahmen (in Schnitt und Aufsicht), Flügel, Sprossen, Oberlicht,
  Storenkasten, Sims, Sturzlinien;
- Anschlag und Wandnase, Leibung aussen/Mitte/innen mit Mass,
  **Schichteinzug** je Wandschicht und Seite (etwa die Dämmung, die in die
  Leibung läuft);
- Türarten: Drehtür ein- und zweiflügelig, Schiebetür, Hebeschiebetür,
  Pendeltür, mit Zargenart.

Die Darstellung im Grundriss folgt Schweizer Gewohnheit: Rohbaulücke, Leibung,
Rahmen und Flügel je nach **Detailgrad**, Aufschlag als Bogen, Schiebetüren
mit Pfeil zur Parkseite. Vieles davon ist neu und noch *teilweise* [94]–[106].

Fenster- und Türnummern (`F1.01`, `T1.01` je Geschoss) vergibt Dossier
automatisch, eigene Nummern sind möglich; sie erscheinen in der
[Fenster- und Türliste](../kennzahlen/#fenster--und-türliste).

## Decken

**Befehl:** `d` / `decke`, Taste `7`.

- Umriss Punkt für Punkt, *Schliessen* beendet.
- Aufbau einschichtig (Dicke) oder aus einem Deckenaufbau; Oberkante bezogen
  auf das Geschoss.
- **Aussparungen** setzt der Befehl `deckenloch`; in der Objekt-Info lassen
  sie sich wieder entfernen.
- Eine Decke kann als **Vorsprung** markiert werden (Balkon, Vordach) – das
  Baurecht prüft sie dann als solchen [63].

## Dächer

**Befehl:** `dach`.

- Zwei Ecken ziehen ein Rechteck auf; Form und Masse folgen in der
  Objekt-Info: **Flach, Pult, Sattel, Walm, Zelt, Mansarde** (Giebel-, Walm-
  oder Zelt-Mansarde mit Knicklage und oberer Neigung), **Krüppelwalm** (in
  Prozent der Firsthöhe), Firstrichtung, Neigung, Traufhöhe, Überstand an
  Traufe und Ortgang, Dachaufbau.
- Über unregelmässigen Grundrissen (L, T, U, mit Innenhöfen) rechnet Dossier
  die Dachflächen über ein „Straight Skeleton“ mit Graten und Kehlen.
  Schiefwinklige Sonderfälle sind noch *teilweise* [26].
- **Gaube** (`gaube`, `lukarne`): Klick auf die Mitte der Gaubenstirn in
  einer geneigten Dachfläche; Formen Schlepp, Sattel, Walm, Flach. Grösse per
  Griff.
- **Dachfenster** (`dachfenster`): Öffnung in einer Dach- oder
  Deckenfläche; Breite quer zum Gefälle, Höhe im Gefälle [103].
- **Dachhof** (`dachhof`): Ausschnitt im Dach.
- Wände lassen sich an die Dachunterseite anschliessen.

## Treppen

**Befehl:** `treppe` / `tp`.

- Startpunkt (Antritt), dann Laufrichtung und Ende. Bei der **L-Treppe**
  folgt ein zweiter Lauf, bei der **Wendeltreppe** ist der zweite Punkt der
  Aussenrand.
- Optionen: **Grundform** (gerade, L, Wendel), **Auf/Ab**, **Referenz**
  (links, Mitte, rechts), **Trittmass** (Stufenzahl aus einem Soll-Auftritt).
- Die Treppe steigt genau um die Geschosshöhe ins nächste Geschoss; die
  Objekt-Info zeigt Stufenzahl, Steigung, Auftritt, Laufbreite, Betonvolumen
  und Schalfläche der Untersicht.
- Im Grundriss: Stufen mit Lauflinie und Pfeil (ein- und ausblendbar).

## Stützen

**Befehl:** `stuetze`. Punkt setzen; Profil rechteckig oder rund, Breite,
Tiefe bzw. Radius, Höhe und Drehung in der Objekt-Info.

## Räume

**Befehl:** `raum` / `rm`, Taste `0`.

- In einen von Wänden umschlossenen Bereich klicken: Dossier findet den
  Umriss. Mit der Option *Modus* zeichnet man ihn von Hand.
- Name, Nummer, **SIA-Kategorie** (Nutzfläche HNF/NNF, Verkehrsfläche,
  Funktionsfläche …), Fläche und Umfang.
- Der **Raumstempel** zeigt das, was im Stempel-Editor festgelegt ist (Name,
  Nummer, Fläche, Kategorie, lichte Höhe); er bleibt auf dem Papier gleich
  gross.
- Räume speisen Flächenbilanz, Raumprogramm und die Raumspalten der
  Fenster- und Türliste.

## Körper und Abzugskörper

- **Körper** (`koerper`): Quader, Zylinder, Kegel, Kegelstumpf, Kugel, Torus.
  **Extrudieren** (`ex`), **Rotationskörper** (`rev`) und **Loft** (`lf`)
  machen aus 2D-Profilen Körper.
- **Körper verschneiden** (`bool`): vereinigen, abziehen, schneiden.
- **Durchbruch** (`durchbruch`, `nische`): ein Abzugskörper, der von Wänden,
  Decken und Stützen abgezogen wird – für Durchbrüche, Nischen und Schlitze.
  Er wirkt in Grundriss, Schnitt, 3D und im STEP-Export.

Körper erscheinen im Grundriss als Schnitt auf Schnitthöhe, in Schnitt und
Ansicht und im 3D. Gerechnet wird exakt (Manifold), für STEP als B-Rep.

## Typen, Aufbauten und Standards

Wand-, Decken- und Dachaufbauten, Fenster- und Türtypen, Baustoffe,
Schraffuren und Linientypen liegen im **Ressourcen-Manager**. Neue Projekte
bringen Standards mit: über 30 Baustoffe mit Schraffur und Wärmeleitfähigkeit
(Beton, Backstein, Kalksandstein, Holz, Dämmstoffe, Putze, Estrich …) und
Linientypen in Anlehnung an SIA 400 und ISO 128 [100]–[102]. **Standards
laden** ergänzt in älteren Projekten, was fehlt.
