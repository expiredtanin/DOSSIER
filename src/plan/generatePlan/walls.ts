// Wand-Domäne des Grundriss-Generators: Öffnungs-Lücken entlang der Wandachse,
// die Wand-Footprints (für das Verdecken darunterliegender Decken-Umrisse, s.
// {@link ../ceilings}) und die eigentliche Wand-Poché (Schichten + Umriss +
// Öffnungsaussparungen + T-Stoss-/Gehrungs-Behandlung).

import type { LayerCategory, Opening, Project, Vec2, Wall } from "../../model/types";
import { getComponent, getWallType, wallTypeThickness } from "../../model/types";
import { wallReferenceOffset } from "../../model/wall";
import { openingInterval } from "../../geometry/opening";
import {
  add,
  along,
  clippedBand,
  dot,
  leftNormal,
  lineIntersect,
  normalize,
  scale,
  sub,
} from "../../model/geometry";
import type { Line } from "../../model/geometry";
import type { WallCuts } from "../../model/joins";
import {
  HATCH_INK,
  HATCH_PAPER,
  LAYER_DETAIL_FACTOR,
  LAYER_LINE_MM,
  NO_HATCH,
  OUTLINE_DETAIL_FACTOR,
  POCHE_STROKE,
  resolveBackground,
  resolveForeground,
  resolveHatch,
  resolveHatchId,
  type DetailLevel,
  type Primitive,
} from "./shared";

/** Ein Öffnungs-Intervall entlang der Wandachse (from..to in Metern). `headHeight`
 *  = Sturzhöhe (OK der Öffnung über der Wand-UK) für die 3D-Aussparung; im Plan
 *  ungenutzt, aber Teil des gemeinsamen Vertrags mit dem 3D-Pfad. */
export interface WallGap {
  from: number;
  to: number;
}

/**
 * Vereint Legacy-Türen (`Door`) und Öffnungen (`Opening`) einer Wand zu einer
 * sortierten Lücken-Intervall-Liste entlang der Wandachse. Entartete Intervalle
 * (Breite ≤ 0 oder außerhalb der Achse) werden verworfen.
 */
export function wallGaps(
  wall: Wall,
  doors: Project["doors"],
  openings: Opening[],
): WallGap[] {
  const gaps: WallGap[] = [];
  for (const d of doors) gaps.push({ from: d.position, to: d.position + d.width });
  for (const o of openings) {
    const iv = openingInterval(wall, o);
    if (iv) gaps.push(iv);
  }
  return gaps.sort((a, b) => a.from - b.from);
}

/** Toleranz für die Achsen-Intervall-Arithmetik der Durchgangswand-Aussparungen. */
export const CUTOUT_EPS = 1e-9;

/**
 * Zieht die Loch-Intervalle `holes` vom Segment `[s,e]` ab und liefert die
 * verbleibenden (gezeichneten) Teil-Intervalle in Achsen-Metern. Löcher werden
 * auf `[s,e]` geklemmt, sortiert und vereinigt; leeres Ergebnis heisst „ganz
 * ausgespart". Ist `holes` leer, kommt exakt `[[s,e]]` zurück (unverändertes
 * Verhalten für Wände ohne Aussparung).
 */
export function subtractIntervals(
  s: number,
  e: number,
  holes: Array<[number, number]>,
): Array<[number, number]> {
  const clipped = holes
    .map(([a, b]): [number, number] => [
      Math.max(s, Math.min(a, b)),
      Math.min(e, Math.max(a, b)),
    ])
    .filter(([a, b]) => b > a + CUTOUT_EPS)
    .sort((p, q) => p[0] - q[0]);
  const parts: Array<[number, number]> = [];
  let cursor = s;
  for (const [a, b] of clipped) {
    if (a > cursor + CUTOUT_EPS) parts.push([cursor, a]);
    if (b > cursor) cursor = b;
  }
  if (cursor < e - CUTOUT_EPS) parts.push([cursor, e]);
  return parts;
}

/**
 * Wand-Footprint als orientiertes Rechteck (OBB) für das Verdecken der
 * darunterliegenden Decke im Grundriss: Achs-Startpunkt + Einheits-Richtung `u`
 * und -Normale `m`, Halbdicke, Referenz-Querversatz (Wandachse↔Bandmitte) und
 * Achslänge. Die u-Ausdehnung wird beim Test an beiden Enden um die Halbdicke
 * verlängert, damit auch die Eck-Überlappe (Gehrungen) sicher abgedeckt sind.
 */
