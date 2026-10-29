// Grundriss-Generator: erzeugt aus dem semantischen Modell den
// 2D-Grundriss als abstrakte Vektor-Primitive (später → SVG).
//
// Kern-Erkenntnis: Der Grundriss entsteht NICHT durch Zerschneiden eines
// 3D-Meshes, sondern direkt aus den Parametern (Wandachsen, Schichtaufbau,
// Öffnungen) — exakt, schnell, sauber.
//
// Diese Datei ist nur noch der ORCHESTRATOR: `generatePlan()`/
// `generateSectionPlan()` sowie die `resolve*SectionStyle`-Helfer (für den
// Schnitt-Pfad, `toSection.ts`). Die Bauteil-Domänen (Decken, Dächer, Räume,
// Wände mit Öffnungen, Treppen, Stützen, Extrusionen, Kontext, Schnittführung)
// rechnet der Rust-Kern auf dem Projekt-Dokument (`src-tauri/core/src/plan/`,
// Abfrage `planDomains`, [K3d]) und liefert fertige `Primitive` — auch die freie
// 2D-Geometrie (`plan/drawings.rs`). In TS bleiben Schattenstudie und Baurecht,
// die Abzugskörper (`voids.ts`), Mono und der Strichstärken-Massstab.
// Das `Primitive`-Vokabular und die Attribut-Auflösung für die übrigen TS-Pfade
// leben in `generatePlan/shared.ts`.

import type {
  Ceiling,
  Component,
  ContextImage,
  ContextObject,
  Drawing2D,
  Project,
  Vec2,
  Wall,
} from "../model/types";
import {
  getCeilingType,
  getComponent,
  getLayerCategory,
  getWallType,
} from "../model/types";
import { documentFor } from "../core/document";
import { decodePlanBuf, type DecodedPlanBuf } from "./planBuf";
import type { SectionOutput } from "./toSection";
import {
  HATCH_INK,
  HATCH_PAPER,
  MONO_INK,
  SHOW_ALL,
  resolveBackground,
  resolveForeground,
  resolveHatch,
  resolveHatchId,
  type CategoryDisplayResolver,
  type DetailLevel,
  type HatchRender,
  type Primitive,
} from "./generatePlan/shared";
import { subtractVoidsInPlan, voidPrisms } from "./voids";
import { isBufPiece, lazyPlan, piecesOf, planCount, planFields, type PlanPiece } from "./planLazy";
import { addSunShadow } from "./generatePlan/sunShadow";
import { addSiteRules, addSiteViolations } from "./generatePlan/siteRules";
import { lineWeightFactor, scalePrimitiveWeights } from "./lineWeightScale";
import { DEFAULT_SCALE_DENOMINATOR } from "../model/dimension";
import { layersStyleSig } from "./generatePlan/layerSig";

// Re-Export des gemeinsamen Vokabulars — externe Konsumenten (Export-Pipeline,
// PlanView, toSection.ts, toWalls3d.ts, toRenderScene.ts, …) importieren
// weiterhin ausschliesslich von hier, unverändert zur Zeit vor dem Domänen-Split.
export { HATCH_INK, HATCH_PAPER, resolveBackground, resolveForeground, resolveHatch, resolveHatchId };
export type { CategoryDisplayResolver, DetailLevel, HatchRender, Primitive };

/**
 * Füllfarbe + Schraffur eines aufgelösten Bauteils, fertig für eine Cut-Poché.
 */
export interface SectionCutStyle {
  fill: string;
  hatch: HatchRender;
}

/**
 * Löst das tragende Bauteil (höchste `joinPriority`) einer Wand auf und liefert
 * dessen Poché-Füllung + echte Schraffur für die Schnitt-Poché (mittel/fein).
 * Die grobe Grundriss-Poché (1:100) folgt dieser Bauteil-Regel NICHT mehr —
 * sie ist immer vollschwarz, unabhängig vom Bauteil-Pattern (SIA 400 Fig. 36,
 * s. `addWallPoche`). `null`, wenn Wandtyp oder Bauteil nicht auflösbar sind
 * (z. B. verwaistes `wallTypeId`); der Aufrufer fällt dann auf die generische
 * Schnitt-Schraffur zurück.
 */
export function resolveWallSectionStyle(project: Project, wall: Wall): SectionCutStyle | null {
  try {
    const wt = getWallType(project, wall);
    let best: Component | null = null;
    for (const layer of wt.layers) {
      const comp = getComponent(project, layer.componentId);
      if (!best || comp.joinPriority > best.joinPriority) best = comp;
    }
    if (!best) return null;
    const category = getLayerCategory(project, wall.categoryCode);
    const wallAngleDeg =
      (Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x) * 180) / Math.PI;
    const hatchId = resolveHatchId(wall.hatchId, wall.hatchSource, category, best.hatchId) ?? best.hatchId;
    const hatch = resolveHatch(
      project,
      hatchId,
      wallAngleDeg,
      resolveForeground(best, wall.foreground, category, wall.foregroundSource),
    );
    // Poché-Hintergrund neutral (Papier) statt Bauteil-Albedo; Vollmuster → Tinte
    // (unabhängig von `hatch.color`, das jetzt den aufgelösten Vordergrund tragen
    // kann, s. {@link resolveHatch}).
    const solid = hatch.pattern === "solid";
    return {
      fill: solid ? HATCH_INK : HATCH_PAPER,
      hatch,
    };
  } catch {
    return null;
  }
}

/**
 * Löst das erste Bauteil des Deckentyps einer Decke auf — dieselbe Regel wie
 * `addCeilingPoche` für die normale Deckenpoché — und liefert dessen
 * Füllfarbe + echte Schraffur für die Schnitt-Poché. `null`, wenn Deckentyp
 * oder Bauteil nicht auflösbar sind bzw. der Deckentyp keine Schicht trägt.
 */
export function resolveCeilingSectionStyle(
  project: Project,
  ceiling: Ceiling,
): SectionCutStyle | null {
  try {
    const wt = getCeilingType(project, ceiling);
    if (wt.layers.length === 0) return null;
    const comp = getComponent(project, wt.layers[0].componentId);
    const category = getLayerCategory(project, ceiling.categoryCode);
    const hatchId =
      resolveHatchId(ceiling.hatchId, ceiling.hatchSource, category, comp.hatchId) ?? comp.hatchId;
    const hatch = resolveHatch(
      project,
      hatchId,
      undefined,
      resolveForeground(comp, ceiling.foreground, category, ceiling.foregroundSource),
    );
    // Poché-Hintergrund neutral (Papier) statt Bauteil-Albedo; Vollmuster → Tinte
    // — dieselbe Neutralisierung wie {@link resolveWallSectionStyle}, damit die
    // geschnittene Decke nicht als andersfarbige Fläche gegenüber der Wand auffällt.
    const solid = hatch.pattern === "solid";
    return {
      fill: solid ? HATCH_INK : HATCH_PAPER,
      hatch,
    };
  } catch {
    return null;
  }
}

