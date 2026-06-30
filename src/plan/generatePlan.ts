// Grundriss-Generator: erzeugt aus dem semantischen Modell den
// 2D-Grundriss als abstrakte Vektor-Primitive (später → SVG).
//
// Kern-Erkenntnis: Der Grundriss entsteht NICHT durch Zerschneiden eines
// 3D-Meshes, sondern direkt aus den Parametern (Wandachsen, Schichtaufbau,
// Öffnungen) — exakt, schnell, sauber.

import type {
  Drawing2D,
  HatchPattern,
  LayerCategory,
  Project,
  Vec2,
  Wall,
} from "../model/types";
import {
  flattenCategories,
  getComponent,
  getHatch,
  getLineStyle,
  getWallType,
  wallTypeThickness,
} from "../model/types";
import { wallReferenceOffset } from "../model/wall";
import {
  add,
  along,
  clippedBand,
  leftNormal,
  normalize,
  scale,
  sub,
  wallCorners,
} from "../model/geometry";

/**
 * Detailgrad der Plan-Darstellung (Oberleiste „grob/mittel/fein"). Steuert hier
 * konkret zwei Dinge im Grundriss:
 *  • Tür-/Fenstersymbole: grob = nur Öffnungs-Lücke + gerade Türblatt-Linie;
 *    mittel = + Schwenkbogen; fein = + Rahmen/Anschlag-Striche.
 *  • Schraffuren + Linienfeinheit: grob = vereinfachte Poché (eine Sammelfläche
 *    ohne Schraffur, dickere Umrisslinie); mittel = aktueller mehrschichtiger
 *    Aufbau mit Schraffuren; fein = volle Schraffuren + dünnere Linien.
 *
 * NOCH OFFEN (folgt, sobald die Features existieren — hier bewusst KEIN
 * Schein-Effekt): Bemaßung/Beschriftung werden mit dem Detailgrad auf-/abblenden
 * (Maßketten, Raumstempel), und die 3D-Geometrie-Auflösung (z. B. Profil-
 * Rundungen, Tritt-/Setzstufen) wird ebenfalls dem Detailgrad folgen, sobald
 * Bemaßung bzw. eine feinere 3D-Tessellierung implementiert sind.
 */
export type DetailLevel = "grob" | "mittel" | "fein";
import { computeJoins } from "../model/joins";
import type { WallCuts } from "../model/joins";

/** Stroke-Farbe der Schicht-Polygone (dunkles Grau). */
const POCHE_STROKE = "#2b3039";

/** Tinte für den Schwarz-Weiss-Modus: einheitliches Dunkel für alle Striche. */
const MONO_INK = "#111111";

// ── Linienstärken in PAPIER-Millimeter (vgl. docs/design/plans-output.md §3.2) ──
// Alle Stricharten sind in mm Papier definiert; die PlanView rechnet sie über
// dpi = 96·devicePixelRatio in konstante Bildschirm-Pixel um (non-scaling-stroke),
// damit Linien beim Zoomen ihre Papiergröße behalten und der Massstab stimmt.

/** Dünne Trennlinie zwischen den Schichten (Schichtfugen) in mm. */
const LAYER_LINE_MM = 0.13;
/** Stärke der Wand-Umrisslinie je Detailgrad, als Faktor auf die Ebenen-lw. */
const OUTLINE_DETAIL_FACTOR: Record<DetailLevel, number> = {
  grob: 1.6, // dickere Sammellinie
  mittel: 1.0, // wie die Kategorie-Strichstärke
  fein: 0.6, // feiner
};
/** Stärke der Schichtfugen je Detailgrad (mittel/fein; grob hat keine Fugen). */
const LAYER_DETAIL_FACTOR: Record<DetailLevel, number> = {
  grob: 1.0,
  mittel: 1.0,
  fein: 0.7,
};
/** Default-Umrandungs-Strichstärke (mm), falls die Kategorie keine lw trägt
   (Grundeinstellung für „normale Elemente"). */
const WALL_FALLBACK_MM = 0.18;

/**
 * Aufgelöste Schraffur eines Polygons — alle Werte stammen aus einer
 * HatchStyle-Ressource (Muster/Maßstab/Winkel/Farbe) plus dem optional
 * verknüpften LineStyle (Linienstärke/Strichmuster der Musterlinien). Die
 * PlanView ist damit rein darstellend und kennt das Projekt nicht.
 */
