// Geschnittene Fenster/Türen im Schnitt. Der Schnitt-Extraktor (section.rs)
// spart in einer geschnittenen Wand nur die Öffnung aus (Brüstung + Sturz als
// Poché, dazwischen nichts) — das Fenster selbst fehlte, die Öffnung wirkte wie
// ein Loch. Hier entsteht der vertikale Querschnitt des Öffnungselements:
//   • Fenster: Blendrahmen-Profil unten (auf der Brüstung) und oben (am Sturz)
//     über die Rahmentiefe + Glaslinie(n) dazwischen. Rahmentiefe/-lage und
//     Glas-Lage stammen aus DEMSELBEN `windowSymbol` wie der Grundriss — die
//     Lage in der Wand stimmt also mit dem Grundriss überein.
//   • Tür: Zargen-Profil am Sturz + geschlossenes Türblatt.
// Alles in Schnitt-Koordinaten (u, Höhe), wie `SectionOutput`.

import type { DrawingLevel, Opening, Project, Vec2, Wall } from "../model/types";
import { getWallType, getWindowType, sashesOfWindowType, wallTypeThickness } from "../model/types";
import { dot, sub } from "../model/geometry";
import { wallReferenceOffset } from "../model/wall";
import { openingInterval, openingVerticalExtent, wallAxisFrame, windowSymbol } from "../geometry/opening";
import { NO_HATCH, SHOW_ALL, type CategoryDisplayResolver, type Primitive } from "./generatePlan/shared";
import { sectionPlaneFromLevel, sectionUAxisModel } from "./toSection";

const INK = "#1f242c";
/** Umriss geschnittener Rahmen-/Blattprofile (mm Papier). */
const FRAME_MM = 0.25;
/** Glaslinien (mm Papier). */
const GLASS_MM = 0.13;
/** Default-Rahmentiefe/-profilbreite (m), wie im Grundriss (`opening.ts`). */
const DEFAULT_FRAME_DEPTH = 0.07;
const DEFAULT_FRAME_WIDTH = 0.06;
/** Türblatt-Dicke (m). */
const DOOR_LEAF_THICKNESS = 0.04;
/** Unter diesem |cos| zwischen Wandnormale und Schnitt-u gilt die Wand als
 *  (fast) parallel zum Schnitt — dort gibt es keinen sinnvollen Querschnitt. */
const MIN_CROSS = 0.15;

const rect = (u0: number, u1: number, v0: number, v1: number): Vec2[] => [
  { x: Math.min(u0, u1), y: v0 },
  { x: Math.max(u0, u1), y: v0 },
  { x: Math.max(u0, u1), y: v1 },
  { x: Math.min(u0, u1), y: v1 },
];

/**
 * Plan-Primitive (u, Höhe) aller Fenster/Türen, deren Wand die Schnittebene der
 * Ebene `level` IM Bereich der Öffnung kreuzt. Jedes Primitiv trägt die
 * `openingId` — ein Klick im Schnitt wählt die Öffnung.
 */
export function sectionOpeningPrimitives(
  project: Project,
  level: DrawingLevel,
  visibleCodes?: Set<string>,
  categoryDisplay: CategoryDisplayResolver = SHOW_ALL,
): Primitive[] {
  const plane = sectionPlaneFromLevel(level);
  if (!plane || level.kind !== "section") return [];
  const uRaw = sectionUAxisModel(plane);
  const uLen = Math.hypot(uRaw.x, uRaw.y) || 1;
  const U: Vec2 = { x: uRaw.x / uLen, y: uRaw.y / uLen };
  const P0: Vec2 = { x: plane.point[0], y: plane.point[2] };
  const wallsById = new Map(project.walls.map((w) => [w.id, w]));
  const out: Primitive[] = [];

  for (const o of project.openings ?? []) {
    if (visibleCodes && !visibleCodes.has(o.categoryCode)) continue;
    const disp = categoryDisplay(o.categoryCode);
    if (!disp.render) continue;
    const wall = wallsById.get(o.hostWallId);
    if (!wall) continue;
    if (visibleCodes && !visibleCodes.has(wall.categoryCode)) continue;
    const cut = crossSection(project, wall, o, P0, U);
    if (!cut) continue;
    const prims = o.kind === "window" ? windowCut(project, wall, o, cut) : doorCut(o, cut);
    for (const p of prims) out.push(disp.greyed ? ({ ...p, greyed: true } as Primitive) : p);
  }
  return out;
}

/** Abbildung "Offset quer zur Wand (n)" → Schnitt-u, falls die Schnittebene die
 *  Wandachse innerhalb der Öffnung kreuzt. */
interface CrossSection {
  /** u eines Punktes mit Wand-Offset `s` (entlang der linken Normalen). */
  uAt: (s: number) => number;
  zBottom: number;
  zTop: number;
  /** Wand-Offsets der Wandflächen (min/max). */
  faceMin: number;
  faceMax: number;
}

