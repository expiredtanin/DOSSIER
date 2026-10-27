// Reine Raycast-Mathematik für die 3D-Auswahl im Nordstern-Viewport (WASM/
// WebGPU-Pfad). Bewusst OHNE React/three.js/Engine-Abhängigkeit — nur Vektor-
// Arithmetik auf den geflachten Pick-Records (siehe `pickGeometry` in
// ../plan/toWalls3d.ts). So bleibt der Kern unit-testbar (raycast3d.test.ts)
// und der Klick-Pfad im Viewport dünn (Cursor → NDC → cameraRay → pickNearest).
//
// WELT-KONVENTION (identisch zu render3d / toWalls3d): Modell (x,y) → world
// (x, elevation, y); Höhe entlang +Y. Der Grundriss liegt also in der XZ-Ebene,
// vertikal wird über die world-Y-Achse extrudiert.
//
// KAMERA: `cameraRay` deckt BEIDE Projektionen ab — perspektivischer Pinhole-
// Strahl aus `eye` (Default, `perspective` fehlt/true) für die freie Orbit-
// Kamera, ODER (bei `perspective:false`, s. `ProjCamera`/Front-/Top-/Side-/
// Iso-Presets, die render3d orthografisch zeichnet) echte parallele Strahlen:
// alle Strahlen teilen dieselbe Richtung (Blickrichtung `f`), nur der URSPRUNG
// wandert lateral mit dem Pixel — exakte Umkehrung von `worldToScreen`s
// Ortho-Zweig, keine perspektivische Näherung mehr.


import { DRAWING_PICK_TOLERANCE } from "../plan/pickTypes";
import type { Vec3, PickWall, PickOpening, PickDrawingSeg, PickSlab, PickStair, PickRoof, PickContextMesh } from "../plan/pickTypes";
export type { Vec3 } from "../plan/pickTypes";

/** Kamera-Parameter für den Pick-Strahl (Teilmenge von Camera3d). */
export interface RayCamera {
  eye: readonly [number, number, number];
  target: readonly [number, number, number];
  up: readonly [number, number, number];
  /** Vertikaler Öffnungswinkel in RADIANT. */
  fovY: number;
  /** false = orthografisch (parallele Strahlen). Fehlt/true = perspektivisch
   *  (Default, rückwärtskompatibel zu bestehenden Aufrufern ohne dieses Feld). */
  perspective?: boolean;
  /** Halbe Bildhöhe in Metern — nur bei `perspective:false` relevant. */
  orthoHalfHeight?: number;
}

/** Ein Strahl in Weltkoordinaten (dir normalisiert). */
export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

/** Ergebnis eines Picks: getroffenes Bauteil + Distanz entlang des Strahls. */
export interface PickHit {
  kind: "wall" | "ceiling" | "opening" | "stair" | "roof" | "contextObject" | "drawing";
  id: string;
  t: number;
  /** Bei `kind:"opening"` dieselbe Id wie `id` (ausdrucksstärkerer Zugriff). */
  openingId?: string;
  /** Bei `kind:"stair"` dieselbe Id wie `id` (ausdrucksstärkerer Zugriff). */
  stairId?: string;
  /** Bei `kind:"contextObject"` dieselbe Id wie `id` (ausdrucksstärkerer Zugriff). */
  contextObjectId?: string;
  /** Bei `kind:"drawing"` dieselbe Id wie `id` (ausdrucksstärkerer Zugriff). */
  drawingId?: string;
}

const EPS = 1e-9;

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/**
 * Kamerastrahl durch ein NDC-Pixel. `ndcX`/`ndcY` ∈ [-1,1] (X links→rechts, Y
 * unten→oben — der Aufrufer invertiert die Pixel-Y-Achse). `aspect` = Breite/
 * Höhe des Canvas.
 *
 * `perspective` (Default true): Standard-Pinhole — EIN Ursprung (`eye`),
 * Richtung = f + s·(ndcX·aspect·tan(fovY/2)) + u·(ndcY·tan(fovY/2)).
 *
 * `perspective:false`: orthografisch — alle Strahlen PARALLEL (Richtung
 * immer `f`), der Ursprung wandert stattdessen lateral mit dem Pixel (exakte
 * Umkehrung von `worldToScreen`s Ortho-Zweig, s. `ProjCamera`).
 */