export interface HatchRender {
  pattern: HatchPattern;
  scale: number;
  angle: number;
  /** Farbe der Musterlinien bzw. der Vollfüllung (pattern==="solid"). */
  color: string;
  /** Linienstärke der Musterlinien in mm. */
  lineWeight: number;
  /** Strichmuster der Musterlinien in mm; null = durchgezogen. */
  dash: number[] | null;
}

/**
 * Render-Entscheidung je Kategorie-Code für den Grundriss (vgl. ItemDisplay aus
 * dem Panel-Darstellungsmodus). `render`=false blendet die Kategorie ganz aus,
 * `greyed`=true zeichnet sie gedimmt. Wird kein Resolver übergeben, gilt für
 * jede sichtbare Kategorie {render:true, greyed:false} (bisheriges Verhalten).
 */
export interface CategoryDisplay {
  render: boolean;
  greyed: boolean;
}

/** Funktion, die je Kategorie-Code die Render-Entscheidung liefert. */
export type CategoryDisplayResolver = (code: string) => CategoryDisplay;

/** Standard-Resolver: jede (bereits gefilterte) Kategorie normal zeichnen. */
const SHOW_ALL: CategoryDisplayResolver = () => ({ render: true, greyed: false });

export type Primitive =
  | {
      kind: "polygon";
      pts: Vec2[];
      /** Füllfarbe (Component-Poché) bzw. "none" für reine Umrisslinien. */
      fill: string;
      stroke: string;
      /** Umriss-Strichstärke in PAPIER-Millimeter (siehe oben). */
      strokeWidthMm: number;
      hatch: HatchRender;
      /** Gedimmt zeichnen (Darstellungsmodus „andere grau"). */
      greyed?: boolean;
      /**
       * ID der Wand, zu der dieses Schicht-/Umriss-Polygon gehört (für die
       * Links-Klick-Auswahl: die PlanView markiert ALLE Polygone derselben
       * Wand und meldet die wallId nach oben). Reine Umriss-/Symbol-Primitive
       * ohne Wandbezug lassen das Feld weg.
       */
      wallId?: string;
      /**
       * ID des 2D-Zeichenelements (Drawing2D), falls dieses gefüllte Polygon eine
       * geschlossene 2D-Form ist (für die Links-Klick-Auswahl der Fläche).
       */
      drawingId?: string;
    }
  | {
      kind: "line";
      a: Vec2;
      b: Vec2;
      cls: string;
      /** Strichstärke in mm Papier (non-scaling). */
      weightMm: number;
      /** Strichmuster in mm Papier; null/undefined = durchgezogen. */
      dash?: number[] | null;
      /** Optionale explizite Strichfarbe (überschreibt die CSS-Klasse). */
      color?: string;
      /** ID des 2D-Zeichenelements (für Links-Klick-Auswahl von Drawing2D). */
      drawingId?: string;
      greyed?: boolean;
    }
  | {
      kind: "arc";
      center: Vec2;
      from: Vec2;
      to: Vec2;
      r: number;
      cls: string;
      /** Strichstärke in mm Papier (non-scaling). */
      weightMm: number;
      /** Strichmuster in mm Papier; null/undefined = durchgezogen. */
      dash?: number[] | null;
      greyed?: boolean;
    };

/**
 * Löst eine HatchStyle-Ressource (per id) zu einer darstellungsfertigen
 * {@link HatchRender} auf. Der Linienstil der Musterlinien wird, falls gesetzt,
 * aus dem Line Manager nachgeschlagen; sonst gilt ein dünner Default.
 */
function resolveHatch(project: Project, hatchId: string): HatchRender {
  const h = getHatch(project, hatchId);
  const ls = h.lineStyleId ? getLineStyle(project, h.lineStyleId) : null;
  return {
    pattern: h.pattern,
    scale: h.scale,
    angle: h.angle,
    color: h.color,
    lineWeight: ls?.weight ?? 0.13,
    dash: ls?.dash ?? null,
  };
}