/** Ein georeferenziertes Hintergrund-Rasterbild (Luftbild) im Grundriss —
 *  Modell-Meter-Rechteck [min..max], das die interaktive Ansicht UNTER der
 *  Geometrie zeichnet (Kontext-Schicht, `ContextImage`). NICHT Teil der
 *  Vektor-`primitives` (DXF/PDF-Export lassen es aus). */
export interface PlanImage {
  id: string;
  src: string;
  min: Vec2;
  max: Vec2;
  opacity: number;
  /** Bildkorrektur, s. `ContextImage.filters` — durchgereicht, unverändert. */
  filters?: ContextImage["filters"];
}

export interface Plan {
  primitives: Primitive[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Hintergrund-Rasterbilder (Luftbild) — nur für die interaktive Ansicht. */
  backgroundImages?: PlanImage[];
  /**
   * Index-Bereiche [von, bis) in `primitives`, die GEDIMMT darzustellen sind
   * (andere Ebenen als Referenz), OHNE dass die Primitive dafür geklont wurden.
   * Bei einem Kataster-Import (3,7 Mio. Primitive) kostete das Klonen bei jedem
   * Ebenenwechsel ~1,2 s plus GC. Verbraucher: der GPU-Pfad dimmt per Farb-
   * Mapping beim Zeichnen; alle anderen (SVG, WASM, nativ) rufen
   * {@link materializeGreyed} auf.
   */
  greyedRanges?: Array<[number, number]>;
  /**
   * KOMPAKTE Linien-Unterlage (nur in der interaktiven Ansicht, s.
   * {@link UnderlayGroup}): Zeichnungen, deren 'line'-Primitive NICHT in
   * `primitives` stehen. Alle Verbraucher, die diese Linien als Primitive
   * brauchen (SVG-Fallback, WASM, nativ, Gruppen-Isolation), rufen
   * {@link materializeUnderlay}.
   */
  underlay?: UnderlayGroup[];
  /**
   * Abschnitte, die unverändert aus einem Plan-Puffer des Kerns stammen ([K3d]): der GPU-Pfad
   * kompiliert sie direkt aus dem Puffer und erkennt Unverändertes am Inhalts-Hash
   * (`glPlanChunks.ts`). Wer Primitive ersetzt oder verschiebt, muss nichts nachführen — der
   * Verbraucher prüft die Objekt-Identität und fällt sonst auf die Objekte zurück.
   */
  bufRuns?: PlanBufRun[];
}

/** `primitives[at + k]` ist (solange nicht ersetzt) `buf.prims[from + k]`, `k < to − from`. */
export interface PlanBufRun {
  at: number;
  buf: DecodedPlanBuf;
  from: number;
  to: number;
}

/**
 * Eine Gruppe kompakt gehaltener Zeichnungen. Ihre Linien entstehen erst beim
 * Kompilieren eines GPU-Chunks (kurzlebig, `build`), nicht als dauerhafte
 * Primitive: bei einem Kataster-Import 3,7 Mio. Objekte weniger im Speicher und
 * keine O(N)-Durchgänge mehr bei jeder Änderung.
 */
export interface UnderlayGroup {
  drawings: Drawing2D[];
  /** Linien dieser Zeichnungen sind per Kategorie gedimmt (in `build` eingebacken). */
  catGreyed: boolean;
  /** Ganze Gruppe gedimmt darstellen (andere Ebene als Referenz) — beim Zeichnen. */
  tint: boolean;
  /** true = über den übrigen Primitiven zeichnen (aktive Ebene), false = darunter (Referenz-Ebene). */
  above: boolean;
  /** Referenzen, von denen die erzeugten Linien abhängen (Cache-Schlüssel des GPU-Chunks). */
  ctx: readonly unknown[];
  /** Erzeugt die 'line'-Primitive der gegebenen Zeichnungen (Teilmenge dieser Gruppe). */
  build: (drawings: Drawing2D[]) => Primitive[];
  /**
   * Dieselben Linien als Plan-Puffer des Kerns (ohne sie als Objekte zu lesen) — fehlt, wenn die
   * Linien in TS nachbearbeitet werden (Strichstärken-Massstab).
   */
  buildBuf?: (drawings: Drawing2D[]) => DecodedPlanBuf;
}

/**
 * Macht aus `plan.underlay` wieder gewöhnliche 'line'-Primitive (für Verbraucher,
 * die Primitive brauchen). Reihenfolge: Referenz-Ebenen unten, aktive oben;
 * gedimmte Referenz-Linien werden über `greyedRanges` markiert.
 */
export function materializeUnderlay(plan: Plan): Plan {
  const groups = plan.underlay;
  if (!groups || groups.length === 0) return plan;
  // Stücke statt Kopie (s. `planLazy.ts`): die Primitive des Plans werden dabei nicht gelesen, die
  // Linien der Unterlage bleiben (mit `buildBuf`) Abschnitte von Kern-Puffern.
  const below: PlanPiece[] = [];
  const above: PlanPiece[] = [];
  let nBelow = 0;
  let nAbove = 0;
  const belowGreyed: Array<[number, number]> = [];
  const aboveGreyed: Array<[number, number]> = [];
  for (const g of groups) {
    let piece: PlanPiece;
    let n: number;
    if (g.buildBuf) {
      const b = g.buildBuf(g.drawings);
      piece = { buf: b, from: 0, to: b.count };
      n = b.count;
    } else {
      const list = g.build(g.drawings);
      piece = list;
      n = list.length;
    }
    if (n === 0) continue;
    const from = g.above ? nAbove : nBelow;
    (g.above ? above : below).push(piece);
    if (g.above) nAbove += n;
    else nBelow += n;
    if (g.tint) (g.above ? aboveGreyed : belowGreyed).push([from, from + n]);
  }
  const n = planCount(plan);
  const shifted = (plan.greyedRanges ?? []).map(([a, b]): [number, number] => [a + nBelow, b + nBelow]);
  const aboveShift = nBelow + n;
  const ranges = [
    ...belowGreyed,
    ...shifted,
    ...aboveGreyed.map(([a, b]): [number, number] => [a + aboveShift, b + aboveShift]),
  ];
  const { underlay: _u, greyedRanges: _g, ...fields } = planFields(plan);
  return lazyPlan({ ...fields, ...(ranges.length ? { greyedRanges: ranges } : {}) }, [...below, ...piecesOf(plan), ...above]);
}

/** Ob Index `i` in einem der (sortierten, disjunkten) Bereiche liegt. */
export function inGreyedRange(ranges: ReadonlyArray<[number, number]> | undefined, i: number): boolean {
  if (!ranges) return false;
  for (const [a, b] of ranges) if (i >= a && i < b) return true;
  return false;
}

/**
 * Wandelt `greyedRanges` in echte `greyed`-Primitive um (gleiche Indizes, gleiche
 * Länge). Mit `includeLines=false` bleiben 'line'-Primitive unverändert — für den
 * GPU-Pfad, der Linien selbst dimmt; Polygone/Texte/Bögen werden geklont, weil
 * SVG-Overlay und Schraffur-Muster `greyed` direkt am Primitiv lesen.
 */
export function materializeGreyed(plan: Plan, includeLines: boolean): Plan {
  const ranges = plan.greyedRanges;
  if (!ranges || ranges.length === 0) return plan;
  const primitives = plan.primitives.slice();
  for (const [a, b] of ranges) {
    for (let i = a; i < b; i++) {
      const p = primitives[i];
      if (!includeLines && p.kind === "line") continue;
      primitives[i] = greyedClone(p);
    }
  }
  return { ...plan, primitives, greyedRanges: undefined };
}

/**
 * Erzeugt den Grundriss eines Geschosses, gefiltert nach sichtbaren Ebenen
 * (Kategorie-Codes).
 *
 * Enthält Wände dieses Geschosses, deren `categoryCode` ∈ `visibleCodes`. Eine
 * Türöffnung gehört zur Wandgeometrie und wird stets ausgespart; das
 * Tür-SYMBOL (Blatt + Bogen) erscheint nur, wenn der Tür-Code sichtbar ist.
 */
export function generatePlan(
  project: Project,
  floorId: string,
  visibleCodes: Set<string>,
  categoryDisplay: CategoryDisplayResolver = SHOW_ALL,
  detail: DetailLevel = "mittel",
  showReferenceLines = false,
  mono = false,
  // Schalter für die projektglobalen Zutaten (Kontext-Konturen, Schnittlinien,
  // Luftbilder): beim Überlagern mehrerer Geschosse (siehe
  // `generateVisibleLevelsPlan`) dürfen diese NICHT je Geschoss dupliziert
  // werden — nur der aktive Aufruf liefert sie.
  includeGlobal = true,
  /**
   * Papier-Massstab (1:N) DIESES Plans — nur für Bemassungs-Feinheiten, die
   * in Papier-mm angegeben sind (s. `model/dimension.ts`). Der Plan wird je
   * Ziel eigens erzeugt (Bildschirm bzw. Layout-Viewport), der Massstab ist
   * hier also eindeutig. Default 1:100, damit bestehende Aufrufer/Tests
   * unverändert bleiben.
   */
  scaleDenominator: number = DEFAULT_SCALE_DENOMINATOR,
  /**
   * Export-Modus (PDF/SVG/DXF): schliesst Elemente mit `Drawing2D.noPrint`
   * aus (analog einer „Non-Plotting"-Ebene, nur pro Objekt statt pro Ebene —
   * Nutzer-Wunsch „Kein 'nicht druckend'-Flag im Modell"). Default `false`
   * (Bildschirm/Editieren) — ein als `noPrint` markiertes Element bleibt dort
   * normal sichtbar, nur der Export lässt es weg. Bewusst als LETZTER
   * Parameter angehängt (nicht zwischen bestehende einsortiert), damit keine
   * bestehende Aufrufstelle mit positionalen Argumenten verrutscht.
   */
  forPrint = false,
  /**
   * Kompakte Linien-Unterlage statt dauerhafter 'line'-Primitive (s.
   * {@link UnderlayGroup}) — NUR für die interaktive GPU-Ansicht. Aus bei
   * Export/mono (toMono mutiert Linienfarben).
   */
  compactUnderlay = false,
): Plan {
  const primitives: Primitive[] = [];
  // Schattenstudie zuunterst (projektglobal, nur im Geschoss nächst ±0.00).
  if (includeGlobal) addSunShadow(primitives, project, floorId);
  // Baurecht (Parzelle, zulässige Fläche, Verstösse), ebenfalls zuunterst.
  if (includeGlobal) addSiteRules(primitives, project, floorId);
  const underlayCount = primitives.length;
  // Aktives Geschoss (für die Grundriss-Schnitthöhe der Treppen).
  const floor = project.drawingLevels.find((z) => z.id === floorId);
  const compact = compactUnderlay && !mono && !forPrint;

  // Decken, Dächer, Räume, Wände mit Öffnungen, Treppen, Stützen, 2D-Zeichnungen und Extrusions-Umrisse
  // rechnet der Kern auf dem Dokument ([K3d], `plan/{domains,walls,stairs,drawings}.rs`): Filter,
  // Override-Regeln, Verschneidung, Stil und Raumstempel-Daten. Decken, Dächer und Räume liegen unter
  // der Wand-Poché; Stützen folgen nach den Treppen, die 2D-Zeichnungen darüber, Extrusionen danach.
  // Der Kern liefert alles in EINEM Plan-Puffer (Gruppen in dieser Reihenfolge); die Abschnitte
  // merkt sich der Plan (`bufRuns`), damit die GPU sie direkt aus dem Puffer kompiliert.
  // Mono färbt die gelesenen Primitive um (s. `toMono`): dann keine behaltenen Stücke.
  const dom = planDomains(project, floorId, visibleCodes, categoryDisplay, detail, showReferenceLines, includeGlobal, scaleDenominator, forPrint, compact, !mono);
  // Der Plan entsteht aus Stücken ([K3d], `planLazy.ts`): TS-Listen und Kern-Abschnitte; die
  // Kern-Primitive werden erst gelesen, wenn ein Verbraucher sie als Objekte braucht.
  const pieces: PlanPiece[] = [primitives];
  const pushGroups = (first: number, last: number): void => {
    const from = dom.buf.groups[first][0];
    const to = dom.buf.groups[last][1];
    if (to > from) pieces.push({ buf: dom.buf, from, to });
  };
  // Decken, Dächer, Räume; Wände (Poché, Referenzlinie) mit ihren Öffnungs-Symbolen, je Wand
  // nacheinander; Treppen; Stützen; 2D-Zeichnungen (über der Poché); extrudierte Körper
  // (Footprint-Umriss); Kontext-Konturen und Schnittführungs-Symbole (projektglobal, nur beim
  // aktiven Aufruf einer Mehrfach-Überlagerung).
  // Die 2D-Zeichnungen kommen als eigene Puffer-Stücke (an Stelle der Gruppe 6, s. `planDomains`).
  pushGroups(G_CEILINGS, G_COLUMNS);
  for (const c of dom.chunks) pieces.push({ buf: c, from: 0, to: c.count });
  pushGroups(G_SOLIDS, G_SECTIONS);
  // Kompakte Linien-Unterlage (s. {@link UnderlayGroup}): die Linien einfacher Zeichnungen fehlen
  // im Puffer und entstehen erst bei Bedarf, PRO KATEGORIE gruppiert — das Ein-/Ausblenden einer
  // Ebene entfernt dann nur deren Gruppe, die Chunks aller anderen Ebenen bleiben gültig.
  const underlay = compact ? underlayGroups(project, dom, scaleDenominator) : [];

  // Baurechts-Verstösse über allem (Signal, soll nicht unter der Wand-Poché verschwinden).
  const violations: Primitive[] = [];
  if (includeGlobal) addSiteViolations(violations, project, floorId);
  pieces.push(violations);

  // Georeferenzierte Luftbilder als Hintergrund-Ebenen (nur interaktive Ansicht,
  // nicht Teil der Vektor-Primitive) — im Mono-Modus ausgeblendet (reiner S/W-Plan).
  // Projektglobal (nicht je Geschoss), s. `includeGlobal` oben.
  const backgroundImages: PlanImage[] = !includeGlobal || mono
    ? []
    : (project.context ?? [])
        .filter((o): o is Extract<ContextObject, { type: "image" }> => o.type === "image")
        .map((o) => ({
          id: o.id,
          src: o.src,
          min: o.min,
          max: o.max,
          opacity: o.opacity ?? 1,
          filters: o.filters,
        }));

  // Strichstärken nach Massstab ([32], nur mit Projekt-Option): auf die fertigen Primitive und
  // auf die Linien der kompakten Unterlage.
  const lwf = lineWeightFactor(project, scaleDenominator);
  const scaledUnderlay =
    lwf === 1
      ? underlay
      : underlay.map((g) => ({
          ...g,
          ctx: [...g.ctx, lwf],
          build: (ds: Drawing2D[]) => g.build(ds).map((p) => scalePrimitiveWeights(p, lwf)),
          buildBuf: undefined,
        }));
  const rest = {
    bounds: computeBounds(project, dom.buf.bounds, primitives.slice(0, underlayCount)),
    backgroundImages,
    ...(scaledUnderlay.length ? { underlay: scaledUnderlay } : {}),
  };
  const hasVoids = voidPrisms(project).length > 0;
  // Ohne Abzugskörper, Mono und Strichstärken-Massstab bleibt der Plan lazy: die Kern-Primitive
  // werden erst bei Bedarf gelesen.
  if (!hasVoids && !mono && lwf === 1) return lazyPlan(rest, pieces);

  // Sonst wie bisher als Liste: die Schritte unten verändern Primitive.
  const all: Primitive[] = [];
  const runs: PlanBufRun[] = [];
  for (const pc of pieces) {
    if (isBufPiece(pc)) {
      runs.push({ at: all.length, buf: pc.buf, from: pc.from, to: pc.to });
      for (let i = pc.from; i < pc.to; i++) all.push(pc.buf.prim(i));
    } else for (const pr of pc) all.push(pr);
  }
  // Abzugskörper (Aussparungen/Durchbrüche): von Wand-/Stützen-/Decken-Poché abziehen.
  // Ersetzte Primitive erkennt der GPU-Pfad selbst (Identität); verschiebt das Zerlegen die
  // Indizes, werden die Kern-Abschnitte neu ausgerichtet. Die Baurechts-Verstösse liegen über
  // allem und haben keine Bauteil-Id — das Abziehen lässt sie unverändert.
  if (hasVoids && subtractVoidsInPlan(all, project, (floor?.baseElevation ?? 0) + (floor?.cutHeight ?? 1.0))) realignRuns(all, runs);

  // Schwarz-Weiss (mono): nachträglich alle Farben auf reine Tinte zwingen.
  // Element-/Kategorie-/Hatch-Farben werden ignoriert, Füllungen werden weiss,
  // Musterlinien/Striche schwarz — so entsteht ein reiner S/W-Plan.
  if (mono) toMono(all);

  // Mono färbt die Objekte um, der Massstab ersetzt sie: dann gilt der Puffer nicht mehr.
  const keepRuns = !mono && lwf === 1 && runs.length > 0;
  return {
    primitives: lwf === 1 ? all : all.map((p) => scalePrimitiveWeights(p, lwf)),
    ...rest,
    ...(keepRuns ? { bufRuns: runs } : {}),
  };
}

/**
 * Kern-Abschnitte nach einem Umbau der Liste (Abzugskörper zerlegen Polygone) neu ausrichten:
 * jede noch vorhandene Folge unveränderter Puffer-Objekte wird ein eigener Abschnitt.
 */
function realignRuns(primitives: readonly Primitive[], runs: PlanBufRun[]): void {
  if (runs.length === 0) return;
  const where = new Map<Primitive, [PlanBufRun, number]>();
  for (const r of runs) for (let i = r.from; i < r.to; i++) where.set(r.buf.prims[i], [r, i]);
  const out: PlanBufRun[] = [];
  let cur: PlanBufRun | null = null;
  for (let i = 0; i < primitives.length; i++) {
    const w = where.get(primitives[i]);
    if (w && cur && w[0].buf === cur.buf && w[1] === cur.to && i === cur.at + (cur.to - cur.from)) {
      cur.to++;
      continue;
    }
    cur = w ? { at: i, buf: w[0].buf, from: w[1], to: w[1] + 1 } : null;
    if (cur) out.push(cur);
  }
  runs.length = 0;
  for (const r of out) runs.push(r);
}

/**
 * Wie `generatePlan`, überlagert aber ZUSÄTZLICH alle sichtbaren Geschoss-
 * oder Zeichnungs-Ebenen DERSELBEN Art wie `activeLevelId` in EINEM Plan —
 * das Vectorworks-Bild „andere Ebenen als Referenz einblenden": die aktive
 * Ebene farbig/bearbeitbar, die übrigen je Darstellungsmodus gedimmt
 * (`levelDisplay`, derselbe Resolver wie für Geschosse im Panel/3D). Schnitt-/
 * Ansichts-Ebenen bleiben Einzel-Pane (andere Projektionsachse — ein
 * Überlagern mehrerer Schnitte ergäbe kein sinnvolles Bild).
 */
/**
 * Gedimmte Variante eines Primitivs, pro Quell-Objekt EINMAL erzeugt. Ohne den
 * Cache entstanden bei jedem Plan-Aufbau (jeder Ebenenwechsel!) Millionen neuer
 * Objekte — GC-Last, und weil sie nie identisch zum letzten Lauf waren, konnte
 * der GPU-Chunk-Cache (`glPlanChunks.ts`) nichts wiederverwenden.
 */
const greyedClones = new WeakMap<Primitive, Primitive>();
function greyedClone(pr: Primitive): Primitive {
  if ((pr as { greyed?: boolean }).greyed) return pr;
  let c = greyedClones.get(pr);
  if (!c) {
    c = { ...pr, greyed: true } as Primitive;
    greyedClones.set(pr, c);
  }
  return c;
}

export function generateVisibleLevelsPlan(
  project: Project,
  activeLevelId: string,
  visibleCodes: Set<string>,
  categoryDisplay: CategoryDisplayResolver = SHOW_ALL,
  detail: DetailLevel = "mittel",
  showReferenceLines = false,
  mono = false,
  levelDisplay: CategoryDisplayResolver = SHOW_ALL,
  scaleDenominator: number = DEFAULT_SCALE_DENOMINATOR,
  /** Kompakte Linien-Unterlage (s. `UnderlayGroup`) — nur die interaktive GPU-Ansicht. */
  compactUnderlay = false,
): Plan {
  const active = project.drawingLevels.find((l) => l.id === activeLevelId);
  const siblings =
    active && (active.kind === "floor" || active.kind === "drawing")
      ? project.drawingLevels.filter((l) => l.kind === active.kind && l.id !== activeLevelId)
      : [];

  // Stücke der Ebenen hintereinander (lazy, s. `planLazy.ts`): die Primitive werden dabei nicht
  // gelesen. Früher eine `for`-Schleife statt `push(...p.primitives)` (Argumentzahl-Grenze bei
  // Kataster-Importen) — die Stücke umgehen beides.
  const pieces: PlanPiece[] = [];
  let count = 0;
  const greyedRanges: Array<[number, number]> = [];
  const underlay: UnderlayGroup[] = [];
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const extend = (b: Plan["bounds"]) => {
    bounds.minX = Math.min(bounds.minX, b.minX);
    bounds.minY = Math.min(bounds.minY, b.minY);
    bounds.maxX = Math.max(bounds.maxX, b.maxX);
    bounds.maxY = Math.max(bounds.maxY, b.maxY);
  };

  // Andere sichtbare Ebenen ZUERST (unten als Referenz), die aktive zuletzt
  // (obenauf) — wie `buildBuilding` in meshBuilders.ts für die 3D-Szene.
  for (const l of siblings) {
    const d = levelDisplay(l.id);
    if (!d.render) continue;
    const p = generatePlan(
      project,
      l.id,
      visibleCodes,
      categoryDisplay,
      detail,
      showReferenceLines,
      mono,
      false, // includeGlobal: Schnittlinien/Kontext/Luftbilder nur einmal (aktiv)
      scaleDenominator,
      false,
      compactUnderlay,
    );
    for (const g of p.underlay ?? []) underlay.push({ ...g, tint: d.greyed, above: false });
    const from = count;
    const n = planCount(p);
    for (const pc of piecesOf(p)) pieces.push(pc);
    count += n;
    if (d.greyed && n > 0) greyedRanges.push([from, count]);
    // Leere Ebenen melden als Platzhalter (0,0)–(1,1) — NICHT mitzählen: sonst zog
    // jede leere Nachbar-Ebene den Ausschnitt bis zum Ursprung (bei Landes-
    // koordinaten ~2,7 Mio. m daneben → "Einpassen" zeigte nichts).
    if (n > 0 || p.underlay) extend(p.bounds);
  }

  const activePlan = generatePlan(
    project,
    activeLevelId,
    visibleCodes,
    categoryDisplay,
    detail,
    showReferenceLines,
    mono,
    true,
    scaleDenominator,
    false,
    compactUnderlay,
  );
  const activeCount = planCount(activePlan);
  for (const pc of piecesOf(activePlan)) pieces.push(pc);
  for (const g of activePlan.underlay ?? []) underlay.push(g);
  // Aktive Ebene leer UND keine Nachbar-Ebene mit Inhalt → Platzhalter-Ausmass.
  if (activeCount > 0 || activePlan.underlay || bounds.minX === Infinity) extend(activePlan.bounds);

  return lazyPlan(
    {
      bounds,
      backgroundImages: activePlan.backgroundImages,
      ...(greyedRanges.length ? { greyedRanges } : {}),
      ...(underlay.length ? { underlay } : {}),
    },
    pieces,
  );
}

// ── Schnitt/Ansicht (abgeleitete Projektion aus render3d::section) ──────────────
// Die Rohdaten (Cut-Polygone + sichtbare/verdeckte projizierte Kanten) liefert
// der WASM-Extraktor (plan/toSection.ts → section.rs). Hier werden sie 1:1 in
// die BESTEHENDEN Plan-Primitive übersetzt — kein neues Primitiv nötig:
//   • Cut-Polygon  → `polygon` (kräftige Poché-Umrisslinie + Schnitt-Schraffur),
//   • sichtbare Kante → `line` (durchgezogen),
//   • verdeckte Kante → `line` (gestrichelt).
// Damit rendern PlanView (SVG) UND toRenderScene (Engine/WASM-2D) den Schnitt
// ohne jede Sonderbehandlung, mit voller Papier-mm-/Parität-Infrastruktur.

/** Tinte der Schnitt-Poché-Umrisslinie + Schraffur (dunkles Grau). */
const SECTION_INK = "#1f242c";
/** Tinte der sichtbaren Ansichtskanten. */
const SECTION_VISIBLE_INK = "#2b3039";
/** Tinte der verdeckten (gestrichelten) Ansichtskanten (etwas heller). */
const SECTION_HIDDEN_INK = "#8a929c";
/** Strichstärke der Cut-Poché-Umrisslinie (mm Papier, kräftig wie eine Wand). */
const SECTION_CUT_OUTLINE_MM = 0.35;
/** Strichstärke sichtbarer Ansichtskanten (mm Papier). */
const SECTION_VISIBLE_MM = 0.18;
/** Strichstärke der Bodenlinie unter dem Schnitt (mm Papier, wie in der Ansicht). */
const SECTION_GROUND_MM = 0.5;
/** Strichstärke verdeckter Ansichtskanten (mm Papier, dünner). */
const SECTION_HIDDEN_MM = 0.13;
/** Strichmuster verdeckter Kanten (mm Papier). */
const SECTION_HIDDEN_DASH: number[] = [0.12, 0.08];

/**
 * Schnitt-Schraffur der Cut-Flächen (diagonale Poché wie ein Wandschnitt) —
 * Fallback, wenn `toSection.ts` das Quell-Bauteil einer Cut-Fläche NICHT
 * auflösen konnte (siehe `attachCutStyles`). Vordergrund fest `HATCH_INK`,
 * damit auch der Fallback monochrom bleibt statt der rohen 3D-Albedo-Farbe.
 */
const SECTION_HATCH: HatchRender = {
  pattern: "diagonal",
  scale: 1,
  angle: 45,
  color: HATCH_INK,
  lineWeight: 0.13,
  dash: null,
};

/**
 * Baut aus einem {@link SectionOutput} (render3d::section, (u, v)-Meter) den
 * Plan eines Schnitts/einer Ansicht. `u` wird zur Plan-X, `v` (absolute Höhe)
 * zur Plan-Y — die PlanView zeigt Y nach oben, also erscheint der Schnitt
 * aufrecht. Rein darstellend; kennt das Projekt NICHT direkt — `visibleCodes`/
 * `categoryDisplay` (optional) filtern/dimmen jedes Cut-Band trotzdem über
 * `cp.categoryCode` (von `toSection.ts::attachCutStyles` aufgelöst), damit das
 * Ebenen-Panel auch im Schnitt/in der Ansicht wirkt, wie im Grundriss. Ein
 * Band ohne `categoryCode` (unauflösbares Bauteil) bleibt immer sichtbar.
 */
export function generateSectionPlan(
  output: SectionOutput,
  mono = false,
  opts: {
    hiddenLines?: boolean;
    visibleCodes?: Set<string>;
    categoryDisplay?: CategoryDisplayResolver;
  } = {},
): Plan {
  const primitives: Primitive[] = [];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  const catDisplay = opts.categoryDisplay ?? SHOW_ALL;

  // Cut-Polygone: gefüllte Poché-Fläche + Schnitt-Schraffur + kräftige
  // Umrisslinie — wie eine geschnittene Wand im Grundriss. `toSection.ts`
  // (computeSection) löst je Cut-Polygon bereits das Quell-Bauteil auf und
  // hängt dessen echte Füllfarbe/Schraffur an (`cp.fill`/`cp.hatch`); fehlt
  // diese Auflösung (Fallback, z. B. verwaistes Bauteil), greift die generische
  // Schnitt-Schraffur (`SECTION_HATCH`, HATCH_PAPER-Hintergrund) — NICHT die rohe
  // Albedo-Farbe aus dem 3D-Modell (Nutzer-Vorgabe 2026-07-04: einheitlich
  // monochrom, auch im Fallback-Fall).
  for (const cp of output.cutPolygons) {
    if (cp.pts.length < 3) continue;
    // Ebenen-Panel-Sichtbarkeit: nur wenn das Quell-Bauteil aufgelöst werden
    // konnte (categoryCode gesetzt) — sonst (Fallback) immer zeichnen.
    if (cp.categoryCode !== undefined) {
      if (opts.visibleCodes && !opts.visibleCodes.has(cp.categoryCode)) continue;
      if (!catDisplay(cp.categoryCode).render) continue;
    }
    const pts: Vec2[] = cp.pts.map(([u, v]) => {
      acc(u, v);
      return { x: u, y: v };
    });
    const fill = cp.fill ?? HATCH_PAPER;
    const hatch = cp.hatch ?? SECTION_HATCH;
    // Mono: neutrale Poché — Papier statt Bauteilfarbe, Schraffur-Musterlinien →
    // Tinte. Eine dunkle SIA-Vollpoché ("solid") BLEIBT jedoch dunkel
    // (Tinte bleibt Tinte, Papier bleibt Papier).
    const solid = hatch.pattern === "solid";
    const monoFill = solid ? HATCH_INK : HATCH_PAPER;
    const monoHatch =
      solid ? hatch : hatch.pattern !== "none" ? { ...hatch, color: SECTION_INK } : hatch;
    // Auswahl im Schnitt: das QUELL-Element (via cp.sourceId + component.kind) als
    // wallId/ceilingId/roofId ans Polygon hängen — so wählt ein Klick auf das
    // geschnittene Bauteil im Schnitt exakt jene Wand/Decke/Dach im Modell, und
    // die bestehende PlanView-Pick-/Highlight-Logik greift ohne Sonderfall.
    const kind = cp.component.kind;
    const sourceId = cp.sourceId;
    primitives.push({
      kind: "polygon",
      pts,
      fill: mono ? monoFill : fill,
      stroke: SECTION_INK,
      strokeWidthMm: SECTION_CUT_OUTLINE_MM,
      hatch: mono ? monoHatch : hatch,
      wallId: kind === "wall" ? sourceId : undefined,
      ceilingId: kind === "slab" && !cp.stairId ? sourceId : undefined,
      roofId: kind === "roof" ? sourceId : undefined,
      stairId: cp.stairId,
      extrudedSolidId: kind === "body" ? sourceId : undefined,
      noStrokeEdges: cp.noStrokeEdges,
      greyed: cp.categoryCode !== undefined && catDisplay(cp.categoryCode).greyed,
    });
  }

  // Geländelinie(n): kräftige Linie, über Kategorie filterbar.
  for (const pr of output.profiles ?? []) {
    if (pr.categoryCode !== undefined) {
      if (opts.visibleCodes && !opts.visibleCodes.has(pr.categoryCode)) continue;
      if (!catDisplay(pr.categoryCode).render) continue;
    }
    for (let i = 0; i + 1 < pr.pts.length; i++) {
      const [a, b] = [pr.pts[i], pr.pts[i + 1]];
      acc(a[0], a[1]);
      acc(b[0], b[1]);
      primitives.push({
        kind: "line",
        a: { x: a[0], y: a[1] },
        b: { x: b[0], y: b[1] },
        cls: "section-terrain",
        weightMm: SECTION_GROUND_MM,
        color: SECTION_INK,
      });
    }
  }

  // Verdeckte Kanten zuerst (liegen unter den sichtbaren), gestrichelt —
  // Standard AUS (VW-üblich): sie legen sich sonst als blasses Liniengewirr
  // über Poché und Ansichtskanten. Zuschaltbar je Schnitt-/Ansichts-Ebene.
  for (const e of opts.hiddenLines ? output.hiddenEdges : []) {
    acc(e.a[0], e.a[1]);
    acc(e.b[0], e.b[1]);
    primitives.push({
      kind: "line",
      a: { x: e.a[0], y: e.a[1] },
      b: { x: e.b[0], y: e.b[1] },
      cls: "section-hidden",
      weightMm: SECTION_HIDDEN_MM,
      dash: SECTION_HIDDEN_DASH,
      color: SECTION_HIDDEN_INK,
    });
  }

  // Sichtbare Ansichtskanten, durchgezogen.
  for (const e of output.visibleEdges) {
    acc(e.a[0], e.a[1]);
    acc(e.b[0], e.b[1]);
    primitives.push({
      kind: "line",
      a: { x: e.a[0], y: e.a[1] },
      b: { x: e.b[0], y: e.b[1] },
      cls: "section-visible",
      weightMm: SECTION_VISIBLE_MM,
      color: SECTION_VISIBLE_INK,
    });
  }

  // Bodenlinie wie in der Ansicht (toElevation.ts): kräftige Linie über die
  // volle Breite an der untersten Kante — ohne sie "schwebte" der Schnitt.
  if (isFinite(minX) && maxX > minX) {
    primitives.push({
      kind: "line",
      a: { x: minX, y: minY },
      b: { x: maxX, y: minY },
      cls: "section-ground",
      weightMm: SECTION_GROUND_MM,
      color: SECTION_INK,
    });
  }

  if (!isFinite(minX)) return { primitives, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } };
  return { primitives, bounds: { minX, minY, maxX, maxY } };
}

