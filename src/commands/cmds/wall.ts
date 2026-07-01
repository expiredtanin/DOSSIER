// Wall — Wand als echter Engine-Befehl (analog polyline, aber je Achssegment
// entsteht ein eigenständiges `Wall`). Schritte:
//   1) „Startpunkt der Wand:" → Punkt
//   2) „Nächster Punkt ( Zurück ):" → Punkt … (chainend: jede weitere Wand
//      beginnt am letzten Endpunkt) bis Esc/Enter den Zug beendet.
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

import type { Wall, WallType } from "../../model/types";
import { wallTypeThickness } from "../../model/types";
import { wallCorners } from "../../model/geometry";
import { uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  CmdOption,
  DraftShape,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

const EPS = 1e-6;
const DEG = Math.PI / 180;
const DEFAULT_HEIGHT = 2.6; // Fallback-Wandhöhe (Meter), wenn das Geschoss keine hat
const DEFAULT_THICKNESS = 0.2; // Fallback-Banddicke für die Vorschau (Meter)
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

/**
 * Dicke des aktiven Wandtyps (für die Band-Vorschau). Liest `ctx.activeWallTypeId`;
 * fehlt der Typ, Fallback auf den ersten Projekt-Wandtyp bzw. DEFAULT_THICKNESS.
 */
function activeWallThickness(ctx: CommandContext): number {
  const wt =
    ctx.project.wallTypes.find((t) => t.id === ctx.activeWallTypeId) ??
    ctx.project.wallTypes[0];
  return wt ? wallTypeThickness(wt) : DEFAULT_THICKNESS;
}

/** Aktives Wandtyp-Objekt (Fallback: erster Projekt-Wandtyp). */
function activeWallType(ctx: CommandContext): WallType | undefined {
  return (
    ctx.project.wallTypes.find((t) => t.id === ctx.activeWallTypeId) ??
    ctx.project.wallTypes[0]
  );
}

/** Aktiver Wandtyp-ID; Fallback auf den ersten Projekt-Wandtyp. */
function activeWallTypeId(ctx: CommandContext): string {
  const wt = activeWallType(ctx);
  return wt ? wt.id : ctx.activeWallTypeId;
}

/** Einschichtig? Nur dann ist das Dicke-Feld sinnvoll (überschreibt die Schicht). */
function isSingleLayer(ctx: CommandContext): boolean {
  const wt = activeWallType(ctx);
  return !!wt && wt.layers.length === 1;
}

/**
 * Liefert die effektive Vorschau-/Commit-Dicke: eine gelockte `thick`-Eingabe
 * (nur bei einschichtigen Typen) überschreibt die Wandtyp-Dicke.
 */
function effectiveThickness(ctx: CommandContext, override: number | null): number {
  if (override != null && override >= MIN_THICKNESS && isSingleLayer(ctx)) return override;
  return activeWallThickness(ctx);
}

/**
 * Findet einen einschichtigen Wandtyp mit gegebener Dicke (gleiches Bauteil wie
 * `base`) oder erzeugt ihn. Gibt das (evtl. erweiterte) Projekt + die Typ-ID
 * zurück — so bleibt die Plan-/3D-Darstellung unverändert (sie liest die Dicke
 * aus den Schichten des Wandtyps).
 */
function wallTypeForThickness(
  p: Project,
  base: WallType,
  thickness: number,
): { project: Project; wallTypeId: string } {
  const componentId = base.layers[0].componentId;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
  const existing = p.wallTypes.find(
    (t) =>
      t.layers.length === 1 &&
      t.layers[0].componentId === componentId &&
      near(t.layers[0].thickness, thickness),
  );
  if (existing) return { project: p, wallTypeId: existing.id };
  const nt: WallType = {
    id: uniqueId("WT"),
    name: `${base.name} ${(thickness * 100).toFixed(0)} cm`,
    layers: [{ componentId, thickness }],
  };
  return { project: { ...p, wallTypes: [...p.wallTypes, nt] }, wallTypeId: nt.id };
}

interface WallIdle extends CommandState {
  phase: "start";
  /** Sticky Dicke-Übersteuerung (nur einschichtig); null = Wandtyp-Dicke. */
  thickOverride: number | null;
  /** Ist der aktive Wandtyp einschichtig? (aus ctx in onMove/onInput gesetzt) */
  single: boolean;
}
interface WallDrawing extends CommandState {
  phase: "next";
  points: Vec2[];
  cursor: Vec2 | null;
  /** Sticky Dicke-Übersteuerung (nur einschichtig); null = Wandtyp-Dicke. */
  thickOverride: number | null;
  /** Ist der aktive Wandtyp einschichtig? (aus ctx in onMove/onInput gesetzt) */
  single: boolean;
}
type WallCmdState = WallIdle | WallDrawing;

const UNDO: CmdOption = { id: "undo", labelKey: "cmd.polyline.undo" };

/**
 * Vorschau: Achs-Polylinie + Band-Vorschau je Segment (Dicke = aktiver Wandtyp) +
 * HUD (Länge·Winkel des lebenden Segments). Die FERTIGE Wand rendert über die
 * bestehende Wand-Darstellung — hier ist nur der Rubber-Band-Entwurf.
 */
function wallDraft(points: Vec2[], cursor: Vec2 | null, thickness: number): ToolDraft {
  const all = cursor ? [...points, cursor] : points;
  const preview: DraftShape[] = [];
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i];
    const b = all[i + 1];
    if (segLen(a, b) < EPS) continue;
    preview.push({ kind: "poly", pts: wallCorners(a, b, thickness), closed: true });
    preview.push({ kind: "line", a, b }); // Achse
  }
  const draft: ToolDraft = { preview, vertices: points };
  const last = points[points.length - 1];
  if (cursor && last && segLen(last, cursor) >= EPS) {
    draft.hud = {
      at: cursor,
      text: `${segLen(last, cursor).toFixed(2)} m · ${Math.abs(
        (segAngleDeg(last, cursor) + 360) % 360,
      ).toFixed(0)}°`,
    };
  }
  return draft;
}

