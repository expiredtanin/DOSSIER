---
title: "DOSSIER"
description: "Dossier ist ein quelloffenes CAD für Architektur: ein Gebäudemodell aus Bauteilen, aus dem Grundriss, Schnitt, Ansicht, 3D und Planblätter berechnet werden. Für die Praxis in der Schweiz, AGPL-3.0."
---

Dossier ist ein CAD-Programm für Architektinnen und Architekten. Man modelliert
ein Gebäude aus Bauteilen – Wände, Decken, Dächer, Treppen, Fenster, Türen,
Räume – und erhält daraus Grundrisse, Deckenspiegel, Schnitte, Ansichten, ein
3D-Modell, Mengen und fertige Planblätter. Dazu kommt ein vollwertiges
2D-Zeichenprogramm mit Befehlszeile, wie man es von AutoCAD oder Rhino kennt.

![Dossier mit dem Musterhaus: Grundriss Erdgeschoss 1:100, links die Werkzeuge, rechts Objekt-Info und Ausschnitte](/img/app-grundriss.webp)

## Ein Modell, alle Pläne

Es gibt genau ein Modell. Alles andere wird daraus abgeleitet und nie von Hand
nachgeführt: Verschiebt man eine Wand, stimmen Grundriss, Schnitt, Ansicht, 3D,
Flächenbilanz, Fenster- und Türliste und IFC sofort wieder. Bemassungen, die
an Bauteilen gefangen wurden, wandern mit.

Der Grundriss wird nicht aus einem 3D-Netz geschnitten, sondern aus den
Bauteilen berechnet: Wandachse und Schichten ergeben Linien und Füllungen,
Öffnungen ergeben Lücke, Leibung und Symbol. Strichstärken, Schraffuren und
Detailgrad kommen erst beim Zeichnen dazu – das PDF ist derselbe Plan wie am
Bildschirm, mit echten Stiftstärken in Millimetern.

![Schnitt A-A aus dem Musterhaus, mit Schraffuren der Schichten und Gelände](/img/cli-schnitt-aa.webp)

## Für wen

- **Architekturbüros in der Schweiz:** Landeskoordinaten LV95, Daten von
  swisstopo, Kataster als DWG/DXF, Flächen nach SIA 416, Kennzahlen nach IVHB,
  Darstellung in Anlehnung an SIA 400 (Baustoffe, Schraffuren, Linientypen).
- **Wettbewerb bis Ausführung:** Baurecht und Lage prüfen, Massenmodelle und
  Raumprogramm, Eingabepläne 1:100, Ausführungspläne 1:50, Plansätze als PDF,
  DXF/DWG und IFC für die Fachplaner.
- **Wer offene Werkzeuge will:** Dossier ist freie Software unter der
  AGPL-3.0. Das Dateiformat `.obp` ist offenes JSON, die Kommandozeile
  `dossier-cli` erzeugt Pläne und Exporte ohne Fenster.

## Was es kann

- **Bauteile:** mehrschichtige Wände (auch gebogen) mit sauberen Anschlüssen,
  Fenster und Türen mit Typen, Anschlag und Leibung, Decken mit Aussparungen,
  Dächer über beliebigen Grundrissen mit Gauben und Dachfenstern, Treppen,
  Stützen, Räume, Volumenkörper.
- **Pläne:** Grundriss je Geschoss, Deckenspiegel, Schnitte und Ansichten aus
  Schnittlinien, Ansichtsbereich, Detailgrad, Ansichtsvorlagen, Skizzenstil.
- **Layout:** Blätter mit Ansichtsfenstern, Masterlayouts mit Plankopf,
  Legenden, Tabellen, Publikationssätze mit Index, Vektor-PDF mit Ebenen.
- **Ort:** Georeferenz, Gelände aus Höhenlinien, Baugrube, Baulinien und
  Grenzabstände, Sonnenstand und Schatten.
- **Austausch:** DXF/DWG, IFC4/IFC2x3, STEP, OBJ/STL/glTF, PDF, SVG, CSV.

Alle Funktionen, gegliedert und mit ehrlichem Stand: [Funktionen](/funktionen/).

![Ansicht Süd im Skizzenstil](/img/cli-ansicht-skizze.webp)

## Stand

Dossier ist in aktiver Entwicklung und noch vor der ersten öffentlichen Beta.
Es gibt keine fertigen Installer; man baut es aus dem Quellcode
([Download und Installation](/download/)). Hauptplattform ist macOS (Tauri,
Anzeige über Metal), Linux läuft über Electron. Was fertig ist und was nicht,
steht unter [Stand](/stand/).

## Weiter

- [Anleitung](/docs/anleitung/) – Bedienung, Schritt für Schritt
- [Für Entwickler](/docs/entwickler/) – Aufbau, Bauen, Testen, Mitarbeiten
- [Quellcode auf GitHub](https://github.com/expiredtanin/DOSSIER) – Issues,
  Pull Requests, Arbeitsliste `TODO.md`

## Lizenz

© 2026 Karim Gabriele Varano, veröffentlicht unter der
[GNU Affero General Public License v3.0 oder später](https://github.com/expiredtanin/DOSSIER/blob/master/LICENSE).
Wer Dossier verändert und als Netzwerkdienst anbietet, muss den geänderten
Quellcode ebenfalls offenlegen. Fremdkomponenten behalten ihre Lizenzen
(siehe [`NOTICE`](https://github.com/expiredtanin/DOSSIER/blob/master/NOTICE)).
Dossier ist Teil von [openbureau](https://openbureau.ch) und entstand aus dem
gleichnamigen Rhino-Plugin.
