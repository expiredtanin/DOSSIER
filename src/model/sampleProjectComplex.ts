// „Musterhaus komplex": Zweifamilienhaus am Südhang mit Untergeschoss, Erd-, Ober- und Dachgeschoss —
// ein Beispielprojekt, in dem möglichst alle Funktionen zum Zug kommen (Gelände aus Höhenlinien,
// Baugrube, Baurecht, SIA-400-Standards, Schichtaufbauten, Bogenwand, Dach an Dach, Gauben,
// Dachfenster, alle Türrahmen-Arten, Formfenster, Treppen, Räume nach SIA 416, Bemassung, Details,
// Schnitte/Ansichten, Ansichtsvorlagen, Layouts mit Listen und Publikationssatz).
//
// Erzeugt deterministisch (gleiche Eingabe → gleiches Projekt): feste ids, Kern-Befehle mit festem
// Stempel. Braucht den geladenen Rust-Kern (Standards, Raumerkennung, Gelände, Aussenbemassung,
// Rotationskörper/Loft laufen über `cmdOps`). Abschnitte je Bauteil-Gruppe, Masse in Metern.
//
// Lage (x = Ost, y = Nord): Haupthaus 15 × 10 m (Wandachsen), Anbau Nord 5 × 5 m (Eingang, T-Dach),
// runder Erker Ost (Bogenwand r = 2 m, Wendeltreppe UG → EG), Carport West. Das Gelände fällt nach
// Süden: das UG liegt im Norden im Hang, im Süden frei (Gartengeschoss).
// Höhen: Geschosse gestapelt ab UG = 0.00 (wie `recomputeFloorElevations`): UG 0.00, EG 2.70,
// OG 5.60, DG 8.40. Gelände und absolute Höhen (Dachfuss, Baugrube) im selben System.

import type {
  CeilingType,
  Drawing2D,
  Drawing2DGeom,
  DoorType,
  DrawingLevel,
  LayerCategory,
  Opening,
  Project,
  RichTextDoc,
  Room,
  RoomStamp,
  SiaCategory,
  Vec2,
  Wall,
  WallType,
  WindowType,
  RoofType,
} from "./types";
import { sampleProject } from "./sampleProject";
import { withStandards } from "./standards";
import { applyOps, type CoreOp } from "../core/ops";
import { documentFor } from "../core/document";

// ═════════════════════════════════════════════════════════════════════════════
// Hilfen
// ═════════════════════════════════════════════════════════════════════════════

const P = (x: number, y: number): Vec2 => ({ x, y });
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Rechteck (Gegenuhrzeigersinn). */
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];

/** Bogenpunkte um `c` (Radius r) von a0 bis a1 (Bogenmass), n Teilstücke, ohne/mit Endpunkte. */
function arcPts(c: Vec2, r: number, a0: number, a1: number, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push(P(r3(c.x + r * Math.cos(a)), r3(c.y + r * Math.sin(a))));
  }
  return out;
}

/** Kreis als Polygon (n Ecken). */
const circlePts = (c: Vec2, r: number, n: number): Vec2[] => arcPts(c, r, 0, 2 * Math.PI, n).slice(0, n);

const textDoc = (lines: { text: string; bold?: boolean; sizePt?: number; italic?: boolean }[], align: "left" | "center" = "left"): RichTextDoc => ({
  version: 1,
  paragraphs: lines.map((l) => ({
    runs: [{ text: l.text, marks: { ...(l.bold ? { bold: true } : {}), ...(l.italic ? { italic: true } : {}), ...(l.sizePt ? { sizePt: l.sizePt } : {}) } }],
    align,
  })),
});

let stampSeq = 0;

/** Kern-Befehl auf dem Projekt rechnen und anwenden (wie die Zeichenbefehle der App, fester Stempel). */
function runCmd(p: Project, level: string, cmd: string, req: Record<string, unknown>, cat = "20"): { project: Project; ops: CoreOp[] } {
  const lvl = p.drawingLevels.find((l) => l.id === level);
  const ops = documentFor(p).cmdOps({
    cmd,
    ...req,
    ctx: { level, floorHeight: lvl?.floorHeight ?? null, cat, wallType: "std-wt-iw-backstein" },
    stamp: `mk${++stampSeq}`,
  });
  return { project: ops.length ? applyOps(p, ops) : p, ops };
}

// ═════════════════════════════════════════════════════════════════════════════
// Geschosse, Ebenen, Höhen
// ═════════════════════════════════════════════════════════════════════════════

const H = { ug: 2.7, eg: 2.9, og: 2.8, dg: 2.6 } as const;
const Z = { ug: 0, eg: 2.7, og: 5.6, dg: 8.4 } as const;
/** Traufhöhe (Dachfuss aussen) des Hauptdachs: 1.60 m über DG (Kniestock innen ≈ 1.2 m). */
const EAVE_MAIN = 10.0;
const PITCH = 38;
/** Wanddicke der Aussenwände (alle Aufbauten 39 cm, damit die Fluchten über die Geschosse stimmen). */
const AW = 0.39;
const HA = AW / 2;

const LEVELS: DrawingLevel[] = [
  { id: "ug", name: "Untergeschoss", kind: "floor", visible: true, locked: false, floorHeight: H.ug, cutHeight: 1.2, baseElevation: Z.ug, viewTop: 2.7, viewBottom: 0, viewDepth: -0.5, templateId: "vt-gr100", templateLinked: false },
  { id: "eg", name: "Erdgeschoss", kind: "floor", visible: true, locked: false, floorHeight: H.eg, cutHeight: 1.0, baseElevation: Z.eg, viewTop: 2.9, viewBottom: 0, viewDepth: -2.7, templateId: "vt-gr100", templateLinked: false },
  { id: "og", name: "Obergeschoss", kind: "floor", visible: true, locked: false, floorHeight: H.og, cutHeight: 1.0, baseElevation: Z.og, viewTop: 2.8, viewBottom: 0, viewDepth: -0.3, templateId: "vt-gr100", templateLinked: false },
  { id: "dg", name: "Dachgeschoss", kind: "floor", visible: true, locked: false, floorHeight: H.dg, cutHeight: 1.0, baseElevation: Z.dg, viewTop: 2.6, viewBottom: 0, viewDepth: -0.3, templateId: "vt-gr100", templateLinked: false },
  // Schnitte: A längs durch Schleppgaube und Dachfenster (Blick nach Westen), B quer durch Treppen und Erker (Blick nach Norden).
  { id: "schnitt-a", name: "Schnitt A-A", kind: "section", visible: true, locked: false, linePoints: [P(3, -9), P(3, 21)], directionSign: 1, hiddenLines: true, levelMarks: true, templateId: "vt-schnitt" },
  { id: "schnitt-b", name: "Schnitt B-B", kind: "section", visible: true, locked: false, linePoints: [P(-9, 5.6), P(20, 5.6)], directionSign: 1, hiddenLines: true, levelMarks: true, templateId: "vt-schnitt" },
  // Ansichten: Linie so, dass die Blickrichtung (linke Normale der Linie) zum Haus zeigt.
  { id: "ansicht-sued", name: "Ansicht Süd", kind: "elevation", visible: true, locked: false, linePoints: [P(-9, -10), P(20, -10)], directionSign: 1, shadows: true, levelMarks: true, templateId: "vt-ansicht" },
  { id: "ansicht-ost", name: "Ansicht Ost", kind: "elevation", visible: true, locked: false, linePoints: [P(24, -6), P(24, 20)], directionSign: 1, shadows: true, levelMarks: true, templateId: "vt-ansicht" },
  { id: "ansicht-nord", name: "Ansicht Nord", kind: "elevation", visible: true, locked: false, linePoints: [P(20, 22), P(-9, 22)], directionSign: 1, shadows: true, levelMarks: true, templateId: "vt-ansicht" },
  { id: "ansicht-west", name: "Ansicht West", kind: "elevation", visible: true, locked: false, linePoints: [P(-12, 20), P(-12, -6)], directionSign: 1, shadows: true, levelMarks: true, templateId: "vt-ansicht" },
  // 2D-Detail (Zeichnungsebene, Massstab 1:10 auf dem Detailblatt).
  { id: "detail-traufe", name: "Detail Deckenauflager 1:10", kind: "drawing", visible: true, locked: false },
];

const LAYERS: LayerCategory[] = [
  ...sampleProject.layers.map((l) =>
    l.code === "05"
      ? {
          ...l,
          children: [
            { code: "02", name: "Gelände", color: "#8a9478", lw: 0.13, visible: true, locked: false },
            { code: "07", name: "Baugrube", color: "#a07850", lw: 0.18, visible: true, locked: false },
            ...(l.children ?? []),
          ],
        }
      : l,
  ),
  { code: "80", name: "Bemassung", color: "#303038", lw: 0.13, visible: true, locked: false },
  { code: "85", name: "Details", color: "#202028", lw: 0.18, visible: true, locked: false },
];

// ═════════════════════════════════════════════════════════════════════════════
// Aufbauten (aus der SIA-400-Standardbibliothek: Baustoffe std-c-*, Schraffuren std-h-*)
// ═════════════════════════════════════════════════════════════════════════════

const L = (componentId: string, thickness: number) => ({ componentId, thickness });

const WALL_TYPES: WallType[] = [
  // Aussenwand verputzt = Standard `std-wt-aw-kompakt` (39 cm, kommt aus den Standards).
  { id: "mk-aw-holz", name: "Aussenwand Holzständer hinterlüftet, Lattung vertikal 39 cm", layers: [L("std-c-lattung-v", 0.024), L("std-c-luft", 0.04), L("std-c-holzfaser", 0.06), L("std-c-mineralwolle", 0.2385), L("std-c-holzwerkstoff", 0.015), L("std-c-gipskarton", 0.0125)] },
  { id: "mk-aw-ug", name: "Kelleraussenwand Stahlbeton, Perimeterdämmung XPS, Sockelputz 39 cm", layers: [L("std-c-aussenputz", 0.02), L("std-c-xps", 0.12), L("std-c-stahlbeton", 0.25)] },
  { id: "mk-iw-ks", name: "Innenwand Kalksandstein 15 cm", layers: [L("std-c-kalksandstein", 0.15)] },
  { id: "mk-stuetzmauer", name: "Stützmauer Stahlbeton 30 cm", layers: [L("std-c-stahlbeton", 0.3)] },
];

