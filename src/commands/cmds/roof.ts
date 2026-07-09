// Roof — Dach als Engine-Befehl: der Grundriss wird als RECHTECK aufgezogen
// (zwei Klicks: erste Ecke → Gegenecke), committet ein `Roof`-Bauteil. Die
// Dachform/Neigung wählt man nach dem Platzieren im Attribut-Panel; Default ist
// ein Satteldach mit First entlang der LÄNGEREN Rechteckseite.
//
// Schritte:
//   1) „Erste Dachecke:"  → Punkt
//   2) „Gegenecke:"       → Live-Rechteck-Vorschau; Klick committet das Dach.
//
// Herkunft der Dach-Felder (CommandContext):
//   • floorId     ← ctx.level.id (aktives Geschoss)
//   • categoryCode← "35" (Ebene „Dächer"; Fallback ctx.defaultCategoryCode)

import type { Roof, RoofShape } from "../../model/types";
import { uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  CmdOption,
  DraftShape,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

/** Default-Ebene (Kategorie) für Dächer („31 Dächer"). */
const ROOF_CATEGORY = "31";

/** Wählbare Dachformen (Inline-Optionen der Befehlszeile). */
const SHAPE_OPTIONS: CmdOption[] = [
  { id: "sattel", labelKey: "cmd.roof.shape.sattel" },
  { id: "walm", labelKey: "cmd.roof.shape.walm" },
  { id: "pult", labelKey: "cmd.roof.shape.pult" },
  { id: "mansarde", labelKey: "cmd.roof.shape.mansarde" },
  { id: "zelt", labelKey: "cmd.roof.shape.zelt" },
  { id: "flach", labelKey: "cmd.roof.shape.flach" },
];
const SHAPE_IDS = new Set(SHAPE_OPTIONS.map((o) => o.id));

/** Existiert die Dach-Kategorie („35")? Sonst Fallback auf die aktive Kategorie. */
function roofCategory(ctx: CommandContext): string {
  const flat: string[] = [];
  const walk = (list: { code: string; children?: unknown[] }[]) => {
    for (const c of list) {
      flat.push(c.code);
      if (c.children) walk(c.children as { code: string; children?: unknown[] }[]);
    }
  };
  walk(ctx.project.layers as { code: string; children?: unknown[] }[]);
  return flat.includes(ROOF_CATEGORY) ? ROOF_CATEGORY : ctx.defaultCategoryCode;
}

/** Vier Eckpunkte eines Rechtecks aus zwei Gegenecken (CCW). */
function rectCorners(a: Vec2, b: Vec2): Vec2[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

interface RoofIdle extends CommandState {
  phase: "start";
  shape: RoofShape;
}
interface RoofRect extends CommandState {
  phase: "corner";
  a: Vec2;
  cursor: Vec2 | null;
  shape: RoofShape;
}
type RoofState = RoofIdle | RoofRect;

/** Vorschau: aufgezogenes Rechteck + Masse im HUD. */
function roofDraft(a: Vec2, cursor: Vec2 | null): ToolDraft {
  const pts = cursor ? rectCorners(a, cursor) : [a];
  const preview: DraftShape[] = [{ kind: "poly", pts, closed: !!cursor }];
  const draft: ToolDraft = { preview, vertices: [a] };
  if (cursor) {
    draft.hud = {
      at: cursor,
      text: `${Math.abs(cursor.x - a.x).toFixed(2)} × ${Math.abs(cursor.y - a.y).toFixed(2)} m`,
    };
  }
  return draft;
}

/** Hängt ein Dach ans Projekt (immutabel). Entartete Rechtecke werden verworfen. */
function appendRoof(p: Project, a: Vec2, b: Vec2, shape: RoofShape, ctx: CommandContext): Project {
  const w = Math.abs(b.x - a.x);
  const d = Math.abs(b.y - a.y);
  if (w < 0.1 || d < 0.1) return p;
  const roof: Roof = {
    id: uniqueId("RF"),
    type: "roof",
    floorId: ctx.level.id,
    categoryCode: roofCategory(ctx),
    outline: rectCorners(a, b),
    shape,
    // Flach/Pult brauchen keine „Firsthöhe"; Sattel/Walm/Mansarde/Zelt ~30°.
    pitchDeg: shape === "flach" ? 0 : 30,
    overhang: 0.4,
    // First entlang der längeren Seite (Standard).
    ridgeAxis: w >= d ? "x" : "y",
    thickness: 0.2,
  };
  const roofs = p.roofs ? [...p.roofs, roof] : [roof];
  return { ...p, roofs };
}

const idle = (shape: RoofShape = "sattel"): [CommandState, CommandResult] => [
  { phase: "start", shape, lastPoint: null } as RoofIdle,
  { draft: null, done: true },
];

export const roofCommand: Command = {
  name: "roof",
  labelKey: "cmd.roof.label",
  floorOnly: true,
  prompt: (s) => ((s as RoofState).phase === "corner" ? "cmd.roof.corner" : "cmd.roof.start"),
  accepts: () => ["point", "option"],
  // Dachform als Inline-Optionen — vor/während des Aufziehens wählbar.
  options: () => SHAPE_OPTIONS,
  init: (): RoofIdle => ({ phase: "start", shape: "sattel", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as RoofState;
    // Dachform-Option: aktualisiert die Form, Phase/Rechteck bleiben.
    if (input.kind === "option" && SHAPE_IDS.has(input.id)) {
      const ns = { ...s, shape: input.id as RoofShape } as RoofState;
      const draft = ns.phase === "corner" ? roofDraft(ns.a, ns.cursor) : null;
      return [ns, { draft }];
    }
    if (input.kind !== "point") {
      return [s, { draft: s.phase === "corner" ? roofDraft(s.a, s.cursor) : null }];
    }
    if (s.phase !== "corner") {
      const ns: RoofRect = {
        phase: "corner",
        a: input.point,
        cursor: input.point,
        shape: s.shape,
        lastPoint: input.point,
      };
      return [ns, { draft: roofDraft(input.point, input.point) }];
    }
    // Zweite Ecke → committen.
    const a = s.a;
    const b = input.point;
    const shape = s.shape;
    return [
      { phase: "start", shape, lastPoint: null } as RoofIdle,
      { draft: null, done: true, commit: (p) => appendRoof(p, a, b, shape, ctx) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as RoofState;
    if (s.phase !== "corner") return [s, { draft: null }];
    const ns: RoofRect = { ...s, cursor: point };
    return [ns, { draft: roofDraft(s.a, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
