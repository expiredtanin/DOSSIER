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

import type { Opening } from "../../model/types";
import { uniqueId } from "../../tools/types";
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
import { addItems, opsMutation } from "../../core";
import type { CoreOp } from "../../core";

/** Default-Ebene (Kategorie) für Öffnungen: „21" Türen/Fenster (Fallback: aktive). */
const OPENING_CATEGORY = "21";
/** Toleranz (Modell-Meter) für das Picken einer Host-Wand per Klick. */
const WALL_PICK_DIST = 0.6;
/** Default-Maße (Meter). */
const DEF_WINDOW = { width: 1.2, height: 1.2, sill: 0.9 };
const DEF_DOOR = { width: 0.9, height: 2.1, sill: 0 };

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });

/** Existiert die Öffnungs-Kategorie („21")? Sonst Fallback auf die aktive. */
function openingCategory(ctx: CommandContext): string {
  const flat: { code: string }[] = [];
  const walk = (list: { code: string; children?: unknown[] }[]) => {
    for (const c of list) {
      flat.push({ code: c.code });
      if (c.children) walk(c.children as { code: string; children?: unknown[] }[]);
    }
  };
  walk(ctx.project.layers as { code: string; children?: unknown[] }[]);
  return flat.some((c) => c.code === OPENING_CATEGORY)
    ? OPENING_CATEGORY
    : ctx.defaultCategoryCode;
}

/** Auf die Wandachse projizierter Fußpunkt + Parameter t (0..len) + Distanz. */
function projectOntoWall(
  wall: { start: Vec2; end: Vec2 },
  p: Vec2,
): { t: number; foot: Vec2; dist: number } {
  const ax = sub(wall.end, wall.start);
  const len2 = dot(ax, ax) || 1e-9;
  const raw = dot(sub(p, wall.start), ax) / len2; // 0..1
  const t = Math.max(0, Math.min(1, raw));
  const foot = add(wall.start, scale(ax, t));
  const dist = Math.hypot(p.x - foot.x, p.y - foot.y);
  return { t: t * Math.sqrt(len2), foot, dist };
}

