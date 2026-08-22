// Bemassung (lineare Masslinie(n), SIA 400 B.5.3, Figur 14 „Reihenbemassung").
// Bedienung wie eine Polylinie (beliebig viele Klicks, Doppelklick/Enter
// beendet), das ERGEBNIS ist aber IMMER eine GERADE Punktreihe: der erste
// Klick setzt den Startpunkt, der zweite legt die Richtung fest — jeder
// weitere Klick wird auf diese Gerade projiziert (Reihenbemassung misst
// mehrere Punkte entlang EINER Referenzlinie, z. B. einer Wand, nie einen
// Zickzack-Pfad). Schritte:
//   1) „Erster Punkt:"                    → Punkt
//   2) „Nächster Punkt ( Fertig Zurück ):" → Punkt … (ab dem 3. Punkt auf die
//      durch Punkt 1/2 definierte Gerade projiziert)
//   3) „Lage der Masslinie:"               → Punkt/Zahl (EIN Normalabstand
//      für ALLE Segmente) → commit: je aufeinanderfolgendem Punktpaar EIN
//      `shape:"dimension"`-Element (unabhängig editierbar, teilt nur den
//      beim Zeichnen gewählten Offset).
//
// Die Masszahl wird beim Rendern aus dist(a,b) abgeleitet (nicht gespeichert)
// — bleibt beim späteren Griff-Ziehen automatisch korrekt.

import type { Drawing2D } from "../../model/types";
import { segmentHud, uniqueId } from "../../tools/types";
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
const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Vorzeichenbehafteter Normalabstand von `pt` zur Geraden a→b (links positiv). */
function signedOffset(a: Vec2, b: Vec2, pt: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < EPS) return 0;
  const nx = -dy / len, ny = dx / len;
  return (pt.x - a.x) * nx + (pt.y - a.y) * ny;
}

/** Projiziert `pt` auf die Gerade durch `p0` in Richtung `p1` (Kette bleibt gerade ab Punkt 3). */
function projectOnLine(p0: Vec2, p1: Vec2, pt: Vec2): Vec2 {
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return pt;
  const t = ((pt.x - p0.x) * dx + (pt.y - p0.y) * dy) / len2;
  return { x: p0.x + dx * t, y: p0.y + dy * t };
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
}
interface DimOffset extends CommandState {
  phase: "offset";
  pts: Vec2[];
  cursor: Vec2 | null;
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
function offsetDraft(pts: Vec2[], offset: number, at: Vec2 | null): ToolDraft {
  const preview: DraftShape[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (Math.abs(offset) > EPS) {
      const off = offsetPoints(a, b, offset);
      preview.push({ kind: "line", a, b: off.a });
      preview.push({ kind: "line", a: b, b: off.b });
      preview.push({ kind: "line", a: off.a, b: off.b });
    } else {
      preview.push({ kind: "line", a, b });
    }
  }
  const draft: ToolDraft = { preview, vertices: pts };
  if (at) {
    const total = pts.reduce((sum, p, i) => (i === 0 ? 0 : sum + dist(pts[i - 1], p)), 0);
    draft.hud = { at, text: `Σ${total.toFixed(3)}m · Δ${offset.toFixed(3)}m` };
  }
  return draft;
}

function appendDimensionChain(p: Project, pts: Vec2[], offset: number, ctx: CommandContext): Project {
  const added: Drawing2D[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (dist(a, b) < EPS) continue;
    added.push({
      id: uniqueId("dr2d"),
      type: "drawing2d",
      levelId: ctx.level.id,
      categoryCode: ctx.defaultCategoryCode,
      geom: { shape: "dimension", a, b, offset },
    });
  }
  if (added.length === 0) return p;
  return { ...p, drawings2d: [...p.drawings2d, ...added] };
}

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
        const ns: DimNext = { phase: "next", pts, cursor: s.cursor, lastPoint: pts[pts.length - 1] };
        return [ns, { draft: chainDraft(pts, s.cursor) }];
      }
      if (input.id === "finish" && s.pts.length >= 2) {
        const ns: DimOffset = { phase: "offset", pts: s.pts, cursor: s.cursor, lastPoint: s.lastPoint };
        return [ns, { draft: offsetDraft(s.pts, 0, null) }];
      }
      return [s, { draft: chainDraft(s.pts, s.cursor) }];
    }

    if (s.phase !== "offset") {
      if (input.kind !== "point") return [s, { draft: null }];
      const pt = input.point;
      if (s.phase !== "next") {
        const ns: DimNext = { phase: "next", pts: [pt], cursor: pt, lastPoint: pt };
        return [ns, { draft: chainDraft([pt], pt) }];
      }
      // Ab dem dritten Punkt: auf die durch Punkt 1/2 festgelegte Gerade projizieren.
      const placed = s.pts.length >= 2 ? projectOnLine(s.pts[0], s.pts[1], pt) : pt;
      const pts = [...s.pts, placed];
      const ns: DimNext = { phase: "next", pts, cursor: placed, lastPoint: placed };
      return [ns, { draft: chainDraft(pts, placed) }];
    }

    // Offset-Schritt: Zahl = direkter Abstand, Punkt = Abstand zum Cursor.
    let offset: number;
    if (input.kind === "number") offset = input.value;
    else if (input.kind === "point") offset = signedOffset(s.pts[0], s.pts[1], input.point);
    else return [s, { draft: offsetDraft(s.pts, 0, null) }];
    const pts = s.pts;
    return [
      { phase: "start", lastPoint: null },
      { draft: null, done: true, commit: (p) => appendDimensionChain(p, pts, offset, ctx) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as DimState;
    if (s.phase === "next") {
      const cursor = s.pts.length >= 2 ? projectOnLine(s.pts[0], s.pts[1], point) : point;
      const ns: DimNext = { ...s, cursor };
      return [ns, { draft: chainDraft(s.pts, cursor) }];
    }
    if (s.phase === "offset") {
      // Offset relativ zum ERSTEN Segment (repräsentativ für die ganze Kette).
      const off = signedOffset(s.pts[0], s.pts[1], point);
      const ns: DimOffset = { ...s, cursor: point };
      return [ns, { draft: offsetDraft(s.pts, off, point) }];
    }
    return [s, { draft: null }];
  },

  // Enter/Space/Rechtsklick: im "next"-Schritt (≥2 Punkte) wie Doppelklick →
  // Punktreihe abschliessen; im "offset"-Schritt bricht es ab (kein sinnvoller
  // Default-Abstand ohne Zeigegeste).
  onConfirm: (state): [CommandState, CommandResult] => {
    const s = state as DimState;
    if (s.phase === "next" && s.pts.length >= 2) {
      const ns: DimOffset = { phase: "offset", pts: s.pts, cursor: s.cursor, lastPoint: s.lastPoint };
      return [ns, { draft: offsetDraft(s.pts, 0, null) }];
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
