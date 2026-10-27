// Grundriss-Generator: erzeugt aus dem semantischen Modell den
// 2D-Grundriss als abstrakte Vektor-Primitive (später → SVG).
//
// Kern-Erkenntnis: Der Grundriss entsteht NICHT durch Zerschneiden eines
// 3D-Meshes, sondern direkt aus den Parametern (Wandachsen, Schichtaufbau,
// Öffnungen) — exakt, schnell, sauber.
//
// Diese Datei ist nur noch der ORCHESTRATOR: `generatePlan()`/
// `generateSectionPlan()` sowie die `resolve*SectionStyle`-Helfer (für den
// Schnitt-Pfad, `toSection.ts`). Das gemeinsame `Primitive`-Vokabular, die
// By-Layer/By-Object-Attribut-Auflösung (`resolveHatch`/`resolveForeground`/…)
// und die Papier-mm-/Tinten-Konstanten leben in `generatePlan/shared.ts`; jede
// Bauteil-Domäne (Wände, Decken, Öffnungen, Treppen, Dächer, Kontext,
// Schnittführung, Räume, sonstige Tragwerks-/Fremdkörper, freie 2D-Geometrie)
// hat ihre eigene Datei unter `generatePlan/` — siehe dort für die konkrete
// Zeichenlogik je Bauteil.