/** Nächste Wand auf dem aktiven Geschoss zum Klickpunkt (innerhalb Toleranz). */
function pickWall(
  ctx: CommandContext,
  p: Vec2,
): { id: string; start: Vec2; end: Vec2 } | null {
  let best: { id: string; start: Vec2; end: Vec2; d: number } | null = null;
  for (const w of ctx.project.walls) {
    if (w.floorId !== ctx.level.id) continue;
    const { dist } = projectOntoWall(w, p);
    if (dist <= WALL_PICK_DIST && (!best || dist < best.d)) {
      best = { id: w.id, start: w.start, end: w.end, d: dist };
    }
  }
  return best ? { id: best.id, start: best.start, end: best.end } : null;
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

/** Vorschau: Lücken-Balken entlang der Wand + Positionsmarke. */
function posDraft(s: OpPos): ToolDraft {
  const ax = sub(s.end, s.start);
  const len = Math.hypot(ax.x, ax.y) || 1e-9;
  const u = { x: ax.x / len, y: ax.y / len };
  const n = { x: -u.y, y: u.x };
  const from = Math.max(0, Math.min(s.posAlong, len));
  const to = Math.max(from, Math.min(from + s.width, len));
  const a = add(s.start, scale(u, from));
  const b = add(s.start, scale(u, to));
  const half = 0.15; // Vorschau-Balken quer zur Wand
  const quad: Vec2[] = [
    add(a, scale(n, half)),
    add(b, scale(n, half)),
    add(b, scale(n, -half)),
    add(a, scale(n, -half)),
  ];
  const preview: DraftShape[] = [{ kind: "poly", pts: quad, closed: true }];
  // Symbol-Andeutung: Fenster = Mittellinie, Tür = Blatt-Linie in Schwenkrichtung.
  if (s.kind === "window") {
    preview.push({ kind: "line", a, b });
  } else {
    const swingSign = s.side === "left" ? 1 : -1;
    const dirSign = s.dir === "in" ? 1 : -1;
    const hinge = s.hinge === "start" ? a : b;
    const leafEnd = add(hinge, scale(n, swingSign * dirSign * s.width));
    preview.push({ kind: "line", a: hinge, b: leafEnd });
  }
  const draft: ToolDraft = { preview, vertices: [a, b] };
  const mid = add(a, scale(u, (to - from) / 2));
  draft.hud = {
    at: s.cursor ?? mid,
    text: `${from.toFixed(2)} m · ${s.kind === "door" ? "Tür" : "Fenster"} ${(
      s.width * 100
    ).toFixed(0)}×${(s.height * 100).toFixed(0)}`,
  };
  return draft;
}

/** Hängt eine Öffnung ans Projekt (immutabel). */
function appendOpening(s: OpPos, ctx: CommandContext): CoreOp[] {
  const len = Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y);
  const width = Math.max(0.1, Math.min(s.width, len));
  const position = Math.max(0, Math.min(s.posAlong, Math.max(0, len - width)));
  // Standard-Bauteiltyp zuweisen (erster Tür-/Fenstertyp der Bibliothek), damit
  // frisch platzierte Öffnungen SOFORT die volle Rahmen-/Laibungs-Darstellung
  // (2D + 3D) bekommen — ohne Typ blieben sie ein blosses Loch mit flacher
  // Scheibe. Fehlt eine Bibliothek, bleibt es beim Inline-Verhalten (kein Typ).
  const typeId =
    s.kind === "door" ? ctx.project.doorTypes?.[0]?.id : ctx.project.windowTypes?.[0]?.id;
  const opening: Opening = {
    id: uniqueId("O"),
    type: "opening",
    hostWallId: s.wallId,
    categoryCode: openingCategory(ctx),
    kind: s.kind,
    position,
    width,
    height: s.height,
    sillHeight: s.kind === "door" ? 0 : s.sill,
    ...(typeId ? { typeId } : {}),
    ...(s.kind === "door"
      ? { hinge: s.hinge, swing: s.side, openingDir: s.dir, swingAngle: s.swingAngle }
      : {}),
  };
  return addItems("openings", [opening]);
}

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
      return [next, { draft: next.phase === "pos" ? posDraft(next as OpPos) : null }];
    }

    if (input.kind === "number") {
      // Im Positionsschritt: getippte Zahl = Abstand vom Wandanfang (Meter).
      if (s.phase === "pos") {
        const ns: OpPos = { ...s, posAlong: input.value };
        return [ns, { draft: posDraft(ns) }];
      }
      return [s, { draft: null }];
    }

    if (input.kind !== "point") {
      return [s, { draft: s.phase === "pos" ? posDraft(s as OpPos) : null }];
    }

    const pt = input.point;
    if (s.phase === "wall") {
      const w = pickWall(ctx, pt);
      if (!w) return [s, { draft: null }]; // kein Treffer: Schritt wiederholen
      const proj = projectOntoWall(w, pt);
      const ns: OpPos = {
        phase: "pos",
        lastPoint: pt,
        wallId: w.id,
        start: w.start,
        end: w.end,
        cursor: pt,
        posAlong: proj.t,
        kind: s.kind,
        hinge: s.hinge,
        side: s.side,
        dir: s.dir,
        width: s.width,
        height: s.height,
        sill: s.sill,
        swingAngle: s.swingAngle,
      };
      return [ns, { draft: posDraft(ns) }];
    }

    // Positionsschritt: Klick projiziert auf die Achse → committen.
    const proj = projectOntoWall(s, pt);
    const ns: OpPos = { ...s, posAlong: proj.t, cursor: pt };
    return [
      idle(s)[0],
      { draft: null, done: true, commit: opsMutation(() => appendOpening(ns, ctx)) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as OpState;
    if (s.phase !== "pos") return [s, { draft: null }];
    const proj = projectOntoWall(s, point);
    const ns: OpPos = { ...s, posAlong: proj.t, cursor: point };
    return [ns, { draft: posDraft(ns) }];
  },

  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as OpState;
    if (s.phase === "pos") {
      const ns = s;
      return [
        idle(s)[0],
        { draft: null, done: true, commit: opsMutation(() => appendOpening(ns, ctx)) },
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
