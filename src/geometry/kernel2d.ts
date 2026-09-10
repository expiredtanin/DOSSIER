// 2D-Geometrie-Kernel — die „echte Arbeit" für Offset / Trim / Extend / Fillet /
// Split (Rhino-artige Editierbefehle, Tier 1). Reine Funktionen über `Vec2`,
// kein externer Kernel. Baut auf den Helfern in `../model/geometry` auf.
//
// Konvention: Polylinien sind `Vec2[]`; `closed` heißt, die letzte Kante geht
// von pts[n-1] zu pts[0] (der Schlusspunkt wird NICHT dupliziert). Offsets sind
// vorzeichenbehaftet: positiv = nach LINKS bezogen auf die Laufrichtung
// (`leftNormal`-Konvention des Projekts), negativ = nach rechts.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Vec2 } from "../model/types";
import {
  add,
  cross,
  leftNormal,
  len,
  lineIntersect,
  normalize,
  scale,
  sub,
} from "../model/geometry";
import { bulgeArc, bulgeBetweenAngles } from "./bulge";

/** Numerische Toleranz (Meter) für Schnitt-/Gleichheitstests. */
export const EPS = 1e-7;

const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const dist = (a: Vec2, b: Vec2): number => len(sub(a, b));

/** Punkt-Gleichheit innerhalb Toleranz. */
export function vecEqual(a: Vec2, b: Vec2, eps = EPS): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

// ── Punkt/Strecke ────────────────────────────────────────────────────────────

/** Projektionsparameter t von p auf die Gerade a→b (nicht geklemmt). */
export function projectParam(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < EPS) return 0;
  return dot(sub(p, a), ab) / l2;
}

/** Nächster Punkt auf der STRECKE a→b zu p (t auf [0,1] geklemmt). */
export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const t = Math.max(0, Math.min(1, projectParam(p, a, b)));
  return add(a, scale(sub(b, a), t));
}

/** Abstand von p zur Strecke a→b. */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  return dist(p, closestPointOnSegment(p, a, b));
}

// ── Schnitt ──────────────────────────────────────────────────────────────────

/** Ergebnis eines Strecken-/Linienschnitts. */
export interface Hit {
  point: Vec2;
  /** Parameter auf der ersten Strecke (0 = a1, 1 = a2). */
  t: number;
  /** Parameter auf der zweiten Strecke (0 = b1, 1 = b2). */
  s: number;
}

/**
 * Schnitt zweier STRECKEN a1→a2 und b1→b2. Liefert den Schnittpunkt nur, wenn er
 * auf BEIDEN Strecken liegt (t,s ∈ [-eps, 1+eps]); sonst null. Parallel → null.
 */
export function segmentIntersect(
  a1: Vec2,
  a2: Vec2,
  b1: Vec2,
  b2: Vec2,
  eps = EPS,
): Hit | null {
  const da = sub(a2, a1);
  const db = sub(b2, b1);
  const denom = cross(da, db);
  if (Math.abs(denom) < EPS) return null; // parallel/kollinear
  const t = cross(sub(b1, a1), db) / denom;
  const s = cross(sub(b1, a1), da) / denom;
  if (t < -eps || t > 1 + eps || s < -eps || s > 1 + eps) return null;
  return { point: add(a1, scale(da, t)), t, s };
}

/**
 * Schnitt der unendlichen GERADE durch a1→a2 mit der STRECKE b1→b2 (für Extend/
 * Trim gegen einen Schneider): Schnittpunkt muss auf der Strecke b liegen
 * (s ∈ [0,1]), t (auf a) ist frei. Null bei parallel / kein Treffer auf b.
 */
export function lineSegmentIntersect(
  a1: Vec2,
  a2: Vec2,
  b1: Vec2,
  b2: Vec2,
  eps = EPS,
): Hit | null {
  const da = sub(a2, a1);
  const db = sub(b2, b1);
  const denom = cross(da, db);
  if (Math.abs(denom) < EPS) return null;
  const t = cross(sub(b1, a1), db) / denom;
  const s = cross(sub(b1, a1), da) / denom;
  if (s < -eps || s > 1 + eps) return null;
  return { point: add(a1, scale(da, t)), t, s };
}

/** Kanten einer Polylinie als [from,to]-Paare (Schlusskante bei `closed`). */
export function polylineEdges(pts: Vec2[], closed: boolean): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  for (let i = 0; i < pts.length - 1; i++) out.push([pts[i], pts[i + 1]]);
  if (closed && pts.length > 2) out.push([pts[pts.length - 1], pts[0]]);
  return out;
}

/**
 * Alle Schnittpunkte einer STRECKE a1→a2 mit den Kanten einer Polylinie, nach
 * Parameter t auf der Strecke sortiert (für Trim/Split). Endpunkt-Duplikate
 * (gleicher Punkt aufeinanderfolgender Kanten) werden zusammengefasst.
 */
export function segmentPolylineHits(
  a1: Vec2,
  a2: Vec2,
  pts: Vec2[],
  closed: boolean,
): Hit[] {
  const hits: Hit[] = [];
  for (const [b1, b2] of polylineEdges(pts, closed)) {
    const h = segmentIntersect(a1, a2, b1, b2);
    if (h) hits.push(h);
  }
  hits.sort((p, q) => p.t - q.t);
  const dedup: Hit[] = [];
  for (const h of hits) {
    if (dedup.length === 0 || Math.abs(dedup[dedup.length - 1].t - h.t) > 1e-6) {
      dedup.push(h);
    }
  }
  return dedup;
}

// ── Offset (DAS Architektur-Primitiv) ───────────────────────────────────────

/** Offset einer einzelnen Strecke um `d` (links positiv). */
export function offsetSegment(a: Vec2, b: Vec2, d: number): [Vec2, Vec2] {
  const n = leftNormal(normalize(sub(b, a)));
  const off = scale(n, d);
  return [add(a, off), add(b, off)];
}

/**
 * Offset einer Polylinie um `d` (links positiv) mit GEHRUNG (miter): jede Kante
 * wird parallel verschoben, benachbarte verschobene Kanten werden geschnitten.
 * Bei (nahezu) geraden/parallelen Nachbarn wird der verschobene Endpunkt direkt
 * genommen. Funktioniert für offene und geschlossene Polylinien; degenerierte
 * (zu kurze) Kanten werden übersprungen. Selbstüberschneidungen bei starkem
 * Offset werden NICHT bereinigt (genügt für den Architektur-Workflow; ein
 * vollständiger Polygon-Offset mit Selbstschnitt-Heilung wäre Tier-2-Arbeit).
 */
export function offsetPolyline(pts: Vec2[], d: number, closed: boolean): Vec2[] {
  // Auf signifikante Kanten reduzieren (Duplikate verwerfen).
  const clean: Vec2[] = [];
  for (const p of pts) {
    if (clean.length === 0 || dist(clean[clean.length - 1], p) > EPS) clean.push(p);
  }
  if (closed && clean.length > 1 && dist(clean[0], clean[clean.length - 1]) <= EPS) {
    clean.pop();
  }
  const n = clean.length;
  if (n < 2) return [...pts];

  const edges = polylineEdges(clean, closed).map(([a, b]) => offsetSegment(a, b, d));
  if (edges.length === 0) return [...pts];

  const result: Vec2[] = [];

  // Hilfsfunktion: Schnitt zweier (verschobener) Kanten als unendliche Geraden.
  const join = (e1: [Vec2, Vec2], e2: [Vec2, Vec2], fallback: Vec2): Vec2 => {
    const d1 = sub(e1[1], e1[0]);
    const d2 = sub(e2[1], e2[0]);
    const p = lineIntersect(e1[0], d1, e2[0], d2);
    return p ?? fallback;
  };

  if (!closed) {
    // Offener Zug: erster Punkt = Start der ersten Kante; innere Punkte =
    // Schnitt aufeinanderfolgender Kanten; letzter Punkt = Ende der letzten Kante.
    result.push(edges[0][0]);
    for (let i = 0; i < edges.length - 1; i++) {
      result.push(join(edges[i], edges[i + 1], edges[i][1]));
    }
    result.push(edges[edges.length - 1][1]);
    return result;
  }

  // Geschlossen: jeder Ausgabepunkt = Schnitt von Kante i mit Kante i+1 (zyklisch).
  for (let i = 0; i < edges.length; i++) {
    const prev = edges[(i - 1 + edges.length) % edges.length];
    const curr = edges[i];
    result.push(join(prev, curr, curr[0]));
  }
  return result;
}