export function cameraRay(
  cam: RayCamera,
  ndcX: number,
  ndcY: number,
  aspect: number,
): Ray {
  const eye = cam.eye as Vec3;
  const f = norm(sub(cam.target as Vec3, eye)); // Blickrichtung
  const s = norm(cross(f, cam.up as Vec3)); // rechts
  const u = cross(s, f); // echtes Kamera-oben

  if (cam.perspective === false) {
    const hh = cam.orthoHalfHeight || 1;
    const origin: Vec3 = [
      eye[0] + s[0] * (ndcX * aspect * hh) + u[0] * (ndcY * hh),
      eye[1] + s[1] * (ndcX * aspect * hh) + u[1] * (ndcY * hh),
      eye[2] + s[2] * (ndcX * aspect * hh) + u[2] * (ndcY * hh),
    ];
    return { origin, dir: f };
  }

  const th = Math.tan(cam.fovY / 2);
  const dir = norm([
    f[0] + s[0] * (ndcX * aspect * th) + u[0] * (ndcY * th),
    f[1] + s[1] * (ndcX * aspect * th) + u[1] * (ndcY * th),
    f[2] + s[2] * (ndcX * aspect * th) + u[2] * (ndcY * th),
  ]);
  return { origin: [eye[0], eye[1], eye[2]], dir };
}

/**
 * Schnitt-Distanz des Strahls mit einem orientierten Quader (OBB) in der
 * world-XZ-Ebene, oder null. Der Quader ist exakt: Achse start→end in der
 * XZ-Ebene (Länge), Normale dazu (Dicke), world-Y (Höhe baseElevation..
 * baseElevation+height). Slab-Methode im OBB-Rahmen (Real-Time Rendering).
 * Rückgabe = nichtnegative Eintritts-t (bzw. Austritts-t, falls der Ursprung
 * im Quader liegt). Gemeinsamer Kern für `rayWallBox` (volle Wandhöhe) und
 * `rayOpeningBox` (nur die vertikale Ausdehnung der Öffnung).
 */
function rayOrientedBoxXZ(
  ray: Ray,
  start: readonly [number, number],
  end: readonly [number, number],
  thickness: number,
  height: number,
  baseElevation: number,
): number | null {
  const ax = end[0] - start[0];
  const az = end[1] - start[1];
  const len = Math.hypot(ax, az);
  if (len < EPS || height <= EPS || thickness <= EPS) return null;
  const axis: [Vec3, Vec3, Vec3] = [
    [ax / len, 0, az / len], // entlang der Achse
    [0, 1, 0], // Höhe
    [az / len, 0, -ax / len], // Normale (Dicke), senkrecht in XZ
  ];
  const half = [len / 2, height / 2, thickness / 2];
  const center: Vec3 = [
    (start[0] + end[0]) / 2,
    baseElevation + height / 2,
    (start[1] + end[1]) / 2,
  ];
  const p = sub(center, ray.origin);
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const e = dot(axis[i], p);
    const fdir = dot(axis[i], ray.dir);
    const h = half[i];
    if (Math.abs(fdir) > EPS) {
      let t1 = (e + h) / fdir;
      let t2 = (e - h) / fdir;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
      if (tmax < 0) return null;
    } else if (-e - h > 0 || -e + h < 0) {
      // Strahl parallel zu diesem Flächenpaar und ausserhalb → kein Treffer.
      return null;
    }
  }
  return tmin > 0 ? tmin : tmax;
}

/**
 * Schnitt-Distanz des Strahls mit dem orientierten Quader (OBB) einer Wand,
 * oder null — s. {@link rayOrientedBoxXZ}.
 */
export function rayWallBox(ray: Ray, wall: PickWall): number | null {
  return rayOrientedBoxXZ(ray, wall.start, wall.end, wall.thickness, wall.height, wall.baseElevation);
}

/**
 * Schnitt-Distanz des Strahls mit der orientierten Box einer Öffnung (Fenster/
 * Tür) über ihre EIGENE vertikale Ausdehnung, oder null — s. {@link rayOrientedBoxXZ}.
 */
export function rayOpeningBox(ray: Ray, opening: PickOpening): number | null {
  return rayOrientedBoxXZ(
    ray,
    opening.start,
    opening.end,
    opening.thickness,
    opening.height,
    opening.baseElevation,
  );
}

/**
 * Schnitt-Distanz des Strahls mit der (grosszügig tolerierten) Pick-Box eines
 * 2D-Zeichnungs-Segments, oder null — s. {@link PickDrawingSeg}/{@link rayOrientedBoxXZ}.
 */
