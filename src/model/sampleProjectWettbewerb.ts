// „Wettbewerb": kleiner, plausibler Stand eines Wettbewerbsbeitrags für ein Mehrfamilienhaus (Schweiz, LV95) — die Vorlage
// zur Kurzanleitung „Erster Wettbewerb mit Dossier" (`doc/KURZANLEITUNG.md`, [210]). Alle Schritte des Referenz-Ablaufs
// ([206]) sind darin schon einmal gemacht: Parzelle mit Baurecht-Angaben, drei Geschosse mit Aussen- und Innenwänden,
// Decken, Treppe, Flachdach, Räume mit Raumprogramm, Schnitte und Ansichten, Situation und ein Präsentationsplan A1.
//
// Erzeugt deterministisch (feste ids, Kern-Befehle mit festem Stempel); braucht den geladenen Rust-Kern wie
// `sampleProjectComplex.ts`. Nur bestehende Modellfelder.
//
// Lage (x = Ost, y = Nord): Baukörper 20 × 12 m (Wandachsen), Treppenhaus in der Mitte (x 8–12), je eine Wohnung pro
// Geschoss und Seite (West/Ost), Eingang von Norden (Strasse). EG = ±0.00 (= 441.30 m ü. M.), Geschosshöhe 3.00 m, Flachdach
// mit Attika auf +9.00 m.

import type {
  CeilingType,
  DoorType,
  Drawing2D,
  Drawing2DGeom,
  DrawingLevel,
  Opening,
  Project,
  Room,
  RoomStamp,
  RoofType,
  SiaCategory,
  Vec2,
  Wall,
  WindowType,
} from "./types";
import { sampleProject } from "./sampleProject";
import { withStandards } from "./standards";
import { buildingsToMesh, type GeoFeature } from "../io/geoContext";
import { applyOps, type CoreOp } from "../core/ops";
import { withDocument } from "../core/document";
import { presentationDefaults, presentationSheetOps } from "../plan/presentationSheet";

const P = (x: number, y: number): Vec2 => ({ x, y });
const HA = 0.39 / 2;
const L = (componentId: string, thickness: number) => ({ componentId, thickness });
/** Geschosse: id, Name, Sockelhöhe. */
const FLOORS = [
  { id: "eg", name: "Erdgeschoss", z: 0 },
  { id: "og1", name: "1. Obergeschoss", z: 3 },
  { id: "og2", name: "2. Obergeschoss", z: 6 },
] as const;
const FH = 3.0;
const W = 20;
const D = 12;

const LEVELS: DrawingLevel[] = [
  ...FLOORS.map((f, i): DrawingLevel => ({
    id: f.id, name: f.name, kind: "floor", visible: true, locked: false, floorHeight: FH, cutHeight: 1.0, baseElevation: f.z,
    ...(i === 0 ? { zeroLevel: true } : {}), viewTop: FH, viewBottom: 0, viewDepth: i === 0 ? -0.5 : -0.3,
  })),
  { id: "schnitt-a", name: "Schnitt A-A", kind: "section", visible: true, locked: false, linePoints: [P(10, -10), P(10, 20)], directionSign: 1, levelMarks: true },
  { id: "schnitt-b", name: "Schnitt B-B", kind: "section", visible: true, locked: false, linePoints: [P(-8, 3.5), P(28, 3.5)], directionSign: 1, levelMarks: true },
  { id: "ansicht-sued", name: "Ansicht Süd", kind: "elevation", visible: true, locked: false, linePoints: [P(-10, -12), P(30, -12)], directionSign: 1, shadows: true, levelMarks: true },
  { id: "ansicht-ost", name: "Ansicht Ost", kind: "elevation", visible: true, locked: false, linePoints: [P(34, -8), P(34, 20)], directionSign: 1, shadows: true, levelMarks: true },
  { id: "ansicht-nord", name: "Ansicht Nord", kind: "elevation", visible: true, locked: false, linePoints: [P(30, 24), P(-10, 24)], directionSign: 1, shadows: true, levelMarks: true },
  { id: "ansicht-west", name: "Ansicht West", kind: "elevation", visible: true, locked: false, linePoints: [P(-14, 20), P(-14, -8)], directionSign: 1, shadows: true, levelMarks: true },
];

