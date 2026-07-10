// Brücken-Trick: Aussparungen (Löcher) werden über schmale Brücken in den
// Aussenring eingefügt, sodass EIN einfacher (nicht selbstüberschneidender)
// Polygonring entsteht — kein Loch-Support in den nachgelagerten Primitiven
// nötig. Ein solcher Ring ist paritätsbasiert korrekt für SVG-/Canvas-Fill,
// Scanline-Hatch, Ear-Clipping-Triangulierung UND Punkt-in-Polygon-Pick.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Vec2 } from "../model/types";
import { add, cross, sub } from "../model/geometry";

const EPS = 1e-9;

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Vorzeichenbehaftete Polygonfläche (Shoelace); >0 = CCW. */
function signedArea(pts: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Schwerpunkt (einfaches Punkt-Mittel, genügt für den Innen/Aussen-Test). */
function centroid(pts: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/** Punkt-in-Polygon (Ray-Casting). */
function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const hit =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x;
    if (hit) inside = !inside;
  }
  return inside;
}

/** Einheits-Normale nach LINKS (90° CCW) eines Vektors ({0,0} bei Nulllänge). */
function leftNormalUnit(d: Vec2): Vec2 {
  const l = Math.hypot(d.x, d.y);
  if (l < EPS) return { x: 0, y: 0 };
  return { x: -d.y / l, y: d.x / l };
}

/** Ob sich zwei Strecken ECHT (im Inneren BEIDER Strecken) schneiden. */
function segmentsProperlyCross(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
  const da = sub(a2, a1);
  const db = sub(b2, b1);
  const denom = cross(da, db);
  if (Math.abs(denom) < EPS) return false; // parallel/kollinear — blockiert nicht
  const t = cross(sub(b1, a1), db) / denom;
  const s = cross(sub(b1, a1), da) / denom;
  const e = 1e-9;
  return t > e && t < 1 - e && s > e && s < 1 - e;
}

/** Kanten eines geschlossenen Rings als [from,to]-Paare. */
function ringEdges(pts: Vec2[]): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  for (let i = 0; i < pts.length; i++) out.push([pts[i], pts[(i + 1) % pts.length]]);
  return out;
}

/** Ergebnis von {@link mergeHoles}. */
export interface MergedRing {
  /** Einfacher (nicht selbstüberschneidender) Polygonring mit eingefügten Löchern. */
  ring: Vec2[];
  /**
   * Kanten-Indizes der eingefügten Brückenkanten im Ergebnis-Ring (Kante i =
   * ring[i]→ring[(i+1)%n]) — für `noStrokeEdges` im 2D (Brückenkanten sind
   * künstliche Verbindungen, kein realer Bauteilrand, daher nicht stricheln).
   * Je Loch genau 2 Einträge.
   */
  bridgeEdges: number[];
}

/**
 * Fügt Aussparungen (`holes`) über schmale Brücken in `outline` ein, sodass
 * EIN einfacher Polygonring entsteht (der Brücken-Trick). Löcher werden
 * ITERATIV in den (wachsenden) Ring eingefügt: je Loch das nächstgelegene
 * SICHTBARE Ring-/Loch-Vertex-Paar verbinden (Sichtbarkeit = Verbindungs-
 * strecke schneidet keine andere Ring-/Loch-Kante; bei Schnitt wird das
 * nächstbeste Paar versucht). Der Loch-Ring wird dabei in GEGENLÄUFIGER
 * Orientierung zum Aussenring eingefügt (Shoelace-Fläche des Ergebnisses =
 * Aussenfläche − Lochfläche). Die Brücke besteht aus ZWEI knapp parallelen
 * Kanten (`gap`-Versatz quer zur Brückenrichtung statt identischer Punkte),
 * damit der Ring einfach (selbstüberschneidungsfrei) bleibt.
 *
 * Robustheit: degenerierte Löcher (< 3 Punkte oder ~Nullfläche) sowie Löcher,
 * deren Schwerpunkt ausserhalb des aktuellen Rings liegt (Loch ausserhalb der
 * Outline, oder Überlappung mit einem bereits eingefügten Loch), werden
 * übersprungen. Ohne Löcher (leere Liste) liefert die Funktion `outline`
 * unverändert (Kopie) mit leeren `bridgeEdges`.
 */
export function mergeHoles(outline: Vec2[], holes: Vec2[][], gap = 1e-4): MergedRing {
  if (outline.length < 3 || holes.length === 0) {
    return { ring: outline.slice(), bridgeEdges: [] };
  }
  const outerCCW = signedArea(outline) > 0;
  let ring = outline.slice();
  // Referenz-Paare der eingefügten Brückenkanten (Objekt-Identität) — damit
  // die Kanten-Indizes robust am fertigen Ring ermittelt werden können,
  // unabhängig von Index-Verschiebungen durch spätere Loch-Einfügungen.
  const bridgePairs: [Vec2, Vec2][] = [];

  for (const holeRaw of holes) {
    if (holeRaw.length < 3) continue; // degeneriert
    if (Math.abs(signedArea(holeRaw)) < 1e-9) continue; // Nulllinie/Punkt
    const c = centroid(holeRaw);
    if (!pointInPolygon(c, ring)) continue; // ausserhalb (oder bereits verlocht)

    // Loch in Gegenrichtung zum Aussenring einfügen.
    const holeCCW = signedArea(holeRaw) > 0;
    const hole = holeCCW === outerCCW ? holeRaw.slice().reverse() : holeRaw.slice();
    const m = hole.length;

    // Nächstgelegenes SICHTBARES Paar (Ring-Vertex i, Loch-Vertex j): nach
    // Abstand sortiert, erstes Paar ohne echten Schnitt mit Ring- oder
    // Loch-Kanten nehmen (Fallback: nächstbestes Paar in der Reihenfolge,
    // notfalls das absolut nächste).
    const rEdges = ringEdges(ring);
    const hEdges = ringEdges(hole);
    const candidates: { i: number; j: number; d: number }[] = [];
    for (let i = 0; i < ring.length; i++) {
      for (let j = 0; j < m; j++) candidates.push({ i, j, d: dist(ring[i], hole[j]) });
    }
    candidates.sort((a, b) => a.d - b.d);
    let chosen = candidates[0];
    for (const cand of candidates) {
      const P = ring[cand.i];
      const Q = hole[cand.j];
      const blocked =
        rEdges.some(([e1, e2]) => segmentsProperlyCross(P, Q, e1, e2)) ||
        hEdges.some(([e1, e2]) => segmentsProperlyCross(P, Q, e1, e2));
      if (!blocked) {
        chosen = cand;
        break;
      }
    }

    const { i, j } = chosen;
    const A = ring[i];
    const B = hole[j];
    const perp = leftNormalUnit(sub(B, A));
    const off: Vec2 = { x: perp.x * gap, y: perp.y * gap };
    const A1: Vec2 = add(A, off);
    const A2: Vec2 = sub(A, off);
    const B1: Vec2 = add(B, off);
    const B2: Vec2 = sub(B, off);

    const holePart: Vec2[] = [];
    for (let k = 1; k < m; k++) holePart.push(hole[(j + k) % m]);

    ring = [...ring.slice(0, i), A1, B1, ...holePart, B2, A2, ...ring.slice(i + 1)];
    bridgePairs.push([A1, B1], [B2, A2]);
  }

  const bridgeEdges: number[] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    if (bridgePairs.some(([x, y]) => x === a && y === b)) bridgeEdges.push(k);
  }

  return { ring, bridgeEdges };
}