/**
 * Post-Pass für den Schwarz-Weiss-Modus: ersetzt alle Farb-Informationen der
 * Plan-Primitive durch einheitliche Tinte/Weiss. Wirkt in-place.
 * - Polygone: Füllung → weiss, Umriss → Tinte, Schraffur-Musterlinien → Tinte
 *   (Vollfüllung „solid" wird zu Weiss neutralisiert, damit keine Poché-Farbe).
 * - Linien: explizite Strichfarbe → Tinte (CSS-Klassen sind bereits neutral).
 * - Bögen tragen keine Farbe (rein CSS, neutral) → unverändert.
 */
function toMono(primitives: Primitive[]): void {
  for (const p of primitives) {
    if (p.kind === "polygon") {
      // SIA-Poché in mono: Vollmuster „solid" ist eine SCHWARZE Poché und bleibt
      // schwarz (Schwarz bleibt Schwarz); jede andere Füllung wird weiß, die
      // Linien-/Kreuzschraffur bleibt sichtbar, aber in Tinte.
      if (p.hatch.pattern === "solid") {
        p.hatch = { ...p.hatch, color: HATCH_INK };
        p.fill = p.fill === "none" ? "none" : HATCH_INK;
      } else {
        if (p.hatch.pattern !== "none") p.hatch = { ...p.hatch, color: MONO_INK };
        p.fill = p.fill === "none" ? "none" : "#ffffff";
      }
      p.stroke = MONO_INK;
    } else if (p.kind === "line") {
      p.color = MONO_INK;
    } else if (p.kind === "text") {
      p.color = MONO_INK;
    }
  }
}