const CEILING_TYPES: CeilingType[] = [
  { id: "wb-ct-decke", name: "Geschossdecke Unterlagsboden, Trittschall, STB 37 cm", layers: [L("std-c-parkett", 0.015), L("std-c-zementestrich", 0.065), L("std-c-trittschall", 0.04), L("std-c-stahlbeton", 0.24), L("std-c-innenputz", 0.01)] },
  { id: "wb-ct-bodenplatte", name: "Bodenplatte STB auf XPS", layers: [L("std-c-zementestrich", 0.08), L("std-c-xps", 0.12), L("std-c-stahlbeton", 0.25), L("std-c-kies", 0.1)] },
];
const ROOF_TYPES: RoofType[] = [{ id: "wb-rt-flach", name: "Flachdach Umkehrdach bekiest", layers: [L("std-c-kies", 0.06), L("std-c-xps", 0.18), L("std-c-stahlbeton", 0.22)] }];
const WINDOW_TYPES: WindowType[] = [
  {
    id: "wb-fe", name: "Holz-Metall Dreh-Kipp", kind: "drehkipp", wingCount: 1, glazing: "dreifach", frameThickness: 0.08, frameDepth: 0.08, frameWidth: 0.08,
    insetFromFace: 0.18, insetFace: "aussen", rebateDepth: 0.05, lintelHeight: 0.22, sillBoard: "beide", defaultSillHeight: 0.9, defaultWidth: 1.2, defaultHeight: 1.4,
  },
];
const DOOR_TYPES: DoorType[] = [
  { id: "wb-tu", name: "Wohnungstür", kind: "dreh", leafCount: 1, leafStyle: "glatt", frameThickness: 0.05, frameKind: "umfassungszarge", frameWidth: 0.05, defaultWidth: 0.9, defaultHeight: 2.1 },
  { id: "wb-tu-innen", name: "Zimmertür", kind: "dreh", leafCount: 1, leafStyle: "glatt", frameThickness: 0.05, frameKind: "umfassungszarge", frameWidth: 0.05, defaultWidth: 0.8, defaultHeight: 2.1 },
  { id: "wb-tu-haus", name: "Haustür Glas", kind: "dreh", leafCount: 1, leafStyle: "glas", glazingRatio: 0.4, frameThickness: 0.08, frameKind: "blockrahmen", frameWidth: 0.09, threshold: true, defaultWidth: 1.2, defaultHeight: 2.3 },
];
const STAIR_TYPES = [{ id: "wb-tr-beton", name: "Ortbetontreppe mit Geländer rechts", structure: "beton" as const, closedRisers: true, treadThickness: 0.03, nosing: 0.02, railing: "rechts" as const, defaultWidth: 1.1 }];

// ── Wände ───────────────────────────────────────────────────────────────────

const walls: Wall[] = [];
const wall = (id: string, floorId: string, a: Vec2, b: Vec2, typeId: string, extra: Partial<Wall> = {}) =>
  walls.push({ id, type: "wall", floorId, categoryCode: "20", start: a, end: b, wallTypeId: typeId, height: FH, ...extra });