export interface Plan {
  primitives: Primitive[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
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
  // Sichtbarkeit wie bisher; der Darstellungsmodus verfeinert sie zusätzlich:
  // render=false blendet die Wand aus, greyed=true dimmt sie.
  const walls = project.walls.filter(
    (w) =>
      w.floorId === floorId &&
      visibleCodes.has(w.categoryCode) &&
      categoryDisplay(w.categoryCode).render,
  );

  // Code → Kategorie-Strichstärke (mm), damit die Wand-Umrisslinie aus dem
  // Modell (Ebene) stammt statt aus einer Magie-Konstante.
  const lwByCode = categoryLwMap(project.layers);
  const colorByCode = categoryColorMap(project.layers);

  // Freie 2D-Zeichengeometrie dieses Geschosses (wie Wände nach sichtbaren
  // Kategorien + Darstellungsmodus gefiltert). Wird über der Wand-Poché
  // gezeichnet (am Ende angehängt).
  const drawings = project.drawings2d.filter(
    (d) =>
      d.levelId === floorId &&
      visibleCodes.has(d.categoryCode) &&
      categoryDisplay(d.categoryCode).render,
  );

  // Gehrungs-Schnittlinien einmal pro Plan berechnen (auf der gefilterten Menge).
  const joins = computeJoins(project, walls);

  for (const wall of walls) {
    const wallGreyed = categoryDisplay(wall.categoryCode).greyed;
    const wallLwMm = lwByCode.get(wall.categoryCode) ?? WALL_FALLBACK_MM;
    // Türen am Wandhost: die Öffnung bestimmt immer die Wandgeometrie.
    const doors = project.doors.filter((d) => d.hostWallId === wall.id);
    const cuts = joins.get(wall.id) ?? { startCut: null, endCut: null };
    addWallPoche(primitives, project, wall, doors, cuts, wallGreyed, detail, wallLwMm);
    // Referenzlinie: dünne gestrichelte Wand-Achslinie (von der Oberleiste
    // umschaltbar). Wird über der Poché gezeichnet, damit sie sichtbar bleibt.
    if (showReferenceLines) addReferenceLine(primitives, wall, wallGreyed);
    // Tür-Symbol nur, wenn die Tür-Kategorie sichtbar ist und der Modus sie zeigt.
    for (const door of doors) {
      const d = categoryDisplay(door.categoryCode);
      if (visibleCodes.has(door.categoryCode) && d.render) {
        const doorLwMm = lwByCode.get(door.categoryCode) ?? LAYER_LINE_MM;
        addDoorSymbol(primitives, wall, door, d.greyed, detail, doorLwMm);
      }
    }
  }

  // 2D-Zeichengeometrie zuletzt (über der Poché).
  for (const d of drawings) {
    const greyed = categoryDisplay(d.categoryCode).greyed;
    addDrawing2D(primitives, project, d, greyed, lwByCode, colorByCode);
  }

  // Kontext-Konturen (Höhenlinien) als dezente Linien zeichnen — UNTER der
  // Wand-Poché wäre ideal, aber da sie eine eigene gedämpfte Farbe tragen, ist
  // die Reihenfolge unkritisch; wir hängen sie als Referenz an.
  addContextContours(primitives, project);

  // Schwarz-Weiss (mono): nachträglich alle Farben auf reine Tinte zwingen.
  // Element-/Kategorie-/Hatch-Farben werden ignoriert, Füllungen werden weiss,
  // Musterlinien/Striche schwarz — so entsteht ein reiner S/W-Plan.
  if (mono) toMono(primitives);

  return { primitives, bounds: computeBounds(project, walls, drawings) };
}

/** Dezente Plan-Farbe der Kontext-Konturen (gedämpftes Grau). */
const CONTEXT_LINE_COLOR = "#9aa3ad";
/** Strichstärke der Kontext-Konturen (mm Papier, dünn). */
const CONTEXT_LINE_MM = 0.1;

/**
 * Zeichnet die Konturen (Höhenlinien) der Kontext-Schicht `project.context` als
 * dünne, gedämpfte Referenz-Linien in den Grundriss. Die Z-Höhe wird ignoriert
 * (reine 2D-Projektion). TerrainMeshes/ImportedMeshes erscheinen im Plan NICHT
 * (3D genügt). Rein additiv — Wand-/Drawing-Darstellung bleibt unberührt.
 */
function addContextContours(out: Primitive[], project: Project): void {
  const context = project.context ?? [];
  for (const obj of context) {
    if (obj.type !== "contourSet") continue;
    for (const c of obj.contours) {
      const pts = c.pts;
      if (pts.length < 2) continue;
      const segEnd = c.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < segEnd; i++) {
        out.push({
          kind: "line",
          a: pts[i],
          b: pts[(i + 1) % pts.length],
          cls: "context-line",
          weightMm: CONTEXT_LINE_MM,
          color: CONTEXT_LINE_COLOR,
        });
      }
    }
  }
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
      // Vollfüllung „solid" deckte die Poché farbig — in mono auf Weiss setzen,
      // damit nur der Umriss trägt. Linien-/Kreuzschraffur bleibt, aber in Tinte.
      if (p.hatch.pattern === "solid") {
        p.hatch = { ...p.hatch, color: "#ffffff" };
      } else if (p.hatch.pattern !== "none") {
        p.hatch = { ...p.hatch, color: MONO_INK };
      }
      p.fill = p.fill === "none" ? "none" : "#ffffff";
      p.stroke = MONO_INK;
    } else if (p.kind === "line") {
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
 * Leitet ein 2D-Zeichenelement in Plan-Primitive ab (docs/design/drawing-tools.md
 * §7.2). Farbe/Strichstärke kommen aus dem optionalen LineStyle, sonst aus der
 * Kategorie. Phase 1 deckt line/polyline/rect ab (alles → line-Primitive);
 * circle/arc/text folgen mit den Primitive-Erweiterungen (Phase 3).
 */
function addDrawing2D(
  out: Primitive[],
  project: Project,
  d: Drawing2D,
  greyed: boolean,
  lwByCode: Map<string, number>,
  colorByCode: Map<string, string>,
): void {
  const ls = d.lineStyleId
    ? project.lineStyles.find((l) => l.id === d.lineStyleId)
    : undefined;
  // Plan-Tinte fix dunkel: Fallback auf MONO_INK (statt hell „#d0d0d0"), damit
  // ein kategorieloses 2D-Element auf dem hellen Papier sichtbar bleibt.
  const color = d.color ?? ls?.color ?? colorByCode.get(d.categoryCode) ?? MONO_INK;
  const weightMm = d.weightMm ?? ls?.weight ?? lwByCode.get(d.categoryCode) ?? WALL_FALLBACK_MM;
  const dash = ls?.dash ?? null;
  const seg = (a: Vec2, b: Vec2) =>
    out.push({ kind: "line", a, b, cls: "draw2d", weightMm, dash, color, greyed, drawingId: d.id });

  /**
   * Gefüllte Fläche einer GESCHLOSSENEN Form: trägt die Vollton-Füllfarbe
   * (`d.fillColor`, sonst transparent) UND die optionale Füllschraffur
   * (`d.hatchId`, sonst NO_HATCH). Wird VOR den Strichen gepusht, damit die
   * Umrisslinien oben liegen. Trägt `drawingId`, sodass ein Klick auf die Fläche
   * das Element selektiert (analog zu den Linien).
   */
  const fillPoly = (pts: Vec2[]) =>
    out.push({
      kind: "polygon",
      pts,
      fill: d.fillColor ?? "none",
      // Umriss zeichnen die separaten Linien-Primitive (mit Strichmuster); die
      // Füllfläche selbst bleibt randlos, um doppelte Striche zu vermeiden.
      stroke: "none",
      strokeWidthMm: 0,
      hatch: d.hatchId ? resolveHatch(project, d.hatchId) : NO_HATCH,
      greyed,
      drawingId: d.id,
    });

  const g = d.geom;
  switch (g.shape) {
    case "line":
      seg(g.a, g.b);
      break;
    case "polyline": {
      // Geschlossene Polylinie: zuerst die gefüllte Fläche (Vollton/Schraffur).
      if (g.closed && g.pts.length > 2) fillPoly(g.pts);
      for (let i = 0; i < g.pts.length - 1; i++) seg(g.pts[i], g.pts[i + 1]);
      if (g.closed && g.pts.length > 2) seg(g.pts[g.pts.length - 1], g.pts[0]);
      break;
    }
    case "rect": {
      const c1 = g.min;
      const c2 = { x: g.max.x, y: g.min.y };
      const c3 = g.max;
      const c4 = { x: g.min.x, y: g.max.y };
      // Rechteck ist immer geschlossen → zuerst die gefüllte Fläche.
      fillPoly([c1, c2, c3, c4]);
      seg(c1, c2);
      seg(c2, c3);
      seg(c3, c4);
      seg(c4, c1);
      break;
    }
    case "circle": {
      // Kreis als geschlossene Polygon-Approximation (N Segmente) — nutzt die
      // vorhandene Füll-/Strich-Pipeline, ohne ein eigenes Kreis-Primitiv.
      const N = 64;
      const pts: Vec2[] = [];
      for (let i = 0; i < N; i++) {
        const t = (i / N) * Math.PI * 2;
        pts.push({ x: g.center.x + g.r * Math.cos(t), y: g.center.y + g.r * Math.sin(t) });
      }
      fillPoly(pts);
      for (let i = 0; i < N; i++) seg(pts[i], pts[(i + 1) % N]);
      break;
    }
    // arc/text: Primitive-Erweiterungen folgen später.
    default:
      break;
  }
}

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
function addWallPoche(
  out: Primitive[],
  project: Project,
  wall: Wall,
  doors: Project["doors"],
  cuts: WallCuts,
  greyed: boolean,
  detail: DetailLevel,
  wallLwMm: number,
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
  // Strich-/Umrandungsfarbe der Wand: optionale Übersteuerung (wall.color),
  // sonst der Default-Poché-Strich. Betrifft NUR die Linienfarbe (Umriss +
  // Schichtfugen), nicht die Schicht-Füllfarben/Schraffuren.
  const stroke = wall.color ?? POCHE_STROKE;

  // Öffnungs-Intervalle entlang der Wandachse, sortiert.
  const openings = doors
    .map((d) => ({ from: d.position, to: d.position + d.width }))
    .sort((a, b) => a.from - b.from);

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
  // Vereinfachte Füllung (grob): Farbe des tragenden Bauteils (höchste Priorität).
  const simpleFill = backboneColor(project, wt);

  for (const [s, e] of segments) {
    const p1 = along(wall.start, wall.end, s);
    const p2 = along(wall.start, wall.end, e);
    // Nur die echten Wandenden bekommen die Gehrung. Türnahe Segmentenden
    // bleiben rechtwinklig (kein Schnitt).
    const startCut = s <= 1e-6 ? cuts.startCut : null;
    const endCut = e >= axisLen - 1e-6 ? cuts.endCut : null;

    if (detail === "grob") {
      // Eine Sammelfläche über die volle Dicke, ohne Schraffur, dicker Umriss.
      out.push({
        kind: "polygon",
        pts: clippedBand(p1, p2, refOff - total / 2, refOff + total / 2, startCut, endCut),
        fill: simpleFill,
        stroke,
        strokeWidthMm: outlineMm,
        hatch: NO_HATCH,
        greyed,
        wallId,
      });
      continue;
    }

    // mittel/fein: Schichten von außen (-T/2) nach innen (+T/2) stapeln. Jede
    // Schicht löst Bauteil (Füllfarbe) + Schraffur (Muster/Maßstab/Winkel/Farbe)
    // auf; die Schichtfugen werden dünn gestrichen.
    let off = refOff - total / 2;
    for (const layer of wt.layers) {
      const comp = getComponent(project, layer.componentId);
      out.push({
        kind: "polygon",
        pts: clippedBand(p1, p2, off, off + layer.thickness, startCut, endCut),
        fill: comp.color,
        stroke,
        strokeWidthMm: layerLineMm,
        hatch: resolveHatch(project, comp.hatchId),
        greyed,
        wallId,
      });
      off += layer.thickness;
    }
    // Kräftige Wand-Umrisslinie über die volle Dicke (nur Kontur, keine Füllung),
    // damit die Wand sich klar von den dünnen Schichtfugen abhebt.
    out.push({
      kind: "polygon",
      pts: clippedBand(p1, p2, refOff - total / 2, refOff + total / 2, startCut, endCut),
      fill: "none",
      stroke,
      strokeWidthMm: outlineMm,
      hatch: NO_HATCH,
      greyed,
      wallId,
    });
  }
}

/** Farbe des tragenden Bauteils (höchste joinPriority) für die grobe Poché. */
function backboneColor(project: Project, wt: Project["wallTypes"][number]): string {
  let best: { color: string; prio: number } | null = null;
  for (const layer of wt.layers) {
    const comp = getComponent(project, layer.componentId);
    if (!best || comp.joinPriority > best.prio)
      best = { color: comp.color, prio: comp.joinPriority };
  }
  return best?.color ?? "#9aa0a6";
}

/**
 * Tür-Symbol je Detailgrad:
 *  • grob   — nur die gerade Türblatt-Linie (die Öffnungs-Lücke kommt aus der
 *             ausgesparten Poché).
 *  • mittel — + Schwenkbogen (geschlossen → offen).
 *  • fein   — + Rahmen/Anschlag-Striche an beiden Pfosten (kurze Striche quer
 *             zur Wand, die den Türrahmen/-anschlag andeuten).
 */
function addDoorSymbol(
  out: Primitive[],
  wall: Wall,
  door: Project["doors"][number],
  greyed: boolean,
  detail: DetailLevel,
  doorLwMm: number,
): void {
  const u = normalize(sub(wall.end, wall.start));
  const n = leftNormal(u); // linke Seite der Wandachse
  const swingDir = door.swing === "left" ? n : scale(n, -1);

  const jambStart = along(wall.start, wall.end, door.position);
  const jambEnd = along(wall.start, wall.end, door.position + door.width);
  const hinge = door.hinge === "start" ? jambStart : jambEnd;
  const closedDir = door.hinge === "start" ? u : scale(u, -1);

  const openEnd = add(hinge, scale(swingDir, door.width));
  const closedEnd = add(hinge, scale(closedDir, door.width));

  // Türblatt in geöffneter Stellung (alle Stufen).
  out.push({
    kind: "line",
    a: hinge,
    b: openEnd,
    cls: "door-leaf",
    weightMm: doorLwMm,
    greyed,
  });

  // mittel + fein: Schwenkbogen von geschlossen → offen.
  if (detail !== "grob") {
    out.push({
      kind: "arc",
      center: hinge,
      from: closedEnd,
      to: openEnd,
      r: door.width,
      cls: "door-swing",
      weightMm: doorLwMm * 0.6,
      dash: [0.06, 0.04], // gestrichelt in mm Papier
      greyed,
    });
  }

  // fein: Rahmen/Anschlag-Striche an beiden Pfosten (kurz quer zur Wand,
  // symmetrisch um die Achse über eine halbe Wanddicke-Andeutung).
  if (detail === "fein") {
    const reveal = 0.06; // 6 cm Anschlag-Andeutung je Seite
    for (const jamb of [jambStart, jambEnd]) {
      out.push({
        kind: "line",
        a: add(jamb, scale(n, reveal)),
        b: add(jamb, scale(n, -reveal)),
        cls: "door-frame",
        weightMm: doorLwMm,
        greyed,
      });
    }
  }
}

/** Schraffur-Platzhalter „ohne" (für reine Umriss-/Sammelflächen). */
const NO_HATCH: HatchRender = {
  pattern: "none",
  scale: 1,
  angle: 0,
  color: POCHE_STROKE,
  lineWeight: LAYER_LINE_MM,
  dash: null,
};

/**
 * Referenzlinie einer Wand: dünne, gestrichelte Achslinie entlang der Wandachse
 * (start → end). Von der Oberleiste umschaltbar; rein darstellend.
 */
function addReferenceLine(out: Primitive[], wall: Wall, greyed: boolean): void {
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

const length = (w: Wall): number => Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);

function computeBounds(project: Project, walls: Wall[], drawings: Drawing2D[] = []) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (p: Vec2) => {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  };
  for (const w of walls) {
    const t = wallTypeThickness(getWallType(project, w));
    for (const c of wallCorners(w.start, w.end, t)) acc(c);
  }
  for (const d of drawings) {
    const g = d.geom;
    if (g.shape === "line") { acc(g.a); acc(g.b); }
    else if (g.shape === "polyline") g.pts.forEach(acc);
    else if (g.shape === "rect") { acc(g.min); acc(g.max); }
    else if (g.shape === "circle" || g.shape === "arc") {
      acc({ x: g.center.x - g.r, y: g.center.y - g.r });
      acc({ x: g.center.x + g.r, y: g.center.y + g.r });
    } else if (g.shape === "text") acc(g.at);
  }
  // Kontext-Konturen mit einrahmen, damit „Einpassen" sie ebenfalls zeigt.
  for (const obj of project.context ?? []) {
    if (obj.type !== "contourSet") continue;
    for (const c of obj.contours) for (const p of c.pts) acc(p);
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}
