// [222] Volumenstudie → Bauteile: ein gewählter Körper (Massenmodell) wird zu Aussenwänden je Geschoss, Decken
// und Flachdach; fehlende Geschosse legt der Kern obenauf an, der Körper entfällt. Ein Undo-Schritt.
// Ist ein Körper gewählt, läuft der Befehl sofort; sonst „Körper wählen“ (Klick in seine Grundfläche).
// Rechnung und Prüfung im Kern (`cmd_massing.rs`); was er nicht abdeckt (geneigt, Kugel/Kegel/Torus, verrundet, Abzugskörper,
// selbstschneidend, UK zwischen Geschossen), lehnt der Befehl mit einer Meldung ab.

import type { Command, CommandContext, CommandResult, CommandState } from "../types";
import { createMutation, createQuery, xy } from "../createCore";
import { t, type TranslationKey } from "../../i18n";

/** Ergebnis der Prüfung im Kern (`cmd_massing::check`). */
export interface SolidToPartsCheck {
  ok: boolean;
  reason: string | null;
  stories?: number;
  newFloors?: number;
  walls?: number;
  ceilings?: number;
}

/** Namensmuster neuer Geschosse („Geschoss {n}“, der Kern setzt die Nummer ein). */
const floorName = (): string => t("default.floorName");

export function checkSolidToParts(ctx: CommandContext, id: string): SolidToPartsCheck {
  return createQuery<SolidToPartsCheck>(ctx.project, { q: "solidToParts", id, floorName: floorName() });
}

/** Umwandeln (Commit + Meldung) oder ablehnen (nur Meldung). */
function convert(ctx: CommandContext, id: string): CommandResult {
  const c = checkSolidToParts(ctx, id);
  if (!c.ok) {
    return { draft: null, done: true, notice: { key: `cmd.solidtoparts.reject.${c.reason ?? "none"}` as TranslationKey, kind: "warning" } };
  }
  return {
    draft: null,
    done: true,
    commit: createMutation(ctx, { cmd: "solidToParts", id, floorName: floorName() }),
    notice: { key: "cmd.solidtoparts.done", params: { stories: c.stories ?? 0, newFloors: c.newFloors ?? 0, walls: c.walls ?? 0, ceilings: c.ceilings ?? 0 }, kind: "info" },
  };
}

const idle = (): CommandState => ({ phase: "pick", lastPoint: null });

export const solidToPartsCommand: Command = {
  name: "solidtoparts",
  labelKey: "cmd.solidtoparts.label",
  floorOnly: true,
  prompt: () => "cmd.solidtoparts.pick",
  accepts: () => ["point"],
  options: () => [],
  init: idle,

  autoRun: (ctx): CommandResult => {
    const id = ctx.selection.extrudedSolidId;
    return id ? convert(ctx, id) : { draft: null };
  },

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    if (input.kind !== "point") return [state, { draft: null }];
    const hit = createQuery<{ hit: string | null }>(ctx.project, { q: "pickSolid", level: ctx.level.id, pt: xy(input.point) }).hit;
    if (!hit) return [state, { draft: null, notice: { key: "cmd.solidtoparts.noSolid", kind: "info" } }];
    return [idle(), convert(ctx, hit)];
  },
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => [idle(), { draft: null, done: true }],
  onCancel: (): [CommandState, CommandResult] => [idle(), { draft: null, done: true }],
};
