// Sonnenstand und Schattenwurf im Grundriss (Lageplan-Schattenstudie, [64]/[59]).
//
//  • `sunPosition`: Azimut (° von Nord im Uhrzeigersinn) und Höhe (°) nach dem vereinfachten
//    NOAA-Verfahren (Genauigkeit ~0.1°, ohne Refraktion).
//  • `shadowOfPrism`/`shadowPolygons`: Boden-Schatten (z = 0) von Wänden, freien Körpern und
//    Dächern als Vereinigung konvexer Hüllen (Prisma ∪ verschobenes Prisma). Modell: x = Ost,
//    y = Nord, Höhen über dem Geländenullpunkt (Meter).

import polygonClipping from "polygon-clipping";
import type { Pair, Polygon as PcPolygon } from "polygon-clipping";
import type { Project, Vec2 } from "../model/types";
import { wallVerticalExtent } from "../model/wall";
import { roofBaseElevation, roofGeometry } from "../geometry/roof";
import { lv95ToWgs84 } from "../io/lv95";
import { getFloor, getWallType, wallTypeThickness } from "../model/types";

export interface SunPosition {
  /** Grad von Nord im Uhrzeigersinn (Ost = 90, Süd = 180). */
  azimuth: number;
  /** Grad über dem Horizont (negativ = Nacht). */
  elevation: number;
}

const RAD = Math.PI / 180;

export function sunPosition(latDeg: number, lonDeg: number, when: Date): SunPosition {
  const jd = when.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  // Greenwich-Sternzeit → Stundenwinkel.
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  const ha = (((gmst + lonDeg) * RAD - ra) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  const lat = latDeg * RAD;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
  const el = Math.asin(sinEl);
  const az = Math.atan2(-Math.sin(ha) * Math.cos(dec), Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(ha));
  return { azimuth: (((az / RAD) % 360) + 360) % 360, elevation: el / RAD };
}

/** Breite/Länge des Projekts aus `geoAnchor` (LV95), sonst Zürich als Platzhalter. */
export function projectLatLon(project: Project): { lat: number; lon: number } {
  const a = project.geoAnchor;
  if (a) {
    const p = lv95ToWgs84(a.lv95.e, a.lv95.n);
    return { lat: p.lat, lon: p.lon };
  }
  return { lat: 47.3769, lon: 8.5417 };
}

function hull(points: Vec2[]): Vec2[] {
  const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (const q of p.slice().reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Verschiebung des Schattens je Meter Höhe (Richtung von der Sonne weg). */
function shadowShift(sun: SunPosition): Vec2 | null {
  if (sun.elevation <= 0.5) return null;
  const k = 1 / Math.tan(sun.elevation * RAD);
  const az = sun.azimuth * RAD;
  return { x: -Math.sin(az) * k, y: -Math.cos(az) * k };
}

/** Boden-Schatten eines Prismas `footprint` von `zBottom` bis `zTop` (leer bei Nacht). */
export function shadowOfPrism(footprint: Vec2[], zBottom: number, zTop: number, sun: SunPosition): Vec2[] {
  const k = shadowShift(sun);
  if (!k || zTop <= zBottom || footprint.length < 3) return [];
  const pts: Vec2[] = [];
  for (const p of footprint) {
    pts.push({ x: p.x + k.x * zBottom, y: p.y + k.y * zBottom });
    pts.push({ x: p.x + k.x * zTop, y: p.y + k.y * zTop });
  }
  return hull(pts);
}

/** Vereinigter Schatten aller Wände, Körper und Dächer als Polygone (Aussenring + Löcher je Eintrag). */
export function shadowPolygons(project: Project, sun: SunPosition): Vec2[][] {
  if (shadowShift(sun) === null) return [];
  const parts: Vec2[][] = [];
  for (const w of project.walls) {
    const { zBottom, zTop } = wallVerticalExtent(project, w);
    const dx = w.end.x - w.start.x;
    const dy = w.end.y - w.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const t = wallTypeThickness(getWallType(project, w)) / 2;
    const nx = (-dy / len) * t;
    const ny = (dx / len) * t;
    const fp = [
      { x: w.start.x + nx, y: w.start.y + ny },
      { x: w.end.x + nx, y: w.end.y + ny },
      { x: w.end.x - nx, y: w.end.y - ny },
      { x: w.start.x - nx, y: w.start.y - ny },
    ];
    parts.push(shadowOfPrism(fp, zBottom, zTop, sun));
  }
  for (const s of project.extrudedSolids ?? []) {
    if (s.operation === "subtract") continue;
    let base = 0;
    try {
      base = getFloor(project, s.levelId).baseElevation ?? 0;
    } catch {
      /* Geschoss fehlt → 0 */
    }
    const z0 = base + (s.baseOffset ?? 0);
    parts.push(shadowOfPrism(s.points, z0, z0 + s.height, sun));
  }
  for (const r of project.roofs ?? []) {
    const eavesZ = roofBaseElevation(project, r);
    const geo = roofGeometry(r, eavesZ);
    const k = shadowShift(sun)!;
    const pts: Vec2[] = geo.eaves.map((p) => ({ x: p.x + k.x * eavesZ, y: p.y + k.y * eavesZ }));
    const top = eavesZ + geo.ridgeHeight;
    for (const [a, b] of geo.ridges) for (const p of [a, b]) pts.push({ x: p.x + k.x * top, y: p.y + k.y * top });
    for (const [, b] of geo.hips) pts.push({ x: b.x + k.x * top, y: b.y + k.y * top });
    // Traufkante auf Traufhöhe + Firstpunkte → Hülle (Dach ist konvex genug für die Studie).
    for (const p of geo.eaves) pts.push({ x: p.x + k.x * top, y: p.y + k.y * top });
    parts.push(hull(pts));
  }
  const polys: PcPolygon[] = parts
    .filter((p) => p.length >= 3)
    .map((p) => [[...p.map((q): Pair => [q.x, q.y]), [p[0].x, p[0].y] as Pair]]);
  if (polys.length === 0) return [];
  const union = polygonClipping.union(polys[0], ...polys.slice(1));
  // Pro Teilpolygon nur der Aussenring (Löcher eines Schattens sind Hofflächen: bewusst mitgeben).
  const out: Vec2[][] = [];
  for (const poly of union) for (const ring of poly) out.push(ring.slice(0, -1).map(([x, y]) => ({ x, y })));
  return out;
}