/**
 * Hängt je Achssegment ein `Wall` des aktiven Typs ans Projekt (immutabel). Höhe
 * aus dem aktiven Geschoss (floorHeight), Geschoss + Kategorie + Wandtyp aus dem
 * Context. Null-Strecken werden übersprungen. Gehrung an Ecken entsteht später
 * automatisch aus computeJoins (generatePlan).
 */
function appendWalls(
  p: Project,
  pts: Vec2[],
  ctx: CommandContext,
  thickOverride: number | null,
): Project {
  const height =
    ctx.level.floorHeight && ctx.level.floorHeight > 0 ? ctx.level.floorHeight : DEFAULT_HEIGHT;
  // Dicke-Übersteuerung (nur einschichtig): passenden Wandtyp finden/erzeugen,
  // damit Plan/3D — die die Dicke aus dem Wandtyp lesen — korrekt darstellen.
  let project = p;
  let wallTypeId = activeWallTypeId(ctx);
  const base = activeWallType(ctx);
  if (
    base &&
    base.layers.length === 1 &&
    thickOverride != null &&
    thickOverride >= MIN_THICKNESS &&
    Math.abs(thickOverride - wallTypeThickness(base)) > 1e-4
  ) {
    const r = wallTypeForThickness(project, base, thickOverride);
    project = r.project;
    wallTypeId = r.wallTypeId;
  }
  const newWalls: Wall[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (segLen(a, b) < EPS) continue;
    newWalls.push({
      id: uniqueId("W"),
      type: "wall",
      floorId: ctx.level.id,
      categoryCode: ctx.defaultCategoryCode,
      start: a,
      end: b,
      wallTypeId,
      height,
    });
  }
  if (newWalls.length === 0) return p;
  return { ...project, walls: [...project.walls, ...newWalls] };
}

