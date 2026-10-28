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
import type { DrawingLevel, Project, Vec2, Wall } from "../model/types";
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
 * {@link roofWorldFacesAll}), Fenster/Türen feste, an `toWalls3d.ts`
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
  /**
   * Bauteil-Farbe (dominante Wandschicht bzw. äusserste Dach-/Eindeckungs-
   * schicht) für den Farbig-Modus (s. {@link ElevationOptions.mono}). Fehlt
   * ⇒ Fallback auf die neutrale Rollen-Füllung.
   */
  fill?: RRgb;
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
  for (const f of faces) {
    f.wallId = w.wallId;
    f.fill = w.color;
  }
  return faces;
}

/**
 * Enthält der Wandkörper von `w` (Achse ± `half`) den Punkt `p`? Perpendikular-
 * abstand ≤ half UND Projektion innerhalb der Achsenlänge (mit half-Toleranz an
 * den Enden). Basis der T-/L-/X-Stoss-Erkennung für die Eckverlängerung.
 */
function wallBodyContains(w: Wall, half: number, p: Vec2): boolean {
  const dx = w.end.x - w.start.x;
  const dy = w.end.y - w.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return false;
  const ux = dx / len;
  const uy = dy / len;
  const rx = p.x - w.start.x;
  const ry = p.y - w.start.y;
  const along = rx * ux + ry * uy;
  const perp = Math.abs(-uy * rx + ux * ry);
  return along >= -1e-6 && along <= len + 1e-6 && perp <= half + 1e-6;
}

/**
 * Achsen-Verlängerung je Wandende (Meter, ≥0) für die ANSICHT: axis-zu-axis
 * gebaute Wandboxen (s. {@link wallWorldFaces}) decken einen Eckknoten nicht
 * voll ab — an jeder Ecke bleibt ein dreieckiger Spalt der Grösse der halben
 * Dicke der anschliessenden Wand (sichtbar als Kerbe in der Silhouette bzw. als
 * Lücke im Schlagschatten). Jedes Wandende wird darum bis zur AUSSENFLÄCHE der
 * dicksten anstossenden anderen Wand verlängert — die Boxen überlappen dann im
 * Eckbereich vollständig.
 *
 * Erfasst L-Ecken (Endpunkt teilt sich mit anderem Endpunkt), T-Stösse (Ende
 * trifft die SEITE/Achse einer durchlaufenden Wand) UND versetzte Stösse — über
 * {@link wallBodyContains} statt exakter Endpunkt-Gleichheit. Bewusst eine
 * EIGENE, tolerante Näherung statt der Gehrungs-Logik aus `model/joins.ts` (die
 * bedient 2D-Grundriss/3D-Viewer und bleibt unangetastet): die Ansicht ist ein
 * Painter-Silhouetten-Verfahren, dem eine leichte Eck-Überlappung nichts
 * ausmacht — anders als Grundriss-Poché/Schnitt-Dominanz, die exakte Gehrung
 * brauchen.
 */
function wallCornerExtensions(project: Project, walls: Wall[]): Map<string, { start: number; end: number }> {
  const thicknessOf = (w: Wall): number => {
    try {
      return wallTypeThickness(getWallType(project, w));
    } catch {
      return 0.2;
    }
  };
  const halves = new Map<string, number>();
  for (const w of walls) halves.set(w.id, thicknessOf(w) / 2);
  const extAt = (w: Wall, p: Vec2): number => {
    let maxOther = 0;
    for (const other of walls) {
      if (other.id === w.id) continue;
      const ho = halves.get(other.id) ?? 0.1;
      if (wallBodyContains(other, ho, p)) maxOther = Math.max(maxOther, ho);
    }
    return maxOther;
  };
  const out = new Map<string, { start: number; end: number }>();
  for (const w of walls) out.set(w.id, { start: extAt(w, w.start), end: extAt(w, w.end) });
  return out;
}

/**
 * Verlängert die (offset-freien, s. {@link resolveWallBands} `layered:false`)
 * Wand-Boxen des Ansichts-Modells an gemeinsamen Eck-Knoten (s.
 * {@link wallCornerExtensions}), damit Fassaden-Ecken in der Ansicht ohne
 * dreieckige Kerbe/Schattenlücke erscheinen. Wirkt PRO GESCHOSS (`floorId`),
 * damit sich nur Wände desselben Grundrisses zu Ecken verbinden. Mutiert die
 * `start`/`end`-Koordinaten der jeweils äussersten Teilstücke (Pfeiler vor der
 * ersten bzw. nach der letzten Öffnung) in-place.
 *
 * WICHTIG — nur Wände verlängern, die etwa PARALLEL zur Ansichtsebene laufen
 * (Fassaden-Silhouette): eine facaden-SENKRECHTE Wand (Innenwand quer zur
 * Blickrichtung) würde sonst entlang ihrer Achse in die Tiefe — u. U. VOR die
 * Fassade auf den Betrachter zu — geschoben und erschiene als störender
 * Balken. `uModel` ist die Ansichts-u-Achse in Grundriss-Koordinaten (Modell
 * x,y = Welt x,z), gegen die die Wandachse projiziert wird.
 */
