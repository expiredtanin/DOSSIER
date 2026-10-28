# Dossier — Arbeitsliste (Lehren aus BIMCraft, annotiert)

Grundlage: Analyse vom 27.10.2026 (BIMCraft v0.7/0.8, MIT OR Apache-2.0), annotiert gegen den Code von
DOSSIER am 27.10.2026. Ergänzt um die Geometrie-Punkte aus `docs/design/boolean-geometrie-plan.md` (lokal)
und die truck-Arbeit (IDs `[G…]`, `[T…]`, `[R…]`). Seit 27.10. im Repo, damit Cloud-Sitzungen und Agents sie
sehen; Status wird im selben Commit wie der Code nachgeführt.

**Legende.** Stand: ✅ vorhanden · ◐ teilweise · ○ offen · ✗ abgelehnt. Grösse (eine Person mit
Agenten): S ≤ 1 Tag · M ≤ 1 Woche · L ≤ 1 Monat · XL > 1 Monat. „Fertig wenn" ist das
Abschlusskriterium. IDs sind stabil; neue IDs nur anhängen.

BIMCraft-Interna sind seit 27.10. selbst gelesen (Quellcode v0.9) → konkrete Übernahmen im Abschnitt
**Übernahme aus BIMCraft [B]**.

---

## Rust-Kern [K] (Entscheid 27.10.: ganzer Kern nach Rust, UI bleibt TSX)

Ersetzt die frühere Zurückstellung von [1]/[2]. Neuer Kern-Code entsteht in Rust (`src-tauri/core`,
Crate `dossier-core`); jede portierte TS-Funktion wird im selben Schritt gelöscht (keine Doppelspur).
truck (`trucksolid`) bleibt eigenes WASM-Modul (Panic-Isolation), wird vom Kern später nativ eingebunden.

- ✅ **[K0] Lader und Grenze.** (27.10.) `engine/coreWasm.ts`: App lädt den Kern einmal vor dem ersten
  Render, CLI über Byte-Provider, Vitest per Setup-Datei; danach synchron über `core()`. Daten als flache
  `Float64Array`s. Bindungen je Modul in `src-tauri/core/src/web/<modul>.rs`. · S–M
- ◐ **[K1] 2D-Geometrie.** (27.10.) Polygon-Booleans aus Rust (i_overlay) ersetzen `polygon-clipping`
  (entfernt). `kernel2d` produktiv aus Rust (`kernel2d.ts` nur Fassade, Paritätstest weg; gemessen nicht
  langsamer). Schatten, Baurecht (exakter Puffer statt Kapsel), Aussenbemassung, Kennzahlen in Rust; die
  `checkRoomProgram` bleibt vorerst TS (SIA-416-Zuordnung: seit [K2] `room_area.rs`). `bulge.ts` ist Fassade über den
  Rust-Kern (`bulge_polyline_points` für ganze Polylinien; `hasRealBulge`/`pointOnCircle` bleiben TS,
  Einzeiler). Delaunay-Triangulierung (`delaunay.rs`, Port von delaunator inkl. exaktem `orient2d`; bitgleich zu JS über Zufalls-/Raster-/kozirkulare/fast-kollineare Punkte; `delaunator` aus den Abhängigkeiten entfernt, 28.10.): Gelände-TIN und Kontext-Gebäude. Offen: Straight Skeleton [B2]. · M
- ✅ **Mac-Test 27.10.** (Maintainer): App startet mit dem Rust-Kern, Darstellung sieht gut aus — Stand `5b72069`
  (K0–K2, render2d binär); zweiter Test mit GPU-Kompilierung [K3b] (`7a8af4f`) ebenfalls bestanden.
- ✅ **[K2] Geometrie-Ableitungen.** (27.10.) Dachgeometrie in Rust (`roof.rs`, `roof_skeleton.rs`;
  `roofSkeleton.ts` gelöscht, ~2× schneller, Ergebnis bitgleich). Treppen in Rust (`stair_geometry`,
  `stair_outline`, `stair_cut`; `stair.ts` Fassade, 27.10.). Räume (27.10.): `room_area.rs` (Flächen,
  SIA-416-Zuordnung/`balance` nur hier), `room_boundary.rs` (Erkennung über `kernel2d`), `polygon_holes.rs`;
  TS `roomArea/roomBoundary/polygonHoles` sind Fassaden (Beschriftungen und CSV bleiben TS; Einzelflächen
  im WASM 2,5–8× langsamer, je Raum < 4 µs). 3D-Ableitung damit vollständig (27.10.); in TS bleiben nur das Sammeln aus dem `Project` und truck-Körper. · L
  - ✅ (27.10.) Wand-Joins und -Bänder in Rust (`joins.rs`, `wall_bands.rs`): Gehrung/T-Stoss/Kreuzung,
    Pro-Schicht-Cuts, Nah-Putz-Aussparungen, Decken-Dominanz, Öffnungs-Löcher, `topDrop` unter Dächern.
    `model/joins.ts` und `toWalls3d/bands.ts` sammeln nur noch aus dem `Project` und übergeben flach
    (Decken/Dächer einmal je Geschoss). Ergebnis bitgleich (Vergleich über 27 Projekte inkl.
    Zufallsgrundrisse), `computeJoins` ~10×, `projectToWalls3d` (1296 Wände) ~4× schneller.
  - ✅ (27.10.) 3D-Ableitungen Decken, Stützen, Treppen, 2D-Zeichnungen in Rust (`ceilings3d.rs`, `columns3d.rs`,
    `stairs3d.rs` [Slabs, Betonlaufplatte, Handlauf/Pfosten], `drawing2d_3d.rs` [Boden-Spuren und Pick-Strecken in
    Chargen], gemeinsam `mesh3d.rs`, `jsmath.rs` = V8-`Math.hypot`). `toWalls3d/{ceilings,columns,stairs,drawing2d}.ts`
    sammeln nur noch aus dem `Project` (Farbe/Material bleiben TS); Treppengeometrie direkt aus `kernel2d`. Ergebnis
    bitgleich (Vergleich über 460 Projekte inkl. Zufallstreppen/-decken/-stützen/-zeichnungen). Messung: Treppen 1,3–4×,
    Decken ~1,7×, 2D-Zeichnungen (400 000) 1,2–1,5× schneller; Stützen bei 2000 Stück ~2× langsamer (5 → 11 ms, das
    Prisma ist trivial, der Aufbau der JS-Arrays dominiert). **Bleibt TS:** `extrusions.ts` und `voids3d.ts` — jede
    Netzrechnung dort läuft über truck (`extrudePolygon`/`extrudeCircle`/`buildSolidMesh`, eigenes WASM-Modul mit
    Panic-Isolation); übrig ist nur Cache/Async-Orchestrierung und eine z-Verschiebung.
  - ✅ (27.10.) Öffnungen in 3D und Wand-Loch-Mesh in Rust (`openings3d.rs`, `wall_mesh_cut.rs`): Glas/
    Mehrfachverglasung, Türblatt/Kassette, Blend-/Flügelrahmen je Eckstoss, Sprossen, SIA-Symbole, Bänke,
    Zarge, Schwelle, Rollladenkasten; Loch-Mesh für STL/OBJ/IFC, `isWatertight`. `toWalls3d/openings.ts`
    sammelt nur noch (alle Wände in einem Aufruf, `emitOpeningMeshes`), `wallMeshCut.ts` ist Fassade
    (`wallCutMeshes` für viele Bänder). Bitgleich (Beispiel + 40 Zufallsprojekte × 4 Detailgrade, 152k
    Quader; 6586 Bänder; IFC-Datei identisch). Öffnungen ~4–7×, Loch-Mesh ~1,6× schneller,
    `projectToModel3d` (1500 Wände) 193 → 126 ms; `isWatertight` allein ~4× langsamer (Übergabe der
    `number[]`, je Mesh < 3 µs), IFC-Export gesamt unverändert.
- ○ **[K3] Plan, Schnitt, Ansicht in Rust**, Primitive direkt an render2d (ohne TS-Umweg). · L
  Reihenfolge (Entscheid 27.10.: Risiko klein halten, Verbraucher zuerst):
  - ✅ **[K3b] Verbraucher auf Binärpuffer.** (Mac-Test 27.10. bestanden: Grundriss läuft, sieht gut aus) Plan-Puffer-Format (TS schreibt vorerst, Rust liest);
    GPU-Kompilierung (`glPlanCompile`/`glPlanHatch`) in Rust, Vertex-Puffer bitgleich zur TS-Ausgabe;
    render2d bekommt die Szene binär statt JSON — **fertig**: `scene_bin.rs`/`renderSceneBin.ts`
    (Format v1: Kopf mit Magie+Version, f64-Punktepool, f32-Farben, String-Tabelle; Fixture
    `render2d/tests/fixtures/scene_v1.bin` in beiden Tests), `set_scene_bin` ersetzt `set_scene(json)`,
    `push_native_scene` (Nicht-macOS) ebenfalls binär (Linux-Container konnte `src-tauri` nicht bauen: gdk fehlt).
    Gross (200k Linien, 20k Füllungen, 1000 Texte): Kodieren 311 → 15 ms, Rust-Lesen 70 → 14 ms, 33,9 → 14,3 MB.
    - ✅ (27.10.) Teil 1: Plan-Puffer-Format v1 (`plan_buf.rs` ↔ `src/plan/planBuf.ts`, Magie+Version,
      Farb-/Schraffur-Tabellen, ein Eintrag je Primitiv, Text/Bild als Platzhalter, keine Pick-IDs) und
      GPU-Kompilierung in Rust (`gpu_compile.rs`, `hatch.rs`, `jsnum.rs`). `glPlanCompile.ts`/`glPlanHatch.ts`
      sind Fassaden (Signaturen gleich, auch `buildHatchRuns`/`applyDashRuns`/`zigzagPoints`/`motifPoints`/
      `triangulate` für toRenderScene/Druck-SVG/DXF/Mesh). Ein Kern-Aufruf je Chunk. Bitgleich (Vertex-/
      Index-Puffer, Batches, Ursprung, Bounds; gepackt + ungepackt): Beispielprojekt (alle Ebenen ×
      Detailgrade × Modi × LOD, Chunks), 30 Zufallsprojekte (+ Unterlage), 460 Zufalls-Primitivlisten (alle
      Schraffurtypen, Random/Motiv/Dämmung, Strichmuster, Zickzack, noStrokeEdges, greyed/opacity,
      Landeskoordinaten), Schraffur-Fassade einzeln — 8 GB Puffer verglichen. Trigonometrie läuft im Web-Build
      über `Math` der JS-Engine (musl-libm wich ab, auch in der Topologie). Leistung (Node, Min. über
      Wiederholungen): Beispiel-EG 1,5 → 0,8 ms, 100k Linien + 3000 Schraffurflächen 3,9 → 1,8 s, nur
      Schraffur ~2×, nur Linien 104 → 81 ms (davon Kodieren in TS 7–29 ms). Mac-Test bestanden.
  - ◐ **[K3a] Plan-Erzeugung in Rust** (Wand-Poché, Öffnungssymbole, Decken, Treppen, Dächer, Räume,
    2D-Zeichnung, Kontext, Schnittlinien) direkt in den Plan-Puffer; JS-Objekte nur noch für Export/Overlay.
    Vorgehen (28.10.): je Domäne ein Rust-Modul mit flacher Primitivliste, TS nur als dünne Übersetzung
    (Farbe, Graustufen, Pick-ID) — kein Format-v2, bis [K3d] den Puffer direkt liefert.
    ✅ Treppen: `plan_stairs.rs` (`plan_stair_flat`), `generatePlan/stairs.ts` nur noch Übersetzung; bitgleich zur
    alten TS-Fassung (49 Fälle: gerade/L/Wendel, Pfeilstil, Schnitthöhen). Nicht in der Tauri-App angesehen.
    ✅ Wand-Poché und Decken-Umriss: `plan_walls.rs` (Segmente zwischen Öffnungen, Gehrungsbänder, Schichtfugen,
    L-Anschlüsse, Durchgangswand-Aussparungen, Verdeckung durch Wand-Footprints). Stil (Bauteil, Schraffur, Farbe,
    Fugen-Linienstil) bleibt in TS, bis das Modell in Rust liegt [K4]; Zuordnung über den Schichtindex. Bitgleich zur
    alten Fassung (60 Zufallspläne × 3 Detailgrade, Öffnungen, Beispielprojekt, Decken mit/ohne Loch); `subtractIntervals`/
    `segmentInsideWallBand` aus TS gelöscht. Nicht in der Tauri-App angesehen.
    ✅ Öffnungssymbole (Tür/Fenster): `opening_geom.rs` (Pfosten, Lücke, Türblätter, Fenster-Symbol mit Flügel-/Stulpmarken)
    und `plan_openings.rs` (Symbol, Rahmenband, Sturzlinien, Sims, Rollladenkasten); Linien-Overrides lösen in TS auf,
    Farben kommen als Slot zurück. `geometry/opening.ts`: `doorSymbol`/`doorLeaves` gelöscht, `windowSymbol` ist Fassade
    (Schnitt nutzt sie weiter). Bitgleich zur alten Fassung (80 Zufallsfälle × 3 Detailgrade, alle 13 Linienklassen;
    600 Zufalls-Fenstersymbole). Tote halbe Ports in `kernel2d` (door/window_symbol, jambs …) entfernt.
    ✅ Kontext-Mesh (Fussabdruck, Rahmen), Schnittführungs-Symbol, Linienenden: `plan_misc.rs`; bitgleich (200 Zufalls-Meshes,
    200 Schnittebenen-Sätze, 400 Linienenden). Räume, Dächer, Stützen, Extrusions-Umriss, Baurecht, Schatten sind nur
    noch Stil-Glue um schon in Rust berechnete Geometrie (kein Rechenanteil) — bleiben bis [K4] in TS.
    ✅ Kurven (Ellipse, Bezier, Catmull-Rom, B-Spline): `curves.rs`, `geometry/curves.ts` ist Fassade; bitgleich (500 Zufallsfälle).
    `jsnum::pow` (= `Math.pow` im Web-Build) für `x ** 3`.
    Offen: `drawing2d.ts` (950 Zeilen) ist nach diesen Schritten Stil-Auflösung und Verteiler über Formen (Bemassung, Kote,
    Detailverweis, Massstabsbalken, Block über `scaleGeom`); der Rechenanteil liegt in Rust. Der Verteiler zieht mit dem Modell
    nach Rust [K4] — vorher würde ein Rust-`Drawing2D` doppelt gepflegt. Danach: [K3c] Schnitt/Ansicht, [K3d] Aufräumen.
  - ◐ **[K3c] Schnitt und Ansicht** (`toSection`, `toElevation`, `meshSection`) im selben Puffer-Format.
    ✅ Schnitt-Bänder: Dominanz-Subtraktion, Verschmelzung, Rechteck-Vereinigung (`plan_section.rs`, 28.10.).
    ✅ Ansicht: Verdeckungs-Clipping, Punkt-Verdeckung, Schlagschatten, XOR-Umriss (`plan_elevation.rs`, 28.10.).
    ✅ Ansicht: Flächen (Wand-Quader, Decken-Prismen, Dach/Giebel) projizieren + Rückseiten-Culling, Eck-Verlängerung, Öffnungen (Rahmen, Glasfelder, Sprossen, Sims, SIA-Symbol) (`plan_elevation.rs`).
    ✅ Netz-Ebenenschnitt (Körper/Gelände) + Ringe→Flächen (`mesh_section.rs`; behebt nebenbei: rückwärts geschlossene Ringe gingen verloren).
    ✅ Dach-Schnittspur (Cyrus–Beck, lineare Oberkante, Verschmelzen) in `plan_section.rs`.
    ✅ Abzugskörper-Geometrie (`voids.rs`: Polygon minus Schneider mit Schlüsselloch-Stegen, Strecke ausserhalb, Schnitt-Rechtecke); behebt: bei mehreren getrennten Aussparungen wurde nichts abgezogen.
    Rest in TS (28.10.): Stil-Auflösung (Bauteil, Schraffur, Farbe, Linienstil, Pick-IDs, Painter-Reihenfolge) in `generatePlan*.ts`,
    `toSection.ts` (Besitzer-Zuordnung, Schichtbänder), `toElevation.ts` (Orchestrierung), `sectionOpenings.ts`, `planUnderlay.ts`,
    `drawing2d.ts`. Das ist kein Rechenanteil mehr, sondern liest das Modell; es zieht mit [K4] um.
  - ◐ **[K3d] Aufräumen:** TS-Primitive-Erzeugung löschen, SVG/PDF/DXF-Export lesen den Puffer. Hängt an [K4]: Rust braucht das
    typisierte Modell (Bauteil-Typen, Schraffuren, Linienstile, Kategorien) und einen Plan-Puffer v2 mit Pick-IDs + vollem `Primitive`-Umfang
    (Text, Schraffur-Optionen, Zickzack/Motiv); die Verbraucher von `Primitive[]` (SVG/PDF/DXF, Auswahl, Overlay) lesen dann den Puffer.
    Stand 28.10.: Rust-Grundlage `core/src/plan/{prim,style}.rs` (Primitive-Typ mit TS-gleicher JSON-Form, Auflösung By-Layer/By-Object,
    `resolve_hatch`). Offen: Overrides-Engine, Raum-Stempel/richText, Domänen (Decken, Dächer, Räume, Wände+Öffnungen, Treppen, Stützen,
    Körper, Kontext, Schnittlinien), Orchestrator (drawings2d bleibt vorerst TS), Plan-Puffer v2 (GPU-Chunk-Cache braucht Inhalts-Hash statt Objekt-Identität).
    ✅ (28.10.) Plan-Erzeugung auf dem Dokument, Abfrage `planDomains` (`plan/{domains,walls,stairs,overrides}.rs`): Override-Regeln
    (`overrides.rs`, wie `overrides/engine.ts` inkl. JS-`trim`), Decken (Brücken-Trick, Wand-Footprints, Umriss-Verdeckung), Dächer
    (Ansichts-Schraffur der Eindeckung), Räume mit Raumstempel-Daten (`roomStampToDoc`/`roomStampExtraLines`/`formatStampArea`/
    `docFromText` portiert; `js_fmt::js_number` = JS-`String(Zahl)`; Text-Layout bleibt TS), Wände mit Verschneidung, Poché-Stil,
    Fugen-Linienstil (Zickzack/Motiv), Referenzlinie und Öffnungs-Symbolen, Treppen, Stützen, Extrusions-Umrisse und das Ausmass
    dieser Domänen; mit `global` auch Kontext-Konturen (Höhenlinien, Mesh-Fussabdruck, Gelände-Rahmen, Pick-Bänder — die Meshes
    gehen nicht mehr über die WASM-Grenze) und Schnittführungs-Symbole. `generatePlan` ruft die Abfrage einmal je Geschoss und setzt die Primitive an ihre Stelle der Zeichenreihenfolge;
    Sichtbarkeit/Darstellungsmodus gehen als Code-Mengen mit (`show`/`grey`). Gelöscht: `generatePlan/{ceilings,roofs,rooms,structures,
    walls,openings,stairs,context,sections}.ts`, `model/joins.ts` (+ Test, fehlende Fälle in `joins.rs` nachgezogen), Bindungen `compute_joins_flat`,
    `join_priority_resolution`, `plan_wall_poche_flat`, `plan_opening_flat`, `plan_ceiling_outline_flat`, `plan_stair_flat`, `context_footprint_flat`, `context_bbox_flat`,
    `section_line_flat`, TS-Helfer
    `stairsOfFloor`/`stairLabel`/`columnsOfFloor`/`roomsOfFloor`. Gleichheit: Primitive-JSON (Schlüssel sortiert) bitgleich zur alten
    TS-Fassung über Beispielprojekt + 80 Zufallsprojekte (mit Kontext-Meshes/Höhenlinien, variierten Schnittlinien, Override-Regeln,
    Fenster-/Türtypen, Fugen-Linienstilen) × 2 Geschosse × 3 Detailgrade × 2 Sichtbarkeits-/Graustufen-/Mono-/
    Referenzlinien-Varianten (972 Pläne inkl. Fehlermeldungen kaputter Decken/Schraffuren), CLI-SVG Beispiel-EG/OG und grosses Projekt
    byte-gleich (temporärer Paritätstest, danach entfernt). Nicht in der Tauri-App angesehen.
    Messung (`generatePlan`, Node, Linux-Container unter Last, Min/Median über Wiederholungen, alter Stand mit gleich gebautem Kern):
    Beispiel-EG 0,3–0,35 → 0,65–0,7 ms (feste Kosten der Abfrage und der JSON-Übergabe); grosses Projekt (Beispielhaus 20×20: 3600
    Wände, 400 Decken/Räume/Treppen, 1600 Stützen) EG 320–340 → 355–370 ms, also ~10 % langsamer. Die Rechnung selbst ist schneller,
    aber die Antwort ist ~14 MB JSON (Wände 9,3 MB, Treppen 3,7 MB): Abfrage inkl. Serialisierung ~160–210 ms, `JSON.parse` ~145–225 ms.
    Die JSON-Form ist damit der Engpass → Plan-Puffer v2.
    Offen: `drawing2d.ts` (Verteiler), Schatten/Baurecht (dünner Stil-Glue um `analysis/`, Datum/Sonnenstand in TS), Abzugskörper
    (`voids.ts`), Mono, Strichstärken-Massstab und `generateVisibleLevelsPlan` bleiben TS; die Override-Engine in TS bedient nur noch 2D-Zeichnungen. Plan-Puffer v2
    s. nächster Punkt (28.10. erledigt).
    ✅ (28.10.) **Plan-Puffer v2**: `planDomains` antwortet binär statt mit ~15 MB JSON (`doc_query_bin` → `queries.rs::run_bin` →
    `plan/domains.rs::plan_domains_buf`). Format im Kopf von `plan_buf.rs` (Gegenstück `src/plan/planBuf.ts`): Bytes mit f64-Teil
    + UTF-16-Texten; Kopf mit Magie "PLB2"/Version 2, Ausmass und Flags; gemeinsame Tabellen für Strings (Farben, Klassen, Ids,
    Text-JSON) und Schraffuren (je Eintrag einmal als JSON für TS + numerischer Hatch-Datensatz für die GPU); Gruppen (die neun
    Domänen); Offset-Tabelle (wahlfreier Zugriff); Inhalts-Hash je Primitiv; Einträge `[tag, flags, Pick-Art, Pick-Id, …]` mit
    Punkt-/Listen-Pool; voller `Primitive`-Umfang (Polygon mit Löchern/noStrokeEdges, Linie mit Strichmuster null/Liste, Zickzack,
    Motiv, Bogen, Kreis/Bogen der 2D-Zeichnung; Raumstempel, Texte, Textpfad, Bild als JSON „wie heute“). v1 und die TS-`parseColor`
    sind gelöscht (Farben parst jetzt `plan_buf::parse_color`, bitgleich); `prim.rs` kennt auch `drawingTextPath/Image/Circle/Arc`.
    TS liest den Puffer zu `Primitive[]` (gleiche Felder und Reihenfolge wie das alte JSON, Schraffur-Objekte geteilt);
    die GPU-Kompilierung liest Bereiche direkt aus dem Kern-Puffer (`compilePlanBufRange`: Puffer einmal im Kern gehalten,
    `plan_buf_hold`/`gpu_compile_held`, höchstens 8 Puffer/96 MB), gemischte Listen kodiert TS schlank (`lean`).
    GPU-Chunk-Cache: `Plan.bufRuns` merkt sich die Kern-Abschnitte (auch über Abzugskörper, Geschoss-Überlagerung, kompakte
    Unterlage hinweg; Mono/Strichstärken-Massstab lassen sie weg); dort zählt der Inhalts-Hash statt der Objekt-Identität, Chunk-
    Grenzen auch an Bauteil-Ids. Neu erzeugter Plan mit gleichem Inhalt → 0 Chunks neu (vorher alle), eine Wand verschoben → 1 von 69.
    Gleichheit (temporärer Paritätstest gegen den alten Kern, danach entfernt): planDomains-JSON nach Dekodierung Zeichen für Zeichen
    gleich (ohne Sortieren) über Beispiel + 120 Zufallsprojekte (Zickzack/Motiv-Fugen, Random-Schraffur, Override-Regeln,
    Zusatzwände/-öffnungen/-stützen/-treppen, kaputte Schraffuren/Deckentypen → gleiche Fehlermeldungen) × 2 Geschosse × 3 Detailgrade
    mit zufälliger Sichtbarkeit/Graustufe/Referenzlinien/global (726 Abfragen) und das grosse Projekt; GPU-Vertex-/Index-/Batch-Puffer
    byte-gleich zur v1-Kompilierung (2988 Puffer: Kern-Puffer direkt, ganzer Plan schlank kodiert, gepackt/ungepackt, LOD);
    CLI-SVG Beispiel-EG/OG und grosses Projekt byte-gleich; `npm run e2e` grün.
    Messung (Node, Linux-Container unter Last, Min/Median): `generatePlan` Beispiel-EG 0,63/0,76 → 0,32/0,51 ms; grosses Projekt
    (Beispielhaus 20×20, `plan/bigSampleProject.testing.ts`: 3600 Wände, 56 824 Primitive) 386/442 → 171/210 ms. Davon Abfrage
    122–130 ms (Rechnung ~130 ms nativ, Puffer schreiben 21 ms statt JSON 38 ms), Lesen in TS 39 ms (vorher `JSON.parse` 148 ms);
    Puffer 9,2 MB statt 15,5 MB JSON. GPU-Kompilierung des ganzen grossen Plans unverändert ~0,5 s (Rechnung, nicht Übergabe).
    Noch über `Primitive[]` (dekodiert): SVG/PDF/DXF-Export, Auswahl/Picken (`ownerIndex`, `segmentIndex`), Overlay/Texte
    (`nativeText`, PlanView), Culling, Fang, `toRenderScene` → render2d (`scene_bin.rs`, Browser-Ansicht und `push_native_scene`,
    unverändert). Offen: diese Verbraucher auf den Puffer umstellen (Picken über Pick-Art/Id je Eintrag; render2d-Szene direkt aus
    dem Puffer), TS-Anteile (2D-Zeichnungen, Schatten/Baurecht) in den Puffer schreiben. Nicht in der Tauri-App angesehen (der
    direkte GPU-Weg läuft nur im nativen macOS-Renderer; geprüft über die hochgeladenen Puffer in Vitest).
  Nachteile (bewusst): Übergang mit doppelter Datenhaltung, Format muss TS/Rust gleich bleiben
  (Versionsnummer + Hin-und-zurück-Tests), Text-Layout bleibt bis [K4] in TS.