/** Primitive der Kern-Domänen (`planDomains` in `queries.rs`) als gelesene Plan-Puffer v2. */
interface DomainPrims {
  /** Haupt-Puffer: Gruppen wie `plan/domains.rs::GROUPS`, Gruppe 6 (2D-Zeichnungen) leer. */
  buf: DecodedPlanBuf;
  /** Die 2D-Zeichnungen in Stücken (eigene Puffer, Zeichenreihenfolge). */
  chunks: DecodedPlanBuf[];
  /** Argumente der Abfrage (für `drawingUnderlay`). */
  args: string;
}

/** Gruppen des Puffers (`plan/domains.rs::GROUPS`). */
const G_CEILINGS = 0;
const G_COLUMNS = 5;
const G_SOLIDS = 7;
const G_SECTIONS = 9;
const N_GROUPS = 10;

/** Kennung der Antwort mit Zeichnungs-Stücken (`plan/domains.rs::MULTI_MAGIC`, "PLBm"). */
const PLAN_MULTI_MAGIC = 1_347_175_021;

/**
 * Zuletzt gelieferte Zeichnungs-Stücke je Argument-Satz ([K4], Kern-Cache `plan/cache.rs`): ihre
 * Schlüssel gehen beim nächsten Aufruf mit (`have`), unveränderte Stücke kommen dann ohne Puffer
 * zurück und bleiben dieselben Objekte (auch für GPU-Chunks und gehaltene Puffer).
 */
