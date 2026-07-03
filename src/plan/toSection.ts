// Schnitt-/Ansichts-Pipeline: bindet den analytischen render3d-Schnitt-Extraktor
// (`section.rs`, WASM-Export `cut_section_json`) an das Dokumentmodell an.
//
// Ablauf:
//   1. Aus einer Zeichnungsebene (DrawingLevel, kind "section"/"elevation") wird
//      eine Schnittebene abgeleitet — die Grundriss-Schnittlinie `linePoints`
//      plus `directionSign` (Blickrichtung).
//   2. Das Projekt wird über `projectToModel3d` (dieselbe Wand-/Decken-Zerlegung
//      wie der 3D-Viewport) zu Wänden + Decken geflacht und als JSON an
//      `cut_section_json` gereicht.
//   3. Das zurückgegebene `SectionOutput` (Cut-Polygone + sichtbare/verdeckte
//      Kanten, alles in (u, v)-Metern) wird in `generateSectionPlan`
//      (generatePlan.ts) zu Plan-Primitiven übersetzt.
//
// Einheiten: METER. Koordinaten der Ausgabe: u = horizontal entlang der Ebene,
// v = absolute Höhe (world.y). Siehe src-tauri/render3d/src/section.rs.

import type { Ceiling, DrawingLevel, Project, Wall } from "../model/types";
import { getCeilingType, getComponent, openingsOfWall } from "../model/types";
import { ceilingVerticalExtent, wallVerticalExtent } from "../model/wall";
import { openingInterval, openingVerticalExtent } from "../geometry/opening";
import { projectToModel3d } from "./toWalls3d";
import { loadEngine3d } from "../engine/engine3d";
import { resolveCeilingSectionStyle, resolveHatch, resolveWallSectionStyle } from "./generatePlan";
import type { HatchRender } from "./generatePlan";

/** Bauteil-Referenz eines Cut-Polygons/einer Kante (Art + Eingabe-Index). */
export interface SectionComponentRef {
  kind: "wall" | "slab";
  index: number;
}

/** Ein geschnittenes Bauteil-Rechteck in (u, v)-Metern (Ring, implizit geschlossen). */
export interface SectionCutPolygon {
  component: SectionComponentRef;
  /** Albedo-Farbe des Bauteils (RGB 0..1) — Rohwert aus dem 3D-Modell (Fallback). */
  color: [number, number, number];
  /** Ring-Ecken (u, v). */
  pts: Array<[number, number]>;
  /**
   * Echte Poché-Füllfarbe des geschnittenen Bauteils (tragende Wandschicht
   * bzw. erste Deckenschicht), von `computeSection` aufgelöst. Fehlt, wenn das
   * Quell-Bauteil nicht auflösbar war — der Aufrufer (generateSectionPlan)
   * fällt dann auf `color` zurück.
   */
  fill?: string;
  /** Echte Schnitt-Schraffur des geschnittenen Bauteils, analog zu `fill`. */
  hatch?: HatchRender;
}

/** Ein projiziertes Liniensegment in (u, v)-Metern. */
export interface SectionEdge {
  component: SectionComponentRef;
  a: [number, number];
  b: [number, number];
}

/** Vollständige Ausgabe eines Schnitt-/Ansichts-Laufs (JSON von `cut_section_json`). */
export interface SectionOutput {
  cutPolygons: SectionCutPolygon[];
  visibleEdges: SectionEdge[];
  hiddenEdges: SectionEdge[];
}

/** Minimal-Typ des WASM-Exports (das echte `.d.ts` entsteht erst beim wasm-Build). */
interface Engine3dSection {
  cut_section_json(
    modelJson: string,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
  ): string;
}

/**
 * Eine Schnittebene in world-Koordinaten (Y-up): Punkt auf der Ebene +
 * Normale (= Blickrichtung, zeigt vom Betrachter ins Modell).
 */
export interface SectionPlaneSpec {
  point: [number, number, number];
  normal: [number, number, number];
}

