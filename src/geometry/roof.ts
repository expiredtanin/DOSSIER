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
import { cleanRing, convexPieces, isRectilinearNonRect, offsetRectilinear, rectilinearHipRoof } from "./roofSkeleton";

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
      // Mansarde: steile untere Neigung (pitchDeg) bis zur Knicklinie, dann
      // flache obere (pitchUpperDeg ?? halbe Hauptneigung). Untertyp steuert, ob
      // die Knickform an ZWEI Seiten sitzt (Giebel) oder RINGSUM (Walm/Zelt).
      const aLow = a;
      const aUp = Math.max(0, roof.pitchUpperDeg ?? roof.pitchDeg / 2) * DEG;
      const ratio = Math.min(0.49, Math.max(0.05, roof.mansardKneeRatio ?? 0.4));
      const mType = roof.mansardType ?? "giebel";

      if (mType === "giebel") {
        // Mansard-Satteldach: Knick nur an den beiden Traufseiten, Giebel an den
        // Enden (bisheriges Verhalten, jetzt mit parametrierbarem Knick).
        const d1 = halfD * ratio;
        const z1 = e + d1 * Math.tan(aLow);
        const z2 = z1 + (halfD - d1) * Math.tan(aUp);
        const yf = y0 + d1;
        const yb = y1 - d1;
        return {
          eaves,
          ridges: [[P(x0, yc), P(x1, yc)]],
          hips: [],
          breaks: [
            [P(x0, yf), P(x1, yf)],
            [P(x0, yb), P(x1, yb)],
          ],
          planes: [
            { pts: [[x0, y0, e], [x1, y0, e], [x1, yf, z1], [x0, yf, z1]] },
            { pts: [[x0, yf, z1], [x1, yf, z1], [x1, yc, z2], [x0, yc, z2]] },
            { pts: [[x0, y1, e], [x1, y1, e], [x1, yb, z1], [x0, yb, z1]] },
            { pts: [[x0, yb, z1], [x1, yb, z1], [x1, yc, z2], [x0, yc, z2]] },
          ],
          gables: [
            [[x0, y0, e], [x0, yf, z1], [x0, yc, z2], [x0, yb, z1], [x0, y1, e]],
            [[x1, y0, e], [x1, yf, z1], [x1, yc, z2], [x1, yb, z1], [x1, y1, e]],
          ],
          ridgeHeight: z2 - e,
        };
      }

      // Allseitige Mansarde (Walm/Zelt): steiler Sockel ringsum bis zur
      // Knicklinie (inneres Rechteck), darüber flacher Walm bzw. flache Spitze.
      const dLow = Math.min(halfW, halfD) * ratio;
      const z1 = e + dLow * Math.tan(aLow);
      const ix0 = x0 + dLow;
      const iy0 = y0 + dLow;
      const ix1 = x1 - dLow;
      const iy1 = y1 - dLow;
      const ihalfD = (iy1 - iy0) / 2;
      const ihalfW = (ix1 - ix0) / 2;
      // Sockel-Trapeze (4 Seiten, steil) + Sockel-Grate (Ecken aussen→innen) +
      // Knicklinie (inneres Rechteck) sind beiden allseitigen Formen gemein.
      const socketPlanes = [
        { pts: [[x0, y0, e], [x1, y0, e], [ix1, iy0, z1], [ix0, iy0, z1]] as Vec3[] },
        { pts: [[x1, y1, e], [x0, y1, e], [ix0, iy1, z1], [ix1, iy1, z1]] as Vec3[] },
        { pts: [[x0, y1, e], [x0, y0, e], [ix0, iy0, z1], [ix0, iy1, z1]] as Vec3[] },
        { pts: [[x1, y0, e], [x1, y1, e], [ix1, iy1, z1], [ix1, iy0, z1]] as Vec3[] },
      ];
      const socketHips: [Vec2, Vec2][] = [
        [P(x0, y0), P(ix0, iy0)],
        [P(x1, y0), P(ix1, iy0)],
        [P(x1, y1), P(ix1, iy1)],
        [P(x0, y1), P(ix0, iy1)],
      ];
      const kneeBreaks: [Vec2, Vec2][] = [
        [P(ix0, iy0), P(ix1, iy0)],
        [P(ix1, iy0), P(ix1, iy1)],
        [P(ix1, iy1), P(ix0, iy1)],
        [P(ix0, iy1), P(ix0, iy0)],
      ];

      if (mType === "walm") {
        // Oberer Walm auf dem inneren Rechteck (First entlang X).
        const z2 = z1 + ihalfD * Math.tan(aUp);
        let ra = ix0 + ihalfD;
        let rb = ix1 - ihalfD;
        if (ra > rb) ra = rb = xc;
        return {
          eaves,
          ridges: [[P(ra, yc), P(rb, yc)]],
          hips: [
            ...socketHips,
            [P(ix0, iy0), P(ra, yc)],
            [P(ix1, iy0), P(rb, yc)],
            [P(ix1, iy1), P(rb, yc)],
            [P(ix0, iy1), P(ra, yc)],
          ],
          breaks: kneeBreaks,
          planes: [
            ...socketPlanes,
            { pts: [[ix0, iy0, z1], [ix1, iy0, z1], [rb, yc, z2], [ra, yc, z2]] },
            { pts: [[ix1, iy1, z1], [ix0, iy1, z1], [ra, yc, z2], [rb, yc, z2]] },
            { pts: [[ix0, iy1, z1], [ix0, iy0, z1], [ra, yc, z2]] },
            { pts: [[ix1, iy0, z1], [ix1, iy1, z1], [rb, yc, z2]] },
          ],
          gables: [],
          ridgeHeight: z2 - e,
        };
      }

      // "zelt": flache Spitze über der Mitte des inneren Rechtecks.
      const z2 = z1 + Math.min(ihalfW, ihalfD) * Math.tan(aUp);
      return {
        eaves,
        ridges: [],
        hips: [
          ...socketHips,
          [P(ix0, iy0), P(xc, yc)],
          [P(ix1, iy0), P(xc, yc)],
          [P(ix1, iy1), P(xc, yc)],
          [P(ix0, iy1), P(xc, yc)],
        ],
        breaks: kneeBreaks,
        planes: [
          ...socketPlanes,
          { pts: [[ix0, iy0, z1], [ix1, iy0, z1], [xc, yc, z2]] },
          { pts: [[ix1, iy0, z1], [ix1, iy1, z1], [xc, yc, z2]] },
          { pts: [[ix1, iy1, z1], [ix0, iy1, z1], [xc, yc, z2]] },
          { pts: [[ix0, iy1, z1], [ix0, iy0, z1], [xc, yc, z2]] },
        ],
        gables: [],
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
  // Walmdach über einem rechtwinkligen, nicht-rechteckigen Grundriss (L/T/U …):
  // echte Flächen mit Graten und Kehlen statt Bounding-Box (s. roofSkeleton.ts).
  // Zeltdach/Mansard-Zelt auf L/T/U: eine einzelne Spitze gibt es dort nicht — sinnvolles
  // Gegenstück ist das allseitig geneigte Skelett-Dach (wie Walm, ohne Giebel).
  if (
    (roof.shape === "walm" || roof.shape === "sattel" || roof.shape === "mansarde" || roof.shape === "zelt") &&
    isRectilinearNonRect(roof.outline)
  ) {
    return rectilinearWalm(roof, eavesZ);
  }
  if (roof.shape === "pult" && isRectilinearNonRect(roof.outline)) {
    return rectilinearPult(roof, eavesZ);
  }
  const bb = roofBBox(roof.outline);
  const oe = Math.max(0, roof.overhang); // Traufüberstand (senkrecht zum First)
  const og = Math.max(0, roof.overhangGable ?? roof.overhang); // Ortgang (entlang First)
  // Der First liegt entlang der `ridgeAxis`-Achse: dort wirkt der Ortgang-, quer
  // dazu der Traufüberstand. In OUTLINE-Koordinaten je nach Firstrichtung mappen.
  const ox = roof.ridgeAxis === "x" ? og : oe;
  const oy = roof.ridgeAxis === "x" ? oe : og;
  let x0 = bb.x0 - ox;
  let y0 = bb.y0 - oy;
  let x1 = bb.x1 + ox;
  let y1 = bb.y1 + oy;
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

/**
 * Walmdach auf rechtwinkligem Grundriss: Traufe = Umriss um den Traufüberstand
 * nach aussen versetzt (ringsum gleich — beim Walm ist jede Kante Traufe),
 * Flächen/Linien aus {@link rectilinearHipRoof}.
 */
function rectilinearWalm(roof: Roof, eavesZ: number): RoofGeometry {
  let ring = cleanRing(roof.outline);
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    area += p.x * q.y - q.x * p.y;
  }
  if (area < 0) ring = [...ring].reverse();
  const oe = Math.max(0, roof.overhang);
  const og = Math.max(0, roof.overhangGable ?? roof.overhang);
  // Satteldach: Kanten quer zum First sind Ortgang (eigener Überstand), sonst Traufe.
  const eaves = offsetRectilinear(
    ring,
    roof.shape === "sattel"
      ? (a, b) => {
          const alongX = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
          return alongX === (roof.ridgeAxis === "x") ? oe : og;
        }
      : oe,
  );
  const tan = Math.tan(Math.max(0, roof.pitchDeg) * DEG);
  const gabled = roof.shape === "sattel" || (roof.shape === "mansarde" && (roof.mansardType ?? "giebel") === "giebel");
  const ridgeAxis = gabled ? roof.ridgeAxis : undefined;
  let knee: { d: number; tanUp: number } | undefined;
  if (roof.shape === "mansarde") {
    // Knick bei `mansardKneeRatio` der maximalen Dachtiefe (Abstand First–Traufe).
    const depth = rectilinearHipRoof(eaves, 1, 0, ridgeAxis).ridgeHeight;
    const ratio = Math.min(0.49, Math.max(0.05, roof.mansardKneeRatio ?? 0.4));
    const aUp = Math.max(0, roof.pitchUpperDeg ?? roof.pitchDeg / 2) * DEG;
    knee = { d: depth * ratio, tanUp: Math.tan(aUp) };
  }
  const sk = rectilinearHipRoof(eaves, tan, eavesZ, ridgeAxis, knee);
  return {
    eaves,
    ridges: sk.ridges,
    hips: sk.hips,
    breaks: sk.breaks,
    planes: sk.planes.map((pts) => ({ pts })),
    gables: sk.gables,
    ridgeHeight: sk.ridgeHeight,
  };
}

