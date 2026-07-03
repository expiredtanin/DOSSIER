// Grundriss-Generator: erzeugt aus dem semantischen Modell den
// 2D-Grundriss als abstrakte Vektor-Primitive (später → SVG).
//
// Kern-Erkenntnis: Der Grundriss entsteht NICHT durch Zerschneiden eines
// 3D-Meshes, sondern direkt aus den Parametern (Wandachsen, Schichtaufbau,
// Öffnungen) — exakt, schnell, sauber.

import type {
  Ceiling,
  Component,
  Drawing2D,
  HatchPattern,
  LayerCategory,
  Opening,
  Project,
  Room,
  Stair,
  Vec2,
  Wall,
} from "../model/types";
import {
  flattenCategories,
  getCeilingType,
  getComponent,
  getHatch,
  getLineStyle,
  getWallType,
  openingsOfWall,
  roomsOfFloor,
  stairsOfFloor,
  wallTypeThickness,
} from "../model/types";
import { evaluateRoom, siaLabel } from "../geometry/roomArea";
import type { RichTextDoc } from "../text/richText";
import { docFromText } from "../text/richText";
import { roomStampToDoc, roomStampExtraLines } from "../model/roomStamp";
import type { RoomStampLine } from "../model/roomStamp";
import { stairVerticalExtent, wallReferenceOffset } from "../model/wall";
import { stairGeometry, stairCut } from "../geometry/stair";
import { doorSymbol, openingInterval, windowSymbol } from "../geometry/opening";
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
import type { Line } from "../model/geometry";

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
import type { SectionOutput } from "./toSection";

/** Stroke-Farbe der Schicht-Polygone (neutrales Schwarz, geteilte Tinte mit der Schraffur). */
const POCHE_STROKE = "#1a1a1a";

/** Tinte für den Schwarz-Weiss-Modus: einheitliches Dunkel für alle Striche. */
const MONO_INK = "#111111";

// ── Linienstärken in PAPIER-Millimeter (vgl. docs/design/plans-output.md §3.2) ──
// Alle Stricharten sind in mm Papier definiert; die PlanView rechnet sie über
// dpi = 96·devicePixelRatio in konstante Bildschirm-Pixel um (non-scaling-stroke),
// damit Linien beim Zoomen ihre Papiergröße behalten und der Massstab stimmt.

/** Default-Schichtfuge zwischen den Materialschichten in mm — Haarlinie (0.02),
 *  gleiche Stärke wie die Schraffur-Tinte. Pro Fuge im Wandstil überschreibbar
 *  (z. B. 0.13, wenn zwei massive Materialien aufeinandertreffen). */
const LAYER_LINE_MM = 0.02;
/** Haarlinie für Tür-/Fenstersymbole (Flügel, Bogen, Rahmen, Glas) in mm. */
const SYMBOL_HAIRLINE_MM = 0.02;
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
       * Kanten-Indizes, die NICHT umrissen (gestrichen) werden dürfen — die Füllung
       * bleibt das volle Polygon. Kante `i` läuft von `pts[i]` nach `pts[(i+1)%n]`.
       * Damit werden die inneren Gehrungs-/Stoß-Stirnflächen an einer Wandecke
       * unterdrückt: die Diagonale, an der GLEICHFARBIGE Schichten zweier Wände
       * aneinanderstoßen, würde sonst als sichtbare 45°-Naht erscheinen und der
       * Umriss würde als Barbe über den Eck-Apex hinausschießen (Gehrungs-Spitze).
       * Längskanten (Schichtfugen zwischen VERSCHIEDENEN Materialien) bleiben
       * gestrichen — nur die Stoß-Stirnkanten am Knoten entfallen.
       */
      noStrokeEdges?: number[];
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
      /**
       * ID der Decke (Ceiling), falls dieses Polygon eine Decken-Fläche/-Umriss
       * ist (für die Links-Klick-Auswahl der Decke).
       */
      ceilingId?: string;
      /** ID der Öffnung (Fenster/Tür), z. B. der Fensterrahmen (Auswahl). */
      openingId?: string;
      /** ID der Treppe (Stair), falls dieses Polygon ein Tritt/Podest ist (Auswahl). */
      stairId?: string;
      /** ID des Raums (Room), falls dieses Polygon eine Raum-Fläche ist (Auswahl). */
      roomId?: string;
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
      /** ID der Öffnung (für Links-Klick-Auswahl von Fenster/Tür-Symbolen). */
      openingId?: string;
      /** ID der Treppe (für Links-Klick-Auswahl von Treppen-Symbollinien). */
      stairId?: string;
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
      /** ID der Öffnung (für Links-Klick-Auswahl von Tür-Schwenkbögen). */
      openingId?: string;
      greyed?: boolean;
    }
  | {
      kind: "text";
      /** Ankerpunkt im Modell (Meter). */
      at: Vec2;
      /**
       * Frei editierbarer Stempel-Text (Rich-Text). Wird zuerst gezeichnet;
       * `align` je Absatz steuert die Ausrichtung.
       */
      doc: RichTextDoc;
      /**
       * LIVE-Zusatzzeilen (z. B. Fläche „24.30 m²" + SIA-Tag), UNTER dem Doc
       * gezeichnet — unabhängig vom editierten Text, stets aktuell. Jede Zeile
       * trägt ihre eigene Ausrichtung (`align`).
       */
      extraLines: RoomStampLine[];
      /** Basis-Schriftgrösse in PUNKT (für Runs ohne eigene Grösse + Zusatzzeilen). */
      basePt: number;
      /** Textfarbe (hex) als Default. */
      color: string;
      /** ID des Raums (Room), zu dem dieser Stempel gehört (Auswahl). */
      roomId?: string;
      greyed?: boolean;
    };

