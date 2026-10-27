// Sonnenstand und Schattenwurf im Grundriss (Lageplan-Schattenstudie, [64]/[59]).
//
//  • `sunPosition`: Azimut (° von Nord im Uhrzeigersinn) und Höhe (°) nach dem vereinfachten
//    NOAA-Verfahren (Genauigkeit ~0.1°, ohne Refraktion).
//  • `shadowOfPrism`/`shadowPolygons`: Boden-Schatten (z = 0) von Wänden, freien Körpern und
//    Dächern als Vereinigung konvexer Hüllen (Prisma ∪ verschobenes Prisma). Modell: x = Ost,
//    y = Nord, Höhen über dem Geländenullpunkt (Meter).
// Gerechnet wird im Rust-Kern (`src-tauri/core/src/sun.rs`); hier wird nur aus dem Projekt
// gesammelt und die Datenform übersetzt.

import { core } from "../engine/coreWasm";
import { FlatReader, FlatWriter, pointsOf } from "../geometry/coreFlat";
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

export function sunPosition(latDeg: number, lonDeg: number, when: Date): SunPosition {
  const r = core().sun_position(latDeg, lonDeg, when.getTime());
  return { azimuth: r[0], elevation: r[1] };
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

/** Boden-Schatten eines Prismas `footprint` von `zBottom` bis `zTop` (leer bei Nacht). */
export function shadowOfPrism(footprint: Vec2[], zBottom: number, zTop: number, sun: SunPosition): Vec2[] {
  return pointsOf(core().sun_shadow_of_prism(new FlatWriter().pts(footprint).done(), zBottom, zTop, sun.azimuth, sun.elevation));
}

/** Ein Schatten-Polygon: `[0]` Aussenring, weitere Ringe sind Löcher (Höfe). Ringe offen (ohne Wiederholung des Startpunkts). */
export type ShadowPolygon = Vec2[][];

/**
 * Vereinigter Schatten aller Wände, Körper und Dächer (leer bei Nacht). Hier werden nur die
 * Körper gesammelt — Wände und freie Körper als Prismen, Dächer als Punktwolke (Traufe auf
 * Traufhöhe, Traufe/First/Grate auf Firsthöhe); Schatten und Vereinigung rechnet der Rust-Kern.
 */
export function shadowPolygons(project: Project, sun: SunPosition): ShadowPolygon[] {
  const prisms = new FlatWriter();
  const prismCount = prisms.slot();
  let nPrisms = 0;
  for (const w of project.walls) {
    const { zBottom, zTop } = wallVerticalExtent(project, w);
    const dx = w.end.x - w.start.x;
    const dy = w.end.y - w.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const t = wallTypeThickness(getWallType(project, w)) / 2;
    const nx = (-dy / len) * t;
    const ny = (dx / len) * t;
    prisms.num(zBottom, zTop).ring([
      { x: w.start.x + nx, y: w.start.y + ny },
      { x: w.end.x + nx, y: w.end.y + ny },
      { x: w.end.x - nx, y: w.end.y - ny },
      { x: w.start.x - nx, y: w.start.y - ny },
    ]);
    nPrisms++;
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
    prisms.num(z0, z0 + s.height).ring(s.points);
    nPrisms++;
  }
  const clouds = new FlatWriter();
  const cloudCount = clouds.slot();
  let nClouds = 0;
  for (const r of project.roofs ?? []) {
    const eavesZ = roofBaseElevation(project, r);
    const geo = roofGeometry(r, eavesZ);
    const top = eavesZ + geo.ridgeHeight;
    const pts: number[] = [];
    for (const p of geo.eaves) pts.push(p.x, p.y, eavesZ, p.x, p.y, top);
    for (const [a, b] of geo.ridges) pts.push(a.x, a.y, top, b.x, b.y, top);
    for (const [, b] of geo.hips) pts.push(b.x, b.y, top);
    clouds.num(pts.length / 3, ...pts);
    nClouds++;
  }
  const out = core().sun_shadow_union(
    prisms.set(prismCount, nPrisms).done(),
    clouds.set(cloudCount, nClouds).done(),
    sun.azimuth,
    sun.elevation,
  );
  return new FlatReader(out).polygons();
}

/**
 * Zerlegt ein Polygon mit Löchern in lochfreie Teile gleicher Gesamtfläche (für Ausgaben, die
 * nur einfache Polygone füllen, z. B. das Plan-Primitiv); Rechnung im Rust-Kern (`sun.rs`).
 */
export function withoutHoles(poly: ShadowPolygon): Vec2[][] {
  if (!poly[0] || poly[0].length < 3) return [];
  if (poly.length === 1) return [poly[0]];
  return new FlatReader(core().sun_without_holes(new FlatWriter().polygons([poly]).done())).polygons().map((p) => p[0]);
}
