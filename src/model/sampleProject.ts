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
  ],
  // Bauteil-Materialien: color = Poché-Füllung im Grundriss UND 3D-Diffusfarbe;
  // joinPriority höher = läuft am Stoß durch (für spätere T-Stöße).
  components: [
    { id: "render-ext", name: "Aussenputz", color: "#d8d2c7", hatchId: "none", joinPriority: 10 },
    // Weißer Grund unter der schwarzen Dämmungs-Haarlinie (Schraffur-Grundeinstellung).
    { id: "insulation", name: "Wärmedämmung", color: "#ffffff", hatchId: "insulation", joinPriority: 20 },
    { id: "brick", name: "Backstein", color: "#8c5544", hatchId: "none", joinPriority: 50 },
    { id: "render-int", name: "Innenputz", color: "#efece6", hatchId: "none", joinPriority: 10 },
    // Für spätere T-Stöße: Beton als durchlaufender Backbone (höchste Priorität).
    { id: "concrete", name: "Beton", color: "#9aa0a6", hatchId: "solid-concrete", joinPriority: 100 },
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
      lw: 0.5,
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
    { code: "35", name: "Träger", color: "#a87858", lw: 0.5, visible: true, locked: false },
    { code: "50", name: "Text", color: "#d0d0d0", lw: 0.13, visible: true, locked: false },
    { code: "60", name: "Plangrafik", color: "#c0a040", lw: 0.13, visible: true, locked: false },
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
  // Freie 2D-Zeichengeometrie — anfangs leer; wird mit den Zeichenwerkzeugen
  // gefüllt (docs/design/drawing-tools.md).
  drawings2d: [],
  // Kontext-Schicht (importierte/abgeleitete Geometrie) — anfangs leer; wird
  // über den DXF-Import bzw. die Gelände-Generierung gefüllt.
  context: [],
};
