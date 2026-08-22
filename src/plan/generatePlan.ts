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
import { stairVerticalExtent } from "../model/wall";
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
import { addContextContours } from "./generatePlan/context";
import { addDrawing2D } from "./generatePlan/drawing2d";
import { addDoorSymbol, addOpeningSymbol } from "./generatePlan/openings";
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
}

export interface Plan {
  primitives: Primitive[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Hintergrund-Rasterbilder (Luftbild) — nur für die interaktive Ansicht. */
  backgroundImages?: PlanImage[];
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
): Plan {
  const primitives: Primitive[] = [];
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
        categoryDisplay(d.categoryCode).render,
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
    // Türen (Legacy) + Öffnungen (Fenster/Türen) am Wandhost: BEIDE sparen die
    // Wand-Poché aus. Aus beiden wird eine gemeinsame Lücken-Intervall-Liste.
    const doors = project.doors.filter((d) => d.hostWallId === wall.id);
    const openings = openingsOfWall(project, wall.id);
    const gaps = wallGaps(wall, doors, openings);
    const cuts = joins.get(wall.id) ?? { startCut: null, endCut: null };
    // Schnitt vs. Ansicht nach Schnitthöhe (BIM-Standard): erreicht die Wand die
    // Grundriss-Schnittebene nicht (Höhe < Schnitthöhe des Geschosses, z. B. eine
    // Brüstung/ein Podestrand), wird sie nur als Ansichts-Umriss gezeichnet —
    // keine Schnitt-Poché. Normale Wände (Höhe ≥ Schnitthöhe) sind unberührt.
    const wallViewOnly = wall.height < (floor?.cutHeight ?? 1.0);
    addWallPoche(
      primitives, project, wall, gaps, cuts, wallGreyed, detail, wallLwMm, wallCategory, wallViewOnly,
    );
    // Referenzlinie: dünne gestrichelte Wand-Achslinie (von der Oberleiste
    // umschaltbar). Wird über der Poché gezeichnet, damit sie sichtbar bleibt.
    if (showReferenceLines) addReferenceLine(primitives, wall, wallGreyed);
    // Tür-Symbol (Legacy-Door) nur, wenn die Kategorie sichtbar ist und der Modus
    // sie zeigt.
    for (const door of doors) {
      const d = categoryDisplay(door.categoryCode);
      if (visibleCodes.has(door.categoryCode) && d.render) {
        const doorLwMm = lwByCode.get(door.categoryCode) ?? LAYER_LINE_MM;
        addDoorSymbol(primitives, wall, door, d.greyed, detail, doorLwMm);
      }
    }
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
        addOpeningSymbol(primitives, project, wall, effO, d.greyed, detail, oLwMm);
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
  for (const d of drawings) {
    const greyed = categoryDisplay(d.categoryCode).greyed;
    addDrawing2D(primitives, project, d, greyed, lwByCode, colorByCode, catByCode);
  }

  // Extrudierte Körper (truck-Integration): das Quell-Profil wurde beim
  // Extrudieren aus `drawings2d` entfernt (s. `extrude.ts` appendExtrudedSolid)
  // — im Grundriss erscheint stattdessen der Footprint-Umriss des Körpers
  // selbst (Haarlinie, kein Poché/Schraffur; Farbe wie das 3D-Orange).
  for (const solid of project.extrudedSolids ?? []) {
    if (solid.levelId === floorId) addExtrudedSolidOutline(primitives, solid);
  }

  // Kontext-Konturen (Höhenlinien) als dezente Linien zeichnen — UNTER der
  // Wand-Poché wäre ideal, aber da sie eine eigene gedämpfte Farbe tragen, ist
  // die Reihenfolge unkritisch; wir hängen sie als Referenz an.
  addContextContours(primitives, project);

  // Schnittführungs-Symbole (klassische Schnittlinien) aller Schnitt-/Ansichts-
  // ebenen mit gesetzter Linie — projektglobale Referenzgeometrie über dem Plan.
  addSectionLines(primitives, project);

  // Schwarz-Weiss (mono): nachträglich alle Farben auf reine Tinte zwingen.
  // Element-/Kategorie-/Hatch-Farben werden ignoriert, Füllungen werden weiss,
  // Musterlinien/Striche schwarz — so entsteht ein reiner S/W-Plan.
  if (mono) toMono(primitives);

  // Georeferenzierte Luftbilder als Hintergrund-Ebenen (nur interaktive Ansicht,
  // nicht Teil der Vektor-Primitive) — im Mono-Modus ausgeblendet (reiner S/W-Plan).
  const backgroundImages: PlanImage[] = mono
    ? []
    : (project.context ?? [])
        .filter((o): o is Extract<ContextObject, { type: "image" }> => o.type === "image")
        .map((o) => ({ id: o.id, src: o.src, min: o.min, max: o.max, opacity: o.opacity ?? 1 }));

  return {
    primitives,
    bounds: computeBounds(project, walls, drawings, ceilings, stairs, rooms, roofs),
    backgroundImages,
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
 * aufrecht. Rein darstellend; kennt das Projekt nicht.
 */
export function generateSectionPlan(
  output: SectionOutput,
  mono = false,
  opts: { hiddenLines?: boolean } = {},
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
      ceilingId: kind === "slab" ? sourceId : undefined,
      roofId: kind === "roof" ? sourceId : undefined,
    });
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
    if (g.shape === "line") { acc(g.a); acc(g.b); }
    else if (g.shape === "polyline") g.pts.forEach(acc);
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
      acc(g.a);
      acc(g.b);
    } else if (g.shape === "kote") acc(g.at);
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