function extendWallCornersForElevation(project: Project, rwalls: RWall[], uModel: Vec2): void {
  const byFloor = new Map<string, Wall[]>();
  for (const w of project.walls) {
    const key = w.floorId ?? "";
    const list = byFloor.get(key);
    if (list) list.push(w);
    else byFloor.set(key, [w]);
  }
  const byWallId = new Map<string, RWall[]>();
  for (const rw of rwalls) {
    const list = byWallId.get(rw.wallId);
    if (list) list.push(rw);
    else byWallId.set(rw.wallId, [rw]);
  }
  const closeTo = (a: RVec2, b: Vec2): boolean => Math.abs(a[0] - b.x) < 1e-6 && Math.abs(a[1] - b.y) < 1e-6;
  for (const floorWalls of byFloor.values()) {
    const ext = wallCornerExtensions(project, floorWalls);
    for (const w of floorWalls) {
      const e = ext.get(w.id);
      if (!e || (e.start <= EPS && e.end <= EPS)) continue;
      const pieces = byWallId.get(w.id);
      if (!pieces) continue;
      const dx = w.end.x - w.start.x;
      const dz = w.end.y - w.start.y;
      const len = Math.hypot(dx, dz);
      if (len < 1e-9) continue;
      const ux = dx / len;
      const uz = dz / len;
      // Parallelität zur Ansichtsebene: |Achse · u| ≈ 1 (parallel) … 0 (senkrecht).
      // Facaden-senkrechte Wände NICHT verlängern (sonst Tiefen-Protrusion).
      if (Math.abs(ux * uModel.x + uz * uModel.y) < 0.35) continue;
      if (e.start > EPS) {
        const first = pieces.find((p) => closeTo(p.start, w.start));
        if (first) first.start = [first.start[0] - ux * e.start, first.start[1] - uz * e.start];
      }
      if (e.end > EPS) {
        const last = pieces.find((p) => closeTo(p.end, w.end));
        if (last) last.end = [last.end[0] + ux * e.end, last.end[1] + uz * e.end];
      }
    }
  }
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
  for (const f of faces) {
    f.ceilingId = s.ceilingId;
    f.fill = s.color;
  }
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
  fill?: RRgb;
  /** Welt-Normale (Einheit) — für die Erkennung deckungsgleicher Nachbarflächen. */
  normal?: V3;
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
  return {
    pts,
    depth,
    depthMin,
    depthMax,
    role: face.role,
    wallId: face.wallId,
    ceilingId: face.ceilingId,
    roofId: face.roofId,
    fill: face.fill,
    normal: face.normal,
  };
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
    // Äusserste Schicht (Eindeckung) bzw. `roof.color`-Übersteuerung — dieselbe
    // Farbwahl wie {@link emitRoofs} (3D-Viewer), damit Ansicht/3D konsistent
    // wirken. Ohne auflösbare Schicht der neutrale Dach-Fallback.
    const outer = roofLayers(project, roof)[0];
    const fill: RRgb = roof.color
      ? hexToRgb(roof.color, ROOF_RGB_FALLBACK)
      : outer?.componentId
        ? hexToRgb(getComponent(project, outer.componentId).color, ROOF_RGB_FALLBACK)
        : ROOF_RGB_FALLBACK;
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
      out.push({ role: "roof", normal: n, poly, roofId: roof.id, fill });
    }
    for (const gable of g.gables) {
      const poly: V3[] = gable.map((p) => [p[0], p[2], p[1]]);
      if (poly.length < 3) continue;
      let n = newell(poly);
      // Giebel zeigen vom Dach-Schwerpunkt weg nach aussen.
      const toC: V3 = [cx - poly[0][0], cy - poly[0][1], cz - poly[0][2]];
      if (n[0] * toC[0] + n[1] * toC[1] + n[2] * toC[2] > 0) n = [-n[0], -n[1], -n[2]];
      out.push({ role: "roof", normal: n, poly, roofId: roof.id, fill });
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
    return { pts, depth, glass: [], doorLeaf: [], divisions: [], sashRects: [], sill: [], symbol: [], isDoor: false };
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
    for (const op of openingsOfWall(project, wall.id)) {
      const iv = openingInterval(wall, op);
      if (!iv) continue;
      const v = openingVerticalExtent(project, wall, op);
      const pr = projectOpeningRect(frame, wall, iv.from, iv.to, v.zBottom, v.zTop, thickness);
      if (!pr) continue;
      pr.openingId = op.id;
      const w = iv.to - iv.from;
      const h = v.zTop - v.zBottom;
      if (op.kind === "door") {
        // Türen im Projekt-`openings`-Array: Blatt-Fläche, bei Glasblatt mit
        // Teilverglasung (`glazingRatio`, Kämpferhöhe von OBEN gemessen wie
        // beim Fenster-Oberlicht) — Glasanteil oben (`glass`), blinder Rest
        // unten (`doorLeaf`), Trennlinie dazwischen ab Kämpfer.
        pr.isDoor = true;
        const dt = getDoorType(project, op);
        if (dt?.leafStyle === "glas") {
          const ratio = Math.max(0.05, Math.min(1, dt.glazingRatio ?? 1));
          if (ratio >= 1 - EPS) {
            pr.glass.push(rect(pr.pts, 0.04, 0.96, 0, 0.97));
          } else {
            const splitZ = 0.97 * (1 - ratio);
            pr.glass.push(rect(pr.pts, 0.04, 0.96, splitZ, 0.97));
            pr.doorLeaf.push(rect(pr.pts, 0.04, 0.96, 0, splitZ));
            pr.divisions.push([quadAt(pr.pts, 0.04, splitZ), quadAt(pr.pts, 0.96, splitZ)]);
          }
        } else {
          pr.doorLeaf.push(rect(pr.pts, 0.04, 0.96, 0, 0.97));
        }
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
        // Kämpfer-/Sprossen-Zeilen (mullionRows): das Glasfeld wird in `rows`
        // horizontale Scheiben geteilt (analog zum 3D, s. toWalls3d), mit einer
        // Trennlinie je Zeilengrenze über die Glasbreite. 1 = ungeteilt (bisher).
        const rows = Math.max(1, Math.round(wt?.mullionRows ?? 1));
        // Sprossen-Spalten (mullionCols): das Glasfeld wird in `cols` vertikale
        // Scheiben geteilt (analog zum 3D, s. toWalls3d), mit einer
        // Trennlinie je Spaltengrenze über die Glasscheibenhöhe.
        const cols = Math.max(1, Math.round(wt?.mullionCols ?? 1));
        if (gB - gA > 1e-6 && gz1 - gz0 > 1e-6) {
          // Glasfelder: rows × cols Gitter aus Einzelscheiben.
          for (let r = 0; r < rows; r++) {
            const rz0 = gz0 + ((gz1 - gz0) * r) / rows + (r > 0 ? gV / 2 : 0);
            const rz1 = gz0 + ((gz1 - gz0) * (r + 1)) / rows - (r < rows - 1 ? gV / 2 : 0);
            if (rz1 - rz0 <= 1e-6) continue;
            for (let c = 0; c < cols; c++) {
              const ca0 = gA + ((gB - gA) * c) / cols + (c > 0 ? gU / 2 : 0);
              const ca1 = gA + ((gB - gA) * (c + 1)) / cols - (c < cols - 1 ? gU / 2 : 0);
              if (ca1 - ca0 > 1e-6) pr.glass.push(rect(pr.pts, ca0, ca1, rz0, rz1));
            }
          }
          // Horizontale Trennlinien (Kämpfer)
          for (let r = 1; r < rows; r++) {
            const rz = gz0 + ((gz1 - gz0) * r) / rows;
            pr.divisions.push([quadAt(pr.pts, gA, rz), quadAt(pr.pts, gB, rz)]);
          }
          // Vertikale Trennlinien (Sprossen-Spalten)
          for (let c = 1; c < cols; c++) {
            const ca = gA + ((gB - gA) * c) / cols;
            pr.divisions.push([quadAt(pr.pts, ca, gz0), quadAt(pr.pts, ca, gz1)]);
          }
        }
        // Trennlinie zum nächsten Feld (ausser am Rand).
        if (fa1 < 1 - fa - 1e-6) {
          pr.divisions.push([quadAt(pr.pts, fa1, fz), quadAt(pr.pts, fa1, fieldTop)]);
        }
        // Öffnungssymbol (SIA B.9.1.3): Linien starten/enden EXAKT auf den
        // Glasfeld-Ecken (Nutzer-Report: Anker waren daneben). Dreh/Drehkipp:
        // Spitze zeigt zur Bandseite (Anschlag), Basis zur Griffseite — SIA-
        // Konvention. Kipp: Spitze oben Mitte (VW).
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
        if (kind === "schiebe") {
          // Schiebeflügel (SIA: „vertikales/horizontales Schiebefenster"):
          // KEIN Dreieck (keine Bandseite), sondern ein Pfeil in Laufrichtung
          // (horizontal) auf halber Glashöhe — die Griffseite (hingeSide)
          // bestimmt die Pfeilrichtung.
          const zc = (gz0 + gz1) / 2;
          const toRight = (sd.hingeSide ?? "left") === "left"; // Griff links ⇒ schiebt nach rechts
          const tail = toRight ? gA : gB;
          const head = toRight ? gB : gA;
          const barb = (head - tail) * 0.22; // Pfeilspitzen-Rücksprung (Glasbreite-Anteil)
          const headPt = quadAt(pr.pts, head, zc);
          pr.symbol.push(
            [quadAt(pr.pts, tail, zc), headPt], // Schaft
            [quadAt(pr.pts, head - barb, gz0 + (gz1 - gz0) * 0.32), headPt], // obere Spitze
            [quadAt(pr.pts, head - barb, gz0 + (gz1 - gz0) * 0.68), headPt], // untere Spitze
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
  let faces = collectElevationFaces(model, frame);
  // Dächer analytisch (roofGeometry) — nicht Teil von RModel3d walls/slabs.
  for (const rf of roofWorldFacesAll(project)) {
    const pf = projectFace(frame, rf);
    if (pf) faces.push(pf);
  }
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
