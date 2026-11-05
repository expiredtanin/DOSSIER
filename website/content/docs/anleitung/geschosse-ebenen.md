---
title: "Geschosse und Ebenen"
linkTitle: "Geschosse und Ebenen"
weight: 6
---

Dossier ordnet ein Projekt in zwei Richtungen: **Zeichnungsebenen** (Wo? –
Geschosse, Schnitte, Ansichten, Details) und **Kategorie-Ebenen** (Was? –
Wände, Decken, Möblierung, Beschriftung …). Das kennt man aus ArchiCAD und
aus dem früheren Rhino-Plugin.

## Zeichnungsebenen

Das Panel **Zeichnungsebenen** listet alle Ebenen nach Art; die Knöpfe unten
legen neue an:

| Art | Inhalt |
|---|---|
| **Geschoss** | Bauteile und 2D-Elemente eines Stockwerks; daraus der Grundriss. |
| **Deckenspiegel** | Untersicht eines Geschosses („Deckenspiegel von …“). |
| **Schnitt** | Schnitt durch das Modell entlang einer Schnittlinie. |
| **Ansicht** | Fassadenansicht entlang einer Ansichtslinie. |
| **Zeichnung** | Reine 2D-Ebene, etwa ein Detail 1:10; ohne Höhen. |

Doppelklick oder *Einstellungen …* im Kontextmenü öffnet den Editor einer
Ebene. Für Geschosse:

- **Geschosshöhe** – von Oberkante fertig Boden bis zum nächsten Geschoss.
  Die Höhen der Geschosse stapeln sich daraus.
- **OK fertig Boden** – die Höhe relativ zu ±0.00, direkt eintippbar.
- **Schnitthöhe** – auf welcher Höhe der Grundriss geschnitten wird
  (üblich 1.00–1.20 m).
- **Ansichtsbereich** – *Oberkante Sicht*, *Unterkante Sicht*, *Darunter
  sichtbar bis*, siehe [Ansichten](../ansichten/#ansichtsbereich).
- **Bezug ±0.00** – siehe unten.
- Vorlage, Detailgrad, Massstab und Skizzenstil der Ansicht.

Schnitte und Ansichten haben stattdessen eine **Sichttiefe**: wie weit hinter
der Schnittebene Bauteile noch gezeichnet werden.

### ±0.00 und Untergeschosse

Genau ein Geschoss trägt das Kennzeichen **Bezug ±0.00** – üblicherweise
das Erdgeschoss. Geschosse darunter erhalten negative Koten: Ändert man die
Höhe des Untergeschosses, wächst es nach unten, statt das Erdgeschoss
anzuheben. Ohne Kennzeichen ist das unterste Geschoss der Bezug (so verhalten
sich ältere Dateien) [131]. Die absolute Höhe von ±0.00 über Meer stellt man
unter *Einstellungen → Projekt* ein; sie gilt für Koten, Gelände und IFC.

### Referenzgeschosse

Ein Geschoss kann andere Geschosse grau im Hintergrund zeigen – etwa das EG
unter dem OG zum Abgleich der Tragstruktur. Bauteile lassen sich ausserdem an
ein **Referenzgeschoss** binden: Eine Wand im EG mit „An oberes Geschoss
binden“ folgt der Höhe des OG.

## Kategorie-Ebenen

Das Panel **Ebenen** zeigt die Kategorie-Ebenen mit Nummer und Namen
(Wände, Decken, Dächer, Treppen, Gelände, Kontext, Beschriftung …). Bauteil-Befehle legen ihre
Elemente automatisch auf die passende Ebene, 2D-Elemente landen auf der
aktiven Ebene.

Je Ebene: sichtbar, gesperrt, drucken ja/nein, Farbe, Stift, Linienstärke,
Schraffur. Unterebenen sind möglich. Rechtsklick: Ebene ausblenden, *Nur
Ebene zeigen* (isolieren), Auswahl auf eine Ebene übertragen.

## Kombinationen

In der Ansichtsleiste oben speichert man Sichtbarkeiten als Satz:

- **Ebenen-Kombination** – welche Kategorie-Ebenen sichtbar sind, z. B.
  „Eingabeplan“, „Tragwerk“, „Möblierung“.
- **Zeichnungs-Kombination** – welche Zeichnungsebenen gemeinsam sichtbar
  sind.

*＋ Aktuelle speichern …* legt eine Kombination aus dem jetzigen Zustand an;
Ausschnitte und Ansichtsfenster auf Layoutblättern merken sich ihre
Kombination.

## Regeln (Overrides)

**Regeln** überschreiben Farbe, Strichstärke oder Füllung nach Ebene oder
Element – etwa für einen Brandschutz- oder Tragwerksplan (im Musterhaus:
Ausschnitt „EG Brandschutz“). Sie werden in Ausschnitten und
Ansichtsvorlagen aktiviert.
