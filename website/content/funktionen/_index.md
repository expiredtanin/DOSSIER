---
title: "Funktionen"
description: "Was Dossier kann, nach Bereichen gegliedert, mit Stand: vorhanden oder teilweise."
---

Stand: 5. November 2026. **Teilweise** heisst: nutzbar, aber mit bekannten
Lücken; die genaue Liste führt die Arbeitsliste
[`TODO.md`](https://github.com/expiredtanin/DOSSIER/blob/master/TODO.md) (Nummern
in eckigen Klammern verweisen dorthin). Wie man die Funktionen bedient, steht in
der [Anleitung](/docs/anleitung/).

## Zeichnen 2D

- Linie, Polylinie mit Bögen, Rechteck, Kreis, Bogen, Ellipse, Vieleck,
  Spline, Bézier, Konstruktionslinie, Strahl, Parallellinien.
- Bearbeiten: Verschieben, Kopieren, Drehen, Spiegeln, Skalieren, Feld
  (Reihe/Polar), Versatz, Stutzen, Verlängern, Teilen, Unterbrechen, Verbinden,
  Verrunden, Fasen, Auflösen, Ausrichten.
- Texte (auch Textspalten und Text entlang eines Pfads) in Papiergrösse, die
  mit dem Massstab mitgehen; Vorführungspfeile; Revisionswolken;
  Maskenregionen; Massstabsbalken; Detail- und Schnittverweise; Punktmarken.
- Schraffuren und Füllungen, Zauberstab (Klick in eine geschlossene Fläche
  erzeugt den Umriss) – *teilweise* [77].
- Blöcke (Symbole) definieren und einfügen, Gruppen.
- Achsraster rechtwinklig oder radial mit Achsköpfen.
- Über 70 Befehle mit deutschen und englischen Kürzeln, getippte Koordinaten
  (`5,3`, `r5,3`, `5<45`), Fang, Griffe, Verlauf mit Sprung zu jedem früheren
  Schritt.

## Bauteile und Gebäudemodell

- **Wände** mit beliebig vielen Schichten aus Bauteil-Aufbauten, gerade und
  gebogen; L-, T- und X-Anschlüsse nach Priorität, auch schräg – *teilweise*
  bei Sonderfällen schräger Mehrschicht-Anschlüsse [108]. Wände lassen sich wie
  Linien stutzen, verlängern, teilen, verrunden und versetzen [113].
- **Fenster und Türen** als Typen (Bibliothek): Rahmen, Flügel, Sprossen,
  Oberlicht, Storenkasten, Anschlag, Leibung und Schichteinzug je Wandschicht;
  Türarten Dreh, Schiebe, Hebeschiebe, Pendel. Sehr viele Konstruktionsdetails
  sind vorhanden, einige noch *teilweise* [94]–[106].
- **Decken** mit Aussparungen, **Dächer** (Flach, Pult, Sattel, Walm, Zelt,
  Mansarde, Krüppelwalm) über beliebigen Grundrissen, auch mit Innenhöfen;
  **Gauben** (Schlepp, Sattel, Walm, Flach), **Dachfenster**, Dachhöfe.
- **Treppen** gerade, L-förmig und gewendelt, mit Podest und Geländer;
  **Stützen** mit Profil; **Räume** mit Raumstempel und Nutzung nach SIA 416.
- **Volumenkörper** (Extrusion, Rotation, Loft, Grundkörper) mit Booleans;
  **Abzugskörper** für Durchbrüche, Nischen und Schlitze, die von Wänden,
  Decken und Stützen abgezogen werden.
- Geschosse mit Bezugsgeschoss ±0.00, Untergeschosse mit negativen Koten [131].
- Standard-Baustoffe, Schraffuren und Linientypen in Anlehnung an SIA 400 und
  ISO 128 in neuen Projekten – *teilweise* [100]–[102].
- U-Wert aus dem Schichtaufbau (Rechnung nach EN ISO 6946).

## Grundriss, Deckenspiegel, Schnitt, Ansicht

- Grundriss je Geschoss, aus den Bauteilen berechnet; Referenzgeschosse;
  Darstellungsmodi (farbig, schwarz-weiss), Detailgrad grob/mittel/fein.
- **Deckenspiegel** (Untersicht) je Geschoss.
- **Ansichtsbereich** (View Range): Schnitthöhe, Oberkante, Unterkante,
  „darunter sichtbar bis“ – Bauteile darüber gestrichelt, darunter gepunktet –
  *teilweise* [36].
- **Schnitte und Ansichten** aus Schnitt- und Ansichtslinien, Verschneidung
  nach derselben Priorität wie im Grundriss, Gelände im Schnitt – *teilweise*
  [115], [132].
- **Ansichtsvorlagen**: Detailgrad, Massstab, Kategorien, Regeln,
  Darstellungsmodus und Ansichtsbereich als benannter Satz, einmal angewendet
  oder verknüpft – *teilweise* [34]. Mitgeliefert: „Präsentation“,
  „Eingabeplan 1:100“, „Ausführungsplan 1:50“ [66].
- **Ausschnitte**: gespeicherte Ansichten mit Massstab, Ebenen und Vorlage,
  in Ordnern, duplizierbar; Zeichnungs-Reiter unabhängig davon [136].
- Strichstärken in Papier-Millimetern, auf Wunsch nach Massstab skaliert;
  Stiftsätze, Regeln, die Farbe und Strichstärke nach Ebene oder Element
  überschreiben.

![Deckenspiegel Erdgeschoss mit Unterkanten der Räume](/img/cli-deckenspiegel-eg.webp)

## 3D