- ◐ **[K4] Modell und Ops in Rust** [2]; TS bekommt die Typen generiert (z. B. `ts-rs`). · XL
  Ziel (Entscheid 28.10., Maintainer): nur die UI bleibt TS, alles andere Rust. Vorgehen in Stufen, jede verdrahtet und mit
  Gleichheitstest gegen die TS-Fassung, die im selben Schritt verschwindet:
  - ✅ **S1 Dokument im Kern** (28.10.): `document.rs` hält das Projekt als JSON-Baum, `core/document.ts` spiegelt jede
    Änderung von `store.project` (setProject, Laden, Undo/Redo) als Ops (`diffToOps` → `doc_apply`); Selbstheilung durch Neuöffnen.
    Test: 300 Zufallsänderungen, Kern-JSON == TS-Projekt. (Spiegel, TS ist noch Quelle der Änderungen.)
  - ◐ **S2 Ableitungen lesen das Dokument** (28.10.): typisiertes Rust-Modell `model/` (`generated.rs` aus den TS-Typen per
    `scripts/gen-rust-model.py`, `manual.rs` für getaggte Unions; Hin-und-zurück-Test gegen das Beispielprojekt mit
    `deny_unknown_fields`), `Document::project()` als gecachte typisierte Sicht, `documentFor(project)` (TS) hält ein gemeinsames
    Dokument per Differenz aktuell. Verbraucher bisher: Kennzahlen (`kennzahlen.rs::compute`), Baurecht-Prüfung/Footprint/Modellhöhe (`site_rules.rs`); Abfragen laufen
    über `doc_query`, Modell-Nachschlagen in `model/helpers.rs`. TS-Sammler gelöscht.
    Sonnenstand/Schatten ebenso. **3D-Modell komplett** (28.10.): `model3d.rs` (Wände mit Verschneidung/Bändern/Öffnungen, Decken, Treppen,
    Stützen, Dächer inkl. Schnitt-Schichten, Öffnungs-Einbauteile, Kontext) → `projectToModel3d` holt die Teile per `doc_query`
    (`queries.rs`), nur die truck-Körper (async) fügt TS ein; TS-Sammler `toWalls3d/{bands,ceilings,columns,openings,stairs,roofs}.ts`
    gelöscht, unbenutzte Bindungen/Kodierer entfernt. Hin-und-her-Vergleich mit der TS-Fassung lief über Zufallsprojekte, danach
    prüft die bestehende Suite (2123 Tests) den neuen Weg. Das Modell ist tolerant (fehlende Felder = Standardwert).
    Pick-Geometrie und 2D-Boden-Spuren im 3D ebenfalls im Kern. **IFC-Export** (`export_ifc.rs`, `js_fmt.rs` für JS-`toFixed`, `geo_rebase.rs`)
    byte-genau zur TS-Fassung (Vergleich über Zufallsprojekte; das Salz der GUID-Ableitung beginnt mit U+0001 — so seit jeher, bleibt für
    stabile GUIDs). Modell verlustfrei (`Extra`-Felder), typisierte Sicht wird nach Ops feldweise nachgeführt.
    **Zusammenführung 28.10. (Cloud):** Der IFC- und OBJ/STL-Export liefen parallel auch in `src-tauri/fileio` weiter
    ([B5]/[C11]: IFC2x3, Basismengen, Öffnungen, Zonen, Klassifikation, glTF …). Behalten ist die `fileio`-Fassung; die
    Kern-Duplikate `export_ifc.rs`, `export_mesh.rs`, `geo_rebase.rs`, `web/export_ifc.rs`, `doc_export_ifc` und die
    Abfragen `objFile`/`stlFile` sind gelöscht. Die Exporte holen ihre 3D-Teile über `export/model3dParts.ts` aus dem
    Dokument (`queries.rs`). Offen: `fileio`-Schreiber direkt aus dem Dokument füttern statt über den TS-Sammler.
    Nächste: Export (Schedule/CSV, STL/OBJ, STEP), Plan/Schnitt/Ansicht-Sammler (generatePlan, toSection, toElevation) — hängt an Plan-Puffer v2.
    Grundriss (28.10.): Decken, Dächer, Räume, Wände+Öffnungen, Treppen, Stützen, Extrusionen, Kontext und Schnittlinien
    kommen über `planDomains` aus dem Dokument ([K3d]); übrig in `generatePlan`: 2D-Zeichnungen, Schatten/Baurecht, Abzugskörper.
    Ziel: Plan/Schnitt/Ansicht, 3D, Export rechnen mit `doc`-Handle statt flach gesammelter Arrays; TS-Sammler/-Adapter werden gelöscht
    ([K3d] hängt hier dran: Plan-Puffer v2 mit Pick-IDs und vollem Primitive-Umfang).
    Stand 28.10.: Plan-Puffer v2 steht ([K3d]) — `planDomains` liefert binär, GPU liest ihn direkt; Export/Auswahl/Overlay lesen
    noch die dekodierten `Primitive[]`.
  - ◐ **S3 Änderungen kommen aus Rust**: Befehle (Zustandsautomaten, Werkzeuge) erzeugen Ops im Kern; Undo/Redo, Validierung
    (`validateOps`) und Gruppen/Ebenen-Logik wandern nach Rust; `diffToOps` entfällt, TS hält nur noch eine Leseansicht.
    **Erste Etappe (28.10.): Ops, Prüfung, Undo/Redo im Kern.** `core/src/ops.rs` (Op, Prüfung bitgleich zur TS-Fassung — gleiche
    Ablehnungen und Meldungen; NaN/±Infinity reisen als Marken `"\u0001NaN"`, weil JSON sie nicht kennt), `document.rs`
    `commit`/`undo`/`redo`: atomar anwenden, prüfen, bei Verstoss über die inversen Ops zurückrollen; Verlauf als **inverse Ops**
    statt Schnappschüssen (feine Inverse je Op, Feld-Sicherung nur bei Alt-Doppelungen/fehlendem Feld; Feld-Position wird mit
    zurückgegeben, Undo ist JSON-exakt). coalesceKey + Zeitfenster (400 ms) und Gruppen (`doc_group_begin/end`, Store
    `groupChanges`) = ein Schritt; Drag-Serien werden verdichtet (wachsen nicht je Mausbewegung); Grenzen 100 Schritte /
    256 MiB (älteste fallen weg). Store: `setProject` → `diffToOps` → `ProjectDocument.commit` (Kern) → TS führt die
    Leseansicht mit denselben Ops nach (`applyOps`); `undo`/`redo` holen die Ops aus dem Kern (`doc_undo`/`doc_redo`).
    TS-Snapshot-Undo und TS-`validateOps`/`validateProject`-Rechnung gelöscht (Fassaden über `ops_validate`/`project_validate`).
    Das Store-Dokument ist zugleich das Abfrage-Dokument (`documentFor` → kein zweiter Spiegel). Store-Felder
    `undoStack/redoStack` → `undoDepth/redoDepth`, `clearHistory()`.
    **Entscheid Richtung (28.10.):** halb umgedreht. Der Kern ist Autorität für Prüfung und Verlauf; das TS-Projekt ist eine
    Leseansicht, die nur mit Ops nachgeführt wird, die der Kern angenommen (`commit`) oder geliefert (Undo/Redo) hat — so kann
    sie nicht auseinanderlaufen (Test: 1000 Zufallsänderungen, Undo bis Anfang/Redo bis Ende, Kern-JSON == TS-Projekt).
    `diffToOps` bleibt vorerst als Adapter, weil ~50 Store-Aktionen, Griffe, Panels und `src/commands` noch Projekt → Projekt
    liefern; die volle Umkehr (ganzes Projekt als JSON zurück) ist verworfen: sie kostet je Schritt Parse-Zeit und zerstört die
    Objekt-Identität unveränderter Elemente, auf der die Plan-/3D-Caches beruhen. Patches (Ops) erhalten sie. Änderungen vorbei an
    den Ops (direktes `setState` in Tests) zieht der Spiegel per Differenz nach und leert den Verlauf.
    **Messung** (Linux-Container): Kern nativ (release), 5000 Wände: commit 51 µs, Undo 37 µs, Redo 36 µs je Schritt. Über WASM im
    Store-Weg (vitest, 3000 Wände, 500 Schritte): 2,6 ms/Schritt, davon `diffToOps`+`applyOps` in TS ≈ 2,0 ms, Kern-Commit ≈ 0,4 ms;
    Undo 0,08 ms, Redo 0,07 ms; Verlauf ≈ 780 KiB für 500 Schritte.
    Offen: Befehle/Store-Aktionen erzeugen Ops direkt (dann entfällt `diffToOps`, der grösste Kostenanteil); `applyOps` bleibt als
    Patch-Anwendung der Leseansicht; Ebenen-/Gruppen-Logik (`groupActions.ts`) nach Rust; Undo-Verlauf als Liste in der UI [84].
  - ○ **S4 Typen aus Rust**: `types.ts` wird aus den Rust-Strukturen erzeugt (ts-rs); Datei-I/O (`projectFormat`, Migration, IFC/DXF/
    STEP-Ex- und -Import) im Kern.
  Offene Entscheide/Risiken: Kosten der JSON-Übergabe bei grossen Projekten (Teil-Updates statt Neuaufbau), Struktur-Sharing im
  React-Store (TS-Spiegel bleibt bis S3), Befehls-Zustandsautomaten sind viel Code (`src/commands/cmds/*`).