const CEILING_TYPES: CeilingType[] = [
  { id: "mk-ct-parkett", name: "Geschossdecke Parkett, Unterlagsboden, Trittschall, STB 37 cm", layers: [L("std-c-parkett", 0.015), L("std-c-zementestrich", 0.065), L("std-c-trittschall", 0.04), L("std-c-stahlbeton", 0.24), L("std-c-innenputz", 0.01)] },
  { id: "mk-ct-platten", name: "Geschossdecke Keramikplatten, Unterlagsboden, Trittschall, STB 37 cm", layers: [L("std-c-keramik", 0.01), L("std-c-zementestrich", 0.07), L("std-c-trittschall", 0.04), L("std-c-stahlbeton", 0.24), L("std-c-innenputz", 0.01)] },
  { id: "mk-ct-bodenplatte", name: "Bodenplatte STB auf XPS und Magerbeton", layers: [L("std-c-zementestrich", 0.08), L("std-c-xps", 0.12), L("std-c-stahlbeton", 0.25), L("std-c-kies", 0.1)] },
];

const ROOF_TYPES: RoofType[] = [
  { id: "mk-rt-flach", name: "Flachdach Umkehrdach bekiest", layers: [L("std-c-kies", 0.06), L("std-c-xps", 0.18), L("std-c-stahlbeton", 0.22)] },
  { id: "mk-rt-blech", name: "Carportdach Trapezblech auf Holz", layers: [L("std-c-trapezblech", 0.04), L("std-c-holz", 0.16)] },
];

// Fenster: Rahmen je Seite, Falz, Sturz, Fensterbänke, Lamellenstoren-Kasten, Schichteinzug.
const WINDOW_TYPES: WindowType[] = [
  {
    id: "mk-fe-dk", name: "Holz-Metall Dreh-Kipp 1-flg. mit Lamellenstore", kind: "drehkipp", wingCount: 1, glazing: "dreifach",
    frameThickness: 0.08, frameDepth: 0.08, frameWidth: 0.08, insetFromFace: 0.18, insetFace: "aussen", rebateDepth: 0.05, lintelHeight: 0.22,
    sillBoard: "beide", sillLine: { faces: "beide", view: "auf" }, frameCornerJoin: "gehrung",
    shading: { create: true, kind: "raffstore", box: { width: 0, height: 0.3, depth: 0.16 }, mount: "sturz" },
    frameDetail: { frameSides: { left: 0.08, right: 0.08, top: 0.1, bottom: 0.12 }, rebates: { left: 0.05, right: 0.05, top: 0.05, bottom: 0.02 }, sillProfile: 0.04, shadingProfile: 0.06 },
    // Vorgabe „Aussendämmung überdämmt Rahmen 3 cm, Innenputz in Leibung".
    layerReveals: [{ layer: 1, mode: "ueberdaemmt", amount: 0.03 }, { layer: -1, mode: "leibung" }],
    defaultSillHeight: 0.9, defaultWidth: 1.2, defaultHeight: 1.4,
  },
  {
    id: "mk-fe-dk2", name: "Dreh-Kipp 2-flg. Stulp mit Lamellenstore", kind: "drehkipp", wingCount: 2, glazing: "dreifach",
    frameThickness: 0.08, frameDepth: 0.08, frameWidth: 0.08, insetFromFace: 0.18, insetFace: "aussen", rebateDepth: 0.05, lintelHeight: 0.22, sillBoard: "beide",
    sashes: [{ kind: "fluegel", autoWidth: true, opening: "dreh", hingeSide: "left" }, { kind: "fluegel", autoWidth: true, opening: "drehkipp", hingeSide: "right" }],
    shading: { create: true, kind: "raffstore", box: { width: 0, height: 0.3, depth: 0.16 }, mount: "sturz" },
    layerReveals: [{ layer: 1, mode: "leibung", amount: 0.03 }, { layer: -1, mode: "leibung" }],
    defaultSillHeight: 0.9, defaultWidth: 1.6, defaultHeight: 1.5,
  },
  {
    id: "mk-fe-pr", name: "Pfosten-Riegel 3-teilig mit Kipp-Oberlicht", kind: "drehkipp", wingCount: 3, glazing: "dreifach",
    frameThickness: 0.08, frameDepth: 0.1, frameWidth: 0.06, insetFace: "mitte", rebateDepth: 0.05, lintelHeight: 0.25, sillBoard: "beide", transomHeight: 0.5,
    sashes: [
      { kind: "fluegel", autoWidth: true, opening: "drehkipp", hingeSide: "left" }, { kind: "pfosten", postWidth: 0.08 },
      { kind: "fluegel", autoWidth: true, opening: "fest" }, { kind: "pfosten", postWidth: 0.08 },
      { kind: "fluegel", autoWidth: true, opening: "drehkipp", hingeSide: "right" },
    ],
    transomSashes: [{ kind: "fluegel", autoWidth: true, opening: "kipp" }],
    shading: { create: true, kind: "raffstore", box: { width: 0, height: 0.3, depth: 0.16 }, mount: "vorgesetzt" },
    defaultSillHeight: 0.3, defaultWidth: 3.0, defaultHeight: 2.2,
  },
  {
    id: "mk-fe-fest", name: "Festverglasung (Formfenster)", kind: "fest", wingCount: 1, glazing: "dreifach",
    frameThickness: 0.07, frameDepth: 0.08, frameWidth: 0.06, insetFromFace: 0.18, insetFace: "aussen", rebateDepth: 0.05, sillBoard: "aussen",
    defaultSillHeight: 1.0, defaultWidth: 0.9, defaultHeight: 0.9,
  },
  {
    id: "mk-fe-dach", name: "Dachflächenfenster Klapp-Schwing 78/118", kind: "kipp", wingCount: 1, glazing: "dreifach",
    frameThickness: 0.06, frameDepth: 0.12, frameWidth: 0.06, defaultSillHeight: 0, defaultWidth: 0.78, defaultHeight: 1.18,
  },
];

// Türen: jede Rahmenart einmal (Blockrahmen, Umfassungszarge, Futter + Bekleidung, Schiebe-, Hebeschiebetür, Wandöffnung).
const DOOR_TYPES: DoorType[] = [
  {
    id: "mk-tu-haus", name: "Haustür Holz-Metall, Blockrahmen, Oberlicht", kind: "dreh", leafCount: 1, leafStyle: "glas", glazingRatio: 0.3,
    frameThickness: 0.08, frameKind: "blockrahmen", frameWidth: 0.09, insetFromFace: 0.18, insetFace: "aussen", rebateDepth: 0.05, lintelHeight: 0.25,
    transomHeight: 0.4, threshold: true, defaultWidth: 1.1, defaultHeight: 2.5,
  },
  {
    id: "mk-tu-umfassung", name: "Zimmertür Stahl-Umfassungszarge", kind: "dreh", leafCount: 1, leafStyle: "glatt",
    frameThickness: 0.05, frameKind: "umfassungszarge", frameWidth: 0.05, doorFrame: { falzWidth: 0.015, falzDepth: 0.025, spiegel: 0.05, sheetThickness: 0.0015 },
    defaultWidth: 0.85, defaultHeight: 2.0,
  },
  {
    id: "mk-tu-futter", name: "Zimmertür Holz, Futter und Bekleidung", kind: "dreh", leafCount: 1, leafStyle: "kassette", panelCols: 1, panelRows: 3,
    frameThickness: 0.04, frameKind: "futter", frameWidth: 0.07, doorFrame: { liningThickness: 0.025, casingWidth: 0.07, casingThickness: 0.012, casingSides: "beide" },
    defaultWidth: 0.85, defaultHeight: 2.0,
  },
  { id: "mk-tu-schiebe", name: "Schiebetür vor der Wand", kind: "schiebe", leafCount: 1, leafStyle: "glatt", frameThickness: 0.04, frameWidth: 0.04, defaultWidth: 0.9, defaultHeight: 2.1 },
  {
    id: "mk-tu-hebeschiebe", name: "Hebeschiebetür Holz-Metall", kind: "hebeschiebe", leafCount: 2, leafStyle: "glas",
    frameThickness: 0.1, frameDepth: 0.16, frameKind: "blockrahmen", frameWidth: 0.1, insetFromFace: 0.18, insetFace: "aussen", rebateDepth: 0.05,
    lintelHeight: 0.25, threshold: true, defaultWidth: 3.0, defaultHeight: 2.3,
  },
  { id: "mk-tu-ug", name: "Kellertür Stahl, Eckzarge (EI30)", kind: "dreh", leafCount: 1, leafStyle: "glatt", frameThickness: 0.05, frameKind: "eckzarge", frameWidth: 0.05, defaultWidth: 0.9, defaultHeight: 2.0 },
  { id: "mk-tu-wand", name: "Wandöffnung", kind: "wandoeffnung", leafCount: 1, leafStyle: "glatt", frameThickness: 0, defaultWidth: 1.0, defaultHeight: 2.1 },
];

const STAIR_TYPES = [
  { id: "mk-tr-beton", name: "Ortbetontreppe mit Naturstein-Tritten, Geländer rechts", structure: "beton" as const, closedRisers: true, treadThickness: 0.03, nosing: 0.02, railing: "rechts" as const, defaultWidth: 1.1 },
  { id: "mk-tr-spindel", name: "Betonwendeltreppe mit Spindel", structure: "spindel" as const, closedRisers: true, treadThickness: 0.04, nosing: 0.02, railing: "rechts" as const, defaultWidth: 0.9 },
  { id: "mk-tr-holz", name: "Wangentreppe Eiche, Geländer beidseitig", structure: "wange" as const, closedRisers: false, treadThickness: 0.045, nosing: 0.03, railing: "beide" as const, defaultWidth: 1.0 },
];

