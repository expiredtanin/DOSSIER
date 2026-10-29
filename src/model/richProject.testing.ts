// Testhilfe: Beispielprojekt mit allen Element-Arten (`richProject`) und daraus abgeleitete
// Zufallsprojekte (`randomProject`, Listen gemischt/gekürzt, Zahlen verrauscht, optionale Felder weg).
// Genutzt von der Modell-Rundreise und dem Robustheitstest des Kerns.

import { sampleProject } from "./sampleProject";
import type { Drawing2DGeom, ParametricRule, Project, RichTextDoc } from "./types";

export const plain = (p: unknown): unknown => JSON.parse(JSON.stringify(p));

const doc: RichTextDoc = {
  version: 1,
  paragraphs: [{ runs: [{ text: "Hallo", marks: { bold: true, sizePt: 9, color: "#112233", super: true } }], align: "center", lineHeight: 1.2 }],
};

const geoms: Drawing2DGeom[] = [
  { shape: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
  { shape: "xline", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } },
  { shape: "ray", a: { x: 0, y: 0 }, b: { x: 0, y: 1 } },
  { shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: true, bulge: [0, 0.5, 0] },
  { shape: "rect", min: { x: 0, y: 0 }, max: { x: 2, y: 1 } },
  { shape: "circle", center: { x: 1, y: 1 }, r: 0.5 },
  { shape: "arc", center: { x: 1, y: 1 }, r: 0.5, a0: 0, a1: 1.5 },
  { shape: "ellipse", center: { x: 1, y: 1 }, rx: 2, ry: 1, rotation: 0.3 },
  { shape: "bezier", pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 0 }] },
  { shape: "spline", pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }], closed: false, mode: "control" },
  {
    shape: "dimension", pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }], offset: 0.5, gapMm: 1, overshootMm: 2, tickLenMm: 3,
    textHeightMm: 2.5, lineWeightMm: 0.18, extWeightMm: 0.13, tickWeightMm: 0.35, textOffsetsMm: [{ along: 1, perp: -1 }],
  },
  { shape: "kote", at: { x: 1, y: 2 }, value: 3.05, kind: "ukRoh", rotation: 0 },
  { shape: "detailref", at: { x: 1, y: 2 }, label: "3", sheetLayoutId: "lay1", sheetLabel: "A-12" },
  { shape: "scalebar", at: { x: 0, y: -2 }, segmentLength: 1, segments: 5 },
  { shape: "pointmarker", at: { x: 2, y: 2 } },
  {
    shape: "text", at: { x: 0, y: 3 }, text: "Notiz", height: 0.25, angle: 0.1, width: 2, marks: { italic: true }, doc,
    leaderTarget: { x: 1, y: 1 }, leaderBendPoints: [{ x: 0.5, y: 2 }], pathPts: [{ x: 0, y: 3 }, { x: 2, y: 3 }],
  },
  { shape: "block", blockDefId: "blk1", at: { x: 5, y: 5 }, rotation: 1.57, scale: 2 },
  { shape: "image", min: { x: 0, y: 0 }, max: { x: 1, y: 1 }, src: "data:image/png;base64,AAAA", opacity: 0.5 },
];

const rules: ParametricRule[] = [
  { type: "grid", spacing: 3, directions: "both", wallTypeId: "wt1", referenceLine: "center", height: 2.8 },
  { type: "module", moduleSize: 1.2, direction: "x", referenceWallId: "w1" },
  { type: "conditional-thickness", condition: "exterior", wallTypeId: "wt1", logic: "or" },
  { type: "reference-line", referenceLine: "left", target: "all" },
  { type: "sequence", rules: [{ type: "reference-line", referenceLine: "right", target: "exterior" }], stopOnMatch: true },
];

