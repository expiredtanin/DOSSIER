---
title: "Ansichten"
linkTitle: "Ansichten"
weight: 7
---

Alle Ansichten werden aus dem Modell berechnet. Man zeichnet einen Grundriss,
einen Schnitt oder eine Ansicht nie nach – man stellt nur ein, *wie* sie
gezeichnet werden.

## Grundriss

Der Grundriss eines Geschosses entsteht aus den Bauteilen: Wandachse und
Schichten ergeben Kanten und Füllungen, Öffnungen ergeben Lücke, Leibung und
Symbol, Treppen ihre Stufen und die Lauflinie. Was über der Schnitthöhe liegt,
wird nach dem Ansichtsbereich gestrichelt oder weggelassen.

In der Ansichtsleiste:

- **Detailgrad** *grob*, *mittel*, *fein*: grob zeigt Wände als Umriss mit
  Füllung, fein alle Schichten, Rahmen, Flügel und Anschläge. Einzelne
  Öffnungen können eine eigene Detailstufe haben.
- **Darstellung** *Farbig*, *Schwarz-Weiss*, und weitere Arten je nach
  Ansicht.
- **Massstab**: Er bestimmt die Grösse von Texten, Koten und Symbolen und –
  wenn *Strichstärken nach Massstab* eingeschaltet ist – die Strichstärken.
  „frei …“ erlaubt jeden Massstab, etwa 1:35.
- **Referenzlinien** (Wandachsen) ein und aus.

In der Statusleiste schaltet **Display/Print** zwischen ruhigen Haarlinien
zum Arbeiten und echten Strichstärken in Millimetern wie im Druck.

![Grundriss EG 1:100 aus der Kommandozeile, mit Schraffuren](/img/cli-grundriss-eg.webp)

## Ansichtsbereich

Wie in Revit oder ArchiCAD bestimmt der **Ansichtsbereich** eines Geschosses,
was gezeichnet wird [36]. Eingabe im Geschoss-Editor, Höhen in Metern über
Oberkante fertig Boden:

| Feld | Wirkung |
|---|---|
| **Schnitthöhe** | Bauteile, die diese Höhe schneiden, werden geschnitten gezeichnet (kräftig, mit Schraffur). |
| **Oberkante Sicht** | Bauteile zwischen Schnitthöhe und Oberkante erscheinen gestrichelt („über Schnitt“), z. B. Oberlichter, Unterzüge. Darüber: nichts. |
| **Unterkante Sicht** | Bauteile unter der Schnitthöhe bis zu dieser Höhe erscheinen in Ansicht. |
| **Darunter sichtbar bis** | Bauteile unter der Unterkante bis zu dieser Höhe erscheinen gepunktet, etwa ein tieferliegender Hof. |

Ohne Eingaben bleibt alles wie gewohnt. Der Ansichtsbereich wirkt auf Wände
mit ihren Öffnungen, Stützen, Treppen, Decken, Dächer und Körper. *Teilweise:*
noch nicht alle Bauteilarten haben jede Zone.

## Deckenspiegel

Ein **Deckenspiegel** zeigt die Untersicht eines Geschosses: Raumumrisse mit
Unterkante der Decke („UK +2.53“), Wände geschnitten, Öffnungsstürze.
Anlegen über *+ Deckenspiegel* im Panel *Zeichnungsebenen*.

![Deckenspiegel Erdgeschoss](/img/cli-deckenspiegel-eg.webp)

## Schnitte und Ansichten

1. **Schnittlinie** (`schnittlinie`) bzw. **Ansichtslinie**
   (`ansichtslinie`): Start- und Endpunkt im Grundriss klicken. Die Option
   *Art* wechselt zwischen Schnitt und Ansicht. Der Pfeil zeigt die
   Blickrichtung (senkrecht zur Linie).
2. Dossier legt eine neue Zeichnungsebene „Schnitt B“ bzw. „Ansicht B“ an
   und zeichnet die Schnittlinie mit Kennzeichnung im Grundriss.
3. Öffnen wie jede Ansicht: Panel *Zeichnungsebenen* oder als Ausschnitt.

Schnitte verschneiden die Bauteile nach derselben Priorität wie der Grundriss:
Schichten laufen korrekt durch, Decken stossen an Wände, Dachaufbauten werden
geschnitten. Das Gelände erscheint im Schnitt mit Schraffur. Die **Sichttiefe**
begrenzt, wie weit hinter der Schnittebene Bauteile noch gezeichnet werden.

Ansichten zeigen Materialien und Schraffuren der Oberflächen (Putz, Ziegel,
Holzschalung …), Fenster mit Rahmen und Sprossen, Achsraster.

