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

import type { DrawingLevel, Project, Vec2, Wall } from "../model/types";
import {
  getWallType,
  getWindowType,
  openingsOfWall,
  sashesOfWindowType,
  wallTypeThickness,
} from "../model/types";
import { wallVerticalExtent } from "../model/wall";
import { openingInterval, openingVerticalExtent } from "../geometry/opening";
import { roofBaseElevation, roofGeometry } from "../geometry/roof";
import { projectToModel3d } from "./toWalls3d";
import type { RModel3d, RSlab, RWall } from "./toWalls3d";
import { sectionPlaneFromLevel } from "./toSection";
import type { SectionPlaneSpec } from "./toSection";
import type { HatchRender, Plan, Primitive } from "./generatePlan";

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
/** Blaugraues Fenster-Glas (dunkler als die Fassade → als Öffnung lesbar). */
const GLASS_FILL = "#ffffff";
/** Glas im Mono-Modus (neutrales Grau statt Blaugrau). */
const GLASS_FILL_MONO = "#c4c8cd";
/** Festes Schattengrau (über der Fassade, unter den Kanten). */
const SHADOW_FILL = "#8f959e";
/** Bodenlinie (Terrain-/Nulllinie): kräftige Tinte über die volle Breite. */
const GROUND_INK = "#1f242c";
/** Strichstärke der Bodenlinie (mm Papier). */
const GROUND_MM = 0.5;
/** Rollen-Füllungen: EINE ruhige Fassadenfläche statt Tiefen-Patchworks —
 *  klassische Architektur-Ansicht (Flächen tragen, Kanten nur wo bedeutsam:
 *  Dachrand, Öffnungen, Bodenlinie). Wand/Decke identisch (Decken-Stirnflächen
 *  verschwinden optisch in der Fassade), Dach eine Stufe dunkler. */
const WALL_FILL = "#ffffff";
const ROOF_FILL = "#ffffff";
/** Blendrahmen-Fläche der Öffnungen. */
const FRAME_FILL = "#ffffff";
/** Türblatt-Fläche. */
const DOOR_LEAF_FILL = "#ffffff";
/** Öffnungssymbol (DIN-Andeutung): dezente Annotation, nicht Bauteilkante. */
const SYMBOL_INK = "#7d858f";

/** Sonnenrichtung als (u, v)-Schattenversatz je Tiefeneinheit: 45° von links
 *  oben ⇒ Schatten fällt nach rechts unten (+u, −v). */
const SUN_U = 1;
const SUN_V = -1;

/** Numerisches Rauschen (Meter) für Tiefen-/Flächenvergleiche. */
const EPS = 1e-6;
/** Grazing-Schwelle: Flächen fast parallel zur Blickrichtung gelten als nicht
 *  sichtbar (Kanten-an, keine Fläche) — vermeidet Z-Rauschen an Laibungen. */
const FACING_EPS = 1e-4;

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

/** Projektion eines Weltpunkts in die Ansicht: u, v (Höhe) und Tiefe hinter der Ebene. */
export function projectPoint(
  frame: ElevationFrame,
  w: V3,
): { u: number; v: number; depth: number } {
  const rx = w[0] - frame.P[0];
  const ry = w[1] - frame.P[1];
  const rz = w[2] - frame.P[2];
  return {
    u: rx * frame.U[0] + ry * frame.U[1] + rz * frame.U[2],
    v: w[1], // absolute Höhe, wie die Schnitt-v-Konvention
    depth: rx * frame.N[0] + ry * frame.N[1] + rz * frame.N[2],
  };
}

// ── Welt-Flächen aus dem geflachten Modell ─────────────────────────────────

/** Rolle einer Fläche (steuert Füllung/Stil in der Ansicht). */
export type FaceRole = "wall" | "slab" | "roof";

/** Eine orientierte Welt-Fläche (konvexes Polygon + Aussennormale). */
export interface WorldFace {
  poly: V3[];
  normal: V3;
  role: FaceRole;
  /** Ursprungs-Wand (nur role "wall") — für Auswahl/Painter-Identität. */
  wallId?: string;
  /** Ursprungs-Decke (nur role "slab"). */
  ceilingId?: string;
  /** Ursprungs-Dach (nur role "roof"). */
  roofId?: string;
}

