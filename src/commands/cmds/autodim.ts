// Aussenbemassung ([81]) — Sofort-Befehl ohne Punkt-Eingabe: erzeugt für das aktive Geschoss
// die Massketten (Öffnungen, Vor-/Rücksprünge, Gesamtmass) je Gebäudeseite
// (`geometry/autoDimensions.ts`). Ein erneuter Aufruf ersetzt die zuvor automatisch erzeugten
// Ketten DIESES Geschosses (feste IDs), von Hand gezeichnete Bemassungen bleiben.

import { addItems, autoExteriorDimensions, opsMutation, removeItems } from "../../core";
import type { Command, CommandContext, CommandResult, CommandState } from "../types";

const PREFIX = "autodim";

const done = (): [CommandState, CommandResult] => [
  { phase: "idle", lastPoint: null },
  { draft: null, done: true },
];

export const autodimCommand: Command = {
  name: "autodim",
  labelKey: "cmd.autodim.label",
  prompt: () => "cmd.autodim.label",
  accepts: () => [],
  options: () => [],
  init: (): CommandState => ({ phase: "idle", lastPoint: null }),

  autoRun: (ctx: CommandContext): CommandResult => {
    if (ctx.level.kind !== "floor") return { draft: null, done: true };
    const floorId = ctx.level.id;
    const dims = autoExteriorDimensions(ctx.project, floorId, ctx.defaultCategoryCode, 100, PREFIX);
    if (dims.length === 0) return { draft: null, done: true };
    const own = `${PREFIX}-${floorId}-`;
    return {
      draft: null,
      done: true,
      // Frühere Ketten dieses Geschosses raus, neue hinten dran.
      commit: opsMutation((p) => [
        ...removeItems(p, "drawings2d", (d) => d.id.startsWith(own)),
        ...addItems("drawings2d", dims.map((d) => d.drawing)),
      ]),
    };
  },

  onInput: (): [CommandState, CommandResult] => done(),
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => done(),
  onCancel: (): [CommandState, CommandResult] => done(),
};
