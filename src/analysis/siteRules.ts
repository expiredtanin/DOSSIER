// Baurecht der Parzelle ([63]): zulässige Grundfläche aus Grenzabständen und Baulinien, Prüfung
// des Modells (Grundfläche ausserhalb, Gesamthöhe).
//
//  • Grenzabstand: gesperrt ist alles, was näher als d_i an Kante i liegt (Streifen um die Kante
//    mit gerundeten Enden) — so stimmen auch konkave Parzellen und einspringende Ecken.
//  • Baulinie: Halbebene auf der Seite des Parzellen-Schwerpunkts.
//  • Gebäude-Grundfläche: Wände aller Geschosse und freie Körper (ohne Abzugskörper). Vorsprünge
//    (Dachüberstand, Balkone) und ihre Sonderregeln zählen nicht.

import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Pair, Polygon as PcPolygon } from "polygon-clipping";
import type { Project, SiteRules, Vec2 } from "../model/types";
import { getFloor, getWallType, wallTypeThickness } from "../model/types";
import { wallVerticalExtent } from "../model/wall";
import { wallCorners } from "../model/geometry";
import { roofBaseElevation, roofGeometry } from "../geometry/roof";
import { polygonArea } from "../geometry/roomArea";

/** Polygone mit Ringen: `[polygon][ring]`, Ring 0 aussen, weitere Löcher; Ringe offen. */
export type Area = Vec2[][][];

const ring = (pts: Vec2[]): Pair[] => [...pts.map((p): Pair => [p.x, p.y]), [pts[0].x, pts[0].y]];
const fromPc = (mp: MultiPolygon): Area => mp.map((poly) => poly.map((r) => r.slice(0, -1).map(([x, y]) => ({ x, y }))));
const toPc = (a: Area): MultiPolygon => a.map((poly) => poly.map(ring));

/** Fläche einer Mehrfach-Fläche (Löcher abgezogen). */
export function multiPolygonArea(a: Area): number {
  let s = 0;
  for (const poly of a) poly.forEach((r, i) => (s += (i === 0 ? 1 : -1) * polygonArea(r)));
  return s;
}

/** Streifen um die Strecke a–b mit Halbbreite d und Halbkreis-Enden (Polygon-Näherung). */
function capsule(a: Vec2, b: Vec2, d: number, segs = 12): Vec2[] {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const pts: Vec2[] = [];
  // Halbkreis um b (von rechts nach links der Richtung), dann um a; Polygon-Ecken AUSSERHALB
  // des Kreises (Radius / cos), damit der gesperrte Streifen nie zu schmal gerät.
  const r = d / Math.cos(Math.PI / (2 * segs));
  for (let i = 0; i <= segs; i++) {
    const t = ang - Math.PI / 2 + (Math.PI * i) / segs;
    const rr = i === 0 || i === segs ? d : r;
    pts.push({ x: b.x + rr * Math.cos(t), y: b.y + rr * Math.sin(t) });
  }
  for (let i = 0; i <= segs; i++) {
    const t = ang + Math.PI / 2 + (Math.PI * i) / segs;
    const rr = i === 0 || i === segs ? d : r;
    pts.push({ x: a.x + rr * Math.cos(t), y: a.y + rr * Math.sin(t) });
  }
  return pts;
}

function centroid(pts: Vec2[]): Vec2 {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const c = p.x * q.y - q.x * p.y;
    a += c; cx += (p.x + q.x) * c; cy += (p.y + q.y) * c;
  }
  if (Math.abs(a) < 1e-12) return pts[0];
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Grosses Rechteck = Halbebene der Baulinie a–b auf der Seite von `inside`. */
function halfPlane(a: Vec2, b: Vec2, inside: Vec2, size: number): PcPolygon | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9)) return null;
  const ux = dx / len, uy = dy / len;
  // Normale zur Innenseite.
  let nx = -uy, ny = ux;
  if ((inside.x - a.x) * nx + (inside.y - a.y) * ny < 0) { nx = -nx; ny = -ny; }
  const p0 = { x: a.x - ux * size, y: a.y - uy * size };
  const p1 = { x: a.x + ux * size, y: a.y + uy * size };
  return [ring([p0, p1, { x: p1.x + nx * size, y: p1.y + ny * size }, { x: p0.x + nx * size, y: p0.y + ny * size }])];
}

