// Wand-Domäne der 3D-Ableitung (SCHICHTEN → Bänder → Boxen, siehe Moduldoc in
// `../../toWalls3d.ts`): löst den Schichtaufbau EINER Wand in quer zur Dicke
// gestapelte Materialbänder auf und emittiert daraus Wandkörper — inklusive
// aller materialbewussten Verschneidungen (Gehrungs-/Anschluss-Cuts an L-/
// T-Stössen, Durchgangswand-Span-Cutouts, Decken-Dominanz pro Schicht, Dach-
// Unterkanten-Kappung mit schräger Oberkante). Das 3D-Pendant zu
// `generatePlan/walls.ts::addWallPoche`.
//
// Gerechnet wird im Rust-Kern (`src-tauri/core/src/wall_bands.rs`); hier bleiben
// das Sammeln aus dem `Project` (Wandtyp, Öffnungen, Decken- und Dachaufbau,
// Höhen), die flache Übergabe und die Darstellungs-Metadaten je Band (Farbe,
// Schraffur, Material, Schnitt-Stil).

import type { Project, Wall } from "../../model/types";
import {
  getCeilingType,
  getComponent,
  getWallType,
  getWindowType,
  openingsOfWall,
  roofLayers,
  wallTypeThickness,
} from "../../model/types";
import { ceilingVerticalExtent, wallVerticalExtent } from "../../model/wall";
import { openingInterval, openingVerticalExtent } from "../../geometry/opening";
import { roofBaseElevation, roofGeometry, roofPlanesFlat } from "../../geometry/roof";
import { writeWallCuts, type WallCuts } from "../../model/joins";
import { FlatReader, FlatWriter } from "../../geometry/coreFlat";
import { core } from "../../engine/coreWasm";
import {
  WALL_RGB,
  dominantLayerColor,
  dominantLayerHatch,
  hexToRgb,
  resolveComponentHatch,
  resolveComponentMaterialLayer,
  resolveCutLineStyle,
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
 * Eine quer zur Wanddicke gestapelte Materiallage als 3D-Band: eigene Dicke und
 * Materialfarbe. Den Mitten-Versatz (Stapel um die Achse, Referenzlinie) rechnet
 * der Kern (`wall_bands.rs`); jede Lage wird dort pro Achsen-Teilstück zu einer
 * eigenen Voll-Box.
 */
interface WallBand {
  thickness: number;
  color: RRgb;
  /** Schnitt-Schraffur des Band-Bauteils (siehe {@link RHatch}). */
  hatch?: RHatch;
  /** Material-Textur-Ebene des Band-Bauteils (1-basiert, siehe `wallMaterialColorMaps`). */
  materialIndex?: number;
  /**
   * Verschneidungs-Rang dieser Materiallage (`Component.joinPriority`) — treibt
   * die per-Schicht-Dominanz gegen Decken im layered-3D-Pfad (s. `wall_bands.rs`):
   * eine Decke mit STRIKT höherer
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
 * mit ihrer Dicke und Component-Farbe (`stacked: true`). Der Kern stapelt die
 * Lagen um die Wandachse und verschiebt den Stapel um den Referenzversatz
 * (`Wall.referenceLine`/`referenceOffset`), wie der 2D-Plan und die Gehrungs-
 * Cuts. Gesamtdicke = SUMME der Lagen-Dicken (lückenlos). Kein auflösbarer
 * WallType / keine Lagen ⇒ EIN Vollkörper-Band über die volle Dicke im neutralen
 * Grundton (`stacked: false`, ebenfalls Referenz-versetzt).
 */
function resolveWallBands(project: Project, wall: Wall, layered = true): { bands: WallBand[]; stacked: boolean } {
  try {
    const wt = getWallType(project, wall);
    if (wt.layers.length > 0) {
      // Gesamtdicke = Summe der Lagen (konsistent mit den Offsets); wenn diese
      // von wallTypeThickness abwiche, gewinnt die Lagen-Summe (keine Lücken).
      const total = wt.layers.reduce((s, l) => s + l.thickness, 0);
      // Schnitt-Eingabe (layered=false): EINE Voll-Box über die ganze Dicke statt
      // je Lage eine Box. So bleibt die Emission 1:1 Wand→Rechteck — passend zu
      // `wallSegmentOwners`/`splitWallLayers` in toSection.ts, die die Schicht-
      // Zerlegung TS-seitig aus diesem einen Rechteck machen. (Der 3D-Viewer ruft
      // mit Default layered=true auf und bekommt unverändert die Schicht-Bänder.)
      if (!layered) {
        const dominant = wt.layers.reduce((best, l) => (l.thickness > best.thickness ? l : best));
        const band: WallBand = {
          thickness: total,
          color: dominantLayerColor(wt.layers, project, WALL_RGB),
          hatch: dominantLayerHatch(wt.layers, project, SECTION_WALL_AXIS_ANGLE_DEG),
          materialIndex: resolveComponentMaterialLayer(project, dominant.componentId),
        };
        return { bands: [band], stacked: false };
      }
      const bands: WallBand[] = [];
      for (const l of wt.layers) {
        const comp = getComponent(project, l.componentId);
        const color = hexToRgb(comp.color);
        const lineStyle = resolveCutLineStyle(project, l.jointLineStyleId);
        bands.push({
          thickness: l.thickness,
          color,
          priority: comp.joinPriority,
          componentId: comp.id,
          cutLineColor: lineStyle?.color,
          cutLineWeight: lineStyle?.weight,
          hatch: resolveComponentHatch(project, l.componentId, SECTION_WALL_AXIS_ANGLE_DEG),
          materialIndex: resolveComponentMaterialLayer(project, l.componentId),
        });
      }
      return { bands, stacked: true };
    }
    // WallType ohne Schichten: EIN Vollkörper über die Typ-Gesamtdicke.
    return { bands: [{ thickness: wallTypeThickness(wt), color: WALL_RGB }], stacked: false };
  } catch {
    // Kein auflösbarer WallType: EIN Vollkörper mit Default-Dicke/Grundton.
    return { bands: [{ thickness: 0.2, color: WALL_RGB }], stacked: false };
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
 * Dicke einer Wand für die grobe Grundriss-Hülle (Decken-Vorfilter im Kern):
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

/** `Wall.sliceTermination` → Kodierung im Kern (0 = beide/Standard). */
const TERMINATION = { below: 1, above: 2 } as const;

/**
 * Schreibt Decken und Dächer EINES Geschosses (Kodierung `wall_bands.rs`): Decken
 * mit z-Ausdehnung, Umriss und Schichten samt Rang (NaN = Bauteil unbekannt,
 * Typ-Flag 0 = Deckentyp unbekannt); Dächer mit Traufhöhe, Schichtdicke, Traufe
 * und Flächen. Ob und wo eine Decke ein Band schneidet bzw. ein Dach die Oberkante
 * kappt, entscheidet der Kern.
 */
function writeFloor(w: FlatWriter, project: Project, floorId: string | undefined): void {
  const ceilings = (project.ceilings ?? []).filter((c) => c.floorId === floorId && c.outline && c.outline.length >= 3);
  w.num(ceilings.length);
  for (const c of ceilings) {
    const ext = ceilingVerticalExtent(project, c);
    w.num(ext.zBottom, ext.zTop).ring(c.outline);
    let layers;
    try {
      layers = getCeilingType(project, c).layers;
    } catch {
      w.num(0, 0);
      continue;
    }
    w.num(1, layers.length);
    for (const l of layers) {
      let prio = Number.NaN;
      try {
        prio = getComponent(project, l.componentId).joinPriority;
      } catch {
        // Unbekanntes Bauteil: diese Deckenschicht schneidet nicht.
      }
      w.num(l.thickness, prio);
    }
  }
  const roofs = (project.roofs ?? []).filter((r) => r.floorId === floorId);
  w.num(roofs.length);
  for (const r of roofs) {
    const eavesZ = roofBaseElevation(project, r);
    const geo = roofGeometry(r, eavesZ);
    const total = roofLayers(project, r).reduce((s, l) => s + Math.max(0, l.thickness), 0);
    w.num(eavesZ, total).ring(geo.eaves);
    const planes = roofPlanesFlat(geo);
    for (let i = 0; i < planes.length; i++) w.num(planes[i]);
  }
}

/**
 * Emittiert die Wandkörper der Wände `walls` in EINEM Kern-Aufruf (Decken/Dächer je
 * Geschoss nur einmal übergeben). Reihenfolge der Körper wie Wand für Wand.
 *
 * ZWEI PFADE je `layered`:
 *  • layered=true (3D-Viewer, Default): EIN Körper pro Schicht-Band über die
 *    VOLLE Achse mit allen Öffnungen als echte `holes` (render3d stanzt sie in
 *    die Langseiten), dazu die materialbewussten Verschneidungen (End-Cuts/Merge
 *    an L-/T-Stössen aus `joins`, Durchgangswand-Span-Cutouts, Decken-Dominanz
 *    pro Schicht, schräge Oberkante unter Dächern als `topDrop`).
 *  • layered=false (Schnitt-Pfad, `computeSection`): Pfeiler/Brüstung/Sturz-
 *    Segmentierung (EIN Voll-Band je Segment), passend zu
 *    `toSection.ts::wallSegmentOwners`. Keine Löcher, keine Cuts.
 */
export function emitWalls(
  out: RWall[],
  project: Project,
  walls: readonly Wall[],
  layered = true,
  joins?: Map<string, WallCuts>,
): void {
  const w = new FlatWriter().num(walls.length);
  const floors = new FlatWriter();
  const floorIndex = new Map<string | undefined, number>();
  const bandsOf: WallBand[][] = [];

  for (const wall of walls) {
    const { bands, stacked } = resolveWallBands(project, wall, layered);
    bandsOf.push(bands);
    const { zBottom, zTop } = wallVerticalExtent(project, wall);
    let floor = -1;
    if (layered) {
      floor = floorIndex.get(wall.floorId) ?? -1;
      if (floor < 0) {
        floor = floorIndex.size;
        floorIndex.set(wall.floorId, floor);
        writeFloor(floors, project, wall.floorId);
      }
    }
    w.num(floor, wall.start.x, wall.start.y, wall.end.x, wall.end.y, zBottom, zTop, layered ? 1 : 0, stacked ? 1 : 0);
    if (wall.referenceOffset != null) w.num(3, wall.referenceOffset);
    else w.num(wall.referenceLine === "left" ? 1 : wall.referenceLine === "right" ? 2 : 0, 0);
    const term = wall.sliceTermination === "below" || wall.sliceTermination === "above" ? TERMINATION[wall.sliceTermination] : 0;
    w.num(wallThicknessSafe(project, wall), term, bands.length);
    for (const b of bands) w.num(b.thickness, b.priority ?? Number.NaN);

    // Öffnungen (Fenster und Türen): Achsen-Intervall + vertikale Ausdehnung.
    const slot = w.slot();
    let nOpenings = 0;
    for (const op of openingsOfWall(project, wall.id)) {
      const iv = openingInterval(wall, op);
      if (!iv) continue;
      const v = openingVerticalExtent(project, wall, op);
      const recess = op.kind === "window" && getWindowType(project, op)?.innerLayerRecess === true;
      w.num(iv.from, iv.to, v.zBottom, v.zTop, recess ? 1 : 0);
      nOpenings++;
    }
    w.set(slot, nOpenings);
    writeWallCuts(w, layered ? joins?.get(wall.id) : undefined);
  }

  const floorBuf = new FlatWriter().num(floorIndex.size).done();
  const r = new FlatReader(core().wall_bands_flat(w.done(), concat(floorBuf, floors.done())));
  const nWalls = Math.min(r.count(), walls.length);
  for (let i = 0; i < nWalls; i++) {
    const wall = walls[i];
    const bands = bandsOf[i];
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    for (let n = r.count(); n > 0; n--) {
      const b = bands[r.num()];
      const start: [number, number] = [r.num(), r.num()];
      const end: [number, number] = [r.num(), r.num()];
      const zb = r.num();
      const zt = r.num();
      const sloped = r.num() === 1;
      const topDrop: [number, number] = [r.num(), r.num()];
      const holes: RHole[] = [];
      for (let k = r.count(); k > 0; k--) holes.push({ from: r.num(), to: r.num(), zBottom: r.num(), zTop: r.num() });
      if (!b) continue;
      const cut = bandCutMeta(b);
      out.push({
        start,
        end,
        thickness: b.thickness,
        height: zt - zb,
        baseElevation: zb,
        ...(sloped ? { topDrop } : {}),
        color: b.color,
        layers: [],
        wallId: wall.id,
        ...(b.hatch ? { hatch: withTopAngle(b.hatch, dx, dy) } : {}),
        ...(b.materialIndex != null ? { materialIndex: b.materialIndex } : {}),
        ...(holes.length > 0 ? { holes } : {}),
        ...(cut ? { cut } : {}),
      });
    }
  }
}

function concat(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