for (const f of FLOORS) {
  const ext = { isExternal: true, loadBearing: true };
  // Aussenwände im Gegenuhrzeigersinn (aussen = rechts).
  wall(`${f.id}-aw-s`, f.id, P(0, 0), P(W, 0), "std-wt-aw-kompakt", ext);
  wall(`${f.id}-aw-o`, f.id, P(W, 0), P(W, D), "std-wt-aw-kompakt", ext);
  wall(`${f.id}-aw-n`, f.id, P(W, D), P(0, D), "std-wt-aw-kompakt", ext);
  wall(`${f.id}-aw-w`, f.id, P(0, D), P(0, 0), "std-wt-aw-kompakt", ext);
  // Treppenhauswände (tragend), Wohnungstrennwände Nord, Quertrennwand im Treppenhaus.
  wall(`${f.id}-iw-x8`, f.id, P(8, 0), P(8, D), "std-wt-iw-backstein", { loadBearing: true });
  wall(`${f.id}-iw-x12`, f.id, P(12, 0), P(12, D), "std-wt-iw-backstein", { loadBearing: true });
  wall(`${f.id}-iw-th`, f.id, P(8, 7), P(12, 7), "std-wt-iw-backstein");
  for (const [side, x0, x1, xz, xb] of [["w", 0, 8, 4, 4], ["o", 12, 20, 16, 16]] as const) {
    wall(`${f.id}-iw-${side}-y7`, f.id, P(x0, 7), P(x1, 7), "std-wt-iw-backstein");
    wall(`${f.id}-iw-${side}-zimmer`, f.id, P(xz, 7), P(xz, D), "std-wt-iw-backstein");
    // Bad/Diele: Wand zwischen Diele (Seite Treppenhaus) und Bad.
    const [bx0, bx1] = side === "w" ? [xb, 8] : [12, xb];
    wall(`${f.id}-iw-${side}-bad`, f.id, P(bx0, 9.5), P(bx1, 9.5), "std-wt-iw-backstein");
  }
}

// ── Öffnungen ───────────────────────────────────────────────────────────────

const openings: Opening[] = [];
let winNo = 0;
let doorNo = 0;
const win = (id: string, host: string, pos: number, w: number, h: number, sill: number) =>
  openings.push({ id, type: "opening", hostWallId: host, categoryCode: "21", kind: "window", typeId: "wb-fe", position: pos, width: w, height: h, sillHeight: sill, mark: `F${String(++winNo).padStart(2, "0")}`, uValue: 0.9, isExternal: true });
const door = (id: string, host: string, typeId: string, pos: number, w: number, h: number, extra: Partial<Opening> = {}) =>
  openings.push({ id, type: "opening", hostWallId: host, categoryCode: "21", kind: "door", typeId, position: pos, width: w, height: h, sillHeight: 0, mark: `T${String(++doorNo).padStart(2, "0")}`, swing: "left", hinge: "start", ...extra });
for (const f of FLOORS) {
  const i = f.id;
  // Süd: zwei Wohnräume je Seite, Treppenhaus. Ost/West-Wände laufen im Gegenuhrzeigersinn (Ost von Süd nach Nord, West von Nord nach Süd).
  for (const [n, pos] of [[1, 2.2], [2, 5.8], [3, 10], [4, 14.2], [5, 17.8]] as const) win(`${i}-f-s${n}`, `${i}-aw-s`, pos, n === 3 ? 1.2 : 1.6, 1.5, 0.9);
  win(`${i}-f-o1`, `${i}-aw-o`, 3.5, 1.8, 1.5, 0.9);
  win(`${i}-f-o2`, `${i}-aw-o`, 9.5, 1.2, 1.4, 0.9);
  win(`${i}-f-w1`, `${i}-aw-w`, 2.5, 1.2, 1.4, 0.9);
  win(`${i}-f-w2`, `${i}-aw-w`, 8.5, 1.8, 1.5, 0.9);
  // Nord (Position von Osten): Zimmer Ost x = 18, Bad Ost 14, Abstell/Eingang 10, Bad West 6, Zimmer West 2.
  win(`${i}-f-n1`, `${i}-aw-n`, 2, 1.2, 1.4, 0.9);
  win(`${i}-f-n2`, `${i}-aw-n`, 6, 0.6, 0.9, 1.3);
  win(`${i}-f-n4`, `${i}-aw-n`, 14, 0.6, 0.9, 1.3);
  win(`${i}-f-n5`, `${i}-aw-n`, 18, 1.2, 1.4, 0.9);
  if (i === "eg") door("eg-t-haus", "eg-aw-n", "wb-tu-haus", 10, 1.2, 2.3, { isExternal: true, uValue: 1.2, hinge: "end" });
  else win(`${i}-f-n3`, `${i}-aw-n`, 10, 1.2, 1.4, 0.9);
  door(`${i}-t-th`, `${i}-iw-th`, "wb-tu", 2, 1.0, 2.1);
  door(`${i}-t-wohnung-w`, `${i}-iw-x8`, "wb-tu", 3.5, 0.9, 2.1, { fireRating: "EI30" });
  door(`${i}-t-wohnung-o`, `${i}-iw-x12`, "wb-tu", 3.5, 0.9, 2.1, { fireRating: "EI30", swing: "right" });
  // [256] Innentüren je Wohnung: Wohnen → Diele, Diele → Zimmer und Bad (Plan-Review 1:100: Zimmer/Bad ohne Zugang).
  for (const side of ["w", "o"] as const) {
    const o = side === "o";
    door(`${i}-t-${side}-diele`, `${i}-iw-${side}-y7`, "wb-tu-innen", o ? 2 : 6, 0.9, 2.1);
    door(`${i}-t-${side}-zimmer`, `${i}-iw-${side}-zimmer`, "wb-tu-innen", 1.25, 0.8, 2.1, o ? { swing: "right" } : {});
    door(`${i}-t-${side}-bad`, `${i}-iw-${side}-bad`, "wb-tu-innen", 2, 0.8, 2.1, o ? { swing: "right" } : {});
  }
}