- Eigenes 3D-Fenster (render3d, auf dem Mac über Metal, sonst WebGPU) mit
  schattierter Darstellung, Kanten, Live-Schnitt und Kamera-Voreinstellungen.
- Explosionsaxonometrie: Geschosse auseinanderziehen – *teilweise* [65].
- Zulässige Bauhülle im 3D [63]; Punktwolken anzeigen – *teilweise* [27].
- Schatten im 3D fehlt noch (im Grundriss vorhanden) [64].

## Layout, Publikation, PDF

- Layoutblätter mit beliebig vielen Ansichtsfenstern in eigenem Massstab;
  gezeichnet wird auf dem Blatt genau wie im Grundriss [93].
- Masterlayouts mit Rahmen und Plankopf; Autotext (Projekt, Blatt,
  Massstab, Datum, Plannummer, Index) [78].
- Grafische Legenden aus den gezeigten Materialien und Linientypen [82];
  Tabellen auf dem Blatt (Fenster-/Türliste, Flächen, Raumprogramm,
  Bauteile) [111].
- Vektor-PDF mit schaltbaren Ebenen [80]; ganze Plansätze.
- **Publikationssätze**: Blätter in Reihenfolge, PDF (einzeln oder
  mehrseitig) oder DXF/DWG, Dateinamen-Muster, Index hochzählen,
  Publikationsprotokoll – *teilweise* [79].

![Layoutblatt „Grundrisse UG / EG“ mit zwei Ansichtsfenstern und Legende](/img/app-layout-blatt.webp)

## Bemassung

- Lineare Bemassung und Ketten, Radius-, Durchmesser- und Bogenmass,
  Höhenkoten.
- **Assoziativ**: an Bauteilen gefangene Punkte folgen dem Modell; verlorene
  Bezüge werden markiert, „Bemassung lösen“ macht sie frei [38].
- **Automatische Aussenbemassung**: Öffnungs-, Vor-/Rücksprung- und
  Gesamtkette je Fassade, auch an schiefen Fassaden – *teilweise* [81].

## Baurecht, Lage, Sonne

- Parzelle und Baulinien aus der Zeichnung, Grenzabstände pauschal und je
  Kante, Gesamthöhe, Vorsprünge; zulässige Fläche und Verstösse im Grundriss,
  zulässige Hülle im 3D [63].
- Sonnenstand und Schattenwurf im Grundriss mit Zeitregler, auch im PDF und
  in der Kommandozeile – *teilweise*: Schatten im 3D fehlt [64].
- Georeferenz in LV95, Bezugspunkt setzen; swisstopo (Gelände, Gebäude,
  Orthofoto) und OpenStreetMap als Kontext.

## Gelände

- Gelände aus Höhenlinien oder Punkten (Triangulation mit Bruchkanten) –
  *teilweise* [T6].
- **Baugrube**: Sohle, Böschung je Kante, Schüttung, Bermen; dasselbe Objekt
  trägt ab und schüttet auf; Mengen – *teilweise* [68].

![Situation 1:500 mit Höhenlinien, Parzellen und Schattenwurf](/img/app-situation.webp)

## Import und Export

| Format | Import | Export |
|---|---|---|
| DXF, DWG | ja (R12–2018, auch grosse Kataster) | ja, mit Layouts |
| IFC | ja, als Kontext oder als Bauteile (*teilweise* [B4]) | IFC4 und IFC2x3, mit Schichten, Öffnungen, Räumen, Georeferenz |
| STEP | ja | ja (B-Rep, in mm) |
| OBJ, STL, glTF/GLB, PLY | ja | ja (ohne PLY) |
| PDF | Vektoren (mit Fang, *teilweise* [76]) und als Bild | Plan und Plansatz, mit Ebenen |
| Punktwolken (LAS/LAZ, E57, PLY, XYZ) | Anzeige im 3D (*teilweise* [27]) | – |
| SVG, CSV | – | Plan, Bauteil-, Flächen- und Öffnungslisten |
| BCF | Themen lesen (Panel BCF) | – |

Das eigene Format ist `.obp` (JSON, versioniert; ältere Dateien werden beim
Öffnen migriert).

## Kennzahlen und Listen

- Flächenbilanz nach SIA 416 (HNF, NNF, VF, FF, NGF, KF, GF, AGF, GV) je
  Geschoss und total [70]; Kennzahlen nach IVHB (GFZ, AZ, BMZ, ÜZ, GZ).
- Raumprogramm Soll/Ist, auch aus einer Tabelle importiert [61].
- Fenster- und Türliste mit automatischer Nummerierung [97]; Bauteilliste
  mit U-Wert [71].
- Kollisionsprüfung zwischen Bauteilen (Panel Kollision).

## Darstellung und Präsentation

- **Skizzenstil**: Linien leicht gebogen und an Ecken überzogen, für
  Bildschirm, SVG und PDF gleich – *teilweise* [67].
- Präsentationsvorlage mit Farbe und Schatten [66]; Materialien mit
  Texturen (ambientCG, CC0) im 3D.
- Farbmanagement mit ICC-Profilen (macOS).

![Ansicht Süd mit Materialien und Schraffuren](/img/cli-ansicht-sued.webp)

## Automatisierung

- `dossier-cli`: derselbe Kern ohne Fenster – Pläne als SVG, Exporte,
  Kennzahlen, Listen, Sonnenstand, Konvertierung, Befehle per Skript
  ([Kommandozeile](/docs/anleitung/kommandozeile/)).
- KI-Zugriff über MCP, auf eine Datei oder das offene Projekt (ausdrücklich
  einzuschalten, nur lokal); jede Änderung ist ein eigener Undo-Schritt.
