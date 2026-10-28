// Ansichts-Generator (Elevation/Fassadenansicht): erzeugt aus dem Modell eine
// echte 2D-Architektur-Ansicht mit gefüllten Flächen statt eines blossen
// Kanten-Durchlaufs durch die Schnitt-Pipeline.
//
// Ablauf (rein TS, KEIN WASM):
//   1. Aus der Ansichts-Ebene (DrawingLevel, kind "elevation") wird über
//      `sectionPlaneFromLevel`/`sectionUAxisModel` (toSection.ts, lesend) eine
//      Welt-Ansichtsebene abgeleitet: Punkt P, Blicknormale N (vom Betrachter ins
//      Modell) und die horizontale In-Plane-u-Achse U (Y-up-Welt).
//   2. Das Projekt wird über `projectToModel3d({ layeredWalls:false })` geflacht
//      (eine Voll-Box je Wand, Öffnungen als Segment-Aussparungen; plus Decken-
//      Prismen). Jede relevante Fläche (Wand-Aussenseiten, Decken-Stirn-/Deck-
//      flächen) wird auf (u, v) projiziert: u = dot(W−P, U), v = Welt-Höhe (W.y,
//      identisch zur Schnitt-v-Konvention), depth = dot(W−P, N).
//   3. SICHTBARKEIT über den PAINTER-ALGORITHMUS (Näherung, siehe unten): nur
//      Flächen, die zum Betrachter zeigen (Normale gegen N) UND hinter der Ebene
//      liegen (depth > 0), werden von HINTEN nach VORNE (grosse depth zuerst) als
//      gefüllte Polygone emittiert. Nähere Flächen überdecken so fernere.
//   4. Fenster/Türen: als Rahmen+Glas-Flächen auf der Aussenseite der Wirtswand.
//   5. Optionaler Schlagschatten (`level.shadows`): auskragende Decken/Balkone
//      (Slabs) werfen einen 45°-Schatten auf die dahinterliegende Fassade.
//
// NÄHERUNG (bewusst, dokumentiert): Der Painter-Algorithmus sortiert GANZE Flächen
// nach ihrer mittleren Tiefe und lässt nähere Flächen fernere überdecken — er ist
// KEIN exakter Hidden-Line-/Hidden-Surface-Algorithmus. Sich gegenseitig
// durchdringende oder in der Tiefe verschränkte Flächen (selten bei orthogonalen
// Fassaden) können falsch geordnet werden. Für Architektur-Ansichten (überwiegend
// planparallele, gestaffelte Flächen) genügt das — vgl. Auftragsvorgabe.
//
// Einheiten: METER. Ausgabe wie der Schnitt: u = horizontal entlang der Ebene,
// v = absolute Höhe (Welt-Y). Die PlanView zeichnet Y nach oben → Ansicht steht
// aufrecht.

import { core } from "../engine/coreWasm";
import type { DrawingLevel, Project, Vec2 } from "../model/types";
import {
  getComponent,
  getDoorType,
  getWallType,
  getWindowType,
  openingsOfWall,
  roofLayers,
  sashesOfWindowType,
  wallTypeThickness,
} from "../model/types";
import { openingInterval, openingVerticalExtent } from "../geometry/opening";
import { roofBaseElevation, roofGeometry } from "../geometry/roof";
import { projectToModel3d } from "./toWalls3d";
import type { RModel3d, RRgb, RSlab, RVec2, RWall } from "./toWalls3d";
import { sectionPlaneFromLevel } from "./toSection";
import type { SectionPlaneSpec } from "./toSection";
import type { CategoryDisplayResolver, HatchRender, Plan, Primitive } from "./generatePlan";

/** Welt-3D-Punkt (x, Höhe/y, z) — Y-up, identisch zur render3d-Weltkonvention. */
export type V3 = [number, number, number];

/** Leere Schraffur (Ansichtsflächen tragen keine Musterlinien, nur Fläche+Umriss). */
const NO_HATCH: HatchRender = {
  pattern: "none",
  scale: 1,
  angle: 0,
  color: "#1a1a1a",
  lineWeight: 0.02,
  dash: null,
};

// ── Stil (monochrome Architektur-Ansicht) ──────────────────────────────────
/** Tinte der Ansichts-Umrisskanten (Haarlinie um jede Fläche). */
const EDGE_INK = "#2b3039";
/** Strichstärke der Flächen-Umrisskanten (mm Papier, Haarlinie). */
const EDGE_MM = 0.13;
/** Fenster/Tür-Rahmen: etwas kräftigere Umrisslinie. */
const FRAME_MM = 0.18;
/**
 * Fenster-Glas/Rahmen/Türblatt/Wand/Dach: im MONO-Modus (SW/Print, VW-Linien-
 * zeichnungs-Look) bleibt alles weiss — nur Kontur trägt Information. Im
 * FARBIG-Modus tragen die Flächen echte Bauteilfarbe: Wand/Dach die dominante
 * Schicht (s. {@link WorldFace.fill}, gesetzt in {@link wallWorldFaces}/
 * {@link collectRoofFaces}), Fenster/Türen feste, an `toWalls3d.ts`
 * (FRAME_RGB/GLASS_RGB/SILL_RGB/DOOR_LEAF_RGB) angelehnte Töne, damit Ansicht
 * und 3D konsistent wirken.
 */
const GLASS_FILL_MONO = "#c4c8cd";
const GLASS_FILL_COLOR = "#9fc2d9";
const SHADOW_FILL = "#8f959e";
/** Laibungs-/Reveal-Schatten der Öffnungen (Fenster/Türen) — etwas heller als
 *  der Bauteil-Schlagschatten {@link SHADOW_FILL}, damit die Vertiefung dezent
 *  liest und Sprossen/Symbole darüber noch erkennbar bleiben. */
const OPENING_SHADOW_FILL = "#a7adb5";
/** Bodenlinie (Terrain-/Nulllinie): kräftige Tinte über die volle Breite. */
const GROUND_INK = "#1f242c";
/** Strichstärke der Bodenlinie (mm Papier). */
const GROUND_MM = 0.5;
/** Rollen-Füllungen: MONO-Fallback, wenn eine Fläche keine Bauteilfarbe trägt
 *  (z. B. Dach ohne auflösbare Schicht) — sonst gilt im Farbig-Modus immer die
 *  echte Bauteilfarbe (s. `fillFor` in {@link generateElevationPlan}). */