// ── Offset MIT Bogen-Segmenten (bulge) ──────────────────────────────────────

/** Eine rohe Offset-Kante: Gerade (`arc: null`) oder konzentrischer Bogen. */
interface OffsetEdge {
  a: Vec2;
  b: Vec2;
  arc: { center: Vec2; r: number; sweepSign: 1 | -1 } | null;
}

/** Offset einer einzelnen Kante (Gerade ODER Bogen-Segment) um `d`. */
function offsetEdgeFor(a: Vec2, b: Vec2, bulgeVal: number | undefined, d: number): OffsetEdge {
  const arc = bulgeVal !== undefined ? bulgeArc(a, b, bulgeVal) : null;
  if (!arc) {
    const [oa, ob] = offsetSegment(a, b, d);
    return { a: oa, b: ob, arc: null };
  }
  const sweepSign: 1 | -1 = arc.sweep >= 0 ? 1 : -1;
  // Tangentenrichtung d/dθ(cosθ,sinθ) = (−sinθ,cosθ) ist bei steigendem θ (CCW,
  // sweepSign=+1) exakt die um 90° CCW gedrehte Radius-Richtung ⇒ „links" (+d)
  // zeigt nach INNEN (Radius sinkt). Bei CW (sweepSign=−1) ist es umgekehrt.
  const newR = Math.max(0.001, arc.r - d * sweepSign);
  const oa = { x: arc.center.x + newR * Math.cos(arc.a0), y: arc.center.y + newR * Math.sin(arc.a0) };
  const ob = { x: arc.center.x + newR * Math.cos(arc.a1), y: arc.center.y + newR * Math.sin(arc.a1) };
  return { a: oa, b: ob, arc: { center: arc.center, r: newR, sweepSign } };
}

/** Kandidat aus `cands`, der `fallback` am nächsten liegt (oder `null`, wenn leer). */
function nearestTo(cands: Vec2[], fallback: Vec2): Vec2 | null {
  if (cands.length === 0) return null;
  let best = cands[0];
  let bestD = dist(best, fallback);
  for (let i = 1; i < cands.length; i++) {
    const dd = dist(cands[i], fallback);
    if (dd < bestD) { bestD = dd; best = cands[i]; }
  }
  return best;
}

/** Schnittpunkt zweier Offset-Kanten (Gerade↔Gerade/Gerade↔Bogen/Bogen↔Bogen) für die Gehrung. */
function joinOffsetEdges(e1: OffsetEdge, e2: OffsetEdge, fallback: Vec2): Vec2 {
  if (!e1.arc && !e2.arc) {
    const d1 = sub(e1.b, e1.a);
    const d2 = sub(e2.b, e2.a);
    return lineIntersect(e1.a, d1, e2.a, d2) ?? fallback;
  }
  if (e1.arc && !e2.arc) {
    return nearestTo(lineCircleIntersect(e2.a, e2.b, e1.arc.center, e1.arc.r), fallback) ?? fallback;
  }
  if (!e1.arc && e2.arc) {
    return nearestTo(lineCircleIntersect(e1.a, e1.b, e2.arc.center, e2.arc.r), fallback) ?? fallback;
  }
  return nearestTo(circleCircleIntersect(e1.arc!.center, e1.arc!.r, e2.arc!.center, e2.arc!.r), fallback) ?? fallback;
}

const angleOf = (center: Vec2, p: Vec2): number => Math.atan2(p.y - center.y, p.x - center.x);

/**
 * Offset einer Polylinie MIT Bogen-Segmenten (`bulge`, s. `geometry/bulge.ts`)
 * um `d` (links positiv). Ein Bogen-Segment bleibt konzentrisch (gleicher
 * Mittelpunkt/Winkelbereich, s. `offsetEdgeFor`) — nur der Radius ändert sich;
 * der bulge-WERT selbst bleibt beim reinen Offsetten unverändert (er kodiert
 * nur den Öffnungswinkel, nicht den Radius) — wird aber an den Nahtstellen aus
 * den TATSÄCHLICHEN (durch die Gehrung ggf. verschobenen) Endpunkt-Winkeln neu
 * hergeleitet (`bulgeBetweenAngles`), sonst stimmt die Krümmung nicht mehr exakt.
 * Nachbar-Kanten werden wie bei `offsetPolyline` auf Gehrung (miter) geschnitten
 * (`joinOffsetEdges`, bei Bogen-Beteiligung per Geraden↔Kreis-/Kreis↔Kreis-
 * Schnitt, nächstgelegener Kandidat zum Fallback-Punkt gewinnt).
 */
export function offsetPolylineWithBulge(
  pts: Vec2[],
  bulge: (number | undefined)[] | undefined,
  d: number,
  closed: boolean,
): { pts: Vec2[]; bulge: number[] } {
  const n = pts.length;
  if (n < 2) return { pts: pts.slice(), bulge: [] };
  const edgeCount = closed ? n : n - 1;
  const edges: OffsetEdge[] = [];
  for (let i = 0; i < edgeCount; i++) {
    edges.push(offsetEdgeFor(pts[i], pts[(i + 1) % n], bulge?.[i], d));
  }

  const verts: Vec2[] = [];
  if (!closed) {
    verts.push(edges[0].a);
    for (let i = 0; i < edges.length - 1; i++) {
      verts.push(joinOffsetEdges(edges[i], edges[i + 1], edges[i].b));
    }
    verts.push(edges[edges.length - 1].b);
  } else {
    for (let i = 0; i < edges.length; i++) {
      const prev = edges[(i - 1 + edges.length) % edges.length];
      const curr = edges[i];
      verts.push(joinOffsetEdges(prev, curr, curr.a));
    }
  }

  const outBulge: number[] = new Array(edgeCount).fill(0);
  for (let i = 0; i < edgeCount; i++) {
    const e = edges[i];
    if (!e.arc) continue;
    const vStart = verts[i];
    const vEnd = closed ? verts[(i + 1) % edgeCount] : verts[i + 1];
    const aFrom = angleOf(e.arc.center, vStart);
    const aTo = angleOf(e.arc.center, vEnd);
    outBulge[i] = bulgeBetweenAngles(e.arc.center, e.arc.r, aFrom, aTo, e.arc.sweepSign);
  }

  return { pts: verts, bulge: outBulge };
}

// ── Trim / Split ─────────────────────────────────────────────────────────────

/**
 * Schneidet eine STRECKE seg=[a1,a2] an allen Schnittpunkten mit den Schneider-
 * Kurven (Polylinien) und liefert die resultierenden Teilstrecken. `cutters`
 * sind Polylinien (jede mit `closed`-Flag). Reine Geometrie; welche Teile
 * behalten/verworfen werden, entscheidet der Aufrufer (z. B. Trim verwirft das
 * Stück, das den Pick-Punkt enthält — siehe {@link trimSegment}).
 */
export function splitSegmentByCutters(
  a1: Vec2,
  a2: Vec2,
  cutters: { pts: Vec2[]; closed: boolean }[],
): [Vec2, Vec2][] {
  const ts: number[] = [0, 1];
  for (const c of cutters) {
    for (const h of segmentPolylineHits(a1, a2, c.pts, c.closed)) {
      if (h.t > EPS && h.t < 1 - EPS) ts.push(h.t);
    }
  }
  ts.sort((p, q) => p - q);
  const da = sub(a2, a1);
  const pieces: [Vec2, Vec2][] = [];
  for (let i = 0; i < ts.length - 1; i++) {
    if (ts[i + 1] - ts[i] < 1e-6) continue;
    pieces.push([add(a1, scale(da, ts[i])), add(a1, scale(da, ts[i + 1]))]);
  }
  return pieces;
}

/**
 * Trim: schneidet seg an den Cuttern und VERWIRFT das Teilstück, das `pick`
 * am nächsten liegt (das angeklickte „wegzuschneidende" Stück). Liefert die
 * verbleibenden Teilstücke (0..n).
 */
