// [280] Träger/Unterzug als Engine-Befehl. Ablauf:
//   1) „Anfang des Trägers:" → Punkt
//   2) „Ende des Trägers:"   → Punkt → commit (ein Träger, Befehl endet)
//
// Der Träger sitzt auf dem aktiven Geschoss, Klasse „25“ (Stützen), sonst „50“ (Tragwerk), die Oberkante bündig an der Deckenunterkante
// (Unterzug); der Kern (`cmd_create.rs`, Befehl `beam`) legt ihn an. Optionen (IMMER sichtbar): Profil = Vorgabe aus
// einer kurzen Liste (Rechteck-Unterzug 25/40 … oder Stahlprofil als Text mit Aussenmassen). Eine getippte Zahl setzt
// die Querschnittshöhe (Meter) PERSISTENT über Aufrufe, die Breite bleibt die des Profils.
//
// Bezeichner englisch, sichtbarer Text via t().

import { segmentHud } from "../../tools/types";
import type { Command, CommandContext, CommandResult, CommandState, CmdOption, ToolDraft, Vec2 } from "../types";
import { createMutation, createPreview } from "../createCore";

const EPS = 1e-6;

/** Profil-Vorgaben: Breite × Höhe (Meter, Aussenmasse), Name nur als Text. */
const PRESETS: { id: string; width: number; height: number; name: string }[] = [
  { id: "rect2540", width: 0.25, height: 0.4, name: "" },
  { id: "rect3050", width: 0.3, height: 0.5, name: "" },
  { id: "rect2030", width: 0.2, height: 0.3, name: "" },
  { id: "heb200", width: 0.2, height: 0.2, name: "HEB 200" },
  { id: "heb300", width: 0.3, height: 0.3, name: "HEB 300" },
  { id: "ipe200", width: 0.1, height: 0.2, name: "IPE 200" },
];

// ── Persistente Vorgaben (modulweit, leben über Befehls-Instanzen hinweg) ─────
const defaults: { preset: number; height: number | null } = { preset: 0, height: null };

const current = () => {
  const p = PRESETS[defaults.preset] ?? PRESETS[0];
  return { width: p.width, height: defaults.height ?? p.height, profileName: p.name };
};

const label = () => {
  const c = current();
  const size = `${(c.width * 100).toFixed(0)}/${(c.height * 100).toFixed(0)}`;
  return c.profileName ? `${c.profileName} (${size})` : size;
};

interface BeamState extends CommandState {
  phase: "start" | "end" | "done";
  a?: Vec2;
}

const finish = (): [CommandState, CommandResult] => [{ phase: "done", lastPoint: null } as BeamState, { draft: null, done: true }];

/** Anfrage an den Kern: Achse a→b, Querschnitt und Profilname der Vorgabe. */
const request = (a: Vec2, b: Vec2) => ({ cmd: "beam", pts: [[a.x, a.y], [b.x, b.y]], ...current() });

function draftTo(a: Vec2, b: Vec2, ctx: CommandContext): ToolDraft {
  const far = Math.hypot(b.x - a.x, b.y - a.y) >= EPS;
  return {
    preview: far ? createPreview(ctx, { cmd: "beam", ...current() }, [a, b]).shapes : [],
    vertices: [a],
    hud: far ? { at: b, text: `${segmentHud(a, b).length.toFixed(2)} m · ${label()}` } : undefined,
  };
}

export const traegerCommand: Command = {
  name: "traeger",
  labelKey: "cmd.traeger.label",
  prompt: (s) => ((s as BeamState).phase === "end" ? "cmd.traeger.end" : "cmd.traeger.start"),
  accepts: () => ["point", "number", "option"],
  options: (): CmdOption[] => [{ id: "profile", labelKey: "cmd.traeger.profile", value: label() }],
  floorOnly: true,

  init: (): BeamState => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as BeamState;
    if (s.phase === "done") return finish();
    if (input.kind === "number") {
      const v = Math.abs(input.value);
      if (v > 1e-4) defaults.height = v;
      return [s, { draft: s.a ? draftTo(s.a, s.a, ctx) : null }];
    }
    if (input.kind === "option" && input.id === "profile") {
      defaults.preset = (defaults.preset + 1) % PRESETS.length;
      defaults.height = null;
      return [s, { draft: null }];
    }
    if (input.kind !== "point") return [s, { draft: null }];
    if (s.phase === "start") {
      return [{ phase: "end", a: input.point, lastPoint: input.point } as BeamState, { draft: draftTo(input.point, input.point, ctx) }];
    }
    const a = s.a as Vec2;
    if (Math.hypot(input.point.x - a.x, input.point.y - a.y) < EPS) return [s, { draft: draftTo(a, a, ctx) }];
    return [{ phase: "done", lastPoint: null } as BeamState, { draft: null, done: true, commit: createMutation(ctx, request(a, input.point)) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as BeamState;
    if (s.phase !== "end" || !s.a) return [s, { draft: null }];
    return [s, { draft: draftTo(s.a, point, ctx) }];
  },

  onConfirm: (): [CommandState, CommandResult] => finish(),
  onCancel: (): [CommandState, CommandResult] => finish(),
};