- **Fertig wenn** (je Etappe): TS-Fassung gelöscht, `npm run check` grün, App/CLI/IFC unverändert.

## Was die Analyse übersieht (Ergänzungen zum Vergleich)

- **Geometrie ist der eigentliche Rückstand.** BIMCraft hat laut README Bogenwände, Gauben,
  Grate/Kehlen auf beliebigen Grundrissen, Dach aus Extrusion, IFC-Import und Hidden-Line-
  Ansichten. DOSSIER: alles Prisma, Wand unter Dach in 15-cm-Stufen, Ansicht per Painter-
  Verfahren, kein Geländeschnitt → Abschnitt **Geometrie [G]**.
- **`native2d`** (Grundriss über Metal unter der Webview) fehlt im Vergleich — es gibt heute
  vier 2D-Pfade, nicht drei.
- **Vorsprünge von DOSSIER:** Perspektive/Nordstern, läuft im Browser, macOS getestet (BIMCraft:
  „macOS app not tested by hand"), STEP-Export/-Import, B-Rep-Grundkörper, Kollisionsprüfung,
  Abzugskörper, Kataster/Swisstopo-Import.

## Rendering-Entscheid [R]

Frage: WebGPU weiterführen oder wie BIMCraft CPU + native GPU?

- Nordstern ist **wgpu** — derselbe Rust-Code läuft im Browser über WebGPU und nativ über
  Metal/Vulkan/DX12 (`render3d`, Feature `render`). Der Unterschied ist nicht WebGPU vs. GPU,
  sondern *wo* der Renderer läuft.
- WebGPU behalten: Browser-Version und Nur-Lese-Link [88] gibt es nur so; eine Codebasis.
- Was BIMCraft mit dem CPU-Rasterizer gewinnt, holen wir gezielt:

- ✅ **[R1] 3D headless nativ rendern.** 27.10.: `render_png` (render3d auf Offscreen-Texture, Metal) +
  `dossier-cli … model3d`. Ersetzt „Nutzer prüft im Tauri-3D". Offen: Golden-Bilder in der CI (braucht
  GPU/Software-Treiber). · M
- ○ **[R2] Grafik-Fallback** = [46].
- ✗ **[R3] Eigener CPU-Rasterizer.** Kein Mehrwert gegenüber [R1] + Three.js-Fallback.
- ✗ **[egui] Probe: native Oberfläche in egui.** (28.10.) Crate `dossier-egui` (eframe/egui 0.35, egui_dock,
  render2d/render3d als Offscreen-Texturen) gebaut und angesehen — verworfen: wirkt wie ein Werkzeug, nicht wie
  eine Mac-App; Gleichstand hätte Monate gekostet. **Die Oberfläche bleibt React/TSX.** Code gelöscht, im
  Verlauf unter `33bad5d`. Geblieben: CLI `plan --format json`, `:beispiel` statt Datei.

---

## Priorität 0 — vor der öffentlichen Beta

- ✅ **[5] Doppelspur `Door[]`/`Opening[]` auflösen.** 27.10.: Formatversion 2, `Project.doors`/`Door`
  entfernt, Legacy-Pfade gestrichen. · M
- ✅ **[12] Dateien tolerant lesen, Befehle streng.** 27.10.: `io/projectFormat.ts` (`formatVersion`,
  Migrationskette, ein Parser für alle drei Ladestellen, Fehler als Toast). Unbekannte Felder **melden,
  nicht löschen**. Offen: „Befehle streng" → [16]/[7]. · S–M
- ✅ **[13] Autosave mit Wiederherstellen.** 27.10.: `state/autosave.ts`, alle 30 s bei ungespeicherten
  Änderungen in IndexedDB, Dialog beim Start und beim Öffnen. 27.10. nachgezogen [B10]: Stand, der während
  des Speicherns entsteht, wird nach dem Löschen der Kopie wieder gesichert (`createAutosaveTracker`). · M
- ◐ **[46] Grafik-Fallback beim Start.** 27.10.: Meldung im Viewport bei fehlendem WebGPU, Start-Protokoll
  mit Hinweis nach unsauberem Ende. Kein Fallback-Renderer mehr (bewusst). · M
- ✅ **[47] Netzwerk in einem Modul.** 27.10.: `src/net/net.ts` (netFetch, Offline-Modus, Host-Liste),
  Test verbietet fetch ausserhalb. · S–M
- ◐ **[14] „Never crash".** TS-Wächter `guarded()` um das truck-WASM (Trap → neu instanziieren, einmal
  wiederholen). Rust-Kern: Bindungen verwerfen Unsinn statt zu paniken. Offen: Wächter für
  render3d/render2d/Kern, Rust-Lints `unwrap_used`/`expect_used`/`panic` auf `deny`, Obergrenzen. · M
- ✅ **[16] Befehle mit Unsinn füttern.** 27.10.: `commands/hostile.test.ts` füttert alle Befehle; fand
  1 Speicher-Explosion (revisionCloud), behoben. · S
- ✅ **[22] Fester Check vor Abschluss.** `npm run check` (tsc, vitest, cargo test aller 6 Crates,
  `--fast` ohne Rust). `cargo fmt`/`clippy` fehlen noch (Riesen-Diff) → eigener Schritt.
- ○ **[30] Release-Workflow.** · M · Hängt an [57].
- ◐ **[57] Tests bei jedem Push.** `.github/workflows/check.yml` (baut alle WASM-Pakete, installiert
  ifcopenshell, `npm run check`; (28.10.) zusätzlich Job `e2e` für [49]). Läuft auf GitHub, sobald Actions aktiv sind. · S–M
