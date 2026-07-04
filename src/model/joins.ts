// Wand-Verschneidung (Gehrung): an einer Ecke, wo zwei Wände aufeinander­
// treffen, sollen sich die Schicht-Bänder nicht überlappen, sondern an einer
// gemeinsamen Gehrungslinie sauber stoßen. Dieses Modul berechnet pro Wand
// die optionalen Schnittlinien an Start- und Endpunkt.

import type { Project, Vec2, Wall } from "./types";
import { getWallType, wallTypeThickness } from "./types";
import { wallReferenceOffset } from "./wall";
import {
  add,
  dot,
  leftNormal,
  len,
  lineIntersect,
  normalize,
  scale,
  sub,
} from "./geometry";
import type { Line } from "./geometry";

/** Schnittlinien einer Wand an ihren beiden Achsenden. */
export interface WallCuts {
  startCut: Line | null;
  endCut: Line | null;
}

/** Rundet eine Koordinate auf ein Gitter, um Endpunkte robust zu gruppieren. */
const roundKey = (p: Vec2): string => {
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return `${r(p.x)},${r(p.y)}`;
};

interface WallEnd {
  wallId: string;
  end: "start" | "end";
}

/**
 * Berechnet für jede Wand die Gehrungs-/Anschluss-Schnittlinien.
 * Behandelt werden: L-Ecken (genau zwei Wandenden treffen sich), T-Knoten
 * (drei Wandenden treffen sich, zwei davon kollinear) und Mittelspannen-
 * T-Stöße (ein freies Wandende trifft auf die Seite einer anderen Wand).
 * X-Stöße (vier und mehr Enden) bleiben vorerst rechtwinklig.
 *
 * `walls` ist die bereits gefilterte Wandmenge (z. B. ein Geschoss); die
 * Gehrung wird nur innerhalb dieser Menge gebildet.
 */
export function computeJoins(
  project: Project,
  walls: Wall[],
): Map<string, WallCuts> {
  const byId = new Map(walls.map((w) => [w.id, w]));

  const result = new Map<string, WallCuts>();
  for (const w of walls) result.set(w.id, { startCut: null, endCut: null });

  // Knotenkarte: gerundeter Endpunkt → Liste der dort endenden Wandenden.
  const junctions = new Map<string, WallEnd[]>();
  const push = (p: Vec2, we: WallEnd) => {
    const key = roundKey(p);
    const list = junctions.get(key);
    if (list) list.push(we);
    else junctions.set(key, [we]);
  };
  for (const w of walls) {
    push(w.start, { wallId: w.id, end: "start" });
    push(w.end, { wallId: w.id, end: "end" });
  }

  for (const [, ends] of junctions) {
    // Freies Ende → kein Schnitt hier (wird unten separat auf Mittelspannen-T
    // geprüft, Fall 2).
    if (ends.length === 1) continue;

    if (ends.length === 2) {
      const a = byId.get(ends[0].wallId)!;
      const b = byId.get(ends[1].wallId)!;
      const cut = miterLine(project, a, ends[0].end, b);
      if (!cut) continue; // kollinear → kein Schnitt

      setCut(result, ends[0], cut);
      setCut(result, ends[1], cut);
      continue;
    }

    if (ends.length === 3) {
      applyTJunction(project, byId, ends, result);
      continue;
    }

    // X-Stöße u. ä. (>3 Enden): vorerst rechtwinklig lassen (Folge-Arbeit).
  }

  // Fall 2: Mittelspannen-T-Stoß. Ein freies Wandende (kein anderes Wandende
  // teilt sich seinen Knoten) kann trotzdem auf die Seite einer anderen Wand
  // treffen (nicht an deren Endpunkten). In dem Fall bekommt das freie Ende
  // einen Schnitt entlang der zugewandten Fläche dieser Wand.
  for (const [, ends] of junctions) {
    if (ends.length !== 1) continue;
    applyMidSpanTee(project, byId, walls, ends[0], result);
  }

  return result;
}

/** Trägt eine Schnittlinie am passenden Ende einer Wand ein. */
function setCut(result: Map<string, WallCuts>, we: WallEnd, cut: Line): void {
  const cuts = result.get(we.wallId)!;
  if (we.end === "start") cuts.startCut = cut;
  else cuts.endCut = cut;
}

/** Achsrichtung start→end, normalisiert. */
const dirOf = (w: Wall): Vec2 => normalize(sub(w.end, w.start));

