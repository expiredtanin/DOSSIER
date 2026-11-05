---
title: "Import und Export"
linkTitle: "Import und Export"
weight: 12
---

Dossier liest und schreibt die Formate, mit denen Schweizer Büros und
Fachplaner arbeiten. Die Dateiformate sind in Rust umgesetzt (eigener Code
und quelloffene Bibliotheken, Herkunft in `NOTICE`); dieselben Leser und
Schreiber nutzt die [Kommandozeile](../kommandozeile/).

## Übersicht

| Format | Import | Export |
|---|---|---|
| `.obp` (Dossier) | ja | ja |
| DXF, DWG | ja, R12–2018 | ja, Modell und Layouts |
| IFC | ja, als Kontext oder als Bauteile | IFC4, IFC2x3 |
| STEP | ja | ja (B-Rep) |
| OBJ, STL, glTF/GLB | ja | ja |
| PLY | ja | – |
| PDF | Vektor oder Bild | Plan, Blatt, Plansatz |
| Bilder (PNG, JPG …) | ja, als Unterlage | – |
| Punktwolken | LAS, LAZ, E57, PLY, XYZ, PTS | – |
| SVG | – | Plan, Schnitt, Ansicht, Listen |
| CSV | Raumprogramm (auch XLSX, ODS) | Bauteil-, Flächen-, Öffnungslisten |
| BCF | ja (`.bcfzip`) | ja |
| `.lin`, `.pat` | Linientypen, Schraffuren | – |

Importieren: *Datei → Importieren …* (DXF, DWG, PDF, Bilder) bzw. die
Einträge für STEP, IFC, Punktwolke und 3D-Modell. Exportieren: *Datei →
Exportieren* (PDF, DXF, Bauteilliste, IFC, OBJ, STL, glTF, STEP).

## DXF und DWG

**Import.** DXF (ab R12) und DWG (R13 bis 2018), auch sehr grosse
Kataster. Die Zeichnung wird zu 2D-Elementen auf Ebenen mit den Namen der
Datei. Landeskoordinaten werden an den
Bezugspunkt verschoben ([Lage](../lage-baurecht/#georeferenz-und-nullpunkt)).
Höhenlinien aus DXF dienen als Grundlage für das Gelände. Wände und Öffnungen
werden aus DXF/DWG nicht erkannt – der Import ist Unterlage oder 2D-Plan.

**Export.** Grundriss, Schnitt und Ansicht als DXF oder DWG: im Modellbereich
in Metern, Masse auf Wunsch in Zentimetern, mit Layouts (Papierbereich mit
Ansichtsfenstern), auf Wunsch binär. Ebenen nach den Kategorien, Farben und
Strichstärken aus den Stiften. Aus einem Publikationssatz entstehen DXF/DWG
je Blatt.

## IFC

**Export** als IFC4 (Standard) oder IFC2x3 (Coordination View 2.0):

- Wände mit Schichten (Materialaufbau), Öffnungen mit Fenstern und Türen,
  Decken, Dächer, Treppen, Stützen, Räume (IfcSpace) mit SIA-416-Flächen;
- Geschosse als IfcBuildingStorey, Georeferenz mit EPSG:2056 und
  IfcMapConversion;
- stabile GUIDs (gleiches Bauteil, gleiche GlobalId über Exporte hinweg);
- Eigenschaften: tragend, aussen, Brand- und Schallschutz, U-Wert in den
  Psets; Mengen in Qto-Sets;
- Klassifikation nach eBKP-H-Hauptgruppen oder nach den Dossier-Ebenen
  (Option).

Die Dateien werden in der Entwicklung mit IfcOpenShell gegen Schema und
Regeln geprüft.

**Import.** Zwei Wege (Dialog beim Import):

- **Kontext** (Standard): jedes Produkt wird als Netz übernommen, gruppiert
  nach Produkt oder Klasse – z. B. das Modell der Nachbarbaute oder des
  Tragwerksplaners. Öffnungen und Booleans werden aufgelöst.
- **Bauteile** *(teilweise [B4])*: Wände, Decken, Öffnungen und weitere
  Bauteile werden als echte Dossier-Bauteile angelegt, soweit sie erkannt
  werden; der Rest bleibt Kontext.

## STEP

STEP importiert Volumenkörper als B-Rep und exportiert die
Bauteile und Körper als B-Rep in Millimetern – für Fachplaner, Fassadenbau
oder Fertigung.

## OBJ, STL, glTF, PLY

**Import** als Kontext-Netz (*3D-Modell importieren …*): Einheit (mm, cm, m,
inch, foot), Hochachse (Z, Y oder automatisch) und Platzierung (zentriert
oder Original) sind wählbar. **Export** von OBJ, STL und glTF/GLB (glTF in
Metern, Y nach oben, Geschosse als Knoten).

## PDF

**Export** (*Datei → Exportieren → PDF*, Layoutblätter, Plansätze):
vektoriell, mit Strichstärken in Millimetern, Text als Text, optional mit
schaltbaren Ebenen. Siehe [Layout und Publikation](../layouts/#pdf).

**Import** als Unterlage:

- **Vektor:** Dossier liest die Pfade und Texte der Seite selbst (ohne
  Umweg über ein Bild) und legt sie als 2D-Elemente ab, nach Farbe und
  Strichstärke auf Ebenen verteilt. Man fängt darauf wie auf eigener
  Geometrie. Mit **Kalibrieren** (zwei Punkte, bekannte Distanz) stimmt der
  Massstab. *Teilweise* [76]: Verschlüsselte PDFs werden abgelehnt, sehr
  exotische Inhalte fehlen.
- **Bild:** die Seite als Rasterbild.

## Punktwolken

LAS, LAZ, E57, PLY, XYZ und PTS werden gelesen, auf ein Raster ausgedünnt
(Voxel) und im 3D angezeigt, mit Farben oder Intensität *(teilweise [27])*.
Schnitte und Grundrisse aus der Punktwolke und Fang darauf folgen später.

## BCF

Das Panel **BCF** öffnet `.bcfzip`-Dateien (etwa aus Solibri oder anderen
BIM-Werkzeugen) für die Koordination mit Fachplanern: Themen mit Status,
Priorität, Zuständigkeit, Kommentaren, Kamera und Schnittebenen; die
betroffenen Bauteile werden über die IFC-GlobalId gefunden. *Thema aus
Auswahl* legt ein neues Thema zu gewählten Bauteilen an, *Speichern …*
schreibt die Datei zurück.

## Listen

- Bauteilliste (CSV), Fenster- und Türliste, SIA-416-Flächentabelle,
  IVHB-Kennzahlen, Raumprogramm Soll/Ist: CSV, SVG oder PDF; auch als
  Tabelle auf dem Layoutblatt.
- Linientypen (`.lin`) und Schraffurmuster (`.pat`) im AutoCAD-Format lassen
  sich in die Bibliothek laden.
