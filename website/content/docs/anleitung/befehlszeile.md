---
title: "Befehlszeile"
linkTitle: "Befehlszeile"
weight: 3
---

Jedes Werkzeug ist ein Befehl. Man startet ihn mit der Maus (Panel
*Werkzeuge*), mit einer Taste (siehe [Tastenkürzel](../tastenkuerzel/)) oder
getippt in der **Befehlszeile** unter der Zeichenfläche – wie in AutoCAD oder
Rhino. **Tab** setzt den Cursor in die Befehlszeile; während eines Befehls
landen getippte Zahlen ohnehin direkt dort. Einzelne Buchstaben und Ziffern
ohne Fokus in der Befehlszeile sind dagegen Tastenkürzel (`m` Verschieben,
`6` Wand …).

## Befehl starten

- Befehlsnamen oder Kürzel tippen, Enter. Deutsche und englische Namen
  funktionieren (`w`, `wand`, `wall`).
- Beim Tippen schlägt die Befehlszeile passende Befehle vor; Tab übernimmt
  den Vorschlag.
- **Enter oder Leertaste ohne Eingabe** wiederholt den letzten Befehl.
- Eigene Kürzel legt man unter *Einstellungen → Allgemein →
  Befehlszeilen-Kürzel* an.

`wand` startet die **Wand**; der Zauberstab heisst `zauberstab` (Kürzel `zs`).
Den Einzelbuchstaben `r` gibt es absichtlich nicht: er ist für relative
Koordinaten reserviert.

## Während eines Befehls

Die Befehlszeile zeigt, was der Befehl gerade erwartet („Startpunkt der
Wand:“), dazu **Optionen** und **Felder**.

- **Optionen** (etwa *Bogen*, *Schliessen*, *Zurück*, *Grundform*) wählt man
  per Klick oder indem man das Wort bzw. seinen Anfang tippt.
- **Felder** (Länge, Winkel, Dicke, Breite, Brüstung …): **Tab** springt ins
  nächste Feld, der getippte Wert wird festgehalten (gesperrt), die Maus
  bestimmt den Rest. So zeichnet man etwa eine 4.20 m lange Wand in
  beliebiger Richtung: Länge `4.2`, Tab, Richtung mit der Maus.
- **Enter**, **Leertaste** oder **Rechtsklick** bestätigt: einen Schritt, die
  Vorgabe oder das Ende eines mehrteiligen Befehls (Wandzug, Polylinie).
- **Esc** bricht ab – in jedem Befehl gleich.
- **Zurück** (Option) nimmt den letzten Punkt im laufenden Befehl zurück.

## Koordinaten

Punkte lassen sich klicken oder tippen. Einheit ist der Meter (auf einem
Layout-Blatt Millimeter auf dem Papier). Dezimalpunkt und -komma gehen beide.

| Eingabe | Bedeutung |
|---|---|
| `5,3` | absoluter Punkt X = 5, Y = 3 |
| `5,3,2` | wie oben; Z wird im 2D ignoriert |
| `r5,3` | relativ zum letzten Punkt: 5 nach rechts, 3 nach oben |
| `5<45` | polar: 5 m unter 45° vom letzten Punkt |
| `<45` | nur den Winkel festhalten; die Länge folgt der Maus |
| `5` | nur die Länge: 5 m in Richtung der Maus |

Winkel zählen in Grad gegen den Uhrzeigersinn ab der positiven X-Achse.

## Fang

Der **Fang** (Statusleiste, Knopf *Fang* mit ▲ für die Einstellungen)
greift auf: Endpunkt, Mittelpunkt, Kreismitte und Quadranten, Schnittpunkt,
Lot auf Kante, senkrecht zum letzten Punkt, tangential, parallel zu einer
Referenz (kurz auf einer Linie verweilen), Raster, Teilpunkte entlang einer
Kante und gängige Winkel. Bauteile fangen mit: Wandecken, Leibungen,
Achsen, Stützen, Raumecken.

- **Shift** gedrückt halten erzwingt Ortho (0°/90° bzw. das Winkelraster).
- Das Raster (Weite, Anzeige) und das Winkelraster stellt man in denselben
  Fang-Einstellungen ein.
- Auf einem Layout-Blatt fängt man auch auf den Inhalt der Ansichtsfenster.

## Griffe

Gewählte Elemente zeigen **Griffe**: Endpunkte, Mittelpunkte, Eckpunkte,
Wandenden, Öffnungsränder, Dachgauben, Textrahmen. Ziehen ändert direkt; beim
Ziehen gelten Fang und getippte Werte wie in einem Befehl. Rechtsklick auf
einen Punkt einer Polylinie fügt Punkte ein, löscht sie oder macht sie zu
Bogen- oder Splinepunkten.

## Verlauf