/**
 * Gemeinsame Gehrungslinie zweier Wände A, B, die sich im Knoten J treffen.
 * Robust gegen beliebige Wicklung, ungleiche Dicken und JEDEN Öffnungswinkel
 * (inkl. spitzer): Die Wandflächen werden orientierungsbasiert (vorzeichen­
 * richtig) gepaart — A's Außenfläche verschneidet B's Außenfläche zum äußeren
 * Apex, A's Innenfläche B's Innenfläche zum inneren Apex. „Außen" ist jeweils
 * die vom Körper der anderen Wand ABGEWANDTE Fläche. Die Gerade durch beide
 * Apexe ist die Gehrung; sie trennt beide Wandbänder überlappungsfrei.
 *
 * Die frühere Distanz-Heuristik („nächstgelegene B-Fläche") kippt bei spitzen
 * Winkeln — dort wird die falsche Fläche zur näheren, sodass Außen mit Innen
 * gepaart wird und die Poché-Bänder sich kreuzweise überlappen.
 */
function miterLine(
  project: Project,
  a: Wall,
  aEnd: "start" | "end",
  b: Wall,
): Line | null {
  const j = aEnd === "start" ? a.start : a.end;

  const tA = wallTypeThickness(getWallType(project, a));
  const tB = wallTypeThickness(getWallType(project, b));
  const uA = dirOf(a);
  const uB = dirOf(b);
  const nA = leftNormal(uA);
  const nB = leftNormal(uB);

  // Referenzlinien-Versatz: liegt die Achse nicht mittig, sind die beiden
  // Wandflächen um diesen Betrag entlang +n verschoben (außen −T/2+off, innen
  // +T/2+off). Für „center" (Default) ist off=0 → unverändert.
  const offA = wallReferenceOffset(a, tA);
  const offB = wallReferenceOffset(b, tB);

  // Flächen-Stützpunkte am Knoten: linke Fläche liegt auf +n, rechte auf −n
  // (inkl. Referenzversatz).
  const pLA = add(j, scale(nA, offA + tA / 2));
  const pRA = add(j, scale(nA, offA - tA / 2));
  const pLB = add(j, scale(nB, offB + tB / 2));
  const pRB = add(j, scale(nB, offB - tB / 2));

  // Auslauf-Richtungen der Achsen vom Knoten weg, in den jeweiligen Wandkörper.
  const dA = aEnd === "start" ? uA : scale(uA, -1);
  const bAtStart = len(sub(b.start, j)) <= len(sub(b.end, j));
  const dB = bAtStart ? uB : scale(uB, -1);

  // Orientierungsbasierte, vorzeichenrichtige Flächen-Paarung. „Außen" ist die
  // vom Körper der anderen Wand ABGEWANDTE Fläche: A's +nA-Fläche (pLA) liegt
  // außen, wenn nA·dB < 0; B's +nB-Fläche (pLB) außen, wenn nB·dA < 0. Gepaart
  // wird Außen-mit-Außen und Innen-mit-Innen — nie über Kreuz. (nA·dB = 0 tritt
  // nur bei kollinearen Achsen auf; dann sind die Flächen parallel und
  // lineIntersect liefert unten ohnehin null.)
  const bOuter = dot(nB, dA) < 0 ? pLB : pRB;
  const bInner = dot(nB, dA) < 0 ? pRB : pLB;
  const aLeftIsOuter = dot(nA, dB) < 0;
  const bForLeft = aLeftIsOuter ? bOuter : bInner;
  const bForRight = aLeftIsOuter ? bInner : bOuter;

  // c1 an A's linke Fläche (pLA), c2 an A's rechte (pRA) gebunden — Reihenfolge
  // wie zuvor, damit rechte/stumpfe Ecken bit-identisch bleiben; nur die
  // B-Partnerwahl ist jetzt orientierungs- statt distanzbasiert.
  const c1 = lineIntersect(pLA, uA, bForLeft, uB);
  const c2 = lineIntersect(pRA, uA, bForRight, uB);
  if (!c1 || !c2) return null;

  const dir = sub(c2, c1);
  if (len(dir) < 1e-9) return null;
  return { point: c1, dir };
}

/**
 * Fall 1 — T-Knoten: drei Wandenden treffen sich im selben (gerundeten)
 * Knoten. Typisch sind zwei davon kollinear (die zwei Hälften der
 * Durchgangswand, die geometrisch als eine Achse durchläuft) und das dritte
 * zweigt ab. Die kollinearen zwei bleiben ungeschnitten; der Abzweig bekommt
 * einen Schnitt entlang der ihm zugewandten Fläche der Durchgangswand.
 * Findet sich kein eindeutig kollineares Paar (z. B. echter Y-/X-Knoten),
 * bleibt der Knoten unangetastet (rechtwinklig).
 */