export function trimSegment(
  a1: Vec2,
  a2: Vec2,
  cutters: { pts: Vec2[]; closed: boolean }[],
  pick: Vec2,
): [Vec2, Vec2][] {
  const pieces = splitSegmentByCutters(a1, a2, cutters);
  if (pieces.length <= 1) return pieces;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pieces.length; i++) {
    const d = pointSegmentDistance(pick, pieces[i][0], pieces[i][1]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return pieces.filter((_, i) => i !== best);
}

/**
 * Quick-Trim einer ganzen Kurve (offen ODER geschlossen) an einem Klickpunkt.
 * Die Kurve `pts`/`closed` wird an ALLEN Schnittpunkten mit den Cuttern in
 * Bögen zerlegt; der Bogen, der `pick` am nächsten liegt (das angeklickte „weg-
 * zuschneidende" Stück), wird ENTFERNT. Liefert die verbleibenden Ketten als
 * `{pts, closed}`-Liste (0..n Stücke):
 *   • OFFEN: der getroffene Bogen fällt weg → 0, 1 oder 2 offene Reststücke.
 *   • GESCHLOSSEN: der Ring wird am Schnitt aufgetrennt; das angeklickte Stück
 *     entfällt → genau ein offenes Reststück (oder leer, wenn alles entfällt).
 * Ohne Schnitt (oder nur randständige) bleibt die Kurve unverändert (eine Kette).
 */
export function trimPolyline(
  pts: Vec2[],
  closed: boolean,
  cutters: { pts: Vec2[]; closed: boolean }[],
  pick: Vec2,
): { pts: Vec2[]; closed: boolean }[] {
  const edges = polylineEdges(pts, closed);
  if (edges.length === 0) return [{ pts: pts.slice(), closed }];

  // Schnittpunkte je Kante (innen, t ∈ (0,1)) als globale „Knoten" sammeln —
  // beschrieben durch (edgeIndex, t) und in Kettenreihenfolge sortiert.
  interface Cut {
    edge: number;
    t: number;
    point: Vec2;
  }
  const cuts: Cut[] = [];
  for (let ei = 0; ei < edges.length; ei++) {
    const [a1, a2] = edges[ei];
    for (const c of cutters) {
      for (const h of segmentPolylineHits(a1, a2, c.pts, c.closed)) {
        if (h.t > EPS && h.t < 1 - EPS) {
          cuts.push({ edge: ei, t: h.t, point: h.point });
        }
      }
    }
  }
  cuts.sort((p, q) => (p.edge - q.edge) || (p.t - q.t));
  // Dedup koinzidenter Schnitte (gleiche Kante+t).
  const cut: Cut[] = [];
  for (const h of cuts) {
    const prev = cut[cut.length - 1];
    if (prev && prev.edge === h.edge && Math.abs(prev.t - h.t) < 1e-6) continue;
    cut.push(h);
  }
  if (cut.length === 0) return [{ pts: pts.slice(), closed }];

  // Hilfsfunktion: Kette von Knoten X (auf Kante eX, tX) zu Knoten Y entlang der
  // Kurve (vorwärts in Kantenrichtung) als Punktliste materialisieren.
  const span = (eX: number, pX: Vec2, eY: number, pY: Vec2): Vec2[] => {
    const out: Vec2[] = [pX];
    let e = eX;
    // Über die Vertices NACH dem Startknoten bis zum Endknoten laufen.
    // Anzahl Kanten (modular über die Kettenlänge), damit auch der Wrap bei
    // geschlossenen Kurven funktioniert.
    const total = edges.length;
    let steps = 0;
    while (steps <= total) {
      if (e === eY) break;
      // Endpunkt der aktuellen Kante hinzufügen, dann zur nächsten Kante.
      out.push(edges[e][1]);
      e = (e + 1) % total;
      steps++;
    }
    out.push(pY);
    return dedupeConsecutive(out);
  };

  if (!closed) {
    // Offen: der Pick liegt zwischen zwei Knoten ODER zwischen einem Knoten und
    // einem Element-Ende. Wir finden das Intervall [lo, hi] der Knoten, die den
    // Pick einklammern (lo = letzter Knoten vor dem Pick, hi = erster danach),
    // bzw. das Element-Ende, wenn einseitig kein Schnitt liegt.
    const pickPos = nearestParamOnChain(edges, pick); // globaler Lauf-Param
    const cutPos = cut.map((c) => c.edge + c.t);
    let loIdx = -1;
    let hiIdx = cut.length;
    for (let i = 0; i < cut.length; i++) {
      if (cutPos[i] <= pickPos) loIdx = i;
      else { hiIdx = i; break; }
    }
    // Reststück A: Anfang … loIdx-Knoten. Reststück B: hiIdx-Knoten … Ende.
    const result: { pts: Vec2[]; closed: boolean }[] = [];
    if (loIdx >= 0) {
      const c = cut[loIdx];
      const head = pts.slice(0, c.edge + 1);
      head.push(c.point);
      const d = dedupeConsecutive(head);
      if (d.length >= 2) result.push({ pts: d, closed: false });
    }
    if (hiIdx < cut.length) {
      const c = cut[hiIdx];
      const tail: Vec2[] = [c.point];
      for (let k = c.edge + 1; k < pts.length; k++) tail.push(pts[k]);
      const d = dedupeConsecutive(tail);
      if (d.length >= 2) result.push({ pts: d, closed: false });
    }
    return result;
  }

  // Geschlossen: der Pick liegt in einem Bogen zwischen zwei aufeinanderfolgenden
  // Knoten (zyklisch). Diesen Bogen entfernen → der Rest ist EINE offene Kette,
  // die vom Knoten NACH dem Pick einmal herum bis zum Knoten VOR dem Pick läuft.
  if (cut.length === 1) {
    // Nur ein Schnitt am Ring: am Schnitt auftrennen, Pick liegt auf der ganzen
    // (nun offenen) Kette → nichts Sinnvolles zu entfernen; Ring bleibt.
    return [{ pts: pts.slice(), closed: true }];
  }
  const pickPos = nearestParamOnChain(edges, pick);
  const cutPos = cut.map((c) => c.edge + c.t);
  // Bogenindex i: zwischen cut[i] und cut[i+1] (mod), der den Pick enthält.
  let seg = -1;
  for (let i = 0; i < cut.length; i++) {
    const a = cutPos[i];
    const b = cutPos[(i + 1) % cut.length];
    const inside =
      i === cut.length - 1
        ? pickPos >= a || pickPos <= b // Wrap-Bogen über das Ketten-Ende
        : pickPos >= a && pickPos <= b;
    if (inside) { seg = i; break; }
  }
  if (seg < 0) seg = 0;
  const from = cut[(seg + 1) % cut.length]; // Knoten NACH dem entfernten Bogen
  const to = cut[seg]; // Knoten VOR dem entfernten Bogen
  const chain = span(from.edge, from.point, to.edge, to.point);
  if (chain.length < 2) return [];
  return [{ pts: chain, closed: false }];
}

/**
 * Globaler Lauf-Parameter (edgeIndex + t) des dem Punkt `p` nächstgelegenen
 * Punktes auf der Kantenfolge — für Quick-Trim, um die Klick-Position entlang der
 * Kurve zu lokalisieren.
 */
function nearestParamOnChain(edges: [Vec2, Vec2][], p: Vec2): number {
  let best = 0;
  let bestD = Infinity;
  for (let ei = 0; ei < edges.length; ei++) {
    const [a, b] = edges[ei];
    const t = Math.max(0, Math.min(1, projectParam(p, a, b)));
    const q = add(a, scale(sub(b, a), t));
    const d = dist(p, q);
    if (d < bestD) {
      bestD = d;
      best = ei + t;
    }
  }
  return best;
}

// ── Trim MIT Bogen-Segmenten (Ziel-Kurve UND Schneider dürfen bulge tragen) ─
// Gleicher Algorithmus wie `trimPolyline` oben (Cut-Knoten sammeln → Bogen um
// den Pick entfernen), aber sowohl die Ziel-Kurve als auch die Schneider
// dürfen Bogen-Segmente (`bulge`) tragen — Kreis↔Gerade- UND Kreis↔Kreis-
// Schnitt beim Cut-Sammeln (s. `edgeIntersectTs`). `extend.ts` hält an der
// Cutter-müssen-gerade-sein-Einschränkung fest (Verlängerung eines Bogens
// gegen einen Bogen-Cutter bräuchte eine andere Kandidatenwahl als „kleinstes
// delta"; eigener, separater Umfang).

interface BulgeEdge {
  a: Vec2;
  b: Vec2;
  arc: { center: Vec2; r: number; a0: number; sweep: number } | null;
}

function buildBulgeEdges(pts: Vec2[], bulge: (number | undefined)[] | undefined, closed: boolean): BulgeEdge[] {
  const n = pts.length;
  const edgeCount = closed ? n : n - 1;
  const edges: BulgeEdge[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const bv = bulge?.[i];
    const arc = bv !== undefined ? bulgeArc(a, b, bv) : null;
    edges.push({ a, b, arc: arc ? { center: arc.center, r: arc.r, a0: arc.a0, sweep: arc.sweep } : null });
  }
  return edges;
}

/** Punkt einer BulgeEdge bei Parameter t∈[0,1] (0=a, 1=b). */
function pointOnBulgeEdgeAtT(e: BulgeEdge, t: number): Vec2 {
  if (!e.arc) return add(e.a, scale(sub(e.b, e.a), t));
  const { center, r, a0, sweep } = e.arc;
  return { x: center.x + r * Math.cos(a0 + sweep * t), y: center.y + r * Math.sin(a0 + sweep * t) };
}

/** Nächster Punkt + Parameter t∈[0,1] einer BulgeEdge zu `p` (für die Pick-Lokalisierung). */
function closestOnBulgeEdge(e: BulgeEdge, p: Vec2): { point: Vec2; t: number } {
  if (!e.arc) {
    const t = Math.max(0, Math.min(1, projectParam(p, e.a, e.b)));
    return { point: add(e.a, scale(sub(e.b, e.a), t)), t };
  }
  const { center, a0, sweep } = e.arc;
  const TAU = Math.PI * 2;
  const norm = (x: number) => ((x % TAU) + TAU) % TAU;
  const angleP = Math.atan2(p.y - center.y, p.x - center.x);
  const raw = sweep >= 0 ? norm(angleP - a0) : -norm(a0 - angleP);
  const t = sweep !== 0 ? Math.max(0, Math.min(1, raw / sweep)) : 0;
  return { point: pointOnBulgeEdgeAtT(e, t), t };
}

/** Winkel-Parameter t (nicht auf [0,1] geklemmt) eines Punktes AUF dem Vollkreis der BulgeEdge. */
function tOnArc(arc: { center: Vec2; r: number; a0: number; sweep: number }, p: Vec2): number {
  const TAU = Math.PI * 2;
  const norm = (x: number) => ((x % TAU) + TAU) % TAU;
  const angleP = Math.atan2(p.y - arc.center.y, p.x - arc.center.x);
  const raw = arc.sweep >= 0 ? norm(angleP - arc.a0) : -norm(arc.a0 - angleP);
  return arc.sweep !== 0 ? raw / arc.sweep : 0;
}

/** Liegt ein (bereits AUF dem Vollkreis liegender) Punkt innerhalb der TATSÄCHLICHEN Bogen-Spanne? */
function onArcSpan(arc: { center: Vec2; r: number; a0: number; sweep: number }, p: Vec2): boolean {
  const t = tOnArc(arc, p);
  return t >= -EPS && t <= 1 + EPS;
}

/**
 * t-Parameter(e) ∈(0,1) auf `target`, an denen `cutter` (GERADE ODER BOGEN)
 * sie trifft — Kreuzprodukt aus vier Fällen (Gerade×Gerade, Bogen×Gerade,
 * Gerade×Bogen, Bogen×Bogen). Schneidet ein Bogen-Schneider, wird der Treffer
 * IMMER gegen dessen tatsächliche Spanne geprüft (nicht nur den vollen
 * Kreis) — sonst würde ein kurzer Bogen-Cutter wie ein Vollkreis wirken.
 */
function edgeIntersectTs(target: BulgeEdge, cutter: BulgeEdge): number[] {
  if (!target.arc && !cutter.arc) {
    const h = segmentIntersect(target.a, target.b, cutter.a, cutter.b);
    return h ? [h.t] : [];
  }
  if (target.arc && !cutter.arc) {
    return segmentCircleIntersect(cutter.a, cutter.b, target.arc.center, target.arc.r).map((p) =>
      tOnArc(target.arc!, p),
    );
  }
  if (!target.arc && cutter.arc) {
    return segmentCircleIntersect(target.a, target.b, cutter.arc.center, cutter.arc.r)
      .filter((p) => onArcSpan(cutter.arc!, p))
      .map((p) => projectParam(p, target.a, target.b));
  }
  return circleCircleIntersect(target.arc!.center, target.arc!.r, cutter.arc!.center, cutter.arc!.r)
    .filter((p) => onArcSpan(cutter.arc!, p))
    .map((p) => tOnArc(target.arc!, p));
}

/** bulge-Wert des Teilbogens t0..t1 einer BulgeEdge (Gerade → 0; volle Kante → `orig` unverändert). */
function subBulge(edge: BulgeEdge, orig: number, t0: number, t1: number): number {
  if (!edge.arc) return 0;
  if (t0 <= EPS && t1 >= 1 - EPS) return orig;
  const { center, r, a0, sweep } = edge.arc;
  const sweepSign: 1 | -1 = sweep >= 0 ? 1 : -1;
  return bulgeBetweenAngles(center, r, a0 + sweep * t0, a0 + sweep * t1, sweepSign);
}

function nearestParamOnBulgeChain(edges: BulgeEdge[], p: Vec2): number {
  let best = 0;
  let bestD = Infinity;
  for (let ei = 0; ei < edges.length; ei++) {
    const { point, t } = closestOnBulgeEdge(edges[ei], p);
    const d = dist(p, point);
    if (d < bestD) { bestD = d; best = ei + t; }
  }
  return best;
}

/**
 * Wie {@link trimPolyline}, aber die Ziel-Kurve `pts`/`bulge` darf Bogen-
 * Segmente tragen (Schneider bleiben gerade, s. Kopfkommentar oben). Liefert
 * die verbleibenden Ketten inkl. ihres jeweiligen `bulge`-Arrays.
 */
export function trimPolylineWithBulge(
  pts: Vec2[],
  bulge: (number | undefined)[] | undefined,
  closed: boolean,
  cutters: { pts: Vec2[]; closed: boolean; bulge?: (number | undefined)[] }[],
  pick: Vec2,
): { pts: Vec2[]; closed: boolean; bulge: number[] }[] {
  const edges = buildBulgeEdges(pts, bulge, closed);
  const bulgeFull: number[] = edges.map((e, i) => (e.arc ? (bulge?.[i] ?? 0) : 0));
  if (edges.length === 0) return [{ pts: pts.slice(), closed, bulge: [] }];

  interface CutN { edge: number; t: number; point: Vec2; }
  const rawCuts: CutN[] = [];
  for (let ei = 0; ei < edges.length; ei++) {
    for (const c of cutters) {
      for (const ce of buildBulgeEdges(c.pts, c.bulge, c.closed)) {
        for (const t of edgeIntersectTs(edges[ei], ce)) {
          if (t > EPS && t < 1 - EPS) rawCuts.push({ edge: ei, t, point: pointOnBulgeEdgeAtT(edges[ei], t) });
        }
      }
    }
  }
  rawCuts.sort((p, q) => (p.edge - q.edge) || (p.t - q.t));
  const cut: CutN[] = [];
  for (const h of rawCuts) {
    const prev = cut[cut.length - 1];
    if (prev && prev.edge === h.edge && Math.abs(prev.t - h.t) < 1e-6) continue;
    cut.push(h);
  }
  if (cut.length === 0) return [{ pts: pts.slice(), closed, bulge: bulgeFull }];

  // Materialisiert die Kette von (fromEdge,fromT,fromPoint) bis (toEdge,toT,toPoint)
  // entlang der Kantenfolge (vorwärts, mit Wrap für geschlossene Ketten).
  const spanBulge = (
    fromEdge: number, fromT: number, fromPoint: Vec2,
    toEdge: number, toT: number, toPoint: Vec2,
  ): { pts: Vec2[]; bulge: number[] } => {
    const total = edges.length;
    const outPts: Vec2[] = [fromPoint];
    const outBulge: number[] = [];
    const pushPoint = (p: Vec2, segBulge: number) => {
      const last = outPts[outPts.length - 1];
      if (dist(last, p) <= EPS) return; // degenerierte Nullstrecke überspringen
      outPts.push(p);
      outBulge.push(segBulge);
    };
    let e = fromEdge;
    let curT = fromT;
    let steps = 0;
    while (steps <= total && e !== toEdge) {
      pushPoint(edges[e].b, subBulge(edges[e], bulgeFull[e], curT, 1));
      curT = 0;
      e = (e + 1) % total;
      steps++;
    }
    pushPoint(toPoint, subBulge(edges[toEdge], bulgeFull[toEdge], curT, toT));
    return { pts: outPts, bulge: outBulge };
  };

  if (!closed) {
    const pickPos = nearestParamOnBulgeChain(edges, pick);
    const cutPos = cut.map((c) => c.edge + c.t);
    let loIdx = -1;
    let hiIdx = cut.length;
    for (let i = 0; i < cut.length; i++) {
      if (cutPos[i] <= pickPos) loIdx = i;
      else { hiIdx = i; break; }
    }
    const result: { pts: Vec2[]; closed: boolean; bulge: number[] }[] = [];
    if (loIdx >= 0) {
      const c = cut[loIdx];
      const s = spanBulge(0, 0, pts[0], c.edge, c.t, c.point);
      if (s.pts.length >= 2) result.push({ pts: s.pts, closed: false, bulge: s.bulge });
    }
    if (hiIdx < cut.length) {
      const c = cut[hiIdx];
      const s = spanBulge(c.edge, c.t, c.point, edges.length - 1, 1, pts[pts.length - 1]);
      if (s.pts.length >= 2) result.push({ pts: s.pts, closed: false, bulge: s.bulge });
    }
    return result;
  }

  if (cut.length === 1) return [{ pts: pts.slice(), closed: true, bulge: bulgeFull }];
  const pickPos = nearestParamOnBulgeChain(edges, pick);
  const cutPos = cut.map((c) => c.edge + c.t);
  let seg = -1;
  for (let i = 0; i < cut.length; i++) {
    const a = cutPos[i];
    const b = cutPos[(i + 1) % cut.length];
    const inside = i === cut.length - 1 ? pickPos >= a || pickPos <= b : pickPos >= a && pickPos <= b;
    if (inside) { seg = i; break; }
  }
  if (seg < 0) seg = 0;
  const from = cut[(seg + 1) % cut.length];
  const to = cut[seg];
  const chain = spanBulge(from.edge, from.t, from.point, to.edge, to.t, to.point);
  if (chain.pts.length < 2) return [];
  return [{ pts: chain.pts, closed: false, bulge: chain.bulge }];
}

// ── Extend ───────────────────────────────────────────────────────────────────

/**
 * Verlängert das gewählte Ende (`end`: "start" → a1, "end" → a2) der Strecke
 * a1→a2 bis zur NÄCHSTGELEGENEN Schneider-Kante in Verlängerungsrichtung.
 * Liefert die neue Strecke oder null, wenn kein Treffer in der korrekten
 * Richtung existiert.
 */
export function extendSegment(
  a1: Vec2,
  a2: Vec2,
  end: "start" | "end",
  cutters: { pts: Vec2[]; closed: boolean }[],
): [Vec2, Vec2] | null {
  // Richtung der Verlängerung: bei "end" über a2 hinaus (t>1), bei "start"
  // über a1 hinaus (t<0). Wir parametrisieren stets entlang a1→a2.
  let bestT: number | null = null;
  for (const c of cutters) {
    for (const [b1, b2] of polylineEdges(c.pts, c.closed)) {
      const h = lineSegmentIntersect(a1, a2, b1, b2);
      if (!h) continue;
      if (end === "end" && h.t > 1 + EPS) {
        if (bestT === null || h.t < bestT) bestT = h.t; // nächstgelegen über a2
      } else if (end === "start" && h.t < -EPS) {
        if (bestT === null || h.t > bestT) bestT = h.t; // nächstgelegen unter a1
      }
    }
  }
  if (bestT === null) return null;
  const da = sub(a2, a1);
  const hitPoint = add(a1, scale(da, bestT));
  return end === "end" ? [a1, hitPoint] : [hitPoint, a2];
}

/**
 * Wie {@link extendSegment}, aber für ein Bogen-Segment (`a`→`b` mit `bulge`,
 * DXF-Konvention): verlängert den Kreisbogen über das gewählte Ende hinaus
 * (gleicher Mittelpunkt/Radius, nur die Schwenk-Spanne wächst) bis zur
 * nächstgelegenen Schneider-Kante. Schneider bleiben bewusst GERADE (wie bei
 * `extendSegment`/Trim — Bogen-Cutter sind ein eigenes, grösseres Vorhaben),
 * daher genügt die Kreis-Strecken-Schnittfunktion. `end: "end"` verlängert
 * über `b` hinaus (a bleibt fest), `end: "start"` über `a` hinaus (b bleibt
 * fest) — jeweils in derselben Schwenkrichtung wie das Original, nicht
 * rückwärts. Liefert `null` bei Geraden (bulge≈0) oder ohne Treffer.
 */
export function extendBulgeSegment(
  a: Vec2,
  b: Vec2,
  bulge: number,
  end: "start" | "end",
  cutters: { pts: Vec2[]; closed: boolean }[],
): { point: Vec2; bulge: number } | null {
  const arc = bulgeArc(a, b, bulge);
  if (!arc) return null;
  const { center, r, a0, a1, sweep } = arc;
  const sweepSign: 1 | -1 = sweep >= 0 ? 1 : -1;
  const TAU = Math.PI * 2;
  const norm = (x: number) => ((x % TAU) + TAU) % TAU;
  let bestDelta: number | null = null;
  let bestAngle = 0;
  for (const c of cutters) {
    for (const [b1, b2] of polylineEdges(c.pts, c.closed)) {
      for (const p of segmentCircleIntersect(b1, b2, center, r)) {
        const theta = Math.atan2(p.y - center.y, p.x - center.x);
        const delta =
          end === "end"
            ? sweepSign > 0 ? norm(theta - a1) : norm(a1 - theta)
            : sweepSign > 0 ? norm(a0 - theta) : norm(theta - a0);
        if (delta < EPS) continue; // trifft den Endpunkt selbst
        if (bestDelta === null || delta < bestDelta) {
          bestDelta = delta;
          bestAngle = theta;
        }
      }
    }
  }
  if (bestDelta === null) return null;
  const point = { x: center.x + r * Math.cos(bestAngle), y: center.y + r * Math.sin(bestAngle) };
  const newBulge =
    end === "end"
      ? bulgeBetweenAngles(center, r, a0, bestAngle, sweepSign)
      : bulgeBetweenAngles(center, r, bestAngle, a1, sweepSign);
  return { point, bulge: newBulge };
}

// ── Kreis-Schnitte (für Circle/Arc, 2P/3P/Tangenten) ────────────────────────

/** Schnittpunkte einer unendlichen GERADE a→b mit einem Kreis (0/1/2 Punkte). */
export function lineCircleIntersect(
  a: Vec2,
  b: Vec2,
  center: Vec2,
  r: number,
): Vec2[] {
  const d = sub(b, a);
  const f = sub(a, center);
  const A = dot(d, d);
  if (A < EPS) return [];
  const B = 2 * dot(f, d);
  const C = dot(f, f) - r * r;
  let disc = B * B - 4 * A * C;
  if (disc < -EPS) return [];
  if (disc < 0) disc = 0;
  const sq = Math.sqrt(disc);
  const t1 = (-B - sq) / (2 * A);
  const t2 = (-B + sq) / (2 * A);
  const out = [add(a, scale(d, t1))];
  if (Math.abs(t1 - t2) > EPS) out.push(add(a, scale(d, t2)));
  return out;
}

/** Schnittpunkte einer STRECKE a→b mit einem Kreis (nur t ∈ [0,1]). */
export function segmentCircleIntersect(
  a: Vec2,
  b: Vec2,
  center: Vec2,
  r: number,
): Vec2[] {
  return lineCircleIntersect(a, b, center, r).filter((p) => {
    const t = projectParam(p, a, b);
    return t >= -EPS && t <= 1 + EPS;
  });
}

/** Schnittpunkte zweier Kreise (0/1/2 Punkte). */
export function circleCircleIntersect(
  c1: Vec2,
  r1: number,
  c2: Vec2,
  r2: number,
): Vec2[] {
  const d = dist(c1, c2);
  if (d < EPS) return []; // konzentrisch
  if (d > r1 + r2 + EPS || d < Math.abs(r1 - r2) - EPS) return []; // getrennt/innen
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const u = normalize(sub(c2, c1));
  const mid = add(c1, scale(u, a));
  const n = leftNormal(u);
  if (h < EPS) return [mid];
  return [add(mid, scale(n, h)), add(mid, scale(n, -h))];
}

// ── Polygon-Fläche / Wicklung ───────────────────────────────────────────────

/** Vorzeichenbehaftete Polygonfläche (Shoelace); >0 = CCW, <0 = CW. */
export function signedArea(pts: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Ob ein Polygonzug gegen den Uhrzeigersinn (CCW) gewickelt ist. */
export function isCCW(pts: Vec2[]): boolean {
  return signedArea(pts) > 0;
}

// ── Fillet (Eck-Verrundung) ─────────────────────────────────────────────────

/** Ergebnis einer Eck-Verrundung. */
export interface Fillet {
  center: Vec2;
  radius: number;
  /** Tangentenpunkt auf dem ersten Schenkel (corner→p1). */
  tangentA: Vec2;
  /** Tangentenpunkt auf dem zweiten Schenkel (corner→p2). */
  tangentB: Vec2;
  /** Bogen-Endwinkel in Radiant (für ein Arc-Primitiv). */
  startAngle: number;
  endAngle: number;
}

/**
 * Verrundet die Ecke bei `corner`, gebildet von den beiden Schenkeln corner→p1
 * und corner→p2, mit Radius `r`. Liefert Bogenmittelpunkt + Tangentenpunkte
 * (an denen die Schenkel zurückgetrimmt werden) oder null, wenn die Schenkel
 * (nahezu) kollinear sind oder zu kurz für den Radius. Standard-Kanten-Fillet
 * (Distanz vom Eck = r / tan(θ/2)).
 */
export function filletCorner(
  corner: Vec2,
  p1: Vec2,
  p2: Vec2,
  r: number,
): Fillet | null {
  const u1 = normalize(sub(p1, corner));
  const u2 = normalize(sub(p2, corner));
  const cosTheta = Math.max(-1, Math.min(1, dot(u1, u2)));
  const theta = Math.acos(cosTheta);
  if (theta < 1e-4 || Math.PI - theta < 1e-4) return null; // kollinear
  const tanHalf = Math.tan(theta / 2);
  if (tanHalf < EPS) return null;
  const setback = r / tanHalf; // Abstand Eck → Tangentenpunkt entlang je Schenkel
  // Genügend Schenkellänge?
  if (setback > len(sub(p1, corner)) + EPS || setback > len(sub(p2, corner)) + EPS) {
    return null;
  }
  const tangentA = add(corner, scale(u1, setback));
  const tangentB = add(corner, scale(u2, setback));
  // Mittelpunkt liegt auf der Winkelhalbierenden, Abstand r/sin(θ/2) vom Eck.
  const bis = normalize(add(u1, u2));
  const centerDist = r / Math.sin(theta / 2);
  const center = add(corner, scale(bis, centerDist));
  const startAngle = Math.atan2(tangentA.y - center.y, tangentA.x - center.x);
  const endAngle = Math.atan2(tangentB.y - center.y, tangentB.x - center.x);
  return { center, radius: r, tangentA, tangentB, startAngle, endAngle };
}

/** Ergebnis einer Eck-Fasung. */
export interface Chamfer {
  /** Punkt auf dem ersten Schenkel (corner→p1), im Abstand `distance` vom Eck. */
  a: Vec2;
  /** Punkt auf dem zweiten Schenkel (corner→p2), im Abstand `distance` vom Eck. */
  b: Vec2;
}

/**
 * Fast die Ecke bei `corner` (Schenkel corner→p1, corner→p2) mit einer geraden
 * Abschrägung: gleicher Abstand `distance` vom Eck auf BEIDEN Schenkeln,
 * verbunden durch eine gerade Linie (klassischer Gleichabstands-Chamfer, wie
 * `filletCorner`, nur ohne Bogen — die Ecke fällt weg, der Schnitt bleibt
 * gerade). Liefert `null` bei (nahezu) kollinearen Schenkeln oder wenn
 * `distance` länger als ein Schenkel ist.
 */
export function chamferCorner(
  corner: Vec2,
  p1: Vec2,
  p2: Vec2,
  distance: number,
): Chamfer | null {
  const u1 = normalize(sub(p1, corner));
  const u2 = normalize(sub(p2, corner));
  const cosTheta = Math.max(-1, Math.min(1, dot(u1, u2)));
  const theta = Math.acos(cosTheta);
  if (theta < 1e-4 || Math.PI - theta < 1e-4) return null; // kollinear
  if (
    distance > len(sub(p1, corner)) + EPS ||
    distance > len(sub(p2, corner)) + EPS
  ) {
    return null;
  }
  const a = add(corner, scale(u1, distance));
  const b = add(corner, scale(u2, distance));
  return { a, b };
}

// ── Split / Join / Segment-Löschen (Drawing2D-Editieren) ─────────────────────
// Reine Geometrie auf Polylinien (`Vec2[]` + `closed`). Die Operations-Schicht
// (`src/editors/splitJoin.ts`) wandelt Drawing2D ↔ {pts, closed} und ruft diese
// Funktionen. Punkt P einer Kante: `lerp(pts[i], pts[i+1], t)`.

/** Lineare Interpolation zweier Punkte. */
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => add(a, scale(sub(b, a), t));

/**
 * Teilt eine Polylinie an EINEM Punkt P = lerp(pts[edgeIndex], pts[edgeIndex+1],
 * t) (t ∈ (0,1) entlang der Kante; bei geschlossenen Zügen ist die Schlusskante
 * `edgeIndex === pts.length-1`).
 *  • OFFEN  → zwei offene Polylinien [start…P] und [P…ende].
 *  • GESCHLOSSEN → EINE offene Polylinie, am Punkt P aufgeschnitten (der Zug
 *    läuft von P einmal um die Schleife zurück nach P).
 * Liegt P (nahezu) auf einem vorhandenen Vertex, wird KEIN Duplikat eingefügt.
 */
export function splitPolylineAtParam(
  pts: Vec2[],
  closed: boolean,
  edgeIndex: number,
  t: number,
): Vec2[][] {
  const n = pts.length;
  if (n < 2) return [pts.slice()];
  const a = pts[edgeIndex];
  const b = pts[(edgeIndex + 1) % n];
  const p = lerp(a, b, t);
  const atStart = t <= EPS;
  const atEnd = t >= 1 - EPS;

  if (!closed) {
    // Offen: [0..edgeIndex] + P + [edgeIndex+1..n-1].
    const left = pts.slice(0, edgeIndex + 1);
    if (!atStart && !atEnd) left.push(p);
    else if (atEnd) left.push(b); // P == b → b gehört noch links dazu
    const right: Vec2[] = [];
    if (!atStart && !atEnd) right.push(p);
    else if (atStart) right.push(a);
    for (let i = edgeIndex + 1; i < n; i++) right.push(pts[i]);
    const pieces = [left, right].filter((s) => s.length >= 2);
    return pieces.length ? pieces : [pts.slice()];
  }

  // Geschlossen: an P aufschneiden → eine offene Kette, die einmal herumläuft.
  const out: Vec2[] = [];
  if (!atStart) out.push(p);
  // Ab dem Punkt NACH der Schnittkante einmal komplett um die Schleife.
  for (let k = 1; k <= n; k++) {
    out.push(pts[(edgeIndex + k) % n]);
  }
  // out endet bei pts[edgeIndex] (== a); P schließt den Zug am Ende ab.
  if (!atStart) out.push(p);
  else out.push(a); // bei P==a: a doppelt (Start==Ende) ergäbe eine Schleife;
  // dedupe identische aufeinanderfolgende Punkte
  return [dedupeConsecutive(out)];
}

/** Entfernt aufeinanderfolgende (nahezu) gleiche Punkte (kein Ringschluss). */
function dedupeConsecutive(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    if (out.length === 0 || !vecEqual(out[out.length - 1], p)) out.push(p);
  }
  return out;
}

/**
 * Teilt ein GESCHLOSSENES Polygon an zwei Randpunkten (auf den Kanten `i` bzw.
 * `j`, Parameter `ti`/`tj`) in ZWEI GESCHLOSSENE Polygone: jedes besteht aus dem
 * jeweiligen Rand-Bogen plus der Sehne (Verbindung Pi—Pj). Liefert `null`, wenn
 * i==j (dieselbe Kante → keine sinnvolle Sehne).
 */
export function splitClosedByChord(
  pts: Vec2[],
  i: number,
  ti: number,
  j: number,
  tj: number,
): [Vec2[], Vec2[]] | null {
  const n = pts.length;
  if (n < 3 || i === j) return null;
  // Reihenfolge sicherstellen: a vor b entlang des Ringes.
  let ia = i, ta = ti, ib = j, tb = tj;
  if (i > j) {
    ia = j; ta = tj; ib = i; tb = ti;
  }
  const Pa = lerp(pts[ia], pts[(ia + 1) % n], ta);
  const Pb = lerp(pts[ib], pts[(ib + 1) % n], tb);

  // Bogen 1: Pa → (Vertices ia+1 … ib) → Pb.
  const arc1: Vec2[] = [Pa];
  for (let k = ia + 1; k <= ib; k++) arc1.push(pts[k % n]);
  arc1.push(Pb);
  // Bogen 2: Pb → (Vertices ib+1 … ia, modular) → Pa.
  const arc2: Vec2[] = [Pb];
  for (let k = ib + 1; k <= ia + n; k++) arc2.push(pts[k % n]);
  arc2.push(Pa);

  return [dedupeRing(arc1), dedupeRing(arc2)];
}

/**
 * Dedupliziert aufeinanderfolgende gleiche Punkte UND einen schließenden
 * Duplikat-Endpunkt (Ring: pts[last]==pts[0] → letzten verwerfen).
 */
function dedupeRing(pts: Vec2[]): Vec2[] {
  const out = dedupeConsecutive(pts);
  if (out.length > 1 && vecEqual(out[0], out[out.length - 1])) out.pop();
  return out;
}

/**
 * Entfernt das Segment `edgeIndex` aus einer Polylinie. Liefert die neue
 * Punktliste plus neues `closed`-Flag:
 *  • OFFEN: innere Kante → die Polylinie zerfällt in zwei Stücke; hier wird das
 *    LÄNGERE Stück (mehr Punkte) zurückgegeben (Schere). Erste/letzte Kante →
 *    einfach den End-Vertex abschneiden.
 *  • GESCHLOSSEN: die Schleife wird an dieser Kante zur OFFENEN Polylinie
 *    aufgetrennt (Start = Punkt nach der Kante, einmal herum bis zum Punkt davor).
 */
export function removeSegment(
  pts: Vec2[],
  closed: boolean,
  edgeIndex: number,
): { pts: Vec2[]; closed: boolean } {
  const n = pts.length;
  if (closed) {
    // Auftrennen: Start = (edgeIndex+1) … einmal herum bis edgeIndex.
    const out: Vec2[] = [];
    for (let k = 1; k <= n; k++) out.push(pts[(edgeIndex + k) % n]);
    return { pts: dedupeConsecutive(out), closed: false };
  }
  // Offen.
  if (edgeIndex <= 0) return { pts: pts.slice(1), closed: false };
  if (edgeIndex >= n - 1) return { pts: pts.slice(0, n - 1), closed: false };
  const left = pts.slice(0, edgeIndex + 1);
  const right = pts.slice(edgeIndex + 1);
  // Das punktreichere (geometrisch i. d. R. „größere") Teilstück behalten.
  return { pts: left.length >= right.length ? left : right, closed: false };
}

/**
 * Wie {@link removeSegment}, aber trägt ein `bulge`-Array (Bogen-Segmente,
 * DXF-Konvention, s. `geometry/bulge.ts`) mit durch die Operation. Dieselbe
 * Index-Regel wie überall: `bulge[i]` gehört zur Kante `pts[i]→pts[i+1]`
 * (bzw. `pts[n-1]→pts[0]` bei geschlossenen Polylinien) — die entfernte Kante
 * nimmt ihren bulge-Eintrag mit, alle übrigen wandern unverändert mit ihrem
 * Punktepaar mit. (Dedup identischer Nachbarpunkte wie bei `removeSegment`
 * bewusst ausgelassen — würde bulge-Indizes gegenüber pts verschieben; bei
 * bulge-Polylinien treten doppelte Punkte praktisch nicht auf.)
 */
export function removeSegmentWithBulge(
  pts: Vec2[],
  bulge: number[],
  closed: boolean,
  edgeIndex: number,
): { pts: Vec2[]; closed: boolean; bulge: number[] } {
  const n = pts.length;
  if (closed) {
    const outPts: Vec2[] = [];
    const outBulge: number[] = [];
    for (let k = 1; k <= n; k++) outPts.push(pts[(edgeIndex + k) % n]);
    for (let k = 1; k <= n - 1; k++) outBulge.push(bulge[(edgeIndex + k) % n]);
    return { pts: outPts, closed: false, bulge: outBulge };
  }
  if (edgeIndex <= 0) return { pts: pts.slice(1), closed: false, bulge: bulge.slice(1) };
  if (edgeIndex >= n - 1) {
    return { pts: pts.slice(0, n - 1), closed: false, bulge: bulge.slice(0, -1) };
  }
  const leftPts = pts.slice(0, edgeIndex + 1);
  const leftBulge = bulge.slice(0, edgeIndex);
  const rightPts = pts.slice(edgeIndex + 1);
  const rightBulge = bulge.slice(edgeIndex + 1);
  return leftPts.length >= rightPts.length
    ? { pts: leftPts, closed: false, bulge: leftBulge }
    : { pts: rightPts, closed: false, bulge: rightBulge };
}

/** Ein Schnitt-Treffer auf einer Ziel-Kante: Kantenindex + Parameter + Punkt. */
interface EdgeHit {
  edge: number;
  t: number;
  point: Vec2;
}

/**
 * Teilt das Ziel (`targetPts`, `closed`) an allen Schnittpunkten mit den anderen
 * Polylinien (`others`). Schnittpunkte entstehen je Kantenpaar via
 * {@link segmentIntersect}.
 *  • GESCHLOSSEN + genau zwei Schnitte → {@link splitClosedByChord} (zwei
 *    geschlossene Polygone). Bei !=2 Schnitten: unverändert (eine Liste).
 *  • OFFEN → an den (nach Bogenlänge geordneten) Schnittpunkten in Stücke
 *    zerschnitten.
 * Schnitte an vorhandenen Vertices/Endpunkten werden zusammengefasst.
 */
export function splitAtIntersections(
  targetPts: Vec2[],
  closed: boolean,
  others: Vec2[][],
): Vec2[][] {
  const edges = polylineEdges(targetPts, closed);
  const hits: EdgeHit[] = [];
  for (let ei = 0; ei < edges.length; ei++) {
    const [a1, a2] = edges[ei];
    for (const o of others) {
      // jede Kante jeder anderen Polylinie (offen UND geschlossen behandeln wir
      // gleich: die Aufrufer-Schicht liefert `others` bereits als Polylinien-
      // Punktlisten; geschlossene Schließkante über vecEqual-Heuristik unnötig,
      // da der Aufrufer Endpunkt nicht dupliziert — wir testen offene Kanten).
      const oEdges = polylineEdgesAuto(o);
      for (const [b1, b2] of oEdges) {
        const h = segmentIntersect(a1, a2, b1, b2);
        if (!h) continue;
        // Nur „echte" innere Schnitte zählen (nicht exakt am Ziel-Vertex 0/1,
        // die ohnehin Trennstellen sind).
        hits.push({ edge: ei, t: h.t, point: h.point });
      }
    }
  }
  // Pro Ziel-Kante nach t sortieren + dedupen.
  const dedup: EdgeHit[] = [];
  hits.sort((p, q) => (p.edge - q.edge) || (p.t - q.t));
  for (const h of hits) {
    const prev = dedup[dedup.length - 1];
    if (prev && prev.edge === h.edge && Math.abs(prev.t - h.t) < 1e-6) continue;
    // Schnitte exakt auf einem Ziel-Vertex (t≈0/1) ignorieren — keine echte Teilung.
    if (h.t <= EPS || h.t >= 1 - EPS) continue;
    dedup.push(h);
  }

  if (dedup.length === 0) return [targetPts.slice()];

  if (closed) {
    if (dedup.length === 2) {
      const [h1, h2] = dedup;
      const res = splitClosedByChord(targetPts, h1.edge, h1.t, h2.edge, h2.t);
      return res ? res : [targetPts.slice()];
    }
    // Mehr/weniger als 2 Schnitte: geschlossen an allen Schnitten zur offenen
    // Polylinie aufgetrennt (am ersten Schnitt aufgeschnitten, dann in Stücke).
    // Pragmatisch: am ersten Schnitt aufschneiden, dann wie offen weiter.
    const opened = splitPolylineAtParam(targetPts, true, dedup[0].edge, dedup[0].t)[0];
    return splitOpenAtHits(opened, dedup.slice(1).map((h) => h.point));
  }

  // Offen: an den geordneten Schnittpunkten zerschneiden.
  return splitOpenByEdgeHits(targetPts, dedup);
}

/** Kanten einer (offenen ODER implizit geschlossenen) Punktliste. */
function polylineEdgesAuto(pts: Vec2[]): [Vec2, Vec2][] {
  // Heuristik: ist der erste == letzter Punkt, gilt sie als geschlossen.
  const closed = pts.length > 2 && vecEqual(pts[0], pts[pts.length - 1]);
  return polylineEdges(closed ? pts.slice(0, -1) : pts, closed);
}

/** Offene Polylinie an gegebenen EdgeHits (auf ihren Kanten) zerschneiden. */
function splitOpenByEdgeHits(pts: Vec2[], hits: EdgeHit[]): Vec2[][] {
  const pieces: Vec2[][] = [];
  let cur: Vec2[] = [pts[0]];
  let hi = 0;
  for (let ei = 0; ei < pts.length - 1; ei++) {
    while (hi < hits.length && hits[hi].edge === ei) {
      const p = hits[hi].point;
      cur.push(p);
      pieces.push(cur);
      cur = [p];
      hi++;
    }
    cur.push(pts[ei + 1]);
  }
  pieces.push(cur);
  return pieces.map(dedupeConsecutive).filter((s) => s.length >= 2);
}

/** Offene Polylinie an einer Liste von Schnitt-PUNKTEN (auf dem Zug) zerschneiden. */
function splitOpenAtHits(pts: Vec2[], cutPoints: Vec2[]): Vec2[][] {
  if (cutPoints.length === 0) return [pts.slice()];
  const hits: EdgeHit[] = [];
  for (let ei = 0; ei < pts.length - 1; ei++) {
    const a = pts[ei];
    const b = pts[ei + 1];
    for (const cp of cutPoints) {
      const t = projectParam(cp, a, b);
      if (t > EPS && t < 1 - EPS && pointSegmentDistance(cp, a, b) < 1e-6) {
        hits.push({ edge: ei, t, point: cp });
      }
    }
  }
  hits.sort((p, q) => (p.edge - q.edge) || (p.t - q.t));
  return splitOpenByEdgeHits(pts, hits);
}

/**
 * Verschmilzt Polylinien an koinzidenten Endpunkten zu längeren Ketten. Jeder
 * Eintrag ist `{pts, closed}`. Bereits geschlossene Ketten bleiben unverändert.
 * Offene Ketten werden an gemeinsamen Endpunkten (vecEqual) aneinandergehängt;
 * schließt sich eine Kette (erster == letzter Punkt), wird sie als `closed`
 * markiert (der Schlusspunkt-Duplikat entfernt). Reihenfolge-/Richtungs-stabil
 * genug für den Editier-Workflow (kein Verzweigungs-Handling: Knoten mit >2
 * Enden werden greedy verbunden).
 */
export function joinChains(
  polylines: { pts: Vec2[]; closed: boolean }[],
): { pts: Vec2[]; closed: boolean }[] {
  const closedOut: { pts: Vec2[]; closed: boolean }[] = [];
  // Offene Ketten als veränderbare Punktlisten sammeln (geschlossene bleiben).
  const open: Vec2[][] = [];
  for (const pl of polylines) {
    if (pl.closed) closedOut.push({ pts: pl.pts.slice(), closed: true });
    else if (pl.pts.length >= 2) open.push(pl.pts.slice());
    else if (pl.pts.length === 1) open.push(pl.pts.slice());
  }

  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < open.length; i++) {
      for (let j = i + 1; j < open.length; j++) {
        const A = open[i];
        const B = open[j];
        const aS = A[0], aE = A[A.length - 1];
        const bS = B[0], bE = B[B.length - 1];
        let combined: Vec2[] | null = null;
        if (vecEqual(aE, bS)) combined = [...A, ...B.slice(1)];
        else if (vecEqual(aE, bE)) combined = [...A, ...B.slice(0, -1).reverse()];
        else if (vecEqual(aS, bE)) combined = [...B, ...A.slice(1)];
        else if (vecEqual(aS, bS)) combined = [...B.slice().reverse(), ...A.slice(1)];
        if (combined) {
          open.splice(j, 1);
          open.splice(i, 1, combined);
          merged = true;
          break outer;
        }
      }
    }
  }

  const out: { pts: Vec2[]; closed: boolean }[] = [...closedOut];
  for (const chain of open) {
    if (chain.length > 2 && vecEqual(chain[0], chain[chain.length - 1])) {
      out.push({ pts: chain.slice(0, -1), closed: true });
    } else {
      out.push({ pts: chain, closed: false });
    }
  }
  return out;
}