Jeder Befehl ist ein Schritt im **Verlauf** (Panel *Verlauf*): Cmd/Strg+Z
nimmt ihn zurück, Cmd/Strg+Shift+Z (oder Strg+Y) stellt ihn wieder her, ein
Klick im Panel springt zu einem beliebigen früheren Stand. Schieberegler und
Tippen in der Objekt-Info fassen zusammenhängende Änderungen zu einem Schritt
zusammen.

## Alle Befehle

Stand 5.11.2026, aus der Befehlsliste des Programms (`src/commands/registry.ts`).
„Befehl“ ist der interne (englische) Name, der ebenfalls getippt werden kann.

### Bauteile

| Befehl | Name | Kürzel | Wirkung |
|---|---|---|---|
| `wall` | Wand | `w`, `wand` | Wandzug aus Achspunkten, gerade oder als Bogen; Typ aus den Attributen |
| `fenster` | Fenster | `f` | Fenster in eine Wand setzen |
| `tuer` | Tür | `t`, `tür` | Tür in eine Wand setzen |
| `opening` | Öffnung | `oe` | Öffnung allgemein (Art wählbar) |
| `ceiling` | Decke | `d`, `decke` | Decke aus Umriss |
| `ceilingopening` | Deckenloch | `deckenloch`, `aussparung` | Aussparung in einer Decke |
| `roof` | Dach | `dach`, `rf` | Dach über einem Rechteck; Form in der Objekt-Info |
| `dormer` | Gaube | `gaube`, `lukarne` | Gaube in einer geneigten Dachfläche (Schlepp, Sattel, Walm, Flach) |
| `roofwindow` | Dachfenster | `dachfenster`, `oberlicht` | Dachfenster in Dach oder Decke |
| `roofhole` | Dachhof | `dachhof`, `lichthof` | Ausschnitt (Hof) in einem Dach |
| `stair` | Treppe | `treppe`, `tp` | Gerade, L- oder Wendeltreppe; steigt ins nächste Geschoss |
| `column` | Stütze | `stuetze`, `stütze` | Stütze mit Profil setzen |
| `room` | Raum | `raum`, `rm` | Raum durch Klick hinein oder als Umriss, mit Raumstempel |
| `solid` | Körper | `koerper`, `körper`, `kugel`, `body` | Quader, Zylinder, Kegel, Kegelstumpf, Kugel, Torus |
| `solidbool` | Körper verschneiden | `koerperbool`, `verschneiden`, `bool` | Vereinigen, Abziehen, Schneiden von Körpern |
| `voidbox` | Durchbruch | `durchbruch`, `nische`, `void` | Abzugskörper für Durchbruch, Nische, Schlitz |
| `extrude` | Extrudieren | `ex` | Umriss zu Körper extrudieren |
| `revolve` | Rotationskörper | `rev`, `rotation` | Profil um eine Achse drehen |
| `loft` | Loft | `lf` | Körper durch mehrere Profile |

### Zeichnen 2D

| Befehl | Name | Kürzel | Wirkung |
|---|---|---|---|
| `line` | Linie | `l` | Einzelne Linien |
| `polyline` | Polylinie | `pl` | Linienzug, auch mit Bögen |
| `xline` | Konstruktionslinie | `xl`, `hilfslinie`, `konstruktionslinie` | Unendliche Hilfslinie |
| `ray` | Strahl | `ry`, `strahl` | Halbunendliche Hilfslinie |
| `multiline` | Parallellinien | `ml`, `parallel` | Mehrere parallele Linien in einem Zug |
| `rect` | Rechteck | `rec` | Rechteck aus zwei Ecken |
| `circle` | Kreis | `c` | Kreis: Mitte/Radius, Durchmesser, 3 Punkte, tangential |
| `arc` | Bogen | `a`, `bogen` | Kreisbogen (mehrere Methoden) |
| `ellipse` | Ellipse | `el` | Ellipse |
| `polygon` | Vieleck | `vg`, `vieleck` | Regelmässiges Vieleck |
| `spline` | Spline | `sp` | Glatte Kurve durch Punkte |
| `bezier` | Bezier | `bz` | Bézierkurve |
| `wipeout` | Maskenregion | `wo`, `maske`, `maskierung` | Fläche, die Darunterliegendes abdeckt |
| `zauberstab` | Zauberstab | `zs` | Klick in umschlossene Fläche → Umriss mit Schraffur |
| `grid` | Achsraster | `axes`, `achsraster`, `achsen` | Rechtwinkliges oder radiales Achsraster mit Achsköpfen |
| `block` | Block einfügen | `bl`, `symbol` | Block (Symbol) platzieren |
| `defblock` | Block definieren | `db`, `blockdef` | Auswahl als Block speichern |
| `import` | Importieren | `imp` | DXF-Datei in die Zeichnung importieren |

### Beschriften und Bemassen

