// Wand-Verschneidung (Gehrung): an einer Ecke, wo zwei Wände aufeinander­
// treffen, sollen sich die Schicht-Bänder nicht überlappen, sondern an einer
// gemeinsamen Gehrungslinie sauber stoßen. Dieses Modul berechnet pro Wand
// die optionalen Schnittlinien an Start- und Endpunkt.

import type { Component, Project, Vec2, Wall } from "./types";
import { getComponent, getWallType, wallTypeThickness } from "./types";
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

/**
 * Pro-Schicht-Override der Nahflächen-Cuts (materialbewusster T-Stoss, siehe
 * {@link resolveJoinPriority}). Index = Schicht-Index im Wandtyp DIESER Wand
 * (der Abzweig-Wand). `start`/`end` ersetzen — wo gesetzt — den einheitlichen
 * `startCut`/`endCut` NUR für die jeweilige Schicht; `null` an einem Index
 * heisst: diese Schicht bekommt KEINEN Cut (verschmilzt, läuft durch).
 * `startSide`/`endSide` tragen die zusätzliche seitliche Cut-Linie einer
 * getrimmten Schicht, die an eine verschmelzende Nachbarschicht angrenzt
 * (L-Anschluss, z. B. Putz neben durchlaufendem Backstein-Kern).
 */
export interface LayerCuts {
  start: (Line | null)[];
  end: (Line | null)[];
  startSide: (Line | null)[];
  endSide: (Line | null)[];
}

/**
 * Aussparung der DURCHGANGSWAND an einem materialbewussten T-Stoss: über das
 * Achsen-Intervall `[from,to]` (Meter ab `wall.start` entlang der Achse) und den
 * Quer-Offsetbereich `[offA,offB]` wird die Nah-Putz-Zone der Durchgangswand
 * echt ausgeschnitten, damit der durchstechende Abzweig-Kern (Phase 1b) die
 * Durchgangswand nicht nur übermalt, sondern geometrisch aufbricht.
 *
 * OFFSET-KONVENTION (identisch zu den Schicht-Bändern in `addWallPoche`):
 * `offA`/`offB` sind Querabstände von der Wandachse ENTLANG der linken Normalen
 * `leftNormal(dir)`, inkl. Referenzversatz — also im selben Bereich wie
 * `refOff − total/2` (außen) … `refOff + total/2` (innen). `offA` ist stets die
 * NAHFLÄCHE (Wandoberfläche, `refOff + sign·total/2`), `offB` die dem Abzweig
 * zugewandte Fläche des Rückgrat-KERNS (`refOff + sign·(total/2 − nearPlaster)`)
 * — die Zone dazwischen ist exakt der Nah-Putz, den der Abzweig-Kern durchstösst.
 * `from ≤ to` ist die Projektion der Abzweig-Kernbreite auf die Durchgangsachse.
 */
export interface SpanCutout {
  from: number;
  to: number;
  offA: number;
  offB: number;
}

/** Schnittlinien einer Wand an ihren beiden Achsenden. */
export interface WallCuts {
  startCut: Line | null;
  endCut: Line | null;
  /**
   * Additive Erweiterung: fehlt dieses Feld, gilt weiterhin `startCut`/
   * `endCut` für ALLE Schichten (bisheriges Verhalten, bit-identisch). Wird
   * nur gesetzt, wenn an einem T-Stoss mindestens eine Schicht materialbewusst
   * verschmilzt (siehe {@link resolveJoinPriority}).
   */
  layerCuts?: LayerCuts;
  /**
   * Additive Erweiterung (Durchgangswand-Seite): Aussparungen der Nah-Putz-Zone,
   * durch die ein Abzweig-Kern sticht. Fehlt/leer ⇒ die Wand wird unverändert
   * gezeichnet. Wird nur an der DURCHGANGSWAND gesetzt (nie am Abzweig), analog
   * additiv zu {@link layerCuts}. Siehe {@link SpanCutout}.
   */
  spanCutouts?: SpanCutout[];
}

/**
 * Verschneidungs-Entscheidung zweier Bauteile (Komponenten) am Stoss:
 *  • "merge"   — gleiche Priorität UND gleiche Komponente (z. B. Backstein-
 *    Kern trifft Backstein-Kern): die Schichten verschmelzen, kein Cut.
 *  • "coexist" — gleiche Priorität, aber VERSCHIEDENE Komponente: keine
 *    eindeutige Rangfolge, bleibt beim heutigen (getrimmten) Verhalten.
 *  • "trim-a"  — `b` hat die höhere Priorität und gewinnt; `a` wird getrimmt.
 *  • "trim-b"  — `a` hat die höhere Priorität und gewinnt; `b` wird getrimmt.
 */
export type JoinPriorityResolution = "merge" | "trim-a" | "trim-b" | "coexist";

