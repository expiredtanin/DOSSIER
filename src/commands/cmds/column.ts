// Stütze (Column) als Engine-Befehl — DOSSIER-Audit A4 Tragwerk. Ablauf:
//   1) „Stütze setzen:" → Klick setzt den Einfügepunkt (Profil-Mitte) → commit.
//
// Optionen (togglebar, IMMER sichtbar): Profil Rechteck/Rund. Eine getippte Zahl
// setzt das Leitmass (Rechteck: Seitenlänge → quadratisch; Rund: Durchmesser)
// PERSISTENT über Aufrufe — analog `offset`/`extrude`, wo der pick-Schritt auch
// eine Zahl annimmt. Höhe = Geschosshöhe des aktiven Geschosses (Default).
//
// Herkunft der Stützen-Felder (CommandContext):
//   • floorId     ← ctx.level.id (aktives Geschoss)
//   • categoryCode← "50" (Tragwerk; Fallback ctx.defaultCategoryCode)
//   • height      ← Geschosshöhe (ctx.level.floorHeight), Fallback DEF_HEIGHT
//
// Bezeichner englisch, sichtbarer Text via t() (CONVENTIONS.md).

import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  CmdOption,
  Vec2,
} from "../types";
import { createMutation, createPreview, xy } from "../createCore";

/** Default-Kantenlänge eines Rechteckprofils (Meter). */
const DEF_SIZE = 0.3;

// ── Persistente Defaults (modulweit, leben über Befehls-Instanzen hinweg) ────
const columnDefaults: { kind: "rect" | "round"; size: number } = {
  kind: "rect",
  size: DEF_SIZE,
};

/** Profil-Optionen der Anfrage (Kern baut daraus das Profil: rund Ø `size`, sonst quadratisch). */
const profileReq = () => ({ kind: columnDefaults.kind, size: columnDefaults.size });

/**
 * Commit (Kern, `cmd_create.rs`): Stütze am Punkt, Ebene „50“, Höhe = Geschosshöhe (sonst 2.6 m),
 * Profil aus den Vorgaben.
 */
const appendColumn = (position: Vec2, ctx: CommandContext) =>
  createMutation(ctx, { cmd: "column", at: xy(position), ...profileReq() });

interface ColState extends CommandState {
  phase: "place" | "done";
}

const finish = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as ColState,
  { draft: null, done: true },
];

/** Footprint-Vorschau des aktuellen Default-Profils am Cursor (Kern). */
function previewAt(pt: Vec2, ctx: CommandContext): CommandResult {
  const size =
    columnDefaults.kind === "round"
      ? `Ø${(columnDefaults.size * 100).toFixed(0)}`
      : `${(columnDefaults.size * 100).toFixed(0)}×${(columnDefaults.size * 100).toFixed(0)}`;
  return {
    draft: {
      preview: createPreview(ctx, { cmd: "column", ...profileReq() }, [pt]).shapes,
      vertices: [],
      hud: { at: pt, text: size },
    },
  };
}

export const columnCommand: Command = {
  name: "column",
  labelKey: "cmd.column.label",
  prompt: () => "cmd.column.place",
  accepts: () => ["point", "number", "option"],
  options: (): CmdOption[] => [
    {
      id: "profile",
      labelKey: "cmd.column.profile",
      value: columnDefaults.kind === "round" ? "round" : "rect",
    },
  ],
  floorOnly: true,

  init: (): ColState => ({ phase: "place", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as ColState;
    if (s.phase === "done") return finish();
    if (input.kind === "number") {
      const v = Math.abs(input.value);
      if (v > 1e-4) columnDefaults.size = v;
      return [s, { draft: null }];
    }
    if (input.kind === "option" && input.id === "profile") {
      columnDefaults.kind = columnDefaults.kind === "round" ? "rect" : "round";
      return [s, { draft: null }];
    }
    if (input.kind === "point") {
      return [
        { phase: "done", lastPoint: null } as ColState,
        { draft: null, done: true, commit: appendColumn(input.point, ctx) },
      ];
    }
    return [s, { draft: null }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as ColState;
    if (s.phase !== "place") return [s, { draft: null }];
    return [s, previewAt(point, ctx)];
  },

  onConfirm: (): [CommandState, CommandResult] => finish(),
  onCancel: (): [CommandState, CommandResult] => finish(),
};