// ═════════════════════════════════════════════════════════════════════════════
// Wände
// ═════════════════════════════════════════════════════════════════════════════

const walls: Wall[] = [];
function wall(id: string, floorId: string, a: Vec2, b: Vec2, wallTypeId: string, height: number, extra: Partial<Wall> = {}): Wall {
  const w: Wall = { id, type: "wall", floorId, categoryCode: "20", start: a, end: b, wallTypeId, height, ...extra };
  walls.push(w);
  return w;
}

/** Aussenwände eines Geschosses (Gegenuhrzeigersinn, aussen = rechts): Ostwand am Erker geteilt, Bogenwand dazwischen. */
function shell(f: "ug" | "eg" | "og", typeId: string, h: number, northSplit: boolean): void {
  const ext = { isExternal: true, loadBearing: true };
  wall(`${f}-aw-s`, f, P(0, 0), P(15, 0), typeId, h, ext);
  wall(`${f}-aw-o1`, f, P(15, 0), P(15, 3), typeId, h, ext);
  // Runder Erker: Halbkreis r = 2 m (Bulge −1 = Halbkreis nach rechts = aussen).
  wall(`${f}-aw-erker`, f, P(15, 3), P(15, 7), typeId, h, { ...ext, bulge: -1 });
  wall(`${f}-aw-o2`, f, P(15, 7), P(15, 10), typeId, h, ext);
  if (northSplit) {
    // Nordwand am Anbau geteilt (Wand teilen): die Mitte wird Innenwand zum Anbau.
    wall(`${f}-aw-n1`, f, P(15, 10), P(10, 10), typeId, h, ext);
    wall(`${f}-aw-n2`, f, P(5, 10), P(0, 10), typeId, h, ext);
  } else {
    wall(`${f}-aw-n`, f, P(15, 10), P(0, 10), typeId, h, ext);
  }
  wall(`${f}-aw-w`, f, P(0, 10), P(0, 0), typeId, h, ext);
}

/** Innenwände, die in UG/EG/OG übereinander stehen (Treppenkern x 6–10 / y 5–10). */
function cores(f: "ug" | "eg" | "og", typeId: string, h: number): void {
  wall(`${f}-iw-x6`, f, P(6, 0), P(6, 10), typeId, h, { loadBearing: true });
  wall(`${f}-iw-kern-s`, f, P(6, 5), P(10, 5), typeId, h);
  wall(`${f}-iw-kern-o`, f, P(10, 5), P(10, 10), typeId, h);
}

// UG — Stahlbeton im Hang, Kalksandstein innen.
shell("ug", "mk-aw-ug", H.ug, false);
cores("ug", "mk-iw-ks", H.ug);
wall("ug-iw-y5", "ug", P(0, 5), P(6, 5), "mk-iw-ks", H.ug);
wall("ug-iw-y75", "ug", P(10, 7.5), P(15, 7.5), "mk-iw-ks", H.ug);
// Fundamentriegel unter dem Anbau (kein UG): frostfrei ab 1.30 bis UK Decke.
for (const [id, a, b] of [["ug-fund-o", P(10, 10 + HA), P(10, 15)], ["ug-fund-n", P(10, 15), P(5, 15)], ["ug-fund-w", P(5, 15), P(5, 10 + HA)]] as const) {
  wall(id, "ug", a, b, "mk-aw-ug", 1.03, { isExternal: true, bottom: { mode: "custom", z: 1.3 }, top: { mode: "custom", z: 2.33 } });
}
// Stützmauer im Garten: schräger Stoss an die Westfassade, schräge Ecke (Gehrung).
wall("ug-stuetz-1", "ug", P(-HA, 4), P(-4.5, 1), "mk-stuetzmauer", 1.8, { isExternal: true });
wall("ug-stuetz-2", "ug", P(-4.5, 1), P(-6, -4), "mk-stuetzmauer", 1.2, { isExternal: true });

// EG — Aussenwand verputzt, Backstein innen.
shell("eg", "std-wt-aw-kompakt", H.eg, true);
cores("eg", "std-wt-iw-backstein", H.eg);
wall("eg-iw-y5", "eg", P(0, 5), P(6, 5), "std-wt-iw-backstein", H.eg);
wall("eg-iw-y75", "eg", P(10, 7.5), P(15, 7.5), "std-wt-iw-backstein", H.eg);
wall("eg-iw-x125", "eg", P(12.5, 7.5), P(12.5, 10), "std-wt-iw-backstein", H.eg);
wall("eg-iw-anbau", "eg", P(10, 10), P(5, 10), "std-wt-iw-backstein", H.eg, { loadBearing: true });
// Anbau Nord (Eingang): verputzt im EG.
wall("eg-anbau-o", "eg", P(10, 10), P(10, 15), "std-wt-aw-kompakt", H.eg, { isExternal: true });
wall("eg-anbau-n", "eg", P(10, 15), P(5, 15), "std-wt-aw-kompakt", H.eg, { isExternal: true });
wall("eg-anbau-w", "eg", P(5, 15), P(5, 10), "std-wt-aw-kompakt", H.eg, { isExternal: true });
wall("eg-anbau-iw", "eg", P(5, 12.5), P(7.2, 12.5), "std-wt-iw-backstein", H.eg);
wall("eg-anbau-iw2", "eg", P(7.2, 12.5), P(7.2, 15), "std-wt-iw-backstein", H.eg);

// OG — wie EG; der Anbau als Holzständerbau mit vertikaler Lattung, Giebel bis unters Dach.
shell("og", "std-wt-aw-kompakt", H.og, true);
cores("og", "std-wt-iw-backstein", H.og);
wall("og-iw-y5", "og", P(0, 5), P(6, 5), "std-wt-iw-backstein", H.og);
wall("og-iw-x10s", "og", P(10, 0), P(10, 5), "std-wt-iw-backstein", H.og);
wall("og-iw-anbau", "og", P(10, 10), P(5, 10), "std-wt-iw-backstein", H.og);
wall("og-anbau-o", "og", P(10, 10), P(10, 15), "mk-aw-holz", 4.4, { isExternal: true, roofAttach: true });
wall("og-anbau-n", "og", P(10, 15), P(5, 15), "mk-aw-holz", 6.8, { isExternal: true, roofAttach: true });
wall("og-anbau-w", "og", P(5, 15), P(5, 10), "mk-aw-holz", 4.4, { isExternal: true, roofAttach: true });

// DG — Kniestock (Traufwände) und Giebel in Holzständerbau, an das Dach angeschlossen.
wall("dg-aw-s", "dg", P(0, 0), P(15, 0), "mk-aw-holz", 1.8, { isExternal: true, roofAttach: true });
wall("dg-aw-o", "dg", P(15, 0), P(15, 10), "mk-aw-holz", 5.8, { isExternal: true, roofAttach: true });
wall("dg-aw-n", "dg", P(15, 10), P(0, 10), "mk-aw-holz", 1.8, { isExternal: true, roofAttach: true });
wall("dg-aw-w", "dg", P(0, 10), P(0, 0), "mk-aw-holz", 5.8, { isExternal: true, roofAttach: true });
wall("dg-iw-x6", "dg", P(6, 0), P(6, 10), "std-wt-iw-backstein", 5.8, { roofAttach: true });
wall("dg-iw-y6", "dg", P(0, 6.5), P(6, 6.5), "std-wt-iw-backstein", 2.4);

// ═════════════════════════════════════════════════════════════════════════════
// Öffnungen
// ═════════════════════════════════════════════════════════════════════════════

const openings: Opening[] = [];
let winNo = 0;
let doorNo = 0;
function win(id: string, hostWallId: string, typeId: string, position: number, width: number, height: number, sillHeight: number, extra: Partial<Opening> = {}): void {
  openings.push({
    id, type: "opening", hostWallId, categoryCode: "21", kind: "window", typeId, position, width, height, sillHeight,
    mark: `F${String(++winNo).padStart(2, "0")}`, uValue: 0.9, isExternal: true, ...extra,
  });
}
function door(id: string, hostWallId: string, typeId: string, position: number, width: number, height: number, extra: Partial<Opening> = {}): void {
  openings.push({
    id, type: "opening", hostWallId, categoryCode: "21", kind: "door", typeId, position, width, height, sillHeight: 0,
    mark: `T${String(++doorNo).padStart(2, "0")}`, swing: "left", hinge: "start", ...extra,
  });
}

// UG: Gartengeschoss im Süden (frei), Kellerfenster hoch im Norden.
win("ug-f1", "ug-aw-s", "mk-fe-dk2", 1.6, 1.8, 1.4, 0.8);
door("ug-t-garten", "ug-aw-s", "mk-tu-hebeschiebe", 7.2, 3.0, 2.2, { isExternal: true, uValue: 1.0, notes: "Gartenzugang" });
win("ug-f2", "ug-aw-s", "mk-fe-dk", 11.6, 1.4, 1.4, 0.8);
win("ug-f3", "ug-aw-n", "mk-fe-dk", 11.0, 1.0, 0.5, 1.8, { notes: "Kellerfenster über Terrain" });
win("ug-f4", "ug-aw-erker", "mk-fe-dk", 2.2, 0.9, 1.2, 0.9);
door("ug-t1", "ug-iw-x6", "mk-tu-ug", 3.4, 0.9, 2.0, { fireRating: "EI30", hinge: "end" });
door("ug-t2", "ug-iw-kern-s", "mk-tu-ug", 1.0, 0.9, 2.0, { fireRating: "EI30" });
door("ug-t3", "ug-iw-x6", "mk-tu-ug", 8.2, 0.9, 2.0, { fireRating: "EI30" });
door("ug-t4", "ug-iw-y75", "mk-tu-ug", 0.6, 0.9, 2.0);

