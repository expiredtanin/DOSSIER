// Wall — Wand als echter Engine-Befehl (analog polyline, aber je Achssegment
// entsteht ein eigenständiges `Wall`). Schritte:
//   1) „Startpunkt der Wand:" → Punkt
//   2) „Nächster Punkt ( Zurück ):" → Punkt … (chainend: jede weitere Wand
//      beginnt am letzten Endpunkt) bis Esc/Enter den Zug beendet.
//
// BOGEN-MODUS ([T2], Option „Bogen", wie bei der Polylinie): das nächste Segment wird eine Bogenwand
// (`Wall.bulge`). Drei-Punkt (Default: Durchgangspunkt, dann Endpunkt) oder „Tangential" (schliesst
// weich an das vorige Segment an). Die Bulges rechnet der Kern (`cmd_create.rs`/`cmd_draw.rs`).
//
// Akzeptiert je Punkt Maus-Picks UND getippte Koordinaten (0,0 · r3,0 · 5<45) —
// derselbe Eingabepfad wie Linie/Polylinie. Die fertige Wand rendert über die
// bestehende Wand-Darstellung (generatePlan / 3D); der Draft zeigt die Achse +
// eine einfache Band-Vorschau in der Dicke des aktiven Wandtyps.
//
// Herkunft der Wand-Felder (CommandContext):
//   • wallTypeId  ← ctx.activeWallTypeId (Fallback: project.wallTypes[0].id)
//   • height      ← aktives Geschoss (ctx.level.floorHeight, sonst 2.6 m)
//   • floorId     ← ctx.level.id (aktives Geschoss)
//   • categoryCode← ctx.defaultCategoryCode (aktive Kategorie, i. d. R. „20")

import { segmentHud } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  CmdOption,
  DraftShape,
  ToolDraft,
  Vec2,
} from "../types";
import { createMutation, createPreview, xy } from "../createCore";

const EPS = 1e-6;
const DEG = Math.PI / 180;
const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

const MIN_THICKNESS = 0.01; // kleinste sinnvolle Wanddicke (Meter)

/** Tab-Felder je weiteren Punkt: Länge + Winkel relativ zum letzten Punkt. */
const WALL_FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];
/** Zusätzliches Dicke-Feld (nur bei einschichtigen Wandtypen). */
const THICK_FIELD: CommandField = { id: "thick", labelKey: "cmd.field.thickness" };

/** Nächster Punkt aus gelockten Feldern (length/angle) + Cursor, relativ zu `last`. */
function wallNextFromFields(last: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const ref = cursor ?? last;
  const length = "length" in locks ? locks.length : segLen(last, ref);
  const angleDeg = "angle" in locks ? locks.angle : segAngleDeg(last, ref);
  const ang = angleDeg * DEG;
  return { x: last.x + Math.cos(ang) * length, y: last.y + Math.sin(ang) * length };
}

/** Einschichtig? Nur dann ist das Dicke-Feld sinnvoll (überschreibt die Schicht). */
function isSingleLayer(ctx: CommandContext): boolean {
  const wt =
    ctx.project.wallTypes.find((t) => t.id === ctx.activeWallTypeId) ??
    ctx.project.wallTypes[0];
  return !!wt && wt.layers.length === 1;
}

/** Art eines Segments: gerade (`0`), tangential (`1`) oder Bogen durch einen Durchgangspunkt. */
type Seg = 0 | 1 | Vec2;

interface ArcMode {
  /** Bogen-Modus (bleibt über den Befehl hinweg erhalten). */
  arc: boolean;
  /** Im Bogen-Modus: tangential an den Vorgänger statt Drei-Punkt-Bogen. */
  tangent: boolean;
}

