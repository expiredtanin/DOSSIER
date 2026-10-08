---
title: "Bauteile & Zeichnen"
linkTitle: "Bauteile & Zeichnen"
weight: 4
---

DOSSIER ist bewusst **beides**: ein klassisches 2D-Zeichenprogramm und ein
semantisches 3D-Gebäudemodell — im selben Plan, mit denselben
Zeichenwerkzeugen bedienbar.

## 2D-Zeichenwerkzeuge

Linie, Polylinie, Rechteck, Kreis, Bogen, Text, Textspalte, Bild/PDF-Import.
Freihand-Geometrie ohne semantische Bedeutung — für Beschriftung, Skizzen,
importierte Referenzpläne, alles, was kein eigenes Bauteil sein muss.

## Semantische Bauteile

- **Wände** — mehrschichtig, mit L-Eck-Gehrung und Prioritäts-T-/X-Stössen
  (`joinPriority`); konsistent in Grundriss, 3D-Viewport und Live-Schnitt
- **Decken** — Umriss zeichnen, mit Deckenlöchern (Aussparungen)
- **Türen & Fenster** — in Wänden gehostet, mit Rahmen/Zarge/Kämpfer/
  Oberlicht, Detailgrad grob/mittel/fein, echte Rechteck-Löcher im
  3D-Wandkörper (kein Mesh-Boolean nötig)
- **Treppen** — gerade, L-förmig, Wendel
- **Dächer** — Flach, Pult, Sattel, Walm, Mansarde, Zelt
- **Stützen**
- **Räume** — Klick in einen umschlossenen Bereich (oder Umriss zeichnen);
  automatische Flächenbilanz nach SIA-416 mit CSV-Export

Jedes Bauteil ist Teil des **einen semantischen Modells** — verschiebt man
eine Wand, verschiebt sie sich in jeder daraus abgeleiteten Ansicht
gleichzeitig. Mehr dazu: [Grundgedanke](../../entwickler/grundgedanke/).

## Materialien

13 gebündelte PBR-Starter-Materialien plus Live-Suche der kompletten
[ambientCG](https://ambientcg.com/)-Bibliothek (1K/2K/4K, On-Demand-Download)
für Wand-, Decken- und Dachflächen im 3D-Viewport.

## Resource Manager

Eigenes natives Fenster für Component-, Hatch-, Linien- und Typ-Editoren mit
regelbasierten Overrides — z. B. eine Wandtyp-Definition einmal ändern und
überall im Projekt aktualisieren.