// EG: Hebeschiebetür und Pfosten-Riegel nach Süden, Haustür im Anbau.
win("eg-f1", "eg-aw-s", "mk-fe-dk2", 1.6, 1.8, 1.5, 0.9);
door("eg-t-hst", "eg-aw-s", "mk-tu-hebeschiebe", 7.0, 3.0, 2.3, { isExternal: true, uValue: 1.0 });
win("eg-f2", "eg-aw-s", "mk-fe-pr", 11.2, 2.8, 2.2, 0.3);
win("eg-f3", "eg-aw-w", "mk-fe-dk", 6.6, 1.2, 1.4, 0.9);
win("eg-f4", "eg-aw-w", "mk-fe-dk", 2.0, 1.2, 1.4, 0.9);
win("eg-f5", "eg-aw-erker", "mk-fe-dk", 1.2, 1.0, 1.6, 0.6);
win("eg-f6", "eg-aw-erker", "mk-fe-dk", 3.6, 1.0, 1.6, 0.6);
win("eg-f7", "eg-aw-n1", "mk-fe-dk", 2.6, 0.9, 1.2, 1.1, { notes: "Bad, Milchglas" });
win("eg-f8", "eg-aw-o2", "mk-fe-fest", 1.2, 0.9, 0.9, 1.2, { shape: "rund" });
win("eg-f9", "eg-anbau-o", "mk-fe-dk", 2.0, 1.0, 1.4, 0.9);
door("eg-t-haus", "eg-anbau-n", "mk-tu-haus", 1.2, 1.1, 2.5, { isExternal: true, uValue: 1.2, burglaryClass: "RC2", hinge: "end" });
door("eg-t-anbau", "eg-iw-anbau", "mk-tu-umfassung", 2.85, 1.0, 2.1, { fireRating: "EI30", swing: "right" });
door("eg-t-wohnung", "eg-iw-kern-s", "mk-tu-umfassung", 0.4, 0.9, 2.1, { fireRating: "EI30", soundClass: "Rw 37 dB" });
door("eg-t-zi1", "eg-iw-x6", "mk-tu-futter", 3.4, 0.85, 2.0, { hinge: "end" });
door("eg-t-atelier", "eg-iw-x6", "mk-tu-futter", 5.3, 0.85, 2.0);
door("eg-t-bad", "eg-iw-y75", "mk-tu-schiebe", 0.4, 0.9, 2.1);
door("eg-t-red", "eg-iw-y75", "mk-tu-futter", 3.2, 0.8, 2.0, { hinge: "end" });
door("eg-t-gard", "eg-anbau-iw2", "mk-tu-schiebe", 0.5, 0.9, 2.1);

// OG: Rundbogenfenster, Fenstertür, Bandfenster; Treppenhaus-Türen.
win("og-f1", "og-aw-s", "mk-fe-dk", 2.0, 1.2, 1.6, 0.9, { shape: "rundbogen", shapeRise: 0.6 });
win("og-f2", "og-aw-s", "mk-fe-dk", 7.4, 1.2, 1.5, 0.9);
win("og-f3", "og-aw-s", "mk-fe-dk2", 11.2, 2.0, 2.2, 0.1, { notes: "Fenstertür mit Absturzsicherung" });
win("og-f4", "og-aw-w", "mk-fe-dk", 2.0, 1.2, 1.4, 0.9);
win("og-f5", "og-aw-w", "mk-fe-dk", 6.6, 1.0, 1.0, 1.2, { notes: "Bad" });
win("og-f6", "og-aw-erker", "mk-fe-dk", 1.2, 1.0, 1.6, 0.6);
win("og-f7", "og-aw-erker", "mk-fe-dk", 3.6, 1.0, 1.6, 0.6);
win("og-f8", "og-aw-n1", "mk-fe-dk", 2.0, 1.2, 1.4, 0.9);
win("og-f9", "og-anbau-n", "mk-fe-dk2", 1.7, 1.6, 1.5, 0.9);
win("og-f10", "og-anbau-o", "mk-fe-dk", 2.0, 1.0, 1.4, 0.9);
door("og-t-wohnung", "og-iw-kern-o", "mk-tu-umfassung", 0.15, 0.8, 2.1, { fireRating: "EI30", soundClass: "Rw 37 dB", swing: "right" });
door("og-t-zi4", "og-iw-kern-s", "mk-tu-futter", 1.0, 0.85, 2.0);
door("og-t-bad", "og-iw-x6", "mk-tu-futter", 7.0, 0.8, 2.0, { hinge: "end" });
door("og-t-zi3", "og-iw-x6", "mk-tu-futter", 1.5, 0.85, 2.0);
door("og-t-anbau", "og-iw-anbau", "mk-tu-wand", 1.8, 1.2, 2.1);

// DG: Rundfenster (Oculus) im Westgiebel, Fenster im Ostgiebel, Tür in der Galerie.
win("dg-f1", "dg-aw-w", "mk-fe-fest", 4.4, 1.2, 1.2, 1.8, { shape: "rund" });
win("dg-f2", "dg-aw-o", "mk-fe-dk2", 4.2, 1.6, 1.6, 0.8);
door("dg-t1", "dg-iw-x6", "mk-tu-futter", 4.0, 0.85, 2.0);
door("dg-t2", "dg-iw-y6", "mk-tu-schiebe", 3.0, 0.9, 2.0);

// ═════════════════════════════════════════════════════════════════════════════
// Decken (mit Aussparungen für Treppen), Bodenplatte
// ═════════════════════════════════════════════════════════════════════════════

const ERKER_C = P(15, 5);
/** Ursprung des 2D-Details (abseits des Geländes). */
const DETAIL_X = 60;
/** Umriss bis Aussenkante: Haupthaus, Erker (Halbkreis r = 2 + 0.195), optional Anbau. */
function slabOutline(withErker: boolean, withAnbau: boolean): Vec2[] {
  const o = 15 + HA;
  const pts: Vec2[] = [P(-HA, -HA), P(o, -HA)];
  if (withErker) {
    const r = 2 + HA;
    const dy = Math.sqrt(r * r - HA * HA);
    const a0 = Math.atan2(-dy, HA);
    pts.push(...arcPts(ERKER_C, r, a0, -a0, 16));
  }
  pts.push(P(o, 10 + HA));
  if (withAnbau) pts.push(P(10 + HA, 10 + HA), P(10 + HA, 15 + HA), P(5 - HA, 15 + HA), P(5 - HA, 10 + HA));
  pts.push(P(-HA, 10 + HA));
  return pts;
}

// Treppenlöcher: Wendel UG→EG im Erker, L-Treppe EG→OG im Kern, gerade Treppe OG→DG.
const HOLE_SPIRAL = circlePts(P(15.3, 5), 1.2, 24);
const HOLE_L = [P(8.8, 6.3), P(9.9275, 6.3), P(9.9275, 9.9275), P(7.25, 9.9275), P(7.25, 8.35), P(8.8, 8.35)];
const HOLE_OGDG = rect(10.0725, 5.4, 11.15, 8.9);

const ceilings: NonNullable<Project["ceilings"]> = [
  { id: "c-bodenplatte", type: "ceiling", floorId: "ug", categoryCode: "30", outline: slabOutline(true, false), wallTypeId: "", ceilingTypeId: "mk-ct-bodenplatte", top: { mode: "floor", floorId: "ug", offset: 0 }, loadBearing: true },
  { id: "c-ug", type: "ceiling", floorId: "ug", categoryCode: "30", outline: slabOutline(true, true), openings: [HOLE_SPIRAL], wallTypeId: "", ceilingTypeId: "mk-ct-platten", loadBearing: true },
  { id: "c-eg", type: "ceiling", floorId: "eg", categoryCode: "30", outline: slabOutline(true, true), openings: [HOLE_L], wallTypeId: "", ceilingTypeId: "mk-ct-parkett", loadBearing: true },
  { id: "c-og", type: "ceiling", floorId: "og", categoryCode: "30", outline: slabOutline(false, true), openings: [HOLE_OGDG], wallTypeId: "", ceilingTypeId: "mk-ct-parkett", loadBearing: true },
];

// ═════════════════════════════════════════════════════════════════════════════
// Dächer: Satteldach + Anbau quer (T-Dach mit Kehlen), Gauben, Flachdächer (Erker, Carport)
// ═════════════════════════════════════════════════════════════════════════════

const roofs: NonNullable<Project["roofs"]> = [
  {
    id: "dach-haupt", type: "roof", floorId: "dg", categoryCode: "31", outline: rect(-HA, -HA, 15 + HA, 10 + HA),
    shape: "sattel", pitchDeg: PITCH, overhang: 0.6, overhangGable: 0.35, ridgeAxis: "x", baseElevation: EAVE_MAIN, thickness: 0.41, roofTypeId: "std-rt-steildach-holz",
    dormers: [
      { id: "gaube-schlepp", kind: "schlepp", position: P(3, 1.6), width: 2.8, frontHeight: 1.45, overhang: 0.2, wallTypeId: "mk-aw-holz" },
      { id: "gaube-sattel", kind: "sattel", position: P(11.5, 1.6), width: 2.2, frontHeight: 1.5, pitchDeg: 40, overhang: 0.25, wallTypeId: "mk-aw-holz" },
    ],
  },
  // Anbau: First quer zum Hauptfirst, gleiche Traufhöhe; der Umriss greift ins Hauptdach (Kehlen).
  {
    id: "dach-anbau", type: "roof", floorId: "og", categoryCode: "31", outline: rect(5 - HA, 7.85, 10 + HA, 15 + HA),
    shape: "sattel", pitchDeg: PITCH, overhang: 0.6, overhangGable: 0.35, ridgeAxis: "y", baseElevation: EAVE_MAIN, thickness: 0.41, roofTypeId: "std-rt-steildach-holz",
  },
  {
    id: "dach-erker", type: "roof", floorId: "og", categoryCode: "31", outline: [P(15 + HA, 5 - 2.2), ...arcPts(ERKER_C, 2 + HA + 0.15, -Math.PI / 2 + 0.09, Math.PI / 2 - 0.09, 14), P(15 + HA, 5 + 2.2)],
    shape: "flach", pitchDeg: 0, overhang: 0, ridgeAxis: "x", thickness: 0.46, roofTypeId: "mk-rt-flach",
  },
  {
    id: "dach-carport", type: "roof", floorId: "eg", categoryCode: "31", outline: rect(-6.6, 10.6, -0.9, 16.2),
    // Pultdach 3° (Trapezblech) — ein Flachdach zeigt in der Ansicht keine Stirn.
    shape: "pult", pitchDeg: 3, overhang: 0.1, ridgeAxis: "y", baseElevation: 5.0, thickness: 0.2, roofTypeId: "mk-rt-blech",
  },
];