// ── Decken, Treppen, Dach ───────────────────────────────────────────────────

const slab = [P(-HA, -HA), P(W + HA, -HA), P(W + HA, D + HA), P(-HA, D + HA)];
const HOLE = [P(9.4, 1.3), P(10.6, 1.3), P(10.6, 5.8), P(9.4, 5.8)];
const ceilings: NonNullable<Project["ceilings"]> = [
  { id: "c-bodenplatte", type: "ceiling", floorId: "eg", categoryCode: "30", outline: slab, wallTypeId: "", ceilingTypeId: "wb-ct-bodenplatte", top: { mode: "floor", floorId: "eg", offset: 0 }, loadBearing: true },
  { id: "c-eg", type: "ceiling", floorId: "eg", categoryCode: "30", outline: slab, openings: [HOLE], wallTypeId: "", ceilingTypeId: "wb-ct-decke", loadBearing: true },
  { id: "c-og1", type: "ceiling", floorId: "og1", categoryCode: "30", outline: slab, openings: [HOLE], wallTypeId: "", ceilingTypeId: "wb-ct-decke", loadBearing: true },
];
const stairs: NonNullable<Project["stairs"]> = ["eg", "og1"].map((f) => ({
  id: `tr-${f}`, type: "stair" as const, floorId: f, categoryCode: "40", shape: "straight" as const, typeId: "wb-tr-beton", start: P(10, 1.4), dir: P(0, 1), runLength: 4.3, width: 1.1, totalRise: FH, stepCount: 17,
}));
const roofs: NonNullable<Project["roofs"]> = [
  {
    id: "dach-flach", type: "roof", floorId: "og2", categoryCode: "31", outline: slab, shape: "flach", pitchDeg: 0, overhang: 0, ridgeAxis: "x", thickness: 0.46, roofTypeId: "wb-rt-flach",
    // Attika: Betonbrüstung 50 cm über der Dachhaut.
    parapetHeight: 0.5, parapetWidth: 0.2, parapetComponentId: "std-c-stahlbeton",
  },
];

// ── Kataster, Kontext, Baurecht ─────────────────────────────────────────────

const PARCEL = [P(-6, -6), P(28, -7), P(29, 19), P(-5, 20)];