/**
 * Löst eine HatchStyle-Ressource (per id) zu einer darstellungsfertigen
 * {@link HatchRender} auf. Der Linienstil der Musterlinien wird, falls gesetzt,
 * aus dem Line Manager nachgeschlagen; sonst gilt ein dünner Default.
 */
export function resolveHatch(project: Project, hatchId: string, wallAngleDeg?: number): HatchRender {
  const h = getHatch(project, hatchId);
  const ls = h.lineStyleId ? getLineStyle(project, h.lineStyleId) : null;
  // Wandbezogener Winkel: `HatchRender.angle` wird von allen Renderern in der
  // SVG-Konvention (im Uhrzeigersinn, Bildschirm-Y nach unten) verstanden — der
  // Modell-Renderer negiert ihn in `toModelAngleRad`. Die Wandachse `wallAngleDeg`
  // ist dagegen ein MODELL-Winkel (atan2 der Richtung, gegen den Uhrzeigersinn,
  // Y nach oben). Wegen der Y-Spiegelung entspricht die Wandrichtung am Bildschirm
  // dem Winkel −wallAngleDeg; das Muster folgt der Wand also, indem der
  // Wandwinkel SUBTRAHIERT wird. Ohne Wandkontext (Decke) bleibt `angle` absolut.
  const angle =
    h.relativeToWall && wallAngleDeg != null ? h.angle - wallAngleDeg : h.angle;
  return {
    pattern: h.pattern,
    scale: h.scale,
    angle,
    color: h.color,
    lineWeight: ls?.weight ?? 0.13,
    dash: ls?.dash ?? null,
  };
}

// ── SIA-Poché-Füllung ────────────────────────────────────────────────────
// Die 2D-Poché einer (auch mehrschichtigen) Wand trägt NICHT die rohe Bauteil-
// Albedo (3D-Materialfarbe), sondern einen neutralen Hintergrund, auf dem die
// Schraffur-Musterlinien liegen: Vollmuster ("solid") = reine SCHWARZE Poché
// (kein Linienmuster), jedes andere Muster (inkl. "none") = WEISSER Hintergrund.
const POCHE_FILL_WHITE = "#ffffff";
const POCHE_FILL_BLACK = "#000000";
/** Neutrale Poché-Füllfarbe für ein Muster: "solid" → schwarz, sonst weiß. */
function pocheFill(pattern: HatchPattern): string {
  return pattern === "solid" ? POCHE_FILL_BLACK : POCHE_FILL_WHITE;
}

/** Füllfarbe + Schraffur eines aufgelösten Bauteils, fertig für eine Cut-Poché. */
export interface SectionCutStyle {
  fill: string;
  hatch: HatchRender;
}