// Dachflächenfenster (Nordseite) und Gaubenfenster.
openings.push(
  { id: "dg-df1", type: "opening", hostWallId: "", hostRoofId: "dach-haupt", hostPoint: P(3.0, 7.4), categoryCode: "21", kind: "window", typeId: "mk-fe-dach", position: 0, width: 0.78, height: 1.18, sillHeight: 0, mark: "DF1", uValue: 1.1, isExternal: true },
  { id: "dg-df2", type: "opening", hostWallId: "", hostRoofId: "dach-haupt", hostPoint: P(13.0, 7.4), categoryCode: "21", kind: "window", typeId: "mk-fe-dach", position: 0, width: 0.78, height: 1.18, sillHeight: 0, mark: "DF2", uValue: 1.1, isExternal: true },
  { id: "dg-gf1", type: "opening", hostWallId: "", hostRoofId: "dach-haupt", hostDormerId: "gaube-schlepp", categoryCode: "21", kind: "window", typeId: "mk-fe-dk2", position: 0, width: 1.8, height: 1.1, sillHeight: 0.2, mark: "GF1", uValue: 0.9, isExternal: true },
  { id: "dg-gf2", type: "opening", hostWallId: "", hostRoofId: "dach-haupt", hostDormerId: "gaube-sattel", categoryCode: "21", kind: "window", typeId: "mk-fe-dk", position: 0, width: 1.2, height: 1.15, sillHeight: 0.2, mark: "GF2", uValue: 0.9, isExternal: true },
);

// ═════════════════════════════════════════════════════════════════════════════
// Treppen, Stützen, Körper
// ═════════════════════════════════════════════════════════════════════════════

const stairs: NonNullable<Project["stairs"]> = [
  // UG → EG: Betonwendeltreppe mit Spindel im Erker.
  { id: "tr-wendel", type: "stair", floorId: "ug", categoryCode: "40", shape: "spiral", typeId: "mk-tr-spindel", start: P(15.95, 5), dir: P(0, 1), runLength: 0, center: P(15.3, 5), radius: 0.62, sweep: 320, width: 0.9, totalRise: Z.eg - Z.ug, stepCount: 16, centerColumn: 0.12 },
  // EG → OG: L-Treppe mit Podest im Treppenkern (Lauf 1 nach Norden, Lauf 2 nach Westen).
  { id: "tr-kern", type: "stair", floorId: "eg", categoryCode: "40", shape: "L", typeId: "mk-tr-beton", start: P(9.3775, 5.35), dir: P(0, 1), runLength: 3.0, run2Length: 1.5, turn: 1, width: 1.1, totalRise: Z.og - Z.eg, stepCount: 17 },
  // OG → DG: gerade Holztreppe der Maisonette (steigt nach Süden, Austritt beim First).
  { id: "tr-dg", type: "stair", floorId: "og", categoryCode: "40", shape: "straight", typeId: "mk-tr-holz", start: P(10.6125, 9.6), dir: P(0, -1), runLength: 3.9, width: 1.0, totalRise: Z.dg - Z.og, stepCount: 16 },
];

const columns: NonNullable<Project["columns"]> = [
  ...[P(-6.2, 11.0), P(-1.3, 11.0), P(-6.2, 15.8), P(-1.3, 15.8)].map((position, i) => ({
    id: `st-carport-${i + 1}`, type: "column" as const, floorId: "eg", categoryCode: "25", position, profile: { kind: "rect" as const, width: 0.12, depth: 0.12 }, rotation: 0,
    height: 3.0, componentId: "std-c-stahl", bottom: { mode: "custom" as const, z: 2.0 }, top: { mode: "custom" as const, z: 5.0 },
  })),
  // Rundstütze unter dem Podest der Gartenterrasse (UG, Sichtbeton).
  { id: "st-ug-1", type: "column", floorId: "ug", categoryCode: "25", position: P(10.0, 2.6), profile: { kind: "round", radius: 0.15 }, rotation: 0, height: H.ug, componentId: "std-c-stahlbeton" },
];

const extrudedSolids: NonNullable<Project["extrudedSolids"]> = [
  // Abzugskörper: Durchreiche Küche ↔ Atelier in der EG-Innenwand x = 6.
  { id: "void-durchreiche", type: "extrudedSolid", levelId: "eg", points: rect(5.8, 6.6, 6.2, 7.8), height: 0.6, baseOffset: 1.0, operation: "subtract" },
  // Freier Körper: runder Brunnentrog im Garten (Kreisprofil, Fase).
  { id: "koerper-brunnen", type: "extrudedSolid", levelId: "ug", points: [], circle: { center: P(4.5, -6.5), r: 0.7 }, height: 0.6, baseOffset: -0.1, chamfer: 0.03 },
];

// ═════════════════════════════════════════════════════════════════════════════
// Gelände (Höhenlinien), Baugrube, Kataster, Baurecht
// ═════════════════════════════════════════════════════════════════════════════

/** Gelände z(x, y): fällt nach Süden (tanh-Profil), leicht gewellt. */
const terrainZ = (x: number, y: number) => 0.9 + 1.5 * Math.tanh((y - 4 - 0.8 * Math.sin(x / 9)) / 8);
/** Höhenlinie z als Polylinie y(x) über x = −16 … 32. */
function contourAt(z: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let x = -16; x <= 32; x += 2) pts.push(P(x, r3(4 + 0.8 * Math.sin(x / 9) + 8 * Math.atanh((z - 0.9) / 1.5))));
  return pts;
}
const CONTOUR_Z = [-0.55, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.35];

// Parzelle (Kataster) mit Nachbarparzellen; Grenzabstände je Kante, Baulinie an der Strasse (Nord).
const PARCEL = [P(-14, -12), P(28, -13), P(29, 23), P(-15, 24)];

function cadastre(): Drawing2D[] {
  const d: Drawing2D[] = [];
  const add = (id: string, geom: Drawing2DGeom, extra: Partial<Drawing2D> = {}) =>
    d.push({ id, type: "drawing2d", levelId: "eg", categoryCode: "01", geom, lineStyleId: "std-ls-grundstueck", weightMm: 0.35, ...extra });
  add("kat-parzelle", { shape: "polyline", pts: PARCEL, closed: true });
  add("kat-nachbar-w", { shape: "polyline", pts: [P(-15, 24), P(-40, 25), P(-41, -11), P(-14, -12)], closed: false }, { weightMm: 0.25 });
  add("kat-nachbar-o", { shape: "polyline", pts: [P(28, -13), P(52, -14), P(53, 22), P(29, 23)], closed: false }, { weightMm: 0.25 });
  add("kat-nachbar-s", { shape: "line", a: P(-14, -12), b: P(-13, -34) }, { weightMm: 0.25 });
  add("kat-nachbar-s2", { shape: "line", a: P(28, -13), b: P(29, -35) }, { weightMm: 0.25 });
  // Strasse im Norden (Strassenrand, Achse).
  add("str-rand-s", { shape: "line", a: P(-40, 25.5), b: P(55, 23.5) }, { categoryCode: "11", lineStyleId: "std-ls-voll", weightMm: 0.25 });
  add("str-rand-n", { shape: "line", a: P(-40, 31.5), b: P(55, 29.5) }, { categoryCode: "11", lineStyleId: "std-ls-voll", weightMm: 0.25 });
  add("str-achse", { shape: "line", a: P(-40, 28.5), b: P(55, 26.5) }, { categoryCode: "11", lineStyleId: "std-ls-strichpunkt", weightMm: 0.13 });
  const label = (id: string, at: Vec2, text: string, h = 0.6) => add(id, { shape: "text", at, text, height: h, angle: 0 }, { categoryCode: "01", lineStyleId: undefined });
  label("kat-nr", P(18, -9), "Kat.-Nr. 2417  (1'540 m²)");
  label("kat-nr-w", P(-34, 2), "Kat.-Nr. 2416");
  label("kat-nr-o", P(36, 2), "Kat.-Nr. 2418");
  label("str-name", P(30, 27.6), "Musterweg", 0.8);
  // Bäume (Kontext).
  [P(-9, -7), P(22, -6), P(24, 12), P(-10, 18)].forEach((c, i) =>
    add(`baum-${i + 1}`, { shape: "circle", center: c, r: 2.2 + (i % 2) * 0.6 }, { categoryCode: "13", lineStyleId: "std-ls-voll", weightMm: 0.13 }),
  );
  return d;
}

// ═════════════════════════════════════════════════════════════════════════════
// Beschriftung, Bemassung, Achsraster, Detail
// ═════════════════════════════════════════════════════════════════════════════

