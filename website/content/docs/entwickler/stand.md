---
title: "Stand & Funktionen"
linkTitle: "Stand & Funktionen"
weight: 2
---

Auszug — vollständige Liste inklusive offener Punkte und bekannter technischer
Schulden in [STATUS.md](https://git.openbureau.ch/karim/DOSSIER-STANDALONE/raw/branch/master/STATUS.md) §3.

- **Semantisches Modell** mit mehrschichtigen Wänden, L-Eck-Gehrung **und**
  Prioritäts-T-/X-Stössen (`joinPriority` am Component) — konsistent in
  Grundriss, 3D-Viewport und 3D-Live-Schnitt.
- **Parametrische Wände**, Decken, Treppen (gerade/L/Wendel), Dächer
  (Flach/Pult/Sattel/Walm/Mansarde/Zelt), Stützen, SIA-416-Räume mit
  automatischer Bilanz und CSV-Export.
- **Türen & Fenster** gehostet in Wänden, mit Rahmen/Zarge/Kämpfer/Oberlicht,
  Detailgrad grob/mittel/fein, echte Rechteck-Löcher im 3D-Wandkörper.
- Rhino-artiges **Kommandosystem** mit getippten Koordinaten (`5,3` · `r5,3` ·
  `5<45`) und Tab-Feld-Zyklus; Snapping, Grips, Trim/Split/Join, 2D-Booleans.
- **Live 2D↔3D-Schnitt**: eine Schnittebene im 3D-Viewport folgt derselben
  Prioritäts-Logik wie der 2D-Plan-Schnitt.
- **Vektor-Export:** PDF (Einzel- und Mehrseiten-Layouts), DXF, IFC4 (mit
  echten Fenster-/Tür-Löchern), STL/OBJ, CSV-Bauteilliste.
- **Materialbibliothek**: gebündelte PBR-Starter plus Live-Suche der
  kompletten ambientCG-Bibliothek (1K/2K/4K, On-Demand-Download).
- **Layouts/Plansätze** mit mehreren Viewports pro Blatt, Ausschnitte
  (View-Snapshots), Kamera-Presets, Norden-Rotation.
- **Import:** DXF/DWG, Swisstopo (swissBUILDINGS3D/-ALTI3D/SWISSIMAGE,
  radiusgenau zugeschnitten), OSM-Kontextimport, `.lin`/`.pat`.
- **Native Desktop-Integration** (Tauri): eigene randlose Fenster, native
  Speichern/Öffnen-Dialoge, eigenes `.obp`-Dateiformat mit OS-Level-Lock gegen
  Doppelöffnen.
- **Resource Manager** (Component-/Hatch-/Line-/Typ-Editoren), regelbasierte
  Overrides, Panel-System (dockbar/floatend), i18n (de/en).

## Bewusst noch offen

- **Echtes Mesh-Boolean für Öffnungen** — heute achsparallele Rechteck-Löcher;
  ein generisches CSG-Boolean existiert bereits, ist aber nicht an die
  Wand-Pipeline angeschlossen.
- **3D-Griffsystem**: Feld-Controller und Snapping fehlen für 3D-Grip-Drag
  (im 2D vollständig vorhanden).
- **DWG/DXF-Domänenimport** (Entitäten → echte Wände/Öffnungen) — Lesen
  funktioniert, das Mapping auf das Modell ist unbegonnen.
- **`make2D`**-Kommando (3D-Ansicht → flacher 2D-Plan mit Füllungen).