/**
 * Löst das tragende Bauteil (höchste `joinPriority`) einer Wand auf — dieselbe
 * Regel wie {@link backbonePocheFill} für die grobe Grundriss-Poché — und liefert
 * dessen Poché-Füllung + echte Schraffur für die Schnitt-Poché. `null`, wenn Wandtyp
 * oder Bauteil nicht auflösbar sind (z. B. verwaistes `wallTypeId`); der
 * Aufrufer fällt dann auf die generische Schnitt-Schraffur zurück.
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
    const wallAngleDeg =
      (Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x) * 180) / Math.PI;
    const hatch = resolveHatch(project, best.hatchId, wallAngleDeg);
    // Poché-Hintergrund neutral (weiß) statt Bauteil-Albedo; Vollmuster → schwarz.
    const solid = hatch.pattern === "solid";
    return {
      fill: solid ? POCHE_FILL_BLACK : POCHE_FILL_WHITE,
      hatch: solid ? { ...hatch, color: POCHE_FILL_BLACK } : hatch,
    };
  } catch {
    return null;
  }
}

/**
 * Löst das erste Bauteil des Deckentyps einer Decke auf — dieselbe Regel wie
 * {@link addCeilingPoche} für die normale Deckenpoché — und liefert dessen
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
    return { fill: comp.color, hatch: resolveHatch(project, comp.hatchId) };
  } catch {
    return null;
  }
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
  // Aktives Geschoss (für die Grundriss-Schnitthöhe der Treppen).
  const floor = project.drawingLevels.find((z) => z.id === floorId);
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

  // Decken dieses Geschosses (wie Wände nach sichtbaren Kategorien +
  // Darstellungsmodus gefiltert). Eine Decke liegt (als Slab) über der
  // Schnittebene → im Grundriss als gefüllter/schraffierter Umriss dargestellt,
  // UNTER der Wand-Poché (damit die Wände darüber lesbar bleiben).
  const ceilings = (project.ceilings ?? []).filter(
    (c) =>
      c.floorId === floorId &&
      visibleCodes.has(c.categoryCode) &&
      categoryDisplay(c.categoryCode).render,
  );
  for (const ceiling of ceilings) {
    const greyed = categoryDisplay(ceiling.categoryCode).greyed;
    const lwMm = lwByCode.get(ceiling.categoryCode) ?? WALL_FALLBACK_MM;
    addCeilingPoche(primitives, project, ceiling, greyed, detail, lwMm);
  }

  // Räume (SIA-416-Flächen) dieses Geschosses: transluzente Farbfüllung + Stempel
  // (Name + Fläche + SIA-Tag). UNTER der Wand-Poché gezeichnet, damit die Wände
  // lesbar bleiben. Der Stempel (Text) entfällt beim Detailgrad „grob".
  const rooms = roomsOfFloor(project, floorId).filter(
    (r) =>
      visibleCodes.has(r.categoryCode) && categoryDisplay(r.categoryCode).render,
  );
  for (const room of rooms) {
    const greyed = categoryDisplay(room.categoryCode).greyed;
    addRoomArea(primitives, room, greyed, detail);
  }

  // Gehrungs-Schnittlinien einmal pro Plan berechnen (auf der gefilterten Menge).
  const joins = computeJoins(project, walls);

  for (const wall of walls) {
    const wallGreyed = categoryDisplay(wall.categoryCode).greyed;
    const wallLwMm = lwByCode.get(wall.categoryCode) ?? WALL_FALLBACK_MM;
    // Türen (Legacy) + Öffnungen (Fenster/Türen) am Wandhost: BEIDE sparen die
    // Wand-Poché aus. Aus beiden wird eine gemeinsame Lücken-Intervall-Liste.
    const doors = project.doors.filter((d) => d.hostWallId === wall.id);
    const openings = openingsOfWall(project, wall.id);
    const gaps = wallGaps(wall, doors, openings);
    const cuts = joins.get(wall.id) ?? { startCut: null, endCut: null };
    addWallPoche(primitives, project, wall, gaps, cuts, wallGreyed, detail, wallLwMm);
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
        const oLwMm = lwByCode.get(o.categoryCode) ?? LAYER_LINE_MM;
        addOpeningSymbol(primitives, project, wall, o, d.greyed, detail, oLwMm);
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
    const lwMm = lwByCode.get(stair.categoryCode) ?? WALL_FALLBACK_MM;
    addStairSymbol(primitives, project, stair, greyed, lwMm, cutHeight);
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

  return {
    primitives,
    bounds: computeBounds(project, walls, drawings, ceilings, stairs, rooms),
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

/** Schnitt-Schraffur der Cut-Flächen (diagonale Poché wie ein Wandschnitt). */
const SECTION_HATCH: HatchRender = {
  pattern: "diagonal",
  scale: 1,
  angle: 45,
  color: SECTION_INK,
  lineWeight: 0.13,
  dash: null,
};

/** RGB (0..1) → 6-stelliges Hex, für die Cut-Poché-Füllfarbe. */
function rgbToHex(rgb: [number, number, number]): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

