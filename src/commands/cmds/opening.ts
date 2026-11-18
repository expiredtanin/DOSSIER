// Opening — Öffnung (Fenster/Tür) als Engine-Befehl. Sie wird in eine BESTEHENDE
// Wand gehostet. Ablauf:
//   „Wand für die Öffnung wählen:" → [287] EIN Klick auf/nahe eine Wand setzt die Öffnung an der
//   Mausposition (Archicad/Vectorworks); die Wand ergibt sich aus dem Treffer. Beim Überfahren zeigt
//   eine Vorschau Öffnung und Abstands-Masse. Ein vorher getippter Abstand (Zahl/Feld „Abstand“)
//   gilt statt der Mausposition. Commit: hängt eine `Opening` ans Projekt.
//
// Tab-Felder: Breite / Höhe / Brüstung (sillHeight) /
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
import { t } from "../../i18n";
import type { TranslationKey } from "../../i18n";

/** Default-Maße (Meter). */
const DEF_WINDOW = { width: 1.2, height: 1.2, sill: 0.9 };
const DEF_DOOR = { width: 0.9, height: 2.1, sill: 0 };

/** Nächste Wand des Geschosses zum Klickpunkt (Kern): id, Achse und Abstand des Fusspunkts vom Anfang. */
function pickWall(ctx: CommandContext, p: Vec2): { id: string; start: Vec2; end: Vec2; t: number; bulge?: number } | null {
  const r = createQuery<{ hit: { id: string; start: [number, number]; end: [number, number]; t: number; bulge?: number } | null }>(ctx.project, {
    q: "pickWall",
    level: ctx.level.id,
    pt: xy(p),
  });
  if (!r.hit) return null;
  const { id, start, end, t, bulge } = r.hit;
  return { id, start: { x: start[0], y: start[1] }, end: { x: end[0], y: end[1] }, t, bulge };
}

/**
 * Tab-Felder im Positionsschritt: Abstand entlang der Wand (erstes, aktives Feld — eine getippte Zahl ist der
 * Abstand, nicht die Breite, [285]), dann Breite/Höhe/Brüstung (+ Winkel bei Tür).
 */
const BASE_FIELDS: CommandField[] = [
  { id: "pos", labelKey: "cmd.field.offset" },
  { id: "width", labelKey: "cmd.field.width" },
  { id: "height", labelKey: "cmd.field.height" },
  { id: "sill", labelKey: "cmd.opening.sillField" },
];
const SWING_FIELD: CommandField = { id: "swing", labelKey: "cmd.opening.swingField" };

const KIND: CmdOption = { id: "kind", labelKey: "cmd.opening.kind", value: "window" };
const HINGE: CmdOption = { id: "hinge", labelKey: "cmd.opening.hinge", value: "start" };
const SIDE: CmdOption = { id: "side", labelKey: "cmd.opening.side", value: "left" };
const DIR: CmdOption = { id: "dir", labelKey: "cmd.opening.dir", value: "in" };

interface OpState extends CommandState {
  phase: "wall";
  kind: "window" | "door";
  hinge: "start" | "end";
  side: "left" | "right";
  dir: "in" | "out";
  width: number;
  height: number;
  sill: number;
  swingAngle: number;
  /** [285] Getippter Abstand (Feld „Abstand“): hat Vorrang vor der Mausposition. */
  posLock?: number;
}
/** Treffer-Wand unter der Maus (Kern `pickWall`). */
interface Host {
  wallId: string;
  start: Vec2;
  end: Vec2;
  /** Bogenwand ([T2]): Bulge der Host-Wand; die Position gilt dann als Bogenlänge. */
  bulge?: number;
}