const chunkStores = new Map<string, Map<number, DecodedPlanBuf>>();
const MAX_CHUNK_STORES = 16;

const DETAIL_CODE: Record<DetailLevel, number> = { grob: 0, mittel: 1, fein: 2 };

/**
 * Decken, Dächer, Räume, Wände mit Öffnungen, Treppen, Stützen, 2D-Zeichnungen, Extrusions-Umrisse
 * eines Geschosses und (mit `global`) Kontext-Konturen und Schnittführungs-Symbole aus dem Kern.
 * Sichtbarkeit und Darstellungsmodus (UI-Zustand) gehen als Code-Mengen mit: `show` = sichtbar und
 * gezeichnet, `grey` = gedimmt.
 */
function planDomains(
  project: Project,
  floorId: string,
  visibleCodes: Set<string>,
  categoryDisplay: CategoryDisplayResolver,
  detail: DetailLevel,
  referenceLines: boolean,
  global: boolean,
  scale: number,
  forPrint: boolean,
  compact: boolean,
  /** Stücke vom letzten Aufruf wiederverwenden (gleiche Objekte). */
  reuse = true,
): DomainPrims {
  // Sichtbar und gezeichnet bzw. gedimmt: über die sichtbaren Codes (wenige), nicht über alle
  // Elemente — der Kern zeichnet ein Element genau dann, wenn sein Code in `show` steht.
  const show: string[] = [];
  const grey: string[] = [];
  for (const c of visibleCodes) {
    const d = categoryDisplay(c);
    if (!d.render) continue;
    show.push(c);
    if (d.greyed) grey.push(c);
  }
  const args = JSON.stringify({ floor: floorId, show, grey, referenceLines, global, scale, forPrint, compact });
  const held = reuse ? chunkStores.get(args) : undefined;
  const query = held && held.size ? `${args.slice(0, -1)},"have":[${[...held.keys()].join(",")}]}` : args;
  const res = readPlanMulti(documentFor(project).queryBin("planDomains", [DETAIL_CODE[detail] ?? 1], query), held);
  if (res.main.groups.length !== N_GROUPS) throw new Error("planDomains: unerwartete Gruppen im Plan-Puffer");
  if (reuse) {
    chunkStores.delete(args);
    chunkStores.set(args, res.store);
    if (chunkStores.size > MAX_CHUNK_STORES) chunkStores.delete(chunkStores.keys().next().value!);
  }
  return { buf: res.main, chunks: res.chunks, args };
}