/**
 * Baut aus einem {@link SectionOutput} (render3d::section, (u, v)-Meter) den
 * Plan eines Schnitts/einer Ansicht. `u` wird zur Plan-X, `v` (absolute Höhe)
 * zur Plan-Y — die PlanView zeigt Y nach oben, also erscheint der Schnitt
 * aufrecht. Rein darstellend; kennt das Projekt nicht.
 */
export function generateSectionPlan(output: SectionOutput, mono = false): Plan {
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
  // diese Auflösung (Fallback), greift die generische Schnitt-Schraffur auf
  // Basis der rohen Albedo-Farbe aus dem 3D-Modell.
  for (const cp of output.cutPolygons) {
    if (cp.pts.length < 3) continue;
    const pts: Vec2[] = cp.pts.map(([u, v]) => {
      acc(u, v);
      return { x: u, y: v };
    });
    const fill = cp.fill ?? rgbToHex(cp.color);
    const hatch = cp.hatch ?? SECTION_HATCH;
    // Mono: neutrale Poché — Weiss statt Bauteilfarbe, Schraffur-Musterlinien →
    // Tinte. Eine schwarze SIA-Vollpoché ("solid") BLEIBT jedoch schwarz
    // (Schwarz bleibt Schwarz, Weiss bleibt Weiss).
    const solid = hatch.pattern === "solid";
    const monoFill = solid ? POCHE_FILL_BLACK : "#ffffff";
    const monoHatch =
      solid ? hatch : hatch.pattern !== "none" ? { ...hatch, color: SECTION_INK } : hatch;
    primitives.push({
      kind: "polygon",
      pts,
      fill: mono ? monoFill : fill,
      stroke: SECTION_INK,
      strokeWidthMm: SECTION_CUT_OUTLINE_MM,
      hatch: mono ? monoHatch : hatch,
    });
  }

  // Verdeckte Kanten zuerst (liegen unter den sichtbaren), gestrichelt.
  for (const e of output.hiddenEdges) {
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
      // SIA-Poché in mono: Vollmuster „solid" ist eine SCHWARZE Poché und bleibt
      // schwarz (Schwarz bleibt Schwarz); jede andere Füllung wird weiß, die
      // Linien-/Kreuzschraffur bleibt sichtbar, aber in Tinte.
      if (p.hatch.pattern === "solid") {
        p.hatch = { ...p.hatch, color: POCHE_FILL_BLACK };
        p.fill = p.fill === "none" ? "none" : POCHE_FILL_BLACK;
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
/**
 * Ein Öffnungs-Intervall entlang der Wandachse (from..to in Metern). `headHeight`
 * = Sturzhöhe (OK der Öffnung über der Wand-UK) für die 3D-Aussparung; im Plan
 * ungenutzt, aber Teil des gemeinsamen Vertrags mit dem 3D-Pfad.
 */
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

function addWallPoche(
  out: Primitive[],
  project: Project,
  wall: Wall,
  gaps: WallGap[],
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
  // Vereinfachte Füllung (grob): neutrale SIA-Poché des tragenden Bauteils
  // (höchste Priorität) — weiß, bzw. schwarz falls dessen Muster "solid" ist.
  const simpleFill = backbonePocheFill(project, wt);

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
    let off = refOff - total / 2;
    for (let li = 0; li < wt.layers.length; li++) {
      const layer = wt.layers[li];
      const comp = getComponent(project, layer.componentId);
      const layerHatch = resolveHatch(project, comp.hatchId, wallAngleDeg);
      // SIA-Poché: neutraler Hintergrund (weiß) statt Bauteil-Albedo, die
      // Schichtschraffur liegt darüber; Vollmuster ("solid") = schwarze Poché.
      const layerSolid = layerHatch.pattern === "solid";
      out.push({
        kind: "polygon",
        pts: clippedBand(p1, p2, off, off + layer.thickness, startCut, endCut),
        fill: layerSolid ? POCHE_FILL_BLACK : POCHE_FILL_WHITE,
        // Band ohne Umriss: keine Schichtfuge über die Bandkante, keine 45°-Naht
        // am Knoten. Die Fugen kommen als separate `line`-Primitive (siehe unten).
        stroke: "none",
        strokeWidthMm: 0,
        hatch: layerSolid ? { ...layerHatch, color: POCHE_FILL_BLACK } : layerHatch,
        greyed,
        // Für die Ecktests/Konsistenz beibehalten (bei stroke:"none" wirkungslos).
        noStrokeEdges: bandJoinEdges,
        wallId,
      });
      off += layer.thickness;
      // Innere Schichtfuge (zwischen dieser und der nächst-inneren Schicht) als
      // eigene Linie am kumulierten Offset `off`, mit dem Cut der Bänder geclippt.
      // Stil aus layer.jointLineStyleId (Gewicht/Farbe/Strich); Rückfall = Haar-
      // linie (LAYER_LINE_MM) in Wandfarbe. Das Gewicht folgt demselben Detail-
      // Faktor wie die frühere Schichtfuge (`layerLineMm`), damit die Detailgrade
      // sich unverändert verhalten. Die innerste Schicht hat keine innere Fuge.
      if (li < wt.layers.length - 1) {
        // clippedBand(p1, p2, off, off, …) liefert [edgeStart, edgeEnd, edgeEnd,
        // edgeStart] → die zwei distinkten Endpunkte sind Index 0 (Start) und 1
        // (Ende), beide am Cut abgeschnitten wie die Bandlängskante.
        const jq = clippedBand(p1, p2, off, off, startCut, endCut);
        const jls = layer.jointLineStyleId
          ? project.lineStyles.find((l) => l.id === layer.jointLineStyleId)
          : undefined;
        out.push({
          kind: "line",
          a: jq[0],
          b: jq[1],
          cls: "layer-joint",
          weightMm: jls ? jls.weight * LAYER_DETAIL_FACTOR[detail] : layerLineMm,
          color: jls ? jls.color : stroke,
          dash: jls ? jls.dash : null,
          greyed,
        });
      }
    }
    // Kräftige Wand-Umrisslinie über die volle Dicke (nur Kontur, keine Füllung),
    // damit die Wand sich klar von den dünnen Schichtfugen abhebt. Die Gehrungs-
    // Stirnkanten am Knoten entfallen → sauberer Eck-Apex ohne überschießende Barbe.
    out.push({
      kind: "polygon",
      pts: clippedBand(p1, p2, refOff - total / 2, refOff + total / 2, startCut, endCut),
      fill: "none",
      stroke,
      strokeWidthMm: outlineMm,
      hatch: NO_HATCH,
      greyed,
      noStrokeEdges: bandJoinEdges,
      wallId,
    });
  }
}

/**
 * Neutrale SIA-Poché-Füllung des tragenden Bauteils (höchste joinPriority) für
 * die grobe Sammelfläche: weiß, bzw. schwarz falls dessen Schraffur "solid" ist.
 * (Ersetzt die frühere rohe Bauteil-Albedo — im Plan zählt die Poché, nicht die
 * 3D-Materialfarbe.)
 */
function backbonePocheFill(project: Project, wt: Project["wallTypes"][number]): string {
  let best: { pattern: HatchPattern; prio: number } | null = null;
  for (const layer of wt.layers) {
    const comp = getComponent(project, layer.componentId);
    if (!best || comp.joinPriority > best.prio)
      best = { pattern: getHatch(project, comp.hatchId).pattern, prio: comp.joinPriority };
  }
  return best ? pocheFill(best.pattern) : POCHE_FILL_WHITE;
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
  _doorLwMm: number,
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
    weightMm: SYMBOL_HAIRLINE_MM,
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
      weightMm: SYMBOL_HAIRLINE_MM,
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
        weightMm: SYMBOL_HAIRLINE_MM,
        greyed,
      });
    }
  }
}