function normalize3(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/**
 * Die sechs Quader-Flächen EINER Wand-Box (RWall) in Weltkoordinaten mit
 * Aussennormalen: zwei Langseiten (Fassaden-Aussenflächen, Normale horizontal
 * quer zur Wand), zwei Stirnkappen (Normale entlang der Achse), Deckel/Boden.
 */
export function wallWorldFaces(w: RWall): WorldFace[] {
  const sx = w.start[0];
  const sz = w.start[1];
  const ex = w.end[0];
  const ez = w.end[1];
  const ax = ex - sx;
  const az = ez - sz;
  const len = Math.hypot(ax, az);
  if (len < 1e-9 || w.height <= EPS) return [];
  const aHat: V3 = [ax / len, 0, az / len];
  const nHat: V3 = [az / len, 0, -ax / len]; // horizontale Quer-Normale
  const ht = w.thickness / 2;
  const zb = w.baseElevation;
  const zt = w.baseElevation + w.height;
  // Ecke bei (Achsen-Meter sAlong, Quer-Versatz tOff, Höhe y).
  const corner = (sAlong: number, tOff: number, y: number): V3 => [
    sx + aHat[0] * sAlong + nHat[0] * tOff,
    y,
    sz + aHat[2] * sAlong + nHat[2] * tOff,
  ];
  const faces: WorldFace[] = [];
  // +Quer (Aussenfläche A)
  faces.push({
    role: "wall",
    normal: nHat,
    poly: [corner(0, ht, zb), corner(len, ht, zb), corner(len, ht, zt), corner(0, ht, zt)],
  });
  // −Quer (Aussenfläche B)
  faces.push({
    role: "wall",
    normal: [-nHat[0], -nHat[1], -nHat[2]],
    poly: [corner(0, -ht, zb), corner(0, -ht, zt), corner(len, -ht, zt), corner(len, -ht, zb)],
  });
  // Stirn Start (−Achse)
  faces.push({
    role: "wall",
    normal: [-aHat[0], -aHat[1], -aHat[2]],
    poly: [corner(0, -ht, zb), corner(0, ht, zb), corner(0, ht, zt), corner(0, -ht, zt)],
  });
  // Stirn Ende (+Achse)
  faces.push({
    role: "wall",
    normal: aHat,
    poly: [corner(len, -ht, zb), corner(len, -ht, zt), corner(len, ht, zt), corner(len, ht, zb)],
  });
  // Deckel (+Höhe)
  faces.push({
    role: "wall",
    normal: [0, 1, 0],
    poly: [corner(0, -ht, zt), corner(0, ht, zt), corner(len, ht, zt), corner(len, -ht, zt)],
  });
  // Boden (−Höhe)
  faces.push({
    role: "wall",
    normal: [0, -1, 0],
    poly: [corner(0, -ht, zb), corner(len, -ht, zb), corner(len, ht, zb), corner(0, ht, zb)],
  });
  for (const f of faces) f.wallId = w.wallId;
  return faces;
}

/**
 * Die Flächen EINER Deckenplatte (RSlab): Deckel + Boden (Umriss bei zTop/zBottom)
 * und je Umrisskante eine Seitenfläche (Stirn). Die Seitennormalen werden über
 * den Grundriss-Schwerpunkt nach AUSSEN orientiert (unabhängig von der Umriss-
 * Windung). Der Umriss (Modell x,y) wird als Welt (x, y=Höhe, z=y) gehoben.
 */
export function slabWorldFaces(s: RSlab): WorldFace[] {
  const n = s.outline.length;
  if (n < 3 || s.zTop - s.zBottom <= EPS) return [];
  // Grundriss-Schwerpunkt (für die Aussen-Orientierung der Seitenflächen).
  let cx = 0;
  let cz = 0;
  for (const p of s.outline) {
    cx += p[0];
    cz += p[1];
  }
  cx /= n;
  cz /= n;
  const bottom: V3[] = s.outline.map((p) => [p[0], s.zBottom, p[1]]);
  const top: V3[] = s.outline.map((p) => [p[0], s.zTop, p[1]]);
  const faces: WorldFace[] = [];
  faces.push({ role: "slab", normal: [0, 1, 0], poly: top.slice() });
  faces.push({ role: "slab", normal: [0, -1, 0], poly: bottom.slice().reverse() });
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = s.outline[j][0] - s.outline[i][0];
    const ez = s.outline[j][1] - s.outline[i][1];
    // Kandidat-Normale horizontal quer zur Kante; nach aussen orientieren.
    let m: V3 = normalize3([ez, 0, -ex]);
    const midX = (s.outline[i][0] + s.outline[j][0]) / 2;
    const midZ = (s.outline[i][1] + s.outline[j][1]) / 2;
    if (m[0] * (midX - cx) + m[2] * (midZ - cz) < 0) m = [-m[0], -m[1], -m[2]];
    faces.push({
      role: "slab",
      normal: m,
      poly: [bottom[i], bottom[j], top[j], top[i]],
    });
  }
  for (const f of faces) f.ceilingId = s.ceilingId;
  return faces;
}

// ── Projektion + Sichtbarkeit ──────────────────────────────────────────────

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
}

/**
 * Projiziert eine Welt-Fläche und entscheidet die Sichtbarkeit:
 *   • Rückseiten-Culling: Normale muss GEGEN die Blickrichtung zeigen (N·Nf < 0).
 *   • Vor/Hinter: die mittlere Tiefe muss hinter der Ebene liegen (depth > 0).
 * Sonst `null` (Fläche erscheint nicht).
 */