/**
 * Leitet aus einer Schnitt-/Ansichtsebene die world-Schnittebene ab. Die
 * Grundriss-Schnittlinie `linePoints` [p0, p1] (Modell-Meter) liegt in der
 * XZ-Ebene (world.x = model.x, world.z = model.y); die Ebenennormale steht
 * senkrecht auf der Linie in der Horizontalen und wird über `directionSign`
 * (Voreinstellung +1) in die gewünschte Blickrichtung gedreht.
 *
 * Gibt `null` zurück, wenn die Ebene (noch) keine Schnittlinie trägt (z. B. eine
 * frisch angelegte Ansicht ohne gesetzte Linie) — der Aufrufer zeigt dann einen
 * Hinweis statt eines leeren Plans.
 */
export function sectionPlaneFromLevel(level: DrawingLevel): SectionPlaneSpec | null {
  const line = level.linePoints;
  if (!line) return null;
  const [p0, p1] = line;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = dx / len;
  const uy = dy / len;
  // Links-Normale der Linie im Grundriss (n = (-u.y, u.x)), per directionSign
  // in die Blickrichtung gedreht. Modell (nx, ny) → world (nx, 0, ny).
  const sign = level.directionSign ?? 1;
  const nx = -uy * sign;
  const ny = ux * sign;
  return {
    point: [p0.x, 0, p0.y],
    normal: [nx, 0, ny],
  };
}

// ── Cut-Polygon → Quell-Bauteil (für die echte Hatch-Auflösung) ────────────
// `cut_section_json` (section.rs) nummeriert jedes Cut-Polygon per
// `ComponentRef { kind, index }`, wobei `index` exakt die Position im
// `walls`/`slabs`-Array ist, das ihm als Modell-JSON übergeben wurde
// (`walls.iter().enumerate()` in section.rs) — also dieselbe Reihenfolge wie
// `projectToModel3d(project).walls`/`.slabs` (toWalls3d.ts).
//
// `projectToWalls3d` zerlegt EINE Wand mit Öffnungen in mehrere Teilquader
// (Pfeiler/Brüstung/Sturz) — die Emission ist also nicht 1:1 Wand→Element.
// Um einen `index` wieder auf seine Quellwand zurückzuführen, wird hier exakt
// dieselbe Segmentierungs-/Skip-Logik wie `emitWall`/`pushSegment`
// (toWalls3d.ts) repliziert — NICHT die Geometrie, nur welches Quellelement
// pro emittiertem Segment "besitzt". Bleibt diese Zählung nicht exakt parallel
// zu `emitWall`, verschieben sich die Indizes und die Hatch-Auflösung wird
// falsch (harmlos: der Aufrufer fällt dann pro Cut-Polygon auf die generische
// Schnitt-Schraffur zurück, siehe `resolveWallSectionStyle`/`generatePlan.ts`).
const OWNER_EPS = 1e-4;