function initState(kind: "window" | "door" = "window"): OpState {
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
const openingReq = (s: OpState, h: Host, pos: number | null) => ({
  cmd: "opening",
  wall: h.wallId,
  start: xy(h.start),
  end: xy(h.end),
  bulge: h.bulge ?? null,
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

/** Wand unter dem Cursor als Host (oder null). */
function hostAt(ctx: CommandContext, p: Vec2): Host | null {
  const w = pickWall(ctx, p);
  return w ? { wallId: w.id, start: w.start, end: w.end, bulge: w.bulge } : null;
}

/**
 * [287] Vorschau beim Überfahren einer Wand (Kern): Lücken-Balken + Symbol an der Mausposition (bzw. am
 * getippten Abstand), dazu Abstands-Masse „Abstand vom Wandanfang · Öffnung B×H · Abstand zum Wandende“.
 * Liefert dazu die Position entlang der Wand.
 */
function previewAt(s: OpState, h: Host, ctx: CommandContext, at: Vec2): { draft: ToolDraft; pos: number } {
  const pv = createPreview(ctx, openingReq(s, h, s.posLock ?? null), s.posLock !== undefined ? [] : [at]);
  const [p, from, ax, ay, bx, by, mx, my] = pv.info;
  const draft: ToolDraft = { preview: pv.shapes, vertices: [{ x: ax, y: ay }, { x: bx, y: by }] };
  const straight = !h.bulge;
  const len = Math.hypot(h.end.x - h.start.x, h.end.y - h.start.y);
  const toEnd = straight ? ` · ${Math.max(0, len - from - s.width).toFixed(2)} m` : "";
  draft.hud = {
    at: s.posLock !== undefined ? { x: mx, y: my } : at,
    text: `${from.toFixed(2)} m · ${t(s.kind === "door" ? "cmd.opening.doorLabel" : "cmd.opening.windowLabel")} ${(
      s.width * 100
    ).toFixed(0)}×${(s.height * 100).toFixed(0)}${toEnd}`,
  };
  return { draft, pos: p };
}

const idle = (from?: OpState): [CommandState, CommandResult] => [
  initState(from?.kind ?? "window"),
  { draft: null, done: true },
];

export const openingCommand: Command = {
  name: "opening",
  labelKey: "cmd.opening.label",
  floorOnly: true,
  prompt: () => "cmd.opening.wall",
  accepts: () => ["point", "number", "option"],
  options: (s): CmdOption[] => {
    const st = s as OpState;
    // [287] Werte übersetzt (vorher „Art=window", „Seite=left").
    const kind: CmdOption = { ...KIND, value: t(st.kind === "door" ? "cmd.opening.doorLabel" : "cmd.opening.windowLabel") };
    if (st.kind === "door") {
      return [
        kind,
        { ...HINGE, value: t(`objinfo.opening.hinge.${st.hinge}` as TranslationKey) },
        { ...SIDE, value: t(`objinfo.opening.swing.${st.side}` as TranslationKey) },
        { ...DIR, value: t(`objinfo.opening.dir.${st.dir}` as TranslationKey) },
      ];
    }
    return [kind];
  },
  init: (): OpState => initState("window"),

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
      return [next, { draft: null }];
    }
    if (input.kind !== "point") return [s, { draft: null }];

    // [287] EIN Klick auf die Wand setzt die Öffnung an der Mausposition (ein getippter Abstand gilt vor dem Klick);
    // die Wand ergibt sich aus dem Treffer. Kein Treffer: Schritt wiederholen.
    const h = hostAt(ctx, input.point);
    if (!h) return [s, { draft: null }];
    const pos = s.posLock ?? previewAt(s, h, ctx, input.point).pos;
    return [idle(s)[0], { draft: null, done: true, commit: createMutation(ctx, openingReq(s, h, pos)) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as OpState;
    const h = hostAt(ctx, point);
    return [s, { draft: h ? previewAt(s, h, ctx, point).draft : null }];
  },

  onConfirm: (state): [CommandState, CommandResult] => idle(state as OpState),
  onCancel: (state): [CommandState, CommandResult] => idle(state as OpState),

  fields: (state) => {
    const s = state as OpState;
    return s.kind === "door" ? [...BASE_FIELDS, SWING_FIELD] : BASE_FIELDS;
  },
  // Getippte Tab-Felder sticky in den State übernehmen; kein Koordinatenpunkt.
  pointFromFields: (state, locks) => {
    const s = state as OpState;
    s.posLock = "pos" in locks && Number.isFinite(locks.pos) ? locks.pos : undefined;
    if ("width" in locks && locks.width > 0) s.width = locks.width;
    if ("height" in locks && locks.height > 0) s.height = locks.height;
    if ("sill" in locks && locks.sill >= 0) s.sill = locks.sill;
    if ("swing" in locks && locks.swing > 0) s.swingAngle = locks.swing;
    return null;
  },
  fieldValues: (state): Record<string, number> => {
    const s = state as OpState;
    const out: Record<string, number> = {
      ...(s.posLock !== undefined ? { pos: s.posLock } : {}),
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
  init: (): OpState => initState("window"),
};

/** „Tür"-Variante: identischer Befehl, startet aber im Tür-Modus. */
export const tuerCommand: Command = {
  ...openingCommand,
  name: "tuer",
  labelKey: "cmd.opening.doorLabel",
  init: (): OpState => initState("door"),
};