function cadastre(): Drawing2D[] {
  const d: Drawing2D[] = [];
  const add = (id: string, geom: Drawing2DGeom, extra: Partial<Drawing2D> = {}) =>
    d.push({ id, type: "drawing2d", levelId: "eg", categoryCode: "01", geom, lineStyleId: "std-ls-grundstueck", weightMm: 0.35, ...extra });
  add("kat-parzelle", { shape: "polyline", pts: PARCEL, closed: true });
  add("kat-nachbar-w", { shape: "polyline", pts: [P(-5, 20), P(-30, 21), P(-31, -5), P(-6, -6)], closed: false }, { weightMm: 0.25 });
  add("kat-nachbar-o", { shape: "polyline", pts: [P(28, -7), P(52, -8), P(53, 18), P(29, 19)], closed: false }, { weightMm: 0.25 });
  add("kat-nachbar-s", { shape: "line", a: P(-6, -6), b: P(-5, -28) }, { weightMm: 0.25 });
  add("kat-nachbar-s2", { shape: "line", a: P(28, -7), b: P(29, -29) }, { weightMm: 0.25 });
  // Strasse im Norden.
  add("str-rand-s", { shape: "line", a: P(-30, 21.5), b: P(52, 19.5) }, { categoryCode: "11", lineStyleId: "std-ls-voll", weightMm: 0.25 });
  add("str-rand-n", { shape: "line", a: P(-30, 27.5), b: P(52, 25.5) }, { categoryCode: "11", lineStyleId: "std-ls-voll", weightMm: 0.25 });
  add("str-achse", { shape: "line", a: P(-30, 24.5), b: P(52, 22.5) }, { categoryCode: "11", lineStyleId: "std-ls-strichpunkt", weightMm: 0.13 });
  const label = (id: string, at: Vec2, text: string, h = 0.6) => add(id, { shape: "text", at, text, height: h, angle: 0 }, { lineStyleId: undefined });
  label("kat-nr", P(8, -4), "Kat.-Nr. 1187  (880 m²)");
  label("kat-nr-w", P(-26, 6), "Kat.-Nr. 1186");
  label("kat-nr-o", P(36, 6), "Kat.-Nr. 1188");
  label("str-name", P(20, 23.2), "Hofwiesenstrasse", 0.8);
  [P(-2, -3), P(25, -3), P(26, 16)].forEach((c, i) => add(`baum-${i + 1}`, { shape: "circle", center: c, r: 1.8 + (i % 2) * 0.5 }, { categoryCode: "13", lineStyleId: "std-ls-voll", weightMm: 0.13 }));
  return d;
}

function neighbours() {
  const b = (pts: Vec2[], height: number): GeoFeature => ({ category: "building", pts, closed: true, height });
  const mesh = buildingsToMesh(
    [
      b([P(-26, 0), P(-14, 0), P(-14, 10), P(-26, 10)], 9),
      b([P(36, 0), P(46, 0), P(46, 12), P(36, 12)], 9),
      b([P(-4, 32), P(24, 32), P(24, 40), P(-4, 40)], 12),
    ],
    "Kataster (fiktiv)",
  );
  if (!mesh) throw new Error("Wettbewerb: Nachbargebäude nicht erzeugt");
  return { ...mesh, id: "nachbarn", name: "Nachbargebäude" };
}

// ── Kern-Befehle ────────────────────────────────────────────────────────────

let stampSeq = 0;
function runCmd(p: Project, level: string, cmd: string, req: Record<string, unknown>, cat = "20"): Project {
  const lvl = p.drawingLevels.find((l) => l.id === level);
  const ops = withDocument(p, (d) => d.cmdOps({
    cmd, ...req, ctx: { level, floorHeight: lvl?.floorHeight ?? null, cat, wallType: "std-wt-iw-backstein" }, stamp: `wb${++stampSeq}`,
  }));
  return ops.length ? applyOps(p, ops) : p;
}

