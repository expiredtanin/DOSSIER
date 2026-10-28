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

- ✅ **[10] IDs und GUIDs trennen.** IFC-GUIDs werden deterministisch aus Projekt-, Art- und Element-id gehasht (28.10., [B5]). · M
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
- ◐ **[25] IFC-Import** → [B3] ✅ (Mesh), [B4] ◐ (Bauteile). · L
- ◐ **[26] Dächer über beliebige Grundrisse.** `geometry/roofSkeleton.ts` (Walm/Sattel/Mansarde/
  Krüppelwalm auf L/T/U, Kehlen, Giebel); Port nach Rust läuft [K2]. Offen: Innenhöfe, schiefwinklige
  Grundrisse → [B2]. · M

## Priorität 4 — später

Alle ○: [27] Punktwolken · [28] Phasen · [29] Bauteillisten (◐, Export vorhanden) · [43] Verknüpfte
Modelle · [44] Aus Datei einfügen · [45] Favoriten · [68] Gelände mit Baugrube (= [T6]) · [71] U-Werte ·
[72] Graue Energie KBOB · [73] eBKP-H · [74] SIA 500 · [75] Fluchtwege VKF · [83] Befehlspalette ·
[84] Undo-Verlauf · [85] Makro-Rekorder · [86] Pipette · [87] Fang mit Begründung · [48] Web-Worker
(◐, DXF-Parser, IFC-Import) · [52] Icons (◐, `CommandIcon.tsx`) · [56] Startparameter · [89] Git-freundliches
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
  Offen: Kamera des Viewpoints setzen und für neue Themen aus dem 3D-Viewport lesen (`Wasm3DViewport` hält
  die Orbit-Kamera intern, ohne Setter/Getter; Achsen Z-oben wie IFC, Viewport vermutlich Y-oben);
  Snapshot aus dem Viewport; `extensions.xml` (3.0), Farbgruppen/Linien, BimSnippet, Dokument-Referenzen
  und verwandte Themen gehen beim Speichern verloren; Panel in den Standard-Dock aufnehmen. · M
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