export function projectFace(frame: ElevationFrame, face: WorldFace): ProjectedFace | null {
  const facing = frame.N[0] * face.normal[0] + frame.N[1] * face.normal[1] + frame.N[2] * face.normal[2];
  if (facing >= -FACING_EPS) return null; // Rückseite oder streifend → unsichtbar
  const pts: Array<[number, number]> = [];
  let depthSum = 0;
  let depthMin = Infinity;
  let depthMax = -Infinity;
  for (const w of face.poly) {
    const p = projectPoint(frame, w);
    pts.push([p.u, p.v]);
    depthSum += p.depth;
    depthMin = Math.min(depthMin, p.depth);
    depthMax = Math.max(depthMax, p.depth);
  }
  const depth = depthSum / face.poly.length;
  if (depth <= EPS) return null; // vor der Ebene → ignorieren
  return { pts, depth, depthMin, depthMax, role: face.role, wallId: face.wallId, ceilingId: face.ceilingId, roofId: face.roofId };
}

/**
 * Sammelt alle sichtbaren, projizierten Flächen des Modells (Wände + Decken),
 * bereits rückseiten-gecullt und vor der Ebene verworfen. Reihenfolge = Emissions-
 * reihenfolge des Modells (NICHT tiefensortiert) — die Painter-Sortierung macht
 * der Aufrufer.
 */
export function collectElevationFaces(model: RModel3d, frame: ElevationFrame): ProjectedFace[] {
  const out: ProjectedFace[] = [];
  for (const w of model.walls) {
    for (const f of wallWorldFaces(w)) {
      const pf = projectFace(frame, f);
      if (pf) out.push(pf);
    }
  }
  for (const s of model.slabs) {
    for (const f of slabWorldFaces(s)) {
      const pf = projectFace(frame, f);
      if (pf) out.push(pf);
    }
  }
  return out;
}

// ── Dächer ──────────────────────────────────────────────────────────────────

/**
 * Die Welt-Flächen ALLER Dächer des Projekts: Dachflächen (Aufsicht-Polygone der
 * roofGeometry, Normale aufwärts orientiert) + Giebel (vertikale Endflächen,
 * Normale vom Dach-Schwerpunkt weg nach aussen). Modell [x,y,z=Höhe] → Welt
 * (x, y=Höhe, z=y), dieselbe Konvention wie emitRoofs/pickGeometry. Die
 * Materialdicke bleibt für die Ansicht unberücksichtigt (Silhouette genügt —
 * die Untersicht ist rückseiten-gecullt ohnehin unsichtbar).
 */
export function roofWorldFacesAll(project: Project): WorldFace[] {
  const out: WorldFace[] = [];
  for (const roof of project.roofs ?? []) {
    const eavesZ = roofBaseElevation(project, roof);
    const g = roofGeometry(roof, eavesZ);
    // Dach-Schwerpunkt (Welt) für die Aussen-Orientierung der Giebel.
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let cn = 0;
    for (const pl of g.planes) {
      for (const p of pl.pts) {
        cx += p[0];
        cy += p[2];
        cz += p[1];
        cn++;
      }
    }
    if (cn === 0) continue;
    cx /= cn;
    cy /= cn;
    cz /= cn;
    const newell = (poly: V3[]): V3 => {
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        nx += (a[1] - b[1]) * (a[2] + b[2]);
        ny += (a[2] - b[2]) * (a[0] + b[0]);
        nz += (a[0] - b[0]) * (a[1] + b[1]);
      }
      return normalize3([nx, ny, nz]);
    };
    for (const pl of g.planes) {
      const poly: V3[] = pl.pts.map((p) => [p[0], p[2], p[1]]);
      let n = newell(poly);
      // Dachflächen zeigen aufwärts (Welt-Y).
      if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
      out.push({ role: "roof", normal: n, poly, roofId: roof.id });
    }
    for (const gable of g.gables) {
      const poly: V3[] = gable.map((p) => [p[0], p[2], p[1]]);
      if (poly.length < 3) continue;
      let n = newell(poly);
      // Giebel zeigen vom Dach-Schwerpunkt weg nach aussen.
      const toC: V3 = [cx - poly[0][0], cy - poly[0][1], cz - poly[0][2]];
      if (n[0] * toC[0] + n[1] * toC[1] + n[2] * toC[2] > 0) n = [-n[0], -n[1], -n[2]];
      out.push({ role: "roof", normal: n, poly, roofId: roof.id });
    }
  }
  return out;
}

// ── Fenster/Türen ───────────────────────────────────────────────────────────

