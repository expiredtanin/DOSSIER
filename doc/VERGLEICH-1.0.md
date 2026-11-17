# Dossier 1.0 gegen Archicad und Vectorworks Architect — Lückenanalyse WBW/Vorprojekt

Stand 17.11.2026. Nur der Ablauf Wettbewerb und Vorprojekt (SIA 31) in der Schweiz, Referenz-Ablauf aus `TODO.md` ([206]).

**Quellen und Verlässlichkeit.** Dossier: `TODO.md`, `doc/RELEASE-1.0.md`, `RELEASE-NOTES-1.0.md`, `KURZANLEITUNG.md`,
`DATEIFORMATE.md`, Stichproben im Code (Modell `src-tauri/core/src/model/generated.rs`, `src/commands/cmds`, `src/io`). Archicad/Vectorworks:
Allgemeinwissen zum Funktionsumfang, nur Design Options (Archicad ab 27, in 28 verbessert) und Vectorworks-GIS/Shapefile-Import
(Architect/Landmark) per Websuche belegt. Alles Übrige zu den beiden Programmen ist **nicht einzeln gegen die aktuelle Hilfe geprüft**
(Version 2026 beider Programme nicht verglichen). „Vorhanden“ bei Dossier heisst: im Code und Linux-Container belegt — der Mac-Durchlauf
([206], „Mac-Gegenprobe“) und Fremdprogramm-Gegenproben stehen aus.

## 1. Tabelle je Bereich

Legende Dossier: **ja** vorhanden · **teils** teilweise · **fehlt**.

