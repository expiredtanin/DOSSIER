import type { Project } from "./types";
import { recomputeFloorElevations } from "./types";
import { MATERIAL_LIBRARY } from "../materials/library";
import { materialFromAsset } from "../materials/runtime";

// Bibliotheks-Materialien für die Basis-Components ab Werk (PBR-Texturen,
// s. `src/materials/library.ts`). Zuordnung nur, wo ein Bibliotheks-Asset
// sinnvoll passt — Wärmedämmung und Zementestrich bleiben bewusst ohne
// Zuweisung (kein passendes Asset in der Bibliothek), statt zu raten.
const PLASTER_ASSET = MATERIAL_LIBRARY.find((a) => a.id === "Plaster001")!;
const BRICK_ASSET = MATERIAL_LIBRARY.find((a) => a.id === "Bricks104")!;
const CONCRETE_ASSET = MATERIAL_LIBRARY.find((a) => a.id === "Concrete048")!;

// Demo-Haus mit zwei Geschossen:
//   EG — rechteckiger Raum (5 × 4 m) mit einer Tür in der Südwand.
//   OG — rechteckiger Raum (5 × 3 m) ohne Tür.
// Maße in Metern. Die Außenwand ist ein realistischer SIA-naher
// Schichtaufbau (außen → innen).
//
// Zwei UNABHÄNGIGE Achsen (Dokumentmodell nach DOSSIER):
//   • drawingLevels — Geschosse (EG, OG) + Platzhalter Schnitt/Ansicht.
//   • layers — Grafik-Kategorie-Baum (Codes/Namen/Farben/lw 1:1 aus DOSSIER,
//     DEFAULT_LAYER_SCHEMA in launcher/src/App.jsx). 21 Türen/Fenster ist hier
//     als Kind von 20 Wände gehängt.
export const sampleProject: Project = {
  id: "demo",
  name: "Demo-Haus",
  // ── Ressourcen-Bibliotheken (zentral verwiesen per id) ──────────────────
  // Linienstile: aufgeräumt auf kanonische VOLLLINIEN je Strichstärke (dash=null)
  // + eine gestrichelte Linie. Früher gab es drei funktional identische 0.13-
  // Volllinien ("thin"/"hatch-line"/"joint-massive") — zusammengeführt auf "thin"
  // ("Volllinie 0.13"); Schraffur-/Schichtfugen-Referenzen zeigen jetzt darauf.
  // (Die ids bleiben stabil, damit geladene Projekte + interne Referenzen halten.)
  lineStyles: [
    { id: "hatch-hair", name: "Volllinie 0.02", weight: 0.02, color: "#1a1a1a", dash: null },
    { id: "thin", name: "Volllinie 0.13", weight: 0.13, color: "#1a1a1a", dash: null },
    { id: "medium", name: "Volllinie 0.25", weight: 0.25, color: "#1a1a1a", dash: null },
    { id: "thick", name: "Volllinie 0.5", weight: 0.5, color: "#0a0a0a", dash: null },
    // Gestrichelte Haarlinie für die Dämmung (Striche quer durch die Wanddicke).
    { id: "hatch-dash", name: "Dämmungsstrich", weight: 0.02, color: "#1a1a1a", dash: [0.35, 0.3] },
  ],
  // Schraffuren: color = Linien-/Vollfüllfarbe des Musters; angle in Grad.
  // "none" = keine Schraffur (nur Component-Füllung).
  // Grundeinstellung aller Linien-Schraffuren: schwarze Haarlinie (color) auf
  // weißem Grund (die zugehörigen Bauteile tragen weiße Füllfarbe).
  hatches: [
    { id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#1a1a1a" },
    {
      id: "insulation",
      name: "Wärmedämmung",
      pattern: "insulation",
      scale: 1,
      angle: 0,
      color: "#1a1a1a",
      lineStyleId: "thin",
    },
    {
      id: "diagonal",
      name: "Diagonal",
      pattern: "diagonal",
      scale: 1,
      angle: 45,
      color: "#1a1a1a",
      lineStyleId: "thin",
    },
    {
      id: "crosshatch",
      name: "Kreuzschraffur",
      pattern: "crosshatch",
      scale: 1,
      angle: 0,
      color: "#1a1a1a",
      lineStyleId: "thin",
    },
    {
      id: "solid-concrete",
      name: "Beton (voll)",
      pattern: "solid",
      scale: 1,
      angle: 0,
      color: "#9aa0a6",
      lineStyleId: "thin",
    },
    // ── SIA-Schnittschraffuren (Haarlinie) ──────────────────────────────────
    // Dichte Teilung (scale < 1; Muster-Kachel = 8·scale) für den SIA-Look.
    // Beton: Kreuzschraffur, absolut 45° (bildschirmfest, NICHT wandbezogen).
    {
      id: "sia-concrete",
      name: "Beton (Kreuz)",
      pattern: "crosshatch",
      scale: 0.5,
      angle: 45,
      color: "#1a1a1a",
      lineStyleId: "hatch-hair",
    },
    // Backstein: Diagonale, 45° RELATIV zur Wandachse (dreht mit der Wand mit).
    {
      id: "sia-brick",
      name: "Backstein (Diagonal)",
      pattern: "diagonal",
      scale: 0.5,
      angle: 45,
      relativeToWall: true,
      color: "#1a1a1a",
      lineStyleId: "hatch-hair",
    },
    // Dämmung: DURCHGEZOGENE (nicht gestrichelte) Linien QUER durch die Wanddicke
    // (senkrecht zur Wandachse), wandbezogen. Basiswinkel 0 = Musterlinie steht
    // senkrecht zur Wandrichtung; durchgezogene Haarlinie, dichte Teilung.
    {
      id: "sia-insulation",
      name: "Dämmung (Strich)",
      pattern: "diagonal",
      scale: 0.45,
      angle: 0,
      relativeToWall: true,
      color: "#1a1a1a",
      lineStyleId: "hatch-hair",
    },
  ],
  // Bauteil-Materialien: color = Poché-Füllung im Grundriss UND 3D-Diffusfarbe;
  // joinPriority höher = läuft am Stoß durch (für spätere T-Stöße).
  components: [
    {
      id: "render-ext",
      name: "Aussenputz",
      color: "#d8d2c7",
      hatchId: "none",
      joinPriority: 10,
      material: materialFromAsset(PLASTER_ASSET),
    },
    // Weißer Grund unter den durchgezogenen Dämmungs-Haarlinien (quer zur Wand).
    // Kein passendes Bibliotheks-Asset (Dämmung) → bewusst ohne `material`.
    { id: "insulation", name: "Wärmedämmung", color: "#ffffff", hatchId: "sia-insulation", joinPriority: 20 },
    {
      id: "brick",
      name: "Backstein",
      color: "#8c5544",
      hatchId: "sia-brick",
      joinPriority: 50,
      material: materialFromAsset(BRICK_ASSET),
    },
    {
      id: "render-int",
      name: "Innenputz",
      color: "#efece6",
      hatchId: "none",
      joinPriority: 10,
      material: materialFromAsset(PLASTER_ASSET),
    },
    // Für spätere T-Stöße: Beton als durchlaufender Backbone (höchste Priorität).
    {
      id: "concrete",
      name: "Beton",
      color: "#9aa0a6",
      hatchId: "sia-concrete",
      joinPriority: 100,
      material: materialFromAsset(CONCRETE_ASSET),
    },
    // Zementestrich — oberste Schicht des mehrschichtigen Deckenaufbaus (Decken-Stile).
    // Kein passendes Bibliotheks-Asset (Estrich) → bewusst ohne `material`.
    { id: "screed", name: "Zementestrich", color: "#c9c2b3", hatchId: "diagonal", joinPriority: 30 },
  ],
  wallTypes: [
    {
      id: "aw",
      name: "Aussenwand 34.5 cm",
      // Schichten außen → innen; Priorität lebt jetzt am Component.
      layers: [
        { componentId: "render-ext", thickness: 0.02 },
        // Innere Fuge der Dämmung trifft auf den Backstein (massiv↔massiv) → 0.13 mm.
        { componentId: "insulation", thickness: 0.16, jointLineStyleId: "thin" },
        { componentId: "brick", thickness: 0.15 },
        { componentId: "render-int", thickness: 0.015 },
      ],
    },
    {
      // Verputzte Backstein-Innenwand (beidseitig Innenputz) — für den T-Stoß-Test:
      // eine Querwand, die mit beiden Enden an die Innenflächen der Aussenwände stösst.
      id: "iw",
      name: "Innenwand Mauerwerk verputzt 15 cm",
      layers: [
        { componentId: "render-int", thickness: 0.015 },
        { componentId: "brick", thickness: 0.12 },
        { componentId: "render-int", thickness: 0.015 },
      ],
    },
  ],
  // Deckenstile (Decken-Aufbau-Typen) — das liegende Gegenstück der Wandstile.
  // Schichten oben (OK) → unten (UK), analog zur Wand außen → innen.
  ceilingTypes: [
    {
      id: "dg-massiv",
      name: "Geschossdecke mehrschichtig",
      layers: [
        // Estrich (schwimmend) → Trittschalldämmung.
        { componentId: "screed", thickness: 0.06 },
        // Innere Fuge der Dämmung trifft auf die Betondecke (massiv) → 0.13 mm.
        { componentId: "insulation", thickness: 0.04, jointLineStyleId: "thin" },
        // Betondecke (Rohdecke, tragend) — innerste/unterste Schicht.
        { componentId: "concrete", thickness: 0.2 },
      ],
    },
  ],
  roofTypes: [
    {
      id: "roof-warm",
      name: "Steildach gedämmt",
      // Aussen (Eindeckung) → innen (Verkleidung); Bauteile aus der Bibliothek.
      layers: [
        { componentId: "brick", thickness: 0.04 }, // Eindeckung (Ziegel, Platzhalter)
        { componentId: "insulation", thickness: 0.22, jointLineStyleId: "thin" }, // Sparren/Dämmung
        { componentId: "render-int", thickness: 0.0125 }, // Innenverkleidung (GK)
      ],
    },
  ],
  // Bauteil-Typen (Bibliothek) — Tür/Fenster/Treppe, analog Wand-/Deckenstile.
  // Elemente referenzieren sie per `typeId`; ohne Referenz gilt Inline-Verhalten.
  doorTypes: [
    {
      id: "door-standard",
      name: "Zimmertür 0.9 m",
      kind: "dreh",
      leafCount: 1,
      leafStyle: "glatt",
      frameThickness: 0.05,
      frameKind: "zarge",
      frameWidth: 0.06,
      defaultWidth: 0.9,
      defaultHeight: 2.0,
    },
    {
      // Aussentür: Blockrahmen, in die Aussenschale zurückgesetzt, mit Oberlicht.
      id: "door-entry",
      name: "Haustür Blockrahmen (Oberlicht)",
      kind: "dreh",
      leafCount: 1,
      leafStyle: "glas",
      glazingRatio: 0.35,
      frameThickness: 0.07,
      frameKind: "blockrahmen",
      frameWidth: 0.09,
      insetFromFace: 0.14,
      insetFace: "aussen",
      transomHeight: 0.45,
      threshold: true,
      defaultWidth: 1.1,
      defaultHeight: 2.1,
    },
  ],
  windowTypes: [
    {
      id: "window-standard",
      name: "Fenster 1.2 × 1.4 m",
      kind: "drehkipp",
      wingCount: 1,
      glazing: "zweifach",
      frameThickness: 0.06,
      frameWidth: 0.06,
      defaultSillHeight: 0.9,
      defaultWidth: 1.2,
      defaultHeight: 1.4,
    },
    {
      // Zweiflügliges Fenster mit Kämpfer, Oberlicht und Schichteinzug.
      id: "window-double",
      name: "Fenster 2-flügl. + Oberlicht",
      kind: "drehkipp",
      wingCount: 2,
      mullionRows: 1,
      glazing: "dreifach",
      frameThickness: 0.07,
      frameWidth: 0.07,
      insetFromFace: 0.12,
      insetFace: "aussen",
      transomHeight: 0.4,
      defaultSillHeight: 0.85,
      defaultWidth: 1.8,
      defaultHeight: 1.9,
    },
  ],
  stairTypes: [
    {
      // Standard: normale Ortbeton-Laufplatte (schräge, offene Untersicht).
      id: "stair-standard",
      name: "Betontreppe 1.0 m",
      structure: "beton",
      closedRisers: true,
      treadThickness: 0.05,
      nosing: 0.03,
      railing: "keine",
      defaultWidth: 1.0,
    },
    {
      id: "stair-massiv",
      name: "Massivtreppe (auf Sockel)",
      structure: "massiv",
      closedRisers: true,
      treadThickness: 0.04,
      nosing: 0.03,
      railing: "keine",
      defaultWidth: 1.0,
    },
    {
      // Offene Wangentreppe: schwebende Tritte (unten offen), zum direkten
      // Vergleich mit der Massivtreppe — im ObjectInfoPanel der Treppe zuweisen.
      id: "stair-wange-holz",
      name: "Wangentreppe Holz (offen)",
      structure: "wange",
      closedRisers: false,
      treadThickness: 0.05,
      nosing: 0.03,
      railing: "keine",
      defaultWidth: 1.0,
    },
    {
      // Aufgesattelte Treppe mit geschlossenen Setzstufen (Tritt + Setzstufe,
      // aber unten offen — der Raum darunter bleibt frei).
      id: "stair-aufgesattelt",
      name: "Aufgesattelt (Setzstufen)",
      structure: "aufgesattelt",
      closedRisers: true,
      treadThickness: 0.05,
      nosing: 0.025,
      railing: "keine",
      defaultWidth: 1.0,
    },
  ],
  // Oberste Schnitte: Geschosse + Schnitt/Ansicht + freie Zeichnung.
  // baseElevation wird über recomputeFloorElevations gestapelt: EG=0, OG=2.6.
  drawingLevels: recomputeFloorElevations([
    { id: "eg", name: "Erdgeschoss", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0 },
    { id: "og", name: "Obergeschoss", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0 },
    {
      id: "schnitt-a",
      name: "Schnitt A",
      kind: "section",
      visible: true,
      locked: false,
      linePoints: [{ x: -1, y: 2 }, { x: 6, y: 2 }],
      directionSign: 1,
    },
    {
      id: "ansicht-sued",
      name: "Ansicht Süd",
      kind: "elevation",
      visible: true,
      locked: false,
      // Ansichtslinie südlich des Demo-Hauses, Blick nach Norden (+y) — damit
      // die Demo-Ansicht sofort rendert (analog zur gesäten Schnitt-A-Linie).
      linePoints: [{ x: -1, y: -2 }, { x: 6, y: -2 }],
      directionSign: 1,
      shadows: true,
    },
    { id: "detail-1", name: "Detail 1", kind: "drawing", visible: true, locked: false },
  ]),
  // Grafik-Kategorie-Baum (DOSSIER-Codes 1:1).
  layers: [
    { code: "00", name: "Raster", color: "#484850", lw: 0.13, visible: true, locked: false },
    { code: "01", name: "Vermessung", color: "#707078", lw: 0.18, visible: true, locked: false },
    { code: "10", name: "Situation", color: "#909090", lw: 0.18, visible: true, locked: false },
    { code: "11", name: "Strasse", color: "#a89070", lw: 0.18, visible: true, locked: false },
    { code: "12", name: "Gebäude", color: "#888888", lw: 0.25, visible: true, locked: false },
    { code: "13", name: "Bäume", color: "#50a050", lw: 0.13, visible: true, locked: false },
    { code: "14", name: "Höhenlinien", color: "#909050", lw: 0.18, visible: true, locked: false },
    {
      code: "20",
      name: "Wände",
      color: "#0a0a0a",
      lw: 0.35,
      visible: true,
      locked: false,
      children: [
        { code: "21", name: "Türen/Fenster", color: "#5080c8", lw: 0.25, visible: true, locked: false },
        { code: "22", name: "Möbel", color: "#909090", lw: 0.13, visible: true, locked: false },
        { code: "25", name: "Stützen", color: "#c87050", lw: 0.5, visible: true, locked: false },
      ],
    },
    { code: "30", name: "Decken", color: "#605850", lw: 0.35, visible: true, locked: false },
    { code: "31", name: "Dächer", color: "#7a4a3a", lw: 0.35, visible: true, locked: false },
    { code: "40", name: "Treppen", color: "#4a6a58", lw: 0.35, visible: true, locked: false },
    { code: "35", name: "Träger", color: "#a87858", lw: 0.5, visible: true, locked: false },
    { code: "50", name: "Text", color: "#d0d0d0", lw: 0.13, visible: true, locked: false },
    { code: "60", name: "Räume", color: "#5a7a9a", lw: 0.13, visible: true, locked: false },
    { code: "90", name: "Referenzen", color: "#585860", lw: 0.13, visible: true, locked: false },
    { code: "99", name: "Konstruktion", color: "#404048", lw: 0.13, visible: true, locked: false },
  ],
  walls: [
    // ── EG: 5 × 4 m Raum (CCW) ──
    // Süd (unten)
    { id: "W1", type: "wall", floorId: "eg", categoryCode: "20", start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, wallTypeId: "aw", height: 2.6 },
    // Ost (rechts)
    { id: "W2", type: "wall", floorId: "eg", categoryCode: "20", start: { x: 5, y: 0 }, end: { x: 5, y: 4 }, wallTypeId: "aw", height: 2.6 },
    // Nord (oben)
    { id: "W3", type: "wall", floorId: "eg", categoryCode: "20", start: { x: 5, y: 4 }, end: { x: 0, y: 4 }, wallTypeId: "aw", height: 2.6 },
    // West (links)
    { id: "W4", type: "wall", floorId: "eg", categoryCode: "20", start: { x: 0, y: 4 }, end: { x: 0, y: 0 }, wallTypeId: "aw", height: 2.6 },
    // Innere Querwand (Mauerwerk verputzt): teilt den Raum in zwei. Beide Enden
    // treffen mittig auf die Innenflächen von W1 (unten) und W3 (oben) → zwei
    // Mittelspannen-T-Stösse; computeJoins schneidet die Querwand bündig an.
    { id: "W9", type: "wall", floorId: "eg", categoryCode: "20", start: { x: 2.4, y: 0 }, end: { x: 2.4, y: 4 }, wallTypeId: "iw", height: 2.6 },

    // ── OG: 5 × 3 m Raum (CCW), keine Tür ──
    // Süd (unten)
    { id: "W5", type: "wall", floorId: "og", categoryCode: "20", start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, wallTypeId: "aw", height: 2.6 },
    // Ost (rechts)
    { id: "W6", type: "wall", floorId: "og", categoryCode: "20", start: { x: 5, y: 0 }, end: { x: 5, y: 3 }, wallTypeId: "aw", height: 2.6 },
    // Nord (oben)
    { id: "W7", type: "wall", floorId: "og", categoryCode: "20", start: { x: 5, y: 3 }, end: { x: 0, y: 3 }, wallTypeId: "aw", height: 2.6 },
    // West (links)
    { id: "W8", type: "wall", floorId: "og", categoryCode: "20", start: { x: 0, y: 3 }, end: { x: 0, y: 0 }, wallTypeId: "aw", height: 2.6 },
  ],
  doors: [
    {
      id: "D1",
      type: "door",
      hostWallId: "W1",
      categoryCode: "21",
      position: 0.8, // Startkante 0.8 m ab Wand-Start → Tür x 0.8–1.7, links von W9 (x=2.4)
      width: 0.9,
      height: 2.1,
      swing: "left", // schlägt nach innen (in den Raum) auf
      hinge: "start",
    },
  ],
  // Öffnungen (Fenster/Türen) — ein Beispiel-Fenster in der EG-Südwand (W1,
  // frei von der Tür) und in der EG-Nordwand (W3). Kategorie „21" (Türen/Fenster).
  openings: [
    {
      id: "O1",
      type: "opening",
      hostWallId: "W1",
      categoryCode: "21",
      kind: "window",
      typeId: "window-standard",
      position: 3.0, // Startkante 3.0 m → Fenster x 3.0–4.0, rechts von W9 mit Massiv-Abstand
      width: 1.0,
      height: 1.2,
      sillHeight: 0.9,
    },
    {
      id: "O2",
      type: "opening",
      hostWallId: "W3",
      categoryCode: "21",
      kind: "window",
      typeId: "window-standard",
      // Startkante 0.6 m ab W3-Start (x=5) → Fenster x 3.0–4.4, rechts von W9 (x=2.4)
      // mit sichtbarer Massiv-Wand dazwischen (die Querwand stösst auf Mauerwerk).
      position: 0.6,
      width: 1.4,
      height: 1.3,
      sillHeight: 0.9,
    },
  ],
  // Decken (Slabs) — Geschossdecke über dem EG (= Boden des OG). Umriss = EG-
  // Grundriss (5 × 4 m). Kategorie „30 Decken", mehrschichtiger Deckenstil
  // „dg-massiv" (Estrich + Trittschalldämmung + Betondecke, 30 cm), OK bündig
  // mit dem EG-Wandkopf (baseElevation + floorHeight = 2.6 m). `wallTypeId`
  // bleibt als LEGACY-Rückfall gesetzt (siehe `getCeilingType`).
  ceilings: [
    {
      id: "C1",
      type: "ceiling",
      floorId: "eg",
      categoryCode: "30",
      outline: [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 4 },
        { x: 0, y: 4 },
      ],
      wallTypeId: "aw",
      ceilingTypeId: "dg-massiv",
    },
  ],
  // Dach — Satteldach über dem Baukörper (5×4), First entlang X (längere Seite),
  // 0.4 m Traufüberstand. Sitzt auf der OG-Oberkante (roofBaseElevation-Default).
  roofs: [
    {
      id: "RF1",
      type: "roof",
      floorId: "og",
      categoryCode: "31",
      outline: [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 4 },
        { x: 0, y: 4 },
      ],
      shape: "sattel",
      pitchDeg: 30,
      overhang: 0.4,
      ridgeAxis: "x",
      thickness: 0.2,
    },
  ],
  // Treppen — eine gerade Beispieltreppe im EG entlang der Ostwand, steigt ins OG
  // (totalRise = Geschosshöhe). Kategorie „40 Treppen".
  stairs: [
    {
      id: "ST1",
      type: "stair",
      floorId: "eg",
      categoryCode: "40",
      shape: "straight",
      typeId: "stair-standard",
      start: { x: 3.7, y: 0.4 },
      dir: { x: 0, y: 1 },
      runLength: 3.2,
      width: 1.0,
      totalRise: 2.6,
      stepCount: 15,
      up: true,
    },
  ],
  // Räume (SIA-416-Flächen) — ein Beispielraum im EG (lichte Innenkontur des
  // 5×4-m-Umrisses, Aussenwände Typ „aw" 0.345 m dick → Innenmaß 4.655×3.655 m
  // ≈ 17.01 m²). Kategorie „45 Räume", SIA-Blatt HNF (Hauptnutzfläche).
  rooms: [
    {
      id: "R1",
      type: "room",
      floorId: "eg",
      categoryCode: "60",
      siaCategory: "HNF",
      name: "Wohnen",
      // Lichte Innenkontur = Wandachse ± halbe Wanddicke (Typ „aw": Putz aussen
      // 0.02 + Dämmung 0.16 + Backstein 0.15 + Putz innen 0.015 = 0.345 m Gesamt-
      // dicke → 0.1725 m je Seite). Der Raumumriss liegt damit exakt auf der
      // Innenfläche der Wand, nicht in der Wand-Poché.
      boundary: [
        { x: 0.1725, y: 0.1725 },
        { x: 4.8275, y: 0.1725 },
        { x: 4.8275, y: 3.8275 },
        { x: 0.1725, y: 3.8275 },
      ],
      color: "#6b7280",
      stampAnchor: { x: 2.5, y: 2.0 },
    },
  ],
  // Freie 2D-Zeichengeometrie — anfangs leer; wird mit den Zeichenwerkzeugen
  // gefüllt (docs/design/drawing-tools.md).
  drawings2d: [],
  // Kontext-Schicht (importierte/abgeleitete Geometrie) — anfangs leer; wird
  // über den DXF-Import bzw. die Gelände-Generierung gefüllt.
  context: [],
};