/** Eine projizierte Öffnungs-Fläche (Rahmen+Glas) auf der Wand-Aussenseite. */
interface ProjectedOpening {
  pts: Array<[number, number]>;
  depth: number;
  /** Glasfelder (je Flügel/Feld) innerhalb des Blendrahmens. */
  glass: Array<Array<[number, number]>>;
  /** Teilungslinien (Pfosten/Kämpfer) über den Rahmen. */
  divisions: Array<[[number, number], [number, number]]>;
  /** Flügelrahmen-Rechtecke (Kontur je öffenbarem/festem Flügel). */
  sashRects: Array<Array<[number, number]>>;
  /** Fensterbank (Sims): Bank + Tropfkante als zwei Bänder unter dem Rahmen. */
  sill: Array<Array<[number, number]>>;
  /** Öffnungssymbol (DIN-Ansicht): Linien exakt auf den Glasfeld-Ecken. */
  symbol: Array<[[number, number], [number, number]]>;
  /** Tür (Blatt-Fläche statt Glas, ausser Glas-Blatt). */
  isDoor: boolean;
}

/**
 * Projiziert die Aussenfläche EINER Öffnung (Fenster/Tür) der Wirtswand: das
 * Rechteck [from..to] × [zBottom..zTop] auf der zum Betrachter zeigenden
 * Wand-Langseite (±T/2). Näherung: die Öffnung wird als planare Glasfläche BÜNDIG
 * in der Aussenwandebene dargestellt (keine Laibungstiefe) — genügt für die
 * Fassaden-Lesbarkeit. `null`, wenn keine Seite front-/hinter-Ebene liegt.
 */
function projectOpeningRect(
  frame: ElevationFrame,
  wall: Wall,
  from: number,
  to: number,
  zBottom: number,
  zTop: number,
  thickness: number,
): ProjectedOpening | null {
  const sx = wall.start.x;
  const sz = wall.start.y;
  const ax = wall.end.x - wall.start.x;
  const az = wall.end.y - wall.start.y;
  const len = Math.hypot(ax, az);
  if (len < 1e-9 || to - from <= EPS || zTop - zBottom <= EPS) return null;
  const aHat: V3 = [ax / len, 0, az / len];
  const nHat: V3 = [az / len, 0, -ax / len];
  const ht = thickness / 2;
  // Kandidaten-Seiten (±T/2): die front-facing + hinter der Ebene liegende nehmen.
  for (const side of [ht, -ht]) {
    const normal: V3 = side > 0 ? nHat : [-nHat[0], -nHat[1], -nHat[2]];
    const facing = frame.N[0] * normal[0] + frame.N[1] * normal[1] + frame.N[2] * normal[2];
    if (facing >= -FACING_EPS) continue;
    const corner = (sAlong: number, y: number): V3 => [
      sx + aHat[0] * sAlong + nHat[0] * side,
      y,
      sz + aHat[2] * sAlong + nHat[2] * side,
    ];
    const world = [corner(from, zBottom), corner(to, zBottom), corner(to, zTop), corner(from, zTop)];
    const pts: Array<[number, number]> = [];
    let depthSum = 0;
    for (const w of world) {
      const p = projectPoint(frame, w);
      pts.push([p.u, p.v]);
      depthSum += p.depth;
    }
    const depth = depthSum / world.length;
    if (depth <= EPS) continue;
    // pts-Reihenfolge: [unten-von, unten-bis, oben-bis, oben-von] — Basis für
    // die (fa, fz)-Interpolation der Flügel-/Glasfelder in collectOpenings.
    return { pts, depth, glass: [], divisions: [], sashRects: [], sill: [], symbol: [], isDoor: false };
  }
  return null;
}

/**
 * Alle Öffnungs-Flächen (Fenster/Türen inkl. Legacy-Türen) des Projekts, auf die
 * jeweilige Wand-Aussenseite projiziert. Thickness = WallType-Dicke (Fallback
 * 0.2 m). Rein aus dem Projekt (nicht aus dem geflachten Modell), damit Rahmen+Glas
 * unabhängig von der Segment-Aussparung der Wand-Box gezeichnet werden können.
 */