/** Liefert je emittiertem Wand-Teilquader (in Emissions-Reihenfolge) die Quellwand. */
export function wallSegmentOwners(project: Project): Wall[] {
  const owners: Wall[] = [];
  const pushOwner = (wall: Wall, from: number, to: number, zBottom: number, zTop: number) => {
    if (to - from <= OWNER_EPS) return;
    if (zTop - zBottom <= OWNER_EPS) return;
    owners.push(wall);
  };
  for (const wall of project.walls) {
    const { zBottom, zTop } = wallVerticalExtent(project, wall);
    const axisLen = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    if (axisLen < 1e-9 || zTop - zBottom <= OWNER_EPS) continue;

    const cutouts: Array<{ from: number; to: number; oBottom: number; oTop: number }> = [];
    for (const op of openingsOfWall(project, wall.id)) {
      const iv = openingInterval(wall, op);
      if (!iv) continue;
      const v = openingVerticalExtent(project, wall, op);
      cutouts.push({ from: iv.from, to: iv.to, oBottom: v.zBottom, oTop: v.zTop });
    }
    for (const d of project.doors ?? []) {
      if (d.hostWallId !== wall.id) continue;
      const from = Math.max(0, Math.min(d.position, axisLen));
      const to = Math.max(from, Math.min(d.position + d.width, axisLen));
      if (to - from < OWNER_EPS) continue;
      const oTop = Math.min(zTop, zBottom + d.height);
      cutouts.push({ from, to, oBottom: zBottom, oTop });
    }
    cutouts.sort((a, b) => a.from - b.from);

    if (cutouts.length === 0) {
      pushOwner(wall, 0, axisLen, zBottom, zTop);
      continue;
    }

    let cursor = 0;
    for (const { from, to, oBottom, oTop } of cutouts) {
      const segFrom = Math.max(cursor, from);
      if (from > cursor) pushOwner(wall, cursor, from, zBottom, zTop);
      if (to > segFrom) {
        if (oBottom > zBottom + OWNER_EPS) pushOwner(wall, segFrom, to, zBottom, oBottom);
        if (oTop < zTop - OWNER_EPS) pushOwner(wall, segFrom, to, oTop, zTop);
      }
      cursor = Math.max(cursor, to);
    }
    if (cursor < axisLen) pushOwner(wall, cursor, axisLen, zBottom, zTop);
  }
  return owners;
}

/** Liefert je emittierter Deckenplatte (in Emissions-Reihenfolge) die Quelldecke (1:1, keine Zerlegung). */
export function slabSegmentOwners(project: Project): Ceiling[] {
  const owners: Ceiling[] = [];
  for (const c of project.ceilings ?? []) {
    if (!c.outline || c.outline.length < 3) continue;
    const { zBottom, zTop } = ceilingVerticalExtent(project, c);
    if (zTop - zBottom <= OWNER_EPS) continue;
    owners.push(c);
  }
  return owners;
}

/**
 * Hängt an jedes Cut-Polygon von `output` (in-place) die echte Poché-Füllfarbe
 * + Schraffur des geschnittenen Bauteils an (`fill`/`hatch`), aufgelöst über
 * die Wand-/Decken-Besitzer-Listen. Nicht auflösbare Referenzen (Index
 * außerhalb der Besitzer-Liste, verwaistes `wallTypeId`/Bauteil) bleiben ohne
 * `fill`/`hatch` — `generateSectionPlan` fällt dafür auf die generische
 * Schnitt-Schraffur zurück.
 */
function attachCutStyles(output: SectionOutput, project: Project): void {
  if (output.cutPolygons.length === 0) return;
  const walls = wallSegmentOwners(project);
  const slabs = slabSegmentOwners(project);
  const next: SectionCutPolygon[] = [];
  for (const cp of output.cutPolygons) {
    const ref = cp.component;
    if (ref.kind === "wall") {
      const owner = walls[ref.index];
      const style = owner ? resolveWallSectionStyle(project, owner) : null;
      if (style) {
        cp.fill = style.fill;
        cp.hatch = style.hatch;
      }
      next.push(cp);
      continue;
    }
    // Decke: bei mehrschichtigem Deckentyp wird das EINE geschnittene Rechteck
    // (von der WASM-Schnitt-Extraktion) in liegende Teil-Rechtecke je Schicht
    // aufgeteilt (oben/OK → unten/UK) — siehe `splitSlabLayers`. Nur im
    // Schnitt sichtbar (im Grundriss bleibt die Decke bewusst flächig, siehe
    // `addCeilingPoche`).
    const owner = slabs[ref.index];
    if (owner) {
      const wt = getCeilingType(project, owner);
      if (wt.layers.length > 1) {
        next.push(...splitSlabLayers(cp, project, wt));
        continue;
      }
      const style = resolveCeilingSectionStyle(project, owner);
      if (style) {
        cp.fill = style.fill;
        cp.hatch = style.hatch;
      }
    }
    next.push(cp);
  }
  output.cutPolygons = next;
}