function crossSection(project: Project, wall: Wall, o: Opening, P0: Vec2, U: Vec2): CrossSection | null {
  const iv = openingInterval(wall, o);
  if (!iv) return null;
  const { u: a, n } = wallAxisFrame(wall);
  const un = dot(U, n);
  if (Math.abs(un) < MIN_CROSS) return null;
  const rel = sub(P0, wall.start);
  const n0 = dot(rel, n);
  const a0 = dot(rel, a);
  const ua = dot(U, a);
  // Schnittlinie p(t) = P0 + t·U; Offset quer zur Wand: n0 + t·un.
  const tAt = (s: number) => (s - n0) / un;
  // Lage entlang der Achse dort, wo die Schnittlinie die Wandmitte quert.
  const total = wallTypeThickness(getWallType(project, wall));
  const refOff = wallReferenceOffset(wall, total);
  const along = a0 + tAt(refOff) * ua;
  if (along < iv.from + 1e-4 || along > iv.to - 1e-4) return null;
  const { zBottom, zTop } = openingVerticalExtent(project, wall, o);
  if (zTop - zBottom < 1e-3) return null;
  return {
    uAt: (s) => tAt(s),
    zBottom,
    zTop,
    faceMin: refOff - total / 2,
    faceMax: refOff + total / 2,
  };
}

const profile = (pts: Vec2[], openingId: string): Primitive => ({
  kind: "polygon",
  pts,
  fill: "#ffffff",
  stroke: INK,
  strokeWidthMm: FRAME_MM,
  hatch: NO_HATCH,
  openingId,
});

const pick = (pts: Vec2[], openingId: string): Primitive => ({
  kind: "polygon",
  pts,
  fill: "none",
  stroke: "none",
  strokeWidthMm: 0,
  hatch: NO_HATCH,
  openingId,
});

function windowCut(project: Project, wall: Wall, o: Opening, c: CrossSection): Primitive[] {
  const wt = getWindowType(project, o);
  const spec = wt
    ? {
        sashes: sashesOfWindowType(wt),
        frameWidth: wt.frameWidth ?? DEFAULT_FRAME_WIDTH,
        frameDepth: wt.frameDepth,
        insetFromFace: wt.insetFromFace,
        insetFace: wt.insetFace,
      }
    : undefined;
  const fw = Math.max(0.02, spec?.frameWidth ?? DEFAULT_FRAME_WIDTH);
  const { n } = wallAxisFrame(wall);
  const offOf = (p: Vec2) => dot(sub(p, wall.start), n);

  // Rahmenband quer zur Wand aus dem Grundriss-Symbol (gleiche Lage wie dort).
  let fMin = (c.faceMin + c.faceMax) / 2 - DEFAULT_FRAME_DEPTH / 2;
  let fMax = fMin + DEFAULT_FRAME_DEPTH;
  let glass: number[] = [(fMin + fMax) / 2];
  const sym = windowSymbol(project, wall, o, 1, spec, "mittel");
  if (sym && spec) {
    const offs = sym.frame.map(offOf);
    fMin = Math.min(...offs);
    fMax = Math.max(...offs);
    const g = sym.glassLines.map(([p]) => offOf(p));
    if (g.length > 0) glass = [...new Set(g.map((x) => Math.round(x * 1e6) / 1e6))];
  }
  const u0 = c.uAt(fMin);
  const u1 = c.uAt(fMax);
  const h = c.zTop - c.zBottom;
  const fwv = Math.min(fw, h / 3);
  const out: Primitive[] = [pick(rect(c.uAt(c.faceMin), c.uAt(c.faceMax), c.zBottom, c.zTop), o.id)];
  out.push(profile(rect(u0, u1, c.zBottom, c.zBottom + fwv), o.id));
  out.push(profile(rect(u0, u1, c.zTop - fwv, c.zTop), o.id));
  for (const s of glass) {
    const u = c.uAt(s);
    out.push({
      kind: "line",
      a: { x: u, y: c.zBottom + fwv },
      b: { x: u, y: c.zTop - fwv },
      cls: "section-window-glass",
      weightMm: GLASS_MM,
      color: INK,
      openingId: o.id,
    });
  }
  return out;
}

function doorCut(o: Opening, c: CrossSection): Primitive[] {
  const out: Primitive[] = [pick(rect(c.uAt(c.faceMin), c.uAt(c.faceMax), c.zBottom, c.zTop), o.id)];
  if (o.doorType === "wandoeffnung") return out;
  const mid = (c.faceMin + c.faceMax) / 2;
  const fw = Math.min(DEFAULT_FRAME_WIDTH, (c.zTop - c.zBottom) / 4);
  // Zarge am Sturz über die Rahmentiefe.
  out.push(
    profile(
      rect(c.uAt(mid - DEFAULT_FRAME_DEPTH / 2), c.uAt(mid + DEFAULT_FRAME_DEPTH / 2), c.zTop - fw, c.zTop),
      o.id,
    ),
  );
  // Geschlossenes Türblatt (knapp über Boden bis unter die Zarge).
  out.push(
    profile(
      rect(
        c.uAt(mid - DOOR_LEAF_THICKNESS / 2),
        c.uAt(mid + DOOR_LEAF_THICKNESS / 2),
        c.zBottom + 0.01,
        c.zTop - fw,
      ),
      o.id,
    ),
  );
  return out;
}
