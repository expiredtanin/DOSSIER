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

import type { Column, ColumnProfile } from "../../model/types";
import { uniqueId } from "../../tools/types";
import { columnFootprint } from "../../geometry/column";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  CmdOption,
  Project,
  Vec2,
} from "../types";

/** Default-Ebene (Kategorie) für Stützen: „50" Tragwerk (Fallback: aktive). */
const COLUMN_CATEGORY = "50";
/** Default-Kantenlänge eines Rechteckprofils (Meter). */
const DEF_SIZE = 0.3;
/** Fallback-Höhe, falls das Geschoss keine floorHeight trägt (Meter). */
const DEF_HEIGHT = 2.6;

// ── Persistente Defaults (modulweit, leben über Befehls-Instanzen hinweg) ────
const columnDefaults: { kind: "rect" | "round"; size: number } = {
  kind: "rect",
  size: DEF_SIZE,
};

/** Baut das aktuelle Default-Profil aus `columnDefaults`. */
function currentProfile(): ColumnProfile {
  if (columnDefaults.kind === "round") {
    return { kind: "round", radius: columnDefaults.size / 2 };
  }
  return { kind: "rect", width: columnDefaults.size, depth: columnDefaults.size };
}

/** Fügt die Stütze immutabel an `project.columns` an. */
function appendColumn(
  p: Project,
  position: Vec2,
  ctx: CommandContext,
): Project {
  const height =
    ctx.level.floorHeight != null && ctx.level.floorHeight > 0
      ? ctx.level.floorHeight
      : DEF_HEIGHT;
  const column: Column = {
    id: uniqueId("column"),
    type: "column",
    floorId: ctx.level.id,
    categoryCode: COLUMN_CATEGORY,
    position,
    profile: currentProfile(),
    rotation: 0,
    height,
  };
  return { ...p, columns: [...(p.columns ?? []), column] };
}

interface ColState extends CommandState {
  phase: "place" | "done";
}

const finish = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as ColState,
  { draft: null, done: true },
];

/** Footprint-Vorschau des aktuellen Default-Profils am Cursor. */
function previewAt(pt: Vec2): CommandResult {
  const ghost: Column = {
    id: "_preview",
    type: "column",
    floorId: "",
    categoryCode: COLUMN_CATEGORY,
    position: pt,
    profile: currentProfile(),
    rotation: 0,
    height: 0,
  };
  const size =
    columnDefaults.kind === "round"
      ? `Ø${(columnDefaults.size * 100).toFixed(0)}`
      : `${(columnDefaults.size * 100).toFixed(0)}×${(columnDefaults.size * 100).toFixed(0)}`;
  return {
    draft: {
      preview: [{ kind: "poly", pts: columnFootprint(ghost), closed: true }],
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
        { draft: null, done: true, commit: (p) => appendColumn(p, input.point, ctx) },
      ];
    }
    return [s, { draft: null }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as ColState;
    if (s.phase !== "place") return [s, { draft: null }];
    return [s, previewAt(point)];
  },

  onConfirm: (): [CommandState, CommandResult] => finish(),
  onCancel: (): [CommandState, CommandResult] => finish(),
};
