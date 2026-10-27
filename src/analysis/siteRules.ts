// Baurecht der Parzelle ([63]): zulässige Grundfläche aus Grenzabständen und Baulinien, Prüfung
// des Modells (Grundfläche ausserhalb, Gesamthöhe).
//
//  • Grenzabstand: gesperrt ist alles, was näher als d_i an Kante i liegt (Puffer der Kante mit
//    gerundeten Enden) — so stimmen auch konkave Parzellen und einspringende Ecken.
//  • Baulinie: Halbebene auf der Seite des Parzellen-Schwerpunkts.
//  • Gebäude-Grundfläche: Wände aller Geschosse und freie Körper (ohne Abzugskörper). Vorsprünge
//    (Dachüberstand, Balkone) und ihre Sonderregeln zählen nicht.
// Gerechnet wird im Rust-Kern (`src-tauri/core/src/site_rules.rs`); hier wird aus dem Projekt
// gesammelt (Grundflächen-Teile, Modellhöhe) und die Datenform übersetzt.

import type { Project, SiteRules, Vec2 } from "../model/types";
import { getFloor, getWallType, wallTypeThickness } from "../model/types";
import { wallVerticalExtent } from "../model/wall";
import { wallCorners } from "../model/geometry";
import { roofBaseElevation, roofGeometry } from "../geometry/roof";
import { core } from "../engine/coreWasm";
import { FlatReader, FlatWriter } from "../geometry/coreFlat";

/** Polygone mit Ringen: `[polygon][ring]`, Ring 0 aussen, weitere Löcher; Ringe offen. */
export type Area = Vec2[][][];

/** Fläche einer Mehrfach-Fläche (Löcher abgezogen). */
export function multiPolygonArea(a: Area): number {
  return core().site_multi_polygon_area(new FlatWriter().polygons(a).done());
}

/** Baurecht flach (`web/site_rules.rs`): Parzelle, Grenzabstand je Kante (Rohwert), Baulinien. */
function encodeRules(r: SiteRules): Float64Array {
  const parcel = Array.isArray(r.parcel) ? r.parcel : [];
  const w = new FlatWriter().ring(parcel).num(parcel.length);
  for (let i = 0; i < parcel.length; i++) w.num(r.setbacks?.[i] ?? r.defaultSetback);
  const lines = r.buildingLines ?? [];
  w.num(lines.length);
  for (const l of lines) w.num(l.a.x, l.a.y, l.b.x, l.b.y);
  return w.done();
}

/** Zulässige Grundfläche (leer bei ungültiger Parzelle). */
export function allowedArea(r: SiteRules): Area {
  return new FlatReader(core().site_allowed_area(encodeRules(r))).polygons();
}

/** Teile der Gebäude-Grundfläche (Wände aller Geschosse, freie Körper ohne Abzugskörper). */
function footprintParts(project: Project): Area {
  const parts: Area = [];
  for (const w of project.walls) {
    if (Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y) < 1e-9) continue;
    parts.push([wallCorners(w.start, w.end, wallTypeThickness(getWallType(project, w)))]);
  }
  for (const s of project.extrudedSolids ?? []) {
    if (s.operation === "subtract" || s.points.length < 3) continue;
    parts.push([s.points]);
  }
  return parts;
}

/** Grundfläche des Gebäudes (Wände aller Geschosse, freie Körper ohne Abzugskörper). */
export function buildingFootprint(project: Project): Area {
  const parts = footprintParts(project);
  if (parts.length === 0) return [];
  return new FlatReader(core().poly_union(new FlatWriter().polygons(parts).done())).polygons();
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

/** Prüft das Modell gegen `project.siteRules`; `null` ohne (gültiges) Baurecht. Rechnung im Rust-Kern (`site_rules.rs`). */
export function checkSiteRules(project: Project): SiteCheck | null {
  const r = project.siteRules;
  if (!r) return null;
  const maxTop = modelTop(project);
  const out = core().site_check(
    encodeRules(r),
    new FlatWriter().polygons(footprintParts(project)).done(),
    r.maxHeight ?? Number.NaN,
    maxTop ?? Number.NaN,
  );
  const rd = new FlatReader(out);
  if (rd.num() !== 1) return null;
  const parcelArea = rd.num();
  const allowedA = rd.num();
  const violationArea = rd.num();
  const heightExceeded = rd.num() === 1;
  const allowed = rd.polygons();
  const violations = rd.polygons();
  return { parcelArea, allowed, allowedArea: allowedA, violations, violationArea, maxTop, heightExceeded };
}