/**
 * Öffnungs-Symbol (Fenster/Tür) je Detailgrad. Anders als das Legacy-`addDoorSymbol`
 * arbeitet diese Funktion über die reinen Geometrie-Helfer (opening.ts) und taggt
 * ihre Primitive mit `openingId`, sodass die Öffnung im Plan selektierbar ist.
 *
 * Tür:
 *  • grob   — gerade Türblatt-Linie (die Lücke kommt aus der ausgesparten Poché).
 *  • mittel — + Schwenkbogen (Öffnungswinkel).
 *  • fein   — + Anschlag-Striche an beiden Pfosten.
 * Fenster:
 *  • grob   — eine einzelne Glaslinie über die Lücke.
 *  • mittel — Rahmen-Rechteck (Umriss) + eine Glaslinie.
 *  • fein   — Rahmen + zwei Glaslinien (Doppelverglasung angedeutet).
 */
function addOpeningSymbol(
  out: Primitive[],
  project: Project,
  wall: Wall,
  o: Opening,
  greyed: boolean,
  detail: DetailLevel,
  lwMm: number,
): void {
  if (o.kind === "door") {
    const sym = doorSymbol(wall, o);
    if (!sym) return;
    // Türblatt (alle Stufen).
    out.push({
      kind: "line",
      a: sym.hinge,
      b: sym.openEnd,
      cls: "door-leaf",
      weightMm: SYMBOL_HAIRLINE_MM,
      greyed,
      openingId: o.id,
    });
    // mittel + fein: Schwenkbogen von geschlossen → offen.
    if (detail !== "grob") {
      out.push({
        kind: "arc",
        center: sym.hinge,
        from: sym.closedEnd,
        to: sym.openEnd,
        r: sym.radius,
        cls: "door-swing",
        weightMm: SYMBOL_HAIRLINE_MM,
        greyed,
        openingId: o.id,
      });
    }
    // fein: Anschlag-Striche an beiden Pfosten (quer zur Wand).
    if (detail === "fein") {
      const reveal = 0.06;
      for (const jamb of [sym.jambStart, sym.jambEnd]) {
        out.push({
          kind: "line",
          a: add(jamb, scale(sym.normal, reveal)),
          b: add(jamb, scale(sym.normal, -reveal)),
          cls: "door-frame",
          weightMm: SYMBOL_HAIRLINE_MM,
          greyed,
          openingId: o.id,
        });
      }
    }
    return;
  }

  // Fenster: Rahmen (mittel/fein) + Glaslinie(n) je Detailgrad.
  const glassCount = detail === "fein" ? 2 : 1;
  const sym = windowSymbol(project, wall, o, glassCount);
  if (!sym) return;
  if (detail !== "grob") {
    // Rahmen-Rechteck als reine Umrisslinie (Poché-Stroke, keine Füllung).
    out.push({
      kind: "polygon",
      pts: sym.frame,
      fill: "none",
      stroke: o.color ?? POCHE_STROKE,
      strokeWidthMm: lwMm,
      hatch: NO_HATCH,
      greyed,
      openingId: o.id,
    });
  }
  for (const [a, b] of sym.glassLines) {
    out.push({
      kind: "line",
      a,
      b,
      cls: "window-glass",
      weightMm: SYMBOL_HAIRLINE_MM,
      greyed,
      openingId: o.id,
    });
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

/**
 * Decken-Poché im Grundriss: die Decke liegt als Slab ÜBER der Schnittebene und
 * wird daher als geschlossener Umriss ihres Grundriss-Polygons gezeichnet — eine
 * gefüllte + schraffierte Fläche plus eine kräftige Umrisslinie. Fill/Schraffur
 * stammen aus dem BAUTEIL der ersten (obersten) Schicht des Aufbau-Typs (analog
 * zur Wand-Schichtauflösung); die Umrissfarbe aus der optionalen Decken-Farbe
 * bzw. dem Poché-Strich. Jedes Polygon trägt die `ceilingId` für die Auswahl.
 *
 * BEWUSST FLÄCHIG, auch bei mehrschichtigem Deckentyp: anders als die Wand
 * (deren Schichten im Grundriss als Querschnitt sichtbar sind) liegt der
 * Schichtaufbau einer Decke in Z (oben → unten) — von oben unsichtbar. Die
 * Schichtbänderung erscheint daher NUR im Schnitt (siehe `toSection.ts`), nicht
 * hier. Im Detailgrad „grob" entfällt die Schraffur (nur Fläche + Umriss);
 * „mittel"/„fein" zeigen die Component-Schraffur. `lwMm` ist die Kategorie-
 * Strichstärke.
 */
function addCeilingPoche(
  out: Primitive[],
  project: Project,
  ceiling: Ceiling,
  greyed: boolean,
  detail: DetailLevel,
  lwMm: number,
): void {
  const pts = ceiling.outline;
  if (pts.length < 3) return;
  const wt = getCeilingType(project, ceiling);
  const comp = wt.layers.length > 0 ? getComponent(project, wt.layers[0].componentId) : null;
  const stroke = ceiling.color ?? POCHE_STROKE;
  const outlineMm = lwMm * OUTLINE_DETAIL_FACTOR[detail];
  const ceilingId = ceiling.id;

  // Gefüllte + schraffierte Fläche (Component-Poché). Im Detailgrad „grob" ohne
  // Schraffur (reine Füllung), sonst die Bauteil-Schraffur. SIA-Poché wie bei
  // der mehrschichtigen Wand: neutraler Hintergrund (weiß) statt Bauteil-Albedo,
  // Vollmuster ("solid") = schwarze Poché.
  const hatch = comp && detail !== "grob" ? resolveHatch(project, comp.hatchId) : NO_HATCH;
  const solid = hatch.pattern === "solid";
  out.push({
    kind: "polygon",
    pts,
    fill: comp ? pocheFill(hatch.pattern) : "none",
    stroke,
    strokeWidthMm: LAYER_LINE_MM * LAYER_DETAIL_FACTOR[detail],
    hatch: solid ? { ...hatch, color: POCHE_FILL_BLACK } : hatch,
    greyed,
    ceilingId,
  });
  // Kräftige Umrisslinie über die volle Decke (nur Kontur, keine Füllung).
  out.push({
    kind: "polygon",
    pts,
    fill: "none",
    stroke,
    strokeWidthMm: outlineMm,
    hatch: NO_HATCH,
    greyed,
    ceilingId,
  });
}

/**
 * Deckkraft (0..255) der Raum-Füllung → 2-stelliges Hex-Suffix. Transluzente
 * Farbfüllung entfällt — Plandarstellung schwarz/grau; Farbe bleibt späteren
 * Schema-Ebenen vorbehalten. Alpha 0 = unsichtbar; das Polygon bleibt als
 * `roomId`-Primitiv erhalten (Auswahl per Punkt-in-Polygon in PlanView, NICHT
 * über die native Pointer-Trefferfläche der Füllung — die volle Fläche bleibt
 * damit trotz Alpha 0 klickbar).
 */
const ROOM_FILL_ALPHA = "00";
/** Basis-Schriftgrösse des Raum-Stempels in Punkt (pt). */
const ROOM_STAMP_PT = 10;

/** Farbe mit Alpha-Suffix versehen (nur, wenn `color` ein 6-stelliges Hex ist). */
function withAlpha(color: string, alphaHex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${alphaHex}` : color;
}

/**
 * Raum (SIA-416-Fläche) im Grundriss: eine (unsichtbare, nur klickbare) Füll-
 * fläche über dem lichten Umriss + eine dünne neutrale Umrisslinie (beide
 * `roomId`-getaggt für die Auswahl) + ein Raum-Stempel (Text) am Anker
 * (Centroid oder `stampAnchor`) mit Name, Fläche „24.30 m²" und SIA-Kürzel.
 * Keine Farbwäsche — Plandarstellung schwarz/grau, Farbe bleibt späteren
 * Schema-Ebenen vorbehalten. Der Stempel entfällt beim Detailgrad „grob";
 * Fläche/Umfang/Schwerpunkt werden aus `boundary` abgeleitet (nie gespeichert).
 * Wird UNTER der Wand-Poché gezeichnet.
 */
function addRoomArea(
  out: Primitive[],
  room: Room,
  greyed: boolean,
  detail: DetailLevel,
): void {
  const pts = room.boundary;
  if (pts.length < 3) return;
  const res = evaluateRoom(pts, room.siaCategory);
  const stroke = room.color;

  // Unsichtbare Füllfläche (Alpha 0): keine Farbwäsche im Plan, das Polygon
  // bleibt aber als `roomId`-Primitiv für die Punkt-in-Polygon-Auswahl erhalten.
  out.push({
    kind: "polygon",
    pts,
    fill: withAlpha(room.color, ROOM_FILL_ALPHA),
    stroke,
    strokeWidthMm: LAYER_LINE_MM * LAYER_DETAIL_FACTOR[detail],
    hatch: NO_HATCH,
    greyed,
    roomId: room.id,
  });

  // Raum-Stempel: frei editierbarer Rich-Text (Name/Notizen) + LIVE-Flächenzeile
  // + SIA-Kürzel. Anker fix (stampAnchor, sonst Centroid). Nur ab Detailgrad
  // „mittel". Die Flächenzeile aktualisiert sich unabhängig vom editierten Text.
  if (detail !== "grob") {
    const at = room.stampAnchor ?? res.centroid;
    // Strukturierter Stempel (Feldmodell) hat Vorrang; sonst Alt-Pfad (Rich-Text
    // bzw. Raum-Name als einfacher Text).
    const doc = room.stamp
      ? roomStampToDoc(room.stamp)
      : room.stampDoc ?? docFromText(room.name);
    const extraLines = room.stamp
      ? roomStampExtraLines(room.stamp, {
          netArea: res.netArea,
          siaCategory: room.siaCategory,
          siaLabel: siaLabel(room.siaCategory),
        })
      : [
          { text: `${res.netArea.toFixed(2)} m²`, align: "center" as const },
          {
            text: `${room.siaCategory} · ${siaLabel(room.siaCategory)}`,
            align: "center" as const,
          },
        ];
    out.push({
      kind: "text",
      at,
      doc,
      extraLines,
      basePt: ROOM_STAMP_PT,
      color: stroke,
      roomId: room.id,
      greyed,
    });
  }
}

/**
 * Treppen-Symbol im Grundriss (DOSSIER/SIA):
 *  • Tritte als Rechtecke: die Tritt-Trennlinien werden gezeichnet — unter der
 *    Schnittebene DURCHGEZOGEN (sichtbar), darüber GESTRICHELT (verdeckt).
 *  • Der erste Tritt oberhalb der Schnittebene trägt die diagonale SIA-Bruchlinie
 *    (Doppelstrich quer über den Lauf).
 *  • Zwischenpodest (L/Wendel) als Umriss-Polygon.
 *  • Lauflinie (Lauflinie) mit Auf-/Abpfeil (Auf-/Abpfeil) und Stufenanzahl-Label.
 * Alle Primitive tragen `stairId` für die Auswahl.
 */
function addStairSymbol(
  out: Primitive[],
  project: Project,
  stair: Stair,
  greyed: boolean,
  lwMm: number,
  cutHeight: number,
): void {
  const { zBottom, zTop } = stairVerticalExtent(project, stair);
  const totalRise = zTop - zBottom;
  const geo = stairGeometry(stair, totalRise);
  const cut = stairCut(geo, cutHeight);
  const below = new Set(cut.belowIndices);
  const stroke = stair.color ?? POCHE_STROKE;
  const stairId = stair.id;

  // Umriss + Tritt-Trennlinien je Stufe. Der letzte Punkt jedes Tritt-Rechtecks
  // liefert die vordere Kante (Auftritt); wir zeichnen jede Tritt-Kante.
  for (const tr of geo.treads) {
    const isBelow = below.has(tr.index);
    // Tritt-Rechteck als reine Umrisslinie (keine Füllung), durchgezogen wenn
    // unter der Schnittebene, sonst gestrichelt (verdeckt).
    out.push({
      kind: "polygon",
      pts: tr.pts,
      fill: "none",
      stroke,
      strokeWidthMm: lwMm * 0.7,
      hatch: NO_HATCH,
      greyed,
      stairId,
    });
    // Zusätzliche Auftrittskante (vordere Kante der Stufe) etwas kräftiger.
    const front: [Vec2, Vec2] = [tr.pts[1], tr.pts[2]];
    out.push({
      kind: "line",
      a: front[0],
      b: front[1],
      cls: "stair-tread",
      weightMm: lwMm * (isBelow ? 1.0 : 0.6),
      dash: isBelow ? null : [0.12, 0.08],
      color: stroke,
      greyed,
      stairId,
    });
  }

  // Zwischenpodest (L/Wendel-Auge): Umriss-Polygon.
  if (geo.landing && geo.landing.length >= 3) {
    out.push({
      kind: "polygon",
      pts: geo.landing,
      fill: "none",
      stroke,
      strokeWidthMm: lwMm * 0.7,
      hatch: NO_HATCH,
      greyed,
      stairId,
    });
  }

  // SIA-Bruchlinie (Doppelstrich diagonal über den Schnitt-Tritt).
  if (cut.breakLine) {
    for (const [a, b] of cut.breakLine) {
      out.push({
        kind: "line",
        a,
        b,
        cls: "stair-break",
        weightMm: lwMm,
        color: stroke,
        greyed,
        stairId,
      });
    }
  }

  // Lauflinie (Lauflinie) — kräftig, durchgezogen.
  for (let i = 0; i < geo.runLine.length - 1; i++) {
    out.push({
      kind: "line",
      a: geo.runLine[i],
      b: geo.runLine[i + 1],
      cls: "stair-run",
      weightMm: lwMm,
      color: stroke,
      greyed,
      stairId,
    });
  }
  // Auf-/Abpfeil an der Spitze der Lauflinie.
  const [h1, tip, h2] = geo.arrow.head;
  out.push({ kind: "line", a: h1, b: tip, cls: "stair-arrow", weightMm: lwMm, color: stroke, greyed, stairId });
  out.push({ kind: "line", a: h2, b: tip, cls: "stair-arrow", weightMm: lwMm, color: stroke, greyed, stairId });
}

const length = (w: Wall): number => Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);

function computeBounds(
  project: Project,
  walls: Wall[],
  drawings: Drawing2D[] = [],
  ceilings: Ceiling[] = [],
  stairs: Stair[] = [],
  rooms: Room[] = [],
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