function collectOpenings(project: Project, frame: ElevationFrame): ProjectedOpening[] {
  const out: ProjectedOpening[] = [];
  const lerp = (
    a: [number, number],
    b: [number, number],
    t: number,
  ): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  // Punkt im Öffnungs-Quad: fa = Anteil entlang der Wandachse, fz = Höhenanteil.
  const quadAt = (
    q: Array<[number, number]>,
    fa: number,
    fz: number,
  ): [number, number] => lerp(lerp(q[0], q[1], fa), lerp(q[3], q[2], fa), fz);
  const rect = (
    q: Array<[number, number]>,
    fa0: number,
    fa1: number,
    fz0: number,
    fz1: number,
  ): Array<[number, number]> => [
    quadAt(q, fa0, fz0),
    quadAt(q, fa1, fz0),
    quadAt(q, fa1, fz1),
    quadAt(q, fa0, fz1),
  ];

  for (const wall of project.walls) {
    let thickness = 0.2;
    try {
      thickness = wallTypeThickness(getWallType(project, wall));
    } catch {
      thickness = 0.2;
    }
    const { zBottom, zTop } = wallVerticalExtent(project, wall);
    const axisLen = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    for (const op of openingsOfWall(project, wall.id)) {
      const iv = openingInterval(wall, op);
      if (!iv) continue;
      const v = openingVerticalExtent(project, wall, op);
      const pr = projectOpeningRect(frame, wall, iv.from, iv.to, v.zBottom, v.zTop, thickness);
      if (!pr) continue;
      const w = iv.to - iv.from;
      const h = v.zTop - v.zBottom;
      if (op.kind === "door") {
        // Türen im Projekt-`openings`-Array: Blatt-Fläche (kein Glasraster).
        pr.isDoor = true;
        pr.glass.push(rect(pr.pts, 0.04, 0.96, 0, 0.97));
        out.push(pr);
        continue;
      }
      // Fenster: Blendrahmen → Flügelfelder → Glas (+ Kämpfer/Oberlicht) aus dem
      // Fenstertyp; ohne Typ ein einzelnes Glasfeld im Default-Rahmen.
      const wt = getWindowType(project, op);
      const fw = wt?.frameWidth ?? 0.06;
      const fa = Math.min(0.45, fw / Math.max(w, 1e-6));
      const fz = Math.min(0.45, fw / Math.max(h, 1e-6));
      const transom = Math.max(0, wt?.transomHeight ?? 0);
      // Oberlicht-Trennung als Höhenanteil (0 = keins).
      const fTr = transom > EPS && transom < h - fw ? 1 - transom / h : 0;
      const fieldTop = fTr > 0 ? fTr - fz / 2 : 1 - fz;
      // Flügel-Spannen über die innere Breite (autoWidth gleichmässig).
      const sashes = wt ? sashesOfWindowType(wt) : [{ kind: "fluegel" as const }];
      const innerW = Math.max(1e-6, w * (1 - 2 * fa));
      let fixedSum = 0;
      let autoCount = 0;
      for (const sd of sashes) {
        if (sd.kind === "pfosten") fixedSum += Math.max(0, sd.postWidth ?? 0.06);
        else if (sd.autoWidth === false) fixedSum += Math.max(0, sd.width ?? 0);
        else autoCount++;
      }
      const autoW = autoCount > 0 ? Math.max(0.02, (innerW - fixedSum) / autoCount) : 0;
      let cursor = fa;
      for (const sd of sashes) {
        const sw =
          sd.kind === "pfosten"
            ? Math.max(0, sd.postWidth ?? 0.06)
            : sd.autoWidth === false
              ? Math.max(0, sd.width ?? autoW)
              : autoW;
        const fa0 = cursor;
        const fa1 = cursor + sw / w;
        cursor = fa1;
        if (sd.kind === "pfosten") {
          // Pfosten als Teilungslinie (Mitte).
          const fm = (fa0 + fa1) / 2;
          pr.divisions.push([quadAt(pr.pts, fm, fz), quadAt(pr.pts, fm, fieldTop)]);
          continue;
        }
        // Flügelrahmen (Kontur) + Glas darin eingerückt (VW: Blendrahmen →
        // Flügelprofil → Glas als drei ablesbare Konturen).
        pr.sashRects.push(rect(pr.pts, fa0, fa1, fz, fieldTop));
        const spw = Math.min(0.06, Math.max(0.03, fw)); // Flügelprofil (m)
        const gU = spw / Math.max(w, 1e-6);
        const gV = spw / Math.max(h, 1e-6);
        const gA = fa0 + gU;
        const gB = fa1 - gU;
        const gz0 = fz + gV;
        const gz1 = fieldTop - gV;
        if (gB - gA > 1e-6 && gz1 - gz0 > 1e-6) {
          pr.glass.push(rect(pr.pts, gA, gB, gz0, gz1));
        }
        // Trennlinie zum nächsten Feld (ausser am Rand).
        if (fa1 < 1 - fa - 1e-6) {
          pr.divisions.push([quadAt(pr.pts, fa1, fz), quadAt(pr.pts, fa1, fieldTop)]);
        }
        // Öffnungssymbol (DIN): Linien starten/enden EXAKT auf den Glasfeld-
        // Ecken (Nutzer-Report: Anker waren daneben). Dreh: Spitze am
        // Bandseiten-Mittel des Glasfelds; Kipp: Spitze oben Mitte (VW).
        const kind = sd.opening ?? wt?.kind ?? "fest";
        if (kind === "dreh" || kind === "drehkipp") {
          const hingeLeft = (sd.hingeSide ?? "left") === "left";
          const apex = quadAt(pr.pts, hingeLeft ? gA : gB, (gz0 + gz1) / 2);
          const farU = hingeLeft ? gB : gA;
          pr.symbol.push(
            [quadAt(pr.pts, farU, gz0), apex],
            [quadAt(pr.pts, farU, gz1), apex],
          );
        }
        if (kind === "kipp" || kind === "drehkipp") {
          const apex = quadAt(pr.pts, (gA + gB) / 2, gz1);
          pr.symbol.push(
            [quadAt(pr.pts, gA, gz0), apex],
            [quadAt(pr.pts, gB, gz0), apex],
          );
        }
      }
      // Fensterbank (Sims, VW): Bank + Tropfkante als zwei Bänder unter dem
      // Rahmen, seitlich leicht überstehend. Default AN (sillBoard fehlt),
      // aus bei "keine"/"innen".
      const sb = wt?.sillBoard;
      if (sb !== "keine" && sb !== "innen") {
        const ov1 = 0.02 / Math.max(w, 1e-6);
        const ov2 = 0.05 / Math.max(w, 1e-6);
        const h1 = 0.035 / Math.max(h, 1e-6);
        const h2 = 0.025 / Math.max(h, 1e-6);
        pr.sill.push(rect(pr.pts, -ov1, 1 + ov1, -h1, 0));
        pr.sill.push(rect(pr.pts, -ov2, 1 + ov2, -(h1 + h2), -h1));
      }

      // Oberlicht: eigenes Glasfeld + Kämpferlinie.
      if (fTr > 0) {
        pr.glass.push(rect(pr.pts, fa, 1 - fa, fTr + fz / 2, 1 - fz));
        pr.divisions.push([quadAt(pr.pts, 0, fTr), quadAt(pr.pts, 1, fTr)]);
      }
      out.push(pr);
    }
    for (const d of project.doors ?? []) {
      if (d.hostWallId !== wall.id) continue;
      const from = Math.max(0, Math.min(d.position, axisLen));
      const to = Math.max(from, Math.min(d.position + d.width, axisLen));
      const oTop = Math.min(zTop, zBottom + d.height);
      const pr = projectOpeningRect(frame, wall, from, to, zBottom, oTop, thickness);
      if (pr) {
        pr.isDoor = true;
        pr.glass.push(rect(pr.pts, 0.04, 0.96, 0, 0.97));
        out.push(pr);
      }
    }
  }
  return out;
}

