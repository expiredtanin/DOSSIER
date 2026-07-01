// Raum-Erkennung — geschlossene Raum-Umrisse aus Wandsegmenten ableiten.
//
// Zwei komplementäre Ansätze:
//
//   1. detectRooms(walls) — baut die planare Anordnung (Arrangement) der Wand-
//      MITTELLINIEN, schneidet alle Kanten an ihren Kreuzungen, snappt kleine
//      Lücken zu und extrahiert die minimalen geschlossenen Maschen (Faces) des
//      Graphen über das „next edge counter-clockwise"-Verfahren (half-edge face
//      tracing). Die unbeschränkte Aussenmasche wird verworfen. Für jede innere
//      Masche wird die lichte Innenkontur berechnet, indem die Masche um die
//      halbe Wanddicke nach innen versetzt wird (Miter-Offset).
//
//   2. roomFromPointInside(point, wallFaces) — klick-in-Raum-Fallback: umläuft
//      ausgehend von einem Saatpunkt die den Punkt einschliessende Masche direkt
//      (gap-tolerant, wie die meisten CAD-Werkzeuge für „Raum durch Klick"). Er
//      liefert die lichte Innenkontur der angeklickten Zelle.
//
// Grenzen (ehrlich): Der Arrangement-Ansatz behandelt Wände als 1D-Mittellinien;
// überlappende/kollineare Doppelwände oder gekrümmte Wände werden nicht speziell
// aufgelöst. Lücken unterhalb `gapTol` werden per Endpunkt-Snapping geschlossen;
// grössere Öffnungen (Türen) müssen als geschlossen modelliert oder vom Aufrufer
// überbrückt werden. Der Offset nach innen nutzt Miter-Joins ohne Selbstschnitt-
// Heilung — für orthogonale/konvexe Grundrisse (der Normalfall) exakt, bei sehr
// spitzen einspringenden Ecken approximativ.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md). Einheit: METER.

import type { Vec2 } from "../model/types";
import { signedArea, polygonArea } from "./roomArea";

/** Ein Wandsegment: Mittellinie a→b mit Dicke (beidseitig je thickness/2). */
export interface WallSegment {
  a: Vec2;
  b: Vec2;
  thickness: number;
}

/** Parameter der Raum-Erkennung. */
export interface DetectRoomsOptions {
  /** Lücken/Endpunkt-Abstände ≤ gapTol (m) werden zusammengeschnappt. Default 0.05. */
  gapTol?: number;
  /** Kleinste als Raum akzeptierte Fläche (m²). Default 0.05. */
  minArea?: number;
  /**
   * true (Default): Maschen um halbe Wanddicke nach innen versetzen, sodass die
   * zurückgegebenen Loops die LICHTE Innenkontur sind. false: Wand-Mittellinien-
   * Maschen (roh) zurückgeben.
   */
  offsetToInner?: boolean;
}

// ── Vektorhelfer (lokal, ohne Fremdabhängigkeit) ─────────────────────────────

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
const len = (a: Vec2): number => Math.hypot(a.x, a.y);
const normalize = (a: Vec2): Vec2 => {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};
/** Linke Normale (90° gegen den Uhrzeigersinn). */
const leftNormal = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

const EPS = 1e-9;

// ── Planarer Graph (Knoten + ungerichtete Kanten) ────────────────────────────

interface Node {
  p: Vec2;
}

interface UEdge {
  u: number; // Knotenindex
  v: number; // Knotenindex
}

/**
 * Baut aus den Wand-Mittellinien einen planaren Graphen: Endpunkte werden mit
 * Toleranz `snap` verschmolzen, jedes Segment an allen echten Kreuzungen mit
 * anderen Segmenten unterteilt, kollineare Duplikate entfernt.
 */