export interface WallFootprint {
  a: Vec2;
  u: Vec2;
  m: Vec2;
  len: number;
  half: number;
  refOff: number;
}

/** Baut die Wand-Footprints (OBBs) aus den gerenderten Wänden. Nicht auflösbarer
 *  Wandtyp ⇒ Default-Dicke 0.2 m (wie der Vollkörper-Fallback im 3D-Emitter). */
export function buildWallFootprints(project: Project, walls: Wall[]): WallFootprint[] {
  const out: WallFootprint[] = [];
  for (const w of walls) {
    let t = 0.2;
    try {
      t = wallTypeThickness(getWallType(project, w));
    } catch {
      // Default-Dicke behalten.
    }
    const u = normalize(sub(w.end, w.start));
    out.push({
      a: w.start,
      u,
      m: leftNormal(u),
      len: Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y),
      half: t / 2,
      refOff: wallReferenceOffset(w, t),
    });
  }
  return out;
}

/**
 * Parametrisches Intervall [t0,t1] ⊆ [0,1], über das die Strecke `pa→pb`
 * INNERHALB des Wand-Footprints liegt (also von der Wand verdeckt). `null`, wenn
 * die Strecke den Footprint nicht schneidet. OBB-Test über zwei Slabs: Projektion
 * auf die Achse `u` (Bereich [−half, len+half]) und auf die Normale `m` (Bereich
 * [refOff−half, refOff+half]); das Schnitt-Intervall beider Slabs ∩ [0,1] ist die
 * verdeckte Strecke.
 */
export function segmentInsideWallBand(
  pa: Vec2,
  pb: Vec2,
  fp: WallFootprint,
): [number, number] | null {
  const d = sub(pb, pa);
  const rel = sub(pa, fp.a);
  const clipSlab = (
    f0: number,
    fd: number,
    lo: number,
    hi: number,
  ): [number, number] | null => {
    if (Math.abs(fd) < 1e-12)
      return f0 >= lo - CUTOUT_EPS && f0 <= hi + CUTOUT_EPS ? [0, 1] : null;
    let ta = (lo - f0) / fd;
    let tb = (hi - f0) / fd;
    if (ta > tb) [ta, tb] = [tb, ta];
    return [ta, tb];
  };
  const su = clipSlab(dot(rel, fp.u), dot(d, fp.u), -fp.half, fp.len + fp.half);
  if (!su) return null;
  const sm = clipSlab(
    dot(rel, fp.m),
    dot(d, fp.m),
    fp.refOff - fp.half,
    fp.refOff + fp.half,
  );
  if (!sm) return null;
  const t0 = Math.max(0, su[0], sm[0]);
  const t1 = Math.min(1, su[1], sm[1]);
  return t1 > t0 + CUTOUT_EPS ? [t0, t1] : null;
}

const length = (w: Wall): number => Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);

/**
 * Wand als gefüllte Schnittfläche (Poché), um Öffnungen ausgespart.
 *
 * Detailgrad:
 *  • mittel/fein — jede Schicht des Wandtyps als eigenes Band (Füllfarbe +
 *    Schraffur des Bauteils), dazu eine kräftige Wand-Umrisslinie. fein zeichnet
 *    Schichtfugen und Umriss dünner als mittel.
 *  • grob — KEINE Schichten, KEINE Schraffur: eine einzige Sammelfläche über die
 *    volle Wanddicke (Füllung = Farbe des „Backbone"-Bauteils mit höchster
 *    joinPriority) mit dicker Umrisslinie. Bewusst vereinfacht (≙ DOSSIER
 *    „Einfach").
 */