const idle = (
  thickOverride: number | null = null,
  single = false,
): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null, thickOverride, single } as WallIdle,
  { draft: null, done: true },
];

export const wallCommand: Command = {
  name: "wall",
  labelKey: "cmd.wall.label",
  // Wände leben auf Geschossen — wie das Legacy-Werkzeug nur dort aktiv.
  floorOnly: true,
  prompt: (s) => ((s as WallCmdState).phase === "next" ? "cmd.wall.next" : "cmd.wall.start"),
  accepts: (s) =>
    (s as WallCmdState).phase === "next" ? ["point", "number", "option"] : ["point", "number"],
  options: (s) => {
    const ps = s as WallCmdState;
    return ps.phase === "next" ? [UNDO] : [];
  },
  init: (): WallIdle => ({ phase: "start", lastPoint: null, thickOverride: null, single: false }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as WallCmdState;
    const thickness = effectiveThickness(ctx, s.thickOverride);
    const to = s.thickOverride;
    const single = isSingleLayer(ctx);

    if (input.kind === "option") {
      if (s.phase !== "next") return [s, { draft: null }];
      if (input.id === "undo") {
        const pts = s.points.slice(0, -1);
        if (pts.length === 0)
          return [{ phase: "start", lastPoint: null, thickOverride: to, single } as WallIdle, { draft: null }];
        const ns: WallDrawing = {
          phase: "next",
          points: pts,
          cursor: s.cursor,
          lastPoint: pts[pts.length - 1],
          thickOverride: to,
          single,
        };
        return [ns, { draft: wallDraft(pts, s.cursor, thickness) }];
      }
      return [{ ...s, single } as WallCmdState, { draft: wallDraft(s.points, s.cursor, thickness) }];
    }

    if (input.kind !== "point") {
      return [{ ...s, single } as WallCmdState, { draft: s.phase === "next" ? wallDraft(s.points, s.cursor, thickness) : null }];
    }
    const pt = input.point;
    if (s.phase !== "next") {
      const ns: WallDrawing = { phase: "next", points: [pt], cursor: pt, lastPoint: pt, thickOverride: to, single };
      return [ns, { draft: wallDraft([pt], pt, thickness) }];
    }
    // Chaining: jede weitere Wand beginnt am letzten Endpunkt. Null-Strecke
    // (Klick auf denselben Punkt) ignorieren — nicht abbrechen.
    const last = s.points[s.points.length - 1];
    if (segLen(last, pt) < EPS) {
      return [{ ...s, single } as WallCmdState, { draft: wallDraft(s.points, s.cursor, thickness) }];
    }
    const points = [...s.points, pt];
    const ns: WallDrawing = { phase: "next", points, cursor: pt, lastPoint: pt, thickOverride: to, single };
    return [ns, { draft: wallDraft(points, pt, thickness) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as WallCmdState;
    if (s.phase !== "next") return [s, { draft: null }];
    const ns: WallDrawing = { ...s, cursor: point, single: isSingleLayer(ctx) };
    return [ns, { draft: wallDraft(s.points, point, effectiveThickness(ctx, s.thickOverride)) }];
  },

  // Enter/Space/Rechtsklick: offenen Zug beenden (≥2 Punkte) und committen.
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as WallCmdState;
    if (s.phase === "next" && s.points.length >= 2) {
      const pts = s.points;
      const to = s.thickOverride;
      return [
        { phase: "start", lastPoint: null, thickOverride: to, single: s.single } as WallIdle,
        { draft: null, done: true, commit: (p) => appendWalls(p, pts, ctx, to) },
      ];
    }
    return idle(s.thickOverride, s.single);
  },
  onCancel: (state): [CommandState, CommandResult] => {
    const s = state as WallCmdState;
    return idle(s.thickOverride, s.single);
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
