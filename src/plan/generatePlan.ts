// Grundriss-Generator: erzeugt aus dem semantischen Modell den
// 2D-Grundriss als abstrakte Vektor-Primitive (später → SVG).
//
// Kern-Erkenntnis: Der Grundriss entsteht NICHT durch Zerschneiden eines
// 3D-Meshes, sondern direkt aus den Parametern (Wandachsen, Schichtaufbau,
// Öffnungen) — exakt, schnell, sauber.
//
// Diese Datei ist nur noch der ORCHESTRATOR `generatePlan()` (Schnitt und Ansicht:
// `toSection.ts`/`toElevation.ts`, im Kern). Die Bauteil-Domänen (Decken, Dächer, Räume,
// Wände mit Öffnungen, Treppen, Stützen, Extrusionen, Kontext, Schnittführung)
// rechnet der Rust-Kern auf dem Projekt-Dokument (`src-tauri/core/src/plan/`,
// Abfrage `planDomains`, [K3d]) und liefert fertige `Primitive`. In TS bleiben
// die freie 2D-Geometrie (`generatePlan/drawing2d.ts`), Schattenstudie und
// Baurecht, die Abzugskörper (`voids.ts`), Mono und der Strichstärken-Massstab.
// Das `Primitive`-Vokabular und die Attribut-Auflösung für die übrigen TS-Pfade
// leben in `generatePlan/shared.ts`.

import type {
  ContextImage,
  ContextObject,
  Drawing2D,
  LayerCategory,
  OverrideActions,
  Project,
  Vec2,
} from "../model/types";
import { flattenCategories } from "../model/types";
import { documentFor } from "../core/document";
import { decodePlanBuf, type DecodedPlanBuf } from "./planBuf";
import { effectiveOverrides, hasOverrides } from "../overrides/engine";
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
import {
  addDrawing2D,
  addDrawing2DWithoutLines,
  drawingLinePrims,
  isCompactUnderlayEligible,
} from "./generatePlan/drawing2d";
import { drawingBox } from "../geometry/drawingBounds";
import { layersStyleSig } from "./generatePlan/layerSig";

// Re-Export des gemeinsamen Vokabulars — externe Konsumenten (Export-Pipeline,
// PlanView, toSection.ts, toWalls3d.ts, toRenderScene.ts, …) importieren
// weiterhin ausschliesslich von hier, unverändert zur Zeit vor dem Domänen-Split.
export { HATCH_INK, HATCH_PAPER, resolveBackground, resolveForeground, resolveHatch, resolveHatchId };
export type { CategoryDisplayResolver, DetailLevel, HatchRender, Primitive };

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
}

/**
 * Macht aus `plan.underlay` wieder gewöhnliche 'line'-Primitive (für Verbraucher,
 * die Primitive brauchen). Reihenfolge: Referenz-Ebenen unten, aktive oben;
 * gedimmte Referenz-Linien werden über `greyedRanges` markiert.
 */
