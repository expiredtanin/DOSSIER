# Review [318] — alle Ansichten kritisch (20.11.2026)

Geprüft per CLI (`--hatch`, SVG → PNG in Chromium/Linux): Musterhaus komplex (UG/EG/OG/DG 1:100 und 1:50, Schnitte A-A/B-B,
4 Ansichten, Axo southeast), Wettbewerb (3 Grundrisse 1:100/1:50, Schnitte, 4 Ansichten, Situation 1:500, Axo), Umbau
(Grundrisse, Schnitte A/B/C, Ansichten, Umbauplan/Endzustand/Bestand/Abbruch farbig), Varianten (Grundrisse, Schnitt, Ansicht, Axo).
Nicht geprüft: Metal/Tauri, Druck-PDF, Plakat/Präsentationsblatt (kein CLI-Weg; nur in der App/PDF), Massstab 1:200/1:500 ausser Situation.

Bilder: `komplex-eg-100.png`, `komplex-og-100.png`, `komplex-ansicht-sued.png`, `komplex-schnitt-a-erdreich-vorher.png` (nachher: `…-nachher.png`), `wettbewerb-treppe-nachher.png`, `wettbewerb-situation-nachher.png`,
`wettbewerb-treppe-doppelt.png`, `wettbewerb-situation.png`, `umbau-schnitt-b-farbig.png`, `umbau-eg-umbauplan.png`.

## Behoben in [318]

1. **Schnitt: Nachbar-/Kontext-Umrisse zeichneten durch das Erdreich** (Komplex A-A, `komplex-schnitt-a-erdreich-vorher.png`): [302]
   beschnitt nur die Schnittfläche am Gelände, die Ansichtskanten des Nachbarn (hinter der Ebene) liefen durch Schraffur und
   Stützmauer. Kanten enden jetzt an der Geländelinie (`plan/section/meshes.rs`, Test `nachbar_kanten_enden_am_gelaende`).
2. **Grundriss: doppelte Linien bei übereinanderliegenden gleichen Treppen** (Wettbewerb EG/OG1, `wettbewerb-treppe-doppelt.png`):
   Untersicht der Treppe darüber [G1] legte ihre gestrichelten Tritte exakt auf die der eigenen Treppe (11–12 doppelte Linien je
   Geschoss; Doppeldruck/DXF). Die zweite Linie entfällt (`plan/stairs.rs`, Test `untersicht_deckungsgleiche_treppe_keine_doppelten_linien`).
3. **Situation 1:500 Wettbewerb: Strassenname von der Strassenachse durchstrichen** (`wettbewerb-situation.png`): Beschriftung im
   Beispielprojekt über die Achse gesetzt (`sampleProjectWettbewerb.ts`).

## Offen (nach Gewicht)

A. **Plakat/Präsentationsblatt** nicht headless prüfbar: kein CLI-Befehl für Blatt-Ebenen (`findLevel` blendet `layoutId` aus). Ein
   `sheet`-/`layout`-Befehl (SVG je Layout, wie `layoutPages`) würde die Prüfung im Container erlauben. Hoch für den Referenz-Ablauf.
B. **Situation 1:500**: Massstabsbalken-Beschriftung „20 m" liegt auf der südlichen Parzellengrenze (Nordpfeil/Balken kollidieren mit
   Kataster-Linien; Platzierung ohne Kollisionsprüfung). Rampe/Vorplatz im Osten wird wie Gebäude schwarz gefüllt (Dachaufsicht).
   Keine Dach-/Höhenkoten in der Situation.
C. **Grundriss Komplex EG**: eng stehende Türflügel (Atelier/Zimmer/Treppenhaus) überlagern sich im Treppenhaus; Masszahlen-Ketten
   Süd doppelt (1.79/1.80 gegen 1.80, 3.60/3.60, 3.00/3.00) — gewollt (Öffnungs- und Wandkette), aber eng beieinander; Sofa im Umbau
   (Beispiel) ragt in die Westwand (Modelldaten).
D. **Ansicht Ost Komplex**: Nordflügel steht ohne Sockel/Fundament über dem fallenden Gelände (weisse Lücke zwischen Wandfuss und
   Geländelinie) — Modell hat kein Sockelbauteil, keine Ableitung „Wand bis Gelände".
E. **Schnitt Komplex A-A**: Erdreich-Band unten ohne Randlinie, Unterkante folgt dem Gelände (ausgefranste Schraffur-Enden); Erdreich
   reicht links tiefer als rechts.
F. **Axo Varianten**: Dachrand/Anbau mit mehrfachen Kettenlinien (Dachlagen) unklar lesbar; Linienstärken Silhouette/Kante an Wänden
   unterschiedlich.
G. **Schatten**: Grundrisse zeigen Sonnenschatten flach auf alle Höhen (Komplex EG: Schatten über Gelände-Höhenlinien, Notch-Form
   durch Dachflächen); fachlich plausibel, aber nicht gegen Sonnenstand nachgerechnet.
H. Nachbarn im Grundriss OG: einer weiss (Traufe unter Schnitthöhe), andere grau — fachlich stimmig, aber ohne Legende irritierend.

Geprüft und in Ordnung: Wandstärken/Schraffuren 1:50, Umbaufarben (Etappe 1 rot, Etappe 2 blau, Abbruch gelb, Bestand grau),
Öffnungsbeschriftung, Schnitt-Treppen Wettbewerb, Balkon/Geländer in Schnitt/Ansicht/Axo, Schatten in Ansichten ([316]).