interface WallIdle extends CommandState, ArcMode {
  phase: "start";
  /** Sticky Dicke-Übersteuerung (nur einschichtig); null = Wandtyp-Dicke. */
  thickOverride: number | null;
  /** Ist der aktive Wandtyp einschichtig? (aus ctx in onMove/onInput gesetzt) */
  single: boolean;
}
interface WallDrawing extends CommandState, ArcMode {
  phase: "next";
  points: Vec2[];
  /** Art je Segment (s. {@link Seg}). */
  segs: Seg[];
  /** Drei-Punkt-Bogen: gesetzter Durchgangspunkt, der auf seinen Endpunkt wartet. */
  pendingThrough: Vec2 | null;
  cursor: Vec2 | null;
  /** Sticky Dicke-Übersteuerung (nur einschichtig); null = Wandtyp-Dicke. */
  thickOverride: number | null;
  /** Ist der aktive Wandtyp einschichtig? (aus ctx in onMove/onInput gesetzt) */
  single: boolean;
}
type WallCmdState = WallIdle | WallDrawing;

const UNDO: CmdOption = { id: "undo", labelKey: "cmd.polyline.undo" };
const arcOption = (on: boolean): CmdOption => ({ id: "arc", labelKey: "cmd.polyline.arcOpt", value: on ? "on" : "off" });
const tangentOption = (on: boolean): CmdOption => ({ id: "tangent", labelKey: "cmd.polyline.tangentOpt", value: on ? "on" : "off" });

/**
 * Bänder der schon gesetzten Segmente: sie ändern sich je Mausschritt nicht und werden nur neu gerechnet,
 * wenn sich Punkte, Dicke, Projekt oder Wandtyp ändern — je Mausschritt rechnet der Kern nur das lebende
 * Segment (gleich schnell bei langen Wandzügen).
 */
let fixedCache: { points: Vec2[]; thick: number | null; project: unknown; wallType: string; shapes: DraftShape[] } | null = null;

function fixedShapes(ctx: CommandContext, points: Vec2[], thick: number | null): DraftShape[] {
  const c = fixedCache;
  if (c && c.points === points && c.thick === thick && c.project === ctx.project && c.wallType === ctx.activeWallTypeId) return c.shapes;
  const shapes = points.length >= 2 ? createPreview(ctx, { cmd: "wall", thick }, points).shapes : [];
  fixedCache = { points, thick, project: ctx.project, wallType: ctx.activeWallTypeId, shapes };
  return shapes;
}

/**
 * Vorschau: Band (Dicke = aktiver Wandtyp bzw. gelockte Dicke) + Achse je Segment, gerechnet im Kern
 * (`cmd_create.rs`), dazu HUD (Länge·Winkel des lebenden Segments). Die FERTIGE Wand rendert über die
 * bestehende Wand-Darstellung — hier ist nur der Rubber-Band-Entwurf.
 */
function wallDraft(
  ctx: CommandContext,
  points: Vec2[],
  cursor: Vec2 | null,
  thick: number | null,
  arc?: ArcMode & { segs: Seg[]; pendingThrough: Vec2 | null },
): ToolDraft {
  // Bogen im Spiel: ganze Vorschau im Kern (Tangente hängt am Vorgänger), ohne Zwischenspeicher.
  if (arc && (arc.arc || arc.segs.some((g) => g !== 0))) {
    const all = cursor ? [...points, cursor] : points;
    const req = { cmd: "wall", thick, segs: arc.segs, arc: arc.arc, tangent: arc.tangent, through: arc.pendingThrough, cursor: !!cursor };
    const draft: ToolDraft = { preview: all.length >= 2 ? createPreview(ctx, req, all).shapes : [], vertices: points };
    const last = points[points.length - 1];
    if (cursor && last && segLen(last, cursor) >= EPS) draft.hud = segmentHud(last, cursor);
    return draft;
  }
  const fixed = fixedShapes(ctx, points, thick);
  const live = cursor && points.length ? createPreview(ctx, { cmd: "wall", thick }, [points[points.length - 1], cursor]).shapes : [];
  const draft: ToolDraft = { preview: live.length ? [...fixed, ...live] : fixed, vertices: points };
  const last = points[points.length - 1];
  if (cursor && last && segLen(last, cursor) >= EPS) draft.hud = segmentHud(last, cursor);
  return draft;
}