export function resolveJoinPriority(
  a: Component,
  b: Component,
): JoinPriorityResolution {
  if (a.joinPriority === b.joinPriority) {
    return a.id === b.id ? "merge" : "coexist";
  }
  return a.joinPriority > b.joinPriority ? "trim-b" : "trim-a";
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
  const faceCut: Line = { point: facePoint, dir: uT };

  setCut(result, branchEnd, faceCut);
  applyLayerCuts(project, result, branchEnd, branchWall, throughWall, faceCut, j, uT, sign);
}

/**
 * Materialbewusste Pro-Schicht-Erweiterung eines T-Stoss-Cuts (siehe
 * {@link resolveJoinPriority}): vergleicht jede Schicht der ABZWEIG-Wand mit
 * dem Rückgrat (höchste `joinPriority`) der DURCHGANGSWAND. Verschmilzt eine
 * Schicht (gleiche Komponente + Priorität wie das Rückgrat, oder die
 * Abzweig-Schicht ist sogar prioritärer), bekommt sie einen Cut an der
 * NAHFLÄCHE DES RÜCKGRAT-KERNS der Durchgangswand: der verschmelzende Abzweig-
 * Kern (z. B. Backstein) sticht nur durch den Nah-Putz der Durchgangswand und
 * stoppt am Durchgangs-Kern — er läuft NICHT bis zur Achse durch und überlappt
 * die Durchgangswand nicht (dort verschmelzen die beiden Kerne nahtlos).
 * Getrimmte Schichten, die direkt an eine verschmelzende Nachbarschicht
 * grenzen, bekommen zusätzlich eine seitliche Cut-Linie an eben dieser
 * Rückgrat-Nahfläche (L-Anschluss, z. B. Putz neben durchstechendem Kern).
 *
 * Setzt `WallCuts.layerCuts` NUR, wenn mindestens eine Schicht verschmilzt —
 * sonst bleibt das Feld `undefined` (additiv, bit-identisches Default-
 * Verhalten für den ganz überwiegenden Fall ohne Materialübereinstimmung).
 *
 * `sign` ist die Nahseite der Durchgangswand (der Abzweig-zugewandte `nT`-
 * Vorzeichen, aus {@link applyTJunction}/{@link applyMidSpanTee}); er bestimmt,
 * welche Durchgangswand-Schichten als Nah-Putz vor dem Rückgrat liegen.
 */
