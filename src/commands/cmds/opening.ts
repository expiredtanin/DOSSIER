// Opening — Öffnung (Fenster/Tür) als Engine-Befehl. Sie wird in eine BESTEHENDE
// Wand gehostet. Ablauf:
//   1) „Wand für die Öffnung wählen:" → Klick auf/nahe eine Wand (Host).
//   2) „Position entlang der Wand:" → Klick auf der Wandachse ODER getippter
//      Abstand vom Wand-Startpunkt (Zahl). Die Position wird auf die Achse
//      projiziert; der HUD zeigt den Abstand vom Wandanfang.
//   3) Commit: hängt eine `Opening` ans Projekt.
//
// Tab-Felder im Positionsschritt: Breite / Höhe / Brüstung (sillHeight) /
// Schwenkwinkel (nur Tür). Optionen: Fenster⇄Tür-Umschalter, Anschlag
// (Scharnier start/end), Aufschlagseite (links/rechts), Richtung (innen/außen).
//
// Bezeichner englisch, sichtbarer Text via t() (CONVENTIONS.md).

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

/** Default-Maße (Meter). */
const DEF_WINDOW = { width: 1.2, height: 1.2, sill: 0.9 };
const DEF_DOOR = { width: 0.9, height: 2.1, sill: 0 };

/** Nächste Wand des Geschosses zum Klickpunkt (Kern): id, Achse und Abstand des Fusspunkts vom Anfang. */
function pickWall(ctx: CommandContext, p: Vec2): { id: string; start: Vec2; end: Vec2; t: number } | null {
  const r = createQuery<{ hit: { id: string; start: [number, number]; end: [number, number]; t: number } | null }>(ctx.project, {
    q: "pickWall",
    level: ctx.level.id,
    pt: xy(p),
  });
  if (!r.hit) return null;
  const { id, start, end, t } = r.hit;
  return { id, start: { x: start[0], y: start[1] }, end: { x: end[0], y: end[1] }, t };
}

/** Tab-Felder im Positionsschritt: Breite/Höhe/Brüstung (+ Winkel bei Tür). */
const BASE_FIELDS: CommandField[] = [
  { id: "width", labelKey: "cmd.field.width" },
  { id: "height", labelKey: "cmd.field.height" },
  { id: "sill", labelKey: "cmd.opening.sillField" },
];
const SWING_FIELD: CommandField = { id: "swing", labelKey: "cmd.opening.swingField" };

const KIND: CmdOption = { id: "kind", labelKey: "cmd.opening.kind", value: "window" };
const HINGE: CmdOption = { id: "hinge", labelKey: "cmd.opening.hinge", value: "start" };
const SIDE: CmdOption = { id: "side", labelKey: "cmd.opening.side", value: "left" };
const DIR: CmdOption = { id: "dir", labelKey: "cmd.opening.dir", value: "in" };

interface OpIdle extends CommandState {
  phase: "wall";
  kind: "window" | "door";
  hinge: "start" | "end";
  side: "left" | "right";
  dir: "in" | "out";
  width: number;
  height: number;
  sill: number;
  swingAngle: number;
}
interface OpPos extends CommandState {
  phase: "pos";
  wallId: string;
  start: Vec2;
  end: Vec2;
  cursor: Vec2 | null;
  posAlong: number; // Abstand vom Wandanfang (Meter)
  kind: "window" | "door";
  hinge: "start" | "end";
  side: "left" | "right";
  dir: "in" | "out";
  width: number;
  height: number;
  sill: number;
  swingAngle: number;
}
type OpState = OpIdle | OpPos;

function initState(kind: "window" | "door" = "window"): OpIdle {
  const def = kind === "door" ? DEF_DOOR : DEF_WINDOW;
  return {
    phase: "wall",
    lastPoint: null,
    kind,
    hinge: "start",
    side: "left",
    dir: "in",
    width: def.width,
    height: def.height,
    sill: def.sill,
    swingAngle: 90,
  };
}

/** Anfrage an den Kern (`cmd_create.rs`); `pos` = null → Position aus dem Cursor projiziert. */
const openingReq = (s: OpPos, pos: number | null) => ({
  cmd: "opening",
  wall: s.wallId,
  start: xy(s.start),
  end: xy(s.end),
  kind: s.kind,
  hinge: s.hinge,
  side: s.side,
  dir: s.dir,
  width: s.width,
  height: s.height,
  sill: s.sill,
  swingAngle: s.swingAngle,
  pos,
});

/**
 * Vorschau (Kern): Lücken-Balken entlang der Wand + Symbol (Fenster = Mittellinie, Tür = Blatt in
 * Schwenkrichtung); `pos` = null projiziert `at` auf die Achse. Liefert dazu die Position.
 */
function posDraftAt(s: OpPos, ctx: CommandContext, pos: number | null, at: Vec2 | null): { draft: ToolDraft; pos: number } {
  const pv = createPreview(ctx, openingReq(s, pos), at ? [at] : []);
  const [p, from, ax, ay, bx, by, mx, my] = pv.info;
  const draft: ToolDraft = { preview: pv.shapes, vertices: [{ x: ax, y: ay }, { x: bx, y: by }] };
  draft.hud = {
    at: s.cursor ?? { x: mx, y: my },
    text: `${from.toFixed(2)} m · ${s.kind === "door" ? "Tür" : "Fenster"} ${(
      s.width * 100
    ).toFixed(0)}×${(s.height * 100).toFixed(0)}`,
  };
  return { draft, pos: p };
}

const posDraft = (s: OpPos, ctx: CommandContext): ToolDraft => posDraftAt(s, ctx, s.posAlong, null).draft;

