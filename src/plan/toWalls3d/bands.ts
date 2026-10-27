// Wand-Domäne der 3D-Ableitung (SCHICHTEN → Bänder → Boxen, siehe Moduldoc in
// `../../toWalls3d.ts`): löst den Schichtaufbau EINER Wand in quer zur Dicke
// gestapelte Materialbänder auf und emittiert daraus Wandkörper — inklusive
// aller materialbewussten Verschneidungen (Gehrungs-/Anschluss-Cuts an L-/
// T-Stössen, Durchgangswand-Span-Cutouts, Decken-Dominanz pro Schicht, Dach-
// Unterkanten-Kappung). Das 3D-Pendant zu `generatePlan/walls.ts::addWallPoche`.

import type {
  Ceiling,
  Layer,
  Project,
  SliceTermination,
  Vec2,
  Wall,
} from "../../model/types";
import {
  getCeilingType,
  getComponent,
  getWallType,
  getWindowType,
  openingsOfWall,
  roofLayers,
  wallTypeThickness,
} from "../../model/types";
import { ceilingVerticalExtent, wallReferenceOffset, wallVerticalExtent } from "../../model/wall";
import { pointInOutline } from "../../geometry/ceiling";
import { openingInterval, openingVerticalExtent } from "../../geometry/opening";
import { roofBaseElevation, roofGeometry, roofUndersideAt } from "../../geometry/roof";
import type { RoofGeometry } from "../../geometry/roof";
import type { WallCuts } from "../../model/joins";
import { add, dot, leftNormal, lineIntersect, scale, sub } from "../../model/geometry";
import type { Line } from "../../model/geometry";
import {
  WALL_RGB,
  dominantLayerColor,
  dominantLayerHatch,
  hexToRgb,
  resolveComponentHatch,
  resolveComponentMaterialLayer,
  resolveCutLineStyle,
  EPS,
  type RCutMeta,
  type RHatch,
  type RHole,
  type RRgb,
  type RWall,
} from "./shared";

/**
 * Achswinkel einer GESCHNITTENEN Wand im Schnitt-Koordinatensystem (Modell-
 * Konvention, identisch zu `SECTION_WALL_AXIS_ANGLE_DEG` in toSection.ts): das
 * Wand-Band steht vertikal (Achse entlang v, atan2(1,0) = 90°). Damit drehen
 * `relativeToWall`-Muster (Dämmung, Backstein) im 3D-Schnitt genauso mit der Wand
 * wie im 2D-Schnitt (`splitWallLayers` → `resolveHatch(…, 90, …)`). Für DECKEN gibt
 * es keinen Wandachsen-Bezug — dort bleibt der Winkel absolut (`emitSlabs` ruft
 * `resolveComponentHatch` ohne Achswinkel, wie `splitSlabLayers` → `resolveHatch(…,
 * undefined, …)`), sodass die liegende Boden-Dämmung vertikal statt horizontal läuft.
 */
const SECTION_WALL_AXIS_ANGLE_DEG = 90;

/**
 * Eine quer zur Wanddicke gestapelte Materiallage als 3D-Band: eigene Dicke,
 * Materialfarbe und Mitten-Versatz `offset` (Meter, entlang der Wand-Normalen,
 * relativ zur Wandachse). Jede solche Lage wird pro Achsen-Teilquader zu einer
 * eigenen Voll-Box (siehe {@link emitWall}/{@link pushSegment}).
 */
interface WallBand {
  thickness: number;
  color: RRgb;
  offset: number;
  /** Schnitt-Schraffur des Band-Bauteils (siehe {@link RHatch}). */
  hatch?: RHatch;
  /** Material-Textur-Ebene des Band-Bauteils (1-basiert, siehe `wallMaterialColorMaps`). */
  materialIndex?: number;
  /**
   * Verschneidungs-Rang dieser Materiallage (`Component.joinPriority`) — treibt
   * die per-Schicht-Dominanz gegen Decken im layered-3D-Pfad (s.
   * {@link collectCeilingCutters}/{@link emitWall}): eine Decke mit STRIKT höherer
   * `joinPriority` schneidet nur die Bänder mit niedrigerem Rang aus ihrem
   * z-Intervall (der Kern höherer Priorität läuft durch). `undefined` (kein
   * auflösbarer WallType / synthetisches Fallback-Band) ⇒ keine Decken-
   * Subtraktion (konservativ, wie das frühere Trim-Verhalten bei unbekanntem Typ).
   */
  priority?: number;
  /**
   * Bauteil-Identität dieser Materiallage (`Component.id`) — treibt die MERGE-Regel
   * der Schnitt-Boolean-Dominanz (gleiche Komponente + Priorität verschmelzen, keine
   * innere Trennlinie). Reist als `RCutMeta.componentId` mit.
   */
  componentId?: string;
  /** Farbe der Schnitt-Umrisslinie dieser Schicht (aus `jointLineStyleId`, sonst Default). */
  cutLineColor?: RRgb;
  /** Strichstärke der Schnitt-Umrisslinie in mm-Papier (aus `jointLineStyleId`, sonst Default). */
  cutLineWeight?: number;
}

/**
 * Baut die {@link RCutMeta}-Nutzlast eines Wand-Bandes (Priorität/Identität/
 * Schnittkanten-Stil), oder `undefined`, wenn das Band keinerlei Schnitt-Metadaten
 * trägt (z. B. das Fallback-Vollkörper-Band ohne auflösbaren WallType). Nur gesetzte
 * Felder werden übernommen, damit `#[serde(default)]` auf der Rust-Seite greift.
 */