/** Beispielprojekt, ergänzt um alle Element-Arten, die es selbst nicht enthält. */
export function richProject(): Project {
  const lvl = sampleProject.drawingLevels[0].id;
  return {
    ...sampleProject,
    formatVersion: 3,
    // Blatt-Ebene des Layouts „lay1" (2D-Zeichnung auf dem Blatt).
    drawingLevels: [...sampleProject.drawingLevels, { id: "sheet-lay1", name: "Blatt 1", kind: "drawing", visible: true, locked: false, layoutId: "lay1" }],
    textStyles: [{ id: "ts1", label: "Titel", marks: { bold: true, font: "Helvetica", sizePt: 14 } }],
    blockDefs: [{ id: "blk1", name: "Nordpfeil", geom2d: geoms.slice(0, 4) }],
    pens: [{ id: "pen1", name: "Kontur" }],
    penSets: [{ id: "ps1", name: "Standard", pens: { pen1: { color: "#000000", weight: 0.35 } } }],
    activePenSetId: "ps1",
    customPalettes: [{ id: "pal1", name: "Projekt", colors: ["#ff0000", "#00ff00"], visible: true }],
    builtinPaletteBanks: { ral: false, tango: true },
    roomProgram: [{ name: "Wohnen", siaCategory: "HNF", area: 30, count: 2, group: "Wohnung", note: "Süd" }],
    roomProgramTolerance: 0.1,
    parcelArea: 812,
    sunStudy: { when: "2026-06-21T12:00", show: true },
    siteRules: {
      parcel: [{ x: -5, y: -5 }, { x: 30, y: -5 }, { x: 30, y: 30 }],
      setbacks: [3, 4, 5], defaultSetback: 4, buildingLines: [{ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }], maxHeight: 15, show: true,
    },
    scaleLineWeights: true,
    drawings2d: geoms.map((geom, i) => ({
      id: `d${i}`, type: "drawing2d" as const, levelId: lvl, categoryCode: "90", geom,
      ...(i % 2 ? { noPrint: true, endMarks: { start: "arrow" as const, end: "dot" as const, sizeMm: 2 }, opacity: 0.8 } : {}),
      ...(i % 3 === 0 ? { hatchOrigin: { x: 1, y: 1 }, hatchSource: "layer" as const, weightMm: 0.5, fillColor: "#eeeeee" } : {}),
    })),
    context: [
      { type: "importedMesh", id: "c1", name: "Nachbar", layer: "L", categoryCode: "95", color: "#aabbcc", ifcGlobalId: "2O2Fr$t4X7Zf8NOew3FLOH", positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
      {
        type: "contourSet", id: "c2", name: "Höhenlinien", contours: [
          { z: 400, pts: [{ x: 0, y: 0 }, { x: 5, y: 1 }], closed: false, layer: "HL", filled: true },
          { z: 401, pts: [], closed: false, curve: { kind: "arc", cx: 0, cy: 0, r: 2, a0: 0, a1: 1 } },
        ],
      },
      { type: "terrainMesh", id: "c3", name: "Gelände", positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], vertexColors: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
      { type: "image", id: "c4", name: "Luftbild", src: "data:image/png;base64,AAAA", min: { x: 0, y: 0 }, max: { x: 10, y: 10 }, opacity: 0.7, drape: true, filters: { saturation: 0.5, grayscale: 1 } },
    ],
    extrudedSolids: [
      { id: "x1", type: "extrudedSolid", levelId: lvl, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], height: 2, baseOffset: 0.1, operation: "subtract", taper: 0.1, cornerRadius: 0.05, chamfer: 0.02 },
      { id: "x2", type: "extrudedSolid", levelId: lvl, points: [], height: 1, circle: { center: { x: 3, y: 3 }, r: 0.4 }, brep: { spec: { kind: "box", w: 1, nested: { a: [1, 2] } }, origin: { x: 0, y: 0 }, label: "Quader" } },
    ],
    columns: [
      {
        id: "col1", type: "column", floorId: lvl, categoryCode: "50", position: { x: 2, y: 2 }, profile: { kind: "round", radius: 0.15 },
        rotation: 0, height: 2.6, bottom: { mode: "floor", floorId: lvl, offset: -0.1 }, top: { mode: "custom", z: 3 }, strokeWeightSource: "object",
      },
      { id: "col2", type: "column", floorId: lvl, categoryCode: "50", position: { x: 4, y: 2 }, profile: { kind: "rect", width: 0.3, depth: 0.2 }, rotation: 0.5, height: 2.6 },
    ],
    groups: [{ id: "g1", name: "Gruppe", wallIds: [sampleProject.walls[0].id], drawingIds: ["d1"], ceilingIds: [], roomIds: [], stairIds: [], columnIds: ["col1"], roofIds: [], openingIds: [], groupIds: [] }],
    parametricWalls: [{ id: "pw1", name: "Raster", description: "Test", rules, defaultWallTypeId: sampleProject.wallTypes[0].id }],
    overrideRules: [{ id: "or1", name: "Rot", enabled: true, condition: { type: "layer_name", operator: "contains", value: "Wand" }, actions: { color: "#ff0000", lineweight: 0.5 } }],
    viewSnapshots: [{
      id: "vs1", name: "EG", folderId: "vf1", viewType: "grundriss", view3d: "isoBackLeft", fov: 50, scaleDenominator: 100, detail: "fein", activeLevelId: lvl,
      layerVisibility: { "10": true, "20": false }, drawingVisibility: { [lvl]: true }, enabledOverrideRuleIds: ["or1"], cameraCenter: { x: 1, y: 2 }, cameraPxPerMeter: 40,
    }],
    viewSnapshotFolders: [{ id: "vf1", name: "Pläne" }, { id: "vf2", name: "Unter", parentId: "vf1" }],
    layouts: [{ id: "lay1", name: "Blatt 1", paper: "a3", orientation: "landscape", planNumber: "A-12", masterId: "m1", folderId: "lf1", viewports: [{ id: "vp1", snapshotId: "vs1", xMm: 10, yMm: 10, widthMm: 200, heightMm: 150, scaleDenominator: 50 }] }],
    masterLayouts: [{ id: "m1", name: "Master", paper: "a3", orientation: "landscape", titleBlock: { projectName: "P", sheetName: "S", scale: "1:100", date: "28.10.", author: "K" }, border: true }],
    layoutFolders: [{ id: "lf1", name: "Pläne", kind: "layout" }],
    referenceElevationMasl: 432.1,
    geoAnchor: { lv95: { e: 2600000, n: 1200000 }, height: 432, model: { x: 0, y: 0 }, label: "Bern" },
  };
}