| Bereich | Archicad | Vectorworks Architect | Dossier |
|---|---|---|---|
| Kataster/Grundstück | DXF/DWG-Import, Vermessungsdaten; CH-Amtsdaten direkt: nicht geprüft | DXF/DWG, Shapefile mit .prj (belegt), Georeferenzierung | **ja**: Kataster-DXF/DWG (LV95, Nullpunkt-Bezug, Parzelle aus Auswahl); echte Kantons-DXF nicht geprüft; kein direkter Amtliche-Vermessung-Abruf (Interlis/Geodienste), kein Shapefile/GeoJSON |
| swisstopo/Gelände | Mesh aus Höhenlinien/Punkten; swisstopo-Direktabruf: nicht geprüft | Geländemodell aus Höhenlinien/3D-Polygonen (belegt); swisstopo: nicht geprüft | **ja**: Standort-Import (Geocoder, swissALTI3D, swissBUILDINGS3D über STAC, swissIMAGE, OSM), Gelände aus Höhenlinien, Baugrube; nur online, im Container ungeprüft |
| Baurecht | eigene Eigenschaften/Skripte nötig (nicht geprüft) | Datensätze/Worksheets (nicht geprüft) | **ja**: Grenzabstand je Kante, Baulinie, Profilwinkel, Höhen, Nachweis AZ/ÜZ/BMZ/GFZ, Hülle im 3D ([255], [63]) |
| Volumenstudie | Morph, Slab/Roof/Shell | Extrusion, Solids, Roof | **ja**: Körper (Boolean, Loft, Rotation), `koerperinbauteile` ([222]); Studienkörper neben Wand-Haus zählen nicht ins GV ([266]) |
| Raumprogramm | Zonen + Listen | Spaces + Worksheets | **ja**: Soll/Ist, CSV/XLSX-Import, Räume generieren; **teils**: keine Wohnungs-/Nutzungseinheiten (Wohnungsspiegel) |
| Grundriss/Schnitt/Ansicht | Vollumfang, Marker, Graphische Überschreibung, Ansichtsvorlagen | Viewports, Klassen-Overrides | **ja**: aus dem Modell abgeleitet, SIA-400-Schraffur, Detailgrad, Ansichtsvorlagen, Schnittlinie einstellbar ([276] ◐); 1:100-Abgabequalität offen ([256], [269] ◐) |
| Situation 1:500 / Schwarzplan | Ansichtsvorlage, Mesh-Ansicht | Viewport + Site Model | **ja**: Vorlagen „Situation WBW“/„Schwarzplan“ ([207] ◐); Kataster-Gebäude unter eigenem Fussabdruck nicht ausgeblendet |
| 3D/Axo/Schatten | 3D-Fenster, Axo, Sonnenstudie | Viewports, Heliodon | **ja**: 3D-Dokument als Vektor-Axo mit verdeckten Kanten (CLI auch headless), Schatten Plan und 3D; Metal/Mac ungeprüft |
| Rendering | CineRender (Cinema 4D), Bibliothek | Renderworks (Cinema 4D) | **teils**: Cycles eingebaut ([215] ◐), Blender-Brücke, Pathtracer-Vorschau; Mac ungeprüft; keine 3D-Möbel/Menschen/Autos ([253]) |
| Flächen SIA 416 / IVHB | Raumflächen-Add-on DIN 277/WoFlV belegt; SIA 416 über Listeneinstellungen (Forum, nicht geprüft) | Spaces + Worksheets (SIA 416 nicht geprüft) | **ja**: Flächentabelle nach SIA 416, GV aus Hülle ([266]), IVHB-Ziffern, Kennzahlenleiste, CSV/PDF/IFC |
| Kostenschätzung | Mengen/Listen; Kostenmodul nicht geprüft | Worksheets (nicht geprüft) | **ja**: Kennwert-Methode eBKP-H B–J, Honorar, Reserve, MwSt ([209]); nur grob |
| Abgabe-Layouts | Layouts, Publisher | Sheet Layers, Batch Publish | **ja**: Layout-Blätter, Plakate A0/A1, Kennwort/anonym mit Prüfung, PDF mit Ebenen, Publikationssätze ([208] ◐) |
| Austausch DXF/IFC | DXF/DWG, IFC (sehr ausgereift), BCF, Teamwork-Hotlinks | DXF/DWG, IFC, BCF (nicht geprüft) | **teils**: DXF/DWG, IFC Import/Export, BCF, STEP/OBJ/glTF; IFC/DXF in keinem Fremdprogramm geöffnet ([259], [C9]); Dächer als Netz im IFC |
| Wände/Decken/Dächer | alle, Schichtaufbau, Profile | alle | **ja**: mehrschichtig, Bogen, Gehrung/T-Stoss, Dach beliebiger Umriss; **fehlt**: geneigte Decke/Rampe als Element |
| Treppen | parametrisch, Geländer | parametrisch | **ja**: gerade, L, U, Wendel, Deckenloch automatisch |
| Geländer, Balken, Vorhangfassade | eigene Werkzeuge | eigene Werkzeuge | **fehlt**: kein eigenständiges Geländer, Träger/Unterzug, Vorhangfassade (Modell hat nur Treppen-Geländer/Absturzsicherung am Deckenloch, Stützen) |
| Öffnungen | Fenster/Türen parametrisch | dito | **ja**: Typen, Detailstufen, Formöffnungen, Dachfenster, Gauben |
| Bemassung/Text/Schraffur | ja | ja | **ja**: assoziativ, Aussenbemassung automatisch, Koten, Textfelder, SIA-Schraffuren |
| Ebenen/Klassen, Stifte | Ebenen, Stiftsätze, Überschreibungen | Klassen, Layer | **ja**: Klassen, Stiftsätze, Objektstile mit Regeln ([180], [33]) |
| Ansichtsvorlagen | ja | Viewport-Vorlagen | **ja** ([34]) |
| Umbau | Umbaufilter | Renovation-Attribut | **teils**: Bestand/Abbruch/Neu, Schicht-Sanierung ([271], [274], [275] ◐; 3D-Bildprüfung offen) |
| Varianten | Design Options (ab 27, belegt) | Design-Layer/Klassenkombinationen (nicht geprüft) | **teils**: Option-Sätze und Kombinationen ([272] ◐) |
| Mehrbenutzer | Teamwork/BIMcloud, Hotlink-Module | Project Sharing, Referenzen | **fehlt** (nur Dateisperre unter Tauri) |
| Plattform | Windows + macOS | Windows + macOS | **teils**: macOS (Hauptplattform), Linux; **kein Windows** |

