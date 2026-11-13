// [245] Begehen mit Kollision und Bodenfolge: reine Rechnung auf einer einfachen räumlichen Struktur (Raster in der
// Grundrissebene) aus den 3D-Teilen, die der Viewer ohnehin hat (Wand-Quader mit Löchern, Decken-/Tritt-Prismen,
// Netze). Ohne React und Engine, damit testbar. Kein Ray-Test gegen das ganze Modell: je Schritt nur Rasterzellen
// im Umkreis der Person.
//
// KONVENTION wie render3d: Modell (x, y, z=Höhe) → world (x, Höhe, y); Gelände und Import-Netze mit Nord-Negation
// (x, Höhe, −y) wie in `model3d/pick.rs`. Alle Zahlen hier sind world-Meter.
//
// Hindernisse sind senkrechte „Kapseln": eine Strecke in der XZ-Ebene mit Halbdicke `h` und Höhenband [y0, y1].
//  • Wand = Strecke entlang der Achse (Halbdicke = halbe Wandstärke), in Stücke ausserhalb der Löcher geteilt;
//    über und unter einem Loch bleiben Sturz bzw. Brüstung. Ein Loch bis zur Wand-UK ist eine Tür (frei),
//    ein Loch mit Brüstung ein Fenster: dort sperrt zusätzlich die Glasebene (nicht passierbar).
//  • Decken-/Trittkante = Polygonkante über [zBottom, zTop]; senkrechte Dreiecke der Netze (Stützen, Körper) ebenso.
// Böden sind die Oberseiten der Decken/Tritte (Polygon, Höhe zTop) und alle Dreiecke mit nach oben zeigender Normale
// (Gelände, Dächer, Körper).

/** Person: Radius und Körperhöhe (m); Stufen bis `STEP_UP` steigt man ohne Hindernis. */
export const PERSON_RADIUS = 0.25;
export const PERSON_HEIGHT = 1.8;
export const STEP_UP = 0.25;

const CELL = 2;
/** Mehr Zellen als das → Eintrag kommt in die Liste „gross" (immer geprüft), statt Zehntausende Zellen zu füllen. */
const MAX_CELLS_PER_ENTRY = 1024;
const EPS = 1e-6;

type V2 = readonly [number, number];
type Tri3 = readonly [number, number, number, number, number, number, number, number, number];

/** Minimalformen der Eingabe (RModel3d erfüllt sie strukturell). */
export interface WalkWall {
  start: V2;
  end: V2;
  thickness: number;
  height: number;
  baseElevation: number;
  holes?: ReadonlyArray<{ from: number; to: number; zBottom: number; zTop: number }>;
}
export interface WalkSlab {
  outline: ReadonlyArray<V2>;
  zBottom: number;
  zTop: number;
}
export interface WalkMesh {
  /** Flach (x, y, z=Höhe) in Modell-Metern. */
  positions: ReadonlyArray<number>;
  indices: ReadonlyArray<number>;
  /** `terrain`/`imported`: world-z = −y. */
  kind?: string;
}
export interface WalkModelInput {
  walls: ReadonlyArray<WalkWall>;
  slabs: ReadonlyArray<WalkSlab>;
  meshes: ReadonlyArray<WalkMesh>;
}

interface Obstacle {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Halbdicke. */
  h: number;
  y0: number;
  y1: number;
}

interface Floor {
  /** Dreieck (neun Zahlen, world) oder Polygon mit fester Höhe. */
  tri?: Tri3;
  poly?: ReadonlyArray<V2>;
  y: number;
}

const key = (ix: number, iz: number): number => (ix + 5_000_000) * 10_000_000 + (iz + 5_000_000);

/** Obergrenze für Dreiecke aus Netzen (Speicher/Bauzeit); der Rest bleibt unberücksichtigt. */
export const MAX_MESH_TRIS = 600_000;

export class WalkWorld {
  private obstacles: Obstacle[] = [];
  private floors: Floor[] = [];
  private obstacleCells = new Map<number, number[]>();
  private floorCells = new Map<number, number[]>();
  private bigObstacles: number[] = [];
  private bigFloors: number[] = [];
  /** Zahl der Dreiecke aus Netzen, die nicht mehr aufgenommen wurden. */
  skippedTris = 0;

