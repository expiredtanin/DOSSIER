// [149] Baum als Engine-Befehl. Ablauf: „Baum setzen:" → Klick setzt die Stammmitte → nächster Baum
// (der Befehl bleibt aktiv, Esc/Enter beendet). Optionen (Klick wechselt): Form, Bestand, Laub/Nadel.
// Eine getippte Zahl setzt den Kronendurchmesser (bleibt über Aufrufe, wie das Leitmass der Stütze).
// Höhe, Kronenansatz, Stamm und Art danach in der Objekt-Info.
//
// Die Ops baut der Kern (`cmd_create.rs`, Befehl „tree"): Ebene „13" (Bäume), falls vorhanden, sonst
// die aktive; aktives Geschoss.
//
// Bezeichner englisch, sichtbarer Text via t().

import type { Command, CommandContext, CommandResult, CommandState, CmdOption, Vec2 } from "../types";
import type { TreeFoliage, TreeShape, TreeStatus } from "../../model/types";
import { createMutation, createPreview, xy } from "../createCore";
import { t, type TranslationKey } from "../../i18n";

const SHAPES: TreeShape[] = ["round", "oval", "columnar", "conical"];
const STATUS: TreeStatus[] = ["existing", "new", "remove"];
const FOLIAGE: TreeFoliage[] = ["deciduous", "conifer"];

/** Vorgaben des Werkzeugs (modulweit, leben über Befehls-Instanzen hinweg). */
export const treeDefaults: {
  shape: TreeShape;
  status: TreeStatus;
  foliage: TreeFoliage;
  crownDiameter: number;
  height: number;
  trunkDiameter: number;
  crownBase: number;
} = {
  shape: "round",
  status: "existing",
  foliage: "deciduous",
  crownDiameter: 5,
  height: 10,
  trunkDiameter: 0.3,
  crownBase: 2.5,
};

const next = <T>(list: readonly T[], v: T): T => list[(list.indexOf(v) + 1) % list.length];

/** Anfrage an den Kern (Werkzeug-Vorgaben). */
export const treeReq = () => ({ cmd: "tree", ...treeDefaults });

const appendTree = (at: Vec2, ctx: CommandContext) => createMutation(ctx, { ...treeReq(), at: xy(at) });

interface TreeState extends CommandState {
  phase: "place" | "done";
}

const finish = (): [CommandState, CommandResult] => [{ phase: "done", lastPoint: null } as TreeState, { draft: null, done: true }];

function previewAt(pt: Vec2, ctx: CommandContext): CommandResult {
  return {
    draft: {
      preview: createPreview(ctx, treeReq(), [pt]).shapes,
      vertices: [],
      hud: { at: pt, text: `Ø${treeDefaults.crownDiameter.toFixed(1)} m · ${treeDefaults.height.toFixed(1)} m` },
    },
  };
}

export const treeCommand: Command = {
  name: "tree",
  labelKey: "cmd.tree.label",
  prompt: () => "cmd.tree.place",
  accepts: () => ["point", "number", "option"],
  options: (): CmdOption[] => [
    { id: "shape", labelKey: "cmd.tree.shape", value: t(`objinfo.tree.shape.${treeDefaults.shape}` as TranslationKey) },
    { id: "status", labelKey: "cmd.tree.status", value: t(`objinfo.tree.status.${treeDefaults.status}` as TranslationKey) },
    { id: "foliage", labelKey: "cmd.tree.foliage", value: t(`objinfo.tree.foliage.${treeDefaults.foliage}` as TranslationKey) },
  ],
  floorOnly: true,

  init: (): TreeState => ({ phase: "place", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as TreeState;
    if (s.phase === "done") return finish();
    if (input.kind === "number") {
      const v = Math.abs(input.value);
      if (v > 0.1 && Number.isFinite(v)) treeDefaults.crownDiameter = v;
      return [s, { draft: null }];
    }
    if (input.kind === "option") {
      if (input.id === "shape") treeDefaults.shape = next(SHAPES, treeDefaults.shape);
      if (input.id === "status") treeDefaults.status = next(STATUS, treeDefaults.status);
      if (input.id === "foliage") {
        treeDefaults.foliage = next(FOLIAGE, treeDefaults.foliage);
        // Nadelbaum meist kegelförmig, Laubbaum rund (Form bleibt danach frei wählbar).
        treeDefaults.shape = treeDefaults.foliage === "conifer" ? "conical" : "round";
      }
      return [s, { draft: null }];
    }
    if (input.kind === "point") {
      // Mehrere Bäume nacheinander: der Befehl bleibt in der Setz-Phase.
      return [s, { draft: null, commit: appendTree(input.point, ctx) }];
    }
    return [s, { draft: null }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as TreeState;
    if (s.phase !== "place") return [s, { draft: null }];
    return [s, previewAt(point, ctx)];
  },

  onConfirm: (): [CommandState, CommandResult] => finish(),
  onCancel: (): [CommandState, CommandResult] => finish(),
};

/** [149] „Kreise in Bäume umwandeln": gewählte Kreise, sonst alle Kreise der Baum-Ebene im aktiven Geschoss. */
export const circlesToTreesCommand: Command = {
  name: "circlestotrees",
  labelKey: "cmd.circlestotrees.label",
  prompt: () => "cmd.circlestotrees.label",
  accepts: () => [],
  options: () => [],
  floorOnly: true,
  init: (): CommandState => ({ phase: "idle", lastPoint: null }),
  autoRun: (ctx: CommandContext): CommandResult => {
    const ids = ctx.selection.drawingIds?.length ? ctx.selection.drawingIds : ctx.selection.drawingId ? [ctx.selection.drawingId] : [];
    return { draft: null, done: true, commit: createMutation(ctx, { cmd: "circlesToTrees", ids }) };
  },
  onInput: (): [CommandState, CommandResult] => finish(),
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => finish(),
  onCancel: (): [CommandState, CommandResult] => finish(),
};