Man kann in Schnitten und Ansichten zeichnen und bemassen; diese 2D-Elemente
gehören zur Schnitt-Ebene. Aus Schnitt und Ansicht wechselt man auch direkt
ins 3D. *Teilweise* [115], [132]: einige Darstellungen (etwa Stirnbänder von
Flachdächern, Sonderfälle bei Dächern) werden noch verfeinert.

![Schnitt A-A](/img/cli-schnitt-aa.webp)

## 3D

Die Knöpfe oben in der Ansichtsleiste wechseln zwischen **Grundriss**,
**Perspektive** und **Axonometrie**; das Menü *Ansichten* bietet Vorne,
Hinten, Links, Rechts, Oben und Isometrie.

- **Darstellung:** schattiert, schattiert mit Kanten, weiss, nur Konturen,
  texturiert, Drahtgitter, verdeckte Kanten.
- **Schnitt im 3D:** eine Schnittebene durch das Modell, live.
- **Explosionsaxonometrie:** Knopf unten rechts im 3D-Fenster, mit Abstand;
  hebt jedes Geschoss um den Abstand an. Abzugskörper wandern mit
  *(teilweise [65])*.
- **Zulässige Hülle** aus dem Baurecht kann im 3D erscheinen (Panel *Lage*).
- Auswahl und Griffe funktionieren auch im 3D; Ziehen mit Fang ist dort
  *teilweise*.

Das 3D läuft auf dem Mac nativ über Metal, sonst über WebGPU. Ohne WebGPU
bleibt das 3D-Fenster leer und zeigt einen Hinweis; Grundriss, Schnitt und
Ansicht funktionieren weiter.

## Ausschnitte

Ein **Ausschnitt** speichert eine Ansicht: Zeichnungsebene, Zoom,
Massstab, Ebenen- und Zeichnungs-Kombination, Regeln, Vorlage, Detailgrad.
Ausschnitte sind die Bausteine der Layoutblätter. Bedienung im Panel
*Ausschnitte*:

- **+** legt einen Ausschnitt aus der aktuellen Ansicht an; Ordner ordnen sie.
- Klick zeigt ihn im aktiven Reiter, Doppelklick oder **↗** öffnet einen
  neuen Reiter.
- **Ausschnitt aktualisieren** übernimmt die aktuelle Ansicht in den
  Ausschnitt – nur dann ändert er sich.
- **⧉** dupliziert ihn (als „… Kopie“), ✎ benennt ihn um, × löscht ihn.

Mehr zur Trennung von Reitern und Ausschnitten: [Oberfläche](../oberflaeche/#zeichnungs-reiter-und-ausschnitte).

## Ansichtsvorlagen

Eine **Ansichtsvorlage** fasst Einstellungen zusammen: Detailgrad, Massstab,
Kategorien, Regeln, Darstellungsart, Schwarz-Weiss, Schatten, verdeckte
Kanten, Strichstärken-Skalierung, Ansichtsbereich und Skizzenstil [34].

- Verwaltung im Ressourcen-Manager unter *Ansichtsvorlagen*: neu aus der
  aktiven Ansicht, duplizieren, umbenennen, löschen.
- Eine Vorlage wird an eine Zeichnungsebene oder einen Ausschnitt
  **einmal angewendet** oder **verknüpft**. Verknüpfte Ansichten folgen jeder
  Änderung der Vorlage, in einem Undo-Schritt.
- Neue Projekte bringen drei Vorlagen mit [66]: **Präsentation** (farbig, mit
  Schatten, ohne Referenzen und Konstruktionslinien), **Eingabeplan 1:100**
  und **Ausführungsplan 1:50** (schwarz-weiss, feine Linien, Strichstärken nach
  Massstab).

## Skizzenstil

Der Schalter **Skizze** (Ansichtsleiste, Geschoss-Editor oder Vorlage)
zeichnet Grundriss, Schnitt und Ansicht wie von Hand: Linien leicht gewellt,
an Ecken überzogen, kräftige Striche doppelt. Flächen, Schraffuren und Text
bleiben ruhig. Der Effekt ist bei jedem Neuzeichnen gleich und erscheint
genauso im PDF und SVG [67] *(teilweise)*.

![Ansicht Süd im Skizzenstil](/img/cli-ansicht-skizze.webp)

## Schatten

Im Grundriss lässt sich der Schattenwurf für Datum und Uhrzeit einblenden
(Panel *Lage* → Sonne). Siehe [Lage, Baurecht, Gelände](../lage-baurecht/#sonne-und-schatten).