| Befehl | Name | Kürzel | Wirkung |
|---|---|---|---|
| `text` | Text | `tx`, `txt`, `beschriftung` | Text setzen (Papiergrösse) |
| `textbox` | Textspalte | – | Text mit fester Breite und Umbruch |
| `textpath` | Text entlang Pfad | `txp`, `pfadtext` | Text folgt einer Kurve |
| `leader` | Vorführungspfeil | `ld`, `vorführer` | Pfeil mit Knicken und Text |
| `dimension` | Bemassung | `dim`, `bemassung` | Masskette, assoziativ an Bauteilen |
| `autodim` | Aussenbemassung | `ab`, `aussenbemassung` | Automatische Fassadenketten |
| `dimradius` | Radiusmass | `rad`, `radiusmass` | Radius eines Bogens oder Kreises |
| `dimdiameter` | Durchmessermass | `dm`, `durchmessermass` | Durchmesser |
| `dimarc` | Bogenlänge | `bogenl`, `bogenlaenge` | Länge eines Bogens |
| `dimdetach` | Bemassung lösen | `bml`, `bemassungloesen` | Bezug zum Bauteil aufheben |
| `kote` | Höhenkote | `kt`, `hoehenkote` | Höhenangabe in Grundriss oder Schnitt |
| `detailref` | Detail-/Schnitt-Verweis | `dr`, `detail`, `verweis` | Verweis-Symbol auf Detail oder Schnitt |
| `scalebar` | Massstabsbalken | `sb`, `massstabsbalken`, `massstab` | Massstabsleiste |
| `revcloud` | Revisionswolke | `rv`, `wolke`, `revisionswolke` | Wolke um geänderte Stellen |
| `pointmarker` | Punktmarker | `pm`, `punkt`, `knoten` | Punkt- oder Knotenmarke |
| `measure` | Messen | – | Abstand und Winkel messen (Taste `q`) |

### Bearbeiten

| Befehl | Name | Kürzel | Wirkung |
|---|---|---|---|
| `move` | Verschieben | `m` | Auswahl verschieben (Basis- und Zielpunkt) |
| `copy` | Kopieren | `cp` | Auswahl kopieren |
| `rotate` | Drehen | `ro`, `drehen` | Um einen Punkt drehen |
| `mirror` | Spiegeln | `s`, `spiegeln` | An einer Achse spiegeln |
| `scale` | Skalieren | `sc`, `skalieren` | Um einen Faktor vergrössern/verkleinern |
| `array` | Feld | `ar`, `feld` | Rechteckige oder polare Reihe |
| `align` | Ausrichten | `al`, `ausrichten` | Links, rechts, Mitte, oben, unten, verteilen |
| `offset` | Versatz | `o` | Parallele Kopie in Abstand; auch Wände |
| `trim` | Stutzen | `tr` | An Schnittkanten abschneiden; auch Wände |
| `extend` | Verlängern | `ext`, `verlaengern`, `verlängern` | Bis zu einer Kante verlängern; auch Wände |
| `split` | Teilen | `teilen` | An einem Punkt oder einer Kante teilen |
| `break` | Unterbrechen | `br`, `unterbrechen` | Stück herausschneiden |
| `join` | Verbinden | `j`, `verbinden` | Linien und Bögen zu Polylinie, Wände verketten |
| `fillet` | Verrunden | `fi`, `verrunden` | Ecke mit Radius; auch Wände |
| `chamfer` | Fasen | `ch`, `fasen` | Ecke abschrägen |
| `explode` | Auflösen | `x`, `aufloesen` | Polylinie, Block, Bemassung in Einzelteile |

### Lage und Ansichten

| Befehl | Name | Kürzel | Wirkung |
|---|---|---|---|
| `sectionline` | Schnittlinie | `schnittlinie` | Schnitt mit zwei Punkten anlegen |
| `viewline` | Ansichtslinie | `ansichtslinie` | Ansicht mit zwei Punkten anlegen |
| `terrain` | Gelände | `ter` | Gelände aus gewählten Höhenlinien |
| `excavation` | Baugrube | `baugrube`, `aushub` | Baugrube mit Sohle und Böschung |
| `georef` | Neuer Bezugspunkt | `bezugspunkt`, `nullpunkt` | Neuer Nullpunkt; verschiebt das ganze Projekt |

Hinweise:

- Bauteil-Befehle arbeiten im **aktiven Geschoss** und legen die Elemente auf
  die passende Kategorie-Ebene (Wände, Decken, Dächer, Treppen …).
- Bearbeiten-Befehle nehmen die aktuelle Auswahl; ist nichts gewählt, fragen
  sie danach.
- Beim Verschieben, Kopieren, Spiegeln und in Reihen gehen Fenster und Türen
  mit ihrer Wand mit [134].
- Für Skripte und KI-Assistenten laufen dieselben Befehle mit
  JSON-Parametern über den MCP-Zugriff (siehe
  [Kommandozeile](../kommandozeile/#ki-zugriff-mcp)).