function annotations(): Drawing2D[] {
  const d: Drawing2D[] = [];
  const add = (id: string, levelId: string, categoryCode: string, geom: Drawing2DGeom, extra: Partial<Drawing2D> = {}) =>
    d.push({ id, type: "drawing2d", levelId, categoryCode, geom, ...extra });

  // Achsraster 1–4 / A–C, in allen Geschossen und im 3D.
  add("raster", "eg", "00", {
    shape: "grid", origin: P(0, 0), angle: 0,
    a: [{ label: "1", pos: 0 }, { label: "2", pos: 6 }, { label: "3", pos: 10 }, { label: "4", pos: 15 }],
    b: [{ label: "A", pos: 0 }, { label: "B", pos: 5 }, { label: "C", pos: 10 }],
    extend: 2.5, bubbles: "both", bubbleMm: 6, levels: ["ug", "eg", "og", "dg"], show3d: true,
  }, { lineStyleId: "std-ls-strichpunkt" });

  // Assoziative Bemassung: Innenmasse an Wandflächen (Schichtgrenze 0/letzte) und Öffnungsleibungen.
  add("mass-innen-eg", "eg", "80", {
    shape: "dimension", pts: [P(HA, 1.2), P(6 - 0.0725, 1.2)], offset: 0,
    refs: [{ id: "eg-aw-w", feature: "wall", index: 4, t: 0.88 }, { id: "eg-iw-x6", feature: "wall", index: 0, t: 0.12 }],
  });
  add("mass-fenster-eg", "eg", "80", {
    shape: "dimension", pts: [P(1.6, -1.2), P(3.4, -1.2), P(7.0, -1.2), P(10.0, -1.2)], offset: 0,
    refs: [
      { id: "eg-f1", feature: "opening", index: 0 }, { id: "eg-f1", feature: "opening", index: 1 },
      { id: "eg-t-hst", feature: "opening", index: 0 }, { id: "eg-t-hst", feature: "opening", index: 1 },
    ],
  });
  // Radius- und Bogenbemassung am Erker.
  add("mass-radius-erker", "eg", "80", { shape: "dimension", pts: [ERKER_C, P(17, 5)], offset: 0, kind: "radius", arcCenter: ERKER_C, refs: [{ id: "eg-aw-erker", feature: "center" }, { id: "eg-aw-erker", feature: "rim", t: 0 }] });
  add("mass-bogen-erker", "og", "80", { shape: "dimension", pts: [P(15, 3), P(15, 7)], offset: 2.6, kind: "arc", arcCenter: ERKER_C });

  // Höhenkoten (absolut, wie die Koten in Schnitt/Ansicht).
  add("kote-eg", "eg", "80", { shape: "kote", at: P(3, 2.5), value: Z.eg, kind: "okFertig", rotation: 0 });
  add("kote-eg-terrain", "eg", "80", { shape: "kote", at: P(8.5, -3), value: r3(terrainZ(8.5, -1)), kind: "okFertig", rotation: 0 });
  add("kote-ug", "ug", "80", { shape: "kote", at: P(3, 2.5), value: Z.ug, kind: "okFertig", rotation: 0 });
  add("kote-og", "og", "80", { shape: "kote", at: P(3, 2.5), value: Z.og, kind: "okFertig", rotation: 0 });
  add("kote-dg", "dg", "80", { shape: "kote", at: P(3, 3.5), value: Z.dg, kind: "okFertig", rotation: 0 });

  // Text mit Formatierung, Hinweis mit Führungslinie, Detailverweis, Massstabsleiste, Revisionswolke.
  add("titel-eg", "eg", "50", {
    shape: "text", at: P(-14, -16), text: "Erdgeschoss", height: 0.7, angle: 0, width: 16,
    doc: textDoc([{ text: "Musterhaus komplex — Erdgeschoss", bold: true, sizePt: 14 }, { text: "Zweifamilienhaus am Südhang, Wohnung 1 (EG/UG) und Maisonette (OG/DG)", italic: true }]),
  });
  add("hinweis-hst", "eg", "50", {
    shape: "text", at: P(4, -4.5), text: "Hebeschiebetür, Schwelle rollstuhlgängig ≤ 25 mm", height: 0.25, angle: 0,
    leaderTarget: P(8.5, -0.1), leaderBendPoints: [P(7.5, -2.8)],
  }, { endMarks: { end: "arrow", sizeMm: 2 } });
  add("detailref-1", "eg", "50", { shape: "detailref", at: P(-1.4, -1.6), label: "1", sheetLayoutId: "lay-501", sheetLabel: "501" });
  add("massstab-eg", "eg", "50", { shape: "scalebar", at: P(-14, -19), segmentLength: 1, segments: 5 });
  // Revisionswolke (Bögen nach aussen: negativer Bulge bei Gegenuhrzeigersinn).
  const cloud = [...arcPts(P(12.6, 0), 1.9, -Math.PI, Math.PI, 18).slice(0, 18)].map((q) => P(q.x, r3(q.y * 0.6)));
  add("revision-a", "eg", "90", { shape: "polyline", closed: true, pts: cloud, bulge: cloud.map(() => -0.45) }, { color: "#c0392b", weightMm: 0.35 });
  add("revision-a-text", "eg", "90", { shape: "text", at: P(14.6, -1.4), text: "△A  Pfosten-Riegel statt Fenstertür", height: 0.22, angle: 0 }, { color: "#c0392b" });
  add("nordpfeil", "eg", "50", { shape: "block", blockDefId: "blk-nord", at: P(24, -10), rotation: 0, scale: 1.5 });

  // Detail Deckenauflager (2D, Massstab 1:10): Schichten mit SIA-Schraffuren, Achse, Bruchlinie, Beschriftung.
  const dl = "detail-traufe";
  // Lage abseits des Geländes (Kontext wird auf allen Ebenen gezeichnet), Ursprung x = 60 m.
  const Q = (x: number, y: number) => P(DETAIL_X + x, y);
  const layer = (id: string, x0: number, y0: number, x1: number, y1: number, hatchId: string, fillColor = "#ffffff", hatchAngleDeg?: number) =>
    add(id, dl, "85", { shape: "rect", min: Q(x0, y0), max: Q(x1, y1) }, { hatchId, fillColor, weightMm: 0.25, lineStyleId: "std-ls-voll", ...(hatchAngleDeg != null ? { hatchAngleDeg } : {}) });
  layer("det-aussenputz", 0, 0, 0.02, 2.0, "std-h-putz");
  // Dämmstoffe (SIA 400 Fig. 34): Linien quer zur senkrechten Schicht.
  layer("det-eps", 0.02, 0, 0.2, 2.0, "std-h-daemmung-weich", "#ffffff", 90);
  layer("det-bs-unten", 0.2, 0, 0.375, 0.99, "std-h-backstein");
  layer("det-bs-oben", 0.2, 1.37, 0.375, 2.0, "std-h-backstein");
  layer("det-decke", 0.2, 0.99, 1.4, 1.24, "std-h-stahlbeton");
  layer("det-tsd", 0.375, 1.24, 1.4, 1.28, "std-h-daemmung-weich");
  layer("det-estrich", 0.375, 1.28, 1.4, 1.345, "std-h-estrich");
  layer("det-parkett", 0.375, 1.345, 1.4, 1.36, "std-h-holz-massiv");
  layer("det-putz-unten", 0.375, 0, 0.39, 0.99, "std-h-putz");
  layer("det-putz-decke", 0.39, 0.98, 1.4, 0.99, "std-h-putz");
  add("det-randstreifen", dl, "85", { shape: "line", a: Q(0.38, 1.24), b: Q(0.38, 1.36) }, { lineStyleId: "std-ls-strich-fein", weightMm: 0.18 });
  add("det-achse", dl, "85", { shape: "line", a: Q(0.2875, -0.15), b: Q(0.2875, 2.15) }, { lineStyleId: "std-ls-strichpunkt", weightMm: 0.13 });
  add("det-bruch", dl, "85", { shape: "line", a: Q(1.4, 0.85), b: Q(1.4, 1.5) }, { lineStyleId: "std-ls-bruch", weightMm: 0.13 });
  add("det-mass", dl, "85", { shape: "dimension", pts: [Q(0, -0.12), Q(0.02, -0.12), Q(0.2, -0.12), Q(0.375, -0.12), Q(0.39, -0.12)], offset: 0, textHeightMm: 2.5 });
  add("det-mass-h", dl, "85", { shape: "dimension", pts: [Q(1.55, 0.98), Q(1.55, 1.24), Q(1.55, 1.36)], offset: 0, textHeightMm: 2.5 });
  const label = (id: string, at: Vec2, target: Vec2, text: string) =>
    add(id, dl, "85", { shape: "text", at, text, height: 0.025, angle: 0, leaderTarget: target }, { endMarks: { end: "dot", sizeMm: 1.5 } });
  label("det-t1", Q(-0.9, 1.9), Q(0.01, 1.8), "Aussenputz 20 mm");
  label("det-t2", Q(-0.9, 1.75), Q(0.1, 1.6), "EPS 180 mm, λ = 0.034");
  label("det-t3", Q(-0.9, 1.6), Q(0.29, 1.7), "Backstein 175 mm");
  label("det-t4", Q(1.6, 1.62), Q(0.9, 1.35), "Parkett 15 / Unterlagsboden 65 / TSD 40");
  label("det-t5", Q(1.6, 0.7), Q(0.9, 1.1), "Stahlbetondecke 240 mm");
  add("det-titel", dl, "50", { shape: "text", at: Q(-0.9, 2.3), text: "Detail 1 — Deckenauflager Aussenwand  1:10", height: 0.045, angle: 0, marks: { bold: true } });
  add("det-massstab", dl, "50", { shape: "scalebar", at: Q(-0.9, -0.5), segmentLength: 0.1, segments: 5 });
  return d;
}

// ═════════════════════════════════════════════════════════════════════════════
// Räume (SIA 416) — Umriss per Raumerkennung des Kerns, dann benannt
// ═════════════════════════════════════════════════════════════════════════════