- ○ **[60] Nur versprechen, was getestet ist.** · S · Regel, keine Arbeit.
- ○ **[51] Herkunft übernommenen Codes.** · S · fällig mit [B2]/[B3]: Dateikopf (Repo, Commit, Datei,
  „geändert") + `NOTICE` im Repo.
  (28.10.) [B2] erledigt (BIMCraft `skeleton.rs`: Dateikopf mit MIT-Text, `NOTICE`).

Ausserdem für die Beta: englisches README, `CONTRIBUTING.md`, Spiegel, Beispielprojekt, Beta-Hinweise,
Entscheid CLA vs. Verzicht auf Dual Licensing.

---

## Priorität 1 — Fundament

### Architektur

- ◐ **[1] Kernel nach Rust.** → jetzt [K1]–[K3]. · XL
- ◐ **[2] Das Modell gehört dem Rust-Kern.** → jetzt [K4] (entschieden 27.10.). · XL
- ◐ **[3] Darstellungswege reduzieren.** Vier 2D-Pfade (render2d, glPlan, SVG, native2d), zwei
  3D-Pfade. Mit `native2d` zusammen planen; [K3] liefert die Primitive direkt aus Rust. · L
- ✅ **[4] Kern headless als `dossier-cli`.** info/validate/migrate/plan/section/elevation/dxf/ifc/step/
  obj/stl/schedule/kennzahlen/sun/model3d/mcp/bench. · S–M
- ○ **[58] Inkrementelle Ableitung.** Teilweise über Caches. · L

### Befehle, Undo, Validierung

- ◐ **[6] Jede Aktion ist ein Befehl mit JSON-Parametern.** Registratur vorhanden, aber interaktiv;
  Panels/Griffe ändern das Projekt direkt. · L
- ◐ **[7] Zentrale Validierung nach jedem Befehl.** 28.10.: jede Projektänderung wird im Kern geprüft (`ops.rs`, NaN/neue doppelte
  ids → Rücknahme mit Meldung); weitere Regeln (Bezüge, Geometrie) offen. · M
- ◐ **[8] Undo über Befehle.** 28.10.: Verlauf im Rust-Kern als inverse Ops (coalesceKey, Gruppen, Speichergrenze), keine
  28.10. (Mac-Test Maintainer): nach mehrmaligem Ganz-zurück/Vor war Redo weg. Ursache: die Ausschnitt-Leiste legte bei
  leerem `viewSnapshots` automatisch einen Ausschnitt an (Projektänderung → neuer Verlaufsschritt). Jetzt nur Anzeige-Tab
  ohne Projektänderung; Neu/Öffnen/Vorlage/Wiederherstellen leeren den Verlauf; Browser-Öffnen liest Text statt
  ArrayBuffer. Tests: `history.roundtrip.test.ts`, e2e „Mehrmals ganz zurück und wieder vor“.
  Snapshots mehr ([K4] S3). Offen: Befehle erzeugen Ops direkt statt `diffToOps`. · M
- ◐ **[9] MCP-Brücke.** Headless `dossier-cli … mcp`; Brücke zum offenen Fenster fehlt. · M

### Daten

- ✅ **[10] IDs und GUIDs trennen.** IFC-GUIDs werden deterministisch aus Projekt-, Art- und Element-id gehasht (28.10., [B5]). · M
- ○ **[11] Bibliothek per GUID.** · M

### Robustheit und Tests

- ○ **[15] Kostenbudget.** Zeit-/Schrittbudget je WASM-Geometrie-Operation, Booleans im Worker ([48]). · M
- ◐ **[17] Ergebnisse über die Ausgabe testen.** Golden-SVGs für Plan/Schnitt/Ansicht; 3D noch nicht. · M
- ✅ **[18] IFC gegen IfcOpenShell.** = [B1]. 27.10.: `scripts/validate-ifc.py` + `exportIfc.validate.test.ts`. · S–M
- ◐ **[19] Beispielgebäude als Skript.** `sampleProject.ts` + Kontrollmodell. · S
- ◐ **[20] Performance-Benchmark.** `dossier-cli … bench`; grosses Testgebäude/Frame-Zeiten offen. · M
- ◐ **[49] UI-Tests wie ein Mensch.** (28.10.) Suite in `e2e/` (`npm run e2e`, Playwright, baut `dist-test`,
  `vite preview` Port 5199; nicht in `npm run check`, eigener CI-Job `e2e` in `check.yml`). 14 Tests, ~40 s:
  Start, neues Projekt, Beispielprojekt (Vorlage), Wand per Klicks und per Befehlszeile, Rückgängig/Wiederholen
  (Tastatur + Menü), Eigenschaft ändern (Wand-OK), Geschoss wechseln, 3D-Ansicht, Speichern, Export IFC/DXF,
  DXF-Import. Geprüft wird über sichtbaren Zustand (Elemente-Baum, Panel-Werte), nicht über Pixel; Konsolenfehler
  scheitern, ausser der Erlaubt-Liste in `e2e/app.ts` (wgpu-Panik headless). Offen: **Projekt öffnen im Browser ist
  kaputt** (`onProjectFileChosen`: `readAsArrayBuffer` + `String(result)` → „kein gültiges JSON"; Fix `readAsText`) —
  zwei Tests sind bis dahin als `test.fail` markiert; Debug-Hook für den Store fehlt (bräuchte
  `window.__dossierStore` nur bei `?e2e`); Pixel/Rendering (render2d/render3d) headless nicht prüfbar;
  Strichstärken/Text/Block/Raum/PDF-Export, Schnitt/Ansicht noch ohne UI-Test. Neu: Datei-Menü im Browser hat
  Exportieren: DXF/IFC/OBJ/STL (vorher kein UI-Weg). · M
- ✅ **[50] Test für fehlende Übersetzungen.** `i18n/untranslated.test.ts` mit Baseline. · S

### Arbeitsweise mit Claude Code

- ◐ **[21] Geschichtete Agenten-Doku.** `CLAUDE.md` mit Regeln/Modulkarte/Rust-Kern; `docs/areas/` fehlt. · M
- ✅ **[23] Ergebnis anschauen.** 2D und 3D headless (CLI → SVG/PNG, [R1]). · M
- ○ **[24] Test first.** Regel.
- ✅ **[53] Grössengrenze `CLAUDE.md`.** Test `core/agentDocs.test.ts`. · S
- ✅ **[54] Roadmap mit Grössen** — diese Liste.
- ○ **[55] `IDEAS.md`.** · S

---

## Priorität 1b — Geometrie [G]

Reihenfolge = Abhängigkeiten. Neue Geometrie entsteht in Rust ([K]).

- ◐ **[G1] Ebenenschnitt beliebiger Körper** — `plan/meshSection.ts` (Ringe, Löcher, offene Linienzüge),
  im Schnitt für Geländelinie und freie/B-Rep-Körper. Offen: Grundriss-Poché für Körper,
  Treppenuntersicht, Abzugskörper beliebiger Form im Schnitt. · L
- ◐ **[G2] Wand an Dach.** 27.10.: schräge Oberkante (`topDrop`) in render3d statt 15-cm-Treppung. Offen:
  Schnitt, exakte Lösung über [B6]. · M–L
- ○ **[G3] Öffnungen beliebiger Form** (Rundbogen, rund, schräg) als Abzugskörper. · M · nach [G1].
- ○ **[G4] Exakte Sichtbarkeit (HLR)** für Ansicht und Projektionsteil des Schnitts. · XL
- ○ **[G5] Dächer untereinander, Gauben, Wand ↔ Decke** per Boolean. · L · nach [G1]/[G2].
- ○ **[G6] Allgemeine Polygon-Dominanz im Schnitt** (nicht nur Rechtecke). · M
- ○ **[G7] Robuste Booleans bei bündigen Flächen** — wächst mit jeder Phase. · L (laufend)
- ✅ **[G8] Abzugskörper (senkrechte Prismen)** — Grundriss, Schnitt, 3D, STEP. Offen: Ansicht,
  Schraffur-Deckel im 3D-Live-Schnitt.
- ○ **[G10] render2d-Punkte f32** (Fund aus [K3b], geprüft 27.10.): `render2d::types::Scene` speichert Punkte
  als f32 (~0.25 m Auflösung bei ~2.6e6 m). **Real betroffen:** DXF/DWG-Import mit Platzierung „origin"
  (Vorgabe im Import-Dialog, `ImportDialog.tsx`) behält die Landeskoordinaten → im Browser-/Electron-Pfad
  (WASM-render2d, `useWasmPlanRenderer.ts`) wackeln/verschmelzen Linien eines Katasterplans. **Nicht
  betroffen:** macOS-Metal-Pfad (GPU-Kompilierung mit `origin`-Verschiebung), lokal gezeichnete Projekte,
  Standort-Import (Modell-(0,0) = Suchzentrum). Lösung: Szene relativ zu einem Ursprung kodieren
  (`renderSceneBin.ts`/`scene_bin.rs` + Kamera-Versatz in f64 in render2d, wie `GpuGeometry.origin`). · S–M
- ✅ **[G9] Dach-Gehrung an Walm-/Zeltspitzen** (neu 27.10.): an Punkten mit ≥ 3 Dachflächen trifft die
  paarweise Gehrung der Unterseite nicht exakt (Restlücke < 0.01 m²); solche Dächer gehen als nicht
  geschlossenes Face-Set ins IFC. · S–M
  (28.10.) Nicht durch den Skeleton gelöst (auch dessen Flächen treffen sich an Spitzen mit zwei
  Neigungen, Kehlpunkten und zwischen konvexen Teilstücken einer Fläche): `Mitre` in `model3d.rs` gibt
  allen Flächen an einem Punkt mit > 2 Flächen dieselbe versetzte Ecke (kleinste Quadrate über alle
  Ebenen, unterbestimmt → nächster Punkt der Schnittgeraden); Punkte mit 2 Flächen unverändert. Gemessen
  vorher: Zelt 7×5 m 1.1e-3 m², Walm/Zelt auf L 0.77–1.2 m², Mansard-Walm auf L 0.93 m² Lücke; jetzt jede
  Schicht geschlossen (Test `g9_dachschichten_geschlossen`: Rechteck/L/U/konkav/schief × alle
  Skelett-Formen × First x/y × zwei Schichten). Nicht in der App/IFC-Prüfung angesehen.

## truck [T]

- ✅ truck 0.6, B-Rep-Grundkörper, Booleans mit Mesh-Fallback, Transformation, STEP-Export und -Import,
  Kennwerte, Kollisionsprüfung, `mesh`-Spec.
- ○ **[T1] Polyeder-Körper** (`try_attach_plane` → Shell → Solid). · M
- ○ **[T2] Bogenwände** (`tsweep`/`rsweep` mit Kreisbögen). · L
- ○ **[T3] Wendeltreppe/Wendelfläche** + Handlauf-Sweep. · M
- ○ **[T4] Import-Meshes glätten oder kantig** (`add_smooth_normals`). · S
- ○ **[T5] Import reparieren** (`put_together_same_attrs`, Healing). · S
- ○ **[T6] Glattes Gelände aus Höhenlinien** + Gelände-Prisma für Aushub (= [68]). · L
- ○ **[T7] Rotationskörper/Loft im UI** (API besteht). · S–M
- ○ **[T8] Kollisionsprüfung im 3D zeigen** (heute nur Marker im Grundriss). · S

---

## Priorität 2 — Wettbewerbswerkzeug

- ✅ **[41] Massenmodelle.** `analysis/kennzahlen.ts`: GF/aGF je Geschoss, GV aus Körpern.
- ✅ **[61] Raumprogramm gegen Modell.** `checkRoomProgram`, Editor im Flächenbilanz-Panel (27.10.).
  **Import, Soll/Ist, Räume generieren (28.10.):**
  (1) Import aus .xlsx/.ods/.csv/.tsv: Leser in Rust (`fileio/src/sheet_import.rs`, nur `zip` + `quick-xml`, kein neues
  Crate; CSV UTF-8/UTF-16/Windows-1252, Trenner `;` `,` Tab; Zahlparser „1'250,5“, „12,5 m²“), Zuordnung in
  `io/roomProgramImport.ts` (Kopfzeile + Spalten nach Namen de/en/fr, Summen-/Leerzeilen, Zwischentitel → Gruppe),
  Dialog `ui/RoomProgramImportDialog.tsx` (Knopf „Raumprogramm importieren …“, ersetzen/anhängen). Neue optionale
  Felder `RoomProgramRow.group?`/`note?` (Flächenart = bestehendes `siaCategory`), `Project.roomProgramTolerance?`;
  `generated.rs` von Hand ergänzt (nicht per `gen-rust-model.py`, das nur einmalig war), `KNOWN_KEYS` nachgeführt.
  (2) Soll/Ist in Rust (`core/src/room_program.rs`, Abfrage `programCompare`): Zuordnung nach Namen (genau vor
  Präfix, ohne Nummer/Gross-Klein), Differenz abs/%, Summen je Gruppe/Flächenart/total, Ampel (Standard ±5 %, im
  Projekt einstellbar; `checkRoomProgram` ist jetzt Fassade, Standard-Toleranz damit 5 statt 10 %), Export CSV/PDF
  (`export/programReport.ts`), CLI `raumprogramm [--import tabelle] [--generate] [--format json|csv|svg|pdf]`.
  (3) „Räume generieren“: neues Blatt (Zeichnungsebene „Raumprogramm“, Art `drawing`), je Raum Rechteck + Name +
  Fläche im Verhältnis 4:3 mit exakter Soll-Fläche, Shelf-Packing je Gruppe (Abfrage `programLayout`), ein Undo-Schritt.
  Entscheid: 2D-Zeichnungen statt `Room`s — echte Räume zählen in Flächenbilanz/-tabelle/Kennzahlen/IFC und würden
  das Ist verfälschen. Offen: Ist je Raum nur über den Namen (keine Zuordnung per Hand); Gruppen werden untereinander
  gestapelt (nicht nebeneinander); beim Rückgängig bleibt die aktive Ebene auf dem entfernten Blatt (wie beim
  DXF-Import); Ampel im PDF nur als Text; nur im Browser-Build/Linux geprüft, nicht in der Tauri-App.
- ✅ **[62] Kennzahlenleiste.** Flächenbilanz-Panel: GF/aGF/GV/AZ/ÜZ, Parzellenfläche, je Geschoss (27.10.).
- ✅ **[70] Flächentabellen (Flächenarten nach SIA 416) / IVHB.** (28.10.) Kern `core/src/flaechen.rs`
  (Abfragen `areaTable`, `ivhb`), Fassade `analysis/areaTable.ts`, Bericht `export/areaReport.ts`
  (CSV mit Rückleser, SVG, Vektor-PDF), Abschnitt im Flächenbilanz-Panel (`AreaTableSection.tsx`),
  CLI `kennzahlen --sia416 --ivhb --format json|csv|svg|pdf [--agsf --gruenflaeche --agf-basis --untergeschosse]`.
  Tabelle je Geschoss und total: HNF, NNF, NF, VF, FF, NGF, KF, GF, AGF, GV. GF = NGF + KF (Norm); KF aus
  Wandgrundrissen (abzüglich Räume) + KGF-Räumen hergeleitet. IVHB: GFZ, AZ (aGF-Basis wählbar), BMZ, ÜZ, GZ,
  Gesamt-/Fassadenhöhe; aGSF = Eingabe, sonst Parzellenfläche/-grenze.
  Soll/Ist-Nachweis des Raumprogramms: s. [61]. Offen / Annahmen: (a) Die ältere Bilanz (`room_area::rollup`, Kennzahlenleiste [62], IFC-Qto) rechnet die AGF
  noch in die GF — nach SIA 416 gehört sie nicht dazu; angleichen, sobald IFC/Leiste mitgezogen werden.
  (b) Eingaben aGSF/Grünfläche/aGF-Basis/UG-Anrechnung liegen nur in der Ansicht; Vorschlag Modellfeld
  `Project.ivhb?: { agsf?, greenArea?, agfBasis?, includeUnderground? }` (+ `KNOWN_KEYS`), damit sie mit dem
  Projekt gespeichert werden. (c) Massgebendes Terrain = ±0.00 (kein Geländemodell → Baumasse, Höhen).
  (d) Fassadenhöhe = höchste Wandoberkante (Schnittlinie Fassade/Dach nicht ausgewertet); ÜZ ohne
  Vorsprünge/Dachüberstände; Stützen/Schächte nur als KGF-Raum in der KF; GV = GF × Geschosshöhe bzw. Körper.
  (e) Eigene Raumtypen (Büro, Wohnen …): nur Zuordnung Typ → Flächenart in `flaechen::area_kind`, die Tabelle
  bleibt. (f) Als Layout-Element (Tabelle im Blatt) offen: Layout-Annotationen kennen nur Linie/Rechteck/
  Text/Bild; bis dahin eigener PDF-/SVG-Export. (g) IVHB-Wortlaut (Anhang 1, Ziff. 5/8) vor Behördenabgabe
  gegen die kantonale Bauverordnung prüfen. IFC (28.10., [B5]): SIA-416-Zonen und Geschoss-GF/NGF als Qto im IFC-Export. · M
- ○ **[42] Varianten.** · L
- ✅ **[63] Baulinien, Grenzabstände, zulässige Hülle.** (27.10.) Parzelle/Baulinien aus Auswahl,
  Grenzabstand pauschal und je Kante, Gesamthöhe; zulässige Fläche und Verstösse im Grundriss.
  Offen: Vorsprünge (Dachüberstand, Balkone), Hülle im 3D.
- ◐ **[64]+[59] Sonnenstand und Schatten.** (27.10.) Schatten im Grundriss mit Zeitregler (Lage-Panel),
  auch in CLI/PDF. Offen: Schatten im 3D.
- ○ **[88] Nur-Lese-Link fürs Web.** · M
- ✅ **[31] Stiftstärken in Papier-mm.**
- ◐ **[32] Linienstärken pro Massstab.** (27.10.) Projekt-Option skaliert Grundriss-Stärken mit
  (100/n)^0.25; Layout-PDF/Plan-Export nutzen jetzt den echten Massstab. Offen: Schnitt/Ansicht. · M
- ✅ **[69] Georeferenz im IFC.** IfcProjectedCRS EPSG:2056 + IfcMapConversion.

## Priorität 3 — Planproduktion und Darstellung

- ◐ **[33] Objektstile mit Rangfolge.** Regelbasierte Overrides vorhanden. · M
- ○ **[34] Ansichtsvorlagen.** · M
- ◐ **[35] Detailgrad pro Ansicht.** · S–M
- ◐ **[36] View Range.** Unter-/Oberkante im Grundriss fehlen. · M
- ○ **[37] Beschriftung in Papiergrösse.** · M
- ○ **[38] Assoziative Bemassung.** · L · nach [10].
- ○ **[39] Auswahl gehört zum Modell.** · M
- ◐ **[40] Ansichten duplizieren.** Ebenen duplizieren vorhanden. · S
- ◐ **[76] Vektorfang auf PDF.** (28.10.) Rust `fileio/pdf_object.rs` + `pdf_vector.rs` (eigener Leser:
  Querverweis-Tabelle/-Stream, Objekt-Streams, Flate/LZW/A85/AHx, Wiederherstellung kaputter xref,
  verschlüsselt → Fehler; Content-Stream mit CTM, Farben, w/d, ExtGState /LW /D /CA /ca, Form-XObjects,
  Bézier tesselliert, Text mit ToUnicode). Import-Dialog fragt Seite + Massstab (1:1…1:1000, frei); Übernahme
  als 2D-Zeichnung über `dxfToDrawings` (Ebenen nach Strichstärke/Farbe, Flächenfarben) — damit fangbar.
  CLI `pdf-info`, `convert plan.pdf x.obp --scale 100 [--page n]`. Rasterunterlage („Bild/PDF") unverändert.
  Ergänzt (28.10.): Kreise/Bögen aus Bézier-Folgen als echte `circle`/`arc` (Rust `pdf_geom.rs`,
  Toleranz 0.4 % des Radius; Mittelpunkt/Quadranten fangbar; nur reine Bézier-Teilpfade — Rundungen in
  Linienzügen, Ellipsen und angeschnittene Kreise bleiben Vieleck). Strichmuster (d, ExtGState /D) →
  Linienstil: Muster in Papier-mm je Ebene, vorhandener Stil mit gleichem Muster (±15 %) oder neuer Stil
  „PDF-Strich a/b mm" (`io/pdfLineStyles.ts`, Phase entfällt). Clips: W/W* (Rechteck exakt, Polygon für
  Linien exakt, Flächen nur bei konvexem Clip exakt sonst an der Hüllbox), Form-/Seiten-BBox, Texte
  ausserhalb entfallen. Dialog „PDF importieren" mit Zwei-Punkt-Kalibrierung (Vorschau, Fang, wahre Länge
  → Massstab; `io/pdfCalibrate.ts`, `ui/PdfCalibrate.tsx`).
  Offen: Muster/Schattierungen und Soft-Masks, Clip-Pfade mit Text (Tr 7), Kreise in Linienzügen
  (Rundungen als Bogen abspalten), Strichphase; Kalibrierung nicht in der Tauri-App geprüft. · M
- ○ **[77] Zauberstab.** · M
- ✅ **[78] Autotext im Plankopf.** Titelblock löst Projekt/Blatt/Massstab/Datum auf; Plannummer laufend
  oder `Layout.planNumber` (27.10.).
- ○ **[79] Publikationssätze.** · M
- ○ **[80] PDF mit Ebenen.** · M
- ◐ **[81] Automatische Aussenbemassung.** (27.10.) Befehl `autodim` (Kürzel `ab`): je Seite Öffnungs-,
  Vor-/Rücksprung- und Gesamtkette. Offen: schiefe Wände, Massstab aus der Ansicht statt fest 1:100.
- ○ **[82] Grafische Legenden.** · M
- ○ **[65] Explosionsaxonometrie.** · S–M
- ○ **[66] Präsentationspläne mit einem Klick.** · M
- ○ **[67] Skizzenstil.** · M
- ◐ **[25] IFC-Import** → [B3] ✅ (Mesh), [B4] ◐ (Bauteile). · L
- ◐ **[26] Dächer über beliebige Grundrisse.** `geometry/roofSkeleton.ts` (Walm/Sattel/Mansarde/
  Krüppelwalm auf L/T/U, Kehlen, Giebel); Port nach Rust läuft [K2]. Offen: Innenhöfe, schiefwinklige
  Grundrisse → [B2]. · M
  (28.10.) Skelett-Dächer rechnen über den Straight Skeleton [B2]: konkave/schiefe Umrisse mit
  Split-Ereignissen jetzt richtig, Giebelwände schliessen die Stufe an einspringenden Ecken. Offen, weil
  das Modell es nicht ausdrücken kann (Kern kann es, `weighted_roof`): **Vorschlag Modellfelder** am
  `Roof`: `holes?: Vec2[][]` (Innenhöfe, Ring im Uhrzeigersinn), `edgePitchDeg?: (number | null)[]` je
  Umrisskante (null = Giebel; ersetzt dann die Giebel-Regel „quer zur Firstachse"). Satteldach auf
  schiefem Umriss bleibt bei der Bounding-Box (Umstellung auf den Skeleton würde bestehende Dächer
  ändern — Entscheid Maintainer).

## Priorität 4 — später

Alle ○: [27] Punktwolken (Leser ✅ [B9], Anzeige ◐ s. u., Modell offen) · [28] Phasen · [29] Bauteillisten (◐, Export vorhanden) · [43] Verknüpfte
Modelle · [44] Aus Datei einfügen · [45] Favoriten · [68] Gelände mit Baugrube (= [T6]) · [71] U-Werte ·
[72] Graue Energie KBOB · [73] eBKP-H · [74] SIA 500 · [75] Fluchtwege VKF · [83] Befehlspalette ·
[84] Undo-Verlauf · [85] Makro-Rekorder · [86] Pipette · [87] Fang mit Begründung · [48] Web-Worker
(◐, DXF-Parser, IFC-Import) · [52] Icons (◐, `CommandIcon.tsx`) · [56] Startparameter · [89] Git-freundliches
Format · [90] Versionsvergleich · [91] Assistent · [92] Speckle.

- ◐ **[27] Punktwolken — Stufe 1: Anzeige im 3D.** (28.10.) render3d: eigene Punkt-Pipeline
  (`render3d/src/points.rs` GPU-frei: Puffer-Aufbau, Farbabbildung, WGSL; `gpu_points.rs`: Pipeline im
  selben Pass/Tiefen-/MSAA-Ziel wie das Modell). Ein Instanz-Quad je Punkt (6 Vertices aus
  `vertex_index`, Position 12 B + RGBA8 4 B je Punkt), feste Grösse in Bildschirm-Pixeln (ab 3 px rund),
  tiefengetestet gegen das Modell, vom Live-Schnitt gekappt. Puffer zu höchstens 4 Mio. Punkten (ein
  Draw je Puffer). Farbmodi rgb / Intensität (1.–99. Perzentil) / ASPRS-Klasse / Höhe (fehlt das Attribut →
  Höhe), auf der CPU berechnet; Moduswechsel schreibt nur den Farbpuffer. Eingabe `xyz` f32 relativ zum
  Ursprung + Modellversatz f64, Summe in f64 (LV95-fest). Achsen wie Gelände/Import (`MeshKind::Terrain`):
  Modell (x, y, z) → world (x, z, −y). Bindungen `web.rs` (`set_point_cloud`, `set_point_cloud_style`,
  `remove_point_cloud`, `clear_point_clouds`; Unsinn → 0 Punkte, kein Panic); derselbe `Renderer` im
  Browser (WebGPU) und nativ (`render_png --points wolke.txt [--point-size] [--point-color]`; das native Fenster `native.rs` hat
  denselben Renderer, bekommt aber noch keine Wolken geschoben).
  UI: Menü „Punktwolke importieren …" (Datei-Menü im Browser + natives App-Menü), Drag & Drop
  `.las/.laz/.e57/.ply/.xyz/.pts`, Dialog mit Voxel/Budget und Bericht (Anzahl, Ausdehnung, tiefste Ecke,
  EPSG, Attribute, Lage), Abschnitt „Punktwolken" im Gelände-Panel (Sichtbarkeit, Farbmodus, Punktgrösse,
  Entfernen). Lage (`state/pointCloudPlacement.ts`): mit `geoAnchor` und LV95 (EPSG 2056 oder ohne EPSG mit
  LV95-Koordinaten) lagerichtig, Höhe aus `geoAnchor.height` (sonst tiefster Punkt auf 0); sonst lokale
  Koordinaten wie in der Datei bzw. Landeskoordinaten mittig auf den Nullpunkt — jeweils mit Hinweis.
  Wolken leben im UI-Store `state/pointCloudStore.ts` (kein Projektfeld). Tests: 14 Rust (Puffer, Farben,
  WGSL) + 2 GPU-Render in eine Textur (Tiefe gegen Wand, Sichtbarkeit, Farbwechsel, feste Pixelgrösse;
  `cargo test --features render`, im Container Vulkan/lavapipe) + 12 vitest (Lage, Store, Abgleich).
  Nebenbei behoben: `CAP_WGSL` rief `fwidth` in nicht-uniformem Kontrollfluss → Chrome/Tint verwarf die
  Cap-Pipeline und damit JEDEN 3D-Frame (im Browser-Build gesehen); Ableitungen jetzt vor den Verzweigungen,
  Regressionstest `shaders::uniformity_tests`.
  - Geprüft: Linux-Container — cargo test (lavapipe), `render_png` mit Demo-Haus + synthetischer Wolke
    (110 000 Punkte; Tiefe, Klassen-/RGB-Farben sichtbar richtig), Browser-Build in Chromium (WebGPU über
    SwiftShader): Import-Dialog, Bericht, Panel, Moduswechsel ohne WebGPU-Validierungsfehler. NICHT
    geprüft: Bild im Browser (Chromium präsentiert hier keine WebGPU-Frames, auch nicht headful unter
    Xvfb), Tauri-App/macOS-Metal, echte LAS/E57-Dateien, 2–5 Mio. Punkte (Zeit/Speicher), Achsrichtung
    gegen ein echtes swissALTI3D-Gelände desselben Bezugs.
  - **Einpassen (28.10.):** `set_view_preset` und der Orbit-Seed (`view_fit`) beziehen sichtbare Punktwolken in
    die Bounding-Box ein (`math::merge_bounds`/`fit_target_dist`, Rust-Test); die erste sichtbare Wolke passt
    die Kamera automatisch ein. Nicht im Browser mit Bild geprüft (leerer WebGPU-Frame im Container).
  - Offen: **beim Neuladen sind die Wolken weg** (kein Autosave) → Stufe 2 mit Modellfeld
    `Project.pointClouds` + Asset im IndexedDB/neben der Datei (Vorschlag unter [B9]); Speicher doppelt
    (JS-Store + Rust-CPU-Kopie für Farbwechsel + GPU); Grundriss/Schnitt (Punkte in Scheibe), Fang an Punkten, Clip-Box; sRGB-Ziel in
    `render_png` hellt Punktfarben (wie alle Vertexfarben) auf.

## Übernahme aus BIMCraft [B]

Quelle: github.com/IPedrax/BIMCraft v0.9. Lizenz `MIT OR Apache-2.0` (`crates/rvt` nur Apache-2.0),
DOSSIER ist AGPL-3.0-or-later → Übernahme erlaubt, Pflicht [51]. **Stolpersteine:** BIMCraft rechnet in
**mm** (am WASM-Rand ×1000), Rust **Edition 2024** (let-chains; unsere Crates 2021), `bimcraft-core` als
Ganzes nicht WASM-tauglich (rayon, tempfile, SystemTime) — nur einzelne Module herauslösen.

- ✅ **[B1] IFC-Prüfung in der CI** (= [18]). (27.10.) Eigenes Prüfskript (Schema, Express-Regeln,
  Geometrie je Bauteil), Test ruft es auf, CI installiert ifcopenshell. Erster Fund behoben
  (IfcOwnerHistory ohne LastModifiedDate).
- ✅ **[B2] Straight Skeleton** (für [26]), jetzt nach `dossier-core` statt `kernel2d`. `skeleton.rs`
  (709 Z., 8 Tests inkl. Fuzz): Innenhöfe, schiefwinklige Grundrisse, Giebel auf beliebiger Kante,
  Neigung je Kante, Arbeitsbudget. · S (Kernel) + M (Einbau)
  (28.10.) Übernommen aus BIMCraft `crates/core/src/skeleton.rs` @ f3bbb33 (MIT, Kopf + `NOTICE`), mm→m,
  Rust 2021, Budget-Parameter, `SkeletonError` statt Panic/String, Eingabeprüfung: `core/src/skeleton.rs`
  (Fuzz 2000 Sterne/Treppen mit Höfen und Giebeln), Bindung `straight_skeleton`, Fassade
  `geometry/skeleton.ts`. `roof_skeleton.rs`: `hip_roof` rechnet über `weighted_roof` (Ringe mit Höfen,
  Neigung je Kante, Giebel = Neigung 90°), Rückfall auf das alte Keil-Verfahren (`hip_roof_wedge`) bei
  Budget/Degeneration. Parität (Test `paritaet_mit_keilverfahren_auf_l_t_u`, 800 Zufalls-L/T/U/Treppen ×
  Walm/Sattel x/y/Mansarde; WASM-Vergleich alt/neu über 2000 Dächer): Rechteck/Pult bitgleich (Pfad
  unverändert), Skelett-Dachflächen auf 2e-13 gleich; anders nur, wo das alte falsch war — Sattel/
  Mansard-Giebel auf U mit Giebeln in der Bucht deckte doppelt (13/800), offene Stufe am Giebel einer
  einspringenden Ecke (jetzt Giebelwand bis zur tieferen Fläche), Linien zwischen zwei Flächen derselben
  Ebene (T-Stoss) entfallen; konkave Sterne: in ~37 % stieg das alte Dach über den Randabstand (Fünfeck:
  First 6.49 statt 3.50 m). Ohne Snap auf 1e-6: gemeinsame Ecken jetzt exakt. CLI-Plan/Ansicht (L, U, U
  Sattel, Fünfeck, T Mansarde, Zelt) angesehen (Linux). Offen: Modellfelder für Höfe/Neigung je Kante [26].
- ✅ **[B3] IFC-Import als Mesh** (erste Stufe von [25]). (28.10.) Eigener Code in `src-tauri/fileio`
  (`ifc_step.rs` STEP-Leser inkl. `\X2\`/`\X4\`, `ifc_import.rs` Geometrie), Fassade `io/ifcImport.ts`:
  je IfcProduct ein Kontext-Mesh (Ebene = IFC-Klasse; > 2000 Bauteile je Klasse+Geschoss), Menü „IFC
  importieren …", Import-Dialog und Drag & Drop (`.ifc`), CLI `import-ifc`. Extrusion (Arbitrary/
  Rechteck/Kreis/I/L/U/T, Löcher, Bögen), FacetedBrep, Tri-/PolygonalFaceSet, MappedItem, mm/Fuss,
  IFC2x3/4/4.3. Rundreise und alle buildingSMART-Simple-Scene-Dateien gegen ifcopenshell gleich (Volumen je
  Bauteil). (28.10., 2. Schritt) Öffnungen (IfcRelVoidsElement, auch am Ganzen, z. B. IfcRoof →
  Platten) und IfcBooleanResult/ClippingResult (alle drei Operationen, Halbräume IfcHalfSpaceSolid/
  Boxed/PolygonalBounded als Ebenen-Schnitt) über BSP-CSG `fileio/src/csg.rs` (Verfahren csg.js, neu
  geschrieben, iterativ, Budget; scheitert er → Öffnung gezählt, Wirt ganz); IfcRevolvedAreaSolid,
  IfcSweptDiskSolid(+Polygonal), IfcFixedReferenceSweptAreaSolid, IfcSurfaceCurveSweptAreaSolid auf
  Ebene (`ifc_sweep.rs`, Gehrung an Knicken), 3D-Leitkurven inkl. räumlicher Bögen; Ausrundungen bei
  RoundedRectangle/I/L/U/T. Laden im Web-Worker (`io/ifcImport.worker.ts`, Rückfall im Thread).
  Gegencheck ifcopenshell (Öffnungen jetzt abgezogen): Rundreise (alle Wände ausgeschnitten),
  synthetische Fälle `io/testdata/ifc-geometry-cases.ifc`, alle 35 buildingSMART-Sample-Test-Files
  und 39 von 46 IFC4.3-sample-models gleich (≤ 3 %; nur lokal, nicht eingecheckt). Offen:
  IfcAdvancedBrep (NURBS), IFC4.3-Ausrichtung (IfcGradientCurve, IfcLinearPlacement,
  IfcSectionedSolidHorizontal), IfcGridPlacement, B-Spline-Kurven, StartParam/EndParam der Sweeps,
  Profil-Kantenradien/Neigungen; CSG bei sehr grossen Netzen (> 200 000 Dreiecke) übersprungen; nur
  Linux-Container/vitest, nicht in der Tauri-App geprüft (Worker nur mit Attrappe getestet).
  (28.10., 3. Schritt) `ImportedMesh.color` (`#rrggbb` aus Stil/Material) und `ifcGlobalId` gefüllt,
  Name ohne GlobalId; Rundreise Speichern/Laden getestet. Offen: Anzeige der Farbe in 3D —
  `plan/toWalls3d.ts::emitMeshes` setzt für Kontext-Meshes fest `IMPORTED_RGB`; Vorschlag: dort
  `obj.color` (über `hexToRgb`/255) nehmen, falls gesetzt (der Plan zeichnet nur Umrisse in der
  Ebenenfarbe). · M
  (28.10., 4. Schritt, Freiform) IfcAdvancedBrep(+WithVoids)/IfcFaceSurface: Seiten auf Ebene, Zylinder,
  Kegel, Kugel, Torus, (rationaler) B-Spline-Fläche mit Kanten aus IfcEdgeLoop/IfcEdgeCurve (Linie,
  Polylinie, Kreis, B-Spline …, Kanten je Brep einmal zerlegt → dicht), getrimmt über den Parameterraum
  (`fileio/src/ifc_nurbs.rs`: Projektion, Naht/Pol schliessen, eingeschränkte Delaunay-Triangulierung mit
  crate spade, Raster nach Krümmung/Verdrillung, Nachverfeinern; Verfahren wie truck-meshalgo, eigener
  Code, kein truck im fileio); IfcBSplineCurveWithKnots(+Rational) als Kurve (Profile, Leitkurven,
  IfcTrimmedCurve); IfcGridPlacement (IFC2x3/4 und 4.3-Form); StartParam/EndParam der Sweeps
  (Parameter der Leitkurve, IFC4.3 IfcLengthMeasure = Länge; ausserhalb des Bereichs → ganze Kurve).
  Lesen in `fileio/src/ifc_brep.rs`. Gegencheck ifcopenshell: buildingSMART basin-/cube-advanced-brep
  gleich (≤ 0.3 %), jetzt 77 von 81 Dateien (Sample-Test-Files 35/35, IFC4.3 42/46); grid-placement:
  Stützen liegen auf den Rasterschnitten (ifcopenshell 0.9 liefert sie gar nicht). Neue synthetische
  Fälle `io/testdata/ifc-freeform-cases.ifc` (Formelvolumen, ifcopenshell wo es sie kann; es übergeht
  StartParam/EndParam absichtlich und scheitert an der nahtlosen Halbkugel). Offen: IFC4.3-Trassierung
  (IfcAlignment/IfcGradientCurve/IfcLinearPlacement/IfcSectionedSolidHorizontal, 3 Dateien), Flächen
  aus Kurven-Extrusion/-Rotation, IfcRectangularTrimmedSurface/IfcCurveBoundedPlane, komplexe
  STEP-Instanzen (IFC2x3-NURBS); nur Linux-Container, nicht in der Tauri-App angesehen.
- ◐ **[B4] IFC-Import zu echten Bauteilen** (zweite Stufe von [25]). · L · nach [B3]. Stand 28.10.:
  Wahl im Import-Dialog (`ui/IfcImportDialog.tsx`: Kontext-Meshes = Standard | Bauteile), CLI
  `import-ifc … --elements`. Erkennung in Rust (`fileio/src/ifc_semantic.rs`, `import_ifc_elements`),
  über die Körperform statt den Darstellungstyp: Wand = Rechteck im Grundriss (kleinstes umschliessendes
  Rechteck, unten eben, oben ≥ 35 % eben, Volumen 70–100 %), Achse = Mitte, Enden auf die Achse
  anstossender Wände gezogen (L/T), Schichten aus IfcMaterialLayerSet(Usage) von Bauteil oder Typ,
  Seite der Aussenschicht aus Usage, sonst Schicht-Bändern, sonst „weg vom Geschoss-Schwerpunkt";
  Öffnungen (quaderförmig, durch die ganze Wand) → Tür/Fenster/Wanddurchbruch (sonst bleibt die Wand
  Mesh); IfcSlab als senkrechtes Prisma → Decke (Löcher + durchgehende Öffnungen als
  Deckenöffnungen, nicht Teil eines Daches); IfcColumn Rechteck/Kreis → Stütze; IfcSpace (Prisma ohne
  Loch) → Raum (LongName, SIA 416 aus `CH_Raum`); Geschosse nach Höhe wiederverwendet (±5 mm) oder
  angelegt. TS (`io/ifcElements.ts`) ordnet nur zu: Wand-/Deckentyp nach Schichten (Material + Dicke)
  wiederverwenden oder anlegen, Materialien nach Namen; Projekt über `setProject` (Ops). Rundreise
  Demo-Haus (Export → Import als Bauteile in `emptyProject`): alle 9 Wände (Achse, Richtung, Typ, Höhe,
  Geschoss), 3 Öffnungen (Lage, Grösse, Brüstung, Typ), Decke, Raum gleich, keine neuen Typen;
  Dach/Treppe bleiben Mesh. buildingSMART Sample-Test-Files (35, lokal): alle lesbar, Ergebnis gültig;
  erkannt v. a. Räume, Stützen, `wall-with-opening-and-window` (Wand + Fenster); die Simple-Scene-Wände
  sind Giebelwände (bleiben Mesh). Offen: Dächer, Treppen, Träger, schräge/gekrümmte Wände, Wände mit
  Profiländerung, Decken aus Dreiecksnetzen mit T-Stössen (zwei Teilflächen → Mesh), Tür-Anschlag/
  Öffnungsrichtung, Tür-/Fenstertyp aus IfcDoorType/IfcWindowType, Farbe der Bauteile; nur Linux-
  Container/vitest, nicht in der Tauri-App geprüft (Dialog nur per tsc).
  (28.10., Tür-Ausführung) Tür: OperationType (IfcDoor, sonst IfcDoorType/IfcDoorStyle) → Scharnierseite
  (LEFT = Scharnier auf +X der Tür-Platzierung, von der Aufschlagseite +Y gesehen, wie unser Export) und
  Aufschlagseite (+Y gegen die Wandachse), Türtyp nach Dreh/Schiebe und Blattzahl; Fenster:
  PartitioningType (IfcWindow, sonst IfcWindowType/IfcWindowStyle) → Fenstertyp mit gleicher Flügelzahl,
  sonst `wingCount` an der Öffnung. Erkennung in Rust (`ifc_semantic.rs::operation`), TS ordnet zu.
  Rundreise: alle 8 Kombinationen Scharnier/Aufschlag/Richtung landen räumlich gleich (Scharnierpunkt,
  Aufschlagrichtung; `openingDir` kommt als „in“ mit gespiegeltem `swing` zurück), 2-flügliges Fenster →
  Typ „Fenster 2-flügl.“. Offen: LEFT/RIGHT nur gegen den eigenen Export geprüft (nicht Revit/ArchiCAD);
  Türen ohne Ausführung bleiben beim Standard (kein Raten aus der Platzierung).
  (28.10., Klassifikation/Zonen) IfcClassificationReference (Bauteil, sonst Typ; System aus ReferencedSource,
  IFC4 und IFC2x3) wird gelesen (`Info.classifications`, `IfcProduct.classifications`): Kontext-Meshes
  tragen sie im Namen (` [eBKP-H C]`), für Wand/Decke/Stütze/Raum gibt es kein Modellfeld (kein neues
  angelegt) — Zählung in der Import-Meldung (`summary.classified`). IfcZone (IfcRelAssignsToGroup) →
  SIA-416-Kategorie des Raums, wenn er keine eigene `CH_Raum`-Eigenschaft hat: `CH_Zone.SIA416`, sonst der
  Zonenname (HNF, NNF, VF, FF, KGF/KF, AGF; kein Raten bei anderen Namen). Rundreise Export → Import
  geprüft. Offen: Klassifikation als Feld am Bauteil, IfcGrid (Modell ohne Raster).
- ◐ **[B5] IFC-Export nachziehen** (`exportIfc.ts`). Stand 28.10.:
  - ✅ Nicht-ASCII nach ISO 10303-21 (`\X2\`/`\X4\`).
  - ✅ Materialschichten: Wand-/Decken-/Dachtypen als IfcWallType/IfcSlabType/IfcRoofType mit
    IfcMaterialLayerSet, Exemplare über IfcRelDefinesByType (keine LayerSetUsage, Wand ist Mesh).
  - ✅ IfcSpace aus `Room` (Qto_SpaceBaseQuantities, SIA 416), IfcRoof, IfcColumn mit Material.
  - ✅ `IfcOpeningElement` + RelVoids/RelFills statt ausgeschnittener Meshes. (28.10.) Wand als
    ungeschnittene Extrusion (je Schicht-Band ein IfcExtrudedAreaSolid, SweptSolid), Öffnung als
    Quader über die Wanddicke (+2 cm), Tür/Fenster im Öffnungs-Placement. Nur wenn exakt gleich wie
    das 3D (`bandsMatchOpenings`: kein schräger Bandkopf, Löcher = Öffnungen); sonst (Wand unter
    Dach, Laibungs-Rücksprung) bleibt das Mesh, Öffnung+Füllung trotzdem als Beziehung (zieht nichts
    doppelt ab). Demo-Haus: 7 von 9 Wänden Extrusion; Volumen je Wand nach ifcopenshell = 3D-Mesh.
  - ✅ `Pset_*Common`. (28.10.) Wall/Slab/Roof/Column/Door/Window/SpaceCommon nur mit Modellwerten:
    Reference (Typname, Stützenprofil, Raumnummer), IsExternal (Dach; Raum aus SIA 416 AGF, IfcSpace
    dann EXTERNAL), GlazingAreaFraction (Glastür). Gleicher Inhalt = ein Pset für alle Bauteile.
  - ✅ Dauerhafte GUIDs (= [10]). (28.10.) 128-Bit-Hash (2× FNV-1a + fmix64, UUID v8) über
    `<Projekt-id>/<Art>/<id>[/<Zusatz>]`; Rels/Typen/Psets/Eingliederung an Element-/Geschoss-/
    Typ-ids statt STEP-Nummern. Tests: Rundreise stabil, eindeutig (Decke und Dach gleiche id),
    unabhängig von anderen Bauteilen, projektübergreifend verschieden. GUIDs ändern sich einmalig
    gegenüber Exporten vor dem 28.10.
  - ✅ Georeferenz [69].
  - ○ Offen: IsExternal/LoadBearing/ThermalTransmittance für Wand/Decke/Tür/Fenster brauchen
    Modellfelder (z. B. am Wandtyp tragend/aussen, λ je Bauteil → U-Wert). · S–M
  - ✅ IfcMaterialLayerSetUsage + Achs-Darstellung an Extrusions-Wänden. (28.10.) Wand-Placement am
    Wandanfang, X = Achse, Y = linke Normale (Rust rechnet die Welt-Profile und die Öffnungen ins
    Wandsystem); „Axis“-Darstellung (IfcPolyline, Unterkontext GRAPH_VIEW) + Usage (AXIS2, POSITIVE,
    Offset = Abstand der Aussenschicht von der Achse), nur wenn die Typ-Schichten den Bandquerschnitt
    füllen. Mesh-Wände (schräge Oberkante, Laibung) bleiben ohne Achse/Usage. ifcopenshell liest
    Achse = Wandachse (auch schräg/rückwärts gezeichnet) und die Bänder in Schichtreihenfolge ab Offset.
    Offen: nicht in Revit/ArchiCAD geöffnet.
  - ✅ Tür/Fenster mit echter Geometrie statt Box. (28.10.) `export/ifcOpenings.ts`: Fenster = Blendrahmen
    (4 Teile) + Mittelpfosten + eine Glasscheibe je Flügel (Flügeltabelle/`wingCount`), Tür = Zarge (3 Teile)
    + Blatt/Blätter (Glastür: Rahmen um eine Glasfläche = `glazingRatio`, Oberlicht mit Kämpfer); getrennte
    Körper in einer Darstellung, je mit IfcStyledItem (Rahmen/Blatt/Glas mit Transparenz). Masse aus dem
    Modell (Rahmenbreite/-tiefe, Schichteinzug, Verglasung), sonst die Konstanten des 3D (6 cm, 7 cm, Blatt
    4 cm; Glaspaket 6/24/36 mm). Eigenes Füllungs-Placement (Tür: Y = Aufschlagrichtung). OperationType
    (Blattzahl, Scharnierseite, Schiebe) und PartitioningType (1–3 Flügel). Reine Wandöffnung: kein Körper.
    Geprüft: ifcopenshell (0 Befunde; Volumen Rahmen + Glas, Welt-Lage, Stile je Körper), Modell-Rechnung
    in `ifcOpenings.test.ts`. Offen: LEFT/RIGHT der Tür nach IFC-Konvention (Blick von der Aufschlagseite)
    gelesen, nicht in Revit/ArchiCAD gegengeprüft; ohne Sprossen, Fensterbank, Rollladenkasten, Schwelle,
    Flügelrahmen.
  - ✅ Tür/Fenster-Geometrie nach Rust (Regel „Kern in Rust“, 28.10.): `fileio/src/ifc_openings.rs` rechnet
    Rahmen/Zarge, Blatt, Glas, Füllungs-Placement und OperationType/PartitioningType; `export/ifcOpenings.ts`
    sammelt nur die Parameter (Typ-/Öffnungswerte, fehlende als „keine“), flache Kodierung FILL (Version 2).
    TS-Rechnung gelöscht, ihre Fälle als Rust-Tests. Golden-Vergleich: 419 verschiedene IFC-Ausgaben (Tests in
    `export/*ifc*`, `io/ifcImport`, `io/ifcElements` und 780 Tür-/Fenster-Varianten: Glas-/Schiebe-/Wandöffnung,
    Oberlicht, Flügeltabellen, Einzug innen, Klemmungen) vorher/nachher zeichengleich bis auf Zeitstempel.
  - ○ Offen: Bogenwände als echte Kurve. · M
  - ✅ Eigener IFC-Import ([B3]) zieht Öffnungen ab (28.10.): Rundreise vergleicht alle Wände mit dem
    ausgeschnittenen Volumen (`ifcImport.test.ts`).
  - ✅ Export nach Rust. (28.10.) `src-tauri/fileio/src/ifc_export.rs` schreibt die STEP-Datei
    (Entitäten, GUID-Hash, Typen/Materialschichten, Psets, Beziehungen, Räume, Georeferenz,
    `\X2\`/`\X4\`); `exportIfc.ts` sammelt nur noch (Bänder, Öffnungen, Dach-Meshes, Raumflächen)
    und gibt einen flachen Puffer + Zeichenketten an `export_ifc_flat` (Muster `export.rs`/DXF). Die
    TS-STEP-Erzeugung ist gelöscht; `ifcGuid`/`ifcString` sind dünne Fassaden. `exportIfcSpf` bleibt
    synchron, verlangt aber das geladene Format-Modul (wie `buildPlanDxf`): Dialog und CLI `ifc`
    laden per `loadFileio()`, Tests per `fileioWasm.setup`. Golden-Vergleich gegen die TS-Fassung
    (45 Exporte aus `exportIfc.test`, `exportIfc.validate.test`, `ifcImport.test`, inkl. Demo-Haus,
    Georeferenz, Dach, Stützen, Räume, Umlaute): Entitäten, Reihenfolge, Nummern, GUIDs und Zahlen
    zeichengleich (bis auf Zeitstempel). Abweichungen nur in Grenzfällen: unpaarige UTF-16-Surrogate
    in Namen werden U+FFFD (TS: `\X2\D800\X0\`), `\0` in Namen entfällt, NaN/∞ in einer Koordinate
    ist jetzt ein Fehler statt „NaN“ in der Datei. Rundung wie `toFixed(6)` (Gleichstand auf).
    Offen: Laden von pkgFileIo ist beim ersten IFC-Export neu (bisher synchron ohne Wartezeit);
    Export im Worker; nur Linux-Container/vitest, nicht in der Tauri-App geprüft. · L
  - ✅ IFC für die Schweizer Praxis (28.10.): (1) Klassifikation als Option im Export-Dialog
    (`ExportSaveDialog`, CLI `ifc --ebkph --ebenen`): IfcClassification + IfcClassificationReference +
    IfcRelAssociatesClassification (Rust-Datensatz CLASSIFICATION, eine Beziehung je Code). Das Modell führt
    KEINEN eBKP-H-/BKP-Code; `categoryCode` ist die Grafik-Ebene. Daher zwei Wege: „eBKP-H-Klassifikation
    hinzufügen“ = Standardzuordnung auf Hauptgruppen (`export/ifcClassification.ts`; Quelle CRB, eBKP-H,
    SN 506 511:2020; nur die Buchstaben C Konstruktion Gebäude, E Äussere Wandbekleidung Gebäude, F Bedachung
    Gebäude): Wand/Decke/Stütze/Treppe = C, Dach = F, Fenster = E, Tür und Raum ohne (Aussen/Innen nicht
    unterscheidbar, nicht geraten); keine Untergruppen. „Ebene des Modells als Klassifikation“ = System
    „Dossier-Ebenen“ (Code = `categoryCode`, Name = Ebenenname). (2) Zonen: je vorkommender SIA-416-Kategorie
    eine IfcZone + IfcRelAssignsToGroup der IfcSpaces (immer, wenn Räume da sind), `CH_Zone.SIA416`,
    `CH_Qto_SIA416.NetFloorArea`; je Geschoss `Qto_BuildingStoreyBaseQuantities` (GF/NGF) + `CH_Qto_SIA416`
    (HNF … GF). (3) Achsraster: nicht exportiert, das Modell hat keine Raster-Ressource (nur die Regel „grid“
    der parametrischen Wände). Geprüft: ifcopenshell (`util.classification.get_references`, Zonen-Mitglieder,
    Storey-Qtos; validate-ifc 0 Befunde), Rust- und vitest-Tests, GUIDs bleiben stabil. Offen: die eBKP-H-
    Zuordnung ist ein Vorschlag (Tür, Untergruppen, Aussen-/Innenwand brauchen Modellfelder; Fenster → E und
    Dach → F sind Entscheide auf Gruppenebene, vom Maintainer/Kostenplaner zu bestätigen); nicht in
    Revit/ArchiCAD/Solibri geöffnet; nur Linux-Container/vitest, nicht in der Tauri-App geprüft. · S
  - ✅ Basismengen für Kostenplanung/Mengenermittlung. (28.10.) `Qto_WallBaseQuantities` (Length, Width, Height,
    GrossSideArea, NetSideArea, GrossVolume, NetVolume), `Qto_SlabBaseQuantities` (Decke und Podest: Width, Perimeter,
    Gross-/NetArea, Gross-/NetVolume), `Qto_RoofBaseQuantities` (GrossArea, NetArea, ProjectedArea),
    `Qto_ColumnBaseQuantities`, `Qto_DoorBaseQuantities`/`Qto_WindowBaseQuantities` (Width, Height, Perimeter, Area),
    `Qto_StairFlightBaseQuantities`, `Qto_RailingBaseQuantities`; als IfcElementQuantity je Bauteil (nie geteilt), GUID
    dauerhaft. Werte aus der Geometrie der Datei (`export/ifcQuantities.ts`, reine Rechnung), Netto = abzüglich
    Öffnungen (Wand: je Schicht-Band, Netz-Wände: Volumen des Netzes). Height nur bei konstanter Oberkante (IFC-Vorgabe).
    Mit ifcopenshell nachgerechnet (`exportIfc.quantities.test.ts`, ± 1 %): Wand-Netto und -Brutto (Demo-Haus: exakt),
    Decke/Podest/Stütze/Läufe = Volumen, Dach = nach oben zeigende Netz-Dreiecke (geneigt und projiziert),
    Tür/Fenster = Öffnungskörper; `validate-ifc.py` 0 Befunde. Rechnung bewusst in TS (Modell bleibt bis [K4] TS), die
    Entitäten schreibt Rust (Pset-Arten 3–5, `FLAT_VERSION` 3).
  - ✅ Deckenaussparungen als echte Löcher (IfcArbitraryProfileDefWithVoids statt Volldecke), wie im 3D. (28.10.)
  - ✅ Treppen mit Läufen. (28.10.) IfcStair ohne Darstellung, per IfcRelAggregates mit IfcStairFlight (Prismen der
    Tritte oder glatte Ortbeton-Laufplatte als Netz; NumberOfRisers/Treads, RiserHeight, TreadLength), IfcSlab(LANDING)
    (Podest bei „L“) und IfcRailing(HANDRAIL) (Handlauf + Pfosten, wo das 3D sie zeigt: gerade Läufe). Quelle: dieselben
    `emitStairs`/`emitStairMeshes`/`emitStairRailings` wie das 3D, je Treppe mit Ein-Treppen-Projekt (`export/ifcStairs.ts`).
    Der eigene IFC-Import sieht jetzt `IfcStairFlight` statt `IfcStair` als Bauteil (Tests angepasst). Offen: Lauflänge
    ist eine Näherung (Weg zwischen den Tritt-Schwerpunkten + Auftritt, mit Steigung), Wendeltreppe ein Lauf inkl.
    Mitte, Geländer von L-/Wendeltreppen fehlt wie im 3D, Geländer-Länge = Lauflänge × Seiten; Pfosten nicht
    als IfcMember; nicht in Revit/ArchiCAD geöffnet.
  - ✅ Schema-Option IFC4 (Standard) | IFC2x3 (Coordination View 2.0). (28.10.) Viele Fachplaner-Programme (ältere
    Revit/ArchiCAD, Statik, Energie, Kalkulation) verlangen noch 2x3. Export-Dialog: Auswahl „IFC-Schema“ (nur bei
    IFC), CLI `ifc --schema 4|2x3` (auch bei `convert`), `IfcExportOptions.schema`. Rust `ifc_export.rs`
    (`Schema`, META mit Schema + WGS84-Breite/Länge, `FLAT_VERSION` 4): `FILE_SCHEMA(('IFC2X3'))`,
    `FILE_DESCRIPTION('ViewDefinition [CoordinationView_V2.0]')`; Netze als IfcFacetedBrep (dichtes, aussen
    orientiertes Netz; IfcClosedShell) bzw. IfcShellBasedSurfaceModel (IfcOpenShell) aus IfcFace/IfcPolyLoop statt
    IfcTriangulatedFaceSet; IfcWallStandardCase nur für Extrusions-Wände mit IfcMaterialLayerSetUsage (2x3 WR1), sonst
    IfcWall; IfcDoorStyle/IfcWindowStyle (Ausführung als Attribut, ein Style je Ausführung, Zuordnung über
    IfcRelDefinesByType) statt OperationType/PartitioningType am Bauteil; kein IfcRoofType in 2x3 → Dachschichten
    (IfcMaterialLayerSet) direkt am Dach; IfcStyledItem über IfcPresentationStyleAssignment; Georeferenz über
    IfcSite.RefLatitude/RefLongitude/RefElevation (WGS84 aus dem LV95-Bezug, swisstopo-Näherung) und
    ePSet_ProjectedCRS/ePSet_MapConversion am IfcProject (statt IfcProjectedCRS/IfcMapConversion). Attributlisten nach
    IFC2X3_TC1: ohne PredefinedType bei Wand/Stütze/Öffnung, ShapeType bei Dach/Treppe, NumberOfRiser ohne
    PredefinedType am Lauf, IfcZone ohne LongName (Langname als Beschreibung), IfcMaterial/-Layer/-LayerSet/-Usage,
    IfcQuantity* ohne Formula, IfcClassification/-Reference ohne Description/Location/Tokens (Source/Edition Pflicht),
    IfcPerson mit FamilyName. Quantities, Psets, Zonen, Klassifikation und alle GlobalIds wie IFC4. Geprüft: Rust-Tests
    (`ifc_export.rs`, auch kaputte Puffer), `exportIfc.ifc2x3.test.ts`: ifcopenshell validiert gegen IFC2X3 (0 Befunde,
    Demo-Haus mit/ohne Klassifikation und Georeferenz, Dach mit Typ, Stützen, Wand mit/ohne Mesh, Umlaute), Volumen
    und Welt-Bounding-Box je Bauteil gleich der IFC4-Ausgabe (≤ 1e-6), eigener Import liest die 2x3-Datei als Meshes
    und als Bauteile mit gleichem Ergebnis wie IFC4. Offen: nicht in Revit/ArchiCAD/Solibri geöffnet (die
    buildingSMART-Konvention für ePSet_* am IfcProject nach bestem Wissen, ohne Gegenprüfung in einer Anwendung); Türen/
    Fenster ohne IfcDoorLiningProperties/-PanelProperties; kein IfcFaceBasedSurfaceModel-Pfad für CV-2.0-Zertifizierung;
    Netz-Wände/Dächer als Brep sind grösser als IfcTriangulatedFaceSet (ein Punkt je Ecke, drei Entitäten je Dreieck). · M
  - Geprüft nur im Linux-Container (vitest + ifcopenshell 0.9: 0 Befunde, Volumen), nicht in
    Solibri/BIMcollab und nicht in der Tauri-App.
- ◐ **[BCF] BCF 2.1/3.0 (BIM Collaboration Format).** (28.10.) Koordinations-Themen mit Solibri, BIMcollab,
  Revit, ArchiCAD austauschen. Rust `src-tauri/fileio/src/bcf.rs` (+ `bcf_read`/`bcf_write` im pkgFileIo,
  JSON an der Grenze, Snapshots Base64): .bcfzip lesen/schreiben (Themen mit Typ/Status/Priorität/Zuständig/
  Fällig/Labels, Kommentare, Viewpoints mit Perspektiv-/Orthokamera, Auswahl, Sichtbarkeits-Ausnahmen,
  Schnittebenen, Snapshot; 2.1 und 3.0). Crates `zip` (MIT, nur Deflate) und `quick-xml` (MIT), in NOTICE.
  TS `io/bcf.ts` (Fassade, reine Hilfen), `io/bcfMatch.ts` (GlobalId ↔ Dossier-id mit derselben Ableitung wie
  der IFC-Export: `ifcGuid("<Projekt-id>/<Art>/<id>")`; importierte Meshes über `ifcGlobalId`), Dock-Panel
  „BCF-Themen" (`panels/BcfPanel.tsx`, nicht im Standard-Layout, Menü Fenster > BCF-Themen bzw. macOS Fenster > Panels): Datei öffnen,
  Themenliste, Klick wählt die Bauteile, Kommentar, Status, Thema aus Auswahl, Speichern. Themen liegen in
  der eigenen Datei, kein Feld in `src/model`. CLI `dossier-cli bcf-info <datei.bcfzip>`.
  Geprüft: Rust-Rundreise 2.1/3.0, Unsinn → Fehler (inkl. Zufallsbytes, Zip-Bomben-Grenze, XML-Tiefe),
  alle 71 buildingSMART-Beispieldateien (Test Cases v2.1/v3.0, lokal; CC BY-ND, deshalb nicht im Repo,
  Test `buildingsmart_beispiele` über `BCF_TESTCASES`), vitest Fassade und GlobalId-Zuordnung gegen den
  IFC-Export des Demo-Hauses. Nicht geprüft: Austausch mit echter Solibri/BIMcollab-Software, Tauri-App.
  **Kamera (28.10.):** `viewport/cameraBridge.ts` (`getCamera`/`setCamera({animate})`/`captureSnapshot`/`setSection`/
  `fitView`; der Viewport meldet sich an, ohne Viewport null/false) in MODELL-Koordinaten (z oben); Achsen
  Modell (x, y, Höhe) → world (x, Höhe, y) (Tausch, belegt gegen `projectToModel3d`; Gelände/Punktwolken
  negieren y, s. [27]). `panels/bcfView.ts`: BCF-Weltkoordinaten = Modell + LV95-Versatz `projectGeoOrigin`
  (genau wie `exportIfcSpf`/`projectToWorldCoords`, Höhe unverändert). Klick auf Thema/Viewpoint-Vorschau
  setzt Kamera (perspektivisch + orthogonal, Fahrt 350 ms) und eine senkrechte Schnittebene (live,
  Knopf zum Aufheben), Auswahl wie zuvor; „Thema aus Auswahl", „Ansicht aufnehmen" und Kommentar
  (Häkchen „Aktuelle 3D-Ansicht anhängen") legen einen Viewpoint mit Kamera + PNG-Schnappschuss an.
  Annahmen: FieldOfView vertikal, ViewToWorldScale = sichtbare Breite, ClippingPlane.Direction zeigt auf
  die weggeschnittene Seite (wie `set_section_plane`). render3d additiv: `camera_state`, `view_fit`
  (`math::fit_target_dist`/`merge_bounds`). Geprüft: vitest Achsabbildung + Rundreisen (inkl. echter
  .bcfzip 2.1/3.0), Chromium-Build (`scripts/probe-bcf-camera.mjs`): Kamera setzen/lesen/aufnehmen
  per Debug-Handle `window.__dossierCamera`. NICHT geprüft: Schnappschuss mit echtem Bild (im Container
  ist der WebGPU-Frame leer → `captureSnapshot` liefert null, Viewpoint trägt dann nur die Kamera),
  nativer macOS-Pfad (Metal-Fenster `native.rs` hat eigene Orbit-Kamera, NICHT angebunden: dort nur Anzeige
  und Auswahl), Austausch mit echter Solibri/BIMcollab-Software (Achsen-/FOV-Annahmen oben).
  Offen: Kamera im nativen Metal-Fenster; Schnittebene beim Anlegen eines Themas aus dem Live-Schnitt
  übernehmen; Roll der Kamera (Orbit kennt keinen); schräge Schnittebenen nur angezeigt;
  `extensions.xml` (3.0), Farbgruppen/Linien, BimSnippet, Dokument-Referenzen und verwandte Themen gehen
  beim Speichern verloren; Panel in den Standard-Dock aufnehmen. · M
- ○ **[B6] Wand unter Dach als Prismen zwischen Ebenen** (für [G2]). `walls.rs:413–472, 592–654`. · M
- ○ **[B7] Dach-Verschneidung und Gauben in 2.5D** (für [G5]). · M · nach [B2]/[B6].
- ○ **[B8] Bogenwände, schneller Weg** (für [T2]). · S/M–L
- ✅ **[B9] Punktwolken-Leser** (für [27]). (28.10.) `src-tauri/fileio/src/pointcloud*.rs` + `web_pointcloud.rs`,
  TS-Fassade `src/io/pointCloud.ts` (+ `pointCloud.worker.ts`, Web-Worker wie DWG), CLI `pointcloud-info`.
  Formate: LAS 1.0–1.4 (Punktformate 0–10, eigener Leser), LAZ (Crate `laz` 0.13, Apache-2.0), E57 (Crate
  `e57` 0.11, MIT, mehrere Scans + Pose, Kugel→kartesisch), PLY (ASCII/binär LE+BE), XYZ/PTS (Text);
  Format wird am Inhalt erkannt. Ausgabe: `xyz` f32 RELATIV zu `origin` (f64, ganze Meter; in LV95 sonst
  nur ~0,25 m f32-Auflösung), `rgb` (u8; 8-Bit-Werte in 16-Bit-Feldern werden erkannt), `intensity` (u16),
  `classification` (ASPRS). Ausdünnen STREAMEND in Rust (`Sink`): Voxel-Kante und/oder Punktbudget (bei
  Überschreiten wächst die Kante, die behaltenen Punkte werden neu gerastert) — Speicher nie über Budget;
  Bounding-Box, Klassenhistogramm, Intensitätsbereich, EPSG (GeoKeys/WKT) und Zähler im Bericht beziehen
  sich auf ALLE gelesenen Punkte. Kaputte/abgeschnittene Dateien → Fehler bzw. `truncated`, kein Panic
  (Fuzz-artige Tests: jede Kürzung, jedes Kopfbyte). Tests: 25 Rust (synthetische Dateien im Test erzeugt,
  LAZ per `laz`-Kompressor, E57 per `e57`-Writer) + 5 vitest.
  - Zeiten (Linux-Container, **synthetische** 16-Mio.-Punkte-LAS, 448 MB, Gelände 0,25 m Raster): CLI
    (Node+WASM) 2,3 s mit Budget 2 Mio., 1,3 s mit Voxel 1 m, 2,5 s unausgedünnt; nativ Rust 0,4–2 s.
    Erster Wurf mit `HashSet` brauchte 22 s (SIMD-lose Hash-Tabelle im WASM) → eigene `CellSet`
    (offene Adressierung, ein Multiplikations-Hash). Echte swissSURFACE3D-Kachel NICHT geladen
    (`data.geo.admin.ch` vom Proxy gesperrt, 403); LAZ-Durchsatz an grossen Dateien nicht gemessen.
  - Grenzen: die ganze Datei liegt im Speicher (WASM 4 GB, Eingabe wird einmal kopiert) — Dateien über
    ~1,5 GB brauchen später blockweises Lesen (`File.slice` → Rust-Stromleser). LAZ 1.4 mit
    Punktformat 6–10 (Layered) läuft über `laz`, nur synthetisch geprüft. E57-Bilder/Panoramen werden
    ignoriert; E57-Kompression (Bitpack) nur soweit das Crate sie liest.
  - **Vorschlag Anzeige/Modell für [27]** (nicht umgesetzt, Modell/Plan/render3d gesperrt): render3d kann
    heute KEINE Punkte (`gpu.rs`: nur `TriangleList`/`LineList`-Pipelines, keine Punkt-Topologie) →
    neue Pipeline `PointList` mit Instanz-Quads (feste Pixelgrösse, Tiefe, optional Farbe/Intensität/
    Klassen-Palette), Eingabe `xyz`-f32-Puffer + `origin` als Modell-Versatz. Modell: `Project.pointClouds?:
    PointCloudRef[]` mit `{ id, name, origin: [x,y,z], bbox, count, source: { fileName, format, epsg },
    dataRef (Asset-/Datei-Schlüssel, NICHT die Punkte im .obp), visible, colorMode: "rgb"|"intensity"|
    "class"|"height", pointSize, clip?: Polygon+Höhe }`; Punkte als Asset neben dem Projekt (IndexedDB/
    Datei, Format = die flachen Puffer), neues Feld in `KNOWN_KEYS`; Änderungen über Ops. Georef:
    `origin` gegen `projectGeoOrigin` verrechnen. Folge-Schritte: Import-Dialog (Voxel/Budget wählen,
    Bericht zeigen), Schnitt-/Grundriss-Ansicht (Punkte in Scheibe als Punktwolke im Plan, [27]), Fang an
    Punkten. UI-Texte dann über `t()`.
- ◐ **[B10] Kleine Ideen ohne Code.** · je S
  - ○ `pat.rs`: `;%UNITS=` und `;%TYPE=MODEL|DRAFTING` — lohnt erst mit vollwertigen PAT-Mustern (alle
    Linienfamilien in allen Renderpfaden, M), heute nur Näherung diagonal/kreuz.
  - ✅ `autosave.rs`: Race geprüft (keine auf IndexedDB-Ebene), Logikfehler behoben (s. [13]).
  - ○ `pen.rs` → [32] (✅ Grundriss); `styles.rs`/`graphics.rs` → [33]/[34]; `phasing.rs` → [28];
    `link.rs` → [43]; `docs/areas/*.md`, `docs/performance.md` → [21]/[20].

## Lernen von CADCraft [C] (neu 28.10.)

Quelle: github.com/storytold/cadcraft (README gelesen 28.10.; AutoCAD-Nachbau in Rust, MIT OR Apache-2.0,
„early development", ~7000 Sterne). Gleiche Familie wie das BIMCraft auf getcadcraft.com (Seite hier nicht
erreichbar, kein öffentliches Repo gefunden) — nicht zu verwechseln mit IPedrax/BIMCraft ([B]). Vor jeder
Code-Übernahme Lizenz der Abhängigkeiten prüfen, Pflicht [51].

- ✅ **[C1] DWG über `acadrust`** (28.10.: Gerüst `src-tauri/fileio` mit acadrust 0.6.8, WASM `pkgFileIo`,
  nachgeladen über `src/engine/fileioWasm.ts`; Herkunft geprüft → `NOTICE`) (Rust, Open Source): Lesen R13–2018, **Schreiben R2000**. Heute liest
  Dossier DWG über `dwgimport`/libredwg-web und kann kein DWG schreiben. Lizenz von acadrust prüfen. · M
  28.10. **DWG-Export** steht: `src-tauri/fileio/src/export.rs` baut aus einer flachen Zeichnung ein acadrust-
  `CadDocument` und schreibt **DWG R2018** (R2000 möglich, verliert aber True-Color; Begründung im Dateikopf);
  Dialog „DXF/DWG exportieren“ mit Formatwahl, CLI `dwg`. Rundreise acadrust (`cargo test`) und Gegenlesen mit
  libredwg (`exportDxf.roundtrip.test.ts`): Ebenen, Entitäten, LV95 bitgleich, Umlaute. Offen: Prüfung in AutoCAD/BricsCAD selbst, Tauri-App nicht getestet.
  - ✅ **DWG-Import** (28.10.): `fileio/src/import.rs` liest DWG R13–2018 über acadrust, gleiche Abbildung
    wie DXF ([C2]); `io/dwgParser.ts` ist dünne Fassade (Web-Worker), libredwg-web samt Vite-Aliasen und
    `libredwg-web.d.ts` entfernt. 7–8× schneller (200 000 Linien: 6–8 s → 0,8 s); neu auch Texte,
    Schraffuren, Ebenenfarben, geschlossene LWPOLYLINE, MINSERT, Bulges. Offen: echte swissBUILDINGS3D-
    v3-Kachel nur synthetisch nachgebaut geprüft (`io/testdata/tile*`), nicht in Tauri/macOS getestet.
- ✅ **[C2] DXF als eigenes Rust-Crate** (Lesen und Schreiben über acadrust, 28.10.)
  28.10. **DXF-Export in Rust:** statt eigenem Writer über acadrust (`fileio/src/export.rs`), **R2018 ASCII
  (UTF-8)** statt des alten AC1015-Kopfs mit UTF-8-Inhalt. `buildPlanDxf` (gleiche Signatur) sammelt nur noch
  aus dem `Plan`; `export/dxfWriter.ts` gelöscht, `savePlanDxf` async (lädt pkgFileIo nach). Gleichwertigkeit:
  einmaliger Vergleich alt↔neu am Demo-Haus (EG/OG, lokal/LV95, mit/ohne Schraffur) — gleiche Entitäten,
  Reihenfolge, Ebenen, Strichstärken, True-Color, Koordinaten ≤ 5e-7 m (Rundung des alten Writers auf 6 Stellen;
  neu volle f64). Neu: 2D-Texte als TEXT (fehlten bisher), CLI exportiert georeferenziert wie die App.
  Gegencheck ezdxf (`scripts/validate-dxf.py`, Test übersprungen ohne `pip install ezdxf`): 0 Auditor-Fehler.
  - ✅ **Binär-DXF-Export** (28.10.): `export_dxf_binary` (acadrust `DxfWriter::new_binary`, R2018 UTF-8),
    Dialog-Format „DXF binär“, CLI `dxf --binary`. Rundreise acadrust + ezdxf (gleiche Entitäten/Ebenen wie
    ASCII, 0 Auditor-Fehler, kleiner als der Text). Offen: in AutoCAD/BricsCAD selbst nicht geöffnet.
  - ✅ **Verlauf als echte Gradient-HATCH** (28.10.): `kind === "gradient"` → neuer Datensatz `REC_GRADIENT`
    (`export.rs`): Name LINEAR/SPHERICAL, Farbstützen 0/1, Winkel = SVG-Richtung der Ansicht. ezdxf liest
    Name, Rotation und beide Farben. Offen: Aussehen/Richtung in AutoCAD selbst ungeprüft (Winkel 0 =
    Farbe 1 links angenommen); mehr als zwei Farbstützen kennt das Modell nicht.
  - ✅ **Export: echte HATCH-Entitäten** (28.10.): Schraffuren (`pattern` diagonal/Kreuz/Dämmung/frei, auch
    gestrichelt) und Vollfüllungen gehen als HATCH ins DXF/DWG statt als einzelne geklippte Linien: Rand =
    geschlossene Polylinienkante des Plan-Polygons, Musterzeilen aus Winkel und Linienabstand (Versatz schon
    gedreht, Strich-/Lückenfolge als `dash_lengths`), Vordergrundfarbe als True-Color, Ebene `HATCH`, vor dem
    Umriss gezeichnet (neuer flacher Datensatz `REC_HATCH`, `export.rs`). Zufallsstriche (`random`) haben
    kein Musteräquivalent und bleiben Linien; Bild-Schraffur wie bisher nur Umriss (Verlauf: s. u.). Geprüft:
    acadrust-Rundreise DXF und DWG, ezdxf (Auditor 0 Fehler, Rand/Farbe/Musterzeilen), libredwg zählt gleiche
    Typen. Offen: Aussehen in AutoCAD/BricsCAD selbst nicht geprüft (Musterphase ab Ursprung bei
    LV95-Koordinaten); Verlauf siehe unten (jetzt Gradient-HATCH).
  - ✅ **DXF-Import in Rust** (28.10.): statt eigenem Tag-Reader acadrust (ASCII und Binär, R12–2018+,
    Code-Seiten) in `fileio/src/import.rs` → flacher f64-Puffer + String-Tabelle, dekodiert in
    `io/dxfParser.ts` (Rückgabetyp unverändert, neu `insUnits`). dxf-parser entfernt; Aufteilung grosser
    Dateien für parallele Worker von `io/dxfEntityChunker.ts` nach `fileio/src/split.rs` (Bytes statt
    Text, ab 4 MB). Abweichungen zum alten Parser (alle gewollt): Bulges tesselliert, Kreise/Bögen/
    Schraffuren in Blöcken behalten Kurve/Füllung, Ebene „0" in Blöcken erbt die INSERT-Ebene (sonst
    eigene), Meshes je Ebene und auch aus Blöcken, MESH/Polygon-Mesh trianguliert, nur Modellraum (kein
    Papierbereich), periodische Splines. Offen: DXF am Stück
    ≈ 1,2–1,6× langsamer als dxf-parser (acadrust-Tokenizer; dank Aufteilung ab 4 MB insgesamt schneller).
  - ✅ **Import verfeinert** (28.10.): `$INSUNITS` wird angewendet (mm, cm, m, Zoll, Fuss, … → Meter für
    Koordinaten, Radien, Texthöhen, Meshes; 0/unbekannt/fehlend = 1:1 wie bisher; `insUnits` bleibt roh,
    neu `unitScale`; Puffer-Version 2). Neu abgebildet: SOLID/TRACE als gefüllte Flächen (Eckenfolge 1-2-4-3,
    Dreieck bei 3 = 4), DIMENSION über den Anonymblock `*D…` (Linien + Text; ohne Block nur der Messwert),
    LEADER und MULTILEADER als Linienzug (zur Anschlussstelle geordnet, mit Landestrecke) plus MULTILEADER-Text,
    ATTRIB an INSERTs und ATTDEF in Blöcken als Text (ATTDEF nur ohne passendes ATTRIB, unsichtbare entfallen).
    Geprüft: Rust-Tests über Modell, ASCII-DXF und DWG-Rundreise; vitest `dxfParser.test.ts`; Swisstopo-
    Kacheln (INSUNITS 6) unverändert. Offen (→ unten erledigt): Pfeilspitzen/Spline-Führungslinien, Bemassung ohne Anonymblock
    (nur Text), Block-/Tabellen-Inhalt von MULTILEADER, ATTRIB-Textausrichtung nur über den zweiten
    Ausrichtungspunkt; keine echte Bemassungs-/Mehrdateien-Probe aus AutoCAD (nur synthetisch erzeugt); ein
    Import-Dialog-Hinweis „Datei in mm, umgerechnet“ fehlt (`unitScale` steht bereit).
  - ✅ **Import vervollständigt: Beschriftung, Pfeile, Layouts, Robustheit** (28.10.): neue Module
    `fileio/src/text.rs` (MTEXT-Codes, Ausrichtung) und `annotation.rs` (Pfeile, Bemassung).
    **Texte:** MTEXT-Formatcodes sauber (`\P`/`\N` = neue Zeile, `\~`, `{\f…;}`, `\H`, `\S`-Stapel, `\U+XXXX`,
    `\L\O\K`, `%%c/d/p/nnn`); mehrzeiliger MTEXT = je Zeile ein Text (Zeilenabstand 5/3·Höhe), Anhängepunkt
    (9 Lagen) und Drehung; TEXT 72/73 mit Ausrichtpunkt (links/mitte/rechts × Grundlinie/unten/mitte/oben,
    „Mitte", „ausgerichtet" mit Höhe nach Länge, „eingepasst"), Breitenfaktor; ATTRIB/ATTDEF mit derselben
    Ausrichtung (auch mehrzeilig). Weil `ImportedText` keine Ausrichtung kennt, wird auf den Grundlinien-Anfang
    umgerechnet — mit **geschätzter Textbreite** (mittlere Proportionalschrift, ±10 %).
    **Pfeile:** LEADER (Stil `DIMLDRBLK`/`DIMBLK`, Grösse `DIMASZ·DIMSCALE`), MULTILEADER (Pfeil je Linie, Grösse
    aus Kontext/Linie) und Bemassungen ohne Anonymblock: Pfeilart aus dem Blocknamen (gefülltes/offenes
    Dreieck, offen 30°/90°, Punkt, Kreis, Quadrat, Schrägstrich/Architektur-Tick), `DIMTSZ` → Strich.
    Spline-Führungslinien (LEADER-Spline, MULTILEADER-Spline) tesselliert (Catmull-Rom durch die Stützpunkte);
    MULTILEADER-Block-Inhalt mit Skalierung, Drehung, „Block-Umfang"-Anschluss und Attributtexten.
    **Bemassung ohne Anonymblock** aus Definitionspunkten + Stil: linear, ausgerichtet, Radius, Durchmesser,
    Winkel (3 Punkte und 2 Linien): Hilfslinien (`DIMEXO/DIMEXE`), Masslinie (um mittigen Text unterbrochen),
    Pfeile (aussen, wenn es eng wird), Text nach `DIMDEC/DIMZIN/DIMDSEP/DIMPOST/DIMLFAC/DIMRND/DIMTAD`.
    **Layouts:** der Bericht (`layouts`, im Dialog „Papierbereich") listet Layouts mit Inhalt; ein Layout lässt
    sich statt des Modellraums lesen (`import_layout`, WASM `import_drawing_layout`, `parseDxf(…, layout)`,
    Auswahl im Import-Dialog; Papier in mm/Zoll → Meter). **Robustheit:** Vorprüfung (leer, > 1,5 GB, kein
    DXF/DWG) mit deutscher Meldung; Fehlermeldungen erscheinen im Dialog statt „keine Geometrie";
    abgeschnittene/beschädigte Dateien werden tolerant gelesen und als „teilweise gelesen" gemeldet
    (`recovered`); Fuzz-Test in `cargo test` (`import_robust_tests.rs`: 1200 gekürzte/verfälschte ASCII-/Binär-DXF
    und DWG je Lauf, `FUZZ_ITERS=4000` einmalig mit 32 000 Dateien: 0 Panics). Puffer-Version 3.
    Prüfung: 126 Rust-Tests, vitest `io/`, Probedateien mit ezdxf (`fileio/testdata/make_fixtures.py`: Bemassungen
    mit/ohne Block, Pfeilarten, Leader/MLeader, Texte, Layouts). **Offen:** keine echte AutoCAD-Datei (nur ezdxf/
    acadrust-Synthese — Pfeilgrössen von MULTILEADER, `_OPEN`-Winkel und Textbreiten ungeprüft); Texte werden
    nicht an der Spaltenbreite umbrochen, Schriftart/Schrägstellung/Spiegelung fehlen; LWPOLYLINE-Breiten
    (dicke Architektur-Ticks erscheinen als dünner Strich); Koordinaten-, Bogenlängen-, Knick-Bemassung ohne
    Anonymblock nur als Text; Toleranzen/Alternativeinheiten/Textrahmen fehlen; Layout-Ansichtsfenster
    (Modellansicht im Papierbereich) werden nicht abgebildet; bei Aufteilung grosser DXF (≥ 4 MB, parallel) fehlt
    der Layout-Bericht; Ordinate-Bemassung; Tauri/macOS nicht getestet.
  - ✅ **Export für Fachplaner** (28.10.): statt loser Linien schreibt der Export dort, wo das Modell die Information
    trägt, CAD-Objekte (`export/exportDxf.ts` sammelt, `fileio/src/export.rs` + `export_dim.rs` bauen; neue
    Datensätze der flachen Zeichnung, Version bleibt 1). **Bemassung:** `Drawing2D {shape:"dimension"}` → je Segment
    eine echte ausgerichtete DIMENSION mit Anonymblock `*D…` (Hilfslinien, Masslinie, 45°-Architekturstriche, Masszahl
    über der Linie, nie kopfüber) und DIMSTYLE `DOSSIER_1-<N>` (DIMSCALE = Massstab, DIMTXT/DIMTSZ/DIMEXO/DIMEXE in
    Papier-mm, DIMTAD 1, Textstil); von Hand verschobene Masszahlen bleiben. **Türen/Fenster** (Primitive mit
    `openingId`, Rahmen aus der Wand) → BLOCK `Tuer_90x210`/`Fenster_…` in Wandrichtung + INSERT mit ATTRIB (ID, TYP,
    TYPENAME, BREITE_M, HOEHE_M, BRUESTUNG_M); gleiche lokale Geometrie teilt sich einen Block. **Möbel/Symbole/
    Nordpfeil** (`shape:"block"`) → BLOCK je Definition (Name = Blockname) + INSERT mit Drehung/Skalierung.
    **Linientypen:** Strichmuster → LTYPE (Name des Projekt-Linienstils bzw. `DOSSIER_STRICH_…`, Papier-mm × Massstab),
    je Entität gesetzt. **Textstile:** STYLE `DOSSIER` mit Schriftname aus den Projekt-Textstilen (sonst Arial), Fett/
    Kursiv als eigene Stile; Raumstempel (Name/Nutzung/Fläche) neu als TEXT, zentriert/links/rechts (72), Zeilen wie im
    Plan; mehrzeilige/umbrochene Texte je Zeile. Strichstärken der Ebenen rasten auf CAD-Stufen; unsichtbare Pick-Bänder
    (Dach, Schnittlinie) entfallen; Schnittsymbole auf Ebene `SECTIONS`. **Papierbereich:** optional ein Layout
    (A4–A0 oder Sonderformat) mit Ansichtsfenster im Planmassstab (`--layout`). Dialog: Massstab, Einheit der Masszahl
    (m/cm), Papierbereich; CLI `dxf|dwg --scale N --dim-unit cm --layout`. Geprüft: `cargo test` (acadrust-Rundreise DXF/
    Binär/DWG je Datensatzart), ezdxf-Auditor 0 Fehler (`exportDxf.cad.test.ts`, `scripts/validate-dxf.py` liest jetzt
    Blöcke, Stile, Linientypen, DIMSTYLE, Layouts), libredwg (DWG), eigener DXF-Import (Masszahlen, Geometrie).
    **Offen:** in AutoCAD/BricsCAD selbst nicht geöffnet (DIMTSZ-Strichlänge, Textlage und `*D`-Block dort ungeprüft);
    Wand/Decke/Treppe bleiben Linien/Polylinien (Plan liefert keine Bauteil-Instanzen); keine Strichstärke je Entität
    (nur je Ebene); Schnittsymbole nicht als Block (Plan trägt keine Kennung); Ebenennamen `Code_Name` (kein SIA-2014-
    Schema im Projekt); Masszahl-Einheit nur über Option (keine Projekteinstellung vorhanden); Ansichtsfenster ohne
    eingefrorene Ebenen/Plotstil; Tauri/macOS nicht getestet.
- ○ **[C3] MCP an die laufende App** (`--connect 127.0.0.1:7979`, Werkzeuge `screenshot`, `ui_click`,
  `render` → PNG, `execute` = jeder Befehl mit JSON): genau die fehlende Hälfte von [9]; setzt [6] voraus. · M
- ◐ **[C4] CLI-Skripte** (`run --script`, `--cmd` mehrfach mit `{last}`, `convert`): Befehle headless
  verketten — für Tests, Agenten und Stapelverarbeitung. Erweitert [4]. · S–M
  28.10. **`convert <eingabe> <ausgabe>`** (Format nach Endung: dxf/dwg/ifc/obp lesen, obp/dxf/dwg/ifc/obj/stl/
  glb/gltf/step schreiben; IFC mit `--elements` als Bauteile) und **`--cmd` mehrfach** (auch ohne `convert`:
  `dossier-cli p.obp --cmd "plan --out a.svg" --cmd "dxf --out {last}.dxf"`; `{last}` = zuletzt geschriebene
  Datei; Abbruch beim ersten Fehler) in `src/cli/main.ts`, Tests `src/cli/convert.test.ts`. **Offen:**
  `run --script` (Skriptdatei), `--cmd` ohne gemeinsames Projekt (jeder Befehl sieht das Ausgangsprojekt, keine
  Änderungen werden durchgereicht); DXF/DWG-Import in `convert` legt alles auf das erste Geschoss und nimmt
  die Layer als Kategorien (keine Dialog-Optionen wie Platzierung); `convert` nach pdf/svg fehlt.
- ○ **[C5] Copy-on-Write-Elementspeicher** für billiges Undo: Vorlage für das Modell in Rust ([K4], [8]). · —
- ○ **[C6] `cargo xtask ci`**: prüft Formatierung, Clippy, Tests, **Crate-Schichtung**, **Asset-Herkunft** und
  den WASM-Build in einem Befehl — Ausbau von [22] (fmt/clippy fehlen) und [51]. · S
- ○ **[C7] Text in Rust** (TEXT/MTEXT-Layout, OpenType-Shaping, Unicode-Bidi): Vorbild, wenn `text/` mit
  [K4] nach Rust wandert. · M
- ○ **[C8] Releases** (macOS universal signiert und notarisiert, Windows MSI, Linux AppImage/Flatpak/deb/rpm,
  `SHA256SUMS.txt`): Muster für [30]. · M
- ○ **[C9] Ehrliche Paritäts-Doku** (`docs/file-format-parity.md`, `docs/gaps.md`: was beim Speichern verloren
  geht, was fehlt): passt zu [60]. · S
- ○ **[C10] Kleinigkeiten:** Log-Rotation über `RUST_LOG`, isoliertes Profil per Umgebungsvariable,
  „reduzierte Bewegung" aus den Systemeinstellungen. · je S
- ◐ **[C11] glTF 2.0 / GLB-Export + Mesh-Export in Rust** (28.10.): `src-tauri/fileio/src/mesh_export.rs` schreibt
  OBJ, STL (Ausgabe zeichengleich zur früheren TS-Fassung, Golden am Beispielprojekt) und **glTF/GLB** (eigener
  Code, keine Abhängigkeit): ein Knoten je Bauteil (`Wand_<id>`, `extras` = Typ + id), Geschoss als Eltern-Knoten,
  PBR-Materialien mit der Farbe der Komponente (linear umgerechnet), Verglasung transparent (`BLEND`), Meter,
  **Y-up rechtshändig: Modell (x, y, z-hoch) → (x, z, −y)**, Norden = −Z. TS (`src/export/exportMesh.ts`) sammelt nur
  flach. Export-Dialog „glTF 2.0 (GLB)“, Tauri-Menü, CLI `glb`/`gltf`. Prüfung: Khronos-Validator
  (`gltf-validator`, devDependency, Apache-2.0) ohne Fehler, Rundreise Knoten-/Dreieckszahl gegen OBJ,
  8 Rust-Tests. **Nachgeführt 28.10. (zweiter Schritt):** Dächer (`Dach_<id>`), Treppen (`Treppe_<id>`: Tritt-Prismen,
  Ortbeton-Laufplatte, Handlauf), Stützen (`Stuetze_<id>`), Gelände (`Gelaende_<id>`) und importierte IFC/DXF-Meshes
  (`Kontext_<id>`, mit `color`, falls gesetzt) in OBJ, STL und glTF; Verglasung/Rahmen je Öffnung ein Knoten
  (`Fenster_<id>`/`Tuer_<id>`, `extras` = Öffnungs-id; die Sammelknoten `glazing`/`frame` gibt es nicht mehr, Öffnungsteile
  jetzt auch in OBJ/STL). Quelle sind dieselben `emit*`-Ableitungen wie im 3D (`projectToModel3d`), je Bauteil mit einem
  Ein-Bauteil-Projekt aufgerufen (die Ableitungen liefern keine ids; `src/plan` unverändert). Wicklung: `orientOutward`
  (verschweisste Kanten, Komponenten, Volumenvorzeichen), da render3d doppelseitig zeichnet. **Achsen OBJ/STL geändert:**
  rechtshändig wie glTF, Modell (x, y, z-hoch) → (x, z, −y), Norden = −Z (vorher gespiegelt (x, z, +y)); niemand ausser dem
  eigenen Test hat die alte Abbildung erwartet. Optionen `openingParts`/`context` (Standard an). Prüfung: Validator 0 Fehler,
  Volumen aller Teile > 0, Dreieckszahl je Art = Summe der Ableitungen, Rundreise OBJ = glTF. **Offen:** keine Normalen
  (Flat-Shading), keine Texturen/Instanzen, Gelände ohne Vertex-Farben (Luftbild), Abzugskörper-Booleans (`voids`) und
  truck-Extrusionen (nur Prisma-Näherung) nicht wie im 3D; Dreieckszahl nicht gegen die GPU-Puffer von render3d gemessen
  (Wand-Löcher und Decken aus denselben Ableitungen, Dächer/Stützen/Treppen/Öffnungen identisch); nicht in
  Blender/Twinmotion/Enscape geöffnet, nur Validator; nicht in der Tauri-App getestet. · S
- ◐ **[C12] Allgemeiner Mesh-Import als Kontext-Meshes** (Gegenstück zu [C11], 28.10.): Nachbargebäude, Möbel und
  Umgebungsmodelle aus SketchUp/Blender/Rhino. Eigener Code in `src-tauri/fileio/src/mesh_import.rs` (OBJ + MTL, STL,
  PLY mit Flächen) und `mesh_import_gltf.rs` (glTF 2.0/GLB mit kleinem JSON-Leser, keine neue Abhängigkeit; earcutr
  für N-Ecke), Bindung `import_mesh` in `pkgFileIo`. OBJ: `o`/`g`/`usemtl` → je Objekt+Material ein Mesh (Gruppe = Ebene),
  Polygone trianguliert (Drehsinn bleibt), negative Indizes, MTL `Kd`/`d`/`Tr` (`.mtl` nur, wenn mitgegeben). STL: ASCII
  (mehrere `solid`) und binär, Eckpunkte verschweisst, Farbvarianten VisCAM/SolidView und Magics (`COLOR=`). glTF:
  .gltf (Data-URI, externe `.bin` nur wenn mitgegeben) und .glb, Knoten-Hierarchie (Matrix oder TRS, Spiegelung dreht
  die Wicklung), TRIANGLES/STRIP/FAN, Indizes u8/u16/u32, normalisierte Ganzzahl-Positionen, `baseColorFactor` → sRGB
  als `color`; Draco/Meshopt → Fehlermeldung. PLY ohne Flächen → Fehler `[punktwolke]`, die App öffnet dann den
  Punktwolken-Import. Achse: glTF Y-up = Umkehr der Export-Abbildung (Datei (X,Y,Z) → Modell (X,−Z,Y)); OBJ/STL/PLY
  Z oben / Y oben / automatisch (Kopfkommentar „Dossier/Blender/Rhinoceros“, dann kleinste Ausdehnung, sonst OBJ Y,
  STL/PLY Z; `up_certain` meldet, ob belastbar). Einheit mm/cm/m/inch/foot (glTF immer m). Budget 6 Mio. Dreiecke,
  24 Mio. Eckpunkte; NaN/Index ausserhalb/entartet werden verworfen und gezählt, nie Panic. TS: `io/meshImport.ts`
  (+ `meshImport.worker.ts`, Rückfall im Thread), Abbildung wie [B3] (`color`, `layer` = Gruppe; > 2000 Objekte je
  Gruppe+Farbe zusammengelegt), Dialog `ui/MeshImportDialog.tsx` (Einheit, Achse mit Erkennungsanzeige, Platzierung
  „Projekt-Nullpunkt“ = Grundriss-Mitte auf 0 und Unterkante auf z = 0 / „Original-Koordinaten“ mit LV95-Rückschub wie IFC),
  Menü „3D-Modell importieren …“ (mehrere Dateien: Modell + `.mtl`/`.bin`), Drag & Drop (auch mehrere Dateien),
  CLI `import-mesh <datei> [--unit] [--up] [--placement] [--out]` und `convert` mit obj/stl/gltf/glb/ply als Eingabe
  (Begleitdateien aus dem Verzeichnis). Einfügen nur über `setProject`/Ops (`addContextObjectsAndFit`).
  Prüfung: 27 Rust-Tests (Rundreise glb/gltf/obj/stl mit den eigenen Schreibern: Dreieckszahl, Volumen, Lage, Farbe;
  Quads/konkave N-Ecke, negative Indizes, MTL, Node-Matrizen/TRS, Strip/Fan, externe `.bin`, Budget, jede Kürzung gültiger
  Dateien und Müll ohne Panic), 13 vitest (Fassade, Platzierung, Worker-Protokoll) + 4 CLI-Tests. `src/io/swissBuildings3d.ts`
  hat keinen eigenen OBJ-Parser (nur DXF/DWG werden gelesen, `.obj` steht nur in der Asset-Prioritätsliste) — dort nichts
  umzustellen. **Offen:** keine Texturen/UVs/Normalen/Vertex-Farben (glTF `COLOR_0`, OBJ `v x y z r g b`), keine
  Instanzen-Erweiterungen (`EXT_mesh_gpu_instancing`), Sparse-Accessors ignoriert, Draco/Meshopt nicht gelesen,
  `KHR_materials_pbrSpecularGlossiness` ignoriert; STL-Magics-Bit-Belegung nach Beschreibung, nicht an echten Dateien geprüft;
  Achsen-Erkennung ist eine Heuristik; Dialog und Drag & Drop nicht in der Tauri-App und nicht im Browser angeklickt;
  keine Dateien aus echtem SketchUp/Blender/Rhino gelesen (nur Rundreise und synthetische Fälle). · M

## Bewusst nicht übernommen

egui, CPU-Renderer (s. [R3]), Revit-Bedienkonzept, Strich-Schrift, Haustechnik-Disziplinen. Zusätzlich:
- **HLR [G4]:** BIMCraft hat keine vektorielle Verdeckung → selbst lösen.
- **`crates/rvt` (Revit):** Rechtsrisiko bei wenig Nutzen.
- `pdf.rs` (jsPDF + svg2pdf ist besser), `texture.rs`, `stairs.rs`, `snap.rs`, `crates/update`, `csg.rs`.
