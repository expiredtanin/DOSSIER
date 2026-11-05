---
title: "Kennzahlen und Listen"
linkTitle: "Kennzahlen und Listen"
weight: 11
---

Weil alle Pläne aus einem Modell kommen, sind Flächen und Listen immer auf
dem Stand der Zeichnung. Sie stehen im Panel **Flächenbilanz** (auch *Datei
→ Kennzahlen und Raumprogramm …*), lassen sich als Tabelle auf ein
Layoutblatt setzen und als CSV, SVG oder PDF ausgeben.

## Flächen nach SIA 416

Die Flächenbilanz rechnet je Geschoss und total nach den Flächenarten der
SIA 416 [70]:

| Kürzel | Fläche |
|---|---|
| HNF / NNF | Haupt- und Nebennutzfläche |
| NF | Nutzfläche (HNF + NNF) |
| VF | Verkehrsfläche |
| FF | Funktionsfläche |
| NGF | Nettogeschossfläche (NF + VF + FF) |
| KF | Konstruktionsfläche (aus den Wandgrundrissen) |
| GF | Geschossfläche (NGF + KF) |
| AGF | Aussengeschossfläche |
| GV | Gebäudevolumen |

Grundlage sind die **Räume** und ihre SIA-Kategorie (Objekt-Info des Raums).
Ein Raum ohne Kategorie zählt nicht zur Nutzfläche – darum lohnt es sich,
jedem Raum eine Kategorie zu geben.

Die Begriffe sind hier sinngemäss zusammengefasst; massgebend ist die Norm
selbst.

## Kennzahlen nach IVHB

Mit der Parzellenfläche (aus dem Baurecht oder von Hand) rechnet Dossier die
Ziffern nach der Interkantonalen Vereinbarung über die Harmonisierung der
Baubegriffe: **GFZ**, **AZ** (Basis wählbar: GF, NGF oder NF), **BMZ**,
**ÜZ** und **GZ**; auf Wunsch mit anrechenbaren Untergeschossen, Grünfläche
und anrechenbarer Gebäudefläche. Welche Ziffer gilt und wie sie im Detail
gerechnet wird, regelt die jeweilige Gemeinde.

## Raumprogramm

Das Raumprogramm vergleicht **Soll** (Programm) und **Ist** (gezeichnete
Räume):

- Zeilen von Hand (*+ Programmzeile*: Name, Fläche je Raum, Anzahl,
  Flächenart, Gruppe, Bemerkung) oder **Raumprogramm importieren …** aus
  Excel (`.xlsx`), LibreOffice (`.ods`) oder CSV. Der Import schlägt die
  Spaltenzuordnung vor, überspringt Summen- und Leerzeilen und macht
  Zwischentitel zu Gruppen; Schweizer Zahlen wie „1'250,5“ oder „12,5 m²“
  werden verstanden.
- Zuordnung nach Raumnamen; Ampel je Zeile (erfüllt, zu klein, zu gross,
  fehlt, zu wenige, zu viele) mit einstellbarer Toleranz (Standard ±5 %);
  Summen je Gruppe, Flächenart und total.
- **Räume generieren** legt für ein Programm eine neue Zeichnungsebene mit
  Rechtecken in exakter Soll-Fläche an – als Startpunkt für Volumenstudien.

## Massenmodell

Für Wettbewerb und Machbarkeit: Volumen als **Körper** modellieren; die
Flächenbilanz nimmt das Gebäudevolumen GV aus den Körpern, die
Geschossflächen aus den Räumen, AZ und ÜZ aus der Parzelle [41].

## Fenster- und Türliste

Die Fenster- und Türliste [97] führt jede Öffnung mit:

- **Nummer** (eingetragen oder automatisch `F1.01`, `T1.01` je Geschoss
  und Art),
- Typ, Geschoss, **Räume beidseits** der Wand,
- Rohbau- und Lichtmass und weitere Angaben des Typs.

Ausgabe als Tabelle auf dem Blatt, CSV, SVG oder PDF; auch über die
Kommandozeile (`schedule --openings`).

## Bauteilliste und U-Wert

- Die **Bauteilliste** (*Datei → Exportieren → Bauteilliste (CSV)*) listet
  Wände, Decken, Dächer, Stützen, Treppen mit Mengen (auch
  `dossier-cli … schedule --elements`).
- Der **U-Wert** eines Wand-, Decken- oder Dachaufbaus wird aus den Schichten
  gerechnet (R = Rsi + Σ d/λ + Rse, Rechenweg nach EN ISO 6946) und erscheint
  in der Objekt-Info, in der Bauteiltabelle und im IFC [71]. Die
  Wärmeleitfähigkeit λ kommt aus dem Baustoff. Das ersetzt keinen
  Energienachweis.

## Kollisionsprüfung

*Datei → Kollisionsprüfung …* (Panel *Kollision*) sucht Überschneidungen
zwischen Bauteilen, etwa eine Stütze in einer Tür oder eine Treppe durch eine
Decke ohne Aussparung. Treffer lassen sich anspringen.