// ── Schlagschatten (45°, klassische Architektur-Konvention) ─────────────────

/** Achsparalleles (u, v)-Rechteck. */
interface UVRect {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

function bboxOf(pts: Array<[number, number]>): UVRect {
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const [u, v] of pts) {
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  return { uMin, uMax, vMin, vMax };
}

/**
 * Clippt ein Polygon an ein achsparalleles Rechteck (Sutherland–Hodgman, vier
 * Halbebenen). Liefert das (konvexe) Restpolygon oder [] bei leerem Schnitt.
 */
function clipPolygonToRect(poly: Array<[number, number]>, r: UVRect): Array<[number, number]> {
  type Pt = [number, number];
  const clip = (
    input: Pt[],
    inside: (p: Pt) => boolean,
    intersect: (a: Pt, b: Pt) => Pt,
  ): Pt[] => {
    const out: Pt[] = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i];
      const b = input[(i + 1) % input.length];
      const ain = inside(a);
      const bin = inside(b);
      if (ain) out.push(a);
      if (ain !== bin) out.push(intersect(a, b));
    }
    return out;
  };
  let p: Pt[] = poly.slice();
  const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  // links (u >= uMin)
  p = clip(p, (q) => q[0] >= r.uMin, (a, b) => lerp(a, b, (r.uMin - a[0]) / (b[0] - a[0])));
  if (p.length < 3) return [];
  // rechts (u <= uMax)
  p = clip(p, (q) => q[0] <= r.uMax, (a, b) => lerp(a, b, (r.uMax - a[0]) / (b[0] - a[0])));
  if (p.length < 3) return [];
  // unten (v >= vMin)
  p = clip(p, (q) => q[1] >= r.vMin, (a, b) => lerp(a, b, (r.vMin - a[1]) / (b[1] - a[1])));
  if (p.length < 3) return [];
  // oben (v <= vMax)
  p = clip(p, (q) => q[1] <= r.vMax, (a, b) => lerp(a, b, (r.vMax - a[1]) / (b[1] - a[1])));
  if (p.length < 3) return [];
  return p;
}

/** Ein Schatten-Polygon mit der Tiefe der Empfängerfläche (für die Painter-Ordnung). */
interface ShadowPoly {
  pts: Array<[number, number]>;
  depth: number;
}

