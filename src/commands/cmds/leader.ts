// Leader (Legenden-/Vorführungspfeil) — wie `text`, aber mit vorangestelltem
// Zielpunkt UND optionalen Knickpunkten dazwischen (Nutzer-Wunsch: „Hinweis-
// linie hat nur EIN Segment, kein Knick-Punkt wie bei AutoCADs Multileader").
// Anzahl Knicke über die Option „Knicke" (klickbar im Feld-Row, tippbar als
// „k", zyklisch 0..4 — Default 0 = EXAKT das bisherige Verhalten, zwei Klicks,
// keine Verhaltensänderung für den Normalfall).
//
//   1) „Zielpunkt:"        → Punkt (Pfeilspitze, zeigt auf das referenzierte Detail)
//   2) „Knick N/M:"        → Punkt, je Knick EINMAL (nur wenn „Knicke" > 0)
//   3) „Textanker:"        → Punkt (Textposition)
//   Committet SOFORT ein leeres Text-Element mit `leaderTarget` (+ ggf.
//   `leaderBendPoints`) gesetzt und meldet `focusDrawingId` — dieselbe
//   Inline-Editor-Infrastruktur wie beim `text`-Befehl (kein neuer Shape,
//   s. `Drawing2DGeom["text"].leaderTarget`/`.leaderBendPoints`).

import { uniqueId } from "../../tools/types";
import type {
  CmdOption,
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  DraftShape,
  ToolDraft,
  Vec2,
} from "../types";
import type { TranslationKey } from "../../i18n";
import { createMutation } from "../createCore";

const MAX_BENDS = 4;

/** Persistente Knick-Anzahl über Aufrufe hinweg (wie `lastCount` bei Array). */
let lastBendCount = 0;

const BEND_OPTION: CmdOption = { id: "bends", labelKey: "cmd.leader.bends" };

interface LeaderTarget extends CommandState {
  phase: "target";
}
interface LeaderBend extends CommandState {
  phase: "bend";
  target: Vec2;
  bends: Vec2[];
  cursor: Vec2 | null;
}
interface LeaderAnchor extends CommandState {
  phase: "anchor";
  target: Vec2;
  bends: Vec2[];
  cursor: Vec2 | null;
}
type LeaderState = LeaderTarget | LeaderBend | LeaderAnchor;

/** Commit (Kern, `cmd_draw.rs`): leerer Text am Anker mit Hinweislinie zum Ziel (Knickpunkte, falls gesetzt). */
const appendLeaderText = (id: string, at: Vec2, target: Vec2, bends: Vec2[], ctx: CommandContext) =>
  createMutation(ctx, { cmd: "leader", id, at, target, bends });

const idle = (): [CommandState, CommandResult] => [
  { phase: "target", lastPoint: null } as LeaderTarget,
  { draft: null, done: true },
];

/** Vorschau: der bisherige Pfad (Zielpunkt → platzierte Knicke) + Gummiband zum Cursor. */
function pathDraft(target: Vec2, bends: Vec2[], cursor: Vec2 | null): ToolDraft {
  const pts = [target, ...bends, ...(cursor ? [cursor] : [])];
  if (pts.length < 2) return { preview: [], vertices: [target] };
  const preview: DraftShape[] = [{ kind: "poly", pts, closed: false }];
  return { preview, vertices: [target] };
}

function promptKey(s: LeaderState): TranslationKey {
  if (s.phase === "bend") return "cmd.leader.bend";
  if (s.phase === "anchor") return "cmd.leader.anchor";
  return "cmd.leader.target";
}

export const leaderCommand: Command = {
  name: "leader",
  labelKey: "cmd.leader.label",
  prompt: (s) => promptKey(s as LeaderState),
  accepts: () => ["point", "option"],
  options: () => [{ ...BEND_OPTION, value: String(lastBendCount) }],
  init: (): LeaderTarget => ({ phase: "target", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as LeaderState;

    if (input.kind === "option") {
      if (input.id === "bends") lastBendCount = (lastBendCount + 1) % (MAX_BENDS + 1);
      return [s, { draft: null }];
    }
    if (input.kind !== "point") return [s, { draft: null }];
    const pt = input.point;

    if (s.phase === "target") {
      if (lastBendCount > 0) {
        const next: LeaderBend = { phase: "bend", target: pt, bends: [], cursor: pt, lastPoint: pt };
        return [next, { draft: pathDraft(pt, [], pt) }];
      }
      const next: LeaderAnchor = { phase: "anchor", target: pt, bends: [], cursor: pt, lastPoint: pt };
      return [next, { draft: pathDraft(pt, [], pt) }];
    }

    if (s.phase === "bend") {
      const bends = [...s.bends, pt];
      if (bends.length < lastBendCount) {
        const next: LeaderBend = { phase: "bend", target: s.target, bends, cursor: pt, lastPoint: pt };
        return [next, { draft: pathDraft(s.target, bends, pt) }];
      }
      const next: LeaderAnchor = { phase: "anchor", target: s.target, bends, cursor: pt, lastPoint: pt };
      return [next, { draft: pathDraft(s.target, bends, pt) }];
    }

    // phase "anchor": Textposition setzen, Leader committen.
    const id = uniqueId("dr2d");
    const { target, bends } = s;
    return [
      idle()[0],
      {
        draft: null,
        done: true,
        commit: appendLeaderText(id, pt, target, bends, ctx),
        focusDrawingId: id,
      },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as LeaderState;
    if (s.phase === "target") return [s, { draft: null }];
    return [{ ...s, cursor: point } as LeaderState, { draft: pathDraft(s.target, s.bends, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