/**
 * Antwort von `planDomains` lesen: `[PLAN_MULTI_MAGIC, n, Länge Haupt, (Schlüssel, Länge | −1) × n]`,
 * dann Haupt-Puffer und mitgelieferte Stücke (je auf 8 Bytes aufgefüllt); Länge −1 = Stück aus `held`.
 */
function readPlanMulti(
  input: Uint8Array,
  held: Map<number, DecodedPlanBuf> | undefined,
): { main: DecodedPlanBuf; chunks: DecodedPlanBuf[]; store: Map<number, DecodedPlanBuf> } {
  const bytes = input.byteOffset % 8 === 0 ? input : input.slice();
  // Fehlerpuffer des Kerns: `decodePlanBuf` wirft dessen Meldung.
  if (bytes.byteLength < 24 || new Float64Array(bytes.buffer, bytes.byteOffset, 1)[0] !== PLAN_MULTI_MAGIC) {
    return { main: decodePlanBuf(bytes), chunks: [], store: new Map() };
  }
  const h = new Float64Array(bytes.buffer, bytes.byteOffset, 3);
  const n = h[1];
  const head = new Float64Array(bytes.buffer, bytes.byteOffset, 3 + 2 * n);
  const pad = (len: number) => len + ((8 - (len % 8)) % 8);
  let off = head.length * 8;
  const main = decodePlanBuf(bytes.subarray(off, off + h[2]));
  off += pad(h[2]);
  const chunks: DecodedPlanBuf[] = [];
  const store = new Map<number, DecodedPlanBuf>();
  for (let i = 0; i < n; i++) {
    const key = head[3 + 2 * i];
    const len = head[4 + 2 * i];
    let c: DecodedPlanBuf | undefined;
    if (len < 0) {
      c = held?.get(key);
      if (!c) throw new Error("planDomains: Zeichnungs-Stück fehlt");
    } else {
      // Eigene Kopie: ein behaltenes Stück hält so nicht die ganze Antwort fest.
      c = decodePlanBuf(bytes.slice(off, off + len));
      off += pad(len);
    }
    chunks.push(c);
    store.set(key, c);
  }
  return { main, chunks, store };
}