/**
 * Baut die Schlagschatten auskragender Decken/Balkone (Slabs) auf die dahinter
 * liegenden Fassaden (Wände). KLASSISCHE ARCHITEKTUR-KONVENTION: Sonne 45° von
 * links oben ⇒ die Unterkante des Überstands wirft einen Schatten, dessen
 * horizontaler Versatz UND vertikaler Abfall der Auskragungstiefe entspricht
 * (Δ = Tiefendifferenz Empfänger − Überstand). Der Schatten ist ein Parallelo-
 * gramm unter der Überstand-Unterkante (Höhe/Breite ∝ Δ), geclippt auf die
 * Empfänger-Fassade.
 *
 * NÄHERUNG (dokumentiert): Überstand-Silhouette = (u, v)-Bounding-Box der Slab-
 * Fläche; Empfänger = Bounding-Box der Wandfläche. Nur Slab→Wand-Paare mit
 * echtem Tiefen-Vorsprung (Slab näher) und u-Überlapp erzeugen Schatten. Deckt
 * die geforderten Fälle (Dachüberstand/Traufe, auskragende Decke/Balkon) ab;
 * schräge Auskragungen werden als achsparalleles Band angenähert.
 */
/** Maximale Schatten-Tiefendifferenz (Meter): tiefer liegende Empfänger (ferne
 *  Innen-/Rückwände) bekämen sonst raumhohe Schatten-Parallelogramme —
 *  gezeichnet wird der klassische Bauteil-Schlagschatten (Traufe, Balkon),
 *  nicht die globale Verschattung. */
const MAX_SHADOW_DELTA = 1.2;

export function buildShadows(walls: ProjectedFace[], slabs: ProjectedFace[]): ShadowPoly[] {
  const out: ShadowPoly[] = [];
  for (const slab of slabs) {
    const so = bboxOf(slab.pts);
    for (const wall of walls) {
      const wo = bboxOf(wall.pts);
      // Werfer-Tiefe = NÄCHSTE Kante (depthMin): bei geneigten Dachflächen ist
      // das die auskragende Traufe — der Bezug für die Schattentiefe.
      const delta = wall.depth - slab.depthMin; // Wand hinter dem Überstand?
      if (delta <= EPS || delta > MAX_SHADOW_DELTA) continue;
      // u-Überlapp Überstand/Wand?
      if (so.uMax <= wo.uMin + EPS || so.uMin >= wo.uMax - EPS) continue;
      // Der Schatten hängt an der Slab-Unterkante (so.vMin) und fällt um Δ nach
      // unten, versetzt um Δ nach rechts (Sonne von links oben).
      const vTop = so.vMin;
      const parallelogram: Array<[number, number]> = [
        [so.uMin, vTop],
        [so.uMax, vTop],
        [so.uMax + delta * SUN_U, vTop + delta * SUN_V],
        [so.uMin + delta * SUN_U, vTop + delta * SUN_V],
      ];
      const clipped = clipPolygonToRect(parallelogram, wo);
      if (clipped.length >= 3) out.push({ pts: clipped, depth: wall.depth });
    }
  }
  return out;
}

// ── Umriss-Vereinigung frontaler Flächengruppen ─────────────────────────────

/**
 * Vereinigungs-UMRISS einer Gruppe achsparalleler (u,v)-Rechteckflächen über
 * Kanten-XOR: jede Kante wird als Intervall auf ihrer Trägerlinie gesammelt;
 * Bereiche mit GERADER Überdeckung (geteilte Innenkanten zweier Teilboxen)
 * heben sich auf, ungerade Bereiche bilden die Silhouette — inklusive der
 * Fensterlöcher (die Teilboxen um eine Öffnung lassen genau deren Rand übrig).
 * Nicht-achsparallele Kanten werden unverändert durchgereicht.
 */
export function xorOutlineEdges(
  polys: Array<Array<[number, number]>>,
): Array<[[number, number], [number, number]]> {
  const EPS_AX = 1e-6;
  const keyOf = (x: number): number => Math.round(x * 1e5);
  const horiz = new Map<number, Array<[number, number]>>();
  const vert = new Map<number, Array<[number, number]>>();
  const out: Array<[[number, number], [number, number]]> = [];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (Math.abs(a[1] - b[1]) < EPS_AX) {
        const k = keyOf(a[1]);
        if (!horiz.has(k)) horiz.set(k, []);
        horiz.get(k)!.push([Math.min(a[0], b[0]), Math.max(a[0], b[0])]);
      } else if (Math.abs(a[0] - b[0]) < EPS_AX) {
        const k = keyOf(a[0]);
        if (!vert.has(k)) vert.set(k, []);
        vert.get(k)!.push([Math.min(a[1], b[1]), Math.max(a[1], b[1])]);
      } else {
        out.push([a, b]);
      }
    }
  }
  const sweep = (
    m: Map<number, Array<[number, number]>>,
    emit: (coord: number, s: number, e: number) => void,
  ): void => {
    for (const [k, ivs] of m) {
      const evs: Array<[number, number]> = [];
      for (const [s, e] of ivs) {
        if (e - s < 1e-9) continue;
        evs.push([s, 1], [e, -1]);
      }
      evs.sort((p, q) => p[0] - q[0] || q[1] - p[1]);
      let count = 0;
      let start = 0;
      const coord = k / 1e5;
      for (const [x, d] of evs) {
        const wasOdd = count % 2 === 1;
        count += d;
        const isOdd = count % 2 === 1;
        if (!wasOdd && isOdd) start = x;
        else if (wasOdd && !isOdd && x - start > 1e-9) emit(coord, start, x);
      }
    }
  };
  sweep(horiz, (v, s, e) => out.push([[s, v], [e, v]]));
  sweep(vert, (u, s, e) => out.push([[u, s], [u, e]]));
  return out;
}

