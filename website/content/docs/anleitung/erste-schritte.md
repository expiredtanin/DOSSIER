---
title: "Erste Schritte"
linkTitle: "Erste Schritte"
weight: 2
---

## Start

Nach dem Splash-Screen erscheint der Startbildschirm mit drei Optionen:

- **Neues Projekt** — leeres Projekt anlegen
- **Projekt öffnen …** — bestehende `.obp`-Datei auswählen
- **Zuletzt geöffnet** — Liste der letzten Projekte mit Zeitstempel
  (nur in der Desktop-App — im Browser gibt es keine echten Dateipfade zum
  Wiederöffnen)

Eigenes Dateiformat `.obp`, mit OS-Level-Lock: dieselbe Datei kann nicht
versehentlich zweimal gleichzeitig geöffnet werden.

## Oberfläche

Grob wie ein klassisches CAD-Programm (Vectorworks/Rhino-artig):

- **Oberleiste** — Wortmarke, Werkzeuge, Ansichts-/Renderer-Umschalter
- **Kommandozeile** — Rhino-artige getippte Befehle und Koordinaten
  (s. [Kommandosystem](../kommandosystem/))
- **Zeichnungsebenen-Panel** — steuert, was im 3D-Viewport sichtbar ist
- **3D-Viewport** — eigener Rust/WASM/WebGPU-Renderer „Nordstern" (Default),
  Three.js als leichtgewichtiger Zweitpfad
- **Grundriss (PlanView)** — als SVG immer aktiv (Interaktions-/Fallback-
  Ebene), zusätzlich ein WebGL2-Pfad für grosse Pläne
- **Resource Manager** — eigenes natives Fenster für Component-/Hatch-/
  Linien-/Typ-Editoren

## Geschosse & Ebenen

Ein Gebäude gliedert sich in **Geschosse** und pro Geschoss in
**Kategorie-Ebenen** (Wände, Möblierung, Beschriftung, …) — dieselbe
Denkweise wie im ursprünglichen Rhino-Plugin. Ein Bauteil gehört zu genau
einem Geschoss; Wände lassen sich nicht geschossübergreifend zeichnen.

## Erstes Bauteil

1. Werkzeug **Wand** wählen (Oberleiste oder Kommandozeile: `wand`)
2. Ersten Achspunkt setzen — Klick oder Koordinate tippen (`5,3`)
3. Nächsten Punkt setzen — Doppelklick oder Rechtsklick beendet die Kette
4. Mit **Tür**/**Fenster** eine Öffnung in die fertige Wand setzen: Wand
   anklicken, dann Position entlang der Wand bestimmen

Jede Ansicht — 3D, Grundriss, Schnitt, PDF — wird aus demselben Modell
abgeleitet; siehe [Grundgedanke](../../entwickler/grundgedanke/).
