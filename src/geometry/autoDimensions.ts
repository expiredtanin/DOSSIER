// Automatische Aussenbemassung ([81]): je Gebäudeseite (Süd, Ost, Nord, West) bis zu drei
// Massketten ausserhalb des Grundrisses, von innen nach aussen:
//   1. Öffnungen — Gebäudeecken der Seite plus Leibungen der Fenster/Türen in Wänden dieser Seite,
//   2. Vor-/Rücksprünge — die Ecken der nach dieser Seite schauenden Aussenkanten (nur bei Stufung),
//   3. Gesamtmass.
// Grundlage ist die vereinigte Grundfläche der Wände des Geschosses (an verbundenen Enden um die
// halbe Dicke verlängert, damit Aussenecken voll sind). Nur achsparallele Kanten werden bemasst;
// schiefe Wände fehlen in den Ketten. Ergebnis sind gewöhnliche Bemassungen (Drawing2D), danach
// frei bearbeitbar.

import polygonClipping from "polygon-clipping";
import type { Pair, Polygon as PcPolygon } from "polygon-clipping";
import type { Drawing2D, Project, Vec2, Wall } from "../model/types";
import { getWallType, wallTypeThickness } from "../model/types";
import { openingJambs } from "./opening";

export type DimSide = "south" | "east" | "north" | "west";
export type DimChain = "openings" | "steps" | "total";

export interface AutoDimension {
  side: DimSide;
  chain: DimChain;
  drawing: Drawing2D;
}

/** Aussennormalen der Seiten (Modell: x = Ost, y = Nord). */
const SIDES: { side: DimSide; n: Vec2 }[] = [
  { side: "south", n: { x: 0, y: -1 } },
  { side: "east", n: { x: 1, y: 0 } },
  { side: "north", n: { x: 0, y: 1 } },
  { side: "west", n: { x: -1, y: 0 } },
];

const EPS = 1e-6;
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;

/** Abstand der Ketten von der äussersten Kante in Papier-mm (1:100 → 1.0 / 1.7 / 2.4 m). */
const CHAIN_MM = { openings: 10, steps: 17, total: 24 } as const;

function wallRect(w: Wall, t: number, extStart: number, extEnd: number): Vec2[] {
  const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;
  const nx = -uy * (t / 2), ny = ux * (t / 2);
  const a = { x: w.start.x - ux * extStart, y: w.start.y - uy * extStart };
  const b = { x: w.end.x + ux * extEnd, y: w.end.y + uy * extEnd };
  return [
    { x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny },
  ];
}

/** Liegt `p` auf einer anderen Wandachse (Ende oder dazwischen)? Dann ist das Wandende verbunden. */
function connected(p: Vec2, self: Wall, walls: Wall[]): boolean {
  for (const o of walls) {
    if (o === self) continue;
    const dx = o.end.x - o.start.x, dy = o.end.y - o.start.y;
    const l2 = dx * dx + dy * dy;
    if (l2 < EPS) continue;
    const t = Math.max(0, Math.min(1, ((p.x - o.start.x) * dx + (p.y - o.start.y) * dy) / l2));
    if (Math.hypot(o.start.x + t * dx - p.x, o.start.y + t * dy - p.y) < 1e-3) return true;
  }
  return false;
}

/** Aussenringe der vereinigten Wand-Grundfläche (gegen den Uhrzeigersinn). */
function outerRings(project: Project, walls: Wall[]): Vec2[][] {
  const parts: PcPolygon[] = [];
  for (const w of walls) {
    if (Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y) < EPS) continue;
    let t = 0.3;
    try {
      t = wallTypeThickness(getWallType(project, w));
    } catch {
      /* verwaister Wandtyp */
    }
    const r = wallRect(w, t, connected(w.start, w, walls) ? t / 2 : 0, connected(w.end, w, walls) ? t / 2 : 0);
    parts.push([[...r.map((p): Pair => [p.x, p.y]), [r[0].x, r[0].y]]]);
  }
  if (parts.length === 0) return [];
  const rings: Vec2[][] = [];
  for (const poly of polygonClipping.union(parts[0], ...parts.slice(1))) {
    const ring = poly[0].slice(0, -1).map(([x, y]) => ({ x, y }));
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      a += p.x * q.y - q.x * p.y;
    }
    rings.push(a < 0 ? ring.reverse() : ring);
  }
  return rings;
}