export function addWallPoche(
  out: Primitive[],
  project: Project,
  wall: Wall,
  gaps: WallGap[],
  cuts: WallCuts,
  greyed: boolean,
  detail: DetailLevel,
  wallLwMm: number,
  category: LayerCategory | undefined,
  // Wand liegt GANZ unter der Grundriss-Schnittebene (z. B. 30-cm-Brüstung bei
  // 1 m Schnitthöhe) → „von oben gesehen": nur Ansichts-Umriss (Haarlinie), KEINE
  // Schnitt-Poché/Schraffur/Schichten. Der reguläre Schnittfall bleibt `false`.
  viewOnly: boolean,
): void {
  const wt = getWallType(project, wall);
  const total = wallTypeThickness(wt);
  // Versatz der Schichtstapelung über die Dicke gemäß Referenzlinie (center=0,
  // left=+T/2, right=−T/2). Alle Band-Offsets unten werden hierum verschoben,
  // sodass die Achse bei „außen"/„innen" auf der jeweiligen Wandfläche liegt.
  const refOff = wallReferenceOffset(wall, total);
  // Jede Schicht-/Umrissfläche trägt die Wand-ID, damit ein Links-Klick die
  // GANZE Wand (alle Bänder) markiert und die PlanView die wallId nach oben
  // melden kann.
  const wallId = wall.id;
  // Achswinkel der Wand (Modell, Grad) — treibt wandbezogene Schraffuren
  // ({@link resolveHatch}), damit z. B. eine Diagonale oder die Dämmungsstriche
  // mit der Wandorientierung mitdrehen.
  const wallAngleDeg =
    (Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x) * 180) / Math.PI;
  // Strich-/Umrandungsfarbe der Wand: optionale Übersteuerung (wall.color),
  // sonst der Default-Poché-Strich. Betrifft NUR die Linienfarbe (Umriss +
  // Schichtfugen), nicht die Schicht-Füllfarben/Schraffuren.
  const stroke = wall.color ?? POCHE_STROKE;

  // Öffnungs-Intervalle entlang der Wandachse, sortiert (bereits vereint).
  const openings = gaps;

  // Wand in Segmente zwischen den Öffnungen zerlegen.
  let cursor = 0;
  const segments: Array<[number, number]> = [];
  for (const op of openings) {
    if (op.from > cursor) segments.push([cursor, op.from]);
    cursor = Math.max(cursor, op.to);
  }
  const axisLen = length(wall);
  if (cursor < axisLen) segments.push([cursor, axisLen]);

  const outlineMm = wallLwMm * OUTLINE_DETAIL_FACTOR[detail];
  const layerLineMm = LAYER_LINE_MM * LAYER_DETAIL_FACTOR[detail];
  // Vereinfachte Füllung (grob): immer schwarze Vollfüllung, keine Schraffur

  // Durchgangswand-Aussparungen (Phase 1c): über diese Achsen-Intervalle × Quer-
  // Offsetbereiche wird die Nah-Putz-Zone der Durchgangswand echt ausgeschnitten
  // (der Abzweig-Kern sticht durch). `offA` ist stets die Nahfläche, `offB` die
  // Rückgrat-Nahfläche (siehe SpanCutout in model/joins.ts). Leer ⇒ heutiges
  // Verhalten (Wand ohne T-Durchstoss).
  const spanCutouts = cuts.spanCutouts ?? [];

  // Kanten-Indizes der inneren Gehrungs-Stirnflächen (die Diagonalen am Knoten).
  // clippedBand liefert [A.start, A.end, B.end, B.start] → Kante 1 (A.end→B.end)
  // ist die endCut-Stirnfläche, Kante 3 (B.start→A.start) die startCut-Stirnfläche.
  // Diese werden NICHT umrissen: sonst 45°-Naht zwischen gleichfarbigen Schichten
  // + überschießende Gehrungs-Barbe am Eck-Apex. Freie Enden (kein Cut) bleiben
  // rechtwinklig gestrichen. Die Längskanten (Schichtfugen) bleiben stets sichtbar.
  const joinEdges = (startCut: Line | null, endCut: Line | null): number[] => {
    const e: number[] = [];
    if (endCut) e.push(1);
    if (startCut) e.push(3);
    return e;
  };

  for (const [s, e] of segments) {
    const p1 = along(wall.start, wall.end, s);
    const p2 = along(wall.start, wall.end, e);
    // Nur die echten Wandenden bekommen die Gehrung. Türnahe Segmentenden
    // bleiben rechtwinklig (kein Schnitt).
    const startCut = s <= 1e-6 ? cuts.startCut : null;
    const endCut = e >= axisLen - 1e-6 ? cuts.endCut : null;

    if (viewOnly) {
      // Ansichts-Wand (unter der Schnittebene): ein Umriss über die volle Dicke
      // als Haarlinie, ohne Füllung/Schraffur. Segment-/Gehrungs-/Öffnungs-Logik
      // bleibt dieselbe wie im Schnittfall (nur eben ohne Poché).
      out.push({
        kind: "polygon",
        pts: clippedBand(p1, p2, refOff - total / 2, refOff + total / 2, startCut, endCut),
        fill: "none",
        stroke,
        strokeWidthMm: layerLineMm,
        hatch: NO_HATCH,
        greyed,
        noStrokeEdges: joinEdges(startCut, endCut),
        wallId,
      });
      continue;
    }

    if (detail === "grob") {
      // Eine Sammelfläche über die volle Dicke, ohne Schraffur, dicker Umriss.
      // Bei grob: immer Vollschwarz-Füllung gemäß SIA 400 Anhang B.9, Figur 36
      out.push({
        kind: "polygon",
        pts: clippedBand(p1, p2, refOff - total / 2, refOff + total / 2, startCut, endCut),
        fill: HATCH_INK,
        stroke,
        strokeWidthMm: outlineMm,
        hatch: NO_HATCH,
        greyed,
        noStrokeEdges: joinEdges(startCut, endCut),
        wallId,
      });
      continue;
    }

    // mittel/fein: Schichten von außen (-T/2) nach innen (+T/2) stapeln. Jede
    // Schicht löst Bauteil (Füllfarbe) + Schraffur (Muster/Maßstab/Winkel/Farbe)
    // auf. Die Bänder tragen NUR Füllung + Schraffur (kein eigener Umriss); jede
    // innere Schichtfuge wird als EIGENSTÄNDIGE, stilisierbare Linie gezeichnet.
    const bandJoinEdges = joinEdges(startCut, endCut);
    // Nur die Aussparungen, die dieses Segment [s,e] entlang der Achse berühren.
    const segCutouts = spanCutouts.filter(
      (c) =>
        Math.min(c.from, c.to) < e - CUTOUT_EPS &&
        Math.max(c.from, c.to) > s + CUTOUT_EPS,
    );
    // Punkt entlang der Wandachse bei Achsen-Meter `d` (p1/p2 an den Rändern).
    const axisPt = (d: number): Vec2 =>
      d === s ? p1 : d === e ? p2 : along(wall.start, wall.end, d);
    // Materialbewusster T-Stoss (siehe resolveJoinPriority in model/joins.ts):
    // liegt eine Pro-Schicht-Cut-Überschreibung vor, ersetzt sie PRO SCHICHT den
    // einheitlichen startCut/endCut — nur an den echten Wandenden (dieselbe
    // Maskierung wie oben für startCut/endCut, s <= 1e-6 / e >= axisLen-1e-6).
    // Fehlt sie, bleibt alles wie zuvor (startCut/endCut für jede Schicht).
    const layerCuts = cuts.layerCuts;
    let off = refOff - total / 2;
    for (let li = 0; li < wt.layers.length; li++) {
      const layer = wt.layers[li];
      const comp = getComponent(project, layer.componentId);
      const layerHatchId =
        resolveHatchId(wall.hatchId, wall.hatchSource, category, comp.hatchId) ?? comp.hatchId;
      const layerHatch = resolveHatch(
        project,
        layerHatchId,
        wallAngleDeg,
        resolveForeground(comp, wall.foreground, category, wall.foregroundSource),
      );
      // SIA-Poché: neutraler Hintergrund (Papier) statt Bauteil-Albedo, die
      // Schichtschraffur (fest in HATCH_INK, siehe resolveHatch) liegt darüber;
      // Vollmuster ("solid") = Tinten-Poché.
      const layerSolid = layerHatch.pattern === "solid";
      const bgOverride = resolveBackground(comp, wall.background, category, wall.backgroundSource);
      const layerStartCut = s <= 1e-6 ? (layerCuts ? layerCuts.start[li] : startCut) : null;
      const layerEndCut = e >= axisLen - 1e-6 ? (layerCuts ? layerCuts.end[li] : endCut) : null;
      // Durchgangswand-Aussparung: liegt der Quer-Offsetbereich dieses Bandes
      // [off, off+thickness] im Nah-Putz-Bereich einer Aussparung, wird das Band
      // entlang der Achse in Teil-Bänder VOR/NACH dem Intervall zerlegt (das
      // Durchstoss-Stück entfällt). Ohne Überlappung bleibt genau ein Band
      // [s,e] (unverändertes Verhalten).
      const bandLo = off;
      const bandHi = off + layer.thickness;
      const bandHoles: Array<[number, number]> = [];
      for (const c of segCutouts) {
        const cLo = Math.min(c.offA, c.offB);
        const cHi = Math.max(c.offA, c.offB);
        if (bandLo < cHi - CUTOUT_EPS && bandHi > cLo + CUTOUT_EPS)
          bandHoles.push([c.from, c.to]);
      }
      for (const [a, b] of subtractIntervals(s, e, bandHoles)) {
        const sc = a <= s + CUTOUT_EPS ? layerStartCut : null;
        const ec = b >= e - CUTOUT_EPS ? layerEndCut : null;
        out.push({
          kind: "polygon",
          pts: clippedBand(axisPt(a), axisPt(b), off, off + layer.thickness, sc, ec),
          fill: bgOverride ?? (layerSolid ? HATCH_INK : HATCH_PAPER),
          // Band ohne Umriss: keine Schichtfuge über die Bandkante, keine 45°-Naht
          // am Knoten. Die Fugen kommen als separate `line`-Primitive (siehe unten).
          stroke: "none",
          strokeWidthMm: 0,
          hatch: layerHatch,
          greyed,
          // Für die Ecktests/Konsistenz beibehalten (bei stroke:"none" wirkungslos).
          noStrokeEdges: bandJoinEdges,
          wallId,
        });
      }
      // L-Anschluss: eine getrimmte Schicht (z. B. Putz), die an eine
      // verschmelzende Nachbarschicht (durchlaufender Kern) grenzt, bekommt
      // zusätzlich eine seitliche Cut-Linie entlang der Durchgangsachse — sie
      // begrenzt die Schichtbreite dort, wo der Kern sie unterbricht (L-Form).
      const sideStart = s <= 1e-6 ? layerCuts?.startSide[li] : null;
      const sideEnd = e >= axisLen - 1e-6 ? layerCuts?.endSide[li] : null;
      if (sideStart || sideEnd) {
        const uSeg = normalize(sub(p2, p1));
        const nSeg = leftNormal(uSeg);
        const sidePoint = (base: Vec2, layerOff: number, cut: Line): Vec2 => {
          const pt = add(base, scale(nSeg, layerOff));
          return lineIntersect(pt, uSeg, cut.point, cut.dir) ?? pt;
        };
        if (sideStart) {
          out.push({
            kind: "line",
            a: sidePoint(p1, off, sideStart),
            b: sidePoint(p1, off + layer.thickness, sideStart),
            cls: "layer-joint-l",
            weightMm: layerLineMm,
            color: stroke,
            greyed,
          });
        }
        if (sideEnd) {
          out.push({
            kind: "line",
            a: sidePoint(p2, off, sideEnd),
            b: sidePoint(p2, off + layer.thickness, sideEnd),
            cls: "layer-joint-l",
            weightMm: layerLineMm,
            color: stroke,
            greyed,
          });
        }
      }
      off += layer.thickness;
      // Innere Schichtfuge (zwischen dieser und der nächst-inneren Schicht) als
      // eigene Linie am kumulierten Offset `off`, mit dem Cut der Bänder geclippt.
      // Stil aus layer.jointLineStyleId (Gewicht/Farbe/Strich); Rückfall = Haar-
      // linie (LAYER_LINE_MM) in Wandfarbe. Das Gewicht folgt demselben Detail-
      // Faktor wie die frühere Schichtfuge (`layerLineMm`), damit die Detailgrade
      // sich unverändert verhalten. Die innerste Schicht hat keine innere Fuge.
      // Nutzt bewusst weiterhin den einheitlichen startCut/endCut (nicht die
      // Pro-Schicht-Cuts): die Fuge markiert den Materialwechsel INNERHALB
      // dieser Wand und bleibt daher an der bisherigen Nahfläche.
      if (li < wt.layers.length - 1) {
        const jls = layer.jointLineStyleId
          ? project.lineStyles.find((l) => l.id === layer.jointLineStyleId)
          : undefined;
        // Durchgangswand-Aussparung: liegt die Fuge im (geschlossenen) Nah-Putz-
        // Bereich einer Aussparung — inkl. der Rückgrat-Nahfläche (Merge-Kontakt)
        // —, wird sie über das Durchstoss-Intervall unterbrochen. So bleibt an der
        // Verschmelzungsfläche keine Trennlinie stehen.
        const fugeHoles: Array<[number, number]> = [];
        for (const c of segCutouts) {
          const cLo = Math.min(c.offA, c.offB);
          const cHi = Math.max(c.offA, c.offB);
          if (off >= cLo - CUTOUT_EPS && off <= cHi + CUTOUT_EPS)
            fugeHoles.push([c.from, c.to]);
        }
        for (const [a, b] of subtractIntervals(s, e, fugeHoles)) {
          const sc = a <= s + CUTOUT_EPS ? startCut : null;
          const ec = b >= e - CUTOUT_EPS ? endCut : null;
          // clippedBand(pa, pb, off, off, …) liefert [edgeStart, edgeEnd, edgeEnd,
          // edgeStart] → die zwei distinkten Endpunkte sind Index 0 (Start) und 1
          // (Ende), beide am Cut abgeschnitten wie die Bandlängskante.
          const jq = clippedBand(axisPt(a), axisPt(b), off, off, sc, ec);
          out.push({
            kind: "line",
            a: jq[0],
            b: jq[1],
            cls: "layer-joint",
            weightMm: jls ? jls.weight * LAYER_DETAIL_FACTOR[detail] : layerLineMm,
            color: jls ? jls.color : stroke,
            dash: jls ? jls.dash : null,
            // Zickzack-Fuge (LineStyle kind==="zigzag") ebenfalls durchreichen.
            zigzag: jls?.kind === "zigzag" ? jls.zigzag : undefined,
            // Custom-Motiv-Fuge (LineStyle kind==="custom") ebenfalls durchreichen.
            motif: jls?.kind === "custom" ? jls.motif : undefined,
            greyed,
          });
        }
      }
    }
    // Kräftige Wand-Umrisslinie über die volle Dicke (nur Kontur, keine Füllung),
    // damit die Wand sich klar von den dünnen Schichtfugen abhebt. Die Gehrungs-
    // Stirnkanten am Knoten entfallen → sauberer Eck-Apex ohne überschießende Barbe.
    // Bei einer Durchgangswand-Aussparung wird zusätzlich die NAHFLÄCHEN-Kante
    // (die Längskante auf der Durchstoss-Seite) über [from,to] strokelos gemacht
    // und als separate Segmente vor/nach dem Durchstoss gezeichnet — sonst liefe
    // die Umrisslinie über die Durchstoss-Breite.
    const offLo = refOff - total / 2;
    const offHi = refOff + total / 2;
    const holesHi: Array<[number, number]> = [];
    const holesLo: Array<[number, number]> = [];
    for (const c of segCutouts) {
      // `offA` ist stets die Nahfläche (Wandoberfläche); ordne die Aussparung der
      // passenden Längskante (offHi bzw. offLo) zu.
      if (Math.abs(c.offA - offHi) < 1e-6) holesHi.push([c.from, c.to]);
      else if (Math.abs(c.offA - offLo) < 1e-6) holesLo.push([c.from, c.to]);
    }
    const outlineNoStroke = [...bandJoinEdges];
    // clippedBand-Kantenreihenfolge [A.start(offLo), A.end(offLo), B.end(offHi),
    // B.start(offHi)]: Kante 0 ist die offLo-Längskante, Kante 2 die offHi-Längskante.
    if (holesHi.length) outlineNoStroke.push(2);
    if (holesLo.length) outlineNoStroke.push(0);
    out.push({
      kind: "polygon",
      pts: clippedBand(p1, p2, offLo, offHi, startCut, endCut),
      fill: "none",
      stroke,
      strokeWidthMm: outlineMm,
      hatch: NO_HATCH,
      greyed,
      noStrokeEdges: outlineNoStroke,
      wallId,
    });
    const drawNearEdge = (edgeOff: number, holes: Array<[number, number]>): void => {
      for (const [a, b] of subtractIntervals(s, e, holes)) {
        const sc = a <= s + CUTOUT_EPS ? startCut : null;
        const ec = b >= e - CUTOUT_EPS ? endCut : null;
        const jq = clippedBand(axisPt(a), axisPt(b), edgeOff, edgeOff, sc, ec);
        out.push({
          kind: "line",
          a: jq[0],
          b: jq[1],
          cls: "wall-outline",
          weightMm: outlineMm,
          color: stroke,
          greyed,
        });
      }
    };
    if (holesHi.length) drawNearEdge(offHi, holesHi);
    if (holesLo.length) drawNearEdge(offLo, holesLo);
  }
}

/**
 * Referenzlinie einer Wand: dünne, gestrichelte Achslinie entlang der Wandachse
 * (start → end). Von der Oberleiste umschaltbar; rein darstellend.
 */
export function addReferenceLine(out: Primitive[], wall: Wall, greyed: boolean): void {
  out.push({
    kind: "line",
    a: wall.start,
    b: wall.end,
    cls: "wall-axis",
    weightMm: 0.13,
    dash: [0.18, 0.06, 0.04, 0.06], // Strich-Punkt-Achse in mm Papier
    greyed,
  });
}