const WALL_FILL = "#ffffff";
const ROOF_FILL = "#ffffff";
/** Blendrahmen-/Sims-Fläche der Öffnungen. */
const FRAME_FILL_COLOR = "#d9d9d4";
const SILL_FILL_COLOR = "#cccccb";
/** Türblatt-Fläche. */
const DOOR_LEAF_FILL_COLOR = "#ede6d9";
/** Öffnungssymbol (SIA-Andeutung): dezente Annotation, nicht Bauteilkante. */
const SYMBOL_INK = "#7d858f";
/** Neutraler Dach-Grauton, falls keine Eindeckungs-Schicht/-Farbe auflösbar ist (wie `toWalls3d.ts::ROOF_RGB`). */
const ROOF_RGB_FALLBACK: RRgb = [0.72, 0.45, 0.36];

/** Wandelt eine Hex-Farbe ("#rrggbb") in float-RGB (0..1) um (wie `toWalls3d.ts::hexToRgb`, hier dupliziert — nicht exportiert). */
function hexToRgb(hex: string, fallback: RRgb): RRgb {
  const h = hex?.trim().replace(/^#/, "") ?? "";
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return fallback;
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** Wandelt float-RGB (0..1) zurück in "#rrggbb" (für Primitive-Fill-Strings). */
function rgbToHex(c: RRgb): string {
  const b = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
  return `#${b(c[0])}${b(c[1])}${b(c[2])}`;
}

/** Numerisches Rauschen (Meter) für Tiefen-/Flächenvergleiche. */
const EPS = 1e-6;

// ── Ebenen-Frame ────────────────────────────────────────────────────────────

/** Der orthonormale Ansichts-Frame in Weltkoordinaten. */
export interface ElevationFrame {
  /** Punkt auf der Ebene (Welt). */
  P: V3;
  /** Blicknormale (Einheit, vom Betrachter ins Modell). */
  N: V3;
  /** Horizontale In-Plane-u-Achse (Einheit). */
  U: V3;
}

/**
 * Baut den Ansichts-Frame aus einer Welt-Ebenen-Spezifikation. `N` (aus
 * `sectionPlaneFromLevel`) ist bereits horizontal und Einheit; `U` folgt exakt
 * `sectionUAxisModel` (Modell-2D (x, z)) in die Welt gehoben — dieselbe u-Achse
 * wie der Schnitt-Extraktor, damit Ansicht und Schnitt deckungsgleich messen.
 */
export function elevationFrame(plane: SectionPlaneSpec): ElevationFrame {
  const [nx, ny, nz] = plane.normal;
  const nLen = Math.hypot(nx, ny, nz) || 1;
  const N: V3 = [nx / nLen, ny / nLen, nz / nLen];
  // Blickrichtungs-RECHTS statt der Schnitt-u-Achse: `sectionUAxisModel`
  // (cross(N, up), die Kamera-Formel für Blick entlang −z) SPIEGELT eine
  // Ansicht, die entlang +N betrachtet wird — wer nach Norden schaut, hat
  // Osten rechts. Die Ansicht nutzt darum u = cross(up, N) = (Nz, −Nx) im
  // Grundriss. (Die Schnitt-Pipeline behält vorerst ihre Rust-Konvention —
  // dort ist die Spiegelung ein bekanntes, separat zu lösendes Thema.)
  const ux = nz / nLen;
  const uz = -nx / nLen;
  const uLen = Math.hypot(ux, uz) || 1;
  const U: V3 = [ux / uLen, 0, uz / uLen];
  return { P: plane.point, N, U };
}

// ── Flächen aus dem geflachten Modell ──────────────────────────────────────

/** Rolle einer Fläche (steuert Füllung/Stil in der Ansicht). */
export type FaceRole = "wall" | "slab" | "roof";

/** Eine in die Ansicht projizierte, sichtbare Fläche. */
export interface ProjectedFace {
  pts: Array<[number, number]>;
  /** Mittlere Tiefe hinter der Ebene (Painter-Schlüssel). */
  depth: number;
  /** Kleinste Punkt-Tiefe (nächste Kante — z. B. die auskragende Traufe). */
  depthMin: number;
  /** Grösste Punkt-Tiefe — depthMax≈depthMin ⇒ frontale (ebene) Fläche. */
  depthMax: number;
  role: FaceRole;
  wallId?: string;
  ceilingId?: string;
  roofId?: string;
  fill?: RRgb;
  /** Welt-Normale (Einheit) — für die Erkennung deckungsgleicher Nachbarflächen. */
  normal?: V3;
}

const ROLES: FaceRole[] = ["wall", "slab", "roof"];

/** Ansichts-Frame flach für den Kern (`[P, N, U]`). */
function encodeFrame(frame: ElevationFrame): Float64Array {
  return Float64Array.from([...frame.P, ...frame.N, ...frame.U]);
}

/**
 * Projiziert Wand-Quader (sechs Flächen je Wand-Box, Aussennormalen), Decken-Prismen (Deckel,
 * Boden, Stirnflächen) und Dachflächen/Giebel in die Ansicht und behält die sichtbaren
 * (Rückseiten-Culling: Normale gegen die Blickrichtung, mittlere Tiefe hinter der Ebene).
 * Rechnet der Kern (`plan_elevation.rs`, [K3c]); hier nur Ein-/Ausgabe samt Herkunft (IDs, Farbe).
 * Reihenfolge = Emissionsreihenfolge des Modells (NICHT tiefensortiert) — die Painter-Sortierung
 * macht der Aufrufer.
 */
function projectFaces(
  frame: ElevationFrame,
  walls: RWall[],
  slabs: RSlab[],
  roofs: Array<{ id: string; fill: RRgb; planes: V3[][]; gables: V3[][] }>,
): ProjectedFace[] {
  const w: number[] = [walls.length];
  for (const x of walls) w.push(x.start[0], x.start[1], x.end[0], x.end[1], x.thickness, x.height, x.baseElevation);
  const sl: number[] = [slabs.length];
  for (const x of slabs) {
    sl.push(x.zBottom, x.zTop, x.outline.length);
    for (const p of x.outline) sl.push(p[0], p[1]);
  }
  const r: number[] = [roofs.length];
  for (const roof of roofs) {
    r.push(roof.planes.length, roof.gables.length);
    for (const poly of [...roof.planes, ...roof.gables]) {
      r.push(poly.length);
      for (const p of poly) r.push(p[0], p[1], p[2]);
    }
  }
  const f = core().elevation_faces_flat(encodeFrame(frame), Float64Array.from(w), Float64Array.from(sl), Float64Array.from(r));
  const out: ProjectedFace[] = [];
  for (let k = 0, i = 1; k < (f[0] ?? 0); k++) {
    const role = ROLES[f[i]];
    const src = f[i + 1];
    const count = f[i + 8];
    const pts = new Array<[number, number]>(count);
    for (let j = 0; j < count; j++) pts[j] = [f[i + 9 + 2 * j], f[i + 10 + 2 * j]];
    const face: ProjectedFace = {
      pts,
      depth: f[i + 2],
      depthMin: f[i + 3],
      depthMax: f[i + 4],
      role,
      normal: [f[i + 5], f[i + 6], f[i + 7]],
    };
    if (role === "wall") {
      face.wallId = walls[src].wallId;
      face.fill = walls[src].color;
    } else if (role === "slab") {
      face.ceilingId = slabs[src].ceilingId;
      face.fill = slabs[src].color;
    } else {
      face.roofId = roofs[src].id;
      face.fill = roofs[src].fill;
    }
    out.push(face);
    i += 9 + 2 * count;
  }
  return out;
}

/**
 * Sammelt alle sichtbaren, projizierten Flächen des Modells (Wände + Decken), bereits
 * rückseiten-gecullt und vor der Ebene verworfen.
 */
export function collectElevationFaces(model: RModel3d, frame: ElevationFrame): ProjectedFace[] {
  return projectFaces(frame, model.walls, model.slabs, []);
}

/**
 * Dachflächen (Aufsicht-Polygone der roofGeometry) und Giebel ALLER Dächer, projiziert. Modell
 * [x, y, Höhe]; die Eindeckungsfarbe (äusserste Schicht bzw. `roof.color`) entspricht `emitRoofs`
 * des 3D-Viewers. Die Materialdicke bleibt unberücksichtigt (Silhouette genügt).
 */
function collectRoofFaces(project: Project, frame: ElevationFrame): ProjectedFace[] {
  const roofs = (project.roofs ?? []).map((roof) => {
    const g = roofGeometry(roof, roofBaseElevation(project, roof));
    const outer = roofLayers(project, roof)[0];
    const fill: RRgb = roof.color
      ? hexToRgb(roof.color, ROOF_RGB_FALLBACK)
      : outer?.componentId
        ? hexToRgb(getComponent(project, outer.componentId).color, ROOF_RGB_FALLBACK)
        : ROOF_RGB_FALLBACK;
    return {
      id: roof.id,
      fill,
      planes: g.planes.map((pl) => pl.pts.map((p) => [p[0], p[1], p[2]] as V3)),
      gables: g.gables.map((gb) => gb.map((p) => [p[0], p[1], p[2]] as V3)),
    };
  });
  return projectFaces(frame, [], [], roofs);
}

/**
 * Verlängert die (offset-freien) Wand-Boxen des Ansichts-Modells an gemeinsamen Eck-Knoten, damit
 * Fassaden-Ecken in der Ansicht ohne dreieckige Kerbe/Schattenlücke erscheinen: jedes Wandende
 * reicht bis zur AUSSENFLÄCHE der dicksten anstossenden anderen Wand desselben Geschosses (L-Ecken,
 * T-Stösse, versetzte Stösse). Bewusst eine EIGENE, tolerante Näherung statt der Gehrungs-Logik aus
 * `model/joins.ts`; die Mengen rechnet der Kern (`plan_elevation.rs`).
 *
 * Nur Wände etwa PARALLEL zur Ansichtsebene werden verlängert (Fassaden-Silhouette): eine
 * fassaden-SENKRECHTE Wand würde sonst entlang ihrer Achse in die Tiefe geschoben. `uModel` ist die
 * Ansichts-u-Achse in Grundriss-Koordinaten. Mutiert `start`/`end` der jeweils äussersten
 * Teilstücke (Pfeiler vor der ersten bzw. nach der letzten Öffnung) in-place.
 */
function extendWallCornersForElevation(project: Project, rwalls: RWall[], uModel: Vec2): void {
  const floors = new Map<string, number>();
  const b: number[] = [project.walls.length];
  for (const w of project.walls) {
    const key = w.floorId ?? "";
    if (!floors.has(key)) floors.set(key, floors.size);
    let thickness = 0.2;
    try {
      thickness = wallTypeThickness(getWallType(project, w));
    } catch {
      thickness = 0.2;
    }
    b.push(floors.get(key)!, w.start.x, w.start.y, w.end.x, w.end.y, thickness / 2);
  }
  const ext = core().elevation_wall_extensions_flat(Float64Array.from(b));
  if (ext.length === 0) return;
  const byWallId = new Map<string, RWall[]>();
  for (const rw of rwalls) {
    const list = byWallId.get(rw.wallId);
    if (list) list.push(rw);
    else byWallId.set(rw.wallId, [rw]);
  }
  const closeTo = (a: RVec2, v: Vec2): boolean => Math.abs(a[0] - v.x) < 1e-6 && Math.abs(a[1] - v.y) < 1e-6;
  project.walls.forEach((w, k) => {
    const eStart = ext[1 + 2 * k];
    const eEnd = ext[2 + 2 * k];
    if (eStart <= EPS && eEnd <= EPS) return;
    const pieces = byWallId.get(w.id);
    if (!pieces) return;
    const dx = w.end.x - w.start.x;
    const dz = w.end.y - w.start.y;
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) return;
    const ux = dx / len;
    const uz = dz / len;
    // Parallelität zur Ansichtsebene: |Achse · u| ≈ 1 (parallel) … 0 (senkrecht).
    if (Math.abs(ux * uModel.x + uz * uModel.y) < 0.35) return;
    if (eStart > EPS) {
      const first = pieces.find((p) => closeTo(p.start, w.start));
      if (first) first.start = [first.start[0] - ux * eStart, first.start[1] - uz * eStart];
    }
    if (eEnd > EPS) {
      const last = pieces.find((p) => closeTo(p.end, w.end));
      if (last) last.end = [last.end[0] + ux * eEnd, last.end[1] + uz * eEnd];
    }
  });
}

// ── Fenster/Türen ───────────────────────────────────────────────────────────

/** Eine projizierte Öffnungs-Fläche (Rahmen+Glas) auf der Wand-Aussenseite. */
interface ProjectedOpening {
  pts: Array<[number, number]>;
  depth: number;
  /** Glasfelder (je Flügel/Feld) innerhalb des Blendrahmens. */
  glass: Array<Array<[number, number]>>;
  /**
   * Blinde (undurchsichtige) Türblatt-Felder — Gegenstück zu `glass` bei Türen:
   * ein Glasblatt (`DoorType.leafStyle==="glas"`) mit `glazingRatio<1` teilt
   * sich in einen Glas-Anteil (oben, → `glass`) und einen blinden Blattanteil
   * (unten, → `doorLeaf`); ein nicht-verglastes Blatt landet komplett hier.
   * Fenster füllen dieses Feld nie.
   */
  doorLeaf: Array<Array<[number, number]>>;
  /** Teilungslinien (Pfosten/Kämpfer) über den Rahmen. */
  divisions: Array<[[number, number], [number, number]]>;
  /** Flügelrahmen-Rechtecke (Kontur je öffenbarem/festem Flügel). */
  sashRects: Array<Array<[number, number]>>;
  /** Fensterbank (Sims): Bank + Tropfkante als zwei Bänder unter dem Rahmen. */
  sill: Array<Array<[number, number]>>;
  /** Öffnungssymbol (SIA-Ansicht): Linien exakt auf den Glasfeld-Ecken. */
  symbol: Array<[[number, number], [number, number]]>;
  /** Tür (Blatt-Fläche statt Glas, ausser Glas-Blatt). */
  isDoor: boolean;
  /** Quell-Öffnung (`project.openings[].id`) — Klick in der Ansicht wählt sie. */
  openingId?: string;
}

/** Öffnungsart (`WindowSash.opening`/`WindowType.kind`) in der Kern-Kodierung. */
const SASH_KIND: Record<string, number> = { dreh: 1, kipp: 2, drehkipp: 3, schiebe: 4 };

/**
 * Alle Öffnungs-Flächen (Fenster/Türen inkl. Legacy-Türen) des Projekts, auf die jeweilige
 * Wand-Aussenseite projiziert (Rahmen, Glasfelder je Flügel/Sprossenraster, Kämpfer, Sims,
 * Öffnungssymbol nach SIA). Thickness = WallType-Dicke (Fallback 0.2 m). Rein aus dem Projekt
 * (nicht aus dem geflachten Modell), damit Rahmen+Glas unabhängig von der Segment-Aussparung der
 * Wand-Box gezeichnet werden können. Die Geometrie rechnet der Kern (`plan_elevation.rs`, [K3c]);
 * hier die Auflösung aus dem Modell (Typ-Bibliothek) und die Übersetzung.
 */
function collectOpenings(project: Project, frame: ElevationFrame): ProjectedOpening[] {
  const b: number[] = [0];
  const ids: string[] = [];
  for (const wall of project.walls) {
    let thickness = 0.2;
    try {
      thickness = wallTypeThickness(getWallType(project, wall));
    } catch {
      thickness = 0.2;
    }
    for (const op of openingsOfWall(project, wall.id)) {
      const iv = openingInterval(wall, op);
      if (!iv) continue;
      const v = openingVerticalExtent(project, wall, op);
      const door = op.kind === "door";
      const dt = door ? getDoorType(project, op) : undefined;
      const wt = door ? undefined : getWindowType(project, op);
      const sashes = door ? [] : wt ? sashesOfWindowType(wt) : [{ kind: "fluegel" as const }];
      b.push(
        wall.start.x, wall.start.y, wall.end.x, wall.end.y, thickness, iv.from, iv.to, v.zBottom, v.zTop,
        door ? 1 : 0, dt?.leafStyle === "glas" ? 1 : 0, dt?.glazingRatio ?? Number.NaN,
        wt?.frameWidth ?? 0.06, wt?.transomHeight ?? 0, wt?.mullionRows ?? Number.NaN, wt?.mullionCols ?? Number.NaN,
        wt?.sillBoard !== "keine" && wt?.sillBoard !== "innen" ? 1 : 0,
        SASH_KIND[wt?.kind ?? "fest"] ?? 0,
        sashes.length,
      );
      for (const sd of sashes as Array<{ kind: string; postWidth?: number; autoWidth?: boolean; width?: number; opening?: string; hingeSide?: string }>) {
        b.push(
          sd.kind === "pfosten" ? 1 : 0, sd.postWidth ?? Number.NaN, sd.autoWidth === false ? 0 : 1, sd.width ?? Number.NaN,
          sd.opening === undefined ? -1 : SASH_KIND[sd.opening] ?? 0, (sd.hingeSide ?? "left") === "left" ? 1 : 0,
        );
      }
      ids.push(op.id);
      b[0]++;
    }
  }
  const f = core().elevation_openings_flat(encodeFrame(frame), Float64Array.from(b));
  const out: ProjectedOpening[] = [];
  if (f.length === 0) return out;
  let i = 1;
  const quads = (): Array<Array<[number, number]>> => {
    const list: Array<Array<[number, number]>> = [];
    for (let k = 0, n = f[i++]; k < n; k++, i += 8) {
      list.push([[f[i], f[i + 1]], [f[i + 2], f[i + 3]], [f[i + 4], f[i + 5]], [f[i + 6], f[i + 7]]]);
    }
    return list;
  };
  const lines = (): Array<[[number, number], [number, number]]> => {
    const list: Array<[[number, number], [number, number]]> = [];
    for (let k = 0, n = f[i++]; k < n; k++, i += 4) list.push([[f[i], f[i + 1]], [f[i + 2], f[i + 3]]]);
    return list;
  };
  for (let k = 0; k < f[0]; k++) {
    if (f[i++] === 0) continue;
    const depth = f[i];
    const isDoor = f[i + 1] === 1;
    const pts: Array<[number, number]> = [[f[i + 2], f[i + 3]], [f[i + 4], f[i + 5]], [f[i + 6], f[i + 7]], [f[i + 8], f[i + 9]]];
    i += 10;
    const glass = quads();
    const doorLeaf = quads();
    const divisions = lines();
    const sashRects = quads();
    const sill = quads();
    const symbol = lines();
    out.push({ pts, depth, glass, doorLeaf, divisions, sashRects, sill, symbol, isDoor, openingId: ids[k] });
  }
  return out;
}

// ── Schlagschatten (45°, klassische Architektur-Konvention) ─────────────────

/**
 * Ein opakes Verdeckungs-Polygon (projizierte Fläche) mit seiner FERNSTEN Tiefe
 * (`depth` = `depthMax`): eine Linie/Fläche gilt nur dann als verdeckt, wenn sie hinter
 * dem gesamten Occluder liegt — konservativ, damit gekippte Flächen (Dach) keine
 * sichtbaren Kanten fälschlich wegschneiden. Das Clipping selbst rechnet der Kern
 * (`plan_elevation.rs`, [K3c]): warum überhaupt clippen — die GL-Ansicht zeichnet ALLE
 * Linien in einem EIGENEN Stift-Durchgang ÜBER allen Füllungen (s. `glPlan/glPlanCompile.ts`);
 * eine reine Painter-Tiefensortierung der Flächen verdeckt Linien also NICHT.
 */
interface Occluder {
  poly: Array<[number, number]>;
  depth: number;
}

/** Verdecker flach für den Kern (`[n, (tiefe, k, u, v …) × n]`). */
function encodeOccluders(occ: Occluder[]): Float64Array {
  const b: number[] = [occ.length];
  for (const o of occ) {
    b.push(o.depth, o.poly.length);
    for (const [u, v] of o.poly) b.push(u, v);
  }
  return Float64Array.from(b);
}

/** Ein Schatten-Polygon mit der Tiefe der Empfängerfläche (für die Painter-Ordnung). */
interface ShadowPoly {
  pts: Array<[number, number]>;
  depth: number;
}

function encodeShadowFaces(faces: ProjectedFace[]): Float64Array {
  const b: number[] = [faces.length];
  for (const f of faces) {
    b.push(f.depth, f.depthMin, f.pts.length);
    for (const [u, v] of f.pts) b.push(u, v);
  }
  return Float64Array.from(b);
}

/**
 * Baut die Schlagschatten auskragender Decken/Balkone (Slabs) auf die dahinter
 * liegenden Fassaden (Wände). KLASSISCHE ARCHITEKTUR-KONVENTION: Sonne 45° von
 * links oben ⇒ die Unterkante des Überstands wirft einen Schatten, dessen
 * horizontaler Versatz UND vertikaler Abfall der Auskragungstiefe entspricht.
 * Rechnet der Kern (`plan_elevation.rs`): Näherung Überstand-Silhouette = (u, v)-
 * Bounding-Box der Slab-Fläche, Empfänger = Bounding-Box der Wandfläche; nur Paare mit
 * echtem Tiefen-Vorsprung (höchstens 1,2 m) und u-Überlapp.
 */
export function buildShadows(walls: ProjectedFace[], slabs: ProjectedFace[]): ShadowPoly[] {
  const f = core().elevation_shadows_flat(encodeShadowFaces(walls), encodeShadowFaces(slabs));
  const out: ShadowPoly[] = [];
  let i = 1;
  for (let k = 0; k < (f[0] ?? 0); k++) {
    const depth = f[i];
    const count = f[i + 1];
    i += 2;
    const pts = new Array<[number, number]>(count);
    for (let j = 0; j < count; j++, i += 2) pts[j] = [f[i], f[i + 1]];
    out.push({ pts, depth });
  }
  return out;
}

// ── Umriss-Vereinigung frontaler Flächengruppen ─────────────────────────────

/**
 * Vereinigungs-UMRISS einer Gruppe achsparalleler (u,v)-Rechteckflächen über
 * Kanten-XOR: Bereiche mit GERADER Überdeckung (geteilte Innenkanten zweier
 * Teilboxen) heben sich auf, ungerade Bereiche bilden die Silhouette — inklusive der
 * Fensterlöcher. Nicht-achsparallele Kanten werden unverändert durchgereicht.
 * Rechnet der Kern (`plan_elevation.rs`).
 */
export function xorOutlineEdges(
  polys: Array<Array<[number, number]>>,
): Array<[[number, number], [number, number]]> {
  const b: number[] = [polys.length];
  for (const poly of polys) {
    b.push(poly.length);
    for (const [u, v] of poly) b.push(u, v);
  }
  const f = core().elevation_xor_outline_flat(Float64Array.from(b));
  const out: Array<[[number, number], [number, number]]> = [];
  for (let k = 0, i = 1; k < (f[0] ?? 0); k++, i += 4) out.push([[f[i], f[i + 1]], [f[i + 2], f[i + 3]]]);
  return out;
}

// ── Plan-Zusammenbau ────────────────────────────────────────────────────────

/** Optionen des Ansichts-Generators. */
export interface ElevationOptions {
  /** Schlagschatten zeichnen (Default aus `level.shadows`). */
  shadows?: boolean;
  /** Schwarz-Weiss-Modus (neutralisierte Füllungen). */
  mono?: boolean;
  /**
   * Ebenen-Panel-Sichtbarkeit (wie im Grundriss/Schnitt): eine Fläche, deren
   * Quell-Bauteil (Wand/Decke/Dach, über `wallId`/`ceilingId`/`roofId`) einer
   * NICHT sichtbaren Kategorie angehört, wird VOLLSTÄNDIG entfernt — vor der
   * Verdeckungsberechnung, damit sie auch nichts mehr verdeckt (wie eine
   * ausgeblendete Wand im Grundriss). Fehlt eine der beiden Optionen, bleibt
   * jede Fläche sichtbar (Export-/Print-Pfad ohne Ebenen-Filter).
   */
  visibleCodes?: Set<string>;
  categoryDisplay?: CategoryDisplayResolver;
}

/**
 * Erzeugt den Ansichts-Plan einer Ebene (kind "elevation"). `null`, wenn die
 * Ebene (noch) keine Ansichtslinie trägt — der Aufrufer zeigt dann den bestehenden
 * Hinweis. Rein synchron/TS.
 */
export function generateElevationPlan(
  project: Project,
  level: DrawingLevel,
  opts: ElevationOptions = {},
): Plan | null {
  const plane = sectionPlaneFromLevel(level);
  if (!plane) return null;
  const shadows = opts.shadows ?? level.shadows ?? false;
  const mono = opts.mono ?? false;
  const frame = elevationFrame(plane);

  // Eine Voll-Box je Wand (Öffnungen als Segment-Aussparungen) + Decken-Prismen.
  const model = projectToModel3d(project, { layeredWalls: false });
  // Ansichts-u-Achse in Grundriss-Koordinaten (Welt x,z = Modell x,y).
  extendWallCornersForElevation(project, model.walls, { x: frame.U[0], y: frame.U[2] });
  let faces = [...collectElevationFaces(model, frame), ...collectRoofFaces(project, frame)];
  // Grafik-Kategorie einer projizierten Fläche (Quell-Wand/-Decke/-Dach) — für
  // Ebenen-Panel-Sichtbarkeit UND -Dimmen (s. u.).
  const categoryCodeOfFace = (f: ProjectedFace): string | undefined => {
    if (f.wallId) return project.walls.find((w) => w.id === f.wallId)?.categoryCode;
    if (f.ceilingId) return (project.ceilings ?? []).find((c) => c.id === f.ceilingId)?.categoryCode;
    if (f.roofId) return (project.roofs ?? []).find((r) => r.id === f.roofId)?.categoryCode;
    return undefined;
  };
  // Ebenen-Panel-Sichtbarkeit: kategorie-ausgeblendete Flächen VOR der
  // Verdeckungsberechnung entfernen (s. ElevationOptions.visibleCodes) — wie
  // im Grundriss verdeckt eine ausgeblendete Wand dann auch nichts mehr.
  if (opts.visibleCodes && opts.categoryDisplay) {
    const { visibleCodes, categoryDisplay } = opts;
    faces = faces.filter((f) => {
      const code = categoryCodeOfFace(f);
      if (code === undefined) return true;
      return visibleCodes.has(code) && categoryDisplay(code).render;
    });
  }
  // Ebenen-Panel-Dimmen ("Andere grau"): je Fläche, ob ihre Kategorie gedimmt
  // ist — wirkt NUR auf die Flächen-Füllung selbst (Silhouetten-/Kanten-Linien
  // fassen ggf. MEHRERE Flächen gleicher Tiefe zu EINEM Umriss zusammen, s.
  // `frontalGroups` unten, und tragen deshalb keine eindeutige Kategorie).
  const isFaceGreyed = (f: ProjectedFace): boolean => {
    if (!opts.categoryDisplay) return false;
    const code = categoryCodeOfFace(f);
    return code !== undefined && opts.categoryDisplay(code).greyed;
  };
  const wallFaces = faces.filter((f) => f.role === "wall");
  const slabFaces = faces.filter((f) => f.role === "slab");
  const roofFaces = faces.filter((f) => f.role === "roof");
  // Öffnungen (Fenster/Türen) einmal sammeln — als Fläche gebraucht (Occluder,
  // s. u.) UND weiter unten für die Rahmen-/Glas-/Symbol-Emission.
  const openings = collectOpenings(project, frame);
  // Occluder für die exakte Durchsicht-Entfernung (s. {@link clipSegmentVisible}):
  // ALLE opaken Flächen (Wände, Decken, Dächer) als Verdeckungs-Polygone mit
  // ihrer FERNSTEN Tiefe (`depthMax`, konservativ), PLUS die Öffnungs-Rahmen-
  // quads (die Fassaden-Boxen sind um die Öffnungen ausgespart — ohne diese
  // Occluder schiene eine hintere Wandlinie durch das Fensterloch der vorderen
  // Fassade). Linien HINTER einem Occluder werden exakt herausgeschnitten —
  // nötig, weil die GL-Pipeline alle Linien in einem eigenen Durchgang über die
  // Füllungen legt.
  const occluders: Occluder[] = faces.map((f) => ({ poly: f.pts, depth: f.depthMax }));
  for (const op of openings) occluders.push({ poly: op.pts, depth: op.depth });
  const occFlat = encodeOccluders(occluders);
  // Ganz-Öffnung-Cull: liegt der Öffnungs-Mittelpunkt hinter einer näheren opaken Fläche?
  const openingOccluded = (() => {
    const b: number[] = [openings.length];
    for (const op of openings) {
      b.push(
        (op.pts[0][0] + op.pts[1][0] + op.pts[2][0] + op.pts[3][0]) / 4,
        (op.pts[0][1] + op.pts[1][1] + op.pts[2][1] + op.pts[3][1]) / 4,
        op.depth,
      );
    }
    return core().elevation_occluded_points_flat(occFlat, Float64Array.from(b));
  })();

  const primitives: Primitive[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  // Rollen-Füllung: im Farbig-Modus die echte Bauteilfarbe (dominante Wand-
  // schicht bzw. Dach-Eindeckung, s. {@link WorldFace.fill}); MONO bleibt eine
  // ruhige weisse Fläche — KEINE Tiefenstaffelung (die machte aus der Fassade
  // ein Grau-Patchwork).
  const fillFor = (role: FaceRole, fill: RRgb | undefined): string => {
    if (mono) return "#ffffff";
    if (fill) return rgbToHex(fill);
    return role === "roof" ? ROOF_FILL : WALL_FILL;
  };

  // ── Painter-Sammelstrom: Flächen + Schatten + Öffnungen, fern→nah sortiert.
  // Jede Fläche trägt Füllung + eigene Umrisslinie (nähere Füllung überdeckt
  // fernere Kanten → korrekte Painter-Verdeckung ohne Extra-Kantenpass).
  interface Item {
    depth: number;
    seq: number;
    /** Zeichen-Rang bei Tiefen-Gleichstand (Decke < Wand < Dach < Deko). */
    rank?: number;
    prim: Primitive;
  }
  const items: Item[] = [];
  let seq = 0;

  // Linien-Segmente werden exakt gegen nähere Occluder geclippt (verdeckte Teilstücke
  // entfallen). Die Anforderungen sammeln sich in Zeichenreihenfolge und gehen gebündelt
  // an den Kern (`flushPending`); `depth` = Tiefe der Linie (leicht vor ihrer Trägerfläche).
  type Pending =
    | { a: [number, number]; b: [number, number]; depth: number; prim: (a: [number, number], b: [number, number]) => Primitive }
    | { item: Omit<Item, "seq"> };
  const pending: Pending[] = [];
  const pushClippedLine = (
    a: [number, number],
    b: [number, number],
    depth: number,
    prim: (a: [number, number], b: [number, number]) => Primitive,
  ): void => {
    pending.push({ a, b, depth, prim });
  };
  const flushPending = (): void => {
    const lines = pending.filter((p): p is Extract<Pending, { a: unknown }> => "a" in p);
    const q: number[] = [lines.length];
    for (const l of lines) q.push(l.a[0], l.a[1], l.b[0], l.b[1], l.depth);
    const r = core().elevation_clip_segments_flat(occFlat, Float64Array.from(q));
    let i = 1;
    for (const p of pending) {
      if ("item" in p) {
        items.push({ ...p.item, seq: seq++ });
        continue;
      }
      const c = r.length === 0 ? 1 : r[i++];
      for (let k = 0; k < c; k++) {
        const sa: [number, number] = r.length === 0 ? p.a : [r[i], r[i + 1]];
        const sb: [number, number] = r.length === 0 ? p.b : [r[i + 2], r[i + 3]];
        if (r.length !== 0) i += 4;
        acc(sa[0], sa[1]);
        acc(sb[0], sb[1]);
        items.push({ depth: p.depth, seq: seq++, prim: p.prim(sa, sb) });
      }
    }
    pending.length = 0;
  };

  // Frontale Wand-/Deckenflächen (alle Ecken auf gleicher Tiefe) werden je
  // Tiefen-Gruppe gesammelt: die Flächen selbst OHNE Kontur, dann der
  // XOR-Vereinigungs-Umriss der Gruppe als (geclippter) Linienzug — Innenkanten
  // der Teilboxen (Pfeiler/Sturz/Geschossfugen) heben sich auf, übrig bleibt die
  // Silhouette samt Öffnungslöchern (VW-Linienzeichnungs-Look). Dach/schräge
  // Flächen tragen ihre eigene, ebenfalls geclippte Kanten-Kontur (unten).
  const edgeKey = (a: [number, number], b: [number, number]): string => {
    const r = (v: number) => Math.round(v * 1e4);
    const ka = `${r(a[0])},${r(a[1])}`;
    const kb = `${r(b[0])},${r(b[1])}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const roofEdgeFaces = new Map<string, ProjectedFace[]>();
  for (const f of faces) {
    if (f.role !== "roof" || !f.roofId || !f.normal) continue;
    for (let i = 0; i < f.pts.length; i++) {
      const k = edgeKey(f.pts[i], f.pts[(i + 1) % f.pts.length]);
      const list = roofEdgeFaces.get(k);
      if (list) list.push(f);
      else roofEdgeFaces.set(k, [f]);
    }
  }
  const isCoplanarSeam = (f: ProjectedFace, a: [number, number], b: [number, number]): boolean => {
    if (f.role !== "roof" || !f.roofId || !f.normal) return false;
    return (roofEdgeFaces.get(edgeKey(a, b)) ?? []).some(
      (o) =>
        o !== f &&
        o.roofId === f.roofId &&
        o.normal !== undefined &&
        f.normal![0] * o.normal[0] + f.normal![1] * o.normal[1] + f.normal![2] * o.normal[2] > 1 - 1e-9,
    );
  };
  const frontalGroups = new Map<number, { faces: ProjectedFace[]; depth: number }>();
  for (const f of faces) {
    const pts: Vec2[] = f.pts.map(([u, v]) => {
      acc(u, v);
      return { x: u, y: v };
    });
    const isRoof = f.role === "roof";
    const frontal = !isRoof && f.depthMax - f.depthMin < 1e-4;
    if (frontal) {
      const gk = Math.round(f.depth * 1e4);
      if (!frontalGroups.has(gk)) frontalGroups.set(gk, { faces: [], depth: f.depth });
      frontalGroups.get(gk)!.faces.push(f);
    } else {
      // Dach/schräg angeschnittene Fläche: jede Polygonkante als geclippte Linie
      // (verdeckte Teile hinter näheren Fassaden entfallen exakt).
      for (let i = 0; i < f.pts.length; i++) {
        const a = f.pts[i];
        const b = f.pts[(i + 1) % f.pts.length];
        // Naht zwischen zwei deckungsgleichen Teilflächen DESSELBEN Dachs (konvexe
        // Zerlegung einer L-/T-förmigen Dachfläche): keine Kante — es ist EINE Fläche.
        if (isCoplanarSeam(f, a, b)) continue;
        pushClippedLine(a, b, f.depthMin - EPS * 5, (sa, sb) => ({
          kind: "line",
          a: { x: sa[0], y: sa[1] },
          b: { x: sb[0], y: sb[1] },
          cls: "elevation-outline",
          weightMm: EDGE_MM,
          color: EDGE_INK,
        }));
      }
    }
    pending.push({ item: {
      depth: f.depth,
      // Painter-Gleichstand (bündige Flächen, z. B. Decken-Stirn in der
      // Fassadenebene): Decke vor Wand vor Dach zeichnen, damit die Wand die
      // Stirnstreifen überdeckt.
      rank: f.role === "slab" ? 0 : f.role === "wall" ? 1 : 2,
      prim: {
        kind: "polygon",
        pts,
        fill: fillFor(f.role, f.fill),
        // Kontur trägt die geclippte Kanten-/Gruppen-Linie (oben/unten) —
        // die Fläche selbst füllt nur (nähere Füllung überdeckt fernere).
        stroke: "none",
        strokeWidthMm: 0,
        hatch: NO_HATCH,
        greyed: isFaceGreyed(f),
        ...(f.wallId ? { wallId: f.wallId } : {}),
        ...(f.ceilingId ? { ceilingId: f.ceilingId } : {}),
        ...(f.roofId ? { roofId: f.roofId } : {}),
      },
    } });
  }
  for (const g of frontalGroups.values()) {
    // Der XOR-Silhouetten-Umriss der Gruppe, JEDE Kante exakt gegen nähere
    // opake Flächen geclippt: verdeckte Teile einer hinteren Fassade/Decke
    // entfallen, die vorderste Silhouette bleibt vollständig (Ecken via
    // Wandverlängerung geschlossen). Ersetzt die frühere Bbox-Occlusion.
    for (const [a, b] of xorOutlineEdges(g.faces.map((f) => f.pts))) {
      pushClippedLine(a, b, g.depth - EPS * 5, (sa, sb) => ({
        kind: "line",
        a: { x: sa[0], y: sa[1] },
        b: { x: sb[0], y: sb[1] },
        cls: "elevation-outline",
        weightMm: EDGE_MM,
        color: EDGE_INK,
      }));
    }
  }

  flushPending();

  // Schatten (leicht VOR der Empfängertiefe, damit sie direkt nach der Fassade,
  // aber unter den Öffnungen/Kanten näherer Flächen liegen).
  if (shadows) {
    // Schattenwerfer: auskragende Decken UND Dachflächen (Traufüberstand).
    for (const sh of buildShadows(wallFaces, [...slabFaces, ...roofFaces])) {
      const pts: Vec2[] = sh.pts.map(([u, v]) => {
        acc(u, v);
        return { x: u, y: v };
      });
      items.push({
        depth: sh.depth - EPS * 10,
        seq: seq++,
        prim: {
          kind: "polygon",
          pts,
          fill: SHADOW_FILL,
          stroke: "none",
          strokeWidthMm: 0,
          hatch: NO_HATCH,
        },
      });
    }
  }

  // Fenster/Türen: Rahmen+Glas, knapp VOR der Wirtsfläche (auf der Fassade).
  // Ganz verdeckte Öffnungen (Mittelpunkt hinter einer näheren opaken Fläche)
  // werden gar nicht erst emittiert — sonst scheinen ihre Symbol-/Sprossen-Linien
  // (eigener Linien-Durchgang, s. Occluder-Kommentar oben) durch die Vorderwand.
  for (const [openingIndex, op] of openings.entries()) {
    if (openingOccluded[1 + openingIndex] === 1) continue;
    const toVec = (q: Array<[number, number]>): Vec2[] =>
      q.map(([u, v]) => {
        acc(u, v);
        return { x: u, y: v };
      });
    const d = op.depth - EPS * 100;
    // Blendrahmen: helle Rahmenfläche mit kräftiger Kontur — Glas/Blatt/
    // Teilungen liegen darüber (gleiche Tiefe, seq-Reihenfolge).
    items.push({
      depth: d,
      seq: seq++,
      prim: {
        kind: "polygon",
        pts: toVec(op.pts),
        fill: mono ? "#ffffff" : FRAME_FILL_COLOR,
        stroke: EDGE_INK,
        strokeWidthMm: FRAME_MM,
        hatch: NO_HATCH,
        openingId: op.openingId,
      },
    });
    // Sims (Bank + Tropfkante) — verdeckt die Fassade, Kontur.
    for (const sRect of op.sill) {
      items.push({
        depth: d,
        seq: seq++,
        prim: {
          kind: "polygon",
          pts: toVec(sRect),
          fill: mono ? "#ffffff" : SILL_FILL_COLOR,
          stroke: EDGE_INK,
          strokeWidthMm: EDGE_MM,
          hatch: NO_HATCH,
          openingId: op.openingId,
        },
      });
    }
    // Flügelrahmen-Konturen (zwischen Blendrahmen und Glas).
    for (const sRect of op.sashRects) {
      items.push({
        depth: d,
        seq: seq++,
        prim: {
          kind: "polygon",
          pts: toVec(sRect),
          fill: "none",
          stroke: EDGE_INK,
          strokeWidthMm: EDGE_MM,
          hatch: NO_HATCH,
          openingId: op.openingId,
        },
      });
    }
    for (const g of op.glass) {
      items.push({
        depth: d,
        seq: seq++,
        prim: {
          kind: "polygon",
          pts: toVec(g),
          fill: mono ? GLASS_FILL_MONO : GLASS_FILL_COLOR,
          stroke: EDGE_INK,
          strokeWidthMm: EDGE_MM,
          hatch: NO_HATCH,
          openingId: op.openingId,
        },
      });
    }
    // Blinde Türblatt-Felder (Gegenstück zu `glass`, s. `ProjectedOpening.doorLeaf`).
    for (const g of op.doorLeaf) {
      items.push({
        depth: d,
        seq: seq++,
        prim: {
          kind: "polygon",
          pts: toVec(g),
          fill: mono ? "#ffffff" : DOOR_LEAF_FILL_COLOR,
          stroke: EDGE_INK,
          strokeWidthMm: EDGE_MM,
          hatch: NO_HATCH,
          openingId: op.openingId,
        },
      });
    }
    // Reveal-/Laibungsschatten (nur mit Schatten-Toggle): das zurückliegende
    // Fenster wirft — Sonne 45° von links oben — einen Schatten in die Laibung.
    // Klassische Architektur-Konvention: ein Band UNTER dem Sturz (Kopf, volle
    // Breite) und eines RECHTS der linken Laibung. Über dem Glas (nach den
    // Glasflächen, vor den Symbolen), damit die Öffnung als Vertiefung liest.
    // Bilinear im Öffnungs-Quad (pts [unten-links, unten-rechts, oben-rechts,
    // oben-links]).
    if (shadows) {
      const q = op.pts;
      const lerpP = (a: [number, number], b: [number, number], t: number): [number, number] => [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
      ];
      const quadAt = (fa: number, fz: number): [number, number] =>
        lerpP(lerpP(q[0], q[1], fa), lerpP(q[3], q[2], fa), fz);
      const wU = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
      const hV = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
      const fU = Math.min(0.3, 0.08 / Math.max(wU, 1e-6));
      const fV = Math.min(0.3, 0.08 / Math.max(hV, 1e-6));
      const shadowRect = (fa0: number, fa1: number, fz0: number, fz1: number): Vec2[] =>
        [quadAt(fa0, fz0), quadAt(fa1, fz0), quadAt(fa1, fz1), quadAt(fa0, fz1)].map(([u, v]) => {
          acc(u, v);
          return { x: u, y: v };
        });
      const pushShadow = (pts: Vec2[]): void => {
        items.push({
          depth: d,
          seq: seq++,
          prim: { kind: "polygon", pts, fill: OPENING_SHADOW_FILL, stroke: "none", strokeWidthMm: 0, hatch: NO_HATCH },
        });
      };
      pushShadow(shadowRect(0, 1, 1 - fV, 1)); // Kopf/Sturz-Schatten (oben, volle Breite)
      pushShadow(shadowRect(0, fU, 0, 1 - fV)); // linke Laibung (Rest der Höhe)
    }
    for (const [a, bLn] of op.divisions) {
      items.push({
        depth: d,
        seq: seq++,
        prim: {
          kind: "line",
          a: { x: a[0], y: a[1] },
          b: { x: bLn[0], y: bLn[1] },
          cls: "elevation-division",
          weightMm: EDGE_MM,
          color: EDGE_INK,
        },
      });
    }
    // Öffnungssymbol (SIA): dünn gestrichelt über dem Glas.
    for (const [a, bLn] of op.symbol) {
      items.push({
        depth: d,
        seq: seq++,
        prim: {
          kind: "line",
          a: { x: a[0], y: a[1] },
          b: { x: bLn[0], y: bLn[1] },
          cls: "elevation-opening-symbol",
          weightMm: 0.1,
          dash: [2.2, 1.8],
          color: SYMBOL_INK,
        },
      });
    }
  }

  // Painter: fern (grosse Tiefe) zuerst, nah zuletzt. Stabiler Tiebreak über seq.
  items.sort(
    (a, b) => (b.depth - a.depth) || ((a.rank ?? 3) - (b.rank ?? 3)) || (a.seq - b.seq),
  );
  for (const it of items) primitives.push(it.prim);

  // Bodenlinie (Terrain-/Nulllinie): kräftige Linie über die volle Breite an der
  // untersten sichtbaren Fassadenkante.
  if (isFinite(minX) && isFinite(minY)) {
    primitives.push({
      kind: "line",
      a: { x: minX, y: minY },
      b: { x: maxX, y: minY },
      cls: "elevation-ground",
      weightMm: GROUND_MM,
      color: GROUND_INK,
    });
  }

  if (!isFinite(minX)) return { primitives, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } };
  return { primitives, bounds: { minX, minY, maxX, maxY } };
}