function buildPlanarGraph(
  segments: { a: Vec2; b: Vec2 }[],
  snap: number,
): { nodes: Node[]; edges: UEdge[] } {
  const nodes: Node[] = [];

  // Knoten mit Snapping-Toleranz einfügen (linearer Scan; für Grundriss-Grössen
  // ausreichend).
  const addNode = (p: Vec2): number => {
    for (let i = 0; i < nodes.length; i++) {
      if (dist(nodes[i].p, p) <= snap) return i;
    }
    nodes.push({ p: { x: p.x, y: p.y } });
    return nodes.length - 1;
  };

  // Für jedes Segment: alle Split-Parameter t sammeln (Endpunkte + Kreuzungen).
  const raw = segments
    .map((s) => ({ a: s.a, b: s.b }))
    .filter((s) => dist(s.a, s.b) > snap);

  interface Split {
    t: number;
    p: Vec2;
  }

  const perSegment: Split[][] = raw.map((s) => [
    { t: 0, p: s.a },
    { t: 1, p: s.b },
  ]);

  for (let i = 0; i < raw.length; i++) {
    for (let j = i + 1; j < raw.length; j++) {
      const A = raw[i];
      const B = raw[j];
      const da = sub(A.b, A.a);
      const db = sub(B.b, B.a);
      const denom = cross(da, db);
      if (Math.abs(denom) < EPS) continue; // parallel/kollinear
      const t = cross(sub(B.a, A.a), db) / denom;
      const s = cross(sub(B.a, A.a), da) / denom;
      // Echter innerer Schnitt (Endpunkt-Berührungen sind bereits Knoten).
      const tolT = snap / Math.max(len(da), 1e-9);
      const tolS = snap / Math.max(len(db), 1e-9);
      if (t < -tolT || t > 1 + tolT || s < -tolS || s > 1 + tolS) continue;
      const p = add(A.a, scale(da, t));
      perSegment[i].push({ t, p });
      perSegment[j].push({ t: s, p });
    }
  }

  const edgeSet = new Set<string>();
  const edges: UEdge[] = [];
  const pushEdge = (u: number, v: number) => {
    if (u === v) return;
    const key = u < v ? `${u}_${v}` : `${v}_${u}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ u, v });
  };

  for (let i = 0; i < raw.length; i++) {
    const splits = perSegment[i].sort((p, q) => p.t - q.t);
    let prev = -1;
    let prevT = -Infinity;
    for (const sp of splits) {
      if (sp.t - prevT < 1e-9 && prev >= 0) continue;
      const idx = addNode(sp.p);
      if (prev >= 0 && idx !== prev) pushEdge(prev, idx);
      prev = idx;
      prevT = sp.t;
    }
  }

  return { nodes, edges };
}

// ── Face-Extraktion über gerichtete Halbkanten ───────────────────────────────

interface HalfEdge {
  from: number;
  to: number;
  /** Ausgangswinkel from→to (für die CCW-Sortierung an jedem Knoten). */
  angle: number;
  used: boolean;
}

/**
 * Extrahiert die minimalen geschlossenen Maschen (Faces) des planaren Graphen.
 * Verfahren: jede ungerichtete Kante wird zu zwei Halbkanten. An jedem Knoten
 * werden die abgehenden Halbkanten nach Winkel sortiert. Beim Umlaufen einer
 * Masche wählt man an jedem Zielknoten stets die Halbkante, die im Uhrzeigersinn
 * unmittelbar VOR der eingehenden (umgekehrten) liegt — das „next edge"-Kriterium
 * für konsistente Face-Umläufe. Jede Halbkante gehört zu genau einer Masche.
 * Die (einzige) Masche mit positiver Fläche und maximaler |Fläche|, deren Umlauf
 * die anderen umschliesst, ist die Aussenmasche und wird verworfen.
 */
function extractFaces(nodes: Node[], edges: UEdge[]): number[][] {
  // Adjazenz: je Knoten die Indizes seiner abgehenden Halbkanten.
  const halfEdges: HalfEdge[] = [];
  const outgoing: number[][] = nodes.map(() => []);

  const angleOf = (from: number, to: number): number => {
    const d = sub(nodes[to].p, nodes[from].p);
    return Math.atan2(d.y, d.x);
  };

  for (const e of edges) {
    const h1 = halfEdges.length;
    halfEdges.push({ from: e.u, to: e.v, angle: angleOf(e.u, e.v), used: false });
    outgoing[e.u].push(h1);
    const h2 = halfEdges.length;
    halfEdges.push({ from: e.v, to: e.u, angle: angleOf(e.v, e.u), used: false });
    outgoing[e.v].push(h2);
  }

  // Abgehende Halbkanten je Knoten nach Winkel sortieren.
  for (const list of outgoing) {
    list.sort((h1, h2) => halfEdges[h1].angle - halfEdges[h2].angle);
  }
  // Positionsindex je Halbkante in der sortierten Liste seines from-Knotens.
  const posInList = new Map<number, number>();
  for (const list of outgoing) {
    for (let k = 0; k < list.length; k++) posInList.set(list[k], k);
  }

  // Zwilling (umgekehrte Halbkante): Paare liegen benachbart (2i, 2i+1).
  const twin = (h: number): number => (h % 2 === 0 ? h + 1 : h - 1);

  const faces: number[][] = [];

  for (let start = 0; start < halfEdges.length; start++) {
    if (halfEdges[start].used) continue;
    const faceNodes: number[] = [];
    let h = start;
    let guard = 0;
    const maxSteps = halfEdges.length + 2;
    do {
      halfEdges[h].used = true;
      faceNodes.push(halfEdges[h].from);
      // An to = halfEdges[h].to die nächste Halbkante wählen: rund um den Knoten
      // die im Uhrzeigersinn nächste NACH dem Zwilling der eingehenden Kante.
      const tw = twin(h);
      const list = outgoing[halfEdges[h].to];
      const pos = posInList.get(tw)!;
      const nextPos = (pos - 1 + list.length) % list.length; // im Uhrzeigersinn davor
      h = list[nextPos];
      guard++;
    } while (h !== start && guard < maxSteps);
    if (faceNodes.length >= 3) faces.push(faceNodes);
  }

  // Aussenmasche(n) verwerfen: eine Masche ist „innen", wenn sie CCW orientiert
  // ist (positive Shoelace-Fläche). Die Aussenmasche läuft CW (negative Fläche).
  const inner: number[][] = [];
  for (const f of faces) {
    const poly = f.map((n) => nodes[n].p);
    if (signedArea(poly) > EPS) inner.push(f);
  }
  return inner;
}

// ── Innen-Offset einer Masche (halbe Wanddicke) ──────────────────────────────

/**
 * Versetzt ein CCW-Polygon um `d` nach innen (jede Kante um d nach rechts, da
 * CCW → Innenseite rechts der Laufrichtung? Nein: bei CCW liegt das Innere LINKS.
 * Wir verschieben daher jede Kante um d in Richtung Inneres = linke Normale) via
 * Miter-Join. Bei ungültigem Schnitt (fast parallel) wird der verschobene Eck-
 * punkt direkt genommen.
 */
function offsetInward(poly: Vec2[], d: number): Vec2[] {
  const n = poly.length;
  if (n < 3 || d <= 0) return poly.slice();
  // Sicherstellen: CCW (Inneres links). Falls CW, umdrehen.
  const pts = signedArea(poly) > 0 ? poly : poly.slice().reverse();
  // Verschobene Kanten (Inneres liegt links → linke Normale zeigt nach innen).
  const shifted: { p: Vec2; dir: Vec2 }[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dir = normalize(sub(b, a));
    const nrm = leftNormal(dir); // zeigt ins Innere bei CCW
    shifted.push({ p: add(a, scale(nrm, d)), dir });
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = shifted[(i - 1 + n) % n];
    const curr = shifted[i];
    // Schnitt der beiden verschobenen (unendlichen) Geraden.
    const denom = cross(prev.dir, curr.dir);
    if (Math.abs(denom) < 1e-9) {
      out.push(curr.p); // (nahezu) kollinear → Startpunkt der aktuellen Kante
      continue;
    }
    const t = cross(sub(curr.p, prev.p), curr.dir) / denom;
    out.push(add(prev.p, scale(prev.dir, t)));
  }
  return out;
}

/** Dedupliziert aufeinanderfolgende (nahezu) gleiche Punkte im Ring. */
function dedupeRing(pts: Vec2[], tol = 1e-7): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > tol) out.push(p);
  }
  if (out.length > 1 && dist(out[0], out[out.length - 1]) <= tol) out.pop();
  return out;
}

/** Durchschnittliche Wanddicke der Segmente, die eine Kante bilden (Fallback 0). */
function averageThickness(walls: WallSegment[]): number {
  if (walls.length === 0) return 0;
  let s = 0;
  for (const w of walls) s += w.thickness;
  return s / walls.length;
}

// ── Öffentliche API ──────────────────────────────────────────────────────────

/**
 * Erkennt geschlossene Räume aus einer Menge von Wandsegmenten (Mittellinien
 * mit Dicke). Liefert die lichten Innen-Umrisse (Vec2[] je Raum), CCW orientiert.
 *
 * Ablauf: planarer Graph aus Mittellinien → Face-Extraktion → Aussenmasche
 * verwerfen → jede innere Masche um halbe (mittlere) Wanddicke nach innen
 * versetzen. Kleine Lücken werden über `gapTol` zusammengeschnappt.
 */
export function detectRooms(
  walls: WallSegment[],
  options: DetectRoomsOptions = {},
): Vec2[][] {
  const gapTol = options.gapTol ?? 0.05;
  const minArea = options.minArea ?? 0.05;
  const offsetToInner = options.offsetToInner ?? true;

  if (walls.length < 3) return [];

  const { nodes, edges } = buildPlanarGraph(
    walls.map((w) => ({ a: w.a, b: w.b })),
    gapTol,
  );
  if (edges.length < 3) return [];

  const faces = extractFaces(nodes, edges);
  const half = averageThickness(walls) / 2;

  const rooms: Vec2[][] = [];
  for (const f of faces) {
    let poly = f.map((n) => nodes[n].p);
    poly = dedupeRing(poly);
    if (poly.length < 3) continue;
    if (offsetToInner && half > 0) {
      poly = dedupeRing(offsetInward(poly, half));
      if (poly.length < 3) continue;
    }
    if (polygonArea(poly) < minArea) continue;
    // Kanonisch CCW zurückgeben.
    if (signedArea(poly) < 0) poly = poly.reverse();
    rooms.push(poly);
  }
  return rooms;
}

// ── Klick-in-Raum: Umlauf-Tracer um einen Saatpunkt ──────────────────────────

/** Eine Wand-Innenfläche (Face) als gerichtete/ungerichtete Strecke. */
export interface WallFace {
  a: Vec2;
  b: Vec2;
}

/**
 * Prüft, ob ein Punkt in einem Polygon liegt (Ray-Casting, ungerade Kreuzungen).
 */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersects =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y + 0) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Klick-in-Raum-Fallback: findet die Masche, die den Saatpunkt einschliesst, und
 * gibt ihren lichten Innen-Umriss zurück (oder null, wenn der Punkt in keiner
 * geschlossenen Zelle liegt). Robust gegen T-Stösse; kleine Lücken werden über
 * `gapTol` geschlossen. Nutzt intern dieselbe Arrangement-/Face-Extraktion und
 * wählt die Masche mit kleinster Fläche, die den Punkt enthält (die unmittelbar
 * umgebende Zelle statt einer grösseren umschliessenden).
 */
export function roomFromPointInside(
  point: Vec2,
  walls: WallSegment[],
  options: DetectRoomsOptions = {},
): Vec2[] | null {
  const gapTol = options.gapTol ?? 0.05;
  const offsetToInner = options.offsetToInner ?? true;

  if (walls.length < 3) return null;

  const { nodes, edges } = buildPlanarGraph(
    walls.map((w) => ({ a: w.a, b: w.b })),
    gapTol,
  );
  if (edges.length < 3) return null;

  const faces = extractFaces(nodes, edges);
  const half = averageThickness(walls) / 2;

  let best: Vec2[] | null = null;
  let bestArea = Infinity;

  for (const f of faces) {
    let raw = dedupeRing(f.map((n) => nodes[n].p));
    if (raw.length < 3) continue;
    // Test gegen die ROHE Mittellinien-Masche (schliesst den Klickpunkt weiter ein).
    if (!pointInPolygon(point, raw)) continue;
    const area = polygonArea(raw);
    if (area >= bestArea) continue;
    let inner = raw;
    if (offsetToInner && half > 0) {
      inner = dedupeRing(offsetInward(raw, half));
      if (inner.length < 3) inner = raw;
    }
    if (signedArea(inner) < 0) inner = inner.reverse();
    best = inner;
    bestArea = area;
  }

  return best;
}

/**
 * Variante des Klick-Tracers, die direkt auf bereits berechneten Wand-INNEN-
 * FLÄCHEN (Faces) arbeitet: die Strecken bilden bereits die lichten Wandseiten.
 * Kein Innen-Offset (die Faces sind schon die Innenkontur). Für Aufrufer, die
 * die Wandflächen ohnehin vorhalten (z. B. aus dem Wand-Rendering).
 */
export function roomFromPointInsideFaces(
  point: Vec2,
  wallFaces: WallFace[],
  gapTol = 0.05,
): Vec2[] | null {
  if (wallFaces.length < 3) return null;
  const { nodes, edges } = buildPlanarGraph(
    wallFaces.map((f) => ({ a: f.a, b: f.b })),
    gapTol,
  );
  if (edges.length < 3) return null;
  const faces = extractFaces(nodes, edges);
  let best: Vec2[] | null = null;
  let bestArea = Infinity;
  for (const f of faces) {
    const poly = dedupeRing(f.map((n) => nodes[n].p));
    if (poly.length < 3) continue;
    if (!pointInPolygon(point, poly)) continue;
    const area = polygonArea(poly);
    if (area < bestArea) {
      best = signedArea(poly) < 0 ? poly.reverse() : poly;
      bestArea = area;
    }
  }
  return best;
}