function applyLayerCuts(
  project: Project,
  result: Map<string, WallCuts>,
  branchEnd: WallEnd,
  branchWall: Wall,
  throughWall: Wall,
  faceCut: Line,
  axisPoint: Vec2,
  throughDir: Vec2,
  sign: number,
): void {
  const branchWt = getWallType(project, branchWall);
  const throughWt = getWallType(project, throughWall);
  if (branchWt.layers.length === 0 || throughWt.layers.length === 0) return;

  // Rückgrat der Durchgangswand: die Schicht mit der höchsten joinPriority
  // (Index mitgeführt, um die Nah-Putz-Dicke davor zu bestimmen).
  let backbone = getComponent(project, throughWt.layers[0].componentId);
  let backboneIdx = 0;
  for (let i = 0; i < throughWt.layers.length; i++) {
    const c = getComponent(project, throughWt.layers[i].componentId);
    if (c.joinPriority > backbone.joinPriority) {
      backbone = c;
      backboneIdx = i;
    }
  }

  const n = branchWt.layers.length;
  const merged: boolean[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const comp = getComponent(project, branchWt.layers[i].componentId);
    const res = resolveJoinPriority(comp, backbone);
    // "merge": identisches Rückgrat-Material -> durchgehender Kern.
    // "trim-b": die Abzweig-Schicht ist SELBST prioritärer als das Rückgrat
    // der Durchgangswand -> sie gewinnt ebenfalls und läuft durch (die
    // Durchgangswand könnten wir hier nicht schneiden, ausserhalb des Scopes).
    merged[i] = res === "merge" || res === "trim-b";
  }
  if (!merged.some(Boolean)) return; // keine Materialübereinstimmung -> Default

  const cuts = result.get(branchWall.id)!;
  if (!cuts.layerCuts) {
    cuts.layerCuts = {
      start: new Array(n).fill(null),
      end: new Array(n).fill(null),
      startSide: new Array(n).fill(null),
      endSide: new Array(n).fill(null),
    };
  }
  const lc = cuts.layerCuts;
  if (lc.start.length !== n) return; // Schicht-Anzahl passt nicht zusammen (sollte nicht vorkommen)

  const faceArr = branchEnd.end === "start" ? lc.start : lc.end;
  const sideArr = branchEnd.end === "start" ? lc.startSide : lc.endSide;

  // Nahflächen-Cut des verschmelzenden Kerns: von der Durchgangswand-Nahfläche
  // (`offT + sign·tT/2`) um die Nah-Putz-Dicke nach innen versetzt — also genau
  // die dem Abzweig zugewandte Fläche des Rückgrat-Kerns. Nah-Putz = Summe der
  // Durchgangswand-Schichten, die zwischen der Nahseite (sign) und dem Rückgrat
  // liegen. Die Schichten stapeln entlang +nT (Index 0 = −tT/2); auf der
  // +nT-Nahseite (sign>0) sind das die Schichten HINTER dem Rückgrat
  // (Index > backboneIdx), auf der −nT-Nahseite die davor (Index < backboneIdx).
  const tT = wallTypeThickness(throughWt);
  const offT = wallReferenceOffset(throughWall, tT);
  let nearPlaster = 0;
  for (let i = 0; i < throughWt.layers.length; i++) {
    if (sign > 0 ? i > backboneIdx : i < backboneIdx)
      nearPlaster += throughWt.layers[i].thickness;
  }
  const nT = leftNormal(throughDir);
  const mergePoint = add(
    axisPoint,
    scale(nT, offT + sign * (tT / 2 - nearPlaster)),
  );
  const mergeCut: Line = { point: mergePoint, dir: throughDir };

  // Getrimmte Nachbarschichten schließen mit ihrer L-Seitenlinie an eben dieser
  // Rückgrat-Nahfläche (nicht an der Wandachse) — dort endet der Kern und die
  // Nachbarschicht kappt ihre Breite.
  const sideLine: Line = mergeCut;

  for (let i = 0; i < n; i++) {
    faceArr[i] = merged[i] ? mergeCut : faceCut;
    const adjMerged =
      !merged[i] && ((i > 0 && merged[i - 1]) || (i < n - 1 && merged[i + 1]));
    sideArr[i] = adjMerged ? sideLine : null;
  }

  // Durchgangswand-Aussparung (Phase 1c): den Nah-Putz der Durchgangswand über
  // die Breite des durchstechenden Abzweig-Kerns ECHT ausschneiden. Nur nötig,
  // wenn davor überhaupt Nah-Putz liegt (nearPlaster > 0) — sonst schliesst der
  // Kern flächenbündig an und es gibt nichts aufzubrechen.
  if (nearPlaster > 1e-9) {
    // Kernbreite des Abzweigs im Quer-Offset (Offset-Konvention der Bänder:
    // gestapelt entlang leftNormal ab refOff − total/2). Die verschmelzenden
    // Schichten (`merged`) bilden den Kern; Lo/Hi = ihre Offset-Hülle.
    const totalBranch = wallTypeThickness(branchWt);
    const refOffBranch = wallReferenceOffset(branchWall, totalBranch);
    let bOff = refOffBranch - totalBranch / 2;
    let coreLo = Infinity;
    let coreHi = -Infinity;
    for (let i = 0; i < n; i++) {
      const th = branchWt.layers[i].thickness;
      if (merged[i]) {
        if (bOff < coreLo) coreLo = bOff;
        if (bOff + th > coreHi) coreHi = bOff + th;
      }
      bOff += th;
    }
    if (coreHi > coreLo) {
      // Projektion der Kern-Offsethülle auf die Durchgangsachse: der Achsenpunkt
      // liegt bei `axisAt` (Meter ab Durchgangs-Start), ein Abzweig-Offset `o`
      // verschiebt sich entlang der Achse um `o · (nBranch · uT)`.
      const nBranch = leftNormal(dirOf(branchWall));
      const proj = dot(nBranch, throughDir);
      const axisAt = dot(sub(axisPoint, throughWall.start), throughDir);
      const e1 = axisAt + coreLo * proj;
      const e2 = axisAt + coreHi * proj;
      // Quer-Offsetbereich = Nah-Putz-Zone der Durchgangswand: Nahfläche (offA)
      // bis Rückgrat-Nahfläche (offB, = mergeCut-Offset). Beide in derselben
      // Offset-Konvention wie die Schicht-Bänder der Durchgangswand.
      const offA = offT + sign * (tT / 2);
      const offB = offT + sign * (tT / 2 - nearPlaster);
      const throughCuts = result.get(throughWall.id);
      if (throughCuts) {
        (throughCuts.spanCutouts ??= []).push({
          from: Math.min(e1, e2),
          to: Math.max(e1, e2),
          offA,
          offB,
        });
      }
    }
  }
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

  let best: { wall: Wall; perp: number; dist: number; distAlong: number } | null = null;
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

    if (!best || dist < best.dist) best = { wall: w, perp, dist, distAlong };
  }
  if (!best) return; // kein Treffer → rechtwinklig

  const w = best.wall;
  const tw = wallTypeThickness(getWallType(project, w));
  const uW = dirOf(w);
  const nW = leftNormal(uW);
  const offW = wallReferenceOffset(w, tw);
  const sign = best.perp >= 0 ? 1 : -1;
  const facePoint = add(w.start, scale(nW, offW + sign * (tw / 2)));
  const faceCut: Line = { point: facePoint, dir: uW };

  setCut(result, freeEnd, faceCut);
  // Achsenpunkt auf der getroffenen Wand, auf Höhe der Projektion des freien
  // Endes (nicht zwingend w.start) — Anker für die materialbewusste
  // Pro-Schicht-Erweiterung (analog zum T-Knoten-Fall).
  const axisPoint = add(w.start, scale(uW, best.distAlong));
  applyLayerCuts(project, result, freeEnd, freeWall, w, faceCut, axisPoint, uW, sign);
}
