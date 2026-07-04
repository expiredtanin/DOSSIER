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
// KAMERA: perspektivischer Pinhole-Strahl aus eye durch das Cursor-Pixel. Für
// die freie Orbit-Kamera (iso/perspektivisch bzw. nach jeder manuellen
// Navigation) ist das exakt. Für die achsparallelen Presets (front/top/side),
// die render3d orthografisch zeichnet, ist es eine perspektivische Näherung —
// der Blickwinkel stimmt (VIEW3D_ORBIT), die Parallaxe nicht ganz. Ausreichend
// für die Bauteil-Auswahl; ein exakter Ortho-Strahl kann später ergänzt werden.

export type Vec3 = [number, number, number];

/** Kamera-Parameter für den Pick-Strahl (Teilmenge von Camera3d). */
export interface RayCamera {
  eye: readonly [number, number, number];
  target: readonly [number, number, number];
  up: readonly [number, number, number];
  /** Vertikaler Öffnungswinkel in RADIANT. */
  fovY: number;
}

/** Ein Strahl in Weltkoordinaten (dir normalisiert). */
export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

/** Minimal-Form eines Wand-Quaders für den Raycast (RWall erfüllt sie strukturell). */
export interface PickWall {
  start: readonly [number, number];
  end: readonly [number, number];
  thickness: number;
  height: number;
  baseElevation: number;
  wallId: string;
}

/** Minimal-Form eines Decken-Prismas für den Raycast (RSlab erfüllt sie strukturell). */
export interface PickSlab {
  outline: ReadonlyArray<readonly [number, number]>;
  zBottom: number;
  zTop: number;
  ceilingId: string;
}

/** Ergebnis eines Picks: getroffenes Bauteil + Distanz entlang des Strahls. */
export interface PickHit {
  kind: "wall" | "ceiling";
  id: string;
  t: number;
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
 * Perspektivischer Kamerastrahl durch ein NDC-Pixel. `ndcX`/`ndcY` ∈ [-1,1]
 * (X links→rechts, Y unten→oben — der Aufrufer invertiert die Pixel-Y-Achse).
 * `aspect` = Breite/Höhe des Canvas. Standard-Pinhole: Kamerabasis f/s/u aus
 * eye/target/up, Richtung = f + s·(ndcX·aspect·tan(fovY/2)) + u·(ndcY·tan(fovY/2)).
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
  const th = Math.tan(cam.fovY / 2);
  const dir = norm([
    f[0] + s[0] * (ndcX * aspect * th) + u[0] * (ndcY * th),
    f[1] + s[1] * (ndcX * aspect * th) + u[1] * (ndcY * th),
    f[2] + s[2] * (ndcX * aspect * th) + u[2] * (ndcY * th),
  ]);
  return { origin: [eye[0], eye[1], eye[2]], dir };
}

/**
 * Schnitt-Distanz des Strahls mit dem orientierten Quader (OBB) einer Wand, oder
 * null. Der Quader ist exakt: Achse start→end in der XZ-Ebene (Länge), Normale
 * dazu (Dicke), world-Y (Höhe baseElevation..baseElevation+height). Slab-Methode
 * im OBB-Rahmen (Real-Time Rendering). Rückgabe = nichtnegative Eintritts-t (bzw.
 * Austritts-t, falls der Ursprung im Quader liegt).
 */
export function rayWallBox(ray: Ray, wall: PickWall): number | null {
  const ax = wall.end[0] - wall.start[0];
  const az = wall.end[1] - wall.start[1];
  const len = Math.hypot(ax, az);
  if (len < EPS || wall.height <= EPS || wall.thickness <= EPS) return null;
  const axis: [Vec3, Vec3, Vec3] = [
    [ax / len, 0, az / len], // entlang der Wandachse
    [0, 1, 0], // Höhe
    [az / len, 0, -ax / len], // Normale (Dicke), senkrecht in XZ
  ];
  const half = [len / 2, wall.height / 2, wall.thickness / 2];
  const center: Vec3 = [
    (wall.start[0] + wall.end[0]) / 2,
    wall.baseElevation + wall.height / 2,
    (wall.start[1] + wall.end[1]) / 2,
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
 * Schnitt-Distanz des Strahls mit dem extrudierten Umriss-Prisma einer Decke,
 * oder null. GENAUIGKEIT: exakt für ein einfaches (nicht selbst-schneidendes)
 * Polygon — Deckel/Boden (y=zTop/zBottom) über Punkt-in-Polygon (XZ), die
 * Seitenflächen als vertikale Quads (je zwei Ray-Dreiecke). Kleinstes
 * nichtnegatives t gewinnt.
 */
export function raySlabPrism(ray: Ray, slab: PickSlab): number | null {
  const n = slab.outline.length;
  if (n < 3 || slab.zTop - slab.zBottom <= EPS) return null;
  let best = Infinity;
  const consider = (t: number | null) => {
    if (t !== null && t >= 0 && t < best) best = t;
  };
  // Deckel + Boden (horizontale Ebenen) via Punkt-in-Polygon.
  for (const y of [slab.zBottom, slab.zTop]) {
    if (Math.abs(ray.dir[1]) <= EPS) continue;
    const t = (y - ray.origin[1]) / ray.dir[1];
    if (t < 0) continue;
    const px = ray.origin[0] + t * ray.dir[0];
    const pz = ray.origin[2] + t * ray.dir[2];
    if (pointInPolyXZ(px, pz, slab.outline)) consider(t);
  }
  // Seitenwände: je Kante ein vertikales Quad (zwei Dreiecke).
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = slab.outline[j];
    const b = slab.outline[i];
    const A: Vec3 = [a[0], slab.zBottom, a[1]];
    const B: Vec3 = [b[0], slab.zBottom, b[1]];
    const C: Vec3 = [b[0], slab.zTop, b[1]];
    const D: Vec3 = [a[0], slab.zTop, a[1]];
    consider(rayTriangle(ray, A, B, C));
    consider(rayTriangle(ray, A, C, D));
  }
  return best === Infinity ? null : best;
}

/**
 * Nächstes getroffenes Bauteil (kleinstes t) über Wände + Decken, oder null.
 * Wände und Decken konkurrieren direkt über die Distanz — was näher an der
 * Kamera liegt, gewinnt.
 */
export function pickNearest(
  ray: Ray,
  walls: readonly PickWall[],
  slabs: readonly PickSlab[],
): PickHit | null {
  let hit: PickHit | null = null;
  for (const w of walls) {
    const t = rayWallBox(ray, w);
    if (t !== null && (hit === null || t < hit.t)) {
      hit = { kind: "wall", id: w.wallId, t };
    }
  }
  for (const s of slabs) {
    const t = raySlabPrism(ray, s);
    if (t !== null && (hit === null || t < hit.t)) {
      hit = { kind: "ceiling", id: s.ceilingId, t };
    }
  }
  return hit;
}
