import type { Project } from "./types";
import { recomputeFloorElevations } from "./types";

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
  // Linienstile: Strichstärken aus DEFAULT_LAYER_SCHEMA (lw in mm). "hatch-line"
  // ist der dünne Strich für Schraffur-Muster.
  lineStyles: [
    { id: "thin", name: "Dünn 0.13", weight: 0.13, color: "#1a1a1a", dash: null },
    { id: "medium", name: "Mittel 0.25", weight: 0.25, color: "#1a1a1a", dash: null },
    { id: "thick", name: "Stark 0.5", weight: 0.5, color: "#0a0a0a", dash: null },
    // Schraffurlinie = schwarze Haarlinie (Grundeinstellung für alle Schraffuren).
    { id: "hatch-line", name: "Schraffurlinie", weight: 0.13, color: "#1a1a1a", dash: null },
    // Feinste Haarlinie für die SIA-Schnittschraffuren (Beton/Backstein/Dämmung):
    // Gewicht unter der Bildschirm-Untergrenze, damit die Musterlinien als dünnste
    // Haarlinie (Stroke-Minimum) rendern.
    { id: "hatch-hair", name: "Schraffur-Haarlinie", weight: 0.02, color: "#1a1a1a", dash: null },
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
      lineStyleId: "hatch-line",
    },
    {
      id: "diagonal",
      name: "Diagonal",
      pattern: "diagonal",
      scale: 1,
      angle: 45,
      color: "#1a1a1a",
      lineStyleId: "hatch-line",
    },
    {
      id: "crosshatch",
      name: "Kreuzschraffur",
      pattern: "crosshatch",
      scale: 1,
      angle: 0,
      color: "#1a1a1a",
      lineStyleId: "hatch-line",
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
    { id: "render-ext", name: "Aussenputz", color: "#d8d2c7", hatchId: "none", joinPriority: 10 },
    // Weißer Grund unter den durchgezogenen Dämmungs-Haarlinien (quer zur Wand).
    { id: "insulation", name: "Wärmedämmung", color: "#ffffff", hatchId: "sia-insulation", joinPriority: 20 },
    { id: "brick", name: "Backstein", color: "#8c5544", hatchId: "sia-brick", joinPriority: 50 },
    { id: "render-int", name: "Innenputz", color: "#efece6", hatchId: "none", joinPriority: 10 },
    // Für spätere T-Stöße: Beton als durchlaufender Backbone (höchste Priorität).
    { id: "concrete", name: "Beton", color: "#9aa0a6", hatchId: "sia-concrete", joinPriority: 100 },
  ],
  wallTypes: [
    {
      id: "aw",
      name: "Aussenwand 34.5 cm",
      // Schichten außen → innen; Priorität lebt jetzt am Component.
      layers: [
        { componentId: "render-ext", thickness: 0.02 },
        { componentId: "insulation", thickness: 0.16 },
        { componentId: "brick", thickness: 0.15 },
        { componentId: "render-int", thickness: 0.015 },
      ],
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
    { id: "ansicht-sued", name: "Ansicht Süd", kind: "elevation", visible: true, locked: false },
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
      position: 2.0, // 2 m vom Wand-Start (Ecke unten links)
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
      position: 3.6, // hinter der Tür (2.0–2.9), noch innerhalb der 5-m-Wand
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
      position: 1.8,
      width: 1.4,
      height: 1.3,
      sillHeight: 0.9,
    },
  ],
  // Decken (Slabs) — Geschossdecke über dem EG (= Boden des OG). Umriss = EG-
  // Grundriss (5 × 4 m). Kategorie „30 Decken", 25 cm dick, OK bündig mit dem
  // EG-Wandkopf (baseElevation + floorHeight = 2.6 m).
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
      thickness: 0.25,
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
  // 5×4-m-Umrisses, Aussenwände 0.2 m → Innenmaß 4.8×3.8 m ≈ 18.24 m²).
  // Kategorie „45 Räume", SIA-Blatt HNF (Hauptnutzfläche).
  rooms: [
    {
      id: "R1",
      type: "room",
      floorId: "eg",
      categoryCode: "60",
      siaCategory: "HNF",
      name: "Wohnen",
      boundary: [
        { x: 0.1, y: 0.1 },
        { x: 4.9, y: 0.1 },
        { x: 4.9, y: 3.9 },
        { x: 0.1, y: 3.9 },
      ],
      color: "#5a7a9a",
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