/** Kehrt ein bulge-Array um (Reihenfolge + Vorzeichen), für eine rückwärts gelaufene Kette. */
function reverseBulge(b: number[]): number[] {
  return b.slice().reverse().map((v) => -v);
}

/**
 * Wie {@link joinChains}, aber trägt pro Kette ein optionales `bulge`-Array
 * (Bogen-Segmente, DXF-Konvention, s. `geometry/bulge.ts`) mit durch die
 * Verkettung. Beim Verbinden ZWEIER Ketten am Endpunkt bleibt die Kanten-
 * Reihenfolge/-Richtung jeder Kette erhalten → deren bulge-Werte werden einfach
 * aneinandergehängt. Muss eine Kette dafür UMGEDREHT werden (ihr Start- statt
 * Endpunkt trifft den Anschluss), kehrt sich pro Kante sowohl die Reihenfolge
 * als auch das VORZEICHEN um (dieselbe Konvention wie bei Spiegelung, s.
 * `tools/transform.ts::mvGeom`, Fall `"polyline"`) — bulge kodiert die Krümmung
 * relativ zur Laufrichtung, die sich beim Umdrehen umkehrt.
 */
export function joinChainsWithBulge(
  polylines: { pts: Vec2[]; closed: boolean; bulge?: number[] }[],
): { pts: Vec2[]; closed: boolean; bulge: number[] }[] {
  const closedOut: { pts: Vec2[]; closed: boolean; bulge: number[] }[] = [];
  const open: { pts: Vec2[]; bulge: number[] }[] = [];
  for (const pl of polylines) {
    const bulge = pl.bulge ?? new Array(Math.max(0, pl.pts.length - 1)).fill(0);
    if (pl.closed) closedOut.push({ pts: pl.pts.slice(), closed: true, bulge });
    else if (pl.pts.length >= 1) open.push({ pts: pl.pts.slice(), bulge });
  }

  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < open.length; i++) {
      for (let j = i + 1; j < open.length; j++) {
        const A = open[i];
        const B = open[j];
        const aS = A.pts[0], aE = A.pts[A.pts.length - 1];
        const bS = B.pts[0], bE = B.pts[B.pts.length - 1];
        let combined: { pts: Vec2[]; bulge: number[] } | null = null;
        if (vecEqual(aE, bS)) {
          combined = { pts: [...A.pts, ...B.pts.slice(1)], bulge: [...A.bulge, ...B.bulge] };
        } else if (vecEqual(aE, bE)) {
          combined = {
            pts: [...A.pts, ...B.pts.slice(0, -1).reverse()],
            bulge: [...A.bulge, ...reverseBulge(B.bulge.slice(0, -1))],
          };
        } else if (vecEqual(aS, bE)) {
          combined = { pts: [...B.pts, ...A.pts.slice(1)], bulge: [...B.bulge, ...A.bulge] };
        } else if (vecEqual(aS, bS)) {
          combined = {
            pts: [...B.pts.slice().reverse(), ...A.pts.slice(1)],
            bulge: [...reverseBulge(B.bulge), ...A.bulge],
          };
        }
        if (combined) {
          open.splice(j, 1);
          open.splice(i, 1, combined);
          merged = true;
          break outer;
        }
      }
    }
  }

  const out = [...closedOut];
  for (const chain of open) {
    if (chain.pts.length > 2 && vecEqual(chain.pts[0], chain.pts[chain.pts.length - 1])) {
      out.push({ pts: chain.pts.slice(0, -1), closed: true, bulge: chain.bulge });
    } else {
      out.push({ pts: chain.pts, closed: false, bulge: chain.bulge });
    }
  }
  return out;
}