/**
 * Zerlegt das EINE geschnittene Deckenrechteck (`cp`, vier Ecken in u/v-Metern)
 * in liegende Teil-Rechtecke je Schicht des Deckentyps `wt` — das Schnitt-
 * Gegenstück zur mehrschichtigen Wand-Poché (dort im Grundriss als Bänder quer
 * zur Achse; hier im Schnitt als Bänder über die Höhe v, oben/OK → unten/UK,
 * exakt wie der liegende Aufbau physisch stapelt). Die Modell-Schichtdicken
 * werden proportional auf die tatsächlich geschnittene Höhe skaliert (falls
 * `Ceiling.thickness` die Typ-Summe übersteuert). Jedes Teil-Rechteck trägt
 * Füllung + Schraffur seines Bauteils; die Fugen ergeben sich implizit aus den
 * aneinanderstoßenden Rechtecken (jedes bekommt in `generateSectionPlan` die
 * generische Schnitt-Umrisslinie).
 */
function splitSlabLayers(
  cp: SectionCutPolygon,
  project: Project,
  wt: ReturnType<typeof getCeilingType>,
): SectionCutPolygon[] {
  const totalT = wt.layers.reduce((s, l) => s + l.thickness, 0);
  const us = cp.pts.map((p) => p[0]);
  const vs = cp.pts.map((p) => p[1]);
  const uMin = Math.min(...us);
  const uMax = Math.max(...us);
  const vMin = Math.min(...vs);
  const vMax = Math.max(...vs); // vMax = OK (oben), vMin = UK (unten)
  const vSpan = vMax - vMin;
  if (totalT <= 1e-9 || vSpan <= 1e-9) return [cp];
  const scale = vSpan / totalT;

  const out: SectionCutPolygon[] = [];
  let acc = 0; // kumulierte Dicke von OK (oben) nach UK (unten)
  for (const layer of wt.layers) {
    const comp = getComponent(project, layer.componentId);
    const hatch = resolveHatch(project, comp.hatchId);
    const vTop = vMax - acc * scale;
    acc += layer.thickness;
    const vBottom = vMax - acc * scale;
    out.push({
      component: cp.component,
      color: cp.color,
      pts: [
        [uMin, vTop],
        [uMax, vTop],
        [uMax, vBottom],
        [uMin, vBottom],
      ],
      fill: hatch.pattern === "solid" ? "#000000" : "#ffffff",
      hatch,
    });
  }
  return out;
}

/**
 * Berechnet den Schnitt/die Ansicht der Ebene `level` gegen das Modell `project`
 * über den WASM-Extraktor. Asynchron (das render3d-WASM-Modul wird lazy geladen).
 *
 * Gibt `null` zurück, wenn die Ebene keine gültige Schnittlinie hat. Wirft, wenn
 * das WASM-Modul den Export (noch) nicht bereitstellt — der Aufrufer fängt das ab
 * und blendet einen Fallback ein (pkg3d muss dann über `npm run build:engine3d`
 * neu gebaut werden, damit `cut_section_json` verfügbar ist).
 */
export async function computeSection(
  project: Project,
  level: DrawingLevel,
): Promise<SectionOutput | null> {
  const plane = sectionPlaneFromLevel(level);
  if (!plane) return null;
  const mod = (await loadEngine3d()) as Engine3dSection;
  if (typeof mod.cut_section_json !== "function") {
    throw new Error(
      "render3d-WASM ohne cut_section_json — pkg3d neu bauen (npm run build:engine3d)",
    );
  }
  const modelJson = JSON.stringify(projectToModel3d(project));
  const json = mod.cut_section_json(
    modelJson,
    plane.point[0],
    plane.point[1],
    plane.point[2],
    plane.normal[0],
    plane.normal[1],
    plane.normal[2],
  );
  const output = JSON.parse(json) as SectionOutput;
  attachCutStyles(output, project);
  return output;
}