function bandCutMeta(b: WallBand): RCutMeta | undefined {
  const meta: RCutMeta = {};
  if (b.priority !== undefined) meta.joinPriority = b.priority;
  if (b.componentId !== undefined) meta.componentId = b.componentId;
  if (b.cutLineColor !== undefined) meta.lineColor = b.cutLineColor;
  if (b.cutLineWeight !== undefined) meta.lineWeight = b.cutLineWeight;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * Löst den Schichtstapel EINER Wand auf: je Materiallage ein {@link WallBand}
 * mit ihrer Dicke, Component-Farbe und dem Mitten-Versatz entlang der Normalen.
 * Die Versätze zentrieren den Stapel um die Wandachse UND verschieben ihn um
 * {@link wallReferenceOffset} (`Wall.referenceLine`/`referenceOffset` — links/
 * Mitte/rechts/frei), damit die Achse bei „außen"/„innen" tatsächlich auf der
 * gewählten Wandfläche liegt statt immer mittig — dieselbe Grösse, die der 2D-
 * Plan (`generatePlan/walls.ts`) UND die Gehrungs-/Anschluss-Cuts an Ecken
 * (`model/joins.ts::miterLine`) bereits verwenden. Bis 2026-08-30 rechnete
 * dieser Pfad NICHT damit (Bug: Wände mit `referenceLine !== "center"` sassen
 * im Standard-3D mittig, obwohl die Eckenverschneidung schon den Versatz
 * annahm → Geraden und Ecken liefen auseinander). Als Gesamtdicke T dient die
 * SUMME der tatsächlichen Lagen-Dicken (nicht `wallTypeThickness`, falls es
 * abweicht) — so schließen die Bänder lückenlos aneinander an. Kein auflösbarer
 * WallType / keine Lagen ⇒ EIN Vollkörper-Band über die volle Dicke im
 * neutralen Grundton (heutiges Fallback-Verhalten), ebenfalls Referenz-versetzt.
 */
function resolveWallBands(project: Project, wall: Wall, layered = true): WallBand[] {
  try {
    const wt = getWallType(project, wall);
    if (wt.layers.length > 0) {
      // Gesamtdicke = Summe der Lagen (konsistent mit den Offsets); wenn diese
      // von wallTypeThickness abwiche, gewinnt die Lagen-Summe (keine Lücken).
      const total = wt.layers.reduce((s, l) => s + l.thickness, 0);
      const refOff = wallReferenceOffset(wall, total);
      // Schnitt-Eingabe (layered=false): EINE Voll-Box über die ganze Dicke statt
      // je Lage eine Box. So bleibt die Emission 1:1 Wand→Rechteck — passend zu
      // `wallSegmentOwners`/`splitWallLayers` in toSection.ts, die die Schicht-
      // Zerlegung TS-seitig aus diesem einen Rechteck machen. (Der 3D-Viewer ruft
      // mit Default layered=true auf und bekommt unverändert die Schicht-Bänder.)
      if (!layered) {
        const dominant = wt.layers.reduce((best, l) => (l.thickness > best.thickness ? l : best));
        return [
          {
            thickness: total,
            color: dominantLayerColor(wt.layers, project, WALL_RGB),
            offset: refOff,
            hatch: dominantLayerHatch(wt.layers, project, SECTION_WALL_AXIS_ANGLE_DEG),
            materialIndex: resolveComponentMaterialLayer(project, dominant.componentId),
          },
        ];
      }
      const bands: WallBand[] = [];
      let prefix = 0;
      for (const l of wt.layers) {
        const comp = getComponent(project, l.componentId);
        const color = hexToRgb(comp.color);
        const lineStyle = resolveCutLineStyle(project, l.jointLineStyleId);
        bands.push({
          thickness: l.thickness,
          color,
          offset: refOff - total / 2 + prefix + l.thickness / 2,
          priority: comp.joinPriority,
          componentId: comp.id,
          cutLineColor: lineStyle?.color,
          cutLineWeight: lineStyle?.weight,
          hatch: resolveComponentHatch(project, l.componentId, SECTION_WALL_AXIS_ANGLE_DEG),
          materialIndex: resolveComponentMaterialLayer(project, l.componentId),
        });
        prefix += l.thickness;
      }
      return bands;
    }
    // WallType ohne Schichten: EIN Vollkörper über die Typ-Gesamtdicke.
    const total = wallTypeThickness(wt);
    return [{ thickness: total, color: WALL_RGB, offset: wallReferenceOffset(wall, total) }];
  } catch {
    // Kein auflösbarer WallType: EIN Vollkörper mit Default-Dicke/Grundton.
    const total = 0.2;
    return [{ thickness: total, color: WALL_RGB, offset: wallReferenceOffset(wall, total) }];
  }
}

/**
 * Setzt `topAngle` (Draufsicht): wie der 2D-Grundriss — das Muster folgt der Wandachse
 * (`relativeToWall`), `resolveHatch` zieht den Wandwinkel ab (SVG-Konvention, y nach unten);
 * render3d rechnet in Modell-Winkeln (gegen den Uhrzeigersinn), daher das Vorzeichen.
 */
function withTopAngle(h: RHatch, dx: number, dy: number): RHatch {
  if (h.baseAngle === undefined) return h;
  const wallAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const svgAngle = h.relativeToWall ? h.baseAngle - wallAngle : h.baseAngle;
  // Parallel-/Kreuzschar (diagonal=2, crosshatch=3): die 2D-Kachel trägt bei Winkel 0 eine
  // SENKRECHTE Musterlinie (glPlanHatch: Basisrichtung (0,−1)), der 3D-Shader bei Winkel 0
  // eine HORIZONTALE → um 90° versetzen. Die Dämmungs-Welle (4) läuft in beiden entlang u.
  const quarter = h.pattern === 2 || h.pattern === 3 ? 90 : 0;
  return { ...h, topAngle: -svgAngle + quarter };
}

/**
 * Hängt eine Wand-Schicht-Box an: das Achsenstück [from..to] (Meter ab
 * Wand-Startpunkt) über den Höhenbereich [zBottom..zTop], quer um `normalOffset`
 * Meter entlang der Wand-Normalen versetzt (Schichtmitte relativ zur Achse) und
 * mit Schicht-`thickness`/`color`. Entartete Stücke (Länge ≤ 0 oder Höhe ≤ 0)
 * werden übersprungen — so überleben Öffnungen dicht an den Wandenden ohne
 * Nullquader.
 *
 * Optionale `holes`: echte rechteckige Aussparungen in DIESER Box (siehe
 * {@link RHole}). Ihre `from`/`to` sind Achsen-Meter ab Wand-Start (dieselbe
 * Achse wie `from`/`to` dieser Box), `zBottom`/`zTop` absolute Weltmeter — beides
 * unverändert an render3d durchgereicht (der Querversatz `normalOffset` wirkt nur
 * senkrecht zur Achse und lässt die Loch-Parametrisierung unberührt). Werden nur
 * im 3D-Pfad (voller Achsen-Quader) gesetzt.
 */
function pushSegment(
  out: RWall[],
  wall: Wall,
  from: number,
  to: number,
  zBottom: number,
  zTop: number,
  thickness: number,
  normalOffset: number,
  color: RRgb,
  wallId: string,
  hatch?: RHatch,
  materialIndex?: number,
  holes?: RHole[],
  cut?: RCutMeta,
  topDrop?: [number, number],
): void {
  if (to - from <= EPS) return;
  if (zTop - zBottom <= EPS) return;
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return;
  const ux = dx / len;
  const uy = dy / len;
  // LINKE Grundriss-Normale (identisch zu `leftNormal(u)` = (−uy, ux) in
  // generatePlan.ts/clippedBand — dieselbe Konvention, die addWallPoche für
  // den Schichtstapel im 2D-Grundriss benutzt). Der Schicht-Versatz verschiebt
  // Start/Ende der Box quer zur Wand, sodass render3d die Box um ihre eigene
  // (versetzte) Achse zentriert aufbaut — mit dieser Normale liegt Schicht 0
  // (Aussenseite, kleinster `offset`) auf derselben Weltseite wie im Grundriss.
  // Bewusst NICHT identisch zur Normale, die raycast3d/selectionHighlightLines
  // für den Box-Rebuild nutzen (n = (uy, −ux), rechte Normale) — das ist
  // unschädlich, weil jene Boxen symmetrisch um die (hier bereits versetzte)
  // Achse jedes einzelnen Layer-Records aufgebaut werden und daher unabhängig
  // von der Vorzeichen-Konvention des Versatzes sind.
  const ox = -uy * normalOffset;
  const oy = ux * normalOffset;
  const p1: [number, number] = [wall.start.x + ux * from + ox, wall.start.y + uy * from + oy];
  const p2: [number, number] = [wall.start.x + ux * to + ox, wall.start.y + uy * to + oy];
  out.push({
    start: p1,
    end: p2,
    thickness,
    height: zTop - zBottom,
    baseElevation: zBottom,
    ...(topDrop && (topDrop[0] > EPS || topDrop[1] > EPS) ? { topDrop } : {}),
    color,
    layers: [],
    wallId,
    ...(hatch ? { hatch: withTopAngle(hatch, dx, dy) } : {}),
    ...(materialIndex != null ? { materialIndex } : {}),
    ...(holes && holes.length > 0 ? { holes } : {}),
    ...(cut ? { cut } : {}),
  });
}

/**
 * Achsenparalleles Grundriss-Rechteck (min/max je Achse), Meter, Modell-XY.
 * Dient hier NUR der groben Footprint-Überlapp-Prüfung Wand↔Decke (s.
 * {@link collectCeilingCutters}) — kein exakter Polygon-Test, siehe dort.
 */
interface Bounds2 {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Bounding-Box der Wandachse, um `halfThickness` in beide Richtungen geweitet
 * (sichere Über-Approximation des tatsächlichen Wandkörpers, unabhängig von
 * dessen Orientierung). */
function wallFootprintBounds(wall: Wall, halfThickness: number): Bounds2 {
  return {
    minX: Math.min(wall.start.x, wall.end.x) - halfThickness,
    maxX: Math.max(wall.start.x, wall.end.x) + halfThickness,
    minY: Math.min(wall.start.y, wall.end.y) - halfThickness,
    maxY: Math.max(wall.start.y, wall.end.y) + halfThickness,
  };
}

/** Bounding-Box eines geschlossenen Umrisses (Decke). */
function outlineBounds(outline: Array<{ x: number; y: number }>): Bounds2 {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of outline) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

/** Überlappen sich zwei Bounding-Boxen (mit EPS-Toleranz an den Rändern)? */
function boundsOverlap(a: Bounds2, b: Bounds2): boolean {
  return (
    a.minX <= b.maxX + EPS &&
    a.maxX >= b.minX - EPS &&
    a.minY <= b.maxY + EPS &&
    a.maxY >= b.minY - EPS
  );
}

/**
 * Dicke einer Wand für die Footprint-Näherung (s. {@link wallFootprintBounds}):
 * Summe der WallType-Schichtdicken, sonst der Fallback-Grundton-Dicke aus
 * {@link resolveWallBands} (0.2 m), falls kein WallType auflösbar ist. Auch von
 * `../openings.ts::resolveOpeningFrame` genutzt (Rahmen-Tiefe auf die Wanddicke
 * klemmen).
 */
export function wallThicknessSafe(project: Project, wall: Wall): number {
  try {
    return wallTypeThickness(getWallType(project, wall));
  } catch {
    return 0.2;
  }
}

/**
 * Repräsentative `joinPriority` einer Decke (höchste ihrer Schichten) — bestimmt,
 * ob die Decke am Wand/Decke-Stoss "durchläuft" (gewinnt) und in die Wandschichten
 * niedrigerer Priorität einschneidet (s. {@link collectCeilingCutters}).
 */
function ceilingDominantPriority(project: Project, ceiling: Ceiling): number | undefined {
  try {
    const ct = getCeilingType(project, ceiling);
    let best: number | undefined;
    for (const layer of ct.layers) {
      const p = getComponent(project, layer.componentId).joinPriority;
      if (best === undefined || p > best) best = p;
    }
    return best;
  } catch {
    return undefined;
  }
}

/**
 * Ein Decken-„Cutter": vertikales z-Intervall + Dominanz-Rang + Grundriss-Umriss
 * (s. {@link collectCeilingCutters}). Der `outline` erlaubt die PER-BAND-genaue
 * Überdeckungsprüfung in {@link emitWall} (statt eines wandweiten BBox-Tests): eine
 * Decke schneidet ein Schicht-Band nur dort, wo ihre Outline die Footprint-
 * Mittellinie des Bandes im Grundriss überdeckt.
 */
interface CeilingCutter {
  zBottom: number;
  zTop: number;
  priority: number;
  outline: Vec2[];
}

/**
 * Sammelt die Decken, die eine Wand im layered-3D-Pfad PRO SCHICHT einschneiden —
 * die 3D-Entsprechung der Schnitt-Boolean-Dominanz (`toSection.ts::
 * subtractDominantBands`): statt die GANZE Wand am Deckenanschluss zu kappen
 * (früheres `trimWallTopForCeilings`), behält die Wand ihre volle Höhe und JEDES
 * Schicht-Band verliert nur das z-Intervall der Decken mit STRIKT höherer
 * `joinPriority` als das Band (der Kern höherer Priorität läuft durch die Decke).
 * Ein Band kann dadurch vertikal in zwei Boxen zerfallen (unter Deckenunterkante
 * + über Deckenoberkante, falls die Wand die Decke überragt).
 *
 * Kriterien je Decke (alle müssen zutreffen):
 *  • dasselbe Geschoss (`ceiling.floorId === wall.floorId`),
 *  • vertikale Überlappung mit der (vollen) Wand-Ausdehnung,
 *  • grober Footprint-Überlapp (Bounding-Box, s. {@link boundsOverlap}) — nur ein
 *    billiger Vor-Filter (keine Wand berührt, wenn die Wand-BBox die Decken-BBox
 *    nicht schneidet); die EXAKTE, per-Band geometrische Überdeckung entscheidet
 *    dann in {@link emitWall} (s. {@link bandCoverageIntervals}).
 *  • auflösbare Decken-`joinPriority` (`ceilingDominantPriority`).
 *
 * Das z-Intervall/die Priorität der Cutter ist PER DECKENSCHICHT (nicht die ganze
 * Decke als EIN Block der dominanten Priorität): jede Deckenschicht wird zu einem
 * eigenen Cutter mit IHREM z-Band (proportional auf [zBottom,zTop] verteilt, exakt
 * wie `../ceilings.ts::emitSlabs`) und IHRER `Component.joinPriority`. Das ist
 * zwingend, damit der 3D-Cut EXAKT wie der 2D-Schnitt (`toSection.ts::
 * subtractDominantBands`) verschneidet: dort trägt jede Schicht ihre eigene
 * Priorität. Mit dem früheren EINEN Block (dominante Prio 100 über die volle
 * Decke) verlor z. B. der Backstein (50) das GANZE Decken-z-Band [UK,OK] —
 * obwohl er die schwimmenden Deckenschichten Estrich (30)/Dämmung (20)
 * ÜBERRAGEN und schneiden soll; nur die Betonschicht (100) darf ihn kappen. So
 * blieb im 3D (Solid UND Schnitt) über dem Backstein eine Lücke, durch die
 * Estrich/Dämmung „rausliefen" (Nutzer-Bug). Per Schicht läuft der Backstein
 * zwischen Beton-OK und Wandkopf durch und schneidet dort Estrich/Dämmung weg —
 * identisch zum 2D-Schnitt. Der `outline` reist mit, damit {@link emitWall} PRO
 * BAND prüft, ob die Decke die Footprint-Mittellinie dieses Bandes überdeckt
 * (geometrischer Überlapp, kein wandweiter BBox-Test). Der Prioritätsvergleich pro
 * Band passiert in {@link emitWall} (`cutter.priority > band.priority`) — eine
 * Wand-Schicht mit ≥ Rang der jeweiligen Deckenschicht läuft durch deren z-Band durch.
 * Ein-Schicht-/nicht auflösbare Deckentypen fallen auf EINEN Cutter über die volle
 * Ausdehnung mit der dominanten Priorität zurück (Alt-Verhalten).
 */
function collectCeilingCutters(
  project: Project,
  wall: Wall,
  zBottom: number,
  zTop: number,
): CeilingCutter[] {
  const halfThickness = wallThicknessSafe(project, wall) / 2;
  const wallBounds = wallFootprintBounds(wall, halfThickness);
  const cutters: CeilingCutter[] = [];
  for (const c of project.ceilings ?? []) {
    if (c.floorId !== wall.floorId) continue;
    if (!c.outline || c.outline.length < 3) continue;
    const cExtent = ceilingVerticalExtent(project, c);
    if (cExtent.zBottom >= zTop - EPS || cExtent.zTop <= zBottom + EPS) continue;
    if (!boundsOverlap(wallBounds, outlineBounds(c.outline))) continue;

    // Per-Schicht-Cutter: je Deckenschicht ein eigenes z-Band + eigene Priorität
    // (proportional auf die tatsächliche Decken-z-Spanne skaliert, oben→unten wie
    // emitSlabs). Nur so schneidet Beton (100) den Backstein (50), Backstein aber
    // Estrich (30)/Dämmung (20) — identisch zu subtractDominantBands.
    let layers: Layer[] | undefined;
    try {
      layers = getCeilingType(project, c).layers;
    } catch {
      layers = undefined;
    }
    const total = layers?.reduce((s, l) => s + l.thickness, 0) ?? 0;
    if (layers && layers.length > 0 && total > EPS) {
      const span = cExtent.zTop - cExtent.zBottom;
      let prefixTop = 0; // von OK (zTop) nach unten aufsummiert (Meter)
      for (const l of layers) {
        const t = (l.thickness / total) * span;
        const layerTop = cExtent.zTop - prefixTop;
        const layerBottom = layerTop - t;
        prefixTop += t;
        let prio: number | undefined;
        try {
          prio = getComponent(project, l.componentId).joinPriority;
        } catch {
          prio = undefined;
        }
        if (prio === undefined) continue;
        cutters.push({ zBottom: layerBottom, zTop: layerTop, priority: prio, outline: c.outline });
      }
    } else {
      const ceilingPriority = ceilingDominantPriority(project, c);
      if (ceilingPriority === undefined) continue;
      cutters.push({ zBottom: cExtent.zBottom, zTop: cExtent.zTop, priority: ceilingPriority, outline: c.outline });
    }
  }
  return cutters;
}

/**
 * Achsen-Teilintervalle (Meter ab `wall.start` entlang `u`, geklemmt auf
 * `[lo,hi]`), auf denen die MITTELLINIE eines Schicht-Bands (Querversatz
 * `bandOffset` entlang `n = leftNormal(u)`) im Decken-Umriss `outline` liegt —
 * die per-Band-Entsprechung des geometrischen Rechteck-Überlapps in
 * `toSection.ts::subtractDominantBands`. Nur diese Teilintervalle bekommen später
 * den Decken-z-Schnitt; unbedeckte Achsenabschnitte behalten die volle Höhe (so
 * laufen Dämmung/Aussenputz, deren Mittellinie AUSSERHALB des Decken-Umrisses
 * liegt, ununterbrochen durch — der Nutzer-Bug „Kranz durch die Dämmung").
 *
 * Die Bandmittellinie wird entlang der Achse gerastert (~5-cm-Schritte, min. 32)
 * und gegen {@link pointInOutline} geprüft; Innen/Aussen-Übergänge werden per
 * Bisektion auf ~EPS verfeinert, sodass die Überdeckungsgrenzen scharf sind (auch
 * eine Decke, die nur einen Teil der Wandlänge überdeckt, wird korrekt getrimmt).
 */
function bandCoverageIntervals(
  wall: Wall,
  u: Vec2,
  n: Vec2,
  bandOffset: number,
  outline: Vec2[],
  lo: number,
  hi: number,
): Array<[number, number]> {
  if (hi - lo <= EPS) return [];
  const base = add(wall.start, scale(n, bandOffset));
  const inside = (t: number): boolean => pointInOutline(add(base, scale(u, t)), outline);
  const steps = Math.max(32, Math.ceil((hi - lo) / 0.05));
  const dt = (hi - lo) / steps;
  const intervals: Array<[number, number]> = [];
  let prevInside = inside(lo);
  let start: number | null = prevInside ? lo : null;
  let prevT = lo;
  for (let i = 1; i <= steps; i++) {
    const t = i === steps ? hi : lo + i * dt;
    const now = inside(t);
    if (now !== prevInside) {
      const cross = bisectBoundary(inside, prevT, t);
      if (now) start = cross;
      else if (start !== null) {
        intervals.push([start, cross]);
        start = null;
      }
    }
    prevInside = now;
    prevT = t;
  }
  if (start !== null) intervals.push([start, hi]);
  return intervals;
}

/**
 * Bisektion des Innen/Aussen-Übergangs der Bandmittellinie zwischen `a` und `b`
 * (verschiedene {@link pointInOutline}-Seiten) auf ~EPS-Genauigkeit — liefert die
 * scharfe Achsen-Position der Überdeckungsgrenze.
 */
function bisectBoundary(inside: (t: number) => boolean, a: number, b: number): number {
  const aInside = inside(a);
  let lo = a;
  let hi = b;
  for (let i = 0; i < 40 && hi - lo > EPS * 0.01; i++) {
    const mid = (lo + hi) / 2;
    if (inside(mid) === aInside) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Zieht die Cutter-Intervalle `holes` vom Intervall `[lo,hi]` ab und liefert die
 * verbleibenden Teil-Intervalle (Meter). Löcher werden auf `[lo,hi]` geklemmt,
 * sortiert und vereinigt; leeres `holes` ⇒ exakt `[[lo,hi]]` (unveränderter Fall).
 * Dient sowohl der Achsen-Zerlegung durch Durchgangswand-Span-Cutouts als auch
 * der vertikalen Decken-Subtraktion (identische 1D-Semantik wie
 * `generatePlan/walls.ts::subtractIntervals`, hier lokal gehalten).
 */
function subtractSpans(lo: number, hi: number, holes: Array<[number, number]>): Array<[number, number]> {
  const clipped = holes
    .map(([a, b]): [number, number] => [Math.max(lo, Math.min(a, b)), Math.min(hi, Math.max(a, b))])
    .filter(([a, b]) => b > a + EPS)
    .sort((p, q) => p[0] - q[0]);
  const parts: Array<[number, number]> = [];
  let cursor = lo;
  for (const [a, b] of clipped) {
    if (a > cursor + EPS) parts.push([cursor, a]);
    if (b > cursor) cursor = b;
  }
  if (cursor < hi - EPS) parts.push([cursor, hi]);
  return parts;
}

/**
 * Wendet die Decken-z-Cutter `cutters` (dominante horizontale Cut-Bänder [zBottom,
 * zTop]) auf das Wandband-Intervall `[lo,hi]` an — je nach Terminierungs-Regel der
 * Wand (`Wall.sliceTermination`). Bewusst als EIGENER, klar benannter Schritt
 * neben der Priorität gehalten (Terminierung = Zuschnitt, KEINE Prioritätsregel):
 *
 *   • "both"/undefined ⇒ heutiges Verhalten: `subtractSpans` stanzt jedes Cutter-
 *     z-Band aus (oben+unten Reste bleiben erhalten). Bit-identisch zu vorher.
 *   • "below" ⇒ die Wand ENDET an der Decke: alles AB der Decken-UNTERKANTE wird
 *     verworfen (kein über der Decke wieder auftauchender Rest). Clip-Grenze = das
 *     KLEINSTE `zBottom` aller dominanten Cutter dieses Bandes. Da die dominanteste
 *     (tragende) Deckenschicht — z. B. Beton (Prio 100) — jedes schwächere Band
 *     kappt UND zugleich die unterste Deckenlage ist, terminieren so ALLE Bänder
 *     einheitlich an der Deckenunterkante (kein Durchstoss/Staffel, keine
 *     Interpenetration mit Beton/Dämmung darüber). Für den Backstein, den nur der
 *     Beton kappt, ist das exakt „unter dem dominanten Cut" (dessen Unterkante).
 *   • "above" ⇒ spiegelbildlich: alles BIS zur Decken-OBERKANTE wird verworfen.
 *     Clip-Grenze = das GRÖSSTE `zTop` aller dominanten Cutter dieses Bandes.
 *
 * Ohne Cutter (`cutters` leer) bleibt `[lo,hi]` in allen Modi unverändert — ein
 * Band ausserhalb des Decken-Umrisses (Aussenputz/Dämmung) läuft also weiter voll
 * durch, unabhängig von der Terminierung.
 */
function terminateOrSubtractSpans(
  lo: number,
  hi: number,
  cutters: Array<[number, number]>,
  termination: SliceTermination | undefined,
): Array<[number, number]> {
  if (cutters.length === 0) return [[lo, hi]];
  if (termination === "below") {
    // Deckenunterkante = kleinstes zBottom der Cutter; die Wand endet dort.
    let clipTop = Infinity;
    for (const [cb] of cutters) clipTop = Math.min(clipTop, cb);
    const top = Math.min(clipTop, hi);
    return top > lo + EPS ? [[lo, top]] : [];
  }
  if (termination === "above") {
    // Deckenoberkante = grösstes zTop der Cutter; die Wand beginnt dort.
    let clipBottom = -Infinity;
    for (const [, ct] of cutters) clipBottom = Math.max(clipBottom, ct);
    const bottom = Math.max(clipBottom, lo);
    return bottom < hi - EPS ? [[bottom, hi]] : [];
  }
  return subtractSpans(lo, hi, cutters);
}

/**
 * Achsen-Distanz (Meter ab `wall.start` entlang der Wandrichtung `u`), an der die
 * MITTELLINIE eines Schicht-Bands (Querversatz `bandOffset` entlang `leftNormal(u)`)
 * die Gehrungs-/Anschluss-Schnittlinie `cut` trifft — die 3D-Achsenbox-Entsprechung
 * des 2D-`clippedBand`. Da die Box achsparallel endet (keine gekippte Stirnfläche),
 * wird die Band-Länge auf den Schnittpunkt der MITTELLINIE gekürzt/verlängert; die
 * beiden 2D-Bandkanten (bei ±thickness/2) treffen die Schnittlinie an leicht
 * versetzten Achsenpunkten — der Box-Wert ist ihr Mittelwert. `null` bei
 * (nahezu) parallelem Schnitt (kollineare Achsen) ⇒ Aufrufer behält das Bandende.
 */
function bandCutDistance(wall: Wall, u: Vec2, n: Vec2, bandOffset: number, cut: Line): number | null {
  const base = add(wall.start, scale(n, bandOffset));
  const hit = lineIntersect(base, u, cut.point, cut.dir);
  if (!hit) return null;
  return dot(sub(hit, wall.start), u);
}

/** Schrittweite (Meter) der Dach-Unterkanten-Annäherung, s. {@link clipPieceToRoofs}. */
const ROOF_CLIP_STEP = 0.15;

/**
 * Kappt ein Wand-Achsenstück [a,bb] (z-Bereich [zb,zt]) an der Dach-UNTERKANTE
 * (falls ein Dach darüber liegt) und emittiert es via `emit` — in FEINE Achsen-
 * Schritte (~{@link ROOF_CLIP_STEP}) zerlegt, je Schritt auf die dort gemessene
 * Dach-Unterkante geklemmt. Das ist eine TREPPENSTUFEN-Annäherung an eine echte
 * geneigte Giebelwand-Stirnfläche (render3d-Wandkörper (`RWall`) haben nur einen
 * FLACHEN Top — echte Schrägflächen bräuchten einen neuen Mesh-Pfad); bei der
 * gewählten Schrittweite optisch glatt genug UND behebt das eigentliche Problem
 * (Wand durchdringt die Dachfläche → Z-Fighting, s. PENDENZEN.md „Dach-Wand-
 * Verschneidung"), ohne render3d/Rust anzufassen.
 *
 * Ohne Dächer (oder keinem, das dieses Wandstück überdeckt) läuft das Stück
 * UNVERÄNDERT als EIN Body durch (kein Overhead im Normalfall).
 */
function clipPieceToRoofs(
  project: Project,
  wall: Wall,
  u: Vec2,
  n: Vec2,
  bandOffset: number,
  a: number,
  bb: number,
  zb: number,
  zt: number,
  emit: (a: number, bb: number, zb: number, ztStart: number, ztEnd: number) => void,
): void {
  if (zt - zb <= EPS || bb - a <= EPS) return;
  const nrm = n;
  const wallBounds = wallFootprintBounds(wall, Math.abs(bandOffset) + 0.01);
  const roofs = (project.roofs ?? []).filter((r) => {
    if (r.floorId !== wall.floorId) return false;
    const eavesZ = roofBaseElevation(project, r);
    // Grober Höhen-Ausschluss: Dach-Traufe weit unter dem Wandstück ⇒ kann nicht
    // schneiden (übliche Dächer haben keine nach unten ausufernden Übermasse).
    return eavesZ + 50 >= zb; // grosszügige Schranke statt exakter First-Höhe
  });
  if (roofs.length === 0) {
    emit(a, bb, zb, zt, zt);
    return;
  }
  const roofData = roofs
    .map((r) => {
      const eavesZ = roofBaseElevation(project, r);
      const geo = roofGeometry(r, eavesZ);
      if (!boundsOverlap(wallBounds, outlineBounds(geo.eaves))) return null;
      const total = roofLayers(project, r).reduce((s, l) => s + Math.max(0, l.thickness), 0);
      return { geo, total };
    })
    .filter((d): d is { geo: RoofGeometry; total: number } => d !== null);
  if (roofData.length === 0) {
    emit(a, bb, zb, zt, zt);
    return;
  }

  // Oberkante entlang der Achse abtasten (Dach-Unterkante ist stückweise linear in `u`) …
  const span = bb - a;
  const count = Math.max(1, Math.ceil(span / ROOF_CLIP_STEP));
  const topAt = (t: number): number => {
    // Randpunkte minimal nach innen: auf der Dachkante selbst liefert die Unterkante `null`.
    const tt = Math.min(bb - 1e-3, Math.max(a + 1e-3, t));
    const p = add(add(wall.start, scale(u, tt)), scale(nrm, bandOffset));
    let clip = zt;
    for (const { geo, total } of roofData) {
      const under = roofUndersideAt(geo, total, p.x, p.y);
      if (under !== null && under < clip) clip = under;
    }
    return Math.max(zb, clip);
  };
  const ts: number[] = [];
  const tops: number[] = [];
  for (let i = 0; i <= count; i++) {
    ts.push(a + (span * i) / count);
    tops.push(topAt(ts[i]));
  }
  // … und zu geraden Stücken zusammenfassen (Toleranz 2 mm): jedes Stück ist ein Körper mit
  // schräger Oberkante (`topDrop`), die Knicke (First, Grat) sind die Stückgrenzen.
  const TOL = 0.002;
  const runs: Array<{ i0: number; i1: number }> = [];
  let i0 = 0;
  while (i0 < count) {
    let i1 = i0 + 1;
    while (i1 < count) {
      const k = i1 + 1;
      const slope = (tops[k] - tops[i0]) / (ts[k] - ts[i0]);
      let ok = true;
      for (let m = i0 + 1; m <= k && ok; m++) ok = Math.abs(tops[i0] + slope * (ts[m] - ts[i0]) - tops[m]) <= TOL;
      if (!ok) break;
      i1 = k;
    }
    runs.push({ i0, i1 });
    i0 = i1;
  }
  // Knick exakt als Schnitt der Nachbargeraden setzen (statt auf dem Abtastpunkt).
  const cuts: number[] = [a];
  const line = (r: { i0: number; i1: number }) => {
    const m = (tops[r.i1] - tops[r.i0]) / (ts[r.i1] - ts[r.i0]);
    return { m, c: tops[r.i0] - m * ts[r.i0] };
  };
  for (let r = 0; r + 1 < runs.length; r++) {
    const l1 = line(runs[r]);
    const l2 = line(runs[r + 1]);
    const lo = ts[runs[r].i1 - 1];
    const hi = ts[Math.min(count, runs[r].i1 + 1)];
    let x = ts[runs[r].i1];
    if (Math.abs(l1.m - l2.m) > 1e-9) {
      const cx = (l2.c - l1.c) / (l1.m - l2.m);
      if (cx >= lo && cx <= hi) x = cx;
    }
    cuts.push(x);
  }
  cuts.push(bb);
  const valueAt = (r: { i0: number; i1: number }, x: number): number => {
    const l = line(r);
    return Math.min(zt, Math.max(zb, l.m * x + l.c));
  };
  runs.forEach((r, k) => {
    const sa = cuts[k];
    const sb = cuts[k + 1];
    if (sb - sa <= EPS) return;
    const z0 = valueAt(r, sa);
    const z1 = valueAt(r, sb);
    if (Math.max(z0, z1) - zb > EPS) emit(sa, sb, zb, z0, z1);
  });
}

/**
 * Emittiert die Wandkörper EINER Wand (mit oder ohne Öffnungen).
 *
 * ZWEI PFADE je `layered`:
 *  • layered=true (3D-Viewer, Default): EIN Körper pro Schicht-Band über die
 *    VOLLE Achse mit allen Öffnungen als echte `holes` (render3d stanzt sie in
 *    die Langseiten). Ermöglicht auch versetzt übereinanderliegende Fenster in
 *    EINEM Körper (keine Segment-Nähte).
 *  • layered=false (Schnitt-Pfad, `computeSection`): UNVERÄNDERTE Pfeiler/
 *    Brüstung/Sturz-Segmentierung (EIN Voll-Band je Segment), damit die
 *    `ComponentRef.index`-Reihenfolge exakt zu `toSection.ts::wallSegmentOwners`
 *    passt (Owner-Kompatibilität; toSection.ts bleibt unangetastet). Löcher
 *    werden hier NICHT emittiert.
 */
export function emitWall(out: RWall[], project: Project, wall: Wall, layered = true, cuts?: WallCuts): void {
  const bands = resolveWallBands(project, wall, layered);
  const { zBottom, zTop } = wallVerticalExtent(project, wall);
  // Anders als früher (`trimWallTopForCeilings` kappte im layered-Pfad die GANZE
  // Wand an der Deckenunterkante) behält die Wand jetzt IN BEIDEN PFADEN ihre
  // volle Höhe; die per-Schicht-Decken-Subtraktion (unten, nur layered) schneidet
  // Bänder niedrigerer Priorität im Decken-z-Band aus — die 3D-Entsprechung der
  // Schnitt-Boolean-Dominanz. Der Schnitt-Pfad (layered=false) bleibt unverändert
  // (volle Rohgeometrie; seine Dominanz macht toSection.ts::subtractDominantBands).
  const axisLen = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  if (axisLen < 1e-9 || zTop - zBottom <= EPS) return;

  // Ein Achsen-Teilquader × jede Materiallage = eine Box (Schichtstapel quer
  // zur Wanddicke). Alle tragen die Wand-Id, sodass ein Klick auf irgendeine
  // Schicht die GANZE Wand selektiert und das Highlight alle Bänder umrandet.
  const emitSeg = (from: number, to: number, zb: number, zt: number): void => {
    for (const b of bands) {
      pushSegment(out, wall, from, to, zb, zt, b.thickness, b.offset, b.color, wall.id, b.hatch, b.materialIndex, undefined, bandCutMeta(b));
    }
  };

  // Aussparungen der Wand als vereinheitlichte Cutouts sammeln:
  //   • Öffnungen (project.openings: Fenster und Türen, mit Brüstung/Sturz).
  // Jeweils [from..to] auf die Achse geklemmt + vertikale Öffnungs-Ausdehnung.
  const cutouts: Array<{
    from: number;
    to: number;
    oBottom: number;
    oTop: number;
    /** Schicht-Rücksprung der innersten Schicht an DIESER Öffnung (nur Fenster
     *  mit `WindowType.innerLayerRecess`), s. Moduldoc unten. */
    recessInnerLayer: boolean;
  }> = [];
  for (const op of openingsOfWall(project, wall.id)) {
    const iv = openingInterval(wall, op);
    if (!iv) continue;
    const v = openingVerticalExtent(project, wall, op);
    const recessInnerLayer =
      op.kind === "window" && getWindowType(project, op)?.innerLayerRecess === true;
    cutouts.push({ from: iv.from, to: iv.to, oBottom: v.zBottom, oTop: v.zTop, recessInnerLayer });
  }
  cutouts.sort((a, b) => a.from - b.from);

  // ── 3D-Viewer-Pfad (layered=true): EIN Körper je Schicht-Band über die volle
  // Achse mit allen Öffnungen als echte Löcher (render3d stanzt sie), PLUS die
  // materialbewussten Verschneidungen (identisch zum 2D-Grundriss/Schnitt):
  //   1. End-Cuts/Merge an L-/T-Stössen: jede Schicht wird an ihrem Achsenende an
  //      der Gehrungs-/Anschluss-Schnittlinie individuell gekürzt/verlängert
  //      (`WallCuts.startCut`/`endCut`, bzw. pro Schicht `layerCuts.start/end` —
  //      merge: Kern läuft bis zur Rückgrat-Nahfläche durch; trim: Putz stoppt an
  //      der Wandoberfläche). Wie im 2D wird die Band-MITTELLINIE geschnitten.
  //   2. Durchgangswand-Span-Cutouts: der Nah-Putz einer Durchgangswand wird über
  //      die Achsen-Breite des durchstechenden Abzweig-Kerns ausgeschnitten — ein
  //      Band zerfällt dabei entlang der Achse in mehrere Teilstücke.
  //   3. Decken-Dominanz pro Schicht: Bänder niedrigerer `joinPriority` verlieren
  //      das z-Intervall überlappender Decken (vertikaler Split), der Kern läuft
  //      durch (s. {@link collectCeilingCutters}).
  // Die Öffnungs-Löcher (`holes`, Achsen-Meter ab Wand-Start) werden je Teilstück
  // auf dessen Achsen-Start umgerechnet (rebased), damit render3d sie relativ zum
  // jeweiligen Box-Start korrekt stanzt.
  if (layered) {
    const holes: (RHole & { recessInnerLayer: boolean })[] = cutouts.map((c) => ({
      from: c.from,
      to: c.to,
      zBottom: c.oBottom,
      zTop: c.oTop,
      recessInnerLayer: c.recessInnerLayer,
    }));
    const startCut = cuts?.startCut ?? null;
    const endCut = cuts?.endCut ?? null;
    const layerCuts = cuts?.layerCuts;
    const spanCutouts = cuts?.spanCutouts ?? [];
    const ux = (wall.end.x - wall.start.x) / axisLen;
    const uy = (wall.end.y - wall.start.y) / axisLen;
    const u: Vec2 = { x: ux, y: uy };
    const n = leftNormal(u); // (-uy, ux) — dieselbe Konvention wie pushSegment/2D.
    const ceilingCutters = collectCeilingCutters(project, wall, zBottom, zTop);

    for (let li = 0; li < bands.length; li++) {
      const b = bands[li];
      // (1) Per-Schicht-Cuts an den Achsenden. `layerCuts` (materialbewusster
      // T-Stoss) überschreibt — wo gesetzt — den einheitlichen start/endCut PRO
      // Schicht; `null` an einem Index heisst „keine Kürzung an diesem Ende".
      // Exakt die 2D-Wahl aus generatePlan/walls.ts::addWallPoche.
      const sCut = layerCuts ? layerCuts.start[li] : startCut;
      const eCut = layerCuts ? layerCuts.end[li] : endCut;
      let from0 = 0;
      let to0 = axisLen;
      if (sCut) {
        const d = bandCutDistance(wall, u, n, b.offset, sCut);
        if (d !== null) from0 = d;
      }
      if (eCut) {
        const d = bandCutDistance(wall, u, n, b.offset, eCut);
        if (d !== null) to0 = d;
      }

      // (2) Span-Cutouts, deren Quer-Offsetbereich dieses Band schneidet, brechen
      // die Achse [from0,to0] auf (Nah-Putz-Durchstoss der Durchgangswand).
      const bandLo = b.offset - b.thickness / 2;
      const bandHi = b.offset + b.thickness / 2;
      const axisHoles: Array<[number, number]> = [];
      for (const c of spanCutouts) {
        const cLo = Math.min(c.offA, c.offB);
        const cHi = Math.max(c.offA, c.offB);
        if (bandLo < cHi - EPS && bandHi > cLo + EPS) axisHoles.push([c.from, c.to]);
      }
      const axisPieces = subtractSpans(from0, to0, axisHoles);

      // (3) Decken-Subtraktion GEOMETRISCH pro Band (Replik der Schnitt-Boolean-
      // Dominanz `toSection.ts::subtractDominantBands`): eine Decke mit STRIKT
      // höherer Priorität schneidet dieses Band nur dort aus, wo ihr Grundriss-
      // Umriss die Footprint-MITTELLINIE dieses Bandes überdeckt (nicht mehr der
      // wandweite BBox-Test). Aussenschichten (Dämmung/Aussenputz), deren
      // Mittellinie ausserhalb des Decken-Umrisses liegt, laufen ununterbrochen
      // durch — nur der überdeckte Kern verliert das Decken-z-Intervall. Ohne
      // auflösbare Band-Priorität bleibt die volle Höhe (konservativ).
      const bandZCuts: Array<{ from: number; to: number; zBottom: number; zTop: number }> = [];
      if (b.priority !== undefined) {
        for (const cc of ceilingCutters) {
          if (cc.priority <= b.priority) continue;
          for (const [ca, cb] of bandCoverageIntervals(wall, u, n, b.offset, cc.outline, from0, to0)) {
            bandZCuts.push({ from: ca, to: cb, zBottom: cc.zBottom, zTop: cc.zTop });
          }
        }
      }

      // Öffnungs-Löcher, die ein z-Teilstück vertikal berühren, auf den Box-Start
      // `a` umrechnen (render3d klemmt u/z selbst auf die Box). An der INNERSTEN
      // Schicht (li = letztes Band) weicht das Loch bei Fenstern mit
      // `WindowType.innerLayerRecess` rundum um die eigene Schichtdicke zurück
      // (Schicht-Rücksprung an der Laibung) — die anderen Schichten bleiben bündig.
      const isInnermostBand = li === bands.length - 1;
      const recessDepth = b.thickness;
      const emitPiece = (a: number, bb: number, zb: number, ztStart: number, ztEnd: number): void => {
        const zt = Math.max(ztStart, ztEnd);
        const segHoles = holes
          .filter((h) => h.zTop > zb + EPS && h.zBottom < zt - EPS)
          .map((h) => {
            const widen = isInnermostBand && h.recessInnerLayer;
            return widen
              ? {
                  from: h.from - a - recessDepth,
                  to: h.to - a + recessDepth,
                  zBottom: h.zBottom - recessDepth,
                  zTop: h.zTop + recessDepth,
                }
              : { from: h.from - a, to: h.to - a, zBottom: h.zBottom, zTop: h.zTop };
          });
        if (segHoles.length > 0 && Math.abs(ztStart - ztEnd) > EPS) {
          // Schräge Oberkante und Löcher im selben Körper geht nicht (render3d): gestuft annähern.
          const k = Math.max(1, Math.ceil((bb - a) / ROOF_CLIP_STEP));
          for (let i = 0; i < k; i++) {
            const sa = a + ((bb - a) * i) / k;
            const sb = a + ((bb - a) * (i + 1)) / k;
            const zm = ztStart + ((ztEnd - ztStart) * (i + 0.5)) / k;
            emitPiece(sa, sb, zb, zm, zm);
          }
          return;
        }
        const drop: [number, number] = [zt - ztStart, zt - ztEnd];
        pushSegment(out, wall, a, bb, zb, zt, b.thickness, b.offset, b.color, wall.id, b.hatch, b.materialIndex, segHoles, bandCutMeta(b), drop);
      };

      for (const [a, bb] of axisPieces) {
        // Nur die Decken-z-Schnitte, die dieses Achsen-Teilstück wirklich treffen.
        const local = bandZCuts
          .map((c) => ({ from: Math.max(a, c.from), to: Math.min(bb, c.to), zBottom: c.zBottom, zTop: c.zTop }))
          .filter((c) => c.to > c.from + EPS);
        if (local.length === 0) {
          // Kein Decken-Überlapp auf diesem Achsenstück ⇒ volle Höhe (Band läuft
          // durch) — ausser ein Dach kappt den Top (s. {@link clipPieceToRoofs}).
          clipPieceToRoofs(project, wall, u, n, b.offset, a, bb, zBottom, zTop, emitPiece);
          continue;
        }
        // Achse [a,bb] an allen Überdeckungs-Grenzen in elementare Teilstücke
        // zerlegen; je Teilstück nur die dort greifenden Decken-z-Intervalle
        // subtrahieren (unbedeckte Teilstücke behalten die volle Höhe).
        const bounds = new Set<number>([a, bb]);
        for (const c of local) {
          bounds.add(c.from);
          bounds.add(c.to);
        }
        const xs = [...bounds].sort((p, q) => p - q);
        for (let i = 0; i < xs.length - 1; i++) {
          const xa = xs[i];
          const xb = xs[i + 1];
          if (xb - xa <= EPS) continue;
          const mid = (xa + xb) / 2;
          const zCutters = local
            .filter((c) => c.from <= mid && c.to >= mid)
            .map((c): [number, number] => [c.zBottom, c.zTop]);
          // Terminierung (Zuschnitt) statt reiner z-Subtraktion: bei "below"/"above"
          // endet die Wand an der Decke, statt oben wieder aufzutauchen (s.
          // {@link terminateOrSubtractSpans}). "both"/undefined = heutiges Verhalten.
          for (const [zb, zt] of terminateOrSubtractSpans(zBottom, zTop, zCutters, wall.sliceTermination)) {
            clipPieceToRoofs(project, wall, u, n, b.offset, xa, xb, zb, zt, emitPiece);
          }
        }
      }
    }
    return;
  }

  // ── Schnitt-Pfad (layered=false): unveränderte Pfeiler/Brüstung/Sturz-
  // Segmentierung (Owner-Kompatibilität mit toSection.ts::wallSegmentOwners).
  // Ohne Aussparungen: ein durchgehender Quader je Schicht.
  if (cutouts.length === 0) {
    emitSeg(0, axisLen, zBottom, zTop);
    return;
  }

  // Wand entlang der Achse durchlaufen: volle Pfeiler zwischen den Aussparungen,
  // Brüstung/Sturz im Öffnungsbereich. Überlappende Cutouts werden über `cursor`
  // zusammengefasst.
  let cursor = 0;
  for (const { from, to, oBottom, oTop } of cutouts) {
    const segFrom = Math.max(cursor, from);
    if (from > cursor) {
      // Voller Wandpfeiler bis zur Aussparung.
      emitSeg(cursor, from, zBottom, zTop);
    }
    if (to > segFrom) {
      // Brüstung unter der Öffnung (bei Türen entfällt sie, da oBottom == zBottom).
      if (oBottom > zBottom + EPS) {
        emitSeg(segFrom, to, zBottom, oBottom);
      }
      // Sturz über der Öffnung (bis zum Wandkopf).
      if (oTop < zTop - EPS) {
        emitSeg(segFrom, to, oTop, zTop);
      }
    }
    cursor = Math.max(cursor, to);
  }
  // Restlicher Wandpfeiler bis zum Achsenende.
  if (cursor < axisLen) {
    emitSeg(cursor, axisLen, zBottom, zTop);
  }
}