type RoomDef = [level: string, at: Vec2, nr: string, name: string, sia: SiaCategory];
const ROOMS: RoomDef[] = [
  ["ug", P(3, 2.5), "U.01", "Hobby", "HNF"],
  ["ug", P(3, 7.5), "U.02", "Keller", "NNF"],
  ["ug", P(8, 7.5), "U.03", "Technik", "FF"],
  ["ug", P(12.5, 8.8), "U.04", "Waschen", "NNF"],
  ["ug", P(9, 2.5), "U.05", "Gartenzimmer", "HNF"],
  ["eg", P(3, 2.5), "E.01", "Zimmer", "HNF"],
  ["eg", P(3, 7.5), "E.02", "Atelier", "HNF"],
  ["eg", P(9, 2.5), "E.03", "Wohnen/Essen/Küche", "HNF"],
  ["eg", P(11.2, 8.8), "E.04", "Bad", "NNF"],
  ["eg", P(13.7, 8.8), "E.05", "Réduit", "NNF"],
  ["eg", P(7, 7), "E.06", "Treppenhaus", "VF"],
  ["eg", P(8.5, 13.7), "E.07", "Eingang", "VF"],
  ["eg", P(6, 13.7), "E.08", "Garderobe", "NNF"],
  ["og", P(3, 2.5), "O.01", "Zimmer", "HNF"],
  ["og", P(3, 7.5), "O.02", "Bad / Ankleide", "NNF"],
  ["og", P(8, 2.5), "O.03", "Zimmer", "HNF"],
  ["og", P(12.5, 2.5), "O.04", "Wohnen/Küche", "HNF"],
  ["og", P(7, 7), "O.05", "Treppenhaus", "VF"],
  ["og", P(7.5, 12.5), "O.06", "Zimmer", "HNF"],
  ["dg", P(3, 3), "D.01", "Schlafen", "HNF"],
  ["dg", P(3, 8.2), "D.02", "Bad", "NNF"],
  ["dg", P(10.5, 5), "D.03", "Galerie", "HNF"],
];

function addRooms(p: Project): Project {
  for (const [level, at, nr, name, sia] of ROOMS) {
    const lvl = p.drawingLevels.find((l) => l.id === level);
    const ops = documentFor(p).cmdOps({ cmd: "room", at: [at.x, at.y], ctx: { level, floorHeight: lvl?.floorHeight ?? null, cat: "60", wallType: "" }, stamp: `raum${nr}` });
    const made = ops.find((o) => o.kind === "add" && o.collection === "rooms");
    if (!made || made.kind !== "add") throw new Error(`Musterhaus komplex: Raum ${nr} nicht erkannt`);
    const stamp: RoomStamp = { number: nr, name, showFloorArea: true, showUsage: true, roundingStep: 0.1 };
    const room = { ...(made.items[0] as unknown as Room), id: `raum-${nr}`, name, siaCategory: sia, stamp, stampDoc: textDoc([{ text: nr }, { text: name, bold: true }], "center") };
    p = applyOps(p, [{ kind: "add", collection: "rooms", items: [room as unknown as { id: string }] }]);
  }
  return p;
}

// ═════════════════════════════════════════════════════════════════════════════
// Ansichten, Ansichtsvorlagen, Layouts, Publikation
// ═════════════════════════════════════════════════════════════════════════════

/** Sichtbarkeit je Kategorie: Ausschnitte listen jede sichtbare Kategorie ausdrücklich (fehlt = aus). */
const codesOf = (ls: LayerCategory[]): string[] => ls.flatMap((l) => [l.code, ...codesOf(l.children ?? [])]);
const vis = (hidden: string[] = []): Record<string, boolean> => Object.fromEntries(codesOf(LAYERS).map((c) => [c, !hidden.includes(c)]));
const ALL = vis();
const LEVEL_VIS: Record<string, boolean> = Object.fromEntries(LEVELS.map((l) => [l.id, true]));
/** Grundrisse auf Blättern: ohne Kataster, Strasse, Höhenlinien und Gelände. */
const PLAN_VIS = vis(["01", "02", "10", "11", "13", "14"]);
/** Kontext (Gelände, Baugrube, Höhenlinien, Kataster, Raster) aus — für das Detail. */
const HIDE_SITE = vis(["00", "01", "02", "07", "10", "11", "13", "14"]);
const snap = (id: string, name: string, level: string, scale: number, center: Vec2, extra: Partial<NonNullable<Project["viewSnapshots"]>[number]> = {}) => ({
  id, name, viewType: "grundriss" as const, view3d: "iso" as const, scaleDenominator: scale, detail: (scale <= 50 ? "fein" : "mittel") as "fein" | "mittel",
  activeLevelId: level, layerVisibility: PLAN_VIS, drawingVisibility: LEVEL_VIS, cameraCenter: center, cameraPxPerMeter: 40, ...extra,
});