type RoomDef = [at: Vec2, key: string, name: string, sia: SiaCategory];
const ROOMS_PER_FLOOR: RoomDef[] = [
  [P(4, 3.5), "01", "Wohnen/Essen", "HNF"],
  [P(2, 9.5), "02", "Zimmer", "HNF"],
  [P(6, 8.2), "03", "Diele", "HNF"],
  [P(6, 10.8), "04", "Bad", "NNF"],
  [P(16, 3.5), "05", "Wohnen/Essen", "HNF"],
  [P(18, 9.5), "06", "Zimmer", "HNF"],
  [P(14, 8.2), "07", "Diele", "HNF"],
  [P(14, 10.8), "08", "Bad", "NNF"],
  [P(10, 6.5), "09", "Treppenhaus", "VF"],
  [P(10, 9.5), "10", "Abstellraum", "NNF"],
];

function addRooms(p: Project): Project {
  const prefix = { eg: "E", og1: "1", og2: "2" } as const;
  for (const f of FLOORS) {
    for (const [at, key, baseName, sia] of ROOMS_PER_FLOOR) {
      const name = f.id === "eg" && key === "10" ? "Eingang" : baseName;
      const cat: SiaCategory = f.id === "eg" && key === "10" ? "VF" : sia;
      const nr = `${prefix[f.id]}.${key}`;
      const lvl = p.drawingLevels.find((l) => l.id === f.id);
      const ops = withDocument(p, (d) => d.cmdOps({ cmd: "room", at: [at.x, at.y], ctx: { level: f.id, floorHeight: lvl?.floorHeight ?? null, cat: "60", wallType: "" }, stamp: `raum${nr}` }));
      const made = ops.find((o) => o.kind === "add" && o.collection === "rooms");
      if (!made || made.kind !== "add") throw new Error(`Wettbewerb: Raum ${nr} nicht erkannt`);
      const stamp: RoomStamp = { number: nr, name, showFloorArea: true, showUsage: false, roundingStep: 0.1 };
      const room = { ...(made.items[0] as unknown as Room), id: `raum-${nr}`, name, siaCategory: cat, stamp };
      p = applyOps(p, [{ kind: "add", collection: "rooms", items: [room as unknown as { id: string }] } as CoreOp]);
    }
  }
  return p;
}

const codesOf = (ls: Project["layers"]): string[] => ls.flatMap((l) => [l.code, ...codesOf(l.children ?? [])]);
const visHidden = (hidden: string[]): Record<string, boolean> => Object.fromEntries(codesOf(sampleProject.layers).map((c) => [c, !hidden.includes(c)]));
/** Klassen, die die Situation ausblendet (wie `standards.rs::SITUATION_HIDDEN`). */
const SITUATION_HIDDEN = ["00", "07", "20", "21", "22", "25", "30", "35", "40", "50", "60", "80", "81", "82", "85", "90", "91", "92", "99"];
const LEVEL_VIS: Record<string, boolean> = Object.fromEntries(LEVELS.map((l) => [l.id, true]));
const pxPerMeterAt = (scale: number) => Math.round(((96 / 25.4) * 1000) / scale * 100) / 100;