export function materializeUnderlay(plan: Plan): Plan {
  const groups = plan.underlay;
  if (!groups || groups.length === 0) return plan;
  const below: Primitive[] = [];
  const above: Primitive[] = [];
  const belowGreyed: Array<[number, number]> = [];
  const aboveGreyed: Array<[number, number]> = [];
  for (const g of groups) {
    const target = g.above ? above : below;
    const from = target.length;
    for (const pr of g.build(g.drawings)) target.push(pr);
    if (g.tint && target.length > from) (g.above ? aboveGreyed : belowGreyed).push([from, target.length]);
  }
  // Stücke statt Kopie (s. `planLazy.ts`): die Primitive des Plans werden dabei nicht gelesen.
  const n = planCount(plan);
  const shifted = (plan.greyedRanges ?? []).map(([a, b]): [number, number] => [a + below.length, b + below.length]);
  const aboveShift = below.length + n;
  const ranges = [
    ...belowGreyed,
    ...shifted,
    ...aboveGreyed.map(([a, b]): [number, number] => [a + aboveShift, b + aboveShift]),
  ];
  const { underlay: _u, greyedRanges: _g, ...fields } = planFields(plan);
  return lazyPlan({ ...fields, ...(ranges.length ? { greyedRanges: ranges } : {}) }, [below, ...piecesOf(plan), above]);
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
  // Code → Kategorie-Strichstärke (mm), damit die Wand-Umrisslinie aus dem
  // Modell (Ebene) stammt statt aus einer Magie-Konstante.
  const lwByCode = categoryLwMap(project.layers);
  const colorByCode = categoryColorMap(project.layers);
  // Code → volle LayerCategory, für die By-Layer-Attribut-Auflösung (Quelle
  // "layer" von Vordergrund/Hintergrund/Strichstärke/Schraffur).
  const catByCode = categoryMap(project.layers);

  // ── Grafische Overrides (Regel-Engine, src/overrides/engine.ts) ───────────
  // Effektive Aktionen je Element als OBERSTE Schicht ÜBER der regulären
  // By-Layer/By-Object-Auflösung: die Elemente werden hier — rein zur
  // Renderzeit — mit den Regel-Ergebnissen dekoriert (flache Kopien; das
  // Projekt bleibt unverändert, jederzeit reversibel). `layer_name` matcht
  // Ebenen-Name ODER -Code, `object_name` den Element-/Typ-Namen.
  const overrideFor = (
    categoryCode: string,
    objectName?: string,
  ): OverrideActions =>
    effectiveOverrides(project.overrideRules, {
      layerName: catByCode.get(categoryCode)?.name,
      layerCode: categoryCode,
      objectName,
    });
  // Freie 2D-Zeichengeometrie dieses Geschosses (wie Wände nach sichtbaren
  // Kategorien + Darstellungsmodus gefiltert). Wird über der Wand-Poché
  // gezeichnet (am Ende angehängt).
  const drawings = project.drawings2d
    .filter(
      (d) =>
        d.levelId === floorId &&
        visibleCodes.has(d.categoryCode) &&
        categoryDisplay(d.categoryCode).render &&
        (!forPrint || !d.noPrint),
    )
    .map((d) => {
      // `object_name` matcht bei freier 2D-Geometrie den Formnamen
      // (line/polyline/rect/circle/arc/text). Linienstil-Override nur hier —
      // Drawing2D ist das einzige Element mit LineStyle-Referenz.
      const ov = overrideFor(d.categoryCode, d.geom.shape);
      if (!hasOverrides(ov)) return d;
      return {
        ...d,
        color: ov.color ?? d.color,
        weightMm: ov.lineweight ?? d.weightMm,
        lineStyleId: ov.linetypeId ?? d.lineStyleId,
      };
    });

  // Decken, Dächer, Räume, Wände mit Öffnungen, Treppen, Stützen und Extrusions-Umrisse rechnet der
  // Kern auf dem Dokument ([K3d], `plan/{domains,walls,stairs}.rs`): Filter, Override-Regeln,
  // Verschneidung, Stil und Raumstempel-Daten. Decken, Dächer und Räume liegen unter der Wand-Poché; Stützen folgen
  // nach den Treppen, Extrusionen nach den 2D-Zeichnungen.
  // Der Kern liefert alles in EINEM Plan-Puffer (Gruppen in dieser Reihenfolge); die Abschnitte
  // merkt sich der Plan (`bufRuns`), damit die GPU sie direkt aus dem Puffer kompiliert.
  const dom = planDomains(project, floorId, visibleCodes, categoryDisplay, detail, showReferenceLines, includeGlobal);
  // Der Plan entsteht aus Stücken ([K3d], `planLazy.ts`): TS-Listen und Kern-Abschnitte; die
  // Kern-Primitive werden erst gelesen, wenn ein Verbraucher sie als Objekte braucht.
  const pieces: PlanPiece[] = [primitives];
  const pushGroups = (first: number, last: number): void => {
    if (!dom.buf) return;
    const from = dom.buf.groups[first][0];
    const to = dom.buf.groups[last][1];
    if (to > from) pieces.push({ buf: dom.buf, from, to });
  };
  // Decken, Dächer, Räume; Wände (Poché, Referenzlinie) mit ihren Öffnungs-Symbolen, je Wand
  // nacheinander; Treppen (Tritte + Lauflinie + Auf-/Abpfeil mit dem Grundriss-Schnitt, über der
  // Wand-Poché); Stützen (Querschnitt-Poché).
  pushGroups(G_CEILINGS, G_COLUMNS);

  // 2D-Zeichengeometrie zuletzt (über der Poché).
  const drawingPrims: Primitive[] = [];
  pieces.push(drawingPrims);
  const compact = compactUnderlay && !mono && !forPrint;
  // Kompakte Unterlage PRO KATEGORIE gruppiert: das Ein-/Ausblenden einer Ebene
  // entfernt dann nur deren Gruppe — die Chunks aller anderen Ebenen bleiben
  // identisch und werden wiederverwendet (statt dass fast jeder Chunk eine der
  // ausgeblendeten Zeichnungen enthielt und neu kompiliert werden musste).
  const underGroups = new Map<string, { ds: Drawing2D[]; greyed: boolean }>();
  for (const d of drawings) {
    const greyed = categoryDisplay(d.categoryCode).greyed;
    if (compact && isCompactUnderlayEligible(d)) {
      addDrawing2DWithoutLines(drawingPrims, project, d, greyed, lwByCode, colorByCode, catByCode, scaleDenominator);
      const key = `${greyed ? 1 : 0}:${d.categoryCode}`;
      const grp = underGroups.get(key);
      if (grp) grp.ds.push(d);
      else underGroups.set(key, { ds: [d], greyed });
    } else {
      addDrawing2D(drawingPrims, project, d, greyed, lwByCode, colorByCode, catByCode, scaleDenominator, !mono);
    }
  }
  const underlay: UnderlayGroup[] = [];
  const mkGroup = (ds: Drawing2D[], catGreyed: boolean): UnderlayGroup => ({
    drawings: ds,
    catGreyed,
    tint: false,
    above: true,
    // Alles, wovon `build` abhängt (s. drawingPrimCache): ändert sich eine davon,
    // müssen die GPU-Chunks dieser Gruppe neu erzeugt werden.
    ctx: [project.lineStyles, project.hatches, layersStyleSig(project.layers), scaleDenominator],
    build: (list) => {
      const out: Primitive[] = [];
      for (const d of list) {
        drawingLinePrims(out, project, d, catGreyed, lwByCode, colorByCode, catByCode, scaleDenominator);
      }
      return out;
    },
  });
  for (const grp of underGroups.values()) underlay.push(mkGroup(grp.ds, grp.greyed));

  // Extrudierte Körper: Footprint-Umriss (Quell-Profil wurde beim Extrudieren entfernt).
  // Kontext-Konturen (Höhenlinien) als dezente Linien zeichnen — UNTER der
  // Wand-Poché wäre ideal, aber da sie eine eigene gedämpfte Farbe tragen, ist
  // die Reihenfolge unkritisch; wir hängen sie als Referenz an. Projektglobal
  // (nicht je Geschoss) → nur beim aktiven Aufruf einer Mehrfach-Überlagerung.
  // Schnittführungs-Symbole aller Schnitt-/Ansichtsebenen mit Linie — ebenfalls projektglobal,
  // Sichtbarkeit über die Kategorie "90" (Referenzen).
  pushGroups(G_SOLIDS, G_SECTIONS);

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
        }));
  const rest = {
    bounds: computeBounds(project, drawings, dom.buf?.bounds, primitives.slice(0, underlayCount)),
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

/** Baut eine Map Kategorie-Code → Strichstärke (mm) über den ganzen Baum. */
function categoryLwMap(layers: LayerCategory[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of flattenCategories(layers)) map.set(c.code, c.lw);
  return map;
}

/** Baut eine Map Kategorie-Code → Farbe über den ganzen Baum. */
function categoryColorMap(layers: LayerCategory[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of flattenCategories(layers)) map.set(c.code, c.color);
  return map;
}

/**
 * Baut eine Map Kategorie-Code → volle LayerCategory über den ganzen Baum, für
 * die By-Layer-Attribut-Auflösung (Quelle "layer" von Vordergrund/Hintergrund/
 * Strichstärke/Schraffur, siehe {@link resolveForeground} und Geschwister).
 */
function categoryMap(layers: LayerCategory[]): Map<string, LayerCategory> {
  const map = new Map<string, LayerCategory>();
  for (const c of flattenCategories(layers)) map.set(c.code, c);
  return map;
}

/** Primitive der Kern-Domänen (`planDomains` in `queries.rs`) als gelesener Plan-Puffer v2. */
interface DomainPrims {
  /** Fehlt, wenn das Geschoss nichts für den Kern enthält. */
  buf?: DecodedPlanBuf;
}

/** Gruppen des Puffers (`plan/domains.rs::GROUPS`). */
const G_CEILINGS = 0;
const G_COLUMNS = 5;
const G_SOLIDS = 6;
const G_SECTIONS = 8;
const N_GROUPS = 9;

const NO_DOMAINS: DomainPrims = {};
const DETAIL_CODE: Record<DetailLevel, number> = { grob: 0, mittel: 1, fein: 2 };

/**
 * Decken, Dächer, Räume, Wände mit Öffnungen, Treppen, Stützen, Extrusions-Umrisse eines Geschosses
 * und (mit `global`) Kontext-Konturen und Schnittführungs-Symbole aus dem Kern. Sichtbarkeit und Darstellungsmodus (UI-Zustand) gehen als Code-Mengen mit: `show` =
 * sichtbar und gezeichnet, `grey` = gedimmt.
 */
function planDomains(
  project: Project,
  floorId: string,
  visibleCodes: Set<string>,
  categoryDisplay: CategoryDisplayResolver,
  detail: DetailLevel,
  referenceLines: boolean,
  global: boolean,
): DomainPrims {
  const codes = new Set<string>();
  let any = false;
  const take = (list: ReadonlyArray<{ floorId: string; categoryCode: string }> | undefined) => {
    for (const e of list ?? []) {
      if (e.floorId !== floorId) continue;
      codes.add(e.categoryCode);
      any = true;
    }
  };
  take(project.ceilings);
  take(project.roofs);
  take(project.rooms);
  take(project.columns);
  take(project.walls);
  take(project.stairs);
  if (global) {
    // Kontext-Objekte ohne Kategorie sind immer sichtbar; Schnittlinien hängen an "90".
    for (const o of project.context ?? []) {
      if (o.type === "image") continue;
      any = true;
      if (o.categoryCode !== undefined) codes.add(o.categoryCode);
    }
    if (project.drawingLevels.some((l) => (l.kind === "section" || l.kind === "elevation") && l.linePoints)) {
      any = true;
      codes.add("90");
    }
  }
  if (!any && !(project.extrudedSolids ?? []).some((x) => x.levelId === floorId)) return NO_DOMAINS;
  for (const o of project.openings ?? []) codes.add(o.categoryCode);
  const show: string[] = [];
  const grey: string[] = [];
  for (const c of codes) {
    if (!visibleCodes.has(c)) continue;
    const d = categoryDisplay(c);
    if (!d.render) continue;
    show.push(c);
    if (d.greyed) grey.push(c);
  }
  const buf = decodePlanBuf(
    documentFor(project).queryBin(
      "planDomains",
      [DETAIL_CODE[detail] ?? 1],
      JSON.stringify({ floor: floorId, show, grey, referenceLines, global }),
    ),
  );
  if (buf.groups.length !== N_GROUPS) throw new Error("planDomains: unerwartete Gruppen im Plan-Puffer");
  return { buf };
}

function computeBounds(
  project: Project,
  drawings: Drawing2D[] = [],
  /** Ausmass der Kern-Domänen (Wand-Ecken, Decken, Räume, Dach-Traufen, Treppen), s. `planDomains`. */
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
  for (const d of drawings) {
    const g = d.geom;
    if (g.shape === "line" || g.shape === "polyline") {
      // Box je Zeichnung gecacht (drawingBounds.ts) statt über alle Punkte.
      const b = drawingBox(d);
      if (isFinite(b.minX)) {
        acc({ x: b.minX, y: b.minY });
        acc({ x: b.maxX, y: b.maxY });
      }
    }
    else if (g.shape === "rect") { acc(g.min); acc(g.max); }
    else if (g.shape === "circle" || g.shape === "arc") {
      acc({ x: g.center.x - g.r, y: g.center.y - g.r });
      acc({ x: g.center.x + g.r, y: g.center.y + g.r });
    } else if (g.shape === "ellipse") {
      acc({ x: g.center.x - g.rx, y: g.center.y - g.ry });
      acc({ x: g.center.x + g.rx, y: g.center.y + g.ry });
    } else if (g.shape === "bezier" || g.shape === "spline") {
      g.pts.forEach(acc);
    } else if (g.shape === "dimension") {
      g.pts.forEach(acc);
      // Masslinie liegt um `offset` versetzt (linke Normale je Segment), die Masszahl noch etwas
      // weiter aussen — beides mit einrahmen, sonst schneiden Druck/Einpassen die Kette ab.
      const reach = g.offset * 1.4;
      for (let i = 0; i + 1 < g.pts.length; i++) {
        const a = g.pts[i], b = g.pts[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1e-9) continue;
        const nx = (-(b.y - a.y) / len) * reach, ny = ((b.x - a.x) / len) * reach;
        acc({ x: a.x + nx, y: a.y + ny });
        acc({ x: b.x + nx, y: b.y + ny });
      }
    } else if (g.shape === "kote") acc(g.at);
    else if (g.shape === "detailref") acc(g.at);
    else if (g.shape === "scalebar") {
      acc(g.at);
      acc({ x: g.at.x + g.segmentLength * g.segments, y: g.at.y });
    }
    else if (g.shape === "pointmarker") acc(g.at);
    else if (g.shape === "text") acc(g.at);
    else if (g.shape === "image") { acc(g.min); acc(g.max); }
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