function views(): Pick<Project, "viewTemplates" | "viewSnapshots" | "viewSnapshotFolders" | "layouts" | "masterLayouts" | "layoutFolders" | "publishSets" | "overrideRules"> {
  return {
    overrideRules: [
      { id: "or-brand", name: "Brandschutztüren rot", enabled: true, condition: { type: "layer_name", operator: "contains", value: "Türen" }, actions: { color: "#c0392b", lineweight: 0.35 } },
    ],
    viewTemplates: [
      { id: "vt-gr100", name: "Grundriss 1:100", detail: "mittel", scaleDenominator: 100, scaleLineWeights: true, cutHeight: 1.0 },
      { id: "vt-gr50", name: "Grundriss 1:50 fein", detail: "fein", scaleDenominator: 50, scaleLineWeights: true },
      { id: "vt-schnitt", name: "Schnitt 1:100", detail: "mittel", scaleDenominator: 100, hiddenLines: true },
      { id: "vt-ansicht", name: "Ansicht 1:100 mit Schatten", detail: "mittel", scaleDenominator: 100, shadows: true },
      { id: "vt-brand", name: "Brandschutzplan", detail: "grob", scaleDenominator: 100, enabledOverrideRuleIds: ["or-brand"], mono: true },
    ],
    viewSnapshotFolders: [{ id: "vf-gr", name: "Grundrisse" }, { id: "vf-sa", name: "Schnitte und Ansichten" }, { id: "vf-3d", name: "3D" }],
    viewSnapshots: [
      snap("vs-ug", "UG 1:100", "ug", 100, P(7.5, 5), { folderId: "vf-gr", templateId: "vt-gr100", templateLinked: true }),
      snap("vs-eg", "EG 1:100", "eg", 100, P(7.5, 6), { folderId: "vf-gr", templateId: "vt-gr100", templateLinked: true }),
      snap("vs-og", "OG 1:100", "og", 100, P(7.5, 6), { folderId: "vf-gr", templateId: "vt-gr100", templateLinked: true }),
      snap("vs-dg", "DG 1:100", "dg", 100, P(7.5, 5), { folderId: "vf-gr", templateId: "vt-gr100", templateLinked: true }),
      snap("vs-eg50", "EG 1:50 Ausschnitt Wohnen", "eg", 50, P(10, 3.5), { folderId: "vf-gr", templateId: "vt-gr50", templateLinked: true }),
      snap("vs-situation", "Situation 1:500", "eg", 500, P(7, 5), { folderId: "vf-gr", detail: "grob", layerVisibility: ALL }),
      snap("vs-brand", "EG Brandschutz", "eg", 100, P(7.5, 6), { folderId: "vf-gr", templateId: "vt-brand", templateLinked: true, enabledOverrideRuleIds: ["or-brand"] }),
      snap("vs-schnitt-a", "Schnitt A-A", "schnitt-a", 100, P(6, 6), { folderId: "vf-sa", layerVisibility: ALL }),
      snap("vs-schnitt-b", "Schnitt B-B", "schnitt-b", 100, P(6, 6), { folderId: "vf-sa", layerVisibility: ALL }),
      snap("vs-ansicht-s", "Ansicht Süd", "ansicht-sued", 100, P(6, 6), { folderId: "vf-sa", layerVisibility: ALL }),
      snap("vs-ansicht-o", "Ansicht Ost", "ansicht-ost", 100, P(6, 6), { folderId: "vf-sa", layerVisibility: ALL }),
      snap("vs-ansicht-n", "Ansicht Nord", "ansicht-nord", 100, P(6, 6), { folderId: "vf-sa", layerVisibility: ALL }),
      snap("vs-ansicht-w", "Ansicht West", "ansicht-west", 100, P(6, 6), { folderId: "vf-sa", layerVisibility: ALL }),
      snap("vs-detail", "Detail Deckenauflager 1:10", "detail-traufe", 10, P(DETAIL_X + 0.4, 1.0), { folderId: "vf-sa", detail: "fein", layerVisibility: HIDE_SITE }),
      snap("vs-3d", "Axonometrie Südost", "eg", 100, P(7.5, 5), { folderId: "vf-3d", viewType: "perspektive", view3d: "isoFrontLeft", fov: 45 }),
    ],
    layoutFolders: [{ id: "lf-plaene", name: "Baueingabe", kind: "layout" }, { id: "lf-master", name: "Vorlagen", kind: "master" }],
    masterLayouts: [
      { id: "ml-a1", name: "Planrahmen A1 quer", paper: "a1", orientation: "landscape", folderId: "lf-master", border: true, titleBlock: { projectName: "Musterhaus komplex, Musterweg 12, Küsnacht", author: "Muster Architekten AG", date: "30.10.2026" } },
      { id: "ml-a3", name: "Planrahmen A3 quer", paper: "a3", orientation: "landscape", folderId: "lf-master", border: true, titleBlock: { projectName: "Musterhaus komplex", author: "Muster Architekten AG", date: "30.10.2026" } },
    ],
    layouts: [
      {
        id: "lay-101", name: "Grundrisse UG / EG", paper: "a1", orientation: "landscape", planNumber: "101", masterId: "ml-a1", folderId: "lf-plaene", revision: "A",
        viewports: [{ id: "vp-101-ug", snapshotId: "vs-ug", xMm: 30, yMm: 40, widthMm: 370, heightMm: 430, scaleDenominator: 100 }, { id: "vp-101-eg", snapshotId: "vs-eg", xMm: 420, yMm: 40, widthMm: 370, heightMm: 430, scaleDenominator: 100 }],
        legends: [{ id: "leg-101", xMm: 30, yMm: 440, title: "Legende Materialien", kinds: ["hatch"] }],
      },
      {
        id: "lay-102", name: "Grundrisse OG / DG", paper: "a1", orientation: "landscape", planNumber: "102", masterId: "ml-a1", folderId: "lf-plaene", revision: "A",
        viewports: [{ id: "vp-102-og", snapshotId: "vs-og", xMm: 30, yMm: 40, widthMm: 370, heightMm: 430, scaleDenominator: 100 }, { id: "vp-102-dg", snapshotId: "vs-dg", xMm: 420, yMm: 40, widthMm: 370, heightMm: 430, scaleDenominator: 100 }],
      },
      {
        id: "lay-103", name: "Grundriss EG Wohnen 1:50", paper: "a1", orientation: "landscape", planNumber: "103", masterId: "ml-a1", folderId: "lf-plaene",
        viewports: [{ id: "vp-103", snapshotId: "vs-eg50", xMm: 30, yMm: 30, widthMm: 620, heightMm: 520, scaleDenominator: 50 }],
        legends: [{ id: "leg-103", xMm: 670, yMm: 30, title: "Legende", kinds: ["hatch", "lineType", "category"] }],
      },
      {
        id: "lay-401", name: "Listen: Fenster, Türen, Flächen, U-Werte", paper: "a1", orientation: "landscape", planNumber: "401", masterId: "ml-a1", folderId: "lf-plaene",
        viewports: [],
        tables: [
          { id: "tab-fenster", source: "openings", filter: "window", xMm: 30, yMm: 30, widthMm: 380, columns: ["mark", "type", "floor", "rooms", "width", "height", "sill", "u", "notes"] },
          { id: "tab-tueren", source: "openings", filter: "door", xMm: 430, yMm: 30, widthMm: 380, columns: ["mark", "type", "floor", "width", "height", "swing", "fire", "sound", "rc"] },
          { id: "tab-flaechen", source: "areas", xMm: 30, yMm: 330, widthMm: 380 },
          { id: "tab-bauteile", source: "elements", xMm: 430, yMm: 300, widthMm: 380, heightMm: 120 },
          { id: "tab-raumprogramm", source: "rooms", xMm: 30, yMm: 440, widthMm: 380 },
          { id: "tab-erdarbeiten", source: "earthworks", xMm: 430, yMm: 440, widthMm: 380 },
        ],
      },
      {
        id: "lay-501", name: "Detail und Situation", paper: "a3", orientation: "landscape", planNumber: "501", masterId: "ml-a3", folderId: "lf-plaene",
        viewports: [{ id: "vp-501-det", snapshotId: "vs-detail", xMm: 15, yMm: 20, widthMm: 220, heightMm: 250, scaleDenominator: 10 }, { id: "vp-501-sit", snapshotId: "vs-situation", xMm: 245, yMm: 20, widthMm: 160, heightMm: 160, scaleDenominator: 500 }],
      },
      // Schnitte, Ansichten und 3D gehen (noch) nicht als Viewport: das Blatt rechnet nur Grundriss-Ebenen.
    ],
    publishSets: [
      { id: "pub-baueingabe", name: "Baueingabe", layoutIds: ["lay-101", "lay-102", "lay-401"], format: "pdf", namePattern: "{projectNumber}_{number}_{name}_{revision}", includeRevision: true, bumpRevision: true, pdfLayers: true },
      { id: "pub-ausfuehrung", name: "Ausführung 1:50", layoutIds: ["lay-103", "lay-501"], snapshotIds: ["vs-eg50"], format: "pdf", includeRevision: true },
    ],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Zusammenbau
// ═════════════════════════════════════════════════════════════════════════════

/** Musterhaus komplex — neues Projekt (braucht den geladenen Kern). */
export function buildComplexSampleProject(): Project {
  stampSeq = 0;
  const base: Project = {
    id: "musterhaus-komplex",
    name: "Musterhaus komplex",
    projectNumber: "2611",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: WALL_TYPES,
    ceilingTypes: CEILING_TYPES,
    roofTypes: ROOF_TYPES,
    windowTypes: WINDOW_TYPES,
    doorTypes: DOOR_TYPES,
    stairTypes: STAIR_TYPES,
    textStyles: [
      { id: "ts-titel", label: "Plantitel", marks: { bold: true, sizePt: 14 } },
      { id: "ts-liste", label: "Liste", marks: { sizePt: 7 } },
    ],
    blockDefs: [
      {
        id: "blk-nord", name: "Nordpfeil",
        geom2d: [
          { shape: "circle", center: P(0, 0), r: 1 },
          { shape: "polyline", pts: [P(0, 1.3), P(0.45, -0.8), P(0, -0.4), P(-0.45, -0.8)], closed: true },
          { shape: "text", at: P(-0.25, 1.5), text: "N", height: 0.6, angle: 0 },
        ],
      },
    ],
    drawingLevels: LEVELS,
    layers: LAYERS,
    scaleLineWeights: true,
    walls,
    openings,
    ceilings,
    roofs,
    stairs,
    rooms: [],
    columns,
    extrudedSolids,
    drawings2d: [...cadastre(), ...annotations()],
    context: [
      {
        type: "contourSet", id: "hoehenlinien", name: "Höhenlinien (Vermessung)", layer: "Terrain", categoryCode: "14",
        contours: CONTOUR_Z.map((z) => ({ z, pts: contourAt(z), closed: false, layer: Number.isInteger(z * 2) ? "HL-Haupt" : "HL" })),
      },
      {
        // Baugrube: Böschung 60° (Ost 50°), Nordkante (Hang) mit Rühlwand gesichert, Sohle unter der Bodenplatte.
        type: "excavation", id: "baugrube", name: "Baugrube Haupthaus", layer: "Terrain", categoryCode: "07",
        // Umriss = Gebäude-Grundfläche UG (mit Erker), Arbeitsraum 0.8 m; Neigungen in Grad.
        outline: rect(-HA, -HA, 17.2, 10 + HA), bottom: -0.65, slope: 60, fillSlope: 33.7,
        edgeSlopes: [60, 50, 90, 60], edgeShoring: [false, false, true, false], workingSpace: 0.8,
      },
    ],
    roomProgram: [
      { name: "Wohnen/Essen/Küche", siaCategory: "HNF", area: 55, count: 2, group: "Wohnungen", note: "je Wohnung" },
      { name: "Zimmer", siaCategory: "HNF", area: 14, count: 4, group: "Wohnungen" },
      { name: "Schlafen", siaCategory: "HNF", area: 30, count: 1, group: "Maisonette" },
      { name: "Atelier", siaCategory: "HNF", area: 20, count: 1, group: "Wohnungen" },
      { name: "Bad", siaCategory: "NNF", area: 8, count: 3, group: "Nasszellen" },
      { name: "Keller", siaCategory: "NNF", area: 25, count: 1, group: "Nebenräume" },
      { name: "Technik", siaCategory: "FF", area: 12, count: 1, group: "Nebenräume" },
    ],
    roomProgramTolerance: 0.1,
    parcelArea: 1540,
    sunStudy: { when: "2026-06-21T10:00:00Z", show: true },
    siteRules: {
      parcel: PARCEL,
      // Grenzabstände je Parzellenkante (Süd, Ost, Nord, West); Baulinie entlang der Strasse.
      setbacks: [5, 5, 4, 5], defaultSetback: 5,
      buildingLines: [{ a: P(-15, 19.5), b: P(29, 18.5) }],
      maxHeight: 15, show: true,
    },
    referenceElevationMasl: 512.4,
    geoAnchor: { lv95: { e: 2689540, n: 1240310 }, height: 512.4, model: P(0, 0), label: "Musterweg 12, 8700 Küsnacht (fiktiv)" },
    groups: [
      { id: "grp-carport", name: "Carport", wallIds: [], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: columns.filter((c) => c.id.startsWith("st-carport")).map((c) => c.id), roofIds: ["dach-carport"], openingIds: [], groupIds: [] },
    ],
    ...views(),
  };

  // Standard-Bibliothek SIA 400 (Baustoffe, Schraffuren, Linientypen, Aufbauten).
  let p = withStandards(base);

  // Gelände aus den Höhenlinien (Kern: geglättetes TIN mit Bruchkanten).
  p = runCmd(p, "ug", "terrain", {}).project;

  // Freie Körper im Garten: Loft (Pflanzgefäss, quadratisch → gedreht) und Rotationskörper (Sitzrolle).
  const profiles: Drawing2D[] = [
    { id: "prof-loft-1", type: "drawing2d", levelId: "ug", categoryCode: "20", geom: { shape: "rect", min: P(-3.6, -6.6), max: P(-2.4, -5.4) } },
    { id: "prof-loft-2", type: "drawing2d", levelId: "ug", categoryCode: "20", geom: { shape: "polyline", pts: [P(-3.0, -6.85), P(-2.15, -6.0), P(-3.0, -5.15), P(-3.85, -6.0)], closed: true } },
    { id: "prof-rev", type: "drawing2d", levelId: "ug", categoryCode: "20", geom: { shape: "rect", min: P(0.5, -4.3), max: P(2.3, -4.05) } },
  ];
  p = { ...p, drawings2d: [...p.drawings2d, ...profiles] };
  p = runCmd(p, "ug", "loft", { sources: ["prof-loft-1", "prof-loft-2"], height: 0.9 }).project;
  p = runCmd(p, "ug", "revolve", { source: "prof-rev", a: [0.5, -4.6], b: [2.3, -4.6], angle: 360 }).project;

  // Räume per Raumerkennung (Umriss = Innenkontur der Wände).
  p = addRooms(p);

  // Aussenbemassung (Massketten je Fassade) in UG, EG, OG.
  for (const f of ["ug", "eg", "og"]) p = runCmd(p, f, "autodim", {}, "80").project;
  return p;
}
