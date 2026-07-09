// Dach-Geometrie: leitet aus einem (rechteckigen) Grundriss-Umriss + Dachform +
// Neigung die Grundriss-Linien (Traufe/First/Grat/Knick) UND die 3D-Dachflächen
// ab. Bewusst auf der BOUNDING-BOX des Umrisses gerechnet (First entlang einer
// Hauptachse) — die gängige, intuitive Vereinfachung, die alle Standardformen
// (Flach/Pult/Sattel/Walm/Mansarde/Zelt) exakt und ohne Straight-Skeleton abdeckt.
//
// Koordinaten: Grundriss (x, y) in Metern; 3D-Punkte als [x, y, z] mit z = Höhe.
// Reine Datenschicht (kein React/Store), voll unit-testbar.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Project, Roof, Vec2 } from "../model/types";
import { getFloor } from "../model/types";

/** 3D-Punkt [x, y, z=Höhe] in Modell-Metern. */
export type Vec3 = [number, number, number];

/** Eine ebene Dachfläche als Polygon (3D-Eckpunkte in Umlaufreihenfolge). */
export interface RoofPlane {
  pts: Vec3[];
}

/** Vollständige Dach-Geometrie (Grundriss-Linien + 3D-Flächen). */
export interface RoofGeometry {
  /** Traufe-Umriss (Grundriss, inkl. Überstand) als geschlossener Ring. */
  eaves: Vec2[];
  /** Firstlinie(n) im Grundriss (leer bei Flach/Zelt). */
  ridges: [Vec2, Vec2][];
  /** Gratlinien (Walm/Zelt: Ecke → First/Spitze). */
  hips: [Vec2, Vec2][];
  /** Knicklinien (Mansarde). */
  breaks: [Vec2, Vec2][];
  /** 3D-Dachflächen. */
  planes: RoofPlane[];
  /** Giebelflächen (vertikale Polygone an Sattel-/Mansarde-Enden). */
  gables: Vec3[][];
  /** Firsthöhe über der Traufe (Meter). */
  ridgeHeight: number;
}

const DEG = Math.PI / 180;

