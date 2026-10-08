---
title: "Export & Import"
linkTitle: "Export & Import"
weight: 5
---

## Export

| Format | Details |
|---|---|
| **PDF** | Vektor-Export, Einzelblatt oder Mehrseiten-Layouts, echte mm-Stiftstärken statt Bildschirm-Hairlines |
| **DXF** | eigener DXF-Writer |
| **IFC4** | eigener IFC4-Writer, mit echten Fenster-/Tür-Löchern in den Bauteilen |
| **STL / OBJ** | Mesh-Export für 3D-Druck bzw. weitere 3D-Programme |
| **CSV** | Bauteilliste, sowie SIA-416-Flächenbilanz separat |

PDF und die 2D-Formate sind **derselbe Plan** wie im Grundriss — nicht ein
zusätzlich gerendertes Bild, sondern dieselbe analytische Geometrie mit
Norm-Strichstärken.

## Import

- **DXF/DWG** — Lesen funktioniert; das Mapping der Entitäten auf echte
  Wände/Öffnungen ist noch unbegonnen (Import landet aktuell als
  Referenzgeometrie, nicht als Bauteile) — s.
  [Bekannte Einschränkungen](../troubleshooting/)
- **Bild / PDF** — Werkzeug „Bild/PDF": Rasterbilder direkt, PDF-Seiten
  werden gerendert und als Bild eingebettet; landet als normales
  Bild-Element im Plan oder Layout
- **Swisstopo** — swissBUILDINGS3D, swissALTI3D (Terrain), SWISSIMAGE
  (Luftbild), radiusgenau um den Projektstandort zugeschnitten
- **OSM-Kontext** — Umgebungsgebäude/-strassen aus OpenStreetMap als
  Referenz
- **`.lin` / `.pat`** — eigene Parser für Linientypen und Schraffurmuster

STL/OBJ sind aktuell **nur Export**-Formate, kein Re-Import in DOSSIER.

## Geo-Referenzierung

Ein Projekt kann an einem **Vermessungspunkt** (E/N/H, Schweizer
Landeskoordinaten) verankert werden. Das Terrain nutzt reale Höhen, das
Gebäude selbst bleibt bei z = 0 — kein Höhen-Versatz beim Export.