## 2. Lücken, die WBW/Vorprojekt blockieren oder verlangsamen

Grösse: S ≤ 1 Tag · M ≤ 1 Woche · L ≤ 1 Monat. IDs aus `TODO.md`; **neu** = noch nicht in `TODO.md` (Vorschlag).

### Muss vor 1.0

| # | Lücke | Wo im Code / ID | Grösse |
|---|---|---|---|
| 1 | **Mac-Durchlauf des Referenz-Ablaufs fehlt**: Metal-3D, Schatten, Cycles-Fenster, Speichern/Autosave, Tauri-Fenster nur im Linux-Container gesehen. Grösstes Risiko für die Abnahme | [206], „Mac-Gegenprobe“ (u. a. [214], [266], [277], [116]); `doc/RELEASE-1.0.md` §13/§14 | M (Maintainer) |
| 2 | **Fremdprogramm-Gegenprobe DXF/IFC**: nichts in Archicad/Revit/Solibri/AutoCAD geöffnet; Fachplaner-Austausch ist Teil des Ablaufs | [259], [C9], [200], [201] | S |
| 3 | **Echte Kataster-DXF/DWG aus Kantonen** (Layernamen, Einheiten, LV95) nicht geprüft; Ablauf beginnt hier | `src/io/katasterImport*`, `dxfParser`; [206] | S |
| 4 | **1:100-Pläne in Abgabequalität** (Bemassung, Koten, Stempel, Öffnungen) | [256], [269], [270], [276] | M |
| 5 | **Plakat-Rest**: Freitext-Anonymitätsprüfung nur für bekannte Namen; kleine Häuser lassen Plakat leer (kein 1:100-Vorschlag); Situation: Bestandsgebäude unter Neubau bleibt | [208], [266] Rest, [207]; `presentation_poster.rs`, `situation.rs` | M |

### Sollte (Verlangsamung, nach Möglichkeit bis 12.12.)

| # | Lücke | Wo / ID | Grösse |
|---|---|---|---|
| 6 | **Wohnungsspiegel / Nutzungseinheiten**: Räume lassen sich keiner Wohnung zuordnen; kein Spiegel (Zimmerzahl, NWF je Wohnung) — im Mehrfamilienhaus-WBW üblich. **erledigt 17.11. ([278], Rest: Grundriss-Darstellung der Einheiten)** | `unit_schedule.rs`, `UnitsSection` | M |
| 7 | **Geländer als eigenes Bauteil** (Balkon/Loggia/Absturzsicherung in Plan, Schnitt, Ansicht, 3D); heute nur Wand-/2D-Behelf. **neu** | Modell `Stair.railProfile`/`stairs3d::RailSpec` als Ausgangspunkt, `cmds/` | M |
| 8 | **Geneigte Decke / Rampe** (Tiefgarage, Terrassen mit Gefälle): `Ceiling` hat nur Ober-/Unterkante, keine Neigung; Behelf Pultdach/Körper. **neu** | `Ceiling`, `ceiling_item` (`cmd_create.rs`), `plan/section` | M |
| 9 | **Träger/Unterzug/Fassadenträger**: kein Element (Behelf Körper/Wand), Deckenspiegel mit Unterzügen fehlt. **neu**, [100] nennt die Lücke | `columns` als Muster | M |
| 10 | **3D-Entourage** (Möbel, Menschen, Autos 3D) für Bilder: Bibliothek nur 2D; Behelf glTF/OBJ-Import | [253] („3D nach 1.0“), `furniture_lib.rs` | L |
| 11 | **GV: Studienkörper neben Wand-Haus, Bodenplatte unter unterstem Geschoss** | [266] Punkt 1 Rest; `building_volume.rs` | S–M |
| 12 | **IFC: Dächer als Netz, keine 2D/Layouts/Möbel**; IFC-Import zu Bauteilen unvollständig (Dächer, Träger) | [B4], [B5], [259] | M |
| 13 | **Gelände weiter bearbeiten** (Modellieren, Schnitt-Gelände geprüft?): Griffe/Profile, Abtrag/Aufschüttung nur über Baugrube | [187], [T6], [68]; Spec-Schritt 1.3 „Gelände nicht im Schnitt“ | M |
| 14 | **Raumprogramm → Modell**: Räume-generieren/ Abgleich ok; Ausbau auf Variantenvergleich (Kennzahlen je Option) nicht geprüft | [272] | nicht geprüft |