/** Werte zusammenfassen, die näher als 1 mm beieinander liegen (sortiert). */
function uniqueSorted(vals: number[]): number[] {
  const s = vals.slice().sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) if (out.length === 0 || v - out[out.length - 1] > 1e-3) out.push(v);
  return out;
}

/**
 * Erzeugt die Aussenbemassung eines Geschosses. `scaleDenominator` bestimmt den Abstand der
 * Ketten (Papier-mm → Modell-Meter), `categoryCode` die Ebene der neuen Bemassungen.
 */
export function autoExteriorDimensions(
  project: Project,
  floorId: string,
  categoryCode: string,
  scaleDenominator = 100,
  idPrefix = "autodim",
): AutoDimension[] {
  const walls = project.walls.filter((w) => w.floorId === floorId);
  const rings = outerRings(project, walls);
  if (rings.length === 0) return [];
  const toM = (mm: number) => (mm / 1000) * scaleDenominator;
  const out: AutoDimension[] = [];

  for (const { side, n } of SIDES) {
    // Laufrichtung so, dass die linke Normale = Aussennormale ist (positiver Abstand = aussen).
    const u: Vec2 = { x: n.y, y: -n.x };
    let sMax = -Infinity, tMin = Infinity, tMax = -Infinity;
    const corners: number[] = [];
    // Kanten, die nach `n` schauen: Aussennormale (rechte Normale eines CCW-Rings) ≈ n.
    const faces: { s: number; t0: number; t1: number }[] = [];
    for (const ring of rings) {
      for (const p of ring) {
        sMax = Math.max(sMax, dot(p, n));
        tMin = Math.min(tMin, dot(p, u));
        tMax = Math.max(tMax, dot(p, u));
      }
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < EPS) continue;
        const outward = { x: dy / len, y: -dx / len };
        if (dot(outward, n) < 1 - 1e-6) continue; // nur achsparallele, nach n schauende Kanten
        const ta = dot(a, u), tb = dot(b, u);
        faces.push({ s: dot(a, n), t0: Math.min(ta, tb), t1: Math.max(ta, tb) });
        corners.push(ta, tb);
      }
    }
    if (faces.length === 0) continue;

    // Öffnungen in Wänden, deren Aussenseite auf einer dieser Kanten liegt.
    const jambs: number[] = [];
    for (const o of project.openings ?? []) {
      const w = walls.find((x) => x.id === o.hostWallId);
      if (!w) continue;
      const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y;
      const len = Math.hypot(dx, dy);
      if (len < EPS || Math.abs(dot({ x: dx / len, y: dy / len }, n)) > 1e-6) continue; // Wand quer zu n
      let t = 0.3;
      try {
        t = wallTypeThickness(getWallType(project, w));
      } catch {
        /* verwaister Wandtyp */
      }
      const outerS = dot(w.start, n) + t / 2;
      const j = openingJambs(w, o);
      if (!j) continue;
      const ja = dot(j.jambStart, u), jb = dot(j.jambEnd, u);
      const onFace = faces.some((f) => Math.abs(f.s - outerS) < 1e-3 && Math.min(ja, jb) >= f.t0 - 1e-3 && Math.max(ja, jb) <= f.t1 + 1e-3);
      if (onFace) jambs.push(ja, jb);
    }

    const chains: { chain: DimChain; ts: number[] }[] = [];
    const total = [tMin, tMax];
    const steps = uniqueSorted(corners);
    if (jambs.length > 0) chains.push({ chain: "openings", ts: uniqueSorted([...steps, ...jambs]) });
    if (steps.length > 2) chains.push({ chain: "steps", ts: steps });
    chains.push({ chain: "total", ts: total });

    for (const { chain, ts } of chains) {
      if (ts.length < 2) continue;
      const pts = ts.map((t) => ({ x: u.x * t + n.x * sMax, y: u.y * t + n.y * sMax }));
      out.push({
        side,
        chain,
        drawing: {
          id: `${idPrefix}-${floorId}-${side}-${chain}`,
          type: "drawing2d",
          levelId: floorId,
          categoryCode,
          geom: { shape: "dimension", pts, offset: toM(CHAIN_MM[chain]) },
        } as Drawing2D,
      });
    }
  }
  return out;
}