const validParcel = (r: SiteRules) =>
  Array.isArray(r.parcel) && r.parcel.length >= 3 && r.parcel.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) && polygonArea(r.parcel) > 1e-9;

/** Grenzabstand der Kante i (ungültig/negativ → 0). */
export function setbackOf(r: SiteRules, i: number): number {
  const v = r.setbacks?.[i] ?? r.defaultSetback;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Zulässige Grundfläche (leer bei ungültiger Parzelle). */
export function allowedArea(r: SiteRules): Area {
  if (!validParcel(r)) return [];
  const n = r.parcel.length;
  let mp: MultiPolygon = [[ring(r.parcel)]];
  const strips: PcPolygon[] = [];
  for (let i = 0; i < n; i++) {
    const d = setbackOf(r, i);
    if (d > 0) strips.push([ring(capsule(r.parcel[i], r.parcel[(i + 1) % n], d))]);
  }
  if (strips.length > 0) mp = polygonClipping.difference(mp, ...strips);
  const c = centroid(r.parcel);
  const xs = r.parcel.map((p) => p.x), ys = r.parcel.map((p) => p.y);
  const size = 10 * (Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys) + 1);
  for (const line of r.buildingLines ?? []) {
    const h = halfPlane(line.a, line.b, c, size);
    if (h && mp.length > 0) mp = polygonClipping.intersection(mp, h);
  }
  return fromPc(mp);
}

/** Grundfläche des Gebäudes (Wände aller Geschosse, freie Körper ohne Abzugskörper). */
export function buildingFootprint(project: Project): Area {
  const parts: PcPolygon[] = [];
  for (const w of project.walls) {
    if (Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y) < 1e-9) continue;
    parts.push([ring(wallCorners(w.start, w.end, wallTypeThickness(getWallType(project, w))))]);
  }
  for (const s of project.extrudedSolids ?? []) {
    if (s.operation === "subtract" || s.points.length < 3) continue;
    parts.push([ring(s.points)]);
  }
  if (parts.length === 0) return [];
  return fromPc(polygonClipping.union(parts[0], ...parts.slice(1)));
}

/** Höchster Punkt des Modells über ±0.00 (Wände, freie Körper, Dächer); `null` ohne Bauteile. */
export function modelTop(project: Project): number | null {
  let top = -Infinity;
  for (const w of project.walls) top = Math.max(top, wallVerticalExtent(project, w).zTop);
  for (const s of project.extrudedSolids ?? []) {
    if (s.operation === "subtract") continue;
    let base = 0;
    try {
      base = getFloor(project, s.levelId).baseElevation ?? 0;
    } catch {
      /* Geschoss fehlt → 0 */
    }
    top = Math.max(top, base + (s.baseOffset ?? 0) + s.height);
  }
  for (const r of project.roofs ?? []) {
    const eavesZ = roofBaseElevation(project, r);
    top = Math.max(top, eavesZ + roofGeometry(r, eavesZ).ridgeHeight);
  }
  return Number.isFinite(top) ? top : null;
}

export interface SiteCheck {
  parcelArea: number;
  allowed: Area;
  allowedArea: number;
  /** Gebäude-Grundfläche ausserhalb der zulässigen Fläche. */
  violations: Area;
  violationArea: number;
  maxTop: number | null;
  heightExceeded: boolean;
}

/** Prüft das Modell gegen `project.siteRules`; `null` ohne (gültiges) Baurecht. */
export function checkSiteRules(project: Project): SiteCheck | null {
  const r = project.siteRules;
  if (!r || !validParcel(r)) return null;
  const allowed = allowedArea(r);
  const fp = buildingFootprint(project);
  const violations = fp.length === 0 ? [] : allowed.length === 0 ? fp : fromPc(polygonClipping.difference(toPc(fp), toPc(allowed)));
  // Kleinste Splitter (Rundung an gemeinsamen Kanten) nicht als Verstoss melden.
  const real = violations.filter((poly) => polygonArea(poly[0]) > 1e-4);
  const maxTop = modelTop(project);
  return {
    parcelArea: polygonArea(r.parcel),
    allowed,
    allowedArea: multiPolygonArea(allowed),
    violations: real,
    violationArea: multiPolygonArea(real),
    maxTop,
    heightExceeded: r.maxHeight !== undefined && maxTop !== null && maxTop > r.maxHeight + 1e-6,
  };
}