/**
 * Pultdach auf rechtwinkligem Grundriss: EINE Ebene über dem (um Traufe/Ortgang
 * geweiteten) Umriss. Tief bei kleinstem y (First entlang x) bzw. x (First entlang y),
 * Steigung wie beim Rechteck-Pult; Kanten quer zum First bekommen senkrechte Giebel.
 */
function rectilinearPult(roof: Roof, eavesZ: number): RoofGeometry {
  let ring = cleanRing(roof.outline);
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    area += p.x * q.y - q.x * p.y;
  }
  if (area < 0) ring = [...ring].reverse();
  const oe = Math.max(0, roof.overhang);
  const og = Math.max(0, roof.overhangGable ?? roof.overhang);
  const ax = roof.ridgeAxis === "x";
  const eaves = offsetRectilinear(ring, (a, b) => {
    const alongX = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
    return alongX === ax ? oe : og;
  });
  const tan = Math.tan(Math.max(0, roof.pitchDeg) * DEG);
  const s = (p: Vec2) => (ax ? p.y : p.x);
  const smin = Math.min(...eaves.map(s));
  const smax = Math.max(...eaves.map(s));
  const z = (p: Vec2) => eavesZ + tan * (s(p) - smin);
  const up = (p: Vec2): Vec3 => [p.x, p.y, z(p)];
  const base = (p: Vec2): Vec3 => [p.x, p.y, eavesZ];
  const gables: Vec3[][] = [];
  eaves.forEach((a, i) => {
    const b = eaves[(i + 1) % eaves.length];
    const alongX = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
    if (alongX === ax) return;
    gables.push([base(a), base(b), up(b), up(a)]);
  });
  return {
    eaves,
    ridges: [], // höchste Kante(n): Rand bei smax
    hips: [],
    breaks: [],
    planes: convexPieces(eaves).map((pc) => ({ pts: pc.map(up) })),
    gables,
    ridgeHeight: (smax - smin) * tan,
  };
}