### Nach 1.0

| # | Lücke | Wo / ID | Grösse |
|---|---|---|---|
| 15 | **Windows-Paket** (CH-Büros arbeiten vielfach unter Windows; Annahme, nicht belegt) | [30], `release.yml`; „Nicht in 1.0“ | L |
| 16 | **Mehrbenutzer/Teamwork** (Wettbewerbe im Team) | `ARCHITEKTUR.md` Kern-Dokument, Lock `*.obp.lock` | XL |
| 17 | **Amtliche Vermessung/Geodienste direkt** (Kataster ohne DXF, Shapefile/GeoJSON) | `src/io/swissTopo.ts`, `net.ts` Host-Liste; **neu** | M |
| 18 | **Eigene parametrische Objekte, Bibliothek per GUID** | [254], [11] | L |
| 19 | **Vorhangfassade, Detailplanung 1:50/1:20** | „Nicht in 1.0“ | XL |

## 3. Was Dossier besser kann

- **Schweiz im Kern**: SIA 416 (GV aus Manifold-Hülle inkl. Dachraum), IVHB-Ziffern, Baurecht-Hülle und Nachweis zulässig/Projekt/Reserve, eBKP-H-Kostenschätzung — bei Archicad/Vectorworks nach unserem Kenntnisstand über Eigenschaften/Add-ons zu bauen (nicht geprüft).
- **Wettbewerb als Funktion**: Plakat A0/A1 mit Kennwort und Anonymitätsprüfung, Präsentationsplan mit einem Klick, Situation/Schwarzplan als Vorlage.
- **Ein Modell, alles abgeleitet**: Volumenstudie → Bauteile mit einem Befehl, Kennzahlenleiste = Flächentabelle, Axonometrie als Vektor (auch headless).
- **Kern headless**: `dossier-cli` (Plan, Schnitt, Kennzahlen, IFC, Axo), MCP-Brücke für KI; offenes JSON-Projektformat; Golden-Tests.
- **Rendering ohne Zusatzprogramm** (Cycles eingebaut, ohne Blender) und kein Lizenzserver — beides auf dem Mac noch zu bestätigen.
- **Robustheit**: Undo/Redo und Prüfung im Kern, atomares Speichern, Wiederanlauf nach Kern-Panic (auf dem Mac ungeprüft).

## Top-10 (Muss/Sollte)

1. Mac-Durchlauf Referenz-Ablauf und Mac-Gegenprobe ([206]) — Muss, M
2. DXF/IFC in Fremdprogrammen öffnen ([259], [C9]) — Muss, S
3. Echte Kantons-Kataster-DXF/DWG testen — Muss, S
4. 1:100-Planqualität ([256], [269], [270], [276]) — Muss, M
5. Plakat-/Situations-Reste ([208], [266], [207]) — Muss, M
6. Wohnungsspiegel / Nutzungseinheiten (neu) — Sollte, M
7. Geländer als Bauteil (neu) — Sollte, M
8. Geneigte Decke / Rampe (neu) — Sollte, M
9. GV-Reste (Studienkörper, Bodenplatte) ([266]) — Sollte, S–M
10. 3D-Entourage ([253]) bzw. IFC-Bauteile ([B4]/[B5]) — Sollte, L / M