export function rayDrawingSeg(ray: Ray, seg: PickDrawingSeg): number | null {
  return rayOrientedBoxXZ(
    ray,
    seg.start,
    seg.end,
    DRAWING_PICK_TOLERANCE,
    DRAWING_PICK_TOLERANCE,
    seg.baseElevation,
  );
}

/** Punkt-in-Polygon (XZ-Ebene), klassisches Ray-Casting (ungerade Kreuzungen). */
function pointInPolyXZ(
  x: number,
  z: number,
  poly: ReadonlyArray<readonly [number, number]>,
): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0];
    const zi = poly[i][1];
    const xj = poly[j][0];
    const zj = poly[j][1];
    const intersect =
      zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Ray-Dreieck (Möller–Trumbore), doppelseitig; nichtnegative t oder null. */
function rayTriangle(ray: Ray, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const pv = cross(ray.dir, e2);
  const det = dot(e1, pv);
  if (Math.abs(det) < EPS) return null; // parallel
  const inv = 1 / det;
  const tv = sub(ray.origin, a);
  const uu = dot(tv, pv) * inv;
  if (uu < 0 || uu > 1) return null;
  const qv = cross(tv, e1);
  const vv = dot(ray.dir, qv) * inv;
  if (vv < 0 || uu + vv > 1) return null;
  const t = dot(e2, qv) * inv;
  return t >= 0 ? t : null;
}

/**
 * Schnitt-Distanz des Strahls mit einem extrudierten Umriss-Prisma (world-XZ-
 * Grundriss, world-Y-Extrusion zBottom..zTop), oder null. GENAUIGKEIT: exakt
 * für ein einfaches (nicht selbst-schneidendes) Polygon — Deckel/Boden (y=
 * zTop/zBottom) über Punkt-in-Polygon (XZ), die Seitenflächen als vertikale
 * Quads (je zwei Ray-Dreiecke). Kleinstes nichtnegatives t gewinnt. Gemeinsamer
 * Kern für `raySlabPrism` (Decke) und `rayStairPrism` (Treppen-Bounding-Box).
 */
function rayPrismXZ(
  ray: Ray,
  outline: ReadonlyArray<readonly [number, number]>,
  zBottom: number,
  zTop: number,
): number | null {
  const n = outline.length;
  if (n < 3 || zTop - zBottom <= EPS) return null;
  let best = Infinity;
  const consider = (t: number | null) => {
    if (t !== null && t >= 0 && t < best) best = t;
  };
  // Deckel + Boden (horizontale Ebenen) via Punkt-in-Polygon.
  for (const y of [zBottom, zTop]) {
    if (Math.abs(ray.dir[1]) <= EPS) continue;
    const t = (y - ray.origin[1]) / ray.dir[1];
    if (t < 0) continue;
    const px = ray.origin[0] + t * ray.dir[0];
    const pz = ray.origin[2] + t * ray.dir[2];
    if (pointInPolyXZ(px, pz, outline)) consider(t);
  }
  // Seitenwände: je Kante ein vertikales Quad (zwei Dreiecke).
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = outline[j];
    const b = outline[i];
    const A: Vec3 = [a[0], zBottom, a[1]];
    const B: Vec3 = [b[0], zBottom, b[1]];
    const C: Vec3 = [b[0], zTop, b[1]];
    const D: Vec3 = [a[0], zTop, a[1]];
    consider(rayTriangle(ray, A, B, C));
    consider(rayTriangle(ray, A, C, D));
  }
  return best === Infinity ? null : best;
}

/**
 * Schnitt-Distanz des Strahls mit dem extrudierten Umriss-Prisma einer Decke,
 * oder null — s. {@link rayPrismXZ}.
 */
export function raySlabPrism(ray: Ray, slab: PickSlab): number | null {
  return rayPrismXZ(ray, slab.outline, slab.zBottom, slab.zTop);
}

/**
 * Schnitt-Distanz des Strahls mit dem Bounding-Prisma einer Treppe (Grundriss-
 * Fußabdruck × vertikale Ausdehnung), oder null — s. {@link rayPrismXZ}.
 */
export function rayStairPrism(ray: Ray, stair: PickStair): number | null {
  return rayPrismXZ(ray, stair.outline, stair.zBottom, stair.zTop);
}

/**
 * Kleinstes t über alle Dreiecke eines Dachs, oder null — nutzt das bestehende
 * doppelseitige {@link rayTriangle} (Dachflächen sind von oben UND unten
 * anklickbar).
 */