/** Wettbewerb — neues Projekt (braucht den geladenen Kern). */
export function buildWettbewerbSampleProject(): Project {
  stampSeq = 0;
  const base: Project = {
    id: "wettbewerb",
    name: "Wettbewerb Hofwiesen",
    projectNumber: "2701",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    ceilingTypes: CEILING_TYPES,
    roofTypes: ROOF_TYPES,
    windowTypes: WINDOW_TYPES,
    doorTypes: DOOR_TYPES,
    stairTypes: STAIR_TYPES,
    drawingLevels: LEVELS,
    layers: sampleProject.layers,
    scaleLineWeights: true,
    walls,
    openings,
    ceilings,
    roofs,
    stairs,
    rooms: [],
    drawings2d: cadastre(),
    context: [neighbours()],
    // Raumprogramm des Wettbewerbs (Soll); die Räume im Modell liefern das Ist.
    roomProgram: [
      { name: "Wohnen/Essen", siaCategory: "HNF", area: 50, count: 6, group: "Wohnungen", note: "je Wohnung" },
      { name: "Zimmer", siaCategory: "HNF", area: 20, count: 6, group: "Wohnungen" },
      { name: "Diele", siaCategory: "HNF", area: 8, count: 6, group: "Wohnungen" },
      { name: "Bad", siaCategory: "NNF", area: 8, count: 6, group: "Nasszellen" },
      { name: "Treppenhaus", siaCategory: "VF", area: 25, count: 3, group: "Erschliessung" },
      { name: "Eingang", siaCategory: "VF", area: 18, count: 1, group: "Erschliessung" },
      { name: "Abstellraum", siaCategory: "NNF", area: 17, count: 2, group: "Nebenräume" },
    ],
    roomProgramTolerance: 0.1,
    parcelArea: 880,
    sunStudy: { when: "2027-03-21T14:00:00Z", show: true },
    siteRules: {
      parcel: PARCEL,
      // Grenzabstände je Parzellenkante (Süd, Ost, Nord/Strasse, West).
      setbacks: [4, 4, 5, 4], defaultSetback: 4,
      maxHeight: 12, show: true, show3d: true,
    },
    referenceElevationMasl: 441.3,
    geoAnchor: { lv95: { e: 2697450, n: 1261800 }, height: 441.3, model: P(0, 0), label: "Hofwiesenstrasse, 8400 Winterthur (fiktiv)" },
  };

  // Standard-Bibliothek SIA 400 (Baustoffe, Schraffuren, Linientypen, Aufbauten, Ansichtsvorlagen).
  let p = withStandards(base);
  p = addRooms(p);
  // Aussenbemassung (Massketten je Fassade), Klasse „81 Auto-Bemassung" (Befehl `autodim`).
  for (const f of FLOORS) p = runCmd(p, f.id, "autodim", {}, "80");

  // Ansichten der Abgabe: Situation 1:500 (Standard-Vorlage) und Schnitte/Ansichten ohne Nachbargebäude.
  const noNeighbours = visHidden(["12"]);
  const snap = (id: string, name: string, level: string, scale: number, center: Vec2, extra: Record<string, unknown> = {}) => ({
    id, name, viewType: "grundriss" as const, view3d: "iso" as const, scaleDenominator: scale, detail: "mittel" as const, activeLevelId: level,
    layerVisibility: visHidden(["12"]), drawingVisibility: LEVEL_VIS, cameraCenter: center, cameraPxPerMeter: pxPerMeterAt(scale), ...extra,
  });
  p = {
    ...p,
    viewSnapshots: [
      snap("vs-situation", "Situation 1:500", "eg", 500, P(10, 6), { detail: "grob", templateId: "std-vt-situation-wbw", templateLinked: true, layerVisibility: { ...visHidden(SITUATION_HIDDEN), "17": true } }),
      snap("vs-schnitt-a", "Schnitt A-A", "schnitt-a", 200, P(8, 4.5), { layerVisibility: noNeighbours }),
      snap("vs-schnitt-b", "Schnitt B-B", "schnitt-b", 200, P(8, 4.5), { layerVisibility: noNeighbours }),
    ],
    layouts: [
      { id: "lay-situation", name: "Situation 1:500", paper: "a3", orientation: "landscape", planNumber: "001", viewports: [{ id: "vp-situation", snapshotId: "vs-situation", xMm: 20, yMm: 20, widthMm: 380, heightMm: 260, scaleDenominator: 500 }] },
    ],
  };

  // Präsentationsplan A1 (Mappe → Präsentationsplan): Grundrisse, Ansichten und Schnitt A-A im gemeinsamen Massstab 1:200.
  // `planPresentationSheet` fragt das Kern-Dokument ab: das neue Projekt dafür ausdrücklich öffnen (sonst Fehlermeldung in der Konsole).
  const res = withDocument(p, () => presentationSheetOps(
    p,
    { ...presentationDefaults(p), scale: 200 },
    { sheetName: "Präsentationsplan", masterName: "Planrahmen A1 quer", north: "N", northGroup: "Nordpfeil", scaleBarGroup: "Massstabsbalken" },
    "wb",
  ));
  if (!res) throw new Error("Wettbewerb: Präsentationsplan nicht erzeugt");
  return applyOps(p, res.ops);
}