  constructor(input: WalkModelInput) {
    for (const w of input.walls) this.addWall(w);
    for (const s of input.slabs) this.addSlab(s);
    let budget = MAX_MESH_TRIS;
    for (const m of input.meshes) {
      const n = Math.floor(m.indices.length / 3);
      if (n > budget) {
        this.skippedTris += n;
        continue;
      }
      budget -= n;
      this.addMesh(m);
    }
  }

  get obstacleCount(): number {
    return this.obstacles.length;
  }
  get floorCount(): number {
    return this.floors.length;
  }

  // ── Aufbau ─────────────────────────────────────────────────────────────────────────────────────────────────

  private addObstacle(o: Obstacle): void {
    if (!(o.y1 > o.y0) || ![o.x0, o.z0, o.x1, o.z1, o.h, o.y0, o.y1].every(Number.isFinite)) return;
    const id = this.obstacles.length;
    this.obstacles.push(o);
    const r = o.h;
    this.index(this.obstacleCells, this.bigObstacles, id, Math.min(o.x0, o.x1) - r, Math.min(o.z0, o.z1) - r, Math.max(o.x0, o.x1) + r, Math.max(o.z0, o.z1) + r);
  }

  private addFloor(f: Floor, x0: number, z0: number, x1: number, z1: number): void {
    const id = this.floors.length;
    this.floors.push(f);
    this.index(this.floorCells, this.bigFloors, id, x0, z0, x1, z1);
  }

