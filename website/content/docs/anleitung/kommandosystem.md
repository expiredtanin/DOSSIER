---
title: "Kommandosystem"
linkTitle: "Kommandosystem"
weight: 3
---

DOSSIER hat neben der Maus ein **Rhino-artiges Kommandosystem**: Werkzeuge
lassen sich per Kommandozeile starten, und Koordinaten werden getippt statt
nur geklickt.

## Koordinaten tippen

Während ein Zeichenwerkzeug aktiv ist, akzeptiert die Kommandozeile:

| Eingabe | Bedeutung |
|---|---|
| `5,3` | absoluter Punkt (x, y in Metern) |
| `r5,3` | relativ zum letzten Punkt |
| `5<45` | Distanz `<` Winkel (Polarkoordinate) |

**Tab** zykelt zwischen den Eingabefeldern (z. B. erst Distanz, dann
Winkel), wie in Rhino/AutoCAD gewohnt — kein Klicken zwischen Feldern nötig.

## Snapping & Grips

- **Snapping** an Endpunkten, Mittelpunkten, Rasterpunkten — `Shift` erzwingt
  Ortho (0/90°), `Ctrl` schaltet Fang temporär aus
- **Grips**: fertige Elemente lassen sich an ihren Kontrollpunkten direkt
  ziehen, ohne ein Werkzeug zu wechseln
- Feld-Controller (Tab-Zyklus) und Snapping fürs Grip-Ziehen sind aktuell nur
  in 2D vollständig — 3D-Grip-Drag ist bewusst noch offen (s.
  [Bekannte Einschränkungen](../troubleshooting/))

## Bearbeiten

- **Trim/Split/Join** — Linien/Wände an Schnittpunkten stutzen, teilen,
  zusammenführen
- **2D-Booleans** für Flächen (Räume, Decken)
- L-Eck-Gehrung und Prioritäts-T-/X-Stösse bei Wandverbindungen laufen
  automatisch über den `joinPriority` des jeweiligen Bauteils

## Werkzeuge (Auswahl)

Auswahl, Wand, Decke, Fenster, Tür, Treppe, Raum — sowie die klassischen
2D-Primitiven Linie, Polylinie, Rechteck, Kreis, Bogen, Text/Textspalte und
Bild/PDF-Import. Alle über die Oberleiste oder per Kommandozeilen-Kürzel
erreichbar.