import type {
  Ceiling,
  Component,
  ContextImage,
  ContextObject,
  Drawing2D,
  LayerCategory,
  OverrideActions,
  Project,
  Roof,
  Room,
  Stair,
  Vec2,
  Wall,
} from "../model/types";
import {
  columnLabel,
  columnsOfFloor,
  flattenCategories,
  getCeilingType,
  getComponent,
  getLayerCategory,
  getWallType,
  openingLabel,
  openingsOfWall,
  roomsOfFloor,
  stairLabel,
  stairsOfFloor,
  wallTypeThickness,
} from "../model/types";
import { roofGeometry } from "../geometry/roof";
import { effectiveOverrides, hasOverrides } from "../overrides/engine";
import { stairVerticalExtent, wallVerticalExtent } from "../model/wall";
import { stairGeometry } from "../geometry/stair";
import { wallCorners } from "../model/geometry";
import { computeJoins } from "../model/joins";
import type { SectionOutput } from "./toSection";
import {
  HATCH_INK,
  HATCH_PAPER,
  LAYER_LINE_MM,
  MONO_INK,
  SHOW_ALL,
  WALL_FALLBACK_MM,
  resolveBackground,
  resolveForeground,
  resolveHatch,
  resolveHatchId,
  resolveStrokeWeight,
  type CategoryDisplayResolver,
  type DetailLevel,
  type HatchRender,
  type Primitive,
} from "./generatePlan/shared";
import { addCeilingPoche } from "./generatePlan/ceilings";
import { subtractVoidsInPlan } from "./voids";
import { addContextContours } from "./generatePlan/context";
import { addSunShadow } from "./generatePlan/sunShadow";
import { DEFAULT_SCALE_DENOMINATOR } from "../model/dimension";
import {
  addDrawing2D,
  addDrawing2DWithoutLines,
  drawingLinePrims,
  isCompactUnderlayEligible,
} from "./generatePlan/drawing2d";
import { drawingBox } from "../geometry/drawingBounds";
import { layersStyleSig } from "./generatePlan/layerSig";
import { addOpeningSymbol } from "./generatePlan/openings";
import { addRoof } from "./generatePlan/roofs";
import { addRoomArea } from "./generatePlan/rooms";
import { addSectionLines } from "./generatePlan/sections";
import { addStairSymbol } from "./generatePlan/stairs";
import { addColumnPoche, addExtrudedSolidOutline } from "./generatePlan/structures";
import { addReferenceLine, addWallPoche, buildWallFootprints, wallGaps } from "./generatePlan/walls";

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
  const primitives: Primitive[] = [];
  for (const pr of below) primitives.push(pr);
  for (const pr of plan.primitives) primitives.push(pr);
  for (const pr of above) primitives.push(pr);
  const shifted = (plan.greyedRanges ?? []).map(([a, b]): [number, number] => [a + below.length, b + below.length]);
  const aboveShift = below.length + plan.primitives.length;
  const ranges = [
    ...belowGreyed,
    ...shifted,
    ...aboveGreyed.map(([a, b]): [number, number] => [a + aboveShift, b + aboveShift]),
  ];
  return {
    ...plan,
    primitives,
    underlay: undefined,
    greyedRanges: ranges.length ? ranges : undefined,
  };
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
  const shadowCount = primitives.length;
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
  const wallTypeNameById = new Map(project.wallTypes.map((t) => [t.id, t.name]));
  const ceilingTypeNameById = new Map(
    (project.ceilingTypes ?? []).map((t) => [t.id, t.name]),
  );

  // Sichtbarkeit wie bisher; der Darstellungsmodus verfeinert sie zusätzlich:
  // render=false blendet die Wand aus, greyed=true dimmt sie.
  const walls = project.walls
    .filter(
      (w) =>
        w.floorId === floorId &&
        visibleCodes.has(w.categoryCode) &&
        categoryDisplay(w.categoryCode).render,
    )
    .map((w) => {
      // Regel-Override gewinnt über den Per-Instanz-Wert (oberste Schicht):
      // Farbe → Umriss-/Fugenfarbe (Wall.color), Strichstärke → strokeWeight
      // (der topmost-Wert der bestehenden resolveStrokeWeight-Kette).
      const ov = overrideFor(w.categoryCode, wallTypeNameById.get(w.wallTypeId));
      if (!hasOverrides(ov)) return w;
      return {
        ...w,
        color: ov.color ?? w.color,
        strokeWeight: ov.lineweight ?? w.strokeWeight,
      };
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

  // Decken dieses Geschosses (wie Wände nach sichtbaren Kategorien +
  // Darstellungsmodus gefiltert). Eine Decke liegt (als Slab) über der
  // Schnittebene → im Grundriss als gefüllter/schraffierter Umriss dargestellt,
  // UNTER der Wand-Poché (damit die Wände darüber lesbar bleiben).
  const ceilings = (project.ceilings ?? [])
    .filter(
      (c) =>
        c.floorId === floorId &&
        visibleCodes.has(c.categoryCode) &&
        categoryDisplay(c.categoryCode).render,
    )
    .map((c) => {
      // Decken: nur der Farb-Override wirkt (der Umriss ist eine feste
      // Überkopf-Haarlinie, siehe addCeilingPoche — keine Strichstärke).
      const typeName =
        (c.ceilingTypeId ? ceilingTypeNameById.get(c.ceilingTypeId) : undefined) ??
        wallTypeNameById.get(c.wallTypeId);
      const ov = overrideFor(c.categoryCode, typeName);
      return ov.color !== undefined ? { ...c, color: ov.color } : c;
    });
  // Wand-Footprints für das Verdecken der (darunterliegenden) Decken-Umrisse:
  // die Decke liegt als Slab über der Schnittebene, ihre Umrisslinie soll dort,
  // wo eine Wand darüber steht, NICHT durch die Wand-Poché schlagen. Nur nötig,
  // wenn es überhaupt Decken gibt.
  const wallFootprints = ceilings.length ? buildWallFootprints(project, walls) : [];
  for (const ceiling of ceilings) {
    const greyed = categoryDisplay(ceiling.categoryCode).greyed;
    const category = catByCode.get(ceiling.categoryCode);
    // Strichstärke wie bei der Wand (Attribut-Override > Kategorie > Fallback);
    // der Umriss bleibt trotzdem eine gestrichelte Überkopf-Ansichtslinie
    // (Dash-Muster unverändert, s. addCeilingPoche) — nur die Dicke ist editierbar.
    const ceilingLwMm = resolveStrokeWeight(
      ceiling.strokeWeight,
      ceiling.strokeWeightSource,
      category,
      lwByCode.get(ceiling.categoryCode) ?? LAYER_LINE_MM,
    );
    addCeilingPoche(primitives, project, ceiling, greyed, detail, category, wallFootprints, ceilingLwMm);
  }

  // Dächer dieses Geschosses (Dachaufsicht): reine Grundriss-Linien (Traufe/
  // First/Grat/Knick), kein Poché. Über der Wand-Poché gezeichnet.
  const roofs = (project.roofs ?? []).filter(
    (r) =>
      r.floorId === floorId &&
      visibleCodes.has(r.categoryCode) &&
      categoryDisplay(r.categoryCode).render,
  );
  for (const roof of roofs) {
    const greyed = categoryDisplay(roof.categoryCode).greyed;
    const category = catByCode.get(roof.categoryCode);
    addRoof(primitives, project, roof, greyed, category);
  }

  // Räume (SIA-416-Flächen) dieses Geschosses: transluzente Farbfüllung + Stempel
  // (Name + Fläche + SIA-Tag). UNTER der Wand-Poché gezeichnet, damit die Wände
  // lesbar bleiben. Der Stempel (Text) entfällt beim Detailgrad „grob".
  const rooms = roomsOfFloor(project, floorId)
    .filter(
      (r) =>
        visibleCodes.has(r.categoryCode) && categoryDisplay(r.categoryCode).render,
    )
    .map((r) => {
      // Räume: `object_name` matcht den Raum-Namen; der Farb-Override färbt
      // Fläche + Stempel (Room.color) um.
      const ov = overrideFor(r.categoryCode, r.name);
      return ov.color !== undefined ? { ...r, color: ov.color } : r;
    });
  for (const room of rooms) {
    const greyed = categoryDisplay(room.categoryCode).greyed;
    addRoomArea(primitives, room, greyed, detail);
  }

  // Gehrungs-Schnittlinien einmal pro Plan berechnen (auf der gefilterten Menge).
  const joins = computeJoins(project, walls);

  for (const wall of walls) {
    const wallGreyed = categoryDisplay(wall.categoryCode).greyed;
    const wallCategory = catByCode.get(wall.categoryCode);
    const wallLwMm = resolveStrokeWeight(
      wall.strokeWeight,
      wall.strokeWeightSource,
      wallCategory,
      lwByCode.get(wall.categoryCode) ?? WALL_FALLBACK_MM,
    );
    // Öffnungen (Fenster/Türen) am Wandhost sparen die Wand-Poché aus (Lücken-Intervall-Liste).
    const openings = openingsOfWall(project, wall.id);
    const gaps = wallGaps(wall, openings);
    const cuts = joins.get(wall.id) ?? { startCut: null, endCut: null };
    // Schnitt vs. Ansicht nach Schnitthöhe (BIM-Standard): erreicht die Wand die
    // Grundriss-Schnittebene nicht (z. B. eine Brüstung/ein Podestrand), wird sie
    // nur als Ansichts-Umriss gezeichnet — keine Schnitt-Poché. Normale Wände
    // (Schnittebene liegt in ihrer vertikalen Ausdehnung) sind unberührt. Über
    // `wallVerticalExtent` aufgelöst (nicht nur `wall.height`), damit ein
    // `bottom`/`top`-Override (VerticalAnchor) korrekt einfliesst — sonst würde
    // z. B. eine hochgesetzte Wand (angehobenes UK, Höhe allein sieht „hoch genug"
    // aus) fälschlich als Schnitt-Poché statt als Ansichts-Umriss gezeichnet.
    const { zBottom: wallZBottom, zTop: wallZTop } = wallVerticalExtent(project, wall);
    const cutPlaneZ = (floor?.baseElevation ?? 0) + (floor?.cutHeight ?? 1.0);
    const wallViewOnly = wallZTop < cutPlaneZ || wallZBottom > cutPlaneZ;
    addWallPoche(
      primitives, project, wall, gaps, cuts, wallGreyed, detail, wallLwMm, wallCategory, wallViewOnly,
    );
    // Referenzlinie: dünne gestrichelte Wand-Achslinie (von der Oberleiste
    // umschaltbar). Wird über der Poché gezeichnet, damit sie sichtbar bleibt.
    if (showReferenceLines) addReferenceLine(primitives, wall, wallGreyed);
    // Öffnungs-Symbole (Fenster/Tür) je Detailgrad + Auswahl-taggbar.
    for (const o of openings) {
      const d = categoryDisplay(o.categoryCode);
      if (visibleCodes.has(o.categoryCode) && d.render) {
        // Override-Regeln: `object_name` matcht das Öffnungs-Label
        // („Tür 90×210" / „Fenster 120×140").
        const ov = overrideFor(o.categoryCode, openingLabel(o));
        const oLwMm =
          ov.lineweight ?? lwByCode.get(o.categoryCode) ?? LAYER_LINE_MM;
        const effO = ov.color !== undefined ? { ...o, color: ov.color } : o;
        // Per-Element-Detailstufe (`Opening.detailLevel`) übersteuert die
        // ansichtsweite `detail`, sonst gilt Letztere unverändert.
        const effDetail = o.detailLevel ?? detail;
        addOpeningSymbol(primitives, project, wall, effO, d.greyed, effDetail, oLwMm);
      }
    }
  }

  // Treppen dieses Geschosses: Tritte + Lauflinie + Auf-/Abpfeil, mit dem
  // Grundriss-Schnitt (Tritte unter der Schnitthöhe durchgezogen, darüber
  // gestrichelt/verdeckt + SIA-Bruchlinie). Über der Wand-Poché gezeichnet.
  const cutHeight = floor?.cutHeight ?? 1.0;
  const stairs = stairsOfFloor(project, floorId).filter(
    (s) =>
      visibleCodes.has(s.categoryCode) && categoryDisplay(s.categoryCode).render,
  );
  for (const stair of stairs) {
    const greyed = categoryDisplay(stair.categoryCode).greyed;
    // Override-Regeln: `object_name` matcht das Treppen-Label („Gerade 16 STG").
    const ov = overrideFor(stair.categoryCode, stairLabel(stair));
    const lwMm =
      ov.lineweight ?? lwByCode.get(stair.categoryCode) ?? WALL_FALLBACK_MM;
    const effStair = ov.color !== undefined ? { ...stair, color: ov.color } : stair;
    addStairSymbol(primitives, project, effStair, greyed, lwMm, cutHeight);
  }

  // Stützen (Tragwerk) dieses Geschosses: Querschnitt-Poché (Rechteck/Kreis),
  // um `rotation` gedreht, auf Kategorie „50". Über der Wand-Poché gezeichnet.
  const columns = columnsOfFloor(project, floorId).filter(
    (col) =>
      visibleCodes.has(col.categoryCode) && categoryDisplay(col.categoryCode).render,
  );
  for (const column of columns) {
    const greyed = categoryDisplay(column.categoryCode).greyed;
    const category = catByCode.get(column.categoryCode);
    const ov = overrideFor(column.categoryCode, columnLabel(column));
    const lwMm =
      ov.lineweight ??
      resolveStrokeWeight(
        column.strokeWeight,
        column.strokeWeightSource,
        category,
        lwByCode.get(column.categoryCode) ?? WALL_FALLBACK_MM,
      );
    const effCol = ov.color !== undefined ? { ...column, color: ov.color } : column;
    addColumnPoche(primitives, project, effCol, greyed, lwMm, category);
  }

  // 2D-Zeichengeometrie zuletzt (über der Poché).
  const compact = compactUnderlay && !mono && !forPrint;
  // Kompakte Unterlage PRO KATEGORIE gruppiert: das Ein-/Ausblenden einer Ebene
  // entfernt dann nur deren Gruppe — die Chunks aller anderen Ebenen bleiben
  // identisch und werden wiederverwendet (statt dass fast jeder Chunk eine der
  // ausgeblendeten Zeichnungen enthielt und neu kompiliert werden musste).
  const underGroups = new Map<string, { ds: Drawing2D[]; greyed: boolean }>();
  for (const d of drawings) {
    const greyed = categoryDisplay(d.categoryCode).greyed;
    if (compact && isCompactUnderlayEligible(d)) {
      addDrawing2DWithoutLines(primitives, project, d, greyed, lwByCode, colorByCode, catByCode, scaleDenominator);
      const key = `${greyed ? 1 : 0}:${d.categoryCode}`;
      const grp = underGroups.get(key);
      if (grp) grp.ds.push(d);
      else underGroups.set(key, { ds: [d], greyed });
    } else {
      addDrawing2D(primitives, project, d, greyed, lwByCode, colorByCode, catByCode, scaleDenominator, !mono);
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

  // Extrudierte Körper (truck-Integration): das Quell-Profil wurde beim
  // Extrudieren aus `drawings2d` entfernt (s. `extrude.ts` appendExtrudedSolid)
  // — im Grundriss erscheint stattdessen der Footprint-Umriss des Körpers
  // selbst (Haarlinie, kein Poché/Schraffur; Farbe wie das 3D-Orange).
  for (const solid of project.extrudedSolids ?? []) {
    if (solid.levelId === floorId) addExtrudedSolidOutline(primitives, solid);
  }

  // Kontext-Konturen (Höhenlinien) als dezente Linien zeichnen — UNTER der
  // Wand-Poché wäre ideal, aber da sie eine eigene gedämpfte Farbe tragen, ist
  // die Reihenfolge unkritisch; wir hängen sie als Referenz an. Projektglobal
  // (nicht je Geschoss) → nur beim aktiven Aufruf einer Mehrfach-Überlagerung.
  if (includeGlobal) {
    addContextContours(primitives, project, visibleCodes, categoryDisplay);

    // Schnittführungs-Symbole (klassische Schnittlinien) aller Schnitt-/
    // Ansichtsebenen mit gesetzter Linie — ebenfalls projektglobal. Sichtbarkeit
    // läuft über die Kategorie "90" (Referenzen), wie jedes andere Bauteil.
    addSectionLines(primitives, project, visibleCodes, categoryDisplay);
  }

  // Schwarz-Weiss (mono): nachträglich alle Farben auf reine Tinte zwingen.
  // Element-/Kategorie-/Hatch-Farben werden ignoriert, Füllungen werden weiss,
  // Musterlinien/Striche schwarz — so entsteht ein reiner S/W-Plan.
  // Abzugskörper (Aussparungen/Durchbrüche): von Wand-/Stützen-/Decken-Poché abziehen.
  subtractVoidsInPlan(primitives, project, (floor?.baseElevation ?? 0) + (floor?.cutHeight ?? 1.0));

  if (mono) toMono(primitives);

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

  return {
    primitives,
    bounds: computeBounds(project, walls, drawings, ceilings, stairs, rooms, roofs, primitives.slice(0, shadowCount)),
    backgroundImages,
    ...(underlay.length ? { underlay } : {}),
  };
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

  const primitives: Primitive[] = [];
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
    // KEIN `primitives.push(...p.primitives)`: bei grossen Importen (z. B. ein
    // Kataster-DXF einer ganzen Stadt, hunderttausende Drawing2D-Elemente →
    // ebenso viele Primitives) sprengt der Spread-Operator die Argumentzahl-
    // Grenze von `push` (RangeError "Maximum call stack size exceeded") — s.
    // dieselbe, bereits dokumentierte Falle in `swissBuildings3d.ts::concatMeshes`/
    // `dwgParser.ts`. Reine `for`-Schleife ist unbegrenzt sicher.
    const from = primitives.length;
    for (const pr of p.primitives) primitives.push(pr);
    if (d.greyed && primitives.length > from) greyedRanges.push([from, primitives.length]);
    // Leere Ebenen melden als Platzhalter (0,0)–(1,1) — NICHT mitzählen: sonst zog
    // jede leere Nachbar-Ebene den Ausschnitt bis zum Ursprung (bei Landes-
    // koordinaten ~2,7 Mio. m daneben → "Einpassen" zeigte nichts).
    if (p.primitives.length > 0 || p.underlay) extend(p.bounds);
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
  for (const pr of activePlan.primitives) primitives.push(pr);
  for (const g of activePlan.underlay ?? []) underlay.push(g);
  // Aktive Ebene leer UND keine Nachbar-Ebene mit Inhalt → Platzhalter-Ausmass.
  if (activePlan.primitives.length > 0 || activePlan.underlay || bounds.minX === Infinity) extend(activePlan.bounds);

  return {
    primitives,
    bounds,
    backgroundImages: activePlan.backgroundImages,
    ...(greyedRanges.length ? { greyedRanges } : {}),
    ...(underlay.length ? { underlay } : {}),
  };
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

function computeBounds(
  project: Project,
  walls: Wall[],
  drawings: Drawing2D[] = [],
  ceilings: Ceiling[] = [],
  stairs: Stair[] = [],
  rooms: Room[] = [],
  roofs: Roof[] = [],
  /** Zusätzlich einzurahmende Flächen (Schattenstudie), damit Druck/Einpassen den ganzen Schatten zeigen. */
  extra: Primitive[] = [],
) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (p: Vec2) => {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  };
  for (const w of walls) {
    const t = wallTypeThickness(getWallType(project, w));
    for (const c of wallCorners(w.start, w.end, t)) acc(c);
  }
  for (const c of ceilings) for (const p of c.outline) acc(p);
  for (const r of rooms) for (const p of r.boundary) acc(p);
  for (const e of extra) if (e.kind === "polygon") e.pts.forEach(acc);
  // Traufe (inkl. Überstand) statt reinem Umriss, damit ein weit auskragendes
  // Dach das „Einpassen" korrekt mit einrahmt.
  for (const roof of roofs) for (const p of roofGeometry(roof, 0).eaves) acc(p);
  for (const s of stairs) {
    const { zBottom, zTop } = stairVerticalExtent(project, s);
    const geo = stairGeometry(s, zTop - zBottom);
    for (const tr of geo.treads) for (const p of tr.pts) acc(p);
    if (geo.landing) for (const p of geo.landing) acc(p);
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