/**
 * Commit: je Achssegment eine Wand des aktiven Typs (Höhe aus dem Geschoss); eine gelockte Dicke
 * (einschichtig) wählt/erzeugt den passenden Wandtyp — beides im Kern (`cmd_create.rs`).
 */
const appendWalls = (pts: Vec2[], ctx: CommandContext, thick: number | null, segs: Seg[] = []) =>
  createMutation(
    ctx,
    segs.some((g) => g !== 0) ? { cmd: "wall", pts: pts.map(xy), thick, segs } : { cmd: "wall", pts: pts.map(xy), thick },
  );

const idle = (
  thickOverride: number | null = null,
  single = false,
  mode: ArcMode = { arc: false, tangent: false },
): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null, thickOverride, single, arc: mode.arc, tangent: mode.tangent } as WallIdle,
  { draft: null, done: true },
];

const modeOf = (s: ArcMode): ArcMode => ({ arc: s.arc, tangent: s.tangent });
const draftOf = (ctx: CommandContext, s: WallDrawing): ToolDraft => wallDraft(ctx, s.points, s.cursor, s.thickOverride, s);

export const wallCommand: Command = {
  name: "wall",
  labelKey: "cmd.wall.label",
  // Wände leben auf Geschossen — wie das Legacy-Werkzeug nur dort aktiv.
  floorOnly: true,
  prompt: (s) => {
    const ps = s as WallCmdState;
    if (ps.phase !== "next") return "cmd.wall.start";
    return ps.arc && !ps.tangent && !ps.pendingThrough ? "cmd.polyline.arcThrough" : "cmd.wall.next";
  },
  accepts: () => ["point", "number", "option"],
  options: (s) => {
    const ps = s as WallCmdState;
    const arc = [arcOption(!!ps.arc), ...(ps.arc ? [tangentOption(!!ps.tangent)] : [])];
    return ps.phase === "next" ? [...arc, UNDO] : arc;
  },
  init: (): WallIdle => ({ phase: "start", lastPoint: null, thickOverride: null, single: false, arc: false, tangent: false }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as WallCmdState;
    const to = s.thickOverride;
    const single = isSingleLayer(ctx);

    if (input.kind === "option") {
      // Bogen-Modus/Tangential umschalten (auch vor dem Startpunkt); verwirft einen wartenden
      // Durchgangspunkt.
      if (input.id === "arc" || input.id === "tangent") {
        const flip = input.id === "arc" ? { arc: !s.arc } : { tangent: !s.tangent };
        if (s.phase !== "next") return [{ ...s, ...flip, single } as WallIdle, { draft: null }];
        const ns: WallDrawing = { ...s, ...flip, single, pendingThrough: null };
        return [ns, { draft: draftOf(ctx, ns) }];
      }
      if (s.phase !== "next") return [s, { draft: null }];
      if (input.id === "undo") {
        if (s.pendingThrough) {
          const ns: WallDrawing = { ...s, pendingThrough: null };
          return [ns, { draft: draftOf(ctx, ns) }];
        }
        const pts = s.points.slice(0, -1);
        if (pts.length === 0)
          return [{ phase: "start", lastPoint: null, thickOverride: to, single, ...modeOf(s) } as WallIdle, { draft: null }];
        const ns: WallDrawing = {
          phase: "next",
          points: pts,
          segs: s.segs.slice(0, Math.max(0, pts.length - 1)),
          pendingThrough: null,
          cursor: s.cursor,
          lastPoint: pts[pts.length - 1],
          thickOverride: to,
          single,
          ...modeOf(s),
        };
        return [ns, { draft: draftOf(ctx, ns) }];
      }
      return [{ ...s, single } as WallCmdState, { draft: draftOf(ctx, s) }];
    }

    if (input.kind !== "point") {
      return [{ ...s, single } as WallCmdState, { draft: s.phase === "next" ? draftOf(ctx, s) : null }];
    }
    const pt = input.point;
    if (s.phase !== "next") {
      const ns: WallDrawing = {
        phase: "next",
        points: [pt],
        segs: [],
        pendingThrough: null,
        cursor: pt,
        lastPoint: pt,
        thickOverride: to,
        single,
        ...modeOf(s),
      };
      return [ns, { draft: draftOf(ctx, ns) }];
    }
    // Chaining: jede weitere Wand beginnt am letzten Endpunkt. Null-Strecke
    // (Klick auf denselben Punkt) ignorieren — nicht abbrechen.
    const last = s.points[s.points.length - 1];
    if (segLen(last, pt) < EPS) {
      return [{ ...s, single } as WallCmdState, { draft: draftOf(ctx, s) }];
    }
    // Drei-Punkt-Bogen: der erste Klick setzt nur den Durchgangspunkt.
    if (s.arc && !s.tangent && !s.pendingThrough) {
      const ns: WallDrawing = { ...s, pendingThrough: pt, cursor: pt, single };
      return [ns, { draft: draftOf(ctx, ns) }];
    }
    const seg: Seg = !s.arc ? 0 : (s.pendingThrough ?? 1);
    const ns: WallDrawing = {
      ...s,
      points: [...s.points, pt],
      segs: [...s.segs, seg],
      pendingThrough: null,
      cursor: pt,
      lastPoint: pt,
      thickOverride: to,
      single,
    };
    return [ns, { draft: draftOf(ctx, ns) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as WallCmdState;
    if (s.phase !== "next") return [s, { draft: null }];
    const ns: WallDrawing = { ...s, cursor: point, single: isSingleLayer(ctx) };
    return [ns, { draft: draftOf(ctx, ns) }];
  },

  // Enter/Space/Rechtsklick: offenen Zug beenden (≥2 Punkte) und committen.
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as WallCmdState;
    if (s.phase === "next" && s.points.length >= 2) {
      const pts = s.points;
      const to = s.thickOverride;
      return [
        { phase: "start", lastPoint: null, thickOverride: to, single: s.single, ...modeOf(s) } as WallIdle,
        { draft: null, done: true, commit: appendWalls(pts, ctx, to, s.segs) },
      ];
    }
    return idle(s.thickOverride, s.single, modeOf(s));
  },
  onCancel: (state): [CommandState, CommandResult] => {
    const s = state as WallCmdState;
    return idle(s.thickOverride, s.single, modeOf(s));
  },

  // Tab-Feld-Zyklus im „next"-Schritt: Länge + Winkel relativ zum letzten Punkt.
  // Bei EINSCHICHTIGEN Wandtypen zusätzlich ein Dicke-Feld (überschreibt die
  // Bandbreite live + auf Commit). Mehrschichtige Typen: kein Dicke-Feld
  // (der aktive Wandtyp wird in onMove/onInput aus dem Context ermittelt).
  fields: (state) => {
    const s = state as WallCmdState;
    if (s.phase !== "next") return [];
    return s.single ? [...WALL_FIELDS, THICK_FIELD] : WALL_FIELDS;
  },
  pointFromFields: (state, locks, cursor) => {
    const s = state as WallCmdState;
    // Gelockte Dicke sticky in den State übernehmen (kein Koordinatenfeld):
    // die Engine ruft diese Funktion bei jeder Maus-/Pick-/Enter-Aktion, bevor
    // sie den Punkt an onInput reicht — so kennt der Commit die Dicke.
    if ("thick" in locks && locks.thick >= MIN_THICKNESS) s.thickOverride = locks.thick;
    if (s.phase !== "next" || s.points.length === 0) return null;
    return wallNextFromFields(s.points[s.points.length - 1], locks, cursor);
  },
  fieldValues: (state, locks, cursor): Record<string, number> => {
    const s = state as WallCmdState;
    if (s.phase !== "next") return {};
    const out: Record<string, number> = {};
    // Dicke-Feld: gelockt → Lock, sonst die aktuelle (sticky) Übersteuerung.
    if ("thick" in locks) out.thick = locks.thick;
    else if (s.thickOverride != null) out.thick = s.thickOverride;
    if (s.points.length === 0 || !cursor) return out;
    const last = s.points[s.points.length - 1];
    out.length = segLen(last, cursor);
    out.angle = ((segAngleDeg(last, cursor) % 360) + 360) % 360;
    return out;
  },
};