/** Commit (Kern): Öffnung in die Host-Wand, Breite/Position auf die Wand geklemmt, Standard-Typ der Bibliothek. */
const appendOpening = (s: OpPos, ctx: CommandContext) => createMutation(ctx, openingReq(s, s.posAlong));

const idle = (from?: OpState): [CommandState, CommandResult] => [
  initState(from?.kind ?? "window"),
  { draft: null, done: true },
];

export const openingCommand: Command = {
  name: "opening",
  labelKey: "cmd.opening.label",
  floorOnly: true,
  prompt: (s) =>
    (s as OpState).phase === "pos" ? "cmd.opening.pos" : "cmd.opening.wall",
  accepts: (s) =>
    (s as OpState).phase === "pos"
      ? ["point", "number", "option"]
      : ["point", "option"],
  options: (s): CmdOption[] => {
    const st = s as OpState;
    const kind: CmdOption = { ...KIND, value: st.kind };
    if (st.kind === "door") {
      return [
        kind,
        { ...HINGE, value: st.hinge },
        { ...SIDE, value: st.side },
        { ...DIR, value: st.dir },
      ];
    }
    return [kind];
  },
  init: (): OpIdle => initState("window"),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as OpState;

    if (input.kind === "option") {
      // Umschalter zyklen ihren Wert. Bei kind-Wechsel Default-Maße übernehmen.
      const next = { ...s } as OpState;
      if (input.id === "kind") {
        next.kind = s.kind === "window" ? "door" : "window";
        const def = next.kind === "door" ? DEF_DOOR : DEF_WINDOW;
        next.width = def.width;
        next.height = def.height;
        next.sill = def.sill;
      } else if (input.id === "hinge") {
        next.hinge = s.hinge === "start" ? "end" : "start";
      } else if (input.id === "side") {
        next.side = s.side === "left" ? "right" : "left";
      } else if (input.id === "dir") {
        next.dir = s.dir === "in" ? "out" : "in";
      }
      return [next, { draft: next.phase === "pos" ? posDraft(next as OpPos, ctx) : null }];
    }

    if (input.kind === "number") {
      // Im Positionsschritt: getippte Zahl = Abstand vom Wandanfang (Meter).
      if (s.phase === "pos") {
        const ns: OpPos = { ...s, posAlong: input.value };
        return [ns, { draft: posDraft(ns, ctx) }];
      }
      return [s, { draft: null }];
    }

    if (input.kind !== "point") {
      return [s, { draft: s.phase === "pos" ? posDraft(s as OpPos, ctx) : null }];
    }

    const pt = input.point;
    if (s.phase === "wall") {
      const w = pickWall(ctx, pt);
      if (!w) return [s, { draft: null }]; // kein Treffer: Schritt wiederholen
      const ns: OpPos = {
        phase: "pos",
        lastPoint: pt,
        wallId: w.id,
        start: w.start,
        end: w.end,
        cursor: pt,
        posAlong: w.t,
        kind: s.kind,
        hinge: s.hinge,
        side: s.side,
        dir: s.dir,
        width: s.width,
        height: s.height,
        sill: s.sill,
        swingAngle: s.swingAngle,
      };
      return [ns, { draft: posDraft(ns, ctx) }];
    }

    // Positionsschritt: Klick projiziert auf die Achse → committen.
    const ns: OpPos = { ...s, posAlong: posDraftAt(s, ctx, null, pt).pos, cursor: pt };
    return [
      idle(s)[0],
      { draft: null, done: true, commit: appendOpening(ns, ctx) },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as OpState;
    if (s.phase !== "pos") return [s, { draft: null }];
    const at = posDraftAt({ ...s, cursor: point }, ctx, null, point);
    const ns: OpPos = { ...s, posAlong: at.pos, cursor: point };
    return [ns, { draft: at.draft }];
  },

  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as OpState;
    if (s.phase === "pos") {
      const ns = s;
      return [
        idle(s)[0],
        { draft: null, done: true, commit: appendOpening(ns, ctx) },
      ];
    }
    return idle(s);
  },
  onCancel: (state): [CommandState, CommandResult] => idle(state as OpState),

  fields: (state) => {
    const s = state as OpState;
    if (s.phase !== "pos") return [];
    return s.kind === "door" ? [...BASE_FIELDS, SWING_FIELD] : BASE_FIELDS;
  },
  // Getippte Tab-Felder sticky in den State übernehmen; kein Koordinatenpunkt.
  pointFromFields: (state, locks) => {
    const s = state as OpState;
    if ("width" in locks && locks.width > 0) s.width = locks.width;
    if ("height" in locks && locks.height > 0) s.height = locks.height;
    if ("sill" in locks && locks.sill >= 0) s.sill = locks.sill;
    if ("swing" in locks && locks.swing > 0) s.swingAngle = locks.swing;
    return null;
  },
  fieldValues: (state): Record<string, number> => {
    const s = state as OpState;
    const out: Record<string, number> = {
      width: s.width,
      height: s.height,
      sill: s.sill,
    };
    if (s.kind === "door") out.swing = s.swingAngle;
    return out;
  },
};

/** „Fenster"-Variante: identischer Befehl, startet aber im Fenster-Modus. */
export const fensterCommand: Command = {
  ...openingCommand,
  name: "fenster",
  labelKey: "cmd.opening.windowLabel",
  init: (): OpIdle => initState("window"),
};

/** „Tür"-Variante: identischer Befehl, startet aber im Tür-Modus. */
export const tuerCommand: Command = {
  ...openingCommand,
  name: "tuer",
  labelKey: "cmd.opening.doorLabel",
  init: (): OpIdle => initState("door"),
};