/** Zufallsgenerator mit Saat (LCG, reproduzierbar). */
export function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

// Optionale Projekt-Felder (laut Typ) — dürfen in Zufallsprojekten fehlen.
const OPTIONAL_KEYS = [
  "formatVersion", "textStyles", "ceilingTypes", "roofTypes", "blockDefs", "doorTypes", "windowTypes", "stairTypes", "pens", "penSets",
  "activePenSetId", "customPalettes", "builtinPaletteBanks", "roomProgram", "roomProgramTolerance", "parcelArea", "sunStudy", "siteRules",
  "scaleLineWeights", "ceilings", "roofs", "openings", "stairs", "rooms", "context", "extrudedSolids", "columns", "groups",
  "parametricWalls", "overrideRules", "viewSnapshots", "viewSnapshotFolders", "layouts", "masterLayouts", "layoutFolders",
  "referenceElevationMasl", "geoAnchor",
] as const satisfies readonly (keyof Project)[];

/** Zufallsprojekt: Listen gemischt/gekürzt/verdoppelt, Zahlen verrauscht, optionale Felder weggelassen. */
export function randomProject(seed: number): Project {
  const r = rng(seed);
  const jitter = (v: unknown, depth = 0): unknown => {
    if (typeof v === "number") return r() < 0.5 ? v : Math.round((v + (r() - 0.5) * 10) * 1e6) / 1e6;
    if (Array.isArray(v)) {
      let a = v.map((x) => jitter(x, depth + 1));
      if (depth === 1 && a.length > 1 && r() < 0.3) a = a.filter(() => r() < 0.7);
      if (depth === 1 && r() < 0.2) a = [...a].reverse();
      return a;
    }
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jitter(x, depth + 1)]));
    return v;
  };
  const p = jitter(plain(richProject()), 0) as Record<string, unknown>;
  for (const k of OPTIONAL_KEYS) if (r() < 0.25) delete p[k];
  return p as unknown as Project;
}