// ── Plan-Zusammenbau ────────────────────────────────────────────────────────

/** Optionen des Ansichts-Generators. */
export interface ElevationOptions {
  /** Schlagschatten zeichnen (Default aus `level.shadows`). */
  shadows?: boolean;
  /** Schwarz-Weiss-Modus (neutralisierte Füllungen). */
  mono?: boolean;
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
  const faces = collectElevationFaces(model, frame);
  // Dächer analytisch (roofGeometry) — nicht Teil von RModel3d walls/slabs.
  for (const rf of roofWorldFacesAll(project)) {
    const pf = projectFace(frame, rf);
    if (pf) faces.push(pf);
  }
  const wallFaces = faces.filter((f) => f.role === "wall");
  const slabFaces = faces.filter((f) => f.role === "slab");
  const roofFaces = faces.filter((f) => f.role === "roof");

  const primitives: Primitive[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  // Rollen-Füllung: Fassade/Decke einheitlich, Dach eine Stufe dunkler —
  // KEINE Tiefenstaffelung (die machte aus der Fassade ein Grau-Patchwork).
  const fillFor = (role: FaceRole): string => {
    if (mono) return "#ffffff";
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

  // Frontale Wand-/Deckenflächen (alle Ecken auf gleicher Tiefe) werden je
  // Tiefen-Gruppe gesammelt: die Flächen selbst weiss OHNE Kontur, dann der
  // XOR-Vereinigungs-Umriss der Gruppe als Linienzug — Innenkanten der
  // Teilboxen (Pfeiler/Sturz/Geschossfugen) heben sich auf, übrig bleibt die
  // Silhouette samt Öffnungslöchern (VW-Linienzeichnungs-Look).
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
    }
    items.push({
      depth: f.depth,
      seq: seq++,
      // Painter-Gleichstand (bündige Flächen, z. B. Decken-Stirn in der
      // Fassadenebene): Decke vor Wand vor Dach zeichnen, damit die Wand die
      // Stirnstreifen überdeckt.
      rank: f.role === "slab" ? 0 : f.role === "wall" ? 1 : 2,
      prim: {
        kind: "polygon",
        pts,
        fill: fillFor(f.role),
        // Dach + schräg angeschnittene Flächen tragen ihre eigene Kontur;
        // frontale Flächen bekommen den Gruppen-Umriss (unten).
        stroke: isRoof || !frontal ? EDGE_INK : "none",
        strokeWidthMm: isRoof || !frontal ? EDGE_MM : 0,
        hatch: NO_HATCH,
        ...(f.wallId ? { wallId: f.wallId } : {}),
        ...(f.ceilingId ? { ceilingId: f.ceilingId } : {}),
        ...(f.roofId ? { roofId: f.roofId } : {}),
      },
    });
  }
  for (const g of frontalGroups.values()) {
    for (const [a, b] of xorOutlineEdges(g.faces.map((f) => f.pts))) {
      items.push({
        depth: g.depth - EPS * 5,
        seq: seq++,
        prim: {
          kind: "line",
          a: { x: a[0], y: a[1] },
          b: { x: b[0], y: b[1] },
          cls: "elevation-outline",
          weightMm: EDGE_MM,
          color: EDGE_INK,
        },
      });
    }
  }

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
  for (const op of collectOpenings(project, frame)) {
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
        fill: mono ? "#ffffff" : FRAME_FILL,
        stroke: EDGE_INK,
        strokeWidthMm: FRAME_MM,
        hatch: NO_HATCH,
      },
    });
    // Sims (Bank + Tropfkante) — weiss gefüllt (verdeckt die Fassade), Kontur.
    for (const sRect of op.sill) {
      items.push({
        depth: d,
        seq: seq++,
        prim: {
          kind: "polygon",
          pts: toVec(sRect),
          fill: mono ? "#ffffff" : FRAME_FILL,
          stroke: EDGE_INK,
          strokeWidthMm: EDGE_MM,
          hatch: NO_HATCH,
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
          fill: mono ? GLASS_FILL_MONO : op.isDoor ? DOOR_LEAF_FILL : GLASS_FILL,
          stroke: EDGE_INK,
          strokeWidthMm: EDGE_MM,
          hatch: NO_HATCH,
        },
      });
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
    // Öffnungssymbol (DIN): dünn gestrichelt über dem Glas.
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
