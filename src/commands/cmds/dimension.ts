// Bemassung (lineare Masslinie(n), SIA 400 B.5.3, Figur 14 „Reihenbemassung").
// Bedienung wie eine Polylinie (beliebig viele Klicks, Doppelklick/Enter
// beendet), das ERGEBNIS ist aber IMMER eine GERADE Punktreihe: der erste
// Klick setzt den Startpunkt, der zweite legt die Richtung fest — jeder
// weitere Klick wird auf diese Gerade projiziert (Reihenbemassung misst
// mehrere Punkte entlang EINER Referenzlinie, z. B. einer Wand, nie einen
// Zickzack-Pfad). Die ganze Kette ist EIN Element (`pts.length` ≥ 2).
//
// Neu zeichnen:
//   1) „Erster Punkt:"                    → Punkt
//   2) „Nächster Punkt ( Fertig Zurück ):" → Punkt … (ab dem 3. Punkt auf die
//      durch Punkt 1/2 definierte Gerade projiziert)
//   3) „Lage der Masslinie:"               → Punkt/Zahl → commit neues Element
//
// Ergänzen einer bestehenden Kette (Rhino-Muster: erst selektieren, dann
// Befehl — s. `ctx.selection`): ist beim Start eine `dimension`-Kette
// gewählt, lädt der Befehl deren Punkte/Offset vor und der erste Klick wird
// per Geraden-Projektion in die Kette EINSORTIERT (`insertIntoChain`) — vor
// dem ersten, nach dem letzten (verlängert) ODER zwischen zwei bestehenden
// Punkten (fügt ein). Der Commit ersetzt dasselbe Element (keine Kopie).
//
// Die Masszahl wird beim Rendern aus dist(a,b) abgeleitet (nicht gespeichert)
// — bleibt beim späteren Griff-Ziehen automatisch korrekt.

import { segmentHud } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  CmdOption,
  ToolDraft,
  Vec2,
} from "../types";
import { createMutation, createPreview, createQuery, xy } from "../createCore";

const EPS = 1e-6;
const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Vorzeichenbehafteter Normalabstand von `pt` zur Geraden a→b (links positiv). */
function signedOffset(a: Vec2, b: Vec2, pt: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < EPS) return 0;
  const nx = -dy / len, ny = dx / len;
  return (pt.x - a.x) * nx + (pt.y - a.y) * ny;
}

/**
 * Neuen Punkt in die Kette einsortieren (Kern, `cmd_draw.rs`): auf die Masslinie pts[0]→pts[1]
 * projiziert und nach Parameter einsortiert; unter 2 Punkten einfach angehängt.
 */
function insertIntoChain(ctx: CommandContext, pts: Vec2[], raw: Vec2): Vec2[] {
  return createQuery<{ pts: Vec2[] }>(ctx.project, { q: "dimInsert", pts, pt: xy(raw) }).pts;
}

/** Vorgewählte Bemassungskette (Kern), deren Punkte erweitert werden. */
function selectedChain(ctx: CommandContext): { id: string; pts: Vec2[]; offset: number } | null {
  const id = ctx.selection.drawingId;
  if (!id) return null;
  return createQuery<{ hit: { id: string; pts: Vec2[]; offset: number } | null }>(ctx.project, { q: "dimChain", id }).hit;
}

/** Endpunkte der um `offset` parallel verschobenen Masslinie (Strecke a-b). */
function offsetPoints(a: Vec2, b: Vec2, offset: number): { a: Vec2; b: Vec2 } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * offset, ny = (dx / len) * offset;
  return { a: { x: a.x + nx, y: a.y + ny }, b: { x: b.x + nx, y: b.y + ny } };
}

interface DimStart extends CommandState {
  phase: "start";
}
interface DimNext extends CommandState {
  phase: "next";
  pts: Vec2[];
  cursor: Vec2 | null;
  /** ID der bearbeiteten Kette (Ergänzen-Modus) — null = neue Kette. */
  editId: string | null;
}
interface DimOffset extends CommandState {
  phase: "offset";
  pts: Vec2[];
  cursor: Vec2 | null;
  editId: string | null;
}
type DimState = DimStart | DimNext | DimOffset;

const UNDO: CmdOption = { id: "undo", labelKey: "cmd.dimension.undo" };
const FINISH: CmdOption = { id: "finish", labelKey: "cmd.dimension.finish" };
const OFFSET_FIELDS: CommandField[] = [{ id: "offset", labelKey: "cmd.field.offset" }];

/** Vorschau: Punktreihe (Gummiband) während des Sammelns. */
function chainDraft(pts: Vec2[], cursor: Vec2 | null): ToolDraft {
  const shown = cursor ? [...pts, cursor] : pts;
  const draft: ToolDraft = { preview: [{ kind: "poly", pts: shown, closed: false }], vertices: pts };
  const last = pts[pts.length - 1];
  if (cursor && last && dist(last, cursor) >= EPS) draft.hud = segmentHud(last, cursor);
  return draft;
}

/** Vorschau: alle Masslinien-Segmente bei gegebenem Offset (grob — Massstriche/Text rendert generatePlan). */
/**
 * Vorschau der Lage (Kern): Hilfs- und Masslinien im Abstand des Cursors (ohne Cursor: Abstand 0) + HUD
 * (Gesamtlänge · Abstand).
 */
function offsetDraft(ctx: CommandContext, pts: Vec2[], at: Vec2 | null): ToolDraft {
  const pv = createPreview(ctx, { cmd: "dimension", phase: "offset", cursor: !!at }, at ? [...pts, at] : pts);
  const draft: ToolDraft = { preview: pv.shapes, vertices: pts };
  if (at) {
    const [offset, total] = pv.info;
    draft.hud = { at, text: `Σ${total.toFixed(3)}m · Δ${offset.toFixed(3)}m` };
  }
  return draft;
}