/** Bounding-Box eines Umrisses. */
export function roofBBox(outline: Vec2[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of outline) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Traufhöhe (absolutes Z) eines Dachs: `baseElevation`, sonst die OBERKANTE des
 * zugehörigen Geschosses (baseElevation + floorHeight) — das Dach sitzt also
 * standardmäßig auf der Geschossdecke auf.
 */
export function roofBaseElevation(project: Project, roof: Roof): number {
  if (roof.baseElevation !== undefined) return roof.baseElevation;
  try {
    const floor = getFloor(project, roof.floorId);
    return (floor.baseElevation ?? 0) + (floor.floorHeight ?? 0);
  } catch {
    return 0;
  }
}

const P = (x: number, y: number): Vec2 => ({ x, y });

/**
 * Kanonische Berechnung mit First entlang der X-Achse auf dem Rechteck
 * [x0,x1]×[y0,y1] (Traufe, inkl. Überstand) auf Traufhöhe `e`. Die „y"-First-
 * Richtung wird im Wrapper durch Transponieren (x↔y) erreicht.
 */
function computeCanonical(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  e: number,
  roof: Roof,
): RoofGeometry {
  const xc = (x0 + x1) / 2;
  const yc = (y0 + y1) / 2;
  const halfW = (x1 - x0) / 2;
  const halfD = (y1 - y0) / 2;
  const a = Math.max(0, roof.pitchDeg) * DEG;
  const tan = Math.tan(a);
  const h = halfD * tan; // Firsthöhe (Sattel/Walm/Mansarde)

  const eaves: Vec2[] = [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
  const flat = (): RoofGeometry => ({
    eaves,
    ridges: [],
    hips: [],
    breaks: [],
    planes: [{ pts: [[x0, y0, e], [x1, y0, e], [x1, y1, e], [x0, y1, e]] }],
    gables: [],
    ridgeHeight: 0,
  });

  switch (roof.shape) {
    case "flach":
      return flat();

    case "pult": {
      // Eine Fläche: tiefe Seite y0 auf Traufe, hohe Seite y1 auf e+H.
      const H = (y1 - y0) * tan;
      return {
        eaves,
        ridges: [[P(x0, y1), P(x1, y1)]], // hohe Kante (First-Ersatz)
        hips: [],
        breaks: [],
        planes: [{ pts: [[x0, y0, e], [x1, y0, e], [x1, y1, e + H], [x0, y1, e + H]] }],
        gables: [
          [[x0, y0, e], [x0, y1, e + H], [x0, y1, e]],
          [[x1, y0, e], [x1, y1, e + H], [x1, y1, e]],
        ],
        ridgeHeight: H,
      };
    }

    case "sattel": {
      const rz = e + h;
      return {
        eaves,
        ridges: [[P(x0, yc), P(x1, yc)]],
        hips: [],
        breaks: [],
        planes: [
          { pts: [[x0, y0, e], [x1, y0, e], [x1, yc, rz], [x0, yc, rz]] },
          { pts: [[x0, y1, e], [x1, y1, e], [x1, yc, rz], [x0, yc, rz]] },
        ],
        gables: [
          [[x0, y0, e], [x0, y1, e], [x0, yc, rz]],
          [[x1, y0, e], [x1, y1, e], [x1, yc, rz]],
        ],
        ridgeHeight: h,
      };
    }

    case "walm": {
      const rz = e + h;
      // First um die halbe Tiefe an beiden Enden verkürzt (45°-Grate bei
      // gleicher Neigung). Bei schmalem Baukörper (halfW<halfD) degeneriert er
      // zum Punkt (xc) → Walm wird zeltartig.
      let ra = x0 + halfD;
      let rb = x1 - halfD;
      if (ra > rb) ra = rb = xc;
      return {
        eaves,
        ridges: [[P(ra, yc), P(rb, yc)]],
        hips: [
          [P(x0, y0), P(ra, yc)],
          [P(x0, y1), P(ra, yc)],
          [P(x1, y0), P(rb, yc)],
          [P(x1, y1), P(rb, yc)],
        ],
        breaks: [],
        planes: [
          { pts: [[x0, y0, e], [x1, y0, e], [rb, yc, rz], [ra, yc, rz]] },
          { pts: [[x0, y1, e], [x1, y1, e], [rb, yc, rz], [ra, yc, rz]] },
          { pts: [[x0, y0, e], [x0, y1, e], [ra, yc, rz]] },
          { pts: [[x1, y0, e], [x1, y1, e], [rb, yc, rz]] },
        ],
        gables: [],
        ridgeHeight: h,
      };
    }

    case "mansarde": {
      // Sattel mit Knick: steile untere Neigung (pitchDeg) über den äusseren
      // Tiefenanteil, dann flache obere (pitchUpperDeg ?? halbe Hauptneigung).
      const aLow = a;
      const aUp = Math.max(0, roof.pitchUpperDeg ?? roof.pitchDeg / 2) * DEG;
      const d1 = halfD * 0.4; // Knick-Einzug von der Traufe (äussere 40% steil)
      const z1 = e + d1 * Math.tan(aLow);
      const z2 = z1 + (halfD - d1) * Math.tan(aUp);
      const yf = y0 + d1; // vordere Knicklinie
      const yb = y1 - d1; // hintere Knicklinie
      return {
        eaves,
        ridges: [[P(x0, yc), P(x1, yc)]],
        hips: [],
        breaks: [
          [P(x0, yf), P(x1, yf)],
          [P(x0, yb), P(x1, yb)],
        ],
        planes: [
          { pts: [[x0, y0, e], [x1, y0, e], [x1, yf, z1], [x0, yf, z1]] }, // vorn unten
          { pts: [[x0, yf, z1], [x1, yf, z1], [x1, yc, z2], [x0, yc, z2]] }, // vorn oben
          { pts: [[x0, y1, e], [x1, y1, e], [x1, yb, z1], [x0, yb, z1]] }, // hinten unten
          { pts: [[x0, yb, z1], [x1, yb, z1], [x1, yc, z2], [x0, yc, z2]] }, // hinten oben
        ],
        gables: [
          [[x0, y0, e], [x0, yf, z1], [x0, yc, z2], [x0, yb, z1], [x0, y1, e]],
          [[x1, y0, e], [x1, yf, z1], [x1, yc, z2], [x1, yb, z1], [x1, y1, e]],
        ],
        ridgeHeight: z2 - e,
      };
    }

    case "zelt": {
      // Allseitig zur Spitze über der Mitte.
      const hz = Math.min(halfW, halfD) * tan;
      const az = e + hz;
      return {
        eaves,
        ridges: [],
        hips: [
          [P(x0, y0), P(xc, yc)],
          [P(x1, y0), P(xc, yc)],
          [P(x1, y1), P(xc, yc)],
          [P(x0, y1), P(xc, yc)],
        ],
        breaks: [],
        planes: [
          { pts: [[x0, y0, e], [x1, y0, e], [xc, yc, az]] },
          { pts: [[x1, y0, e], [x1, y1, e], [xc, yc, az]] },
          { pts: [[x1, y1, e], [x0, y1, e], [xc, yc, az]] },
          { pts: [[x0, y1, e], [x0, y0, e], [xc, yc, az]] },
        ],
        gables: [],
        ridgeHeight: hz,
      };
    }
  }
}

const swap2 = (p: Vec2): Vec2 => ({ x: p.y, y: p.x });
const swap3 = (p: Vec3): Vec3 => [p[1], p[0], p[2]];
const swapLine = (l: [Vec2, Vec2]): [Vec2, Vec2] => [swap2(l[0]), swap2(l[1])];

/**
 * Dach-Geometrie aus Form/Neigung/Überstand + Traufhöhe `eavesZ`. Rechnet auf
 * der Bounding-Box des Umrisses, um `overhang` nach aussen geweitet. Für
 * `ridgeAxis:"y"` wird kanonisch (First entlang X) gerechnet und danach x↔y
 * transponiert.
 */
export function roofGeometry(roof: Roof, eavesZ: number): RoofGeometry {
  const bb = roofBBox(roof.outline);
  const o = Math.max(0, roof.overhang);
  let x0 = bb.x0 - o;
  let y0 = bb.y0 - o;
  let x1 = bb.x1 + o;
  let y1 = bb.y1 + o;
  const flip = roof.ridgeAxis === "y";
  if (flip) {
    [x0, y0, x1, y1] = [y0, x0, y1, x1];
  }
  const g = computeCanonical(x0, y0, x1, y1, eavesZ, roof);
  if (!flip) return g;
  return {
    eaves: g.eaves.map(swap2),
    ridges: g.ridges.map(swapLine),
    hips: g.hips.map(swapLine),
    breaks: g.breaks.map(swapLine),
    planes: g.planes.map((pl) => ({ pts: pl.pts.map(swap3) })),
    gables: g.gables.map((poly) => poly.map(swap3)),
    ridgeHeight: g.ridgeHeight,
  };
}
