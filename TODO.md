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
  Einzeiler). Offen: Triangulierung, Straight Skeleton [B2]. · M
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
  - ○ **[K3a] Plan-Erzeugung in Rust** (Wand-Poché, Öffnungssymbole, Decken, Treppen, Dächer, Räume,
    2D-Zeichnung, Kontext, Schnittlinien) direkt in den Plan-Puffer; JS-Objekte nur noch für Export/Overlay.
  - ○ **[K3c] Schnitt und Ansicht** (`toSection`, `toElevation`, `meshSection`) im selben Puffer-Format.
  - ○ **[K3d] Aufräumen:** TS-Primitive-Erzeugung löschen, SVG/PDF/DXF-Export lesen den Puffer.
  Nachteile (bewusst): Übergang mit doppelter Datenhaltung, Format muss TS/Rust gleich bleiben
  (Versionsnummer + Hin-und-zurück-Tests), Text-Layout bleibt bis [K4] in TS.
- ○ **[K4] Modell und Ops in Rust** [2]; TS bekommt die Typen generiert (z. B. `ts-rs`). · XL
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
  ifcopenshell, `npm run check`). Läuft auf GitHub, sobald Actions aktiv sind. · S–M
- ○ **[60] Nur versprechen, was getestet ist.** · S · Regel, keine Arbeit.
- ○ **[51] Herkunft übernommenen Codes.** · S · fällig mit [B2]/[B3]: Dateikopf (Repo, Commit, Datei,
  „geändert") + `NOTICE` im Repo.

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
- ○ **[7] Zentrale Validierung nach jedem Befehl.** · M
- ◐ **[8] Undo über Befehle.** Undo existiert (Snapshots, coalesceKey), nicht befehlsbasiert. · M
- ◐ **[9] MCP-Brücke.** Headless `dossier-cli … mcp`; Brücke zum offenen Fenster fehlt. · M

### Daten

- ○ **[10] IDs und GUIDs trennen.** IFC-GUIDs werden deterministisch aus der ID gehasht. · M
- ○ **[11] Bibliothek per GUID.** · M

### Robustheit und Tests

- ○ **[15] Kostenbudget.** Zeit-/Schrittbudget je WASM-Geometrie-Operation, Booleans im Worker ([48]). · M
- ◐ **[17] Ergebnisse über die Ausgabe testen.** Golden-SVGs für Plan/Schnitt/Ansicht; 3D noch nicht. · M
- ✅ **[18] IFC gegen IfcOpenShell.** = [B1]. 27.10.: `scripts/validate-ifc.py` + `exportIfc.validate.test.ts`. · S–M
- ◐ **[19] Beispielgebäude als Skript.** `sampleProject.ts` + Kontrollmodell. · S
- ◐ **[20] Performance-Benchmark.** `dossier-cli … bench`; grosses Testgebäude/Frame-Zeiten offen. · M
- ○ **[49] UI-Tests wie ein Mensch.** Playwright ad hoc (dist-test, Port 5188), nicht als Suite. · M
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
- ○ **[G9] Dach-Gehrung an Walm-/Zeltspitzen** (neu 27.10.): an Punkten mit ≥ 3 Dachflächen trifft die
  paarweise Gehrung der Unterseite nicht exakt (Restlücke < 0.01 m²); solche Dächer gehen als nicht
  geschlossenes Face-Set ins IFC. · S–M

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
- ✅ **[62] Kennzahlenleiste.** Flächenbilanz-Panel: GF/aGF/GV/AZ/ÜZ, Parzellenfläche, je Geschoss (27.10.).
- ◐ **[70] Flächentabellen SIA 416 / IVHB.** SIA-416-Bilanz vorhanden (CSV); IVHB offen. · M
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
- ○ **[76] Vektorfang auf PDF.** · M
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
- ○ **[25] IFC-Import** → [B3]/[B4]. · L
- ◐ **[26] Dächer über beliebige Grundrisse.** `geometry/roofSkeleton.ts` (Walm/Sattel/Mansarde/
  Krüppelwalm auf L/T/U, Kehlen, Giebel); Port nach Rust läuft [K2]. Offen: Innenhöfe, schiefwinklige
  Grundrisse → [B2]. · M

## Priorität 4 — später

Alle ○: [27] Punktwolken · [28] Phasen · [29] Bauteillisten (◐, Export vorhanden) · [43] Verknüpfte
Modelle · [44] Aus Datei einfügen · [45] Favoriten · [68] Gelände mit Baugrube (= [T6]) · [71] U-Werte ·
[72] Graue Energie KBOB · [73] eBKP-H · [74] SIA 500 · [75] Fluchtwege VKF · [83] Befehlspalette ·
[84] Undo-Verlauf · [85] Makro-Rekorder · [86] Pipette · [87] Fang mit Begründung · [48] Web-Worker
(◐, nur DXF-Parser) · [52] Icons (◐, `CommandIcon.tsx`) · [56] Startparameter · [89] Git-freundliches
Format · [90] Versionsvergleich · [91] Assistent · [92] Speckle.

## Übernahme aus BIMCraft [B]

Quelle: github.com/IPedrax/BIMCraft v0.9. Lizenz `MIT OR Apache-2.0` (`crates/rvt` nur Apache-2.0),
DOSSIER ist AGPL-3.0-or-later → Übernahme erlaubt, Pflicht [51]. **Stolpersteine:** BIMCraft rechnet in
**mm** (am WASM-Rand ×1000), Rust **Edition 2024** (let-chains; unsere Crates 2021), `bimcraft-core` als
Ganzes nicht WASM-tauglich (rayon, tempfile, SystemTime) — nur einzelne Module herauslösen.

- ✅ **[B1] IFC-Prüfung in der CI** (= [18]). (27.10.) Eigenes Prüfskript (Schema, Express-Regeln,
  Geometrie je Bauteil), Test ruft es auf, CI installiert ifcopenshell. Erster Fund behoben
  (IfcOwnerHistory ohne LastModifiedDate).
- ○ **[B2] Straight Skeleton** (für [26]), jetzt nach `dossier-core` statt `kernel2d`. `skeleton.rs`
  (709 Z., 8 Tests inkl. Fuzz): Innenhöfe, schiefwinklige Grundrisse, Giebel auf beliebiger Kante,
  Neigung je Kante, Arbeitsbudget. · S (Kernel) + M (Einbau)
- ○ **[B3] IFC-Import als Mesh** (erste Stufe von [25]). `step.rs` + Leseteil von `import.rs`. · M
- ○ **[B4] IFC-Import zu echten Bauteilen** (zweite Stufe von [25]). · L · nach [B3].
- ◐ **[B5] IFC-Export nachziehen** (`exportIfc.ts`). Stand 27.10.:
  - ✅ Nicht-ASCII nach ISO 10303-21 (`\X2\`/`\X4\`).
  - ✅ Materialschichten: Wand-/Decken-/Dachtypen als IfcWallType/IfcSlabType/IfcRoofType mit
    IfcMaterialLayerSet, Exemplare über IfcRelDefinesByType (keine LayerSetUsage, Wand ist Mesh).
  - ✅ IfcSpace aus `Room` (Qto_SpaceBaseQuantities, SIA 416), IfcRoof, IfcColumn mit Material.
  - ○ `IfcOpeningElement` + RelVoids/RelFills statt ausgeschnittener Meshes. · M
  - ○ `Pset_*Common`. · S
  - ○ Dauerhafte GUIDs (= [10]). · M
  - ✅ Georeferenz [69].
- ○ **[B6] Wand unter Dach als Prismen zwischen Ebenen** (für [G2]). `walls.rs:413–472, 592–654`. · M
- ○ **[B7] Dach-Verschneidung und Gauben in 2.5D** (für [G5]). · M · nach [B2]/[B6].
- ○ **[B8] Bogenwände, schneller Weg** (für [T2]). · S/M–L
- ○ **[B9] Punktwolken-Leser** (für [27]). · M
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
  Offen: Binär-DXF-Export, echte HATCH-Entitäten statt Schraffurlinien.
  - ✅ **DXF-Import in Rust** (28.10.): statt eigenem Tag-Reader acadrust (ASCII und Binär, R12–2018+,
    Code-Seiten) in `fileio/src/import.rs` → flacher f64-Puffer + String-Tabelle, dekodiert in
    `io/dxfParser.ts` (Rückgabetyp unverändert, neu `insUnits`). dxf-parser entfernt; Aufteilung grosser
    Dateien für parallele Worker von `io/dxfEntityChunker.ts` nach `fileio/src/split.rs` (Bytes statt
    Text, ab 4 MB). Abweichungen zum alten Parser (alle gewollt): Bulges tesselliert, Kreise/Bögen/
    Schraffuren in Blöcken behalten Kurve/Füllung, Ebene „0" in Blöcken erbt die INSERT-Ebene (sonst
    eigene), Meshes je Ebene und auch aus Blöcken, MESH/Polygon-Mesh trianguliert, nur Modellraum (kein
    Papierbereich), periodische Splines. Offen: Texte/ATTRIB in Blöcken nur als TEXT/MTEXT, SOLID/
    DIMENSION/LEADER nicht abgebildet, `$INSUNITS` nur gemeldet (Koordinaten bleiben 1:1), DXF am Stück
    ≈ 1,2–1,6× langsamer als dxf-parser (acadrust-Tokenizer; dank Aufteilung ab 4 MB insgesamt schneller).
- ○ **[C3] MCP an die laufende App** (`--connect 127.0.0.1:7979`, Werkzeuge `screenshot`, `ui_click`,
  `render` → PNG, `execute` = jeder Befehl mit JSON): genau die fehlende Hälfte von [9]; setzt [6] voraus. · M
- ○ **[C4] CLI-Skripte** (`run --script`, `--cmd` mehrfach mit `{last}`, `convert`): Befehle headless
  verketten — für Tests, Agenten und Stapelverarbeitung. Erweitert [4]. · S–M
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

## Bewusst nicht übernommen

egui, CPU-Renderer (s. [R3]), Revit-Bedienkonzept, Strich-Schrift, Haustechnik-Disziplinen. Zusätzlich:
- **HLR [G4]:** BIMCraft hat keine vektorielle Verdeckung → selbst lösen.
- **`crates/rvt` (Revit):** Rechtsrisiko bei wenig Nutzen.
- `pdf.rs` (jsPDF + svg2pdf ist besser), `texture.rs`, `stairs.rs`, `snap.rs`, `crates/update`, `csg.rs`.