/** Commit (Kern): Kette (Nullstrecken entfernt) mit Abstand bzw. Seite eines Punkts; `editId` ändert eine bestehende. */
const commitChain = (ctx: CommandContext, pts: Vec2[], offset: number | null, side: Vec2 | null, editId: string | null) =>
  createMutation(ctx, { cmd: "dimension", pts, offset, side, editId });

const idle = (): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null },
  { draft: null, done: true },
];

export const dimensionCommand: Command = {
  name: "dimension",
  labelKey: "cmd.dimension.label",
  prompt: (s) => {
    const phase = (s as DimState).phase;
    return phase === "next" ? "cmd.dimension.next" : phase === "offset" ? "cmd.dimension.offset" : "cmd.dimension.start";
  },
  accepts: (s) => ((s as DimState).phase === "offset" ? ["point", "number"] : ["point", "option"]),
  options: (s) => {
    const ds = s as DimState;
    if (ds.phase !== "next") return [];
    return ds.pts.length >= 2 ? [FINISH, UNDO] : [UNDO];
  },
  init: (): DimStart => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as DimState;

    if (input.kind === "option" && s.phase === "next") {
      if (input.id === "undo") {
        const pts = s.pts.slice(0, -1);
        if (pts.length === 0) return [{ phase: "start", lastPoint: null }, { draft: null }];
        const ns: DimNext = { phase: "next", pts, cursor: s.cursor, editId: s.editId, lastPoint: pts[pts.length - 1] };
        return [ns, { draft: chainDraft(pts, s.cursor) }];
      }
      if (input.id === "finish" && s.pts.length >= 2) {
        const ns: DimOffset = { phase: "offset", pts: s.pts, cursor: s.cursor, editId: s.editId, lastPoint: s.lastPoint };
        return [ns, { draft: offsetDraft(ctx, s.pts, null) }];
      }
      return [s, { draft: chainDraft(s.pts, s.cursor) }];
    }

    if (s.phase !== "offset") {
      if (input.kind !== "point") return [s, { draft: null }];
      const pt = input.point;
      if (s.phase !== "next") {
        // Erster Klick: bei selektierter Kette wird er EINSORTIERT (Ergänzen);
        // sonst startet er eine neue Kette.
        const existing = selectedChain(ctx);
        const pts = existing ? insertIntoChain(ctx, existing.pts, pt) : [pt];
        const editId = existing ? existing.id : null;
        const ns: DimNext = { phase: "next", pts, cursor: pt, editId, lastPoint: pt };
        return [ns, { draft: chainDraft(pts, pt) }];
      }
      // Ab dem dritten Punkt (bzw. jedem weiteren Klick im Ergänzen-Modus):
      // auf die durch Punkt 1/2 festgelegte Gerade projizieren/einsortieren.
      const pts = s.pts.length >= 2 ? insertIntoChain(ctx, s.pts, pt) : [...s.pts, pt];
      const ns: DimNext = { phase: "next", pts, cursor: pt, editId: s.editId, lastPoint: pt };
      return [ns, { draft: chainDraft(pts, pt) }];
    }

    // Offset-Schritt: Zahl = direkter Abstand, Punkt = Abstand zum Cursor.
    if (input.kind !== "number" && input.kind !== "point") return [s, { draft: offsetDraft(ctx, s.pts, null) }];
    const commit =
      input.kind === "number"
        ? commitChain(ctx, s.pts, input.value, null, s.editId)
        : commitChain(ctx, s.pts, null, input.point, s.editId);
    return [{ phase: "start", lastPoint: null }, { draft: null, done: true, commit }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as DimState;
    if (s.phase === "next") {
      // Ab zwei Punkten folgt der Cursor der Masslinie (Projektion im Kern).
      let cursor = point;
      if (s.pts.length >= 2) {
        const [cx, cy] = createPreview(ctx, { cmd: "dimension", phase: "next", cursor: true }, [...s.pts, point]).info;
        cursor = { x: cx, y: cy };
      }
      const ns: DimNext = { ...s, cursor };
      return [ns, { draft: chainDraft(s.pts, cursor) }];
    }
    if (s.phase === "offset") {
      const ns: DimOffset = { ...s, cursor: point };
      return [ns, { draft: offsetDraft(ctx, s.pts, point) }];
    }
    return [s, { draft: null }];
  },

  // Enter/Space/Rechtsklick: im "next"-Schritt (≥2 Punkte) wie Doppelklick →
  // Punktreihe abschliessen; im "offset"-Schritt bricht es ab (kein sinnvoller
  // Default-Abstand ohne Zeigegeste).
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as DimState;
    if (s.phase === "next" && s.pts.length >= 2) {
      const ns: DimOffset = { phase: "offset", pts: s.pts, cursor: s.cursor, editId: s.editId, lastPoint: s.lastPoint };
      return [ns, { draft: offsetDraft(ctx, s.pts, null) }];
    }
    return idle();
  },
  onCancel: (): [CommandState, CommandResult] => idle(),

  fields: (state) => ((state as DimState).phase === "offset" ? OFFSET_FIELDS : []),
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as DimState;
    if (s.phase !== "offset" || !cursor) return {};
    return { offset: signedOffset(s.pts[0], s.pts[1], cursor) };
  },
  pointFromFields: (state, locks, cursor) => {
    const s = state as DimState;
    if (s.phase !== "offset") return null;
    const offset = "offset" in locks ? locks.offset : cursor ? signedOffset(s.pts[0], s.pts[1], cursor) : 0;
    return offsetPoints(s.pts[0], s.pts[1], offset).a;
  },
};
