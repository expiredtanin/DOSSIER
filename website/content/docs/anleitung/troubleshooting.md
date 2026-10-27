---
title: "Bekannte Einschränkungen"
linkTitle: "Bekannte Einschränkungen"
weight: 7
---

DOSSIER ist aus einem Risiko-Spike gewachsen und wird aktiv weiterentwickelt.
Diese Seite listet **bewusst offene Punkte** ehrlich auf.

## Modellierung

- **Öffnungen als Rechteck-Löcher, kein echtes Mesh-Boolean** — Türen/Fenster
  funktionieren heute über achsparallele Rechteck-Löcher im Wandkörper. Ein
  generisches CSG-Boolean existiert bereits im Rust-Code (`trucksolid`), ist
  aber noch nicht an die Wand-Pipeline angeschlossen.
- **3D-Griffsystem unvollständig** — Feld-Controller (Tab-Zyklus) und
  Snapping für das Ziehen von Grips fehlen in 3D; in 2D vollständig
  vorhanden.
- **`make2D`-Kommando fehlt** — eine 3D-Ansicht direkt in einen flachen
  2D-Plan mit Füllungen umwandeln, ist noch nicht implementiert.
- Bekannte, noch nicht bereinigte Doppelspur zwischen `Door[]` und
  `Opening[]` im Datenmodell.

## Import

- **DWG/DXF-Domänenimport** — das Lesen der Dateien funktioniert, das
  Mapping der Entitäten auf echte Wände/Öffnungen ist unbegonnen; Import
  landet aktuell als Referenzgeometrie. DWG-**Schreiben** fehlt ganz.

## Plattform

- Auf **Linux** läuft DOSSIER über eine Electron/Chromium-Shell statt Tauri,
  weil Tauris Linux-Webview (WebKitGTK) kein zuverlässiges WebGPU bietet, das
  die beiden Rust/WASM-Renderer brauchen.
- Der **Browser-Modus** hat keine native Fenster-/Dateisystem-Integration —
  kein `.obp`-Format mit OS-Level-Lock, keine nativen Speichern/Öffnen-
  Dialoge.

## Forum

Das Forum für Fragen, Diskussion und Support ist noch nicht online — bis
dahin ist das
[Repository](https://git.openbureau.ch/karim/DOSSIER-STANDALONE) (Issues,
Quellcode) die primäre Anlaufstelle.