/** Punkt-in-Polygon (Ray-Casting), 2D-Aufsicht. */
function pointInPolygon2D(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersect =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Dach-UNTERKANTE (Innenseite der untersten Schicht) an einem Grundriss-Punkt
 * (x,y) — `null`, wenn der Punkt ausserhalb aller Dachflächen liegt (Aufsicht).
 * Ebenengleichung je Fläche über die Newell-Normale (identische Herleitung wie
 * `toSection.ts::appendRoofSections`, dort inline für den Vertikalschnitt) minus
 * `totalLayerThickness` (Summe aller Dachschicht-Dicken, s. `roofLayers`).
 * Dient dem Wand-Zuschnitt unter geneigten Dächern ({@link trimWallTopForRoofs}
 * in `toWalls3d.ts`) — vermeidet, dass ein flacher Wand-Top die Dachfläche
 * durchdringt (Z-Fighting).
 */
export function roofUndersideAt(
  geo: RoofGeometry,
  totalLayerThickness: number,
  x: number,
  y: number,
): number | null {
  for (const pl of geo.planes) {
    const pts = pl.pts;
    if (pts.length < 3) continue;
    if (!pointInPolygon2D({ x, y }, pts.map((p) => ({ x: p[0], y: p[1] })))) continue;
    let A = 0;
    let B = 0;
    let C = 0;
    for (let i = 0; i < pts.length; i++) {
      const c = pts[i];
      const d = pts[(i + 1) % pts.length];
      A += (c[1] - d[1]) * (c[2] + d[2]);
      B += (c[2] - d[2]) * (c[0] + d[0]);
      C += (c[0] - d[0]) * (c[1] + d[1]);
    }
    if (Math.abs(C) < 1e-9) continue; // (nahezu) vertikale Fläche
    const topZ = pts[0][2] - (A * (x - pts[0][0]) + B * (y - pts[0][1])) / C;
    return topZ - Math.max(0, totalLayerThickness);
  }
  return null;
}