  private index(cells: Map<number, number[]>, big: number[], id: number, x0: number, z0: number, x1: number, z1: number): void {
    const ix0 = Math.floor(x0 / CELL);
    const ix1 = Math.floor(x1 / CELL);
    const iz0 = Math.floor(z0 / CELL);
    const iz1 = Math.floor(z1 / CELL);
    if (!(Number.isFinite(ix0 + ix1 + iz0 + iz1)) || (ix1 - ix0 + 1) * (iz1 - iz0 + 1) > MAX_CELLS_PER_ENTRY) {
      big.push(id);
      return;
    }
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const k = key(ix, iz);
        const l = cells.get(k);
        if (l) l.push(id);
        else cells.set(k, [id]);
      }
    }
  }

  private addWall(w: WalkWall): void {
    const [sx, sz] = w.start;
    const [ex, ez] = w.end;
    const len = Math.hypot(ex - sx, ez - sz);
    if (!(len > EPS) || !(w.height > 0)) return;
    const ux = (ex - sx) / len;
    const uz = (ez - sz) / len;
    const h = Math.max(0, w.thickness) / 2;
    const base = w.baseElevation;
    const top = base + w.height;
    const at = (s: number): V2 => [sx + ux * s, sz + uz * s];
    const piece = (a: number, b: number, y0: number, y1: number) => {
      if (b - a < EPS || y1 - y0 < EPS) return;
      const p = at(a);
      const q = at(b);
      this.addObstacle({ x0: p[0], z0: p[1], x1: q[0], z1: q[1], h, y0, y1 });
    };
    const holes = [...(w.holes ?? [])]
      .map((o) => ({ from: Math.max(0, Math.min(o.from, o.to)), to: Math.min(len, Math.max(o.from, o.to)), zBottom: o.zBottom, zTop: o.zTop }))
      .filter((o) => o.to - o.from > EPS)
      .sort((a, b) => a.from - b.from);
    let cursor = 0;
    for (const o of holes) {
      piece(cursor, o.from, base, top);
      // Brüstung unter und Sturz über dem Loch.
      piece(o.from, o.to, base, Math.min(top, o.zBottom));
      piece(o.from, o.to, Math.max(base, o.zTop), top);
      // Fenster (Loch mit Brüstung): die Glasebene sperrt, auch wo die Brüstung niedriger als die Stufenhöhe ist.
      if (o.zBottom > base + EPS) {
        const m = (o.from + o.to) / 2;
        const half = (o.to - o.from) / 2;
        const p = at(m - half);
        const q = at(m + half);
        this.addObstacle({ x0: p[0], z0: p[1], x1: q[0], z1: q[1], h: 0.02, y0: Math.max(base, o.zBottom), y1: Math.min(top, o.zTop) });
      }
      cursor = Math.max(cursor, o.to);
    }
    piece(cursor, len, base, top);
  }

  private addSlab(s: WalkSlab): void {
    const pts = s.outline.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length < 3 || !(s.zTop >= s.zBottom)) return;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minZ = Math.min(minZ, p[1]);
      maxZ = Math.max(maxZ, p[1]);
    }
    this.addFloor({ poly: pts, y: s.zTop }, minX, minZ, maxX, maxZ);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      this.addObstacle({ x0: a[0], z0: a[1], x1: b[0], z1: b[1], h: 0, y0: s.zBottom, y1: s.zTop });
    }
  }

  private addMesh(m: WalkMesh): void {
    const flip = m.kind === "terrain" || m.kind === "imported" ? -1 : 1;
    const p = m.positions;
    const idx = m.indices;
    const vx = (i: number) => p[i * 3];
    const vy = (i: number) => p[i * 3 + 2];
    const vz = (i: number) => p[i * 3 + 1] * flip;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = idx[t];
      const b = idx[t + 1];
      const c = idx[t + 2];
      if (a * 3 + 2 >= p.length || b * 3 + 2 >= p.length || c * 3 + 2 >= p.length) continue;
      const x = [vx(a), vx(b), vx(c)];
      const y = [vy(a), vy(b), vy(c)];
      const z = [vz(a), vz(b), vz(c)];
      if (![...x, ...y, ...z].every(Number.isFinite)) continue;
      // Normale (world), Y-Anteil entscheidet: Boden, Wand oder Decke/Unterseite.
      const e1 = [x[1] - x[0], y[1] - y[0], z[1] - z[0]];
      const e2 = [x[2] - x[0], y[2] - y[0], z[2] - z[0]];
      const nx = e1[1] * e2[2] - e1[2] * e2[1];
      const ny = e1[2] * e2[0] - e1[0] * e2[2];
      const nz = e1[0] * e2[1] - e1[1] * e2[0];
      const nl = Math.hypot(nx, ny, nz);
      if (!(nl > 1e-12)) continue;
      // Das Modell ist rechtshändig (x, y, z=Höhe); in world (x, z, y) kippt die Orientierung: Betrag zählt, nicht das Vorzeichen.
      const upness = Math.abs(ny) / nl;
      if (upness > 0.5) {
        // Dreieck als Boden. Ohne Orientierung gilt jede flache Fläche als begehbar (auch Unterseiten): die Bodenabfrage
        // nimmt ohnehin nur Flächen bis Fusshöhe + Stufe, Dächer und Decken darüber bleiben aussen vor.
        this.addFloor(
          { tri: [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]], y: 0 },
          Math.min(...x),
          Math.min(...z),
          Math.max(...x),
          Math.max(...z),
        );
      } else {
        // Senkrechtes Dreieck: die zwei am weitesten entfernten Punkte in der Grundrissebene bilden die Strecke.
        let best = 0;
        let bi = 0;
        let bj = 1;
        for (const [i, j] of [[0, 1], [1, 2], [0, 2]] as const) {
          const d = Math.hypot(x[i] - x[j], z[i] - z[j]);
          if (d > best) {
            best = d;
            bi = i;
            bj = j;
          }
        }
        if (best < 1e-3) continue;
        this.addObstacle({ x0: x[bi], z0: z[bi], x1: x[bj], z1: z[bj], h: 0, y0: Math.min(...y), y1: Math.max(...y) });
      }
    }
  }

  // ── Abfragen ───────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Höhe des Bodens unter (x, z): die höchste begehbare Fläche mit Höhe ≤ `maxY`. `null`, wenn dort gar nichts liegt
   * (ausserhalb des Modells). Genau ein Ray-Test nach unten, nur gegen die Rasterzelle.
   */
  groundAt(x: number, z: number, maxY: number): number | null {
    let best: number | null = null;
    const test = (id: number) => {
      const f = this.floors[id];
      let y: number | null = null;
      if (f.poly) {
        if (pointInPoly(x, z, f.poly)) y = f.y;
      } else if (f.tri) {
        y = triHeight(f.tri, x, z);
      }
      if (y !== null && y <= maxY + EPS && (best === null || y > best)) best = y;
    };
    const cell = this.floorCells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (cell) for (const id of cell) test(id);
    for (const id of this.bigFloors) test(id);
    return best;
  }

  /**
   * Bewegung (x, z) → (x + dx, z + dz) einer Person mit den Füssen auf `feetY`. Teilschritte gegen Durchtunneln;
   * Hindernisse werden herausgeschoben, die Person gleitet also an Wänden entlang. Gibt die neue Lage zurück.
   */
  move(x: number, z: number, dx: number, dz: number, feetY: number, radius: number = PERSON_RADIUS): V2 {
    const dist = Math.hypot(dx, dz);
    if (!(dist > 0) || !Number.isFinite(dist)) return [x, z];
    const steps = Math.max(1, Math.ceil(dist / (radius * 0.6)));
    const sx = dx / steps;
    const sz = dz / steps;
    let px = x;
    let pz = z;
    for (let i = 0; i < steps; i++) {
      const prevX = px;
      const prevZ = pz;
      px += sx;
      pz += sz;
      [px, pz] = this.pushOut(px, pz, prevX, prevZ, feetY, radius);
    }
    return [px, pz];
  }

  /** Ist die Person an dieser Stelle frei (kein Hindernis im Körperband)? */
  isFree(x: number, z: number, feetY: number, radius: number = PERSON_RADIUS): boolean {
    let free = true;
    this.forNearby(x, z, radius, feetY, (o) => {
      if (segDist(x, z, o) < o.h + radius - 1e-4) free = false;
    });
    return free;
  }

  private pushOut(px0: number, pz0: number, prevX: number, prevZ: number, feetY: number, radius: number): V2 {
    let px = px0;
    let pz = pz0;
    // Mehrere Durchgänge: ein Schub kann in die nächste Wand führen (Ecke).
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      this.forNearby(px, pz, radius, feetY, (o) => {
        const [cx, cz] = closestOnSeg(px, pz, o);
        let nx = px - cx;
        let nz = pz - cz;
        const d = Math.hypot(nx, nz);
        const need = o.h + radius;
        if (d >= need - 1e-9) return;
        if (d > 1e-9) {
          nx /= d;
          nz /= d;
        } else {
          // Genau auf der Achse: zur Seite schieben, von der die Person kam.
          const ax = o.x1 - o.x0;
          const az = o.z1 - o.z0;
          const al = Math.hypot(ax, az) || 1;
          nx = -az / al;
          nz = ax / al;
          if (nx * (prevX - cx) + nz * (prevZ - cz) < 0) {
            nx = -nx;
            nz = -nz;
          }
        }
        px = cx + nx * need;
        pz = cz + nz * need;
        moved = true;
      });
      if (!moved) break;
    }
    return [px, pz];
  }

  /** Alle Hindernisse im Umkreis, deren Höhenband den Körper (Füsse + Stufe … Füsse + Körperhöhe) trifft. */
  private forNearby(x: number, z: number, radius: number, feetY: number, fn: (o: Obstacle) => void): void {
    const lo = feetY + STEP_UP + EPS;
    const hi = feetY + PERSON_HEIGHT;
    const seen = new Set<number>();
    const visit = (id: number) => {
      if (seen.has(id)) return;
      seen.add(id);
      const o = this.obstacles[id];
      if (o.y1 <= lo || o.y0 >= hi) return;
      fn(o);
    };
    const ix0 = Math.floor((x - radius - 1e-9) / CELL);
    const ix1 = Math.floor((x + radius + 1e-9) / CELL);
    const iz0 = Math.floor((z - radius - 1e-9) / CELL);
    const iz1 = Math.floor((z + radius + 1e-9) / CELL);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const l = this.obstacleCells.get(key(ix, iz));
        if (l) for (const id of l) visit(id);
      }
    }
    for (const id of this.bigObstacles) visit(id);
  }
}

// ── Geometrie ────────────────────────────────────────────────────────────────────────────────────────────────

function closestOnSeg(px: number, pz: number, o: Obstacle): V2 {
  const ax = o.x1 - o.x0;
  const az = o.z1 - o.z0;
  const l2 = ax * ax + az * az;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - o.x0) * ax + (pz - o.z0) * az) / l2)) : 0;
  return [o.x0 + ax * t, o.z0 + az * t];
}

function segDist(px: number, pz: number, o: Obstacle): number {
  const [cx, cz] = closestOnSeg(px, pz, o);
  return Math.hypot(px - cx, pz - cz);
}

/** Punkt im Polygon (gerade/ungerade Regel). */
export function pointInPoly(x: number, z: number, poly: ReadonlyArray<V2>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Höhe des Dreiecks (world) über (x, z); `null`, wenn der Punkt ausserhalb liegt (kleine Toleranz gegen Fugen). */
function triHeight(t: Tri3, x: number, z: number): number | null {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = t;
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(d) < 1e-12) return null;
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
  const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
  const l3 = 1 - l1 - l2;
  const tol = -1e-6;
  if (l1 < tol || l2 < tol || l3 < tol) return null;
  return l1 * ay + l2 * by + l3 * cy;
}