function applyTJunction(
  project: Project,
  byId: Map<string, Wall>,
  ends: WallEnd[],
  result: Map<string, WallCuts>,
): void {
  const dirs = ends.map((e) => dirOf(byId.get(e.wallId)!));

  // Suche das (näherungsweise) kollineare Paar: |cos(Winkel der Achsen)| ≈ 1.
  let throughPair: [number, number] | null = null;
  for (let i = 0; i < 3 && !throughPair; i++) {
    for (let k = i + 1; k < 3; k++) {
      if (1 - Math.abs(dot(dirs[i], dirs[k])) < 1e-6) {
        throughPair = [i, k];
        break;
      }
    }
  }
  if (!throughPair) return; // kein eindeutiger Durchgang erkennbar

  const branchIdx = [0, 1, 2].find(
    (i) => i !== throughPair![0] && i !== throughPair![1],
  )!;
  const branchEnd = ends[branchIdx];
  const throughEnd = ends[throughPair[0]];
  const branchWall = byId.get(branchEnd.wallId)!;
  const throughWall = byId.get(throughEnd.wallId)!;

  const j = throughEnd.end === "start" ? throughWall.start : throughWall.end;
  const tT = wallTypeThickness(getWallType(project, throughWall));
  const uT = dirOf(throughWall);
  const nT = leftNormal(uT);
  const offT = wallReferenceOffset(throughWall, tT);

  // Auslaufrichtung des Abzweigs vom Knoten weg, in seinen eigenen Körper
  // (gleiche Konvention wie dA/dB in miterLine).
  const dBranch =
    branchEnd.end === "start"
      ? dirOf(branchWall)
      : scale(dirOf(branchWall), -1);

  // Zugewandte Fläche: die Seite der Durchgangsachse, zu der der Abzweig
  // zeigt (positive nT-Seite, wenn der Abzweig dorthin ausläuft).
  const sign = dot(nT, dBranch) >= 0 ? 1 : -1;
  const facePoint = add(j, scale(nT, offT + sign * (tT / 2)));

  setCut(result, branchEnd, { point: facePoint, dir: uT });
}

/**
 * Fall 2 — Mittelspannen-T-Stoß: prüft, ob das freie Wandende `freeEnd` auf
 * die innere Spanne einer anderen Wand trifft (projizierter Parameter im
 * Inneren, nicht an deren Endpunkten) und dabei senkrecht nah genug an deren
 * Achse liegt (≤ halbe Dicke + Toleranz). Bei Treffer bekommt das freie Ende
 * einen Schnitt entlang der zugewandten Fläche der getroffenen Wand; bei
 * mehreren Treffern gewinnt die nächstliegende Wand.
 */
function applyMidSpanTee(
  project: Project,
  byId: Map<string, Wall>,
  walls: Wall[],
  freeEnd: WallEnd,
  result: Map<string, WallCuts>,
): void {
  const freeWall = byId.get(freeEnd.wallId)!;
  const p = freeEnd.end === "start" ? freeWall.start : freeWall.end;

  const endGap = 1e-4; // Mindestabstand zu den Wandenden für „innere Spanne"
  const tol = 1e-3; // Toleranz für den senkrechten Abstand zur Wandfläche

  let best: { wall: Wall; perp: number; dist: number } | null = null;
  for (const w of walls) {
    if (w.id === freeWall.id) continue;
    const u = dirOf(w);
    const wLen = len(sub(w.end, w.start));
    if (wLen < 1e-9) continue;

    const rel = sub(p, w.start);
    const distAlong = dot(rel, u);
    if (distAlong <= endGap || distAlong >= wLen - endGap) continue; // an Endpunkt, kein Mittelspann

    const perp = dot(rel, leftNormal(u));
    const tw = wallTypeThickness(getWallType(project, w));
    const dist = Math.abs(perp);
    if (dist > tw / 2 + tol) continue;

    if (!best || dist < best.dist) best = { wall: w, perp, dist };
  }
  if (!best) return; // kein Treffer → rechtwinklig

  const w = best.wall;
  const tw = wallTypeThickness(getWallType(project, w));
  const uW = dirOf(w);
  const nW = leftNormal(uW);
  const offW = wallReferenceOffset(w, tw);
  const sign = best.perp >= 0 ? 1 : -1;
  const facePoint = add(w.start, scale(nW, offW + sign * (tw / 2)));

  setCut(result, freeEnd, { point: facePoint, dir: uW });
}
