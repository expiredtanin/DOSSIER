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
// Abfrage `planDomains`, [K3d]) und liefert fertige `Primitive` — auch die freie
// 2D-Geometrie (`plan/drawings.rs`), Schattenstudie und Baurecht, Abzugskörper, Mono und
// Strichstärken-Massstab samt Ausmass (`plan/extras.rs`). `generatePlan` reicht nur noch
// Sichtbarkeit (UI-Zustand) und Optionen weiter und setzt den Plan aus den Puffern zusammen.
// Das `Primitive`-Vokabular und die Attribut-Auflösung für die übrigen TS-Pfade
// leben in `generatePlan/shared.ts`.

import type {
  ContextImage,
  ContextObject,
  Drawing2D,
  DrawingLevel,
  DrawingLevelKind,
  Project,
  Vec2,
} from "../model/types";
import { documentFor } from "../core/document";
import { decodePlanBuf, type DecodedPlanBuf } from "./planBuf";
import {
  HATCH_INK,
  HATCH_PAPER,
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
import { lazyPlan, piecesOf, planCount, planFields, type PlanPiece } from "./planLazy";
import { DEFAULT_SCALE_DENOMINATOR } from "../model/dimension";
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
   * Export/mono (reiner Schwarz-Weiss-Plan ohne Unterlage).
   */
  compactUnderlay = false,
): Plan {
  const compact = compactUnderlay && !mono && !forPrint;
  // Den ganzen Grundriss rechnet der Kern auf dem Dokument ([K3d]/[K4], `plan/{domains,walls,stairs,
  // drawings,extras}.rs`): Schattenstudie und Baurecht zuunterst, Decken, Dächer, Räume, Wände mit
  // Öffnungen, Treppen, Stützen, 2D-Zeichnungen, Extrusions-Umrisse, Kontext und Schnittführung,
  // die Baurechts-Verstösse zuoberst; dazu Abzugskörper, Schwarz-Weiss, Strichstärken nach Massstab
  // und das Ausmass. Er liefert einen Plan-Puffer (Gruppen in dieser Reihenfolge) und die
  // 2D-Zeichnungen in Stücken; der Plan liest die Primitive erst, wenn ein Verbraucher sie als
  // Objekte braucht (`planLazy.ts`), die GPU kompiliert direkt aus den Puffern (`bufRuns`).
  // Zeitpunkt der Schattenstudie: `Date` nimmt das Datum, wie es in der Datei steht (Ortszeit ohne Zone).
  const study = project.sunStudy;
  const sunWhen = includeGlobal && study?.show ? new Date(study.when).getTime() : NaN;
  const dom = planDomains(project, floorId, visibleCodes, categoryDisplay, detail, showReferenceLines, includeGlobal, scaleDenominator, forPrint, compact, mono, sunWhen);
  const pieces: PlanPiece[] = [];
  const pushGroups = (first: number, last: number): void => {
    const from = dom.buf.groups[first][0];
    const to = dom.buf.groups[last][1];
    if (to > from) pieces.push({ buf: dom.buf, from, to });
  };
  // Die 2D-Zeichnungen kommen als eigene Puffer-Stücke an Stelle ihrer (leeren) Gruppe.
  pushGroups(G_UNDER, G_COLUMNS);
  for (const c of dom.chunks) pieces.push({ buf: c, from: 0, to: c.count });
  pushGroups(G_SOLIDS, G_VIOLATIONS);
  // Kompakte Linien-Unterlage (s. {@link UnderlayGroup}): die Linien einfacher Zeichnungen fehlen
  // im Puffer und entstehen erst bei Bedarf, PRO KATEGORIE gruppiert — das Ein-/Ausblenden einer
  // Ebene entfernt dann nur deren Gruppe, die Chunks aller anderen Ebenen bleiben gültig.
  const underlay = compact ? underlayGroups(project, dom, scaleDenominator) : [];

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
  // Ausmass samt Schatten, Baurecht und Kontext (immer gesetzt, ohne Punkte 0,0–1,1).
  const [minX, minY, maxX, maxY] = dom.buf.bounds ?? [0, 0, 1, 1];
  return lazyPlan({ bounds: { minX, minY, maxX, maxY }, backgroundImages, ...(underlay.length ? { underlay } : {}) }, pieces);
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

/** Primitive der Kern-Domänen (`planDomains` in `queries.rs`) als gelesene Plan-Puffer v2. */
interface DomainPrims {
  /** Haupt-Puffer: Gruppen wie `plan/domains.rs::GROUPS`, Gruppe 6 (2D-Zeichnungen) leer. */
  buf: DecodedPlanBuf;
  /** Die 2D-Zeichnungen in Stücken (eigene Puffer, Zeichenreihenfolge). */
  chunks: DecodedPlanBuf[];
  /** Argumente der Abfrage (für `drawingUnderlay`). */
  args: string;
}

/**
 * Gruppen des Puffers: Schatten/Baurecht, die Domänen (`plan/domains.rs::GROUPS`: Decken … Stützen,
 * 2D-Zeichnungen — im Haupt-Puffer leer —, Körper, Kontext, Schnittlinien), Baurechts-Verstösse.
 */
const G_UNDER = 0;
const G_COLUMNS = 6;
const G_SOLIDS = 8;
const G_VIOLATIONS = 11;
const N_GROUPS = 12;

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

/** Argumente der Kern-Abfrage `planDomains` (auch `planUnderlay`). */
function planDomainsArgs(
  floorId: string,
  visibleCodes: Set<string>,
  categoryDisplay: CategoryDisplayResolver,
  referenceLines: boolean,
  global: boolean,
  scale: number,
  forPrint: boolean,
  compact: boolean,
  mono: boolean,
  sunWhen: number,
): Record<string, unknown> {
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
  return { floor: floorId, show, grey, referenceLines, global, scale, forPrint, compact, mono, sunWhen: Number.isNaN(sunWhen) ? null : sunWhen };
}

/**
 * Grundriss-Unterlage in Schnitt/Ansicht aus dem Kern (`plan/underlay.rs`, früher `planUnderlay.ts`):
 * der Grundriss des Geschosses `floorId` (wie `generatePlan` ohne projektglobale Zutaten, aus den
 * Plan-Caches) AUSGERICHTET unter die Schnitt-/Ansichtsfläche gelegt, deren tiefste Kante bei
 * `sectionMinY` liegt — Schnittlinie waagrecht, Blickrichtung im Blatt nach oben, u-Achse wie im
 * Schnitt. Gedimmt, ohne Auswahl-Ids (fremde Projektion), plus die Schnittlinie (strichpunktiert).
 */
export function planUnderlayPrimitives(
  project: Project,
  level: DrawingLevel,
  floorId: string,
  sectionMinY: number,
  visibleCodes: Set<string>,
  categoryDisplay: CategoryDisplayResolver = SHOW_ALL,
  detail: DetailLevel = "mittel",
  showReferenceLines = false,
  mono = false,
  scaleDenominator: number = DEFAULT_SCALE_DENOMINATOR,
): Primitive[] {
  const args = planDomainsArgs(floorId, visibleCodes, categoryDisplay, showReferenceLines, false, scaleDenominator, false, false, mono, NaN);
  const text = JSON.stringify({ ...args, level: { kind: level.kind, linePoints: level.linePoints, directionSign: level.directionSign }, minY: sectionMinY });
  return decodePlanBuf(documentFor(project).queryBin("planUnderlay", [DETAIL_CODE[detail] ?? 1], text)).prims;
}

/**
 * Welche Fremd-Art-Ebene darf als Unterlage in welcher aktiven Ebene erscheinen?
 * Massgebend ist der Koordinatenraum: Geschoss und freie Zeichnung teilen X/Y,
 * Schnitte/Ansichten messen dagegen Länge×Höhe entlang IHRER Linie. Ein Schnitt
 * im Grundriss (oder ein Grundriss/eine andere Ansicht im Schnitt) lag darum
 * nur zufällig irgendwo und überdeckte den eigentlichen Plan (Nutzer-Report
 * 2026-10-20: Fenster der Ansicht im EG-Grundriss, Raumstempel im Schnitt).
 *  • freie Zeichnung: alles (Kalkierpapier zum Abzeichnen, Nutzer-Wunsch).
 *  • Geschoss: nur freie Zeichnungen (gleicher X/Y-Raum).
 *  • Schnitt/Ansicht: nichts — ein Grundriss kommt dort ausgerichtet über
 *    `DrawingLevel.planUnderlayId` dazu (s. {@link planUnderlayPrimitives}).
 */
export function crossKindOverlayAllowed(active: DrawingLevelKind, other: DrawingLevelKind): boolean {
  if (active === "drawing") return true;
  if (active === "floor") return other === "drawing";
  return false;
}

/**
 * Der Grundriss eines Geschosses aus dem Kern: Decken, Dächer, Räume, Wände mit Öffnungen, Treppen,
 * Stützen, 2D-Zeichnungen, Extrusions-Umrisse und (mit `global`) Schatten, Baurecht, Kontext-Konturen
 * und Schnittführungs-Symbole; Abzugskörper, Mono und Strichstärken-Massstab sind eingerechnet.
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
  mono: boolean,
  /** Zeitpunkt der Schattenstudie (Unix-ms, NaN = keiner). */
  sunWhen: number,
): DomainPrims {
  const args = JSON.stringify(planDomainsArgs(floorId, visibleCodes, categoryDisplay, referenceLines, global, scale, forPrint, compact, mono, sunWhen));
  const held = chunkStores.get(args);
  const query = held && held.size ? `${args.slice(0, -1)},"have":[${[...held.keys()].join(",")}]}` : args;
  const res = readPlanMulti(documentFor(project).queryBin("planDomains", [DETAIL_CODE[detail] ?? 1], query), held);
  if (res.main.groups.length !== N_GROUPS) throw new Error("planDomains: unerwartete Gruppen im Plan-Puffer");
  chunkStores.delete(args);
  chunkStores.set(args, res.store);
  if (chunkStores.size > MAX_CHUNK_STORES) chunkStores.delete(chunkStores.keys().next().value!);
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
  const ctx = [project.lineStyles, project.hatches, layersStyleSig(project.layers), scaleDenominator, project.overrideRules, project.scaleLineWeights];
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
