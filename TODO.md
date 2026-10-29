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
- ✅ **Mac-Test 29.10.** (Maintainer): Stand master 29.10. (Kern-Port [K3d]/[K4] S3–S4, Undo im Kern, Plan-Puffer v2, Raumprogramm, Dächer mit Höfen) — „clean“, keine Auffälligkeiten gemeldet.
- ✅ **Mac-Test 29.10. abends** (Maintainer): Stand master `44e17ee` (Rust-Port abgeschlossen [K3]/[K4], Verlauf-Panel [84], Layout-Blatt [93], STEP-Import im Kern, grosse Importe) — „läuft alles“.
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
- ✅ **[K3] Plan, Schnitt, Ansicht in Rust** (abgeschlossen 29.10.), Primitive direkt an render2d (ohne TS-Umweg). · L
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
  - ✅ **[K3a] Plan-Erzeugung in Rust** (Wand-Poché, Öffnungssymbole, Decken, Treppen, Dächer, Räume,
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
    ✅ (29.10.) 2D-Zeichnungen: `drawing2d.ts` (Stil-Auflösung und Verteiler über alle Formen) ist nach `core/src/plan/drawings.rs`
    gezogen und gelöscht, s. [K3d] „2D-Zeichnungen im Kern“. Danach: [K3c] Schnitt/Ansicht, [K3d] Aufräumen.
  - ✅ **[K3c] Schnitt und Ansicht** (`toSection`, `toElevation`, `meshSection`) im selben Puffer-Format (29.10.).
    ✅ Schnitt-Bänder: Dominanz-Subtraktion, Verschmelzung, Rechteck-Vereinigung (`plan_section.rs`, 28.10.).
    ✅ Ansicht: Verdeckungs-Clipping, Punkt-Verdeckung, Schlagschatten, XOR-Umriss (`plan_elevation.rs`, 28.10.).
    ✅ Ansicht: Flächen (Wand-Quader, Decken-Prismen, Dach/Giebel) projizieren + Rückseiten-Culling, Eck-Verlängerung, Öffnungen (Rahmen, Glasfelder, Sprossen, Sims, SIA-Symbol) (`plan_elevation.rs`).
    ✅ Netz-Ebenenschnitt (Körper/Gelände) + Ringe→Flächen (`mesh_section.rs`; behebt nebenbei: rückwärts geschlossene Ringe gingen verloren).
    ✅ Dach-Schnittspur (Cyrus–Beck, lineare Oberkante, Verschmelzen) in `plan_section.rs`.
    ✅ Abzugskörper-Geometrie (`voids.rs`: Polygon minus Schneider mit Schlüsselloch-Stegen, Strecke ausserhalb, Schnitt-Rechtecke); behebt: bei mehreren getrennten Aussparungen wurde nichts abgezogen.
    ✅ (29.10.) Schnitt und Ansicht als Kern-Abfragen `sectionPlan`/`elevationPlan` (`core/src/plan/{section,elevation}.rs`) auf dem
    Dokument, Ausgabe Plan-Puffer v2 mit Pick-Ids (lazy gelesen wie `generatePlan`): Besitzer-Zuordnung, Schicht-Bänder, Stil,
    Decken-Terminierung, Dominanz, Treppen, Monolith, Abzugskörper, Gelände, Schnitt-Tiefe, geschnittene Fenster/Türen
    (`sectionOpenings`), Ansicht mit Eck-Verlängerung, Verdeckung, Schatten, Painter. Der Prismen-Schnitt läuft über
    `render3d::section::cut_section` (Kern hängt an render3d ohne Features); Zahlen, die früher über JSON in render3d
    reisten, werden bitgleich nachgebildet (kürzeste Darstellung, serde_json ohne `float_roundtrip`). Aus TS kommen nur
    noch die truck-Körper (flach, `Float64Array`). Gleichheit: Primitive (Object.is, auch −0), Ausmass, render2d-Szene und
    SVG gegen die TS-Fassung — Beispiel (40 Linien), 60 Zufallsprojekte (Dächer aller Formen, Treppentypen, Öffnungen,
    Abzugskörper, Gelände, Overrides, Terminierung, Tiefe) × 3 Optionssätze, gekacheltes Projekt 6×6; CLI-SVG byte-gleich.
    Ausnahme (Fehler der alten Fassung): eine render3d-interne Schraffur (Muster als Zahl) sickerte bei nicht zuordenbaren
    Decken-/Treppen-Bändern als Plan-Schraffur durch (GPU: Diagonale, SVG: keine) — jetzt die vorgesehene
    Rückfall-Schraffur. Ursache bleibt offen: `slabSegmentOwners` zählt Decken, das Schnitt-Modell emittiert je
    Deckenschicht und Treppentritt eine Platte (Index-Versatz; mehrschichtige Decken im Schnitt falsch geschichtet).
    ✅ Behoben (29.10.): Besitzer kommen aus dem Schnitt-Modell statt aus Zählungen — `RSlab::source` (Decke + Schicht bzw.
    Treppe), Wände über `RWall::wall_id`; `wall_segment_owners`/`slab_segment_owners`/`split_slab_layers` gelöscht. Jede
    Deckenschicht ist ihr eigenes Band mit ihrem Bauteil (vorher wurde jede Schicht-Platte nochmals in alle Schichten geteilt,
    ein Teil fiel auf die Rückfall-Schraffur); Treppentritte tragen Treppe/Kategorie, auch für die Tiefe (Mitte des Tritts).
    Dächer gehen nicht mehr zusätzlich durch render3d (ungestylte Doppel-Bänder je Schicht × Fläche unter den gestylten,
    Besitzer per Index falsch); von der Dominanz beschnittene Stücke behalten Kategorie und Treppe (Ebene aus → weg).
    Gewollte Ausgabe-Änderung: nur Schnitte (CLI byte-gleich für Plan/Ansicht auf 9 Projekten, 18 Schnitte geändert,
    angesehen: Beispiel, mehrschichtige Decken 4/2/1 Schichten mit Aussparung, 2 Treppen, 2 Dächer); Golden `schnitt.svg` neu.
    Leistung (29.10., Ausgabe bitgleich, Gleichheitstest nach jedem Schritt): render3d-Verdeckung über ein u-Raster mit nach
    Tiefe sortierten Zellen und Abbruch bei ganz verdeckter Kante (vorher jede Kante gegen jedes Prisma); Ansicht: Verdecker,
    Schatten, Eck-Verlängerung über Raster (`ugrid.rs`), Linien-Clipping nah→fern mit Abbruch; Schnitt-Dominanz nur gegen
    treffende Schneider, Verschmelzen ohne Neustart über alle Paare, Monolith-Umriss per Bereichs-Malen; Öffnungen je Wand
    einmal indiziert; Zahlen-Nachbildung mit Schnellweg. Messung (Node/WASM, Min., Kacheln des Beispielhauses mit Treppen):
    Schnitt 6×6 10,2 s → 0,10 s, 8×8 33 s → 0,19 s, 16×16 0,8 s (alt nicht messbar, > 1 min); Ansicht 8×8 107 → 29 ms.
    Der Kern merkt sich die zuletzt vorbereiteten Schnitte (Schlüssel je `computeSection`): Schwarz-Weiss/Sichtbarkeit
    umschalten 8×8 ~1 ms statt Neurechnen. Offen: Szene mit vielen verdeckten (gestrichelten) Kanten bleibt teuer
    (16×16 mit verdeckten Kanten ~2,5 s, Strichmuster-Zerlegung in `plan_scene`).
    ✅ (29.10.) Strichmuster im render2d-Shader statt CPU-Zerlegung: gestrichelte Linien/Züge/Umrisse gehen je Segment als
    EINE Instanz (`DashSegment`: Lauflänge, Zuglänge, Muster bis 8 Einträge) an die neue Strich-Pipeline (`DASH_LINE_WGSL`); der
    Fragment-Shader setzt Striche, Lücken und runde Strich-Enden je Pixel (Semantik wie `split_dash`, CPU-Spiegel
    `dash_coverage` gegen die alte Zerlegung getestet; längere Muster zerlegt weiter die CPU). Die Zerlegung lag in
    `render2d::tessellate` (nicht `plan_scene`) und war das eigentliche Problem: big16-Schnitt S2 (385 000 verdeckte Kanten)
    173 Mio. Linien-Vertices/409 Mio. Indizes, `compile_scene` 9 s nativ — und schon 6×6 überschritt die WebGPU-Puffergrenze
    (256 MB, „Buffer size … greater than the maximum“), der Schnitt wurde gar nicht gezeichnet. Jetzt 0,36 Mio. Vertices +
    25 MB Instanzen, `compile_scene` ~0,1–0,9 s (Container unter Last). Bilder (Headless, lavapipe, `render_png --scene`):
    13 Ausschnitte Schnitt/Plan alt vs. neu ≤ 0,09 % Pixel abweichend (Kanten-AA), Strich-Enden rund wie vorher.
    SVG/PDF/DXF unberührt. Offen: Kern-Seite bleibt (big16 S2: Schnitt-Primitive 0,37 s, `planSceneBin` 0,45 s); der
    Chunk-Pfad (`gpu_compile.rs`, WebGL/nativ-Chunks) zeichnet Striche weiterhin durchgezogen. Nicht in der Tauri-App/Metal und
    nicht im Browser-WebGPU angesehen (nur lavapipe/Vulkan headless).
    ✅ (29.10.) Strichmuster auch im Chunk-Pfad (nativer macOS-Renderer `useNativePlanRenderer` → `GpuChunkCache` →
    `render2d/chunks.rs`). Befund: KEINE Regression des Shader-Merges — der Chunk-Pfad hat Linien-Strichmuster nie
    gezeichnet (schon die TS-Fassung `glPlanCompile.ts` vor [K3b] ignorierte `dash`, nur Schraffur-Striche wurden zerlegt;
    `0516253` hat `core/gpu_compile.rs` nicht berührt) — auf dem Mac waren verdeckte Kanten, Achsen, gestrichelte
    Zeichnungen seit jeher durchgezogen. Jetzt: die GPU-Sicht des Plan-Puffers trägt `dash` (Linie/Bogen/Kreis/2D-Bogen),
    `gpu_compile` gibt gestrichelte Züge als Instanzen im render2d-Format aus (16 f32: Segment, Lauflänge, Zug, Muster;
    Phase über verkettete Linien, Länge Papier-mm × 0,1 wie der Szenen-Pfad, > 8 Einträge zerlegt die CPU), der
    Chunk-Renderer zeichnet sie mit DEMSELBEN `DASH_LINE_WGSL`, in Maler-Reihenfolge mit den Linien verzahnt (`lineAt`;
    sonst lagen graue verdeckte Kanten über den Schnittkanten). Flaches Format/`NativeChunkLayout` additiv (`dash_inst`,
    `dash_batches`, serde-Vorgaben). Tests: Kern (Instanzen, Phase, Muster-Rückfälle, Maler-Reihenfolge, Deckung auf der
    Achse = `apply_dash_runs`-Zerlegung, 150 Zufallsfälle), render2d (Reihenfolge; Chunk-Renderer headless zeichnet
    Strich/Lücke), TS-Fassade. Bilder (lavapipe, neu `render_png --chunks/--bounds`): Schnitt mit 752 verdeckten Kanten,
    Grundriss, gestrichelte Zeichnungen — Chunk-Pfad vs. Szenen-Pfad 0,00 % abweichend in den Schnitt-Ausschnitten,
    Rest = Texte (zeichnet der Chunk-Pfad nicht) und vorbestehende Unterschiede; alt (durchgezogen) sichtbar anders.
    Nicht kompiliert: `cad-tauri` mit `native2d` für macOS (Linux-Container: cc kann kein `-arch arm64` für
    objc2-exception-helper) — `native_embed.rs` ist unverändert, `render2d` (`window`) für `aarch64-apple-darwin`
    per `cargo check` geprüft. Nicht auf Metal/in der Tauri-App angesehen.
    TS-Fassung gelöscht (29.10.): `toSection.ts`/`toElevation.ts` sind dünne Fassaden (Ebene, Sichtbarkeit, truck-Körper →
    Abfrage), `sectionOpenings.ts`, `sectionExtras.ts`, `meshSection.ts`, `generateSectionPlan`/`resolve*SectionStyle` in
    `generatePlan.ts`, `windowSymbol` (opening.ts), `keyhole`/`voidSectionRects`/`subtractVoidsInSection` (voids.ts) und ihre
    Bindungen entfernt; die Fälle der alten TS-Einzeltests laufen als Rust-Tests (`plan/section.rs`, `plan_section.rs`,
    `plan_elevation.rs`, `mesh_section.rs`), die übrigen TS-Tests (Ansicht, Öffnungen, Gelände/Körper, Golden-SVG) gegen den
    neuen Weg; der Gleichheitstest ist wieder entfernt. Nicht in der Tauri-App angesehen; pkg3d (3D-Live-Schnitt, gleiche
    render3d-Verdeckung) nicht neu gebaut.
    Bleibt in TS: `planUnderlay.ts` (legt den TS-Grundriss unter Schnitt/Ansicht; zieht mit `generatePlan`/`drawing2d.ts` um),
    das Bauen der truck-Körper (asynchron, eigenes WASM).
    ✅ (29.10.) Grundriss-Unterlage im Kern: `plan/underlay.rs`, Abfrage `planUnderlay` (Argumente wie `planDomains` + Ebene +
    `minY`) liest den Grundriss aus den Plan-Caches (Haupt-Puffer + Zeichnungs-Stücke), bildet ab (Drehung/Verschiebung,
    Schraffurwinkel, Bilder nur ohne Drehung), dimmt, entfernt die Auswahl-Ids und hängt die Schnittlinie an; TS-Fassade
    `planUnderlayPrimitives(project, level, floorId, minY, …)` in `generatePlan.ts` (dort auch `crossKindOverlayAllowed`).
    `planUnderlay.ts` gelöscht, seine Tests als Rust-Tests. Gleichheit gegen die TS-Fassung (Object.is, inkl. Strip der Ids):
    456 Fälle / 142 405 Primitive (9 Projekte inkl. 2D-Zeichnungen, Schnitt-/Ansichtslinien + schräg/senkrecht/beide
    Blickrichtungen, Mono/Detail/Massstab). Nicht in der App angesehen (e2e grün).
    (Die automatischen Höhenkoten `levelMarkers.ts` rechnet seit 29.10. der Kern, Abfrage `levelMarkers`.)
  - ✅ **[K3d] Aufräumen:** TS-Primitive-Erzeugung löschen, SVG/PDF/DXF-Export lesen den Puffer. Hängt an [K4]: Rust braucht das
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
    Offen: Schatten/Baurecht (dünner Stil-Glue um `analysis/`, Datum/Sonnenstand in TS), Abzugskörper
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
    ✅ (28.10.) **Verbraucher lesen den Puffer** (Szene, Auswahl, Fang, SVG-Export). Grundlage `core/src/plan_parts.rs` ↔
    `src/plan/planParts.ts`: ein Plan als Abschnitte gehaltener Plan-Puffer in Zeichenreihenfolge — Kern-Abschnitte aus `Plan.bufRuns`
    (Objekt-Identität geprüft) ohne Umweg, der Rest (2D-Zeichnungen, Schatten, Baurecht, zerlegte Polygone, gedimmte Klone) einmal in
    einen eigenen Puffer (ohne Schraffur-JSON; Texte nur mit JSON für den SVG-Export); `greyedRanges` gehen als Bereiche mit (kein
    Klonen). Gehaltene Puffer sind geteilt (`Rc`), bis 64; verdrängt → TS legt neu ab und fragt nochmals.
    - Render-Szene: `core/src/plan_scene.rs` (Farben wie `toRgba`, CSS-Klassen, Dimmen, `z`, Verkettung, Kantennaht mit Raster statt
      O(n²)-Suche, Schraffur-Läufe, Zickzack/Motiv, Kreis-Tessellierung) schreibt die render2d-Szene v1 direkt (`planSceneBin` →
      `set_scene_bin`, `push_native_scene`) bzw. eine verlustfreie f64-Szene (`planToRenderScene` für `sceneToPrintSvg`/PDF/SVG-Dialog,
      CLI `--format json`). Text-Layout bleibt TS (`planSceneTexts`). `renderSceneBin.ts` gelöscht, Fixture-Test nach Rust.
    - Auswahl: `core/src/plan_pick.rs` ↔ `src/plan/planView/planPick.ts` (Index je Plan, lazy): 2D-Zeichenlinien im Raster (wie
      `segmentIndex`), Polygone unter dem Punkt (oberstes/unterstes, Pick-Feld-Filter), Symbol-Linien/-Bögen in Client-Pixeln, Kreis-/
      Bogen-Ringe, Besitzer. PlanView fragt nur ab (hitTest, pickRoom/Roof/Stair/Opening/Column/…, pickDrawing, nearDrawingIds,
      Hervorhebung); `segmentIndex.ts`, `ownerIndex.ts` und die Schleifen über alle Primitive je Mausbewegung gelöscht.
    - Fang: `core/src/snap.rs` ↔ `src/geometry/snapSegments.ts`: Strecken eines Projekt-Geschosses einmal im Kern (Raster), je
      Mausbewegung Lot/Endpunkt/Mitte/Schnitt/Kante/Verweilen; Schnittpunkte nur zwischen Geraden, die näher als die Toleranz am Cursor
      vorbeigehen (vorher alle Paare). Die Sammlung der Strecken (Modell) bleibt in `tools/snapping.ts` (bis [K4]), gecacht je
      Projekt/Geschoss/Sichtbarkeit samt Raum-Ankern, Kreisen, Ellipsen.
    - SVG-Text-Export: `core/src/plan_svg.rs` (`planToSvgString` für CLI/MCP/Goldens), Texte aus dem Text-JSON des Puffers.
    Gleichheit (temporäre Paritätstests gegen die alten TS-Fassungen, danach entfernt): Szene JSON + Binär bitgleich (Beispielprojekt
    alle Ebenen × Detailgrade × mono, Überlagerung mit gedimmten Ebenen, Schnitt, Ansicht, 400 Zufallslisten aller Primitiv-Arten,
    grosses Projekt); Auswahl 25 000 Abfragen gleich (Beispiel + Überlagerung, 150 Zufallspläne, grosses Projekt); Fang 2600 Abfragen
    gleich (Beispiel, mit 2D-Zeichnung, Nahmodus > 2000 Zeichnungen, bigSample(3), Verweilen an/aus, alle Fang-Arten zufällig); SVG
    328 Pläne byte-gleich, Goldens unverändert; CLI plan EG/OG (svg, json), section, elevation, dxf md5-gleich zur CLI des Hauptstands.
    Messung (Node, Linux-Container, `--no-opt`-WASM): Szene grosses Projekt 3125 → 133 ms (Beispiel-EG 1,8 → 0,7 ms); Auswahl grosses
    Projekt + 100k 2D-Linien alle Hover-Abfragen zusammen 90 ms → 30 µs je Mausbewegung (Aufbau ~100 ms lazy); Fang grosses Projekt
    27,6 s → 0,8 ms je Mausbewegung, bigSample(5) 135 ms → 57 µs. Kodieren des eigenen Puffers in TS ~1 µs je Linie (bei 100k
    gemischten Primitiven ~200 ms, einmal je Plan). Nicht in der Tauri-App angesehen; `push_native_scene` nur über die Bytes geprüft.
    Bleibt über `Primitive[]`: Text-Overlay und SVG-Rückfall der PlanView (`nativeText`, `primitives.tsx`, Culling `cullPrimitives`),
    Marquee (`marqueeHit*`, nur beim Loslassen), `drawingLabel`/Text-/Bild-Treffer (Bbox, je Plan vorsortiert), DXF-Sammler
    (`exportDxf.ts`, 1000 Zeilen Stil/Layer-Logik) und `planToPrintSvg.ts` (Layout-PDF/LayoutSheet; nicht auf `sceneToPrintSvg`
    umgestellt, weil die Ausgabe dann nicht mehr byte-gleich wäre). `generatePlan` dekodiert den Kern-Puffer weiter vollständig
    (für diese Verbraucher); fällt, wenn sie den Puffer lesen bzw. das Modell nach Rust zieht [K4].
    ✅ (29.10.) **Letzte Verbraucher lesen den Puffer, `generatePlan` liest lazy.**
    - Lazy Plan (`src/plan/planLazy.ts`): `generatePlan`, `generateVisibleLevelsPlan`, `materializeUnderlay` und
      `planWithExtra` (Überlagerungen in `viewportContent`) setzen den Plan aus Stücken zusammen (Kern-Abschnitte +
      TS-Listen); `plan.primitives` entsteht erst beim ersten Zugriff. `decodePlanBuf` liest Einträge, Texte und
      Schraffur-JSON bei Bedarf (`prim(i)`, `tag(i)`); `planPrimAt` (ein Eintrag), `planTextEntries` (nur Texte/Bilder,
      aus den Typ-Kennungen), `planCount`. `planParts` nimmt die Stücke direkt (keine Identitätsprüfung). Abzugskörper,
      Mono und Strichstärken-Massstab bleiben auf der Liste (sie ändern Primitive).
    - Auswahl (`plan_pick.rs`): Rahmen-Auswahl über Polygone je Pick-Art und über 2D-Zeichnungen (Linien, Polygone,
      abgetastete Kreise/Bögen, Text-/Bild-Rahmen, Unterlage ausgenommen), Einzeltext-/Bild-Treffer, Form einer
      Zeichnung (`drawingLabel`). `marqueeHit*`/`marqueeHitDrawings` in TS gelöscht.
    - PlanView: Einzelzugriffe über `planPrimAt`; mit GPU kommen SVG-Kandidaten/Culling nur aus den Text-Einträgen
      (Culling selbst bleibt TS über diese wenigen); `planSceneTexts` und die native Text-Sync lesen nur Text-Einträge.
    - DXF/DWG (`plan_dxf.rs`): Sammler (Ebenen, Linientypen, Textstile, DIMENSION, BLOCK/INSERT/ATTRIB, HATCH, Verlauf,
      Zufallsstriche, Papierbereich) im Kern aus Puffer + Projekt-Dokument; TS liefert nur das Text-Layout flach mit und
      gibt die flache Zeichnung an fileio. `FlatDrawing`-Klasse und `dxfCadParts` (ausser `fontNameOf`) gelöscht.
    - Druck-SVG/Layout-Viewport (`plan_print_svg.rs`): Knoten als Anweisungsliste, TS legt sie als DOM an (Rahmen,
      Bild-`<pattern>`, Einzeltexte bleiben TS). Nicht auf `sceneToPrintSvg` umgestellt (Ausgabe bliebe nicht gleich) —
      nicht nötig, der Puffer-Weg ist gleich.
    Gleichheit (temporäre Paritätstests gegen die alten TS-Fassungen, danach entfernt): Rahmen-/Text-Treffer 53 870
    Abfragen (200 Zufallspläne, Beispiel EG/OG/UG, Überlagerung, bigSample(6)); DXF-Zeichnung Zahl für Zahl in 451 Fällen
    (Beispiel + Fachplaner-Projekt × Geschosse × Detailgrade × mono × Optionen, 300 Zufallspläne, bigSample(8)), DXF/
    Binär byte-gleich, CLI `dxf`/`dwg` (--binary, --scale, --dim-unit cm, --layout) 36 Dateien byte-gleich zur CLI des
    Hauptstands; Druck-SVG 475 Pläne gleich (DOM serialisiert). Bleibende Tests: `planLazy.test.ts` (Kern-Verbraucher
    lesen nicht), Marquee-/Text-Tests über den Kern, Rust-Tests für Rechteck-Treffer, Linientypen, Papier, blocklokal.
    Messung (Node, Linux-Container, `--no-opt`, Min/Median, alt und neu im selben Lauf): `generatePlan` Beispiel-EG
    0,38–0,42/0,43–0,65 → 0,30–0,33/0,35–0,40 ms; grosses Projekt (bigSampleProject 20×20) 228–241/285–294 →
    158–160/166–176 ms; mit Render-Szene (`planSceneBin`, WASM-Ansicht) 396–472 → 324–352 ms.
    Bleibt: der native macOS-Pfad (`useNativePlanRenderer`/`GpuChunkCache`) liest die Liste weiter (nicht in der Tauri-App
    geprüft); SVG-Rückfall ohne GPU, Geschoss-Überlagerung mit gedimmten Ebenen (`materializeGreyed`), Gruppen-Isolation,
    Schnitt/Ansicht-Overlays in `viewportContent` und Abzugskörper/Mono/Massstab lesen die Liste (dann wie bisher).
    ✅ (29.10.) **Text-Layout im Kern** ([K3d]/[K4]): `core/src/text_layout.rs` (Rich-Text → Zeilen/Tspans, Run-Stile inkl.
    Hoch-/Tiefstellung, Wortumbruch auf Spaltenbreite, Raumstempel-Block, einfacher Umbruch, Text-Rahmen, `fontNameOf`) und
    `core/src/plan_text.rs` (Raumstempel/Einzeltexte aus dem Text-JSON des Plan-Puffers). Die Kern-Verbraucher setzen die Texte
    selbst beim Massstab der Ausgabe: Render-Szene (`plan_scene_bin(segs, greyed, N)`, neu `plan_scene_texts` für
    `planToRenderScene`), DXF/DWG (`plan_dxf_flat` ohne Text-Eingabe, Standard-Schrift aus den Projekt-Textstilen), Druck-SVG
    (Einzeltexte als Anweisungen `X`/`L`/`R` statt `T` + TS-Layout). TS übergibt kein Layout mehr; gelöscht: `planSceneTexts`,
    `stampLines`/`textInput` (DXF), `drawingTextNode` (Druck-SVG), `runToTspan`/Umbruch in `renderHtml.ts`, die Schätzung in
    `textFrame.ts`, `dxfCadParts.ts` (+ Test, `fontNameOf` → Rust), `texts_from` (Szene, DXF). `renderHtml.ts`
    (`docToLines`/`wrapDocToLines`/`stampBlockLines`/`wrapPlainText`) und `textFrame.ts` sind dünne Fassaden (Ergebnis flach,
    Tspan-Texte als Ausschnitte der Eingabe, je Dokument-Objekt gemerkt) für SVG-Rückfall der PlanView, Layout-Blatt,
    Layout-PDF und Griffe. Der eigene Plan-Puffer trägt Text-JSON jetzt immer (auch für die Szene).
    Glyphen-Metrik: es gibt keine — wie bisher geschätzt (UTF-16-Länge × Grösse × 0.55); keine Schriftdateien, kein
    Canvas-Messen im Layout (nur `fontMetrics.ts` misst für die Inline-Editoren Grundlinie → Oberkante, bleibt TS).
    Gleichheit (temporäre Tests alt gegen neu, danach entfernt; alter Stand = Kern + TS des Hauptstands im selben Lauf):
    288 Pläne × Szene (Texte + Binär-md5), DXF-Zahlen und -Zeichenketten, Druck-SVG (DOM serialisiert) — 6 Projekte mit
    Raumstempeln aller Varianten (Feldmodell mit Nummer/Zeile 2/Flächen-Präfix/Nutzung/Ausrichtungen/Personen/Rundung,
    `stampDoc`, Name) und 60 Einzeltexten (Rich-Text mit gemischten Stilen, Hoch-/Tiefstellung, Absatz-Zeilenhöhen,
    Spalten, Drehungen, Umlaute/Emoji/CJK/NBSP/U+0085/BOM, `\r\n`) × EG/OG × 1:50/1:100/mono × Ausgabe 1:50/100/200,
    dazu 60 Zufallspläne mit Text-Primitiven (gedimmt, Deckkraft, gedimmte Bereiche): 57 527 Szenen-Zeilen, 9 741 Druck-Texte
    gleich; 600 Dokumente `docToLines`/`wrapDocToLines` + 600 Text-Rahmen gleich; 3000 Raumstempel-Blöcke und einfache
    Umbrüche der PlanView gleich; CLI `plan` (svg/json), `dxf` (1:50/100/200, `--binary --layout --dim-unit cm`), `dwg` für
    Beispiel, Kataster- und Klein-DXF-Import sowie zwei Rich-Text-Projekte: 230 Dateien byte-gleich. Einzige Abweichung:
    `−0` in TS-erzeugten Text-Primitiven (nicht aus dem Kern-Puffer) wird über JSON zu `0` (nur DXF-Zahlen, nur Zufallspläne).
    Messung (Node, `--no-opt`, Linux-Container unter Last; 3000 Einzeltexte + 400 Raumstempel): `planSceneBin` 44–70 →
    47–66 ms (gleich), DXF-Sammler 67–91 → 42–58 ms, `planToRenderScene` (nur Export) 20–36 → 56–78 ms (JSON der Texte im
    Kern lesen); Fassade `wrapDocToLines` ungemerkt ~7 → ~28 µs je Aufruf (JSON hin, flache Zeilen zurück), gemerkt < 1 µs.
    Gefunden, bewusst unverändert: im Druck-SVG (Layout-Viewports) tragen die Runs der Einzeltexte `font-size` = Höhe in
    Metern statt Papier-mm (alte TS-Formel `basePt · unitPerPt`); offen als eigener Fehler.
    ✅ (30.10.) behoben: Basisgrösse der Einzeltexte im Druck-SVG = Höhe × mm je Meter (wie die Plan-Ansicht beim
    Massstab; betraf auch Masszahlen, Höhenkoten, Schnittlinien-Bezeichner — alles `drawingText`, im Layout 1:50 20-mal
    zu klein). Raumstempel fehlten im Druck-SVG ganz (Eintrag `text` übergangen): jetzt als Block wie die Plan-Ansicht im
    Druckmodus (`stamp_block`, 10 pt Papier). Test `planToPrintSvg.text.test.ts` (Layout-Viewport 1:50: Einzeltext,
    Rich-Text mit Spalte, Masszahl 4 mm, Kote, Raumstempel) + Rust-Tests; Druck-SVG vorher/nachher in Chromium angesehen.
    Offen: Run-eigene `sizePt` in Einzeltexten bedeuten in SVG-Ansicht und Druck Modell-pt, in der Render-Szene (GPU)
    Papier-pt bei 1:100 — uneinheitlich (Editor setzt sie relativ zu 12 pt); Text entlang Pfad fehlt im Druck-SVG.
    ✅ (30.10.) Zeilen-Lage im Kern: `text_layout::place_lines` (x/Grundlinie je Zeile, Mitte/rechts in der Spalte) und
    `LineAlign::anchor`; Druck-SVG und die Bindungen `text_lines` (jetzt mit Anker x/y und Spaltenbreite) und
    `text_stamp_block` (mit x) liefern gesetzte Zeilen (`x`, `y`, Anker). TS rechnet keine Zeilen-Lage mehr:
    `layoutText`/`annotationTextLines` (`renderHtml.ts`) ersetzen `docToLines`/`wrapDocToLines` (gelöscht); SVG-Rückfall
    der Plan-Ansicht (Einzeltexte, Raumstempel), Layout-Blatt und Layout-PDF legen nur noch Knoten an. Gleichheit
    (temporärer Test alt gegen neu, danach entfernt): 400 Layout-Markups (Blatt-JSX + PDF-DOM; Breite fehlt/0/negativ/
    NaN), 400 Einzeltexte/Raumstempel × Anzeige/1:50/1:200 und 3 Druck-SVG mit 80 Zufalls-Rich-Texten — Ausgabe
    byte-gleich (18 819 Tspans). Der einfache Mehrzeilen-Text ohne Doc (`dy`) bleibt in der Plan-Ansicht wie er ist.
    `nativeText.ts` (macOS) nicht umgestellt: setzt nur einzeilige Texte ohne Doc/Spalte, rechnet kein Layout (Anker =
    `at`, Grösse = Höhe); die Farbumrechnung (`rgb()`-fähig) weicht von `plan_scene::to_rgba` ab — nicht doppelt.
    Nicht in der Tauri-App angesehen (nativer Text-Pfad `nativeText.ts` unverändert).
  Nachteile (bewusst): Übergang mit doppelter Datenhaltung, Format muss TS/Rust gleich bleiben
  (Versionsnummer + Hin-und-zurück-Tests), Text-Layout bleibt bis [K4] in TS.
- ✅ **[K4] Modell und Ops in Rust** [2]; TS bekommt die Typen generiert (z. B. `ts-rs`). · XL
  **Abschluss (29.10.):** Rechnung liegt im Kern; TS hält Oberfläche, Zustandsautomaten der Befehle, Netz-Abrufe,
  DOM-/jsPDF-Aufbau und dünne Fassaden. Bewusst in TS: `model/color.ts` (Farbmischer der UI), Sicht-Culling/Ansichts-
  Transformation/GPU-Cache der Plan-Ansicht, Werkzeug-Vorschau aus UI-Zustand. Rest-Pendenzen: STEP-Import (truck),
  Import-Ops als JSON zurück (42 MB beim 150k-Kataster). Nicht auf dem Mac getestet.
  **[84] Undo-Verlauf als Liste ✅ (29.10.):** Schritte tragen eine Beschriftung im Kern (`Step.label`, `History::set_label` für den
  nächsten neuen Schritt; Koaleszenz/Gruppen behalten die des ersten; `doc_history_label/labels/jump`, `Document::history_jump` =
  mehrere Schritte in einem Aufruf). TS: `withHistoryLabel`/`labelCommit` (`historySlice.ts`), Standard aus Befehl (`history.cmd.<cmd>`),
  Griff, Import oder den Ops (`history.op.<art>:<liste>`); Anzeige `historyLabelText`. Panel `HistoryPanel` (Bearbeiten > Verlauf,
  nicht im Standard-Layout), jüngster oben, Wiederholen-Schritte gedimmt, Klick = `jumpHistory`. Offen: Beschriftungen für
  Eigenschafts-Änderungen aus Panels sind nur „X ändern" (kein Feldname); kein Tastenkürzel; nicht auf dem Mac getestet.
  Transformation/GPU-Cache der Plan-Ansicht, Werkzeug-Vorschau aus UI-Zustand. Rest-Pendenzen:
  Import-Ops als JSON zurück (42 MB beim 150k-Kataster), Undo-Liste in der UI [84]. Nicht auf dem Mac getestet.
  Ziel (Entscheid 28.10., Maintainer): nur die UI bleibt TS, alles andere Rust. Vorgehen in Stufen, jede verdrahtet und mit
  Gleichheitstest gegen die TS-Fassung, die im selben Schritt verschwindet:
  - ✅ **S1 Dokument im Kern** (28.10.): `document.rs` hält das Projekt als JSON-Baum, `core/document.ts` spiegelt jede
    Änderung von `store.project` (setProject, Laden, Undo/Redo) als Ops (`diffToOps` → `doc_apply`); Selbstheilung durch Neuöffnen.
    Test: 300 Zufallsänderungen, Kern-JSON == TS-Projekt. (Spiegel, TS ist noch Quelle der Änderungen.)
  - ✅ **S2 Ableitungen lesen das Dokument** (28.10.): typisiertes Rust-Modell `model/` (`generated.rs` aus den TS-Typen per
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
    Dokument (`queries.rs`). ~~Offen: `fileio`-Schreiber direkt aus dem Dokument füttern statt über den TS-Sammler.~~
    **Export-Sammler im Kern (29.10.):** Der Kern erzeugt den flachen Puffer der `fileio`-Schreiber selbst (Abfragen
    `ifcExportData`/`meshExportData` über `queryBin`, Byte-Hülle `export_flat.rs`); TS gibt nur Optionen + Zeitstempel
    weiter und reicht die Bytes an `fileio` (zwei WASM-Module). Neu: `ifc_data.rs`, `ifc_quantities.rs`,
    `ifc_stairs.rs`, `mesh_data.rs`, `export_flat.rs` (Puffer, `orient_outward`, Volumen), `geo_rebase.rs`
    (LV95-Verschiebung, `lv95_to_wgs84`). Gelöscht: TS-Sammler in `exportIfc.ts`/`exportMesh.ts`, `ifcQuantities`,
    `ifcStairs`, `ifcClassification`, `ifcOpenings`, `meshOrient`, `model3dParts`, `plan/wallMeshCut` samt Bindungen.
    Gleichheit: 1396 Ausgaben (alle Exporte der Test-Suite aufgezeichnet und mit Varianten wiederholt, Beispielprojekt
    IFC4/IFC2x3 × eBKP-H × Ebenen, mit Georeferenz, 80 Zufallsprojekte mit allen Bauteilarten, bigSample(3)) vorher/
    nachher zeichengleich (mit festem Zeitstempel), auch die Fehlermeldungen; `validate-ifc.py` über 110 Dateien
    0 Befunde, glTF-Validator über 390 GLB/glTF 0 Fehler (nach [C11]-Korrektur der leeren Szene). Messung (Node,
    Linux-Container, `--no-opt`-WASM, bigSample(20)): IFC 82,5 s → 2,4 s, GLB 212 s → 1,9 s; Beispielprojekt IFC
    11 → 4 ms, GLB 15 → 2,5 ms (vorher je Bauteil ein eigenes Kern-Dokument aus dem ganzen Projekt-JSON). Nicht in
    der Tauri-App geprüft (e2e im Browser: IFC-Export grün). Bleibt: DXF-Sammler (`exportDxf.ts`) und STEP (truck);
    die Modell-Verschiebung `translateProject` liegt seit 29.10. im Kern (s. S3).
    Nächste: Export (Schedule/CSV, STL/OBJ, STEP), Plan/Schnitt/Ansicht-Sammler (generatePlan, toSection, toElevation) — hängt an Plan-Puffer v2.
    Grundriss (28.10.): Decken, Dächer, Räume, Wände+Öffnungen, Treppen, Stützen, Extrusionen, Kontext und Schnittlinien
    kommen über `planDomains` aus dem Dokument ([K3d]); seit 29.10. auch die 2D-Zeichnungen (`plan/drawings.rs`); übrig in
    `generatePlan`: Schatten/Baurecht, Abzugskörper, Mono, Strichstärken-Massstab.
    Ziel: Plan/Schnitt/Ansicht, 3D, Export rechnen mit `doc`-Handle statt flach gesammelter Arrays; TS-Sammler/-Adapter werden gelöscht
    ([K3d] hängt hier dran: Plan-Puffer v2 mit Pick-IDs und vollem Primitive-Umfang).
    Stand 28.10.: Plan-Puffer v2 steht ([K3d]) — `planDomains` liefert binär, GPU liest ihn direkt; Export/Auswahl/Overlay lesen
    noch die dekodierten `Primitive[]`.
    Nachtrag 28.10.: render2d-Szene, Auswahl, Fang und SVG-Text-Export lesen den Puffer im Kern ([K3d]); Overlay/Texte, DXF und
    Layout-PDF noch über `Primitive[]`.
    Nachtrag 29.10.: auch Rahmen-Auswahl, Text-/Bild-Treffer, Overlay-Texte, DXF/DWG und Druck-SVG lesen den Puffer im
    Kern; `generatePlan` liest die Kern-Primitive nur noch bei Bedarf ([K3d]).
    ✅ (29.10.) **2D-Zeichnungen im Kern** ([K3a]/[K3d]): `core/src/plan/drawings.rs` erzeugt alle Formen (Linie, Konstruktionslinie,
    Strahl, Polylinie mit Bögen, Rechteck, Kreis, Bogen, Ellipse, Bezier, Spline, Bemassung, Kote, Detailverweis, Massstabsbalken,
    Punktmarke, Text/Textpfad/Hinweislinie, Block über `scale_geom` rekursiv, Bild) samt Filter (Geschoss, Sichtbarkeit, `noPrint`),
    Override-Regeln, Stil-Auflösung (Element → Linienstil → Ebene, LTSCALE, Zickzack/Motiv, Schraffur mit Platzierung, Linienenden),
    Transparenz und Ausmass; die Domäne ist Gruppe 6 von `planDomains` (zwischen Stützen und Extrusionen, wie bisher) und schreibt
    direkt in den Plan-Puffer (`Writer::line_ref`, keine Primitiv-Liste dazwischen). Linienzug-Flag: Strichmuster-Kennung je Linie
    (`push_ref`) bildet die TS-Array-Referenz nach. Kompakte Unterlage: `compact` lässt die Linien einfacher Zeichnungen weg,
    `drawingUnderlay` liefert die Gruppen (Indizes), `drawingLines` die Linien einer Teilmenge — `UnderlayGroup.buildBuf` gibt sie als
    Puffer weiter (`materializeUnderlay` hängt Kern-Abschnitte an statt Objekte, der WASM-Weg kodiert nichts mehr in TS). Vorschau
    (`drawingPreview.ts`) über `drawingPrims`, Höhenkoten im Schnitt über `levelMarkers`, Masszahl-Lage (`dimTextFrame`, Griff) über
    die Bindung `dim_text_frame`. Gelöscht: `generatePlan/drawing2d.ts`, `endMarks.ts`, Bindung `end_mark_flat`; Tests
    (`drawing2d.test.ts` → `plan/drawings.test.ts`, Primitiv-Cache → Inhalts-Hashes) laufen über den Kern. `ProjectDocument.sync`
    öffnet bei > 2000 Ops neu (das Entfernen von 10⁵ Zeichnungen einzeln war quadratisch).
    Gleichheit (temporärer Test, danach gelöscht): 1,74 Mio. Primitive Feld für Feld (Zahlen per `Object.is`) gleich der alten
    TS-Fassung, dazu Linienzug-Flags (636 000), Ausmass und Unterlage (Gruppen, Linien, Teilmengen): 60 Zufallsprojekte
    (alle Formen, Stile, Blöcke verschachtelt, Overrides) × 4 Varianten (alle/kompakt 1:50/gedimmt+ausgeblendet 1:200/Druck),
    Beispielprojekt alle Ebenen, LV95-Koordinaten, Kataster 150 000 Linien/Polylinien (kompakt und voll), bigSample, 8 CAD-/DXF-
    Importe und gespeicherte Projekte, 3000 Einzel-Zeichnungen (Vorschau), 300 Koten-Sätze, 2000 Masszahl-Lagen. CLI byte-gleich
    (128 Dateien: `plan` SVG 1:100/1:50 und JSON-Szene, `dxf`, `section`, `elevation` für 10 Projekte inkl. Kataster-Importe).
    Messung (Linux-Container unter Last, Median): `generatePlan` allein (CLI `bench`, alter Stand mit Primitiv-Cache je Zeichnung)
    katbig 10k Zeichnungen 13 → 41 ms, 20k Linien 22 → 38 ms, Beispiel/CAD/Schule ~gleich (1–2 ms); Plan + Zerlegung für den
    WASM-Renderer nach einer Änderung: 10k 58 → 64 ms, 20k 65 → 71 ms, Kataster 150k 2,5 → 1,0 s; Export-Plan (Zerlegung mit
    Texten) 10k 54 → 36–43 ms, Kataster 150k 1,9 → 0,6 s. Nicht in der Tauri-App/im nativen macOS-Renderer angesehen (dort baut
    der GPU-Chunk-Cache die Unterlage weiter über `build` als Objekte).
    Offen: `geometry/geomTransform.ts` (`mvGeom`/`scaleGeom`) bleibt für die Werkzeuge in TS (beliebige Abbildungsfunktion), der Kern
    hat eine eigene Fassung für Blöcke — zusammenführen, wenn die Werkzeuge nach Rust ziehen (S3). Die WASM-Ansicht könnte ganz ohne
    kompakte Unterlage arbeiten (Linien bleiben im Puffer; `viewportContent` fordert sie heute immer an). Das erste Öffnen eines
    sehr grossen Dokuments ist im WASM langsam (200 000 Zeichnungen ~20 s, Speicherwachstum; vorher genauso, betrifft jetzt aber
    auch reine Zeichnungsprojekte in CLI/Tests, die vorher kein Dokument brauchten).
    ✅ (29.10.) **Plan-Cache im Kern** ([K4]/[K3d], Leistung): `plan/cache.rs` je Argument-Satz (Geschoss, Detail, Massstab …).
    Übrige Domänen als fertige Abschnitte mit behaltenen String-/Schraffur-Tabellen (gültig, solange sich ausser den Zeichnungen
    nichts ändert); 2D-Zeichnungen in inhaltsbestimmten Stücken (~256 Elemente, eigener Plan-Puffer je Stück, Schlüssel aus den
    Element-Ständen): `planDomains` liefert den Haupt-Puffer und nur die Stücke, die TS noch nicht hat (`have`, Antwort „PLBm“);
    ein geändertes Stück kopiert seine unveränderten Elemente fertig geschrieben in Läufen (`plan_buf::Kept`). Dokument: Element-
    Stände (`Revs`, neu bei `add`/`replace`), typisierte Sicht nach `replace` nur das Element (`model/items.rs`), id-Positionen über
    die Aufrufe gemerkt; `fieldOps` erkennt an Ort und Stelle ersetzte Elemente ohne Mengen. WASM-Heap wächst in grossen Schritten
    (`wasm_alloc.rs`: jedes `memory.grow` kostete ~0,5 ms, beim ersten Öffnen ~20 000 Mal). Gehaltene Puffer eines Plans fallen in
    einer Runde nicht weg (`plan_buf_round_begin/end`, bis 4096 Puffer/256 MB). Gleichheit: Kern-Test mit/ohne Cache (Primitive,
    Hashes, Linienzüge, Ausmass) über Zufallsänderungen inkl. Undo/Laden/Argumentwechsel und verlorene Stücke; CLI byte-gleich
    (45 Ausgaben: `plan` SVG 1:100/1:50 + JSON, `dxf` 1:100/1:50 für 9 Projekte). Ein Linienzug über eine Stückgrenze entfällt
    (gäbe es nur bei doppelten ids). Messung (vitest/Node, `--no-opt`, Container unter Last, Median): katbig 10k Zeichnungen
    `generatePlan` unverändert 40 → 2,5 ms, nach einer Änderung 55 → 6 ms (TS alt 13 ms), Abgleich `documentFor` 18 → 0,6 ms;
    20k Linien 31 → 6 ms / 63 → 7 ms; Kataster 150k 533 → 59 ms / 862 → 39 ms; Plan + WASM-Renderer nach Änderung katbig 90 →
    38 ms, Kataster 1,8 → 0,6 s. Erstes Öffnen 200 000 Zeichnungen (`doc_open`) 9,6 → 1,8 s, Speicher 953 → 840 MB.
    Nicht in der Tauri-App/im nativen Renderer angesehen.
    Behoben (29.10.): je nach Code-Layout brach der WASM-Kern mit „assertion failed: psize >= size + min_overhead“ (dlmalloc)
    ab, z. B. bei jedem Dach (`roof::compute_canonical`). Ursache: LTO bettete `GrowAhead::dealloc` samt std-dlmalloc
    (`validate_size` liest den Chunk-Kopf vor dem Zeiger) in Funktionen ein, die den Block selbst angelegt hatten; LLVM wertete den
    Lesezugriff ausserhalb der frischen Allokation als undefiniert und erzeugte eine bedingungslose Panik (im `wasm-objdump` sichtbar).
    Die Allokator-Hülle ist jetzt `#[inline(never)]`. Gefunden mit einem Kern, der nach einer harmlosen Änderung reproduzierbar kippte.
    ✅ (29.10.) **`generatePlan` ganz im Kern** ([K3a]/[K3d]/[K4]): `core/src/plan/extras.rs` rechnet Schattenstudie und Baurecht
    (unterste Gruppe; Verstösse zuoberst), Abzugskörper (aus Wand-/Stützen-/Decken-Poché, über dieselben flachen Funktionen wie
    vorher), Schwarz-Weiss und Strichstärken nach Massstab (beim Schreiben, `plan_buf::Writer::post`, auch für die kompakte
    Unterlage `drawingLines`) und das Ausmass samt Kontext. `planDomains` liefert 12 Gruppen; `generatePlan` reicht nur noch
    Sichtbarkeit, Optionen und den Zeitpunkt der Studie (`Date` in TS: Ortszeit wie bisher) weiter — der Plan bleibt immer lazy
    und aus Kern-Puffern (auch mit Mono/Abzugskörpern/Massstab: GPU-Chunks aus dem Puffer, Stücke wiederverwendet). Gelöscht:
    `generatePlan/{sunShadow,siteRules}.ts`, `lineWeightScale.ts`, `subtractVoidsInPlan`/`segmentOutside` (samt Bindung
    `voids_segment_outside_flat`), `toMono`, `computeBounds`, `realignRuns`. Gleichheit (temporärer Test, gelöscht): 481 000
    Primitive Feld für Feld (Zahlen per `Object.is`) samt Ausmass, Luftbildern, gedimmten Bereichen und Unterlage gegen die alte
    TS-Fassung: Beispielprojekt alle Ebenen × 180 Varianten (Detail, Mono, global, Massstab 1:20–1:500, Druck, kompakt, Sichtbarkeit/
    Dimmen zufällig, mit/ohne Studie und Strichstärken-Option), bigSample, 120 Zufallsprojekte mit Abzugskörpern, Stützen, Schatten
    (auch ungültige Zeitpunkte, LV95-Anker), Baurecht (Baulinien, Höhe, `show: false`), Kontext; Kataster 30 000 Zeichnungen;
    `generateVisibleLevelsPlan` stichprobenweise. CLI byte-gleich zum Stand vor beiden Schritten (96 Ausgaben: `plan` SVG 1:100/1:50,
    JSON 1:100/1:200, `dxf` 1:100/1:50 für 16 Projekte, davon 7 mit Schatten/Baurecht/Abzugskörpern/Strichstärken). Messung
    (CLI `bench`, unverändertes Projekt): 36 Häuser mit 40 Abzugskörpern, Studie und Baurecht 237 → 2,3 ms, Beispiel mit
    Abzugskörpern 9 → 0,4 ms. Nicht in der Tauri-App angesehen.
    Bleibt: `geometry/geomTransform.ts` (`mvGeom`/`scaleGeom`) in TS — die Werkzeuge (Verschieben/Drehen/Skalieren mit
    Vorschau je Mausschritt, Ausrichten, Block definieren, Griffe) bilden mit Funktionen ab, die zwar affin sind, aber je Element
    und Frame aufgerufen werden; über die Grenze müsste jede Zeichnungsform (18 Varianten) flach hin und zurück — das lohnt erst,
    wenn die Werkzeuge selbst im Kern laufen ([K4] S3). Der Kern hat seine Fassung für Blöcke (`plan/drawings.rs::mv_geom`).
    ✅ (29.10.) **3D-Reste im Kern** ([K3d]/[K4]): Umriss-Linien der 3D-Auswahl (`selectionHighlightLines`) rechnet
    `core/src/highlight3d.rs` (Abfrage `selectionHighlight`, f32-Linienliste; nur die gewählten Arten werden abgeleitet, vorher
    immer die ganze Pick-Geometrie samt Zeichnungs-Segmenten); Abzugskörper im 3D: welche Wände/Decken getroffen sind und ihre
    truck-Spezifikation (Bauteil − Körper) liefert `core/src/solid_specs.rs` mit `model3dParts` (4. Argument), TS (`voids3d.ts`)
    tesselliert nur noch asynchron über truck; `wallSpec`/`wallProfile` sind Fassaden über `wall_spec_flat`. Gelöscht: TS-
    `resolveHatch`/`resolveForeground`/`resolveBackground`/`resolveHatchId`/`resolveStrokeWeight`, `HATCH_INK`/`HATCH_PAPER`
    (tot, Kern `plan/style.rs`; Tests dorthin). Gleichheit (temporärer Test, gelöscht): 328 Hervorhebungen (Beispiel, bigSample,
    80 Zufallsprojekte, Zufallsauswahl inkl. Dächer/Kontext) Wert für Wert, 4805 Wand-Spezifikationen und 543 Abzugs-Schnitte
    gleich der alten TS-Fassung; CLI byte-gleich (`plan` SVG/JSON, `section`, `elevation`, `model3d` für 3 Projekte).
    Bleibt bewusst in TS: `cullPrimitives` (Auswahl der SVG-Overlay-Objekte, die React ohnehin als Objekte rendert),
    `planView/geometry.ts` (Ansichts-Transformationen), `GpuChunkCache`/Chunk-Grenzen (GPU-Ressourcen), `draftWorldLines`
    (Werkzeug-Vorschau aus dem UI-Zustand); `planPick`, `glPlanHatch`, `glPlanCompile`, `toRenderScene` sind schon Fassaden.
    Offen: STEP-Sammler (`exportStep.ts`) nutzt noch die TS-Helfer `voidPrisms`/`hittingVoids`/`subtractSpec`/`bbox`/
    `wallCorners` (`plan/voids.ts`) — auf die Kern-Spezifikationen umstellen, dann löschen. Nicht in der Tauri-App angesehen.
  - ✅ **S3 Änderungen kommen aus Rust**: Befehle (Zustandsautomaten, Werkzeuge) erzeugen Ops im Kern; Undo/Redo, Validierung
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
    **Zweite Etappe (28.10.): Aktionen erzeugen Ops direkt.** Op-Bauhelfer `core/opsBuild.ts` (`patchItem`, `patchItems`,
    `addItems`, `removeItems`, `setField`, `fieldOps` = Differenz nur über ein kleines Feld, `opsMutation` = Projekt → Projekt-
    Funktion mit mitgeführten Ops); Store `applyChange(ops | (p) => ops, coalesceKey?)`, `setProject` nimmt die Ops einer
    `opsMutation` ohne `diffToOps`. Umgestellt: alle Griffe (Wand/2D/Decke/Dach/Treppe/Raum, Kanten, Stempel), Objekt-Info der
    Store-Aktionen (update*, Farbe/Füllung/Vorder-/Hintergrund, Resize, Dicken, Polylinien-Punkte), Panel-Eigenschaften der
    2D-Elemente, Auswahl verschieben/kopieren/drehen/spiegeln/skalieren (`transformOps`), Löschen der Auswahl, Ebenen/
    Sichtbarkeit/Kategorien, Text-Tippen, Zeichenbefehle (Wand, Decke, Raum, Treppe, Öffnung, Dach, Stütze, Extrusion, alle
    2D-Zeichenbefehle, Bemassung, move/copy/mirror/rotate/scale/array; Gruppen-Zuordnung beim Zeichnen in einer Gruppe über
    `activeGroupOps`). Gruppen: Löschen (+ Schnittlinien) und aufgeschobene Griff-Commits = ein Schritt; `groupChanges(fn, key)`
    mit Schlüssel (Kern `begin_group_keyed`): ein Griff-Zug, der je Mausschritt mitgeführte Ecken bewegt, ist EIN Undo-Schritt
    (vorher mehrere je Mausschritt). Kern: Positions-Index für `replace`-Serien (`PosCache`), `commit` übernimmt die Ops (eine
    Kopie weniger); TS-`applyOps` kopiert jede Liste je Aufruf einmal, Index ab der zweiten Suche. Gleichheit: beim Umbau 2400
    Zufallsschritte gegen die alte setProject-Fassung und 400 Transformationen gegen das alte `commitTransform` (gleiches Projekt
    bis auf erzeugte ids und fehlend/leere Listen); bleibende Tests `applyChange.test.ts`, `opsBuild.test.ts`, `ops.apply.test.ts`.
    **Messung** (vitest/WASM, Linux-Container unter Last, 3000 Wände, `applyChange.perf.test.ts`): Griff ziehen 3,3 → 0,2–0,3 ms
    je Mausschritt, Auswahl (300 Wände) verschieben 30 → 5,5–7,5 ms, Eigenschaft tippen 2,3–3,8 → 0,03 ms; Undo/Redo 0,45 → 0,07 ms.
    Kern nativ: 300 `replace` auf 5000 Wände 11,2 → 1,5 ms. Rest beim Verschieben: JSON der 300 Wände (TS→Kern) und Kopien im Kern.
    **Dritte Etappe (28.10.): Rest der Aktionen auf Ops.** Umgestellt: Editier-Befehle trim/extend/fillet/chamfer/break/join/explode/
    align/autodim/defblock/georef/sectionline/solid/solidbool/voidbox/terrain/ceilingOpening und die Werkzeug-Commits in `tools/tools.ts`
    (alle `CommandResult.commit`/`ToolResult.commit` sind jetzt `opsMutation`); Einfügen (`pasteElementClipboard`), Gruppieren/
    Ungruppieren (`groupSelection`/`ungroup` liefern Ops); `usePanelHostBase.ts` (Stützen, Extrusionen, Kontext-Bild, Ausschnitte +
    Ordner, Layouts/Masterlayouts/Ordner), `useProjectActions.ts` (Wand-/Decken-/Dach-/Tür-/Fenster-/Treppentypen, Override-Regeln,
    Stil speichern), `App.tsx` (Split, 2D-Boolean, Segment schneiden, Stil übertragen, Sperren, Kategorien aus/isolieren,
    Nicht-drucken, Kollisions-Marken, Layout-Blatt, Einstellungen/Georeferenz, Schatten), `projectSlice.ts` (Bauteile, Schraffuren,
    Linien-/Text-Stile, Stifte/Stiftsätze mit `rebakePenOps`, Paletten), `siteSlice.ts`, Raumprogramm/Baurecht/Sonne-Panels
    (`roomProgramOps`, `addProgramSheetOps`, `setField`); 3D-Griffe mit mitgeführten Ecken: `Wasm3DViewport` fasst Element und
    mitgeführte Ecken je Maus-Schritt zur Gruppe mit Schlüssel (`onEditGroup` = `groupChanges`), ein Zug = ein Undo-Schritt.
    Neuer Helfer `replaceWithMany` (Elemente durch mehrere an derselben Stelle ersetzen: explode, Split). Die Projekt → Projekt-Fassungen
    der Befehle/Editoren sind gelöscht (`explodeDrawings`, `alignDrawings`, `applyDrawingStyle`, `setLocked*`, `rebakePenColors`,
    `applyClashMarkers` …); wo CLI/Tests sie brauchen, sind es dünne Hüllen um die Ops (`applyRoomProgram`, `addProgramSheet`).
    Gleichheit: beim Umbau je Befehl 300 Zufallsprojekte (trim … ceilingOpening, 8 Ausrichtungen), dazu Typ-CRUD, 46 Panel-Schritte und
    37 Ressourcen-/Stiftsatz-Schritte (inkl. Undo-Tiefe und Meldungen) gegen die alte setProject-Fassung (Stand vor dem Umbau): gleiches
    Projekt bis auf erzeugte ids. Bleibende Tests: `commands/cmds/editOps.test.ts`, `state/panelOps.test.ts`, `state/resourceOps.test.ts`,
    `replaceWithMany` in `core/opsBuild.test.ts` und die umgestellten Bestandstests (align, explode, matchProps, objectLock, penSets, clash,
    groupActions, elementClipboard). Nicht in der Tauri-App getestet (nur vitest/Linux + e2e im Browser).
    **`setProject(fn)` + `diffToOps` bleibt nur noch für:** Datei-Öffnen/Neu/Vorlage/Wiederherstellen (`useProjectFileActions`),
    Import (DXF-Layer/Linienstile in `runImport`, Bilder einfügen in `useImportHandling`, IFC-Bauteile in `App.tsx` `runIfcImport`),
    das Ressourcen-Fenster (Fremd-Synchronisation) und das CLI (`cli/main.ts`: ganze Dateien, Projekt → Projekt-Hilfen); dazu der
    Rückfall für Befehle ohne mitgeführte Ops in `App.tsx` (gibt es keine mehr; der Typ `commit: (p) => Project` erlaubt es noch).
    Offen: Undo-Verlauf als Liste in der UI [84]; `diffToOps` entfällt erst, wenn auch
    Laden/Import/CLI Ops liefern.
    **Vierte Etappe (29.10.): `diffToOps` gelöscht.** Laden, Import und CLI liefern Ops bzw. laden über den Kern:
    Öffnen/Vorlage/Wiederherstellen = Store `openProjectFile(text)` (Kern liest, migriert, lädt direkt ins Dokument,
    Verlauf leer, s. S4), Neu/Musterhaus = `loadProject(p)` (eine explizite Kern-Funktion „Projekt laden“,
    `doc_load_json`, keine Differenz). DXF/PDF-Import (`runImport`: Ebene, Kategorien, Linienstile, Zeichnungen,
    Kontext) als Ops in EINER Gruppe = ein Undo-Schritt (vorher bis zu fünf); Bilder einfügen (`imageDrawing2d` +
    `addItems`); IFC-Bauteile (`ifcElementsToProject` liefert `ops` + `project`, App `applyChange`); CLI-Importe
    (`fieldOps`/`addItems`/`contextOps`). Das Ressourcen-Fenster ruft nur die echten Handler (schon Ops), sein Projekt
    ist eine Leseansicht. `setProject` nimmt nur noch `opsMutation` (Typ `ProjectMutation`), `CommandResult.commit`/
    `ToolResult.commit`/`EngineHost.commit` ebenso; Rückfall `addNewElementsToActiveGroup` und `isOpsMutation`
    gelöscht. Das gemeinsame Abfrage-Dokument (`documentFor` für fremde Projekte, CLI) folgt feldweise
    (`fieldOps` je geänderter Referenz, kein Verlauf); Änderungen vorbei an den Ops laden das Store-Dokument neu
    (`load`, Verlauf leer). Tests erzeugen Zufallsänderungen über `core/projectDiff.testutil.ts` (nur Tests).
    e2e: Öffnen leert den Verlauf, DXF-Import = ein Undo-Schritt. Nicht in der Tauri-App geprüft (natives Öffnen mit
    Sperre, Ressourcen-Fenster).
    **Gruppen-Logik im Kern (29.10.):** `groups.rs` (transitive Mitgliedschaft mit Zyklenschutz, sichtbare Gruppe
    im Isolations-Kontext, Auswahl um Gruppen erweitern; Abfragen `groupMembership`/`containingGroup`/
    `expandToGroups`), Fassade `model/groups.ts` (letzte Mitgliedschaft gemerkt: Rahmen-Filter fragt je Element).
    TS-Rechnung gelöscht (`transitiveMembership`, `topLevelGroups`, `containingGroupId`, `isInsideActiveGroup`,
    `expandToGroups`); in `state/groupActions.ts` bleiben die Op-Bauer (`groupSelection`, `ungroup`,
    `activeGroupOps`), das Dimmen der Plan-Primitive und `mergeMembership` für Auswahl-Mengen. Gleichheit (einmalig):
    400 Zufallsprojekte × 10 Abfragen (Zyklen, doppelte Gruppen-ids, fehlende Gruppen, Pfade mit unbekannter
    Gruppe), 16000 Vergleiche gleich der alten TS-Fassung.
    **Ebenen- und Geschoss-Logik im Kern (29.10.):** `layers.rs` (Kategorien-Baum: abflachen, suchen, sichtbare Codes,
    umschalten, Sichtbarkeit nach Codes, ändern, Unterkategorie, Duplikat, löschen, `nextFreeCode`, Isolieren/Ausblenden der
    Auswahl, Import-Kategorien `planImportCategories`, Kategorie-Codes der Auswahl über die Abfrage `selectionCategoryCodes`),
    `levels.rs` (`recomputeFloorElevations`); Rechnung auf `serde_json::Value` (verlustfrei), zustandslose Bindungen
    `layers_call`/`levels_recompute_elevations` (`web/layers.rs`), TS-Fassade `model/layers.ts` (abgeflachter Baum je Baum-Array
    gemerkt: `getLayerCategory` je Bauteil bleibt billig). `model/types.ts` re-exportiert die alten Namen; die TS-Rechnung in
    `types.ts`, `projectSlice.ts` (Baum-Helfer), `selectionLayers.ts`, `selectionInfo.ts`, `dxfToDrawings.ts`,
    `contextCategories.ts` ist gelöscht. `sampleProject` trägt die gestapelten Höhen ausgeschrieben (das Modul wird vor dem
    Laden des Kerns ausgewertet; Test dagegen). Gleichheit (einmalig, Test gelöscht): 4000 Zufallsbäume (doppelte Codes,
    nichtnumerische/negative Codes, fehlende Kinder) × 14 Rechnungen, 3000 Geschoss-Listen, 1500 Import-Pläne,
    600 Auswahl-Abfragen gleich der alten TS-Fassung. Einzige Abweichung, gewollt: Das Duplikat einer Unterkategorie
    (`insertAfterCode`) ging in TS verloren (die Ebene mit dem Ziel wurde übersprungen), jetzt steht es hinter dem Original.
    Offen: vertikale Ausdehnungen (`model/wall.ts`: `wallVerticalExtent` …, Kern hat `model/helpers.rs` schon — Aufrufer in
    `toSection`/`voids`/`geometry/opening`/Viewport fallen mit dem Plan-Port bzw. brauchen eine Abfrage je Bauteil),
    Undo-Verlauf als Liste in der UI [84].
    **Stiftsätze im Kern (29.10.):** `pens.rs` (Standardpalette mit 255 Stiften, Freie-Farbe-Palette, `hsl_to_hex`, Neu-Backen
    der Stift-Farben/-Strichstärken `rebake_ops`, Standardsatz anlegen `seed_standard_ops`, Stift löschen samt Verweisen in
    Bauteilen und im Kategorien-Baum `delete_pen_ops`). Rechnung auf der rohen Projekt-Wurzel (`serde_json`, verlustfrei) und
    Ergebnis als Ops; neu: Wurzel-Abfragen (`queries::run_root`, `doc_query_root`, TS `ProjectDocument.queryRoot`) neben den
    typisierten Abfragen. `model/penSets.ts` ist Fassade (Lese-Auflösung `resolvePenColor/Weight` einzeln je Swatch bleibt in TS,
    `freeColorPalette()` statt Modul-Konstante, weil der Kern erst nach `initCore()` lesbar ist); `deletePen` in
    `projectSlice` ruft `deletePenOps`. Gleichheit (einmalig, Test gelöscht): 4000 Zufallsprojekte Neu-Backen, 1500 Standardsatz,
    3000 Stift-löschen (doppelte/fehlende Stift-ids, `constructor`/`__proto__` als Stift-id, fehlende Listen, verschachtelte
    Kategorien), 20000 `hslToHex` — Ergebnis nach `applyOps` zeichengleich (auch Schlüsselreihenfolge). Abweichungen
    (gewollt): Ebenen werden nur noch geschrieben, wenn sich etwas ändert (vorher immer ein `setField layers`), die Stifte
    des Standardsatzes als ein `setField` statt Listen-Differenz (gleiches Ergebnis), unveränderte Ebenen-Kategorien
    behalten nach dem Neu-Backen nicht mehr ihre Objekt-Identität.
    **Layout-Blätter und Ordner-Bäume im Kern (29.10.):** `folder_tree.rs` (eine Rechnung für Layouts-, Master- und
    Ausschnitte-Baum, vorher doppelt in `layoutModel.ts` und `state/viewSnapshotFolders.ts`: Baum aufbauen, Blätter eines
    Ordners in Baum-Reihenfolge, Nachfahren-Test, Ordner löschen mit Hochziehen), `layout_model.rs` (Blattgrössen ISO 216 mit
    freier Grösse, Seitenplanung Ordner-PDF, Titelblock mit Master-Vererbung, `js_trim` wie JS-`trim`); zustandslose Bindung
    `layout_call` (`web/layout_model.rs`) plus Wurzel-Abfragen `folderPdfPages`/`layoutTitleBlock`. Der Kern rechnet auf Indizes
    der Eingabelisten, TS (`model/folderTree.ts`, `layoutModel.ts`, `viewSnapshotFolders.ts`) setzt die Knoten aus den
    Original-Objekten zusammen (Identität bleibt). In TS bleiben Fabriken, Viewport-/Annotations-CRUD, `moveLayoutToFolder`,
    `moveFolderToFolder` (nur das Verschieben, der Zyklentest kommt aus dem Kern), `findMaster`/`findSnapshot`/
    `resolveViewportScale`/`visibleCodesFromSnapshot` (Einzeiler-Nachschlagen) und die Format-Listen der Dropdowns.
    Gleichheit (einmalig, Test gelöscht): 6000 Zufallsfälle Baum (doppelte Ordner-ids, Kreise, verwaiste Verweise, leere
    Eltern) für alle drei Bäume, 6000 Ordner-Blätter, 8000 Löschen/Nachfahren/Verschieben (je Layout, Master, Ausschnitt),
    3000 Blattgrössen, 6000 Titelblöcke (Unicode-Leerraum, Massstäbe 0/1e21/1e-7, doppelte Layout-ids), 4000 Ordner-PDF-Seiten.
    Abweichung (gewollt): kaputte `parentId`-Ketten (Kreis, Selbstverweis) in `collectFolderLayouts` enden jetzt (TS: Stapelüberlauf).
    **Parametrische Wände im Kern (29.10.):** `parametric_walls.rs` (Raster-, Modul-, bedingte-Dicke-, Referenzlinien- und
    Sequenz-Regel, Duplikat-Entfernung, `exterior`/`interior`/`bearing`) auf `serde_json::Value` (vorhandene Wände behalten
    unbekannte Felder), `Math.round/min/max/atan2` über `jsnum`; zustandslose Bindung `parametric_call`
    (`web/parametric_walls.rs`), `model/parametricWalls.ts` ist Fassade mit gleichen Signaturen und hält nur den Zähler der
    Wand-ids. Die App ruft die Engine noch nirgends auf (nur Tests): die Regel-UI fehlt weiterhin. Gleichheit (einmalig, Test
    gelöscht): 3000 Zufallsregelwerke (verschachtelte Sequenzen, Raster mit/ohne gridId, Grenzpolygone mit 1–5 Punkten, Referenzwand
    vorhanden/fehlend, fehlende/negative/0-Abstände, Toleranz 0/0,01/0,5) und 4000 Einzel-Regeln/Bedingungen/Duplikat-Listen,
    Wand-ids samt Zähler gleich, Ergebnis zeichengleich bis auf die Schlüsselreihenfolge von Wänden mit `wallTypeId: undefined`.
    Abweichung (gewollt): Achsen je Aufruf auf 1 000 000 begrenzt (TS rechnete bei absurd kleinem Abstand endlos).
    **Projekt-Verschiebung und Auswahl-Export im Kern (29.10.):** `geo_translate.rs` (`translateProject`/`translateOps` aus
    `model/geoRebase.ts`: Translation aller Modell-Koordinaten inkl. Kontext, Zeichnungen, Geo-Anker; Befehl „Neuer
    Bezugspunkt“, `projectToWorldCoords` für DXF/IFC-Welt-Koordinaten) und `selection_filter.rs` (`filterProjectToSelection`
    aus `state/exportScope.ts`: Export „nur Auswahl“), beide als Wurzel-Abfragen (`translatePatch`/`translateOps`/
    `selectionFilterPatch`); die Fassaden setzen `{...project, ...patch}` zusammen, `projectGeoOrigin` (Einzeiler) bleibt in TS.
    Gleichheit (einmalig, Test gelöscht): 3000 Zufallsprojekte mit allen Elementarten, allen 18 Zeichnungs-Formen, Kontext
    (Mesh/Terrain/Bild/Konturen mit Bogen), Geo-Anker, Verschiebung (0,0) — Projekt, Ops und Welt-Koordinaten
    zeichengleich; 5000 Auswahl-Filter (doppelte ids, fehlende Listen). Abweichung (gewollt): eine nicht endliche
    Verschiebung (NaN/±Infinity) ändert nichts (TS erzeugte NaN-Koordinaten, die der Validator zurückrollte).
    **Z-Anordnen im Kern (29.10.):** `reorder.rs` (front/back/forward/backward für `drawings2d` und `drawingLevels`, vorher
    zweimal kopiert in `projectSlice.ts`), Bindung `reorder_call`, Fassade `model/reorder.ts` (`reorderByIds`, Objekt-Identität
    bleibt); 10000 Zufallsfälle gleich der alten Fassung (einmalig, Test gelöscht).
    **Übrig in TS (Stand 29.10., bewusst nicht portiert):** (1) Lese-Auflösungen je Render/Klick (`resolvePenColor/Weight`,
    `isLocked`, `findMaster/findSnapshot`, `projectGeoOrigin`, `visibleCodesFromSnapshot`, `moveLayoutToFolder`/Viewport-/
    Annotations-CRUD, Fabriken) — Einzeiler, ein Kern-Aufruf je Zugriff wäre teurer als die Rechnung; (2) Op-Bauer mit
    `t()`/`Date.now()` (`setWallThickness`, `setCeilingThickness`, `addPenSet`, Layout-/Ordner-Anlage); (3) Griff-/Resize-Geometrie
    in `projectSlice.ts` (`moveGrip`, `resizeGeom`, `drawingVertices`, `moveEdge` …, ~800 Zeilen) und `state/edgeGrips.ts` —
    gehört zu „Befehle/Griffe im Kern“; (4) `selectionInfo.ts` (`deriveSelection`, 1350 Zeilen Objekt-Info für die Panels);
    (5) `model/wall.ts` (vertikale Ausdehnungen, Aufrufer in `toSection`/`voids`/Viewport — fallen mit dem Plan-Port);
    (6) `model/geometry.ts` (`wallBand`/`wallCorners`/`clippedBand`, Aufrufer in Werkzeugen/Fang), `model/color.ts`
    (Farbraum-Umrechnung der UI), `state/viewSnapshots.ts`/`visibilitySets.ts` (UI-Zustand, localStorage).
    **Griffe im Kern (29.10.)** — erledigt damit (3) und aus (2) die Dicken: `grips.rs` (vorher ~800 Zeilen in `projectSlice.ts`
    und `state/edgeGrips.ts`): Eckpunkt-Griff (`moveGrip`: Wand, alle 2D-Formen inkl. Bogen-Mitten-Griff der Polylinie,
    Masslinien-Offset und Masszahl mit Einrasten, Textpfad/Hinweislinie/Spaltenbreite, Kreis↔Ellipse), Verschieben, Kante
    winkeltreu (`movePolygonEdge`), Grösse um einen Anker (`resizeGeom`), Decke/Dach/Treppe/Raum (Griff, Verschieben, Kante,
    Stempel), Polylinien-Punkt einfügen/löschen, Dicke einschichtiger Wände/Decken (id und Name eines neuen Typs gibt die
    Hülle mit: `Date.now()`, `t()`). Rechnung auf der rohen Wurzel (unbekannte Felder, Schlüsselreihenfolge bleiben). Die
    Store-Aktionen behalten ihre Signatur; je Mausschritt EIN Kern-Aufruf `doc_grip_commit` (rechnen, prüfen, Verlauf —
    `ProjectDocument.commitGrip`), TS führt die Leseansicht mit den gelieferten Ops nach (NaN-Marken werden wieder Zahlen,
    `fromMarkedJson`); die Wurzel-Abfrage `gripOps` rechnet ohne Anwenden. Griff-Listen (`drawingVertices`, `ringEdges`/
    `openEdges`/`polylineEdgeGrips`) über die Fassade `geometry/grips.ts` (Polylinie als flacher Puffer, sonst Element-JSON);
    die Rahmen-Ecken einer Textspalte bleiben in TS (Schrift-Metrik, `textFrameCorners`). Gelöscht: die TS-Rechnung,
    `state/edgeGrips.ts`, `dimTextFrame`/`dimTextPos`/`dimTextOffsetFromPoint`/`mmToModel`/`modelToMm` (`model/dimension.ts` hält
    nur noch die Konstanten) und die Bindung `dim_text_frame`. Gleichheit (einmalig, Test gelöscht): 790 000 Zufalls-Änderungen
    über 15 000 Projekte (alle Formen, entartete Geometrie, NaN/±∞ in den Eingaben, Bögen, LV95) — Ops zeichengleich zur alten
    Fassung; 19 800 Griff-Listen samt Kanten-Griffen bitgleich; 11 000 Store-Schritte (Leseansicht, Undo-Tiefe, Kern ==
    Leseansicht). Abweichungen (gewollt): ein Griff-Index ohne Punkt (negativ, gebrochen, zu gross) ändert nichts (TS warf beim
    Lesen von `undefined`, 38 000 der Zufallsfälle); gerechnet wird auf dem Dokument — ein dort als `null` gespeichertes NaN
    rechnet wie `null` in JS (0) und kommt als `null` in die Leseansicht (vorher blieb dort NaN); Griff-Listen liefern −0 als 0.
    Messung (vitest, Store, 3000 Wände + 2000 Polylinien, alt/neu abwechselnd, kleinster Wert aus drei Läufen, Container unter
    Last; Stand nach dem Nachtrag unten): Wand-Griff an Position 10/1500/2990 32/150/315 µs → 28/116/262 µs (dominiert von der
    linearen id-Suche), Polylinien-Griff 78 → 58 µs, Polylinien-Kante 72 → 57 µs, Wand verschieben 131 → 115 µs, Griff an einer
    5000-Punkte-Polylinie 13,7 → 9,1 ms; Griff-Liste der 5000-Punkte-Polylinie 2,7 → 1,1 ms (kleine Polylinie 2 µs, gleich).
    Nicht in der Tauri-App geprüft (vitest/Linux, e2e im Browser). ~~Offen: `setPolylineVertexType`
    (rechnet in `geometry/polylineVertexType.ts`), die lineare id-Suche je Mausschritt (im Kern beim Rechnen und beim Commit,
    in TS in `applyOps`) und der Commit grosser Polylinien (~9 ms bei 5000 Punkten: Verlauf/Prüfung in `document.rs`/`ops.rs`).~~ Erledigt 29.10., s. „Leistung nach der Zusammenführung“.
    **Objekt-Info im Kern (29.10.)** — erledigt damit (4): `selection_info.rs` (vorher `deriveSelection` in `state/selectionInfo.ts`,
    ~800 Zeilen Rechnung) liefert als Wurzel-Abfrage `selectionInfo` den Kontrakt `Selection` für das erste gewählte Element
    (Vorrang wie bisher): effektive Farbe/Strichstärke/Schraffur/Vorder-/Hintergrund (Element → Linienstil → Ebene → Bauteil),
    bbox, Wand (Referenzlinie, Fugen der Schichten, Typ-Liste mit `wallTypeLabel`, Geschosse, Geschoss darüber, UK/OK, Länge,
    Brutto-/Öffnungs-/Nettovolumen), Decke (Typ, Fläche, Volumen, Aussparungen), Dach (Firsthöhe aus `roof.rs`, Kantenliste
    `roofEdgeList`, Höfe), Öffnung (Lücke `opening_geom`, UK/OK), Treppe (`stair.rs`), Raum, Extrusion, Stütze, Kontext-Objekt
    (LV95-Mitte), Detailverweis; `geomBBox` (auch für Ausrichten/Verteilen: Abfrage `drawingBBoxes`, `editors/align.ts`). Rechnung
    auf der rohen Wurzel (verlustfrei, Schlüsselreihenfolge wie die früheren Objekt-Literale, keine typisierte Sicht des ganzen
    Projekts); nur Dach/Treppe/Stütze werden für die schon typisierte Geometrie einzeln gelesen. Die Antwort wird direkt als Text
    geschrieben; Felder kleiner Objekte linear gesucht statt über den SipHash der `IndexMap` (`grips::field`, auch in den Griffen);
    die Fassade gibt die Lage des Elements aus der Leseansicht mit (spart dem Kern die lineare Suche). `state/selectionInfo.ts`
    hält den Kontrakt (Typen) und die Fassade; die B-Rep-Beschreibung einer Extrusion (`spec`, truck) setzt sie aus
    `extrudedSolidSpec`. `js_fmt::to_fixed` hat einen Schnellweg (nur exakte Halbwerte gehen den langen, genauen Weg; Test
    gegen den genauen Weg über 1,6 Mio. Werte). Gelöscht: die TS-Rechnung, `geomBBox`. Gleichheit (einmalig, Test gelöscht):
    174 360 Auswahlen über 10 000 Zufallsprojekte (alle Bauteilarten, fehlende/null-Felder, Bindungen UK/OK, unbekannte
    Typen/Bauteile, LV95, mehrere Arten gleichzeitig) zeichengleich zur alten Fassung (JSON mit NaN-Marken), 20 489 Fälle mit
    derselben Fehlermeldung; Beispielprojekt alle Elemente; 24 000 Ausrichten/Verteilen-Fälle gleich. Abweichung (gewollt): ein
    Element, das das Kern-Modell nicht lesen kann (Dach/Treppe/Stütze mit kaputten Pflichtfeldern), ergibt `null` mit Warnung
    statt eines Werts. Messung (vitest, Store mit 3000 Wänden und 20 000 Zeichnungen, Container unter Last): Wand 36–67 →
    96–138 µs, Zeichnung (Position 10 000) 150–300 → 160–390 µs, Dach 5 → 30–60 µs (TS merkte sich die Dachgeometrie je
    Objekt; im Kern ist sie für die letzten 16 Dächer gemerkt, der Rest ist die JSON-Übergabe), Griff-Schritt samt Objekt-Info
    1,6–2,6 ms → 1,5–2,4 ms; je Darstellung also ~0,05 ms mehr. Nicht in der Tauri-App geprüft.
    **Höhen und Wand-Bänder (29.10.)** — zu (5)/(6): die 3D-Griffe (`Wasm3DViewport`: Griff-Lagen, Arbeitsebene beim Ziehen)
    holen UK/OK von Wänden und Decken über die Wurzel-Abfrage `verticalExtents` (`selection_info.rs`, dieselbe Rechnung wie die
    Objekt-Info; Fassade `verticalExtents` in `geometry/grips.ts`, ganze Elemente, auch gerade gezogene Fassungen). Gleichheit
    (einmalig, Test gelöscht): 480 000 Höhen über 20 000 Zufallsfälle (Bindungen UK/OK, fehlende Geschosse/Typen, NaN/±∞/null
    in den Elementen) gleich `wallVerticalExtent`/`ceilingVerticalExtent` (−0 kommt als 0). Gelöscht, weil ohne Aufrufer:
    `lineIntersect`/`clippedBand`/`Line`/`wallBand` (`model/geometry.ts`, `wallCorners` rechnet das Band selbst),
    `stairVerticalExtent`/`nextFloorAbove` (`model/wall.ts`), `openingGapQuad`, `roofBBox`, `stairBBox` samt Bindung
    `stair_bbox_flat`, `outlineBBox`, `localToLv95`, `roofEdgeList` (Kantenliste nur noch im Kern; Test über `deriveSelection`;
    `setRoofEdge` zählt die Kanten direkt). Bleibt in TS: `wallVerticalExtent`/`ceilingVerticalExtent`/`columnVerticalExtent`/
    `openingVerticalExtent` nur noch für die Plan-Ableitung (`toSection`, `voids`, `sectionOpenings`, `toElevation` — fallen mit
    deren Port; im Kern gibt es die Regeln doppelt: roh in `selection_info.rs`, typisiert in `model/helpers.rs`, beim Plan-Port
    zusammenlegen); `wallCorners` (Plan-Treffer `planHitTest`, Werkzeug-Vorschau, Griff-Vorschau, `voids`, STEP-Export — ein
    Kern-Aufruf je Wand wäre teurer als die vier Punkte) und `wallReferenceOffset` (Fang, `geometry/opening.ts`). Nicht in
    der Tauri-App geprüft (3D-Griffe nur über e2e im Browser).
    **Befehle im Kern (29.10.)** — Transformation und 2D-Editier-Befehle: `commands.rs` (Anfrage `{cmd, …}` →
    Ops; Wurzel-Abfrage `cmdOps`, `doc_cmd_commit` rechnet UND wendet in einem Kern-Aufruf an, `doc_cmd_query` für
    Treffer/Vorschau zwischen den Schritten), `cmd_transform.rs` (Verschieben/Drehen/Spiegeln/Skalieren mit
    Kopie/Reihe/Verteilen für alle Elementarten inkl. B-Rep-Körper, Ausrichten/Verteilen, Block definieren,
    Vorschau-Formen je Mausschritt `doc_cmd_preview` inkl. Zeichnungs-Primitive und Text-Rahmen),
    `cmd_edit.rs` (Trim, Extend, Verrunden, Fasen, Bruch, Offset, Join, Auflösen: Treffer, Vorschau, Ops). Die
    Abbildung reist als affine Beschreibung (`Xf`: Verschiebung/Drehung/Skalierung/Spiegelung — keine allgemeine
    Matrix, weil sonst die Rechenreihenfolge und damit die Bits nicht mehr der TS-Fassung entsprächen). TS:
    Zustandsautomaten bleiben, `cmdMutation(req)` (`core/document.ts`) trägt die Anfrage; `setProject` wendet sie
    über `commitCmd` direkt im Kern an. Neue ids `prefix-Zeit-Zähler-k` (`uniqueStamp`). Gelöscht:
    `geometry/geomTransform.ts` (`mvGeom`/`scaleGeom`/`scaleFactor`/`reversesOrientation`),
    `tools/drawingPreview.ts`, `transformSolid`, die TS-Rechnung in `tools/transform.ts`, `editors/align.ts`,
    `editors/explode.ts`, `defblock`, `trim`/`extend`/`fillet`/`chamfer`/`break`/`offset`/`join`,
    `joinDrawings`, die nicht mehr benutzten Kernel-Fassaden (`trimPolyline(WithBulge)`, `extend(Bulge)Segment`,
    `chamferCorner`, `breakCurve`, `nearestOnPolyline`, `offsetPolyline(WithBulge)`, `joinChainsWithBulge`) samt
    Bindungen und TS-Tests (die Rust-Tests in `kernel2d` und die Befehls-Tests decken sie). Gleichheit (temporäre
    Tests, gelöscht): 2400 Transformationen über 600 Zufallsprojekte (alle Bauteilarten, 18 Zeichnungs-Formen,
    Sperren, Dächer bei Drehen/Spiegeln, B-Rep, NaN-Punkte, LV95) — Ops zeichengleich (bis auf ids), 219 000
    Vorschau-Formen bitgleich, Griff-Vorschauen; 4500 Ausrichten/Verteilen/Block; Editier-Befehle über 500
    Zufallsprojekte mit denselben Eingabe-Folgen (Entwürfe je Mausschritt und Commits bitgleich): 2213 Trim,
    1460 Extend, 219 Verrunden, 227 Fasen, 605 Bruch, 1241 Offset, 423 Join, 486 Auflösen. Messung (vitest/WASM
    `--no-opt`, Container unter starker Last, Werte schwanken ±50 %): Vorschau 300 Zeichnungen verschieben
    22 → 6 ms, drehen 22 → 8 ms; 300 Wände 0,4–0,9 → 0,5 ms (gleich); Store „300 Wände verschieben“ 8,5 → 10,9 ms
    (Minimum, im Rauschen; die Kosten liegen beim Klonen der JSON-Elemente im Kern statt beim JSON-Lesen).
    Abweichung (gewollt): Griff-Vorschau „Element verschieben“ zeigt bei Formen ohne Primitive die einfachen
    Ersatz-Formen wie die Transformations-Vorschau. Nicht in der Tauri-App geprüft.
    **Offen (S3, Befehle):** ~~Zeichenbefehle (Wand, Decke, Raum, Treppe, Öffnung, Dach, Stütze, Extrusion, alle
    2D-Formen, Bemassung, autodim, sectionline, solid/solidbool/voidbox/terrain, ceilingOpening) und die
    Werkzeug-Commits in `tools/tools.ts` bauen ihre Elemente noch in TS (meist ein Objekt-Literal aus den
    Klickpunkten)~~ (erledigt 29.10., s. unten); Einfügen (`pasteElementClipboard`), ~~Gruppen-Zuordnung
    (`activeGroupOps`)~~; Split/Segment
    löschen (`editors/splitJoin.ts`, App) — dort ersetzt `cutSegment` per `replace` mit NEUER id (hängt an statt
    zu ersetzen; beim Port prüfen); Fang-Kandidaten aus dem Modell (`tools/snapping.ts`: `baseSegments`,
    Kreise, Raum-Anker; Nahmodus ab 2000 Zeichnungen) → `snap.rs`.
    ✅ (29.10.) **Einfügen im Kern** ([K4] S3): `cmd_paste.rs` (`{cmd: "paste", clip, levelId, stamp}`): Klone mit neuen
    ids `prefix-stamp-k` auf dem aktiven Geschoss, an denselben Koordinaten; Öffnungen an die mitkopierte Wirtswand
    umgehängt (ohne sie weggelassen); Rechnung auf rohem JSON (unbekannte Felder, Schlüsselreihenfolge bleiben). Die
    Zwischenablage (Sammeln, Text-Format, Speicher) bleibt in TS; `pasteElementClipboard(project, clip, level)` ist
    Fassade (neue ids für die Nachauswahl aus den `add`-Ops), die Tastatur ruft sie in `applyChange((p) => …)`.
    Gleichheit (einmalig, Test gelöscht): 400 Zufallsprojekte × Zufallsauswahl, Ops gleich bis auf die ids (Verweise
    Öffnung → Wand konsistent). Offen (gab es auch vorher nicht): Versatz beim wiederholten Einfügen, Gruppen
    mitkopieren, Einfügen in die aktive Gruppe (`activeGroupOps`). Nicht in der Tauri-App geprüft.
    ✅ (29.10.) **Split / Segment löschen im Kern** ([K4] S3): `cmd_split.rs` (`{cmd: "split", ids, stamp}`,
    `{cmd: "cutSegment", id, at}`), vorher `editors/splitJoin.ts` + `App.tsx`. Split wie bisher (Schnittpunkte mit den
    übrigen Zeichnungen des Geschosses, sonst Mitte; Stücke an der Stelle des Originals, Stil geerbt); Segment löschen
    sucht die nächste Kante (Bögen gegen die Kurve) und entfernt sie im Kern. **Fehler behoben:** `cutSegment` gab ein
    Element mit NEUER id als `replace` zurück — das traf nichts, der Kern hängte es an und das Original blieb stehen
    (Alt+Klick verdoppelte die Zeichnung statt sie zu kürzen; Test zuerst rot: 2 statt 1 Element). Jetzt behält das
    Element id und alle Attribute (Gruppen, Sperre, Deckkraft …), nur `geom` ist neu; Füllung/Schraffur fallen wie
    vorher weg (Ergebnis offen). `splitJoin.ts` ist Fassade (`splitOps`, `cutSegmentOps`); `toPolyForm` lebt nur noch
    in `booleanOps.ts`. Gelöscht: TS-Rechnung (`splitDrawing`, `cutSegment`, `nearestEdgeIndex`, `fromPolyForm` …),
    Fassaden `splitAtIntersections`/`splitClosedByChord`/`splitPolylineAtParam`/`removeSegment(WithBulge)` samt
    Bindungen `k2_*`. Gleichheit (einmalig, Test gelöscht): 2808 Split-Fälle über 3000 Zufallszeichnungs-Sätze (Linie,
    Polylinie offen/geschlossen/ohne `closed`/mit Bögen, Rechteck, Kreis, Text; zwei Geschosse) Ops gleich bis auf die
    ids; 9000 Segment-Löschen (3047 mit Löschen) gleiche Geometrie bzw. gleiche Ops, Element = Original mit neuer
    Geometrie. Nicht in der Tauri-App geprüft.
    ✅ (29.10.) **Raumprogramm-Import im Kern** ([61]/[K4]): `fileio/src/sheet_map.rs` (Kopfzeile, Spalten-Vorschlag de/en/fr,
    Zeilen → Programmzeilen, Summen-/Zwischentitel, Flächenart, Zellentext), Bindungen in `web_sheet.rs`; `io/roomProgramImport.ts`
    nur noch Fassade (JSON, Signaturen gleich) + `roomProgramOps`. Gleichheit (einmalig, Test gelöscht): 400 Zufallstabellen alt/neu
    gleich. Bekannte Abweichung: Akzente über feste Tabelle statt Unicode-NFD (exotische Zeichen).
    ✅ (29.10.) **Flächen-Nachweis-Ausgabe im Kern** ([70]/[K4]): `core/src/area_report.rs` (CSV schreiben/lesen, Seitenaufteilung
    in Papier-mm, SVG; Bericht reist als JSON, Zahlen über `js_fmt`), Bindungen `web/area_report.rs`; `export/areaReport.ts`
    behält Aufbau mit `t()` und jsPDF-Zeichnen (`buildAreaReportPdf`), der Rest ist Fassade mit gleichen Signaturen
    (`cellText` gelöscht). Gleichheit (einmalig, Test gelöscht): 300 Zufallsberichte × Trenner × Seitenformate alt/neu
    gleich (CSV byteweise, Rückleser, Seiten, SVG; Layout bis auf `bold:false`/`align:"left"` statt fehlend).
    ✅ (29.10.) **Rich-Text-Bearbeitung im Kern** ([K4]): `core/src/rich_text.rs` (Marks setzen/umschalten, `isMarkActive`,
    `commonMarkValue`, Normalisieren, stabile Serialisierung, Stile anwenden; Offsets in UTF-16 wie TS), Bindungen
    `web/rich_text.rs`; `text/richText.ts` behält Konstruktoren/Reintext/`DEFAULT_PRESETS` und ist sonst Fassade mit gleichen
    Signaturen (gelöscht: `mapRunsInRange`, `marksEqual`, `normalizeMarks`, kein Aufrufer). Gleichheit (einmalig,
    Test gelöscht): 500 Zufallsdokumente × alle Operationen alt/neu gleich. Abweichung: Bereich mitten in einem Surrogatpaar
    ergibt U+FFFD (im Editor nicht erreichbar). Nicht in der Tauri-App geprüft.
    ✅ (29.10.) **Gebäude-Mesh-Aufbereitung im Kern** ([K4]): `core/src/geo_mesh.rs` (Zuschnitt auf Bounding-Box, Zerlegen in
    zusammenhängende Gebäude per Verschweissen + Union-Find, Dachüberstand-Untersichten entfernen), Bindungen
    `web/geo_mesh.rs` (flache Puffer); `io/swissBuildings3d.ts` behält Abrufe (STAC/`netFetch`), Verschieben um die Origin und
    `concatMeshes` (reine Kopier-/Versatz-Schleifen) sowie die Metadaten (Id, Name, Ebene). Gleichheit (einmalig, Test
    gelöscht): 400 Zufallsmeshes (mehrere Gebäude, geteilte Ecken, Rest-Dreieck) × Zuschnitt/Soffiten/3 Verschweiss-Toleranzen
    alt/neu gleich. Offen: Netz-Abrufe bleiben TS (`netFetch`). Nicht an echten Kacheln geprüft.
    ✅ (29.10.) **Footprint-Extrusion im Kern** ([K4]): `geo_mesh::extrude_rings` (Ring säubern, Wände, Deckel/Boden über
    Delaunay mit Schwerpunkt-Filter, Fächer als Rückfall; vorher `extrudeRing`/`triangulateRing`/`pointInRing` in
    `io/geoContext.ts`), Bindung `geo_extrude_footprints`; `buildingsToMesh` bleibt als Fassade (Höhe/Name/Id), die
    Kontextobjekt-Erzeugung (`featuresToContextObjects`) bleibt TS (Modellobjekte mit Ids und Beschriftung). Gleichheit
    (einmalig, Test gelöscht): 400 Zufallsfolgen von Footprints (Kreis, Stern, unregelmässig, geschlossen, entartet, offen,
    Höhen inkl. ungültig) Positionen und Indizes identisch.
    ✅ (29.10.) **STEP-Export liest die Kern-Spezifikationen** ([K4]): `export/exportStep.ts` holt Wände/Decken samt
    „Bauteil − Abzugskörper" aus `model3dParts` (`solid_specs.rs`); gelöscht: `voidPrisms`, `hittingVoids`, `subtractSpec`,
    `bbox`, `wallCorners`, `isVoidSolid`, `solidBaseZ` aus `plan/voids.ts`. Gleichheit (einmalig, Test gelöscht): Spezifikationen
    des Beispielprojekts und von 6 Projekten mit Abzugskörper JSON-gleich alt/neu.
    ✅ (29.10.) **Fang-Kandidaten aus dem Modell im Kern** ([K4] S3/[K3d]): `snap_model.rs` sammelt je Dokument-Stand,
    Geschoss und sichtbaren Ebenen (vorher `baseSegments`/`collectCircles`/`roomAnchors`/`ellipseCenters` in
    `tools/snapping.ts`): Wandachsen + Schichtgrenzen, Raum-/Decken- (mit Aussparungen)/Dach-/Treppen-/Stützen-Umrisse,
    2D-Zeichnungen (Konstruktionslinie/Strahl verlängert, Bezier/Spline tesselliert), Kreise/Bögen (Zeichnungen, runde
    Stützen, Wendeltreppe), Raum-Anker, Ellipsen-Mittelpunkte — in zwei Teilen (Modell / Zeichnungen), Schlüssel
    Epoche + Feld-Stände (`Revs`): eine Wand-Änderung sammelt die Zeichnungen nicht neu und umgekehrt; ein
    unverändertes Dokument liefert dieselbe Nummer (`doc_snap_hold`). Je Mausbewegung EIN Aufruf `snap_query`
    (Strecken-Fang wie bisher in `snap.rs`, jetzt über beide Teile; Nahmodus > 2000 Zeichnungen im Kern: Strecken bis
    6·Toleranz über den Raster-Index, nach Abstand sortiert, Schnitt unter den 64 nächsten; dazu Raum-Anker und
    Kreis-Block mit Mittelpunkt/Quadranten/Bogen-Endpunkten/Tangente). TS behält Toleranz in Pixeln, Teilpunkte/
    Verweilen, Parallele, Entwurfspunkte, Blatt-Geometrie (Vorauswahl), Raster/Winkel. Neue Fassade
    `geometry/modelSnap.ts`; gelöscht: TS-Sammlung, `wallLayerBoundarySegments`, `model/wall.ts`
    (`wallReferenceOffset`, kein Aufrufer mehr), `geometry/snapSegments.ts` samt Bindungen `snap_segs_hold`/
    `snap_segs_release`/`snap_eval`, `isIndexable`, Fassaden-Exporte `drawingsNear`/`stairOutline`. Epochen der
    Dokumente sind jetzt über alle Dokumente eindeutig (auch `Document::from_json`), damit Caches ausserhalb des
    Dokuments ein neu geöffnetes Dokument unter derselben Nummer erkennen.
    Gleichheit (einmalig, Test gelöscht): 20 100 `computeSnap`-Abfragen alt/neu JSON-gleich (Beispielprojekt,
    300 Zufallsprojekte mit allen Bauteilarten, je 6 Projekte mit 1500 bzw. 2500 Zeichnungen (Nahmodus) aus Linien,
    Polylinien, Kreisen, Bögen, Rechtecken, Konstruktionslinien, Ellipsen auf zwei Geschossen, bigSample(3); zufällige
    Fang-Einstellungen, Toleranzen, Massstäbe, letzter Punkt/Entwurf, Ebenen-Sichtbarkeit, Verweilen 0 ms (Teilpunkte,
    Parallele)): 0 Abweichungen, alle Fang-Arten getroffen. Bleibende Tests: `geometry/modelSnap.test.ts` (Kern gegen
    Suche über alle Strecken/Paare, Nummer stabil), `tools/snapping.test.ts` (Schichtgrenzen über `computeSnap`),
    Rust `snap_model::tests`, Messung `tools/snapping.perf.test.ts`.
    Messung (vitest/Store, `--no-opt`-WASM, Container unter Last, je Mausbewegung = Mittel über 400 Positionen,
    kleinster aus 3 Läufen; Plan vorher erzeugt wie in der App; alt → neu): 3000 Wände + 20 000 Zeichnungen
    (Nahmodus) 9,7 ms → 23 µs, erster Fang 188 → 25 ms, nach Wand-Änderung 7,5 → 2,6 ms, nach Zeichnungs-Änderung
    52 → 11 ms; 3000 Wände + 1500 Zeichnungen 232 → 180 µs (im selben Lauf abwechselnd: 340–450 → 290–300 µs), nach
    Wand-Änderung 11 → 2,5 ms; Kataster 150 000 Zeichnungen 39 → 15 µs, erster Fang 334 → 136 ms, nach
    Zeichnungs-Änderung 195 → 93 ms (nativ: Strecken 36 ms + Index ~100 ms für 450 000 Strecken; ohne vorher gebaute
    typisierte Sicht kommen ~470 ms dazu). Nicht in der Tauri-App geprüft. Offen: Blatt-Geometrie (Schnitt/Ansicht,
    `sheetSnapGeometry.ts`) wird weiter in TS je Mausbewegung vorausgewählt.
    **Zeichenbefehle im Kern (29.10.):** alle Erzeuge-Befehle bauen ihre Elemente im Kern (`cmd_create.rs`:
    Wand, Decke, Raum, Treppe, Öffnung/Fenster/Tür, Dach, Stütze, Extrusion; `cmd_draw.rs`: Linie, xline, ray,
    Polylinie, Rechteck, Kreis, Bogen, Ellipse, Polygon, Spline, Bézier, Revisionswolke, Wipeout, Multilinie,
    Texte, Hinweis, Kote, Detailverweis, Massstab, Punkt, Block, Bemassung, autodim; `cmd_solid.rs`: solid,
    solidbool, voidbox, terrain, Deckenöffnung, Dachhof, Schnittlinie/Ansichtslinie): Vorgaben aus Typen/Stilen,
    abgeleitete Felder, ids und Gruppen-Zuordnung (`group` im Request, ersetzt `activeGroupOps`). TS hält nur
    die Zustandsautomaten (`commands/createCore.ts`: `createMutation`, `createPreview` mit zwischengespeichertem
    Request → `doc_create_preview_again` ohne JSON je Mausschritt, `createQuery` für Wand-/Profil-/Körper-Wahl).
    Vorschauen mit Rechnung (Wand, Treppe, Öffnung, Raum innen, Stütze, Kreis/Bogen/Ellipse/Polygon, Multilinie,
    Bemassung, autodim, Körper, Schnittlinie) aus dem Kern; reine Echo-Vorschauen (Gummiband, Linie, Punktlisten)
    und HUD-Texte/Feld-Helfer bleiben TS. `tools/tools.ts`: alte Wand/Decke/Linie/Polylinie/Rechteck-Werkzeuge
    entfernt. Gelöscht (TS): `geometry/ceiling.ts`, `opening.ts`, `autoDimensions.ts`, `revisionCloud.ts`,
    Fassaden `arcThroughPoints`/`arcFromStartEnd*`/`bulgeThroughPoint`, `polylineEdges`/`pointSegmentDistance`/
    `signedArea`/`isCCW`/`offsetSegment`/`tangentCircleCenters`/`filletCorner`, `stairGeometry`/`stairCut`/
    `defaultStepCount`, `ellipsePts`, `roofHoleWorks`/`addRoofHole`, `roomFromPointInside(Faces)`,
    `activeGroupOps`; `extrudedSolidSpec` und `generateTerrainFromContours` sind Fassaden über den Kern.
    Gleichheit alt (TS) ↔ Kern mit zeitweiligen Zufallstests (Ops gleich bis auf ids, Vorschauen bitgleich mit
    −0 ≡ 0, danach gelöscht): Wand 1000 Folgen/39677 Vorschauen/2136 Commits, Decke 1941, Raum 937, Treppe 11287,
    Öffnung 1531/Fenster 738/Tür 1502, Dach 9224, Stütze 15833, Extrusion 438; Linie 9643, xline 5430, ray 5387,
    Polylinie 67647 Vorschauen/3699 Commits, Rechteck 15293, Kreis 16408, Bogen 9751, Ellipse 10530, Polygon
    10846, Spline 3561, Bézier 829, Wolke 3519, Wipeout 1280, Multilinie 6449, Text 7258, Textbox 5055, Textpfad
    1096, Hinweis 2019, Kote 435, Detail 7329, Massstab 12068, Punkt 7247, Block 3570, Bemassung 2466 (68378
    Vorschauen), autodim 1066; solid 9348, solidbool 302, voidbox 1764, terrain 7805 (+2000 Höhenlinien-Sätze,
    38617 Dreiecke), Deckenöffnung 1558, Dachhof 288, Schnittlinie 11162, Ansichtslinie 5538, extrudedSolidSpec
    20000; Gruppen-Ops = altes `activeGroupOps`. Messung Wand-Vorschau je Mausschritt (vitest/WASM `--no-opt`,
    3000 Wände, Minimum aus 7): nur Vorschau 1/4/12 Punkte 0,5/1,3/3,8 → 2,9/3,8/3,2 µs; ganzer Mausschritt
    (Fang + Vorschau) 70,6/70,0/75,5 → 75,0/75,3/73,1 µs (Rauschen ±10 µs, Fang dominiert). Abweichungen
    (gewollt): ids `präfix-stamp-k` (Schnittlinien-Geschoss `section-stamp-1` statt `section-<Datum>`);
    nicht-endliche Zahlen/−0 wie im Dokument gespeichert. `bulgePolylinePoints` bleibt (DXF-Import-Test).
    Nicht in der Tauri-App geprüft.
    **Leistung nach der Zusammenführung (29.10.)** — erledigt damit die Offen-Punkte der Griffe/Objekt-Info:
    (a) **id-Suche indiziert:** der Positions-Index des Dokuments (`PosCache`) wird ab der ersten Suche gebaut (Listen
    ≥ 32), überlebt `add` am Ende und ist über `Lookup` (`Document::lookup`) auch für die Wurzel-Abfragen da — Griffe
    (`grips::run`) und Objekt-Info (`selection_info::derive`) suchen nicht mehr linear; die Fassade schickt keine
    Lage-Hinweise mehr (`at` entfällt, TS-`findIndex` je Darstellung weg). TS-`applyOps` bekommt je Op die vom Kern
    getroffene Position (`doc_last_hits` nach Commit/Griff/Undo/Redo, nachgeprüft) und sucht nicht mehr; ohne Hinweis
    (`findItem`) hilft `indexOfId` (Index je Listen-Linie, ab der zweiten Suche — ein `Map` über 20 000 ids kostet in
    V8 ~6 ms, das 20-fache einer linearen Suche). (b) **Commit ohne Kopie:** die Ops gehen ins Dokument über (Prüfung
    der Werte vor, der doppelten ids nach dem Anwenden, `ops::value_problems`/`add_dup_problem`); der Verlauf hält nur
    noch die inversen Ops, den Redo-Schritt liefert das Rückgängigmachen selbst (Inverse der Inversen) — halber
    Verlaufsspeicher, keine Vorwärts-Kopie/-Verdichtung je Mausschritt. Nativ: Commit einer 5000-Punkte-Polylinie
    4,1 → 1,5 ms (`messung_grosse_polylinie`). (c) **Dach-Firsthöhe** nach Inhalt gemerkt (Hash + Vergleich, bis 4096
    Einträge) statt der letzten 16 Dächer. (d) **`setPolylineVertexType` im Kern:** `polyline_vertex.rs` (Ecke/Bogen/
    Spline, `tan` neu in `jsnum`), Griff-Änderung `vertexType`, Kontextmenü über `polyline_vertex_info`; TS-Rechnung
    gelöscht (`withVertexType`). Gleichheit (einmalig, Test gelöscht): 143 880 Fälle (offene/geschlossene Polylinien,
    doppelte/kollineare Punkte, fehlende Bögen, Massstäbe 1e-4…1e5) bitgleich, `vertexTypeOf`/`canSetVertexType` gleich.
    Abweichung (gewollt): keine Änderung → keine Op (vorher ein leerer Undo-Schritt), ein Index ohne Punkt ändert nichts.
    Messung (vitest/Store, 3000 Wände + 20 000 Zeichnungen + 40 Dächer, `objectInfo.perf.test.ts`, alt/neu abwechselnd,
    Container stark unter Last — Werte streuen ±50 %): Objekt-Info Zeichnung (Pos. 10 000) 257–304 → 10–15 µs, Wand
    91–316 → 36–209 µs (ruhig gemessen: 47 µs, davon Kern 36 µs), Dach (40 im Wechsel) 44–109 → 40–102 µs; Griff an
    Zeichnung 15 000 1,9–4,9 ms → 0,19–0,34 ms, Wand an Pos. 1500/2990 129–418 → 55–122 µs; Griff 5000-Punkte-Polylinie
    14–16 → 6,6–10 ms (Rest: JSON 200 KB hin und Parse in TS ≈ 2 ms, neue Polylinie im Kern); Punkttyp kleine Polylinie
    ~1 ms → 0,2–0,5 ms, 5000 Punkte 18–22 → 9–16 ms; Auswahl (300 Wände) verschieben unverändert (5–11 ms). Bleibt:
    die Kopie der Liste in TS je Änderung (`slice` von 20 000 Elementen ≈ 0,14 ms) — Preis der unveränderlichen
    Leseansicht. Nicht in der Tauri-App geprüft.
    **Aufräumen nach den parallelen Ports (29.10.):** Suche nach toten Exporten (Skript über alle `src/**/*.ts`:
    Export ohne Nutzer ausser Tests/Fassade) und toten Bindungen (`#[wasm_bindgen]` ohne TS-Aufrufer), dazu
    `cargo clippy` (dead_code, auch Web-Build). Gelöscht (TS): `wallVerticalExtent`/`ceilingVerticalExtent`/
    `columnVerticalExtent` (`model/wall.ts`, Aufrufer `toSection`/`voids`/`sectionOpenings`/`toElevation` gab es
    nicht mehr; Tests über die Kern-Abfrage `verticalExtents` bzw. Rust-Tests), `openingVerticalExtent`/
    `wallAxisFrame`/`openingCenter` (`geometry/opening.ts`), `isValidOutline`/`outlineCentroid`, `getStairType`/
    `openingsOfWall`/`openingLabel`/`columnLabel`/`getComponent` (`types.ts`), `MONO_INK`/`WALL_FALLBACK_MM`,
    `scatterStrokes`, `ShaderProgram`, `SLAB_RGB`/`DRAWING_LINE_FALLBACK_RGB`, `booleanMesh` samt Typen,
    `meshBytesToImportedMeshes`, `IDEAL_RISER`, `bulgeBetweenAngles`, `pointSegDistPx`, `coreReady`. Bindungen:
    `doc_query`, `core_version`, `drawing3d_line_verts`/`drawing3d_pick_segs` (`web/drawing2d_3d.rs`),
    `bulge_between_angles`, `scatter_strokes_flat`. Rust zusammengelegt: Höhenregeln (UK/OK von Wand/Stütze/Decke,
    Geschoss-Bindung) einmal in `model/helpers.rs::heights` für typisierte Sicht und rohe Wurzel (`selection_info.rs`);
    JS-Wahrheitswert `truthy` (vorher je eine Kopie in `geo_translate`/`layers`/`pens`) aus `grips`; `finite` →
    `jsnum::or_zero` (Kopien in `kennzahlen`/`flaechen`/`room_program`); JS-`String(v)` einmal in
    `js_fmt::js_string` (vorher `project_format` und `selection_info`, letztere ohne Listen); `arr` aus `grips`.
    Bleibt bewusst: TS-Fassaden,
    die nur Tests nutzen (`solidVolume`, `withoutHoles`, `straightSkeleton`, `stairCut`, `triangulate`,
    Schraffur-Clipping in `glPlanHatch.ts`, `subtractRings` — prüfen Kern-Bindungen von TS aus), mehrere
    `signed_area`/`bbox`-Varianten in Rust (verschiedene Punkt-Typen, teils mit JS-Semantik `jsnum::min`).
  - ✅ **S4 Typen aus Rust**: `types.ts` wird aus den Rust-Strukturen erzeugt (ts-rs); Datei-I/O (`projectFormat`, Migration, IFC/DXF/
    STEP-Ex- und -Import) im Kern.
    **Typen (28.10.):** Das Rust-Modell (`core/src/model/generated.rs`, `manual.rs`) ist die Quelle; ts-rs 12 (MIT, nur
    `serde-compat`) erzeugt über `model/ts_export.rs` (eigener Sammler + Formatierer, Test `ts_types_aktuell`) die Datei
    `src/model/types.generated.ts` (`npm run gen:types`; `cargo test` im Kern schlägt fehl, wenn sie veraltet ist).
    `types.ts` re-exportiert sie (`export type *`) und hält nur noch Hilfstypen ohne Projekt-Gegenstück (`EdgeGrip`,
    `ImportedText`, `LayoutAnnotationPatch`, `BuiltinPaletteBank`) und die Helfer (`getWallType` … `PEN_WEIGHTS`);
    `richText.ts`, `viewTypes.ts`, `roomArea.ts` re-exportieren ihre Modell-Typen ebenso. TS-Doku als `///` nach Rust
    übernommen (→ JSDoc). Gleichwertigkeit zur alten TS-Fassung je Typ und Feld per gegenseitiger Zuweisbarkeit + gleiche
    Schlüssel geprüft (einmaliger Abgleich); 18 Literal-Felder per `#[ts(type = …)]` (z. B. `type: "wall"`, `leafCount: 1 | 2`),
    Hilfstypen ohne TS-Namen per `#[ts(inline)]`, getaggte Newtype-Varianten (`ParametricRule`, `ContextObject`) als
    `GridRule | …` mit Tag-Feld in der Struktur. Dabei gefunden: `ImportedMesh.color/ifcGlobalId` fehlten in Rust (ergänzt).
    Rundreise-Test `src/model/types.roundtrip.test.ts`: Beispielprojekt, Projekt mit allen Element-Arten und 60
    Zufallsprojekte TS → JSON → Rust → JSON (Abfrage `modelJson`: typisiertes Modell OHNE `Extra`-Felder) gleich.
    `KNOWN_KEYS` per Test aus `model::Project` abgeglichen. `scripts/gen-rust-model.py` gelöscht. Offen: Varianten-Doku
    getaggter Enums (z. B. `Drawing2DGeom`-Varianten) lässt ts-rs weg (steht in Rust); Datei-I/O-Rest.
    **Datei-I/O (29.10.):** Öffnen lädt die Datei im Kern direkt ins Dokument (`Document::load_file`, `doc_load_file`:
    Parse, Migration, Prüfung; TS bekommt die Leseansicht als JSON des Dokuments) — kein TS-Parse und keine
    Differenz mehr; Speichern, Autosave (jetzt Datei-Text statt Objekt in IndexedDB; alte Objekt-Kopien werden beim
    Lesen zu Text) und Wiederherstellen (wie Öffnen, mit Migration) gehen denselben Weg. CLI/MCP laden ins
    gemeinsame Abfrage-Dokument (`sharedDocument().loadFile`), Abfragen danach ohne erneute Übergabe. Speichern ist
    jetzt Zeichen für Zeichen `JSON.stringify(…, null, 2)`: vorher schrieb der Kern Zahlen wie `5e-6`/`1.2e+20`
    (JS: `0.000005`/`120000000000000000000`) — `JsFormatter` mit JS-Zahlen, Index-Schlüssel („10“, „21“) beim
    Laden vorn wie in einem JS-Objekt, ganze Zahlen über 2⁵³ wie JS gerundet; Meldungen mit JS-Zahlen.
    Gleichheit (einmalig, gegen die frühere TS-Fassung `e02c01d^:src/io/projectFormat.ts` + `JSON.stringify`):
    1804 Dateien (Beispiel, leer, Projekt mit allen Element-Arten, bigSample(3), 80 Zufallsprojekte, 80 mit
    kniffligen Zahlen/Index-Schlüsseln/Sonderzeichen; je 11 Fassungen: kompakt, eingerückt, Version 0, Version 1
    mit Türen, kaputte Listen/unbekannte Felder/ohne id, zu neue/ungültige Version, ohne `walls`, „fremder
    Schreiber“ mit `1.0`/`1e0`), 977 ladbar: Ergebnis, Hinweise, Migration, Fehlermeldungen (ausser JSON-Syntax-
    Text) und gespeicherte Datei zeichengleich. Bleibende Tests: `projectFormat.test.ts`, `setProjectOps.test.ts`,
    Rust `project_format`/`document`. CLI: `convert` obp → obp bytegleich, DXF/IFC-Import (auch `--elements`) gleich
    wie vorher bis auf erzeugte ids. Messung (vitest/Node, `--no-opt`-WASM, Container unter Last, bigSample(20),
    2,6 MB, 3600 Wände): Öffnen 106–115 ms (alter Weg ohne den Kern-Parse ≈ 210–260 ms: JSON zurück, Differenz,
    Commit), Speichern im Kern 32 ms (vorher Kopie des Baums ≈ 80 ms; `JSON.stringify` in JS 17–19 ms).
    **Import-Umwandlung im Kern (29.10.):** Das Format-Modul (`fileio`, eigenes WASM) liest wie bisher in flache
    Puffer; der Kern wandelt sie und wendet das Ergebnis als EINEN Undo-Schritt an: `core/src/import_drawing.rs`
    (DXF/DWG-Puffer v3 dekodieren, Stücke des parallelen Lesens zusammenführen, PDF-Seite mit Massstab →
    Ebenen nach Stärke/Farbe/Strichmuster, Zusammenfassung für den Dialog, Ops: neue Zeichnungsebene, Kategorien
    je Layer `layers::plan_import`, Linienstile der PDF-Strichmuster, 2D-Zeichnungen mit Bulge-Vorzeichen
    Modell = − DXF, Platzierung „Ausschnittsmitte", Meshes als Kontext), `import_ifc.rs` ([B4] Bauteile: Geschosse,
    Wand-/Deckentypen, Materialien, Öffnungen, Stützen, Räume), `import_context.rs` ([B3]/[C11] Kontext-Meshes aus
    IFC und OBJ/STL/glTF/PLY, `ensureContextCategories`, LV95-Rückschub). Bindungen `web/import.rs`
    (`doc_import_drawing/ifc/mesh`, `import_drawing_summary`, `import_drawing_meshes`, `mesh_import_report`,
    `pdf_page_info`, Leseansicht `import_drawing_view` für Tests). TS: `ProjectDocument.importDrawing/importIfc/
    importMesh`, Store `commitImport`; Dialoge halten nur Puffer + Zusammenfassung (`io/importSource.ts`).
    Gelöscht: `io/dxfToDrawings.ts`, `io/pdfLineStyles.ts`, `io/ifcElements.ts`, `decodeImport`, `decodeIfc`,
    `ifcToImportedMeshes`, `decodeMesh`/`meshObjectsToImportedMeshes`, `pdfPageToImport`/`pdfPageInfo` (TS),
    `buildDrawings`, `planImportLayers`, Store `addDrawingLevel`/`importDrawings`; `ensureContextCategories` ist
    Fassade über den Kern. Gleichheit (einmalig, Paritätstest gegen die TS-Fassung, Stand `65e7f3a`): 23 DXF/DWG
    (Fixtures `kataster.dxf`, `klein.dxf`, `layouts.dxf` + Layout, `tile*` DXF/Binär-DXF/DWG R13–2018, synthetischer
    Kataster 3000) × 2 Projekte × 3 Entscheidungen (neue Ebene/Layer-Kategorien/Meshes, aktive Kategorie +
    Ausschnittsmitte, bestehende Ebene); synthetischer Kataster 150 000 Entities in 4 parallel gelesenen Stücken;
    2 PDF × 4 Massstäbe × mit/ohne Text × 2 Projekte × 3 Entscheidungen + vorhandener Linienstil; 5 IFC (Demo-Haus,
    2 Testdaten, 2 mit ifcopenshell erzeugt: 3 Geschosse, Schichten, Stützen, Räume, eBKP-H, einmal in LV95) × 4
    Projekte (leer, Beispiel, mit LV95-Bezug, ohne Listen) × 3 Gruppierungen, Bauteile und Meshes; 6 Meshes
    (OBJ+MTL, STL, GLB, glTF, PLY in LV95) × 3 Einheit/Achse × 3 Projekte × 2 Platzierungen × 3 Gruppierungen →
    Projekt (bis auf erzeugte ids), Zusammenfassung, Berichte, `pdf-info` gleich. CLI (`convert`, `import-ifc`
    auch `--elements`/`--group class`, `import-mesh`, `pdf-info`; 133 Ausgaben): 130 gleich, die 3 PDF-`convert`
    bekommen jetzt wie die App Linienstile für Strichmuster (vorher im CLI nicht). Messung Kataster 150 000
    Entities (vitest/Node, `--no-opt`-WASM, Container unter Last): App-Weg ohne Lesen alt 3,2–4,3 s (TS dekodieren +
    umwandeln + Commit im Kern), neu 2,0–2,7 s (Kern: Zusammenfassung ≈ 0,1 s, Import ≈ 1,7–2,0 s, `JSON.parse` der
    Ops ≈ 0,6 s); CLI `convert` (inkl. Lesen und 78 MB Schreiben) alt ≈ 9,4 s, neu ≈ 9,6–11,9 s (das alte CLI ging
    am Kern-Dokument vorbei). Offen: Ops-Rückgabe als JSON (42 MB beim 150k-Kataster) — die Leseansicht könnte
    die Elemente billiger bekommen; nicht in Tauri/macOS geprüft.
    **STEP-Import im Kern (29.10.):** truck (`trucksolid`, eigenes WASM) liest und tesselliert wie bisher, liefert aber
    einen flachen `Float64Array` (`import_step_flat`, Aufbau `brep::step_meshes_flat`; JSON-`import_step` entfällt);
    der Kern (`import_context.rs::decode_step/step_meshes`, Bindung `doc_import_step`, TS `ProjectDocument.importStep`,
    App: `readStepFlat` → `commitImport`) macht je Körper ein Kontext-Mesh („Import“, Kategorie 10) als EIN Undo-Schritt.
    Gelöscht: `io/stepImport.ts`. Gleichheit (einmalig gegen die alte TS-Fassung): Demo-Haus-, Wand+Zylinder- und
    Quader-STEP aus dem eigenen Export → Meshes (Namen, Positionen f32-genau wie über JSON, Indizes, Schlüsselfolge)
    zeichengleich bis auf ids. CLI importiert kein STEP (nur Export). Bleibend: `io/stepImport.test.ts`, Rust
    `step_tests`. Nur im Linux-Container geprüft, nicht in Tauri/macOS.
    am Kern-Dokument vorbei). Offen: STEP-Import (truck) unverändert in TS; nicht in Tauri/macOS geprüft.
    **Rückweg grosser Schritte (29.10.):** Undo/Redo eines Imports holte alle Elemente als JSON aus dem Kern
    (Redo 34 MB) und baute sie neu (Identität weg). Jetzt merkt sich `ProjectDocument` für Schritte mit ≥ 1000
    berührten Elementen (`core/stepStates.ts`) je berührtem Feld den Wert davor/danach (nur Verweise) unter der
    Laufnummer des Kern-Schritts (`Step::seq`, `doc_history_seq`: oberste Nummern + „verschmolzen"); steht der
    Schritt oben, wendet der Kern ihn ohne Rückgabe an (`doc_jump_quiet`) und TS setzt die Felder zurück — Redo
    bringt dieselben Objekte zurück (Plan-/3D-Caches treffen). Exakt, weil der Verlauf linear ist; verschmolzene
    Schritte bekommen eine neue Nummer (dann wieder JSON-Weg), höchstens 8 gemerkt. Im Kern: `remove` verschiebt
    die Elemente in die inverse Op statt sie zu kopieren (`remove_moving`), Undo/Redo schreiben JSON ohne Kopie
    (`ops::write_ops`, `undo_with`/`redo_with`). Verworfen: binäre Kodierung der Elemente (Prototyp mit
    Formen-Tabelle nur ≈ 20–40 % schneller als `JSON.parse`, mehr Code) und faule Leseansicht (Proxies brechen
    Identität/Iteration der UI). Der Import selbst parst die Elemente weiter einmal (≈ 0,7 s). Messung 150 000
    Entities (vitest, `--no-opt`, Container unter Last, `document.importBench.test.ts` mit `DOSSIER_BENCH=1`):
    Import 3,2–5,4 s → 2,3–2,6 s (Kern 1,6 s, `JSON.parse` 0,7 s), Undo 1,6–2,1 s → 0,2 s, Redo 3,3–5,4 s → 0,14 s;
    nativ Undo 2,2 s → 0,2 s. Offen: Prüfung im Kern-Commit ≈ 0,5 s nativ (Hash-Sets über 150 000 ids).
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
  - ✅ (29.10.) Kaputte Projekte (Datei/Import) bringen keine Abfrage mehr zum Werfen. Fuzz-Test
    `src/core/robustness.test.ts`: Beispiel, „alle Element-Arten", 7 Zufallsprojekte, gekacheltes Projekt × 21
    Verderbnisse (hängende Wand-/Decken-/Dach-/Tür-/Treppentypen, Bauteile, Geschosse, Öffnungs-Wand, Schraffur/
    Linienstil/Stift/Stiftsatz, Block, Layout-Master/-Ausschnitt; Gruppen/Ordner, die sich selbst enthalten; leere und
    Ein-Punkt-Polygone; NaN/±∞/negativ; fehlende Felder; doppelte ids; falsche Typen; kaputte Schnittlinien/Baurecht/
    Sonne) gegen jede Fassade (Plan aller Ebenen + sichtbare Geschosse, Schnitt, Ansicht, Szene/SVG/DXF je Plan, 3D,
    Pick, IFC, OBJ/STL/GLB, Liste, Kennzahlen, Raumprogramm, Flächen/IVHB, Baurecht, Sonne, Layouts, Prüfung,
    Speichern/Laden). Vorher u. a. 158 Würfe allein am Beispiel. Ursachen behoben: (1) Kern-Ableitungen fallen bei
    hängenden Verweisen auf Vorgaben zurück statt `Err` (`wall_type_or_fallback`/`component_or_fallback`: eine Schicht
    0,2 m, neutrales Grau; fehlende Schraffur → ohne Muster; hängender Linienstil einer Schraffur → 0,13 durchgezogen;
    Deckentyp → Rückfall-Schicht; Verschneidung mit Rückfall-Werten; Plan, Schnitt, Ansicht, 3D, IFC, Mesh). (2) Typisierte
    Sicht tolerant (`model/lenient.rs`): EIN Wert, der nicht passt (`null` statt Zahl — NaN überlebt JSON nicht —,
    Zeichenkette statt Punkt), legte das ganze Dokument lahm; jetzt fällt nur er auf die Vorgabe zurück (Pflichtfelder wie
    `Vec2` → 0), nicht lesbare Listenelemente entfallen, die JSON-Wurzel bleibt unverändert. (3) Mesh-Export: gebrochene
    Indizes/NaN-Ecken aus Importen sprengten den `fileio`-Leser. (4) TS `visibleCodesFromSnapshot`/`resolveTitleBlock`
    ohne `layerVisibility`/`viewports`. `projectWarnings` (Kern `project_refs.rs`) listet hängende Verweise, Zyklen und
    ersetzte Werte; `dossier-cli validate` (und MCP `validate`) gibt sie als „Warnung: …" aus (Exit 0, solange keine
    Fehler). Kein Panic gefunden. Offen: Hülle (Panels/Editoren) nicht geprüft; Kategorie-Codes ohne Kategorie werden
    nicht gewarnt (bewusst, häufig bei Importen).
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
  Panels/Griffe ändern das Projekt direkt. 28.10.: die häufigsten Aktionen (Griffe, Objekt-Info, Auswahl-Transformationen,
  Löschen, Zeichenbefehle) liefern ihre Änderung als JSON-Ops (`core/opsBuild.ts`, Store `applyChange`) — Grundlage für
  Makros/MCP; Rest (nur Laden/Import/CLI) unter [K4] S3. · L
  29.10.: auch Laden, Import und CLI liefern Ops bzw. laden über den Kern; `diffToOps` gelöscht ([K4] S3).
- ◐ **[7] Zentrale Validierung nach jedem Befehl.** 28.10.: jede Projektänderung wird im Kern geprüft (`ops.rs`, NaN/neue doppelte
  ids → Rücknahme mit Meldung); weitere Regeln (Bezüge, Geometrie) offen. · M
- ◐ **[8] Undo über Befehle.** 28.10.: Verlauf im Rust-Kern als inverse Ops (coalesceKey, Gruppen, Speichergrenze), keine
  28.10. (Mac-Test Maintainer): nach mehrmaligem Ganz-zurück/Vor war Redo weg. Ursache: die Ausschnitt-Leiste legte bei
  leerem `viewSnapshots` automatisch einen Ausschnitt an (Projektänderung → neuer Verlaufsschritt). Jetzt nur Anzeige-Tab
  ohne Projektänderung; Neu/Öffnen/Vorlage/Wiederherstellen leeren den Verlauf; Browser-Öffnen liest Text statt
  ArrayBuffer. Tests: `history.roundtrip.test.ts`, e2e „Mehrmals ganz zurück und wieder vor“.
  Snapshots mehr ([K4] S3). 28.10.: Griffe, Objekt-Info, Auswahl-Transformationen, Löschen und Zeichenbefehle erzeugen Ops
  direkt (`applyChange`/`opsMutation`); Gruppen mit Schlüssel: ein Griff-Zug mit mitgeführten Ecken = ein Schritt. Offen:
  Rest (nur Laden/Import/CLI) unter [K4] S3. · M
  29.10.: auch Laden/Import/CLI ohne Projekt-Differenz (`diffToOps` gelöscht); Öffnen/Neu leeren den Verlauf im Kern, ein Import = ein Schritt ([K4] S3/S4).
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
- ◐ **[G10] render2d-Punkte f32** (Fund aus [K3b], geprüft 27.10.): `render2d::types::Scene` speichert Punkte
  als f32 (~0.25 m Auflösung bei ~2.6e6 m). **Real betroffen:** DXF/DWG-Import mit Platzierung „origin"
  (Vorgabe im Import-Dialog, `ImportDialog.tsx`) behält die Landeskoordinaten → im Browser-/Electron-Pfad
  (WASM-render2d, `useWasmPlanRenderer.ts`) wackeln/verschmelzen Linien eines Katasterplans. **Nicht
  betroffen:** macOS-Metal-Pfad (GPU-Kompilierung mit `origin`-Verschiebung), lokal gezeichnete Projekte,
  Standort-Import (Modell-(0,0) = Suchzentrum). Lösung: Szene relativ zu einem Ursprung kodieren
  (`renderSceneBin.ts`/`scene_bin.rs` + Kamera-Versatz in f64 in render2d, wie `GpuGeometry.origin`). · S–M
  29.10. **Auch das SVG-Overlay** (Griffe, Fang-Marken, Hervorhebung, Texte) rechnet in viewBox-Einheiten
  = Modell-m · 90 und der Browser in f32: bei LV95 (≈ 2.3e8) liegen Griffe beim Hineinzoomen neben der
  Ecke (gemessen Chromium: 1 px bei 1:500, ~6 px bei Ausschnitt 11 m, ~80 px bei 1.5 m); Treffer und
  GPU-Linien rechnen in f64 und stimmen. `<circle>`/`<rect>`/`x`/`y` (CSS-Längen, ±33.5 Mio. geklemmt)
  fehlen dort ganz — Griffe/Fang sind auf Vieleck umgestellt ([C1] Kataster), offen: Lineal (`PlanRulers`),
  Hover-Kreis einer Kreis-Zeichnung, HUD-Kasten. Lösung: Overlay relativ zu einem Ursprung (viewBox und
  `toScreen` in PlanView minus Ursprung). Auch die CLI-SVG (`plan --out`) schreibt Landeskoordinaten
  (senkrechte Linien fehlten im Chromium-Screenshot eines LV95-Plans).
  29.10. **SVG-Overlay erledigt:** lokaler Ursprung nahe dem Ausschnitt (`views/plan/planView/overlayOrigin.ts`,
  bleibt stehen bis der Ausschnitt > 64 Ausschnitt-Grössen entfernt ist; lokale Projekte: (0, 0) wie bisher).
  viewBox, Griffe, Kanten-Griffe, Fang, Hervorhebung, Vorschau, Texte, Raster, Lineal, HUD, Marquee, Luftbilder
  zeichnen relativ dazu; Ausschnitt, Treffer, Fang bleiben absolut in f64. `vbCircle` wieder entfernt (lokal
  passen `<circle>`-Werte in die CSS-Längen). Gemessen Chromium, Kataster-Ecke: vorher 1.6 px (Übersicht 80 m),
  5.0 px (10 m), 31 px (1 m); nachher ≤ 0.003 px. Lineal: Ticks über ganzzahligen Index (aufsummiert drifteten
  sie bei LV95). Plan-Rad: eigener nicht-passiver Listener (React-`onWheel` ist passiv, `preventDefault` warf
  in Chromium Konsolenfehler). e2e `kataster.spec.ts` (Griffe ± 1 px bei 80/10/1 m, Lineal, Vorschau-Kreis).
  Nicht in Tauri/WKWebView geprüft. Offen: CLI-SVG.
  29.10. **„recursive use of an object … unsafe aliasing" erledigt:** keine Überlappung (alle Aufrufe synchron),
  sondern Geräteverlust: headless SwiftShader verliert das WebGPU-Gerät beim ersten Präsentieren (auch in
  reinem JS nachgestellt; real: Treiber-Reset/GPU-Prozess), `createBuffer(mappedAtCreation)` wirft, wgpu
  paniert mitten in `set_scene_bin` → die wasm-bindgen-Sperre bleibt gesetzt, jeder weitere Aufruf scheitert,
  der GPU-Pfad bleibt aber „bereit" und das SVG zeichnet keine Geometrie (leerer Plan). Behoben: render2d
  merkt den Verlust (`is_lost`, `set_lost_callback`, danach keine wgpu-Aufrufe), Szene ungemappt über die
  Queue hochladen, Validierungsfehler melden statt paniken; `views/plan/wasmRendererSession.ts` ist der
  einzige Aufrufer (letzte Szene gewinnt, gleicher Plan nicht neu hochgeladen, verschachtelte Aufrufe
  nachgeholt, Neuaufbau nach Ausfall mit erneuter Szene, höchstens 3 je 60 s, sonst SVG-Rückfall).
  Tests: vitest mit Schein-Renderer, e2e `planEngine.spec.ts` (scheitert ohne die Änderung). Headless nur
  der Ausfall-/Rückfall-Weg prüfbar (Gerät stirbt immer); echtes WebGPU-Zeichnen nicht geprüft. Nativer
  macOS-Pfad gelesen: Frames zusammengefasst, Zustand hinter `Mutex` — kein solches Sperr-Problem, aber
  `lock().unwrap()` in `native_embed.rs` vergiftet nach einem Panic dauerhaft (offen, nicht geändert).
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
  (29.10.) Verschieden geneigte Flächen ([26] Kantenneigung): an Graten mit zwei Flächen und je einer
  Traufkante gehen die Seitenebenen auseinander — `Mitre::at` nimmt dort den Mittelpunkt beider Eckpunkte
  (bei gleicher Neigung identisch, unverändert).

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
  Fehlerbehebung 28.10.: Schnitt-/Ansichtsmarker erscheinen nicht mehr auf freien Zeichnungsebenen (`plan_section_lines`);
  nach Undo/Redo fällt die aktive Ebene auf die zuletzt aktive bzw. das erste Geschoss zurück (`appStore.ts`, ohne Undo-Schritt).
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
- ✅ **[93] Zeichnen auf dem Layout-Blatt = Zeichnen im Grundriss.** (29.10., Wartungs-Feedback „soll sich genau
  gleich anfühlen") Vorher eigener Pfad: `Layout.annotations` (Linie/Rechteck/Text/Bild in Papier-mm) mit eigenen
  Werkzeug-Zuständen, Klick-Logik, Griffen, Inline-Editor und DOM-Rendering in `LayoutSheet.tsx`, ohne Fang,
  Befehlszeile/HUD, Tab-Felder, Bearbeiten-Befehle, Polylinie/Kreis/Bemassung …; eigene Auswahlart
  `layoutAnnotation`, eigenes Pan/Zoom, eigener PDF-Zweig. Jetzt: jedes Layout hat seine Blatt-Ebene
  (`DrawingLevel.layoutId`, Art „drawing", Papier 1:1 in Metern, Ursprung oben links, Papier-y = −y); ein offenes
  Blatt macht sie zur aktiven Ebene und zeigt sie in derselben PlanView — gleiche Befehle, Fang, Griffe, Vorschau/HUD,
  Auswahl, Undo (ein Schritt je Element) und dasselbe Rendering; das Blatt liefert nur den Hintergrund
  (`PlanView.backdrop`: Papier, Master, Viewports) und Platzieren/Verschieben/Skalieren der Viewports. Format 3:
  Migration `annotations` → `drawings2d` auf der Blatt-Ebene (jedes Layout bekommt seine Ebene); Blatt-Ebenen
  ohne Strichstärken-Faktor und ohne projektglobale Zutaten, Schrifthöhe neuer Texte 3.5 mm (`textHeight` im
  Befehls-Kontext), Bild einfügen 60 mm mitten aufs Blatt; Layout-PDF legt die Blatt-Ebene über `planToPrintSvg`
  (fester Bereich, ohne Blatt) aufs Papier. Gelöscht: Annotations-Typen/-CRUD/-Mathe/-Rendering/-CSS, `annotationTextLines`.
  e2e `layoutSheet.spec.ts` (Linie, Polylinie, Rechteck, Fang auf Endpunkt, Griff ziehen + Undo, ein Undo-Schritt je
  Element — identisch im Grundriss und auf dem Blatt). Offen: Blatt rendert über den SVG-Pfad der PlanView (wegen des
  Hintergrunds, wie bei Luftbildern), nicht über render2d; Lineale/Objekt-Info zeigen Meter (y negativ) statt
  Papier-mm; feste Modellgrössen anderer Befehle (Kote, Detailverweis, Punktmarke) nicht ans Papier angepasst; kein
  Fang auf Viewport-Inhalt; Layout-DXF (`--layout`) ohne Blatt-Zeichnung; PDF-Export der Blatt-Zeichnung nicht
  angesehen; nicht in der Tauri-App/macOS geprüft. · M
- ◐ **[94] Standard-Baustoffe und Ansichtsschraffur (SIA 400).** (29.10., Wunsch Maintainer) Kern `standards.rs`:
  33 Baustoffe/Bekleidungen (Beton, Stahlbeton, Backstein, Kalksandstein, Porenbeton, Holz massiv, Brettsperrholz,
  Holzwerkstoff, Mineral-/Steinwolle, EPS, XPS, Holzfaser, Trittschall, Gipskarton, Innen-/Aussenputz, Zementestrich,
  Glas, Stahl, Aluminium, Naturstein, Erdreich, Kies/Sauberkeitsschicht, Luftschicht, Lattung vertikal/horizontal,
  Boden-Deckel, Schindeln, Trapezblech, Faserzement, Tonziegel) je mit SIA-400-Schnittschraffur, Füll- und
  Ansichtsfarbe, Ansichtsschraffur, 3D-Textur (gebündelt aus `manifest.json`, sonst nur ambientCG-Kennung →
  „Textur laden" im Bauteil-Dialog) und Kennwerten (neue Felder `Component.lambda`/`density`/`fireClass` (VKF
  RF1–RF4)/`elevationColor`/`surfacePattern`/`standardId`); Aufbauten Aussenwand verputzt mit Aussendämmung,
  Innenwand Backstein, Holzständerwand hinterlüftet, Stahlbetondecke mit Trittschall + Estrich, Steildach Holz
  gedämmt. Ansichtsschraffur (`surface_pattern.rs`): Linien/Lattung, Boden-Deckel, Läuferverband, Schindeln,
  Trapezblech, Naturstein polygonal, Plattenteilung; Ausrichtung am Element (Wand: ab Wandanfang/UK; Dach:
  traufparallel/Falllinie ab Traufe), je Element drehbar/versetzbar (`Wall`/`Roof.surfacePatternAngle`/`Offset`,
  Attribute-Panel); Massstab: unter 0.7 mm Papierabstand jede 2./4./8. Linie, darunter weg (Ansicht bekommt den
  Massstab als 3. Argument). Ansicht: sichtbare Wandseite (rechts der Achse = äusserste Schicht) mit Ansichtsfarbe
  + Muster, Dachflächen; verdeckt wie die Kanten, Maler-Tiefe der eigenen Fläche. Grundriss: Dachaufsicht je
  Dachfläche (`roof-surface-pattern`). Geprüft: Rust-Tests (Muster, Ausdünnung, Ansicht, Dachaufsicht,
  Bibliothek), CLI-Ansicht 1:50/1:500 und Druck-SVG Grundriss/Schnitt angesehen (Linux-Container). Offen: 3D-
  Linien (render3d) nicht umgesetzt; Decken-Untersicht/Bodenbeläge ohne Muster; Schnittschraffur-Strichmuster
  (Beton unbewehrt, Estrich) im Schnitt-Druck durchgezogen; ambientCG-Kennungen CorrugatedSteel005, WoodSiding008,
  Chipboard001 ohne Netz nicht geprüft; nicht in der Tauri-App/macOS geprüft. · M
- ◐ **[95] Standards in neuen Projekten, „Standards laden".** (29.10.) Neu/Neu aus Musterhaus bringen die
  Standards mit (`withStandards`, Kern-Abfrage `standardsMergeOps`); Ressourcen-Manager-Kopf: „Standards laden"
  ergänzt nur Fehlendes (gleiche id oder gleicher Name = vorhanden, Verweise neuer Aufbauten zeigen dann auf das
  vorhandene Bauteil), ein Undo-Schritt. Offen: Rückmeldung (Anzahl) nach dem Laden. · S
- ◐ **[96] Linientypen nach SIA 400 / ISO 128.** (29.10.) Standard-Linienstile: Volllinie, Strichlinie fein/grob,
  Punktlinie, Strichpunktlinie (Achse), Strich-Zweipunktlinie, Grundstücksgrenze, Baulinie/Bauteilgrenze,
  Bruchlinie (Zickzack), Schraffurlinien. Fehler behoben: render2d warf Punkte (AN = 0) aus dem Muster und
  verschob AN/AUS (Strichpunkt wurde Strichlinie) — Szenen- und Chunk-Pfad (`gpu_compile.rs`) behalten sie, der
  Shader zeichnet sie rund; Bögen mit Punkten/> 4 Einträgen über den Linien-Strichpfad; Strichmuster skalieren auf
  dem Bildschirm mit dem Massstab (`dash_scale` = N/100 in Linien-, Strich- und Bogen-Uniforms, vorher fest 1:100);
  SVG-Export setzt runde Kappen bei Punkten. DXF/DWG: LTYPE je Linienstil (Name, Punkt = 0) wie bisher. Geprüft:
  Rust-Tests (render2d, Kern), naga-Validierung der Shader, Druck-SVG (PDF-Pfad) mit allen Typen angesehen.
  Offen: Bildschirm (WebGPU) nicht angesehen; CPU-Rückfall (> 8 Einträge) verliert Punkte. · S
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
  (29.10.) Felder umgesetzt (Entscheid Maintainer): `Roof.holes?: Vec2[][]` (Ringe, Drehsinn egal) und
  `Roof.edgePitchDeg?: (number | null)[]` (erst Umrisskanten in gespeicherter Reihenfolge, dann Hofkanten
  Ring für Ring; `null` = Giebel, Zahl ≥ 0 = Neigung der Kante, NEGATIV oder fehlender Eintrag =
  Standard = `pitchDeg`, am Sattel/Mansard-Satteldach Giebel quer zum First; Feld fehlt = wie bisher).
  Wirkt bei Sattel/Walm/Mansarde/Zelt (Höfe auch Flach); Pult ignoriert beide. `roof.rs::custom_roof` →
  `weighted_roof` über alle Ringe, Überstand je Kante (Giebel = Ortgang), Hofringe schrumpfen; ungültige
  Höfe (nicht im Umriss, Schnitt, vom Überstand geschlossen) → Dach wie ohne. Dächer ohne die Felder
  bitgleich (CLI-Plan/Ansicht/Schnitt/IFC vorher/nachher gleich). Plan: Hof = Loch der Dachfläche + Hof-
  Traufe (`plan/domains.rs`); 3D/Schnitt/Ansicht/IFC über die Flächen; `Mitre` (model3d) mittelt die
  Ecke an Graten zwischen verschieden geneigten Flächen (Dachschichten bleiben geschlossen). UI:
  Objekt-Info → Kantenliste (Neigung leer = Standard, Giebel-Schalter, „Alle Kanten auf Standard"),
  Hofliste mit Entfernen, Befehl `dachhof`/`lichthof` (Klicks, ≥ 3 Punkte Polygon, 2 Punkte + Enter
  Rechteck; „aus gewählter Kontur" geht nicht, weil nur ein Objekt wählbar ist). Breite/Tiefe im
  Objekt-Info nur noch für Vierecke ohne Höfe. Offen: Kante im Grundriss hervorheben (PlanView, anderer
  Zuständigkeitsbereich); Kanten-/Hof-Griffe im Grundriss; Mansarde mit Hof UND verschieden geneigten
  Kanten: zweite Dachschicht (Versatz > Knickbreite) nicht geschlossen; Schattenwurf (`sun.rs`) nimmt
  weiter die Hülle der Dachpunkte (Hof wirft Schatten).

## Priorität 4 — später

Alle ○: [27] Punktwolken (Leser ✅ [B9], Anzeige ◐ s. u., Modell offen) · [28] Phasen · [29] Bauteillisten (◐, Export vorhanden) · [43] Verknüpfte
Modelle · [44] Aus Datei einfügen · [45] Favoriten · [68] Gelände mit Baugrube (= [T6]) · [71] U-Werte ·
[72] Graue Energie KBOB · [73] eBKP-H · [74] SIA 500 · [75] Fluchtwege VKF · [83] Befehlspalette ·
[85] Makro-Rekorder · [86] Pipette · [87] Fang mit Begründung · [48] Web-Worker
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
  Sattel, Fünfeck, T Mansarde, Zelt) angesehen (Linux). (29.10.) Modellfelder für Höfe/Neigung je Kante gibt es jetzt, s. [26].
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
  - ✅ Sammler nach Rust (29.10., [K4]): Mengen, Treppen-Teile, Füllungs-Parameter, Klassifikation/Zonen,
    Geschoss-Kennwerte und Georeferenz rechnet der Kern (`core/src/ifc_data.rs`, `ifc_quantities.rs`,
    `ifc_stairs.rs`, `geo_rebase.rs`) direkt aus dem Dokument; `exportIfc.ts` ist Fassade (Optionen, Zeitstempel,
    Bytes an `fileio`). Ausgabe zeichengleich (s. [K4] S2). Dabei gefunden und behoben: Innenhöfe der Dächer
    (`Roof.holes`) wanderten bei Georeferenz nicht mit (auch `translateProject` in TS).
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
  - ✅ **Kataster: Griffe nach dem Anwählen** (29.10., Fehlerbericht „importierte DWG-Geometrien haben keine
    Eckpunkte"): drei Ursachen. (1) Griffe waren `<circle cx cy>` — `cx`/`cy`/`r` sind CSS-Längen, Chromium
    und WebKit klemmen sie auf ±33.5 Mio.; bei LV95 (viewBox-Einheit = m · 90 ≈ 2.3e8) lagen die Griffe
    weit ausserhalb des Bildes (gemessen: −26.8 Mio. px), im DOM aber vorhanden. Jetzt Vieleck
    (`views/plan/planView/vbCircle.tsx`), auch für Fang-Marken und gesetzte Stützpunkte. (2) Ein einzeln
    gewähltes Element mit > 600 Stützpunkten bekam gar keine Griffe (Strassenparzellen/Bodenbedeckung nach
    dem Zerlegen von Bögen und Schraffur-Rändern): Grenze gilt nur noch für Mehrfachauswahl
    (`state/gripLimits.ts`), bei vielen Griffen zeichnet die Ansicht nur die sichtbaren (`gripCull.ts`).
    (3) LWPOLYLINE/POLYLINE und Schraffur-Ränder aus einer Polylinie kommen mit Bögen als Polylinie mit
    `bulge` statt fein zerlegt (`import.rs` `bulge_verts`, Kodierung Flag 8); **Vorzeichen: Modell-Bulge
    = − DXF-Bulge** (Modell: Scheitel links der Sehne, DXF: Gegenuhrzeigersinn). Tests: Rust, vitest,
    e2e `kataster.spec.ts` (Fixture `e2e/fixtures/kataster.dxf`, LV95: Klick, Griffe auf den Ecken, Ziehen,
    Rückgängig). Synthetischer Kataster (6750 Elemente, DXF und DWG) nur im Browser-Build (Chromium) geprüft,
    nicht in Tauri/macOS. Offen: f32-Versatz des SVG-Overlays bei LV95, s. [G10] (29.10. erledigt, Vieleck
    wieder `<circle>`).
  - ✅ **Tests unter Last stabil** (29.10.): e2e `kataster.spec.ts` zoomte mit festen Pausen (100/400 ms) und
    rechnete den Zoom-Ankerpunkt aus der noch nicht festgeschriebenen viewBox → unter Last Drift/Timeout.
    Jetzt mehrere Rad-Ereignisse je Runde, dann `expect.poll` auf stabile viewBox; Griff-Abstand (±1 px) per
    `expect.poll`. vitest: globales `testTimeout` 30 s (`vitest.config.ts`; Plan-Chunk-Test brach unter Last
    an der 5-s-Vorgabe ab), Eingaben auf das Mindestmass (Charge `CHUNK_DOUBLES` überschreiten) verkleinert
    (drawing2d, planPick, swissAlti3d ohne Text-Parsen, glPlanChunks), truckBrep-STEP-Test 120 s (Einlesen
    ≈ 12 s im `--no-opt`-WASM). Je 5× vitest und 3× e2e unter 8 CPU-Brennern grün; nur Linux-Container.
  - ✅ **Kanten-Griffe einer Polylinie** (29.10.): liefen auch über die angehängten Bogen-Mitten-Griffe von
    `drawingVertices` → Dreiecke quer im Innern jeder Polylinie. Jetzt nur über die Eckpunkte und nur an
    geraden Segmenten (Bogen: eigener Mitten-Griff), `state/edgeGrips.ts` + vitest, e2e.
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
  **Sammler nach Rust (29.10., [K4]):** Szene (Knoten, Teil-Netze je Material, Materialtabelle, `orientOutward`)
  baut der Kern aus dem Dokument (`core/src/mesh_data.rs`); `exportMesh.ts` ist Fassade. Ausgabe zeichengleich
  (s. [K4] S2); leere Szene jetzt ohne leere `nodes`-Liste (Validator EMPTY_ENTITY bei leerem Projekt).
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
