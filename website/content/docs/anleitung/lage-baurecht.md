---
title: "Lage, Baurecht, Gelände"
linkTitle: "Lage, Baurecht, Gelände"
weight: 10
---

Dossier rechnet in Schweizer Landeskoordinaten (LV95, EPSG:2056) und bringt
Werkzeuge für die frühe Phase mit: Standort laden, Gelände, Baurecht der
Parzelle, Sonne und Schatten. Alles findet sich im Panel **Lage**.

![Situation 1:500: Höhenlinien, Parzellen, Baulinien und Schattenwurf](/img/app-situation.webp)

## Georeferenz und Nullpunkt

Intern liegt das Projekt nahe am Nullpunkt (genauer und schneller); ein
**Bezugspunkt** verbindet ihn mit der echten Lage:

- **Standort importieren** setzt den Bezugspunkt beim ersten Import
  (Ost/Nord in LV95 und Höhe in m ü. M.), oder man trägt ihn von Hand ein –
  ähnlich dem Vermessungspunkt in ArchiCAD.
- **Neuer Bezugspunkt** (`bezugspunkt`, `nullpunkt`): Klick im Grundriss
  verschiebt das ganze Projekt so, dass dieser Punkt der neue Nullpunkt wird.
- Die Höhe von ±0.00 über Meer steht unter *Einstellungen → Projekt*.
- Export: IFC mit Kartenbezug (IfcMapConversion, EPSG:2056), DXF/DWG auf
  Wunsch in Landeskoordinaten.

## Standort importieren

*Fenster → Standort importieren* oder im Panel *Lage*:

1. **Ort oder Adresse** suchen (z. B. „Bundesplatz Bern“), **Radius** wählen.
2. **Quellen** ankreuzen:
   - **swisstopo:** Gelände (Höhenraster mit wählbarer Auflösung und
     Glättung), Gebäude (vereinfacht als Umriss oder detailliert),
     SWISSIMAGE-Luftbild als 2D-Hintergrund oder aufs Gelände gelegt (3D);
   - **OpenStreetMap:** Gebäude, Strassen, Wasser, Grün, Wald, Parkplätze,
     Bahn.
3. **Importieren**. Die Daten landen als **Kontext** auf eigenen Ebenen
   (Gelände, Kontext, Luftbild …); sie sind keine Bauteile und gehen nicht
   in die Mengen ein.

Für den Abruf braucht Dossier Netz. Im **Offline-Modus** (Einstellungen)
ist jeder Netzzugriff gesperrt; alle Abrufe laufen über eine Stelle mit einer
festen Liste erlaubter Server.

## Kataster und Pläne

Katasterpläne und Vermessungsdaten kommen meist als **DXF oder DWG** in
Landeskoordinaten. Beim Import erkennt Dossier grosse Koordinaten und
verschiebt sie an den Bezugspunkt; die Ebenen der Datei bleiben
erhalten. Siehe [Import und Export](../export-import/#dxf-und-dwg).

## Gelände

- **Gelände aus Höhenlinien:** DXF mit Höhenlinien importieren (Panel
  *Lage* → *DXF importieren*), dann **Gelände erzeugen** (Befehl `ter`).
  Dossier trianguliert mit den Höhenlinien als Bruchkanten und behebt flache
  Dreiecke auf Kuppen und in Mulden (*Glätten*) [T6].
- Darstellung: Äquidistanz, Zähllinie, glatt schattiert mit Knickwinkel.
- Im **Schnitt** erscheint das Gelände mit Erdreich-Band und Schraffur; die
  Breite des Bands ist einstellbar.
- Gelände aus swisstopo kommt als Höhenraster dazu.

*Teilweise:* sehr grosse oder unsaubere Höhenlinien-Sätze brauchen manchmal
Nacharbeit.

## Baugrube

**Befehl:** `baugrube` / `aushub` [68].

1. Umriss der **Sohle** zeichnen.
2. In der Objekt-Info: Sohle (Höhe in m bezogen auf ±0.00), **Böschung** in
   Grad (Standard 45°, je Kante anders möglich), **Schüttung** in Grad,
   **Bermen** (Breite und Höhenabstand), **Arbeitsraum**, **Verbau** je Kante
   (senkrecht statt Böschung, etwa Spundwand).
3. Die Baugrube schneidet das Gelände ein und schüttet, wo das Gelände tiefer
   liegt, auf – am Hang also beides.

Die Objekt-Info zeigt **Abtrag, Auftrag und Hinterfüllung** in m³.
*Teilweise:* Einzelheiten der Geländebearbeitung werden noch ausgebaut.

## Baurecht der Parzelle

Im Panel *Lage* unter **Baurecht der Parzelle** [63]:

1. Parzellengrenze als geschlossene Polylinie wählen (etwa aus dem
   Kataster) → **Parzelle aus Auswahl**.
2. **Grenzabstand** pauschal und je Kante, **Gesamthöhe max.**.
3. **Baulinien** aus gewählten Linien; das Gebäude bleibt auf der
   Parzellenseite.
4. **Vorsprünge**: zulässige Tiefe (über Abstand oder Baulinie) und Anteil
   der Fassadenlänge. Geprüft werden Dachvorsprünge und Bauteile, die als
   Vorsprung markiert sind (*Auswahl ist Vorsprung*, z. B. Balkon, Erker).
5. **Gebäudeprofil**: Profilwinkel und Profilhöhe an der Grenze – die
   zulässige Höhe steigt von jeder Grenze und Baulinie an.

Dossier zeigt im Grundriss die **zulässige Fläche** und Verstösse, meldet
Parzellenfläche, zulässige Fläche, Gebäude ausserhalb, Höhe gegen Maximum
(gemessen ab dem massgebenden Terrain an der Fassade) und das Gebäudeprofil.
Die **zulässige Hülle** erscheint auf Wunsch im 3D; Überschreitungen rot.

Die Regeln bilden typische Schweizer Bauordnungen vereinfacht ab. Sie
ersetzen die Prüfung nach der geltenden kommunalen Bau- und Zonenordnung
nicht.

## Sonne und Schatten

Im Panel *Lage* unter **Sonne** [64]:

- **Schatten im Grundriss zeigen**, Datum und **Uhrzeit** mit Regler;
  Schnellwahl Tagundnachtgleiche, Sommer- und Wintersonnenwende.
- Angezeigt werden Sonnenstand (Azimut, Höhe) und der Schattenwurf im
  Grundriss.
- Ohne Georeferenz rechnet Dossier mit dem Standort Zürich.
- Der Schatten erscheint auch im PDF und in der Kommandozeile
  (`dossier-cli … sun`).

*Teilweise:* Schatten im 3D fehlt noch.