/**
 * Gruppen der kompakten Linien-Unterlage aus dem Kern (`drawingUnderlay`, dieselbe Auswahl wie die
 * Domäne der 2D-Zeichnungen): je (gedimmt, Ebene) die Zeichnungen, deren Linien der Plan-Puffer
 * nicht enthält. `build` holt die Linien einer Teilmenge bei Bedarf (`drawingLines`).
 */
function underlayGroups(project: Project, dom: DomainPrims, scaleDenominator: number): UnderlayGroup[] {
  const bytes = documentFor(project).queryBin("drawingUnderlay", [1], dom.args);
  if (bytes.byteLength % 8 !== 0) throw new Error("drawingUnderlay: unerwartete Antwort");
  const f = new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const all = project.drawings2d;
  // Zeichnung → Index in `drawings2d` (für `drawingLines`), erst beim ersten `build`.
  let index: Map<Drawing2D, number> | null = null;
  const indexOf = (d: Drawing2D): number | undefined => {
    if (!index) {
      index = new Map();
      for (let i = 0; i < all.length; i++) index.set(all[i], i);
    }
    return index.get(d);
  };
  // Alles, wovon `build` abhängt: ändert sich eine davon, werden die GPU-Chunks neu erzeugt.
  const ctx = [project.lineStyles, project.hatches, layersStyleSig(project.layers), scaleDenominator, project.overrideRules];
  const out: UnderlayGroup[] = [];
  let k = 1;
  for (let g = 0; g < f[0]; g++) {
    const catGreyed = f[k] === 1;
    const n = f[k + 1];
    const drawings: Drawing2D[] = new Array(n);
    for (let i = 0; i < n; i++) drawings[i] = all[f[k + 2 + i]];
    k += 2 + n;
    const buildBuf = (list: Drawing2D[]): DecodedPlanBuf => {
      const args = [scaleDenominator, catGreyed ? 1 : 0];
      for (const d of list) {
        const i = indexOf(d);
        if (i !== undefined) args.push(i);
      }
      return decodePlanBuf(documentFor(project).queryBin("drawingLines", args));
    };
    out.push({ drawings, catGreyed, tint: false, above: true, ctx, build: (list) => buildBuf(list).prims, buildBuf });
  }
  return out;
}