function rayRoofTris(ray: Ray, roof: PickRoof): number | null {
  let best: number | null = null;
  for (const [a, b, c] of roof.tris) {
    const t = rayTriangle(ray, a, b, c);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

/** Kleinstes t über alle Dreiecke eines Kontext-Meshes, oder null — wie
 *  {@link rayRoofTris}, dieselbe doppelseitige {@link rayTriangle}. */
function rayContextMeshTris(ray: Ray, mesh: PickContextMesh): number | null {
  let best: number | null = null;
  for (const [a, b, c] of mesh.tris) {
    const t = rayTriangle(ray, a, b, c);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

// Overload OHNE Öffnungen/Treppen: bleibt exakt die bisherige Signatur, sodass
// der bestehende Aufrufer (Wasm3DViewport.tsx: `pickNearest(ray, walls, slabs)`)
// unverändert kompiliert — inklusive des dort erwarteten engen `kind`-Typs
// ("wall" | "ceiling"), da mit leeren Öffnungen/Treppen ohnehin nur diese beiden
// Arten getroffen werden können.
export function pickNearest(
  ray: Ray,
  walls: readonly PickWall[],
  slabs: readonly PickSlab[],
): (PickHit & { kind: "wall" | "ceiling" }) | null;
// Erweiterter Overload MIT Öffnungen/Treppen/Dächern/Kontext-Meshes: `kind`
// deckt alle Arten ab.
export function pickNearest(
  ray: Ray,
  walls: readonly PickWall[],
  slabs: readonly PickSlab[],
  openings: readonly PickOpening[],
  stairs?: readonly PickStair[],
  roofs?: readonly PickRoof[],
  contextMeshes?: readonly PickContextMesh[],
  drawings?: readonly PickDrawingSeg[],
): PickHit | null;
/**
 * Nächstes getroffenes Bauteil (kleinstes t) über Wände, Decken, Öffnungen und
 * Treppen, oder null. Alle Kandidaten konkurrieren direkt über die Distanz —
 * was näher an der Kamera liegt, gewinnt. PRIORITÄT bei (nahezu) gleichem t:
 * Öffnung/Treppe vor Wand/Decke, weil ihr Symbol (Rahmen, Blatt, Stufenkante)
 * auf derselben Fläche wie die Wandaussenkante liegt und sonst vom fast
 * gleich-weiten Wandtreffer verdeckt würde — primär entscheidet aber IMMER das
 * kleinste t, der Rang bricht nur echte Gleichstände.
 */
export function pickNearest(
  ray: Ray,
  walls: readonly PickWall[],
  slabs: readonly PickSlab[],
  openings: readonly PickOpening[] = [],
  stairs: readonly PickStair[] = [],
  roofs: readonly PickRoof[] = [],
  contextMeshes: readonly PickContextMesh[] = [],
  drawings: readonly PickDrawingSeg[] = [],
): PickHit | null {
  const TIE_EPS = 1e-6;
  let hit: PickHit | null = null;
  let rank = Infinity;
  const consider = (candidate: PickHit, candidateRank: number) => {
    if (
      hit === null ||
      candidate.t < hit.t - TIE_EPS ||
      (candidate.t <= hit.t + TIE_EPS && candidateRank < rank)
    ) {
      hit = candidate;
      rank = candidateRank;
    }
  };
  for (const w of walls) {
    const t = rayWallBox(ray, w);
    if (t !== null) consider({ kind: "wall", id: w.wallId, t }, 1);
  }
  for (const s of slabs) {
    const t = raySlabPrism(ray, s);
    if (t !== null) consider({ kind: "ceiling", id: s.ceilingId, t }, 1);
  }
  for (const o of openings) {
    const t = rayOpeningBox(ray, o);
    if (t !== null) consider({ kind: "opening", id: o.openingId, t, openingId: o.openingId }, 0);
  }
  // 2D-Zeichnungs-Spuren: Rang wie Öffnung/Treppe (0) — ihre Boden-Spur liegt
  // auf derselben Fläche wie die Wand-/Deckenoberkante darunter und würde vom
  // fast gleich-weiten Wandtreffer sonst verdeckt.
  for (const d of drawings) {
    const t = rayDrawingSeg(ray, d);
    if (t !== null) consider({ kind: "drawing", id: d.drawingId, t, drawingId: d.drawingId }, 0);
  }
  for (const st of stairs) {
    const t = rayStairPrism(ray, st);
    if (t !== null) consider({ kind: "stair", id: st.stairId, t, stairId: st.stairId }, 0);
  }
  // Dächer: präzise geneigte Flächen (Dreiecke) — Rang wie Wand/Decke; die
  // Distanz entscheidet, ob das Dach oder die Fassade dahinter gemeint ist.
  for (const r of roofs) {
    const t = rayRoofTris(ray, r);
    if (t !== null) consider({ kind: "roof", id: r.roofId, t }, 1);
  }
  // Kontext-Meshes (importierte Gebäude/Terrain): Rang wie Wand/Decke/Dach.
  for (const m of contextMeshes) {
    const t = rayContextMeshTris(ray, m);
    if (t !== null) {
      consider({ kind: "contextObject", id: m.contextObjectId, t, contextObjectId: m.contextObjectId }, 1);
    }
  }
  return hit;
}

// ── 3D-Editier-Griffe (Wasm-Pfad) ────────────────────────────────────────────
// Ergänzt den Pick-Kern um die Bausteine, die ein Vertex-Griff-Drag im nativen
// Viewport braucht: Schnitt mit einer horizontalen Arbeitsebene (Drag-Ziel-
// punkt, analog `workplaneModel` in der three.js-Sicht) + Nächster-Griff-Test
// (Screen-Pixel-Toleranz, die je Strahl-Distanz in Welt-Meter umgerechnet wird
// — dieselbe perspektivische Näherung wie `cameraRay`/`pickNearest`).

/**
 * Schnittpunkt des Strahls mit der horizontalen Ebene world-y = `planeY`, oder
 * null (Strahl (nahezu) parallel zur Ebene oder Schnitt liegt hinter dem
 * Ursprung). Analog `workplaneModel` in `Viewport3D.tsx`, nur ohne three.js.
 */
export function rayPlaneY(ray: Ray, planeY: number): Vec3 | null {
  return rayPlane(ray, [0, planeY, 0], [0, 1, 0]);
}

/**
 * Schnittpunkt des Strahls mit einer beliebigen Ebene (Punkt + Normale), oder
 * null (Strahl (nahezu) parallel zur Ebene oder Schnitt hinter dem Ursprung).
 * Für den 3D-Höhen-Griff (vertikale Ebene entlang der Wandachse) — s.
 * `Wasm3DViewport.tsx`.
 */
export function rayPlane(ray: Ray, point: Vec3, normal: Vec3): Vec3 | null {
  const denom = dot(ray.dir, normal);
  if (Math.abs(denom) < EPS) return null;
  const t = dot(sub(point, ray.origin), normal) / denom;
  if (t < 0) return null;
  return [ray.origin[0] + t * ray.dir[0], ray.origin[1] + t * ray.dir[1], ray.origin[2] + t * ray.dir[2]];
}

/** Kameraparameter für die Weltpunkt→Bildschirm-Projektion (Umkehrung von `cameraRay`). */
export interface ProjCamera extends RayCamera {
  /** true = perspektivisch (fovY), false = orthografisch (orthoHalfHeight). */
  perspective: boolean;
  /** Halbe Sichthöhe in Metern (nur orthografisch). */
  orthoHalfHeight: number;
}

/**
 * Projiziert einen Weltpunkt auf Bildschirm-Pixel (0,0 = oben links) innerhalb
 * eines `width`×`height`-Rechtecks. `null`, wenn der Punkt (nur perspektivisch
 * relevant) hinter der Kamera liegt. Für echte GUI-Griffe (DOM-Overlay statt
 * In-Szene-Geometrie) — s. `Wasm3DViewport.tsx`.
 */
export function worldToScreen(
  cam: ProjCamera,
  point: Vec3,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const eye = cam.eye as Vec3;
  const f = norm(sub(cam.target as Vec3, eye));
  const s = norm(cross(f, cam.up as Vec3));
  const u = cross(s, f);
  const v = sub(point, eye);
  const aspect = width / height;
  let ndcX: number;
  let ndcY: number;
  if (cam.perspective) {
    const depth = dot(v, f);
    if (depth <= 0.01) return null;
    const th = Math.tan(cam.fovY / 2);
    ndcX = dot(v, s) / (depth * aspect * th);
    ndcY = dot(v, u) / (depth * th);
  } else {
    const hh = cam.orthoHalfHeight || 1;
    ndcX = dot(v, s) / (hh * aspect);
    ndcY = dot(v, u) / hh;
  }
  return { x: ((ndcX + 1) / 2) * width, y: ((1 - ndcY) / 2) * height };
}
