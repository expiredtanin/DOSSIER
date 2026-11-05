---
title: "Bemassung"
linkTitle: "Bemassung"
weight: 9
---

Masse in Dossier sind **assoziativ**: Wer an einem Bauteil fängt, bindet das
Mass an das Bauteil. Verschiebt man später die Wand oder ändert die
Fensterbreite, geht die Masskette mit.

## Masskette zeichnen

**Befehl:** `dim` / `bemassung`.

1. Ersten Punkt fangen (Wandecke, Leibung, Achse …).
2. Weitere Punkte – jeder ergänzt die Kette. *Zurück* nimmt den letzten
   Punkt zurück.
3. *Fertig* (oder Enter), dann die **Lage der Masslinie** zeigen.

Die Masszahl steht in Metern (im DXF-Export auf Wunsch in Zentimetern).
Textgrösse und Symbole gehen mit dem Massstab mit.

## Assoziativ

Jeder gefangene Punkt merkt sich seinen Bezug: Wandlinie, Wandende,
**Wandecke** (Schnitt zweier Wandlinien), Öffnungs-Leibung oder -Mitte, Ecke,
Kante oder Mitte von Stütze, Decke, Dach, Raum, Eckpunkt, Kante oder Mitte
eines 2D-Elements [38].

- Die **Objekt-Info** einer Bemassung listet unter *Assoziative Bemassung*
  jeden Punkt mit seinem Bezug oder „frei“.
- Wird ein Bauteil gelöscht, behält der Punkt seine Lage, wird **rot
  markiert** („Bezug verloren“) – nur am Bildschirm, nicht im Druck.
- **Bemassung lösen** (`bml`) macht eine Kette frei; danach bewegt sie sich
  nicht mehr mit.

## Radius, Durchmesser, Bogenlänge

`rad` (Radiusmass), `dm` (Durchmessermass) und `bogenl` (Bogenlänge): Bogen
oder Kreis anklicken, Lage der Beschriftung zeigen. Das funktioniert auch an
gebogenen Wänden.

## Höhenkoten

**Befehl:** `kt` / `hoehenkote`. Punkt setzen, Höhenwert tippen oder
übernehmen, **Art** wählen: *OK fertig*, *UK fertig*, *OK roh*, *UK roh*.
Koten beziehen sich auf ±0.00 (siehe
[Geschosse](../geschosse-ebenen/#000-und-untergeschosse)) und skalieren mit dem
Massstab.

## Automatische Aussenbemassung

**Befehl:** `ab` / `aussenbemassung` [81].

Für die Wände des aktiven Geschosses erzeugt Dossier je Fassadenseite drei
Ketten:

1. **Öffnungskette** – Rohbau-Leibungen der Fenster und Türen,
2. **Vor-/Rücksprungkette** – Gebäudeecken und Versätze,
3. **Gesamtkette** – Gesamtlänge der Seite.

Alle Ketten sind assoziativ (Ecken und Leibungen). Der Abstand der Ketten
richtet sich nach dem Massstab der Ansicht. Nicht mittig gezeichnete Wände
werden an der echten Aussenfläche gemessen. Auch **schiefe Fassaden**
erhalten Ketten parallel zur Fassade.

*Teilweise:* Bei sehr verwinkelten Grundrissen kann es Überlagerungen geben,
die man von Hand bereinigt (Ketten verschieben oder Punkte entfernen).

## In Schnitt und Ansicht

In Schnitten und Ansichten bemasst man genauso, etwa vertikale Ketten für
Geschosshöhen, Brüstungen und Stürze, dazu Höhenkoten für OK und UK.