/**
 * Plan-Primitive EINER Zeichnung (auch einer, die nicht im Projekt steht, z. B. die transformierte
 * Vorschau) aus dem Kern (`drawingPrims`, ohne Override-Regeln), beim Massstab 1:`scaleDenominator`.
 * Blöcke, Linienstile, Schraffuren und Ebenen liest der Kern aus `project`.
 */
export function drawingPrimitives(project: Project, d: Drawing2D, scaleDenominator: number = DEFAULT_SCALE_DENOMINATOR): Primitive[] {
  return decodePlanBuf(documentFor(project).queryBin("drawingPrims", [scaleDenominator], JSON.stringify(d))).prims;
}

function computeBounds(
  project: Project,
  /** Ausmass der Kern-Domänen (Wand-Ecken, Decken, Räume, Dach-Traufen, Treppen, 2D-Zeichnungen), s. `planDomains`. */
  domainBox: [number, number, number, number] | undefined = undefined,
  /** Zusätzlich einzurahmende Primitive (Schatten, Parzelle), damit Druck/Einpassen sie ganz zeigen. */
  extra: Primitive[] = [],
) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (p: Vec2) => {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  };
  if (domainBox) {
    acc({ x: domainBox[0], y: domainBox[1] });
    acc({ x: domainBox[2], y: domainBox[3] });
  }
  for (const e of extra) {
    if (e.kind === "polygon") e.pts.forEach(acc);
    else if (e.kind === "line") { acc(e.a); acc(e.b); }
  }
  // GESAMTE Kontext-Schicht (Konturen, importierte Gebäude/Terrain, Luftbild)
  // mit einrahmen, damit „Einpassen"/die Standard-Ansicht sie zeigt — sonst
  // sässe die Ansicht bei einem reinen Kontext-Import (keine Wände) leer am
  // Ursprung und der Import wäre „unsichtbar" (Nutzer-Report).
  for (const obj of project.context ?? []) {
    if (obj.type === "contourSet") {
      for (const c of obj.contours) for (const p of c.pts) acc(p);
    } else if (obj.type === "image") {
      acc(obj.min);
      acc(obj.max);
    } else {
      const pos = obj.positions;
      for (let i = 0; i + 1 < pos.length; i += 3) acc({ x: pos[i], y: pos[i + 1] });
    }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}
