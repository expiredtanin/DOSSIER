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
 * Berechnet für jede Wand die Gehrungs-Schnittlinien.
 * Nur L-Ecken (genau zwei Wandenden treffen sich) werden behandelt; freie
 * Enden und T-/X-Stöße bleiben rechtwinklig (siehe Kommentare unten).
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
    // Freies Ende → kein Schnitt.
    if (ends.length === 1) continue;
    // T-/X-Stöße (>2 Enden): vorerst rechtwinklig lassen (Folge-Arbeit).
    if (ends.length !== 2) continue;

    const a = byId.get(ends[0].wallId)!;
    const b = byId.get(ends[1].wallId)!;
    const cut = miterLine(project, a, ends[0].end, b);
    if (!cut) continue; // kollinear → kein Schnitt

    setCut(result, ends[0], cut);
    setCut(result, ends[1], cut);
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
