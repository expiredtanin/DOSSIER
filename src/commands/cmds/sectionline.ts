// Schnittlinie — setzt die Grundriss-Schnitt-/Ansichtslinie einer Zeichnungsebene
// (DrawingLevel, kind "section"/"elevation") per zwei Klicks (Start → Ende). Die
// Linie steuert `sectionPlaneFromLevel` (plan/toSection.ts): senkrecht auf ihr
// steht die Blickrichtung (directionSign, Voreinstellung +1).
//
// Schritte:
//   1) „Schnitt-Startpunkt:" → Punkt
//   2) „Schnitt-Endpunkt:"   → Live-Linie + Richtungspfeil; Klick committet.
//
// Ziel-Ebene (im Commit bestimmt): existiert GENAU EINE Ebene der gewählten Art
// OHNE gesetzte Linie (frisch angelegter Platzhalter), wird deren Linie gesetzt;
// sonst wird eine NEUE Ebene angelegt (Name „Schnitt B/C…" bzw. „Ansicht …").
//
// Die Art (Schnitt/Ansicht) ist als Inline-Option umschaltbar — dieselbe Mechanik
// für beide, nur `kind` unterscheidet sich (Alias `viewline` startet mit
// „elevation"). Bezeichner englisch, sichtbarer Text via t().

import { t } from "../../i18n";
import { createMutation, createPreview } from "../createCore";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  CmdOption,
  ToolDraft,
  Vec2,
} from "../types";

/** Nur Schnitt/Ansicht tragen eine Linie. */
type LineKind = "section" | "elevation";

/** Wählbare Art (Inline-Optionen der Befehlszeile). */
const KIND_OPTIONS: CmdOption[] = [
  { id: "section", labelKey: "cmd.sectionline.kind.section" },
  { id: "elevation", labelKey: "cmd.sectionline.kind.elevation" },
];
const KIND_IDS = new Set(KIND_OPTIONS.map((o) => o.id));

/**
 * Vorschau: Schnittlinie + Richtungspfeil (Kern, `cmd_solid.rs`: vom Mittelpunkt entlang der
 * Blicknormalen, zwei Flügel) + Länge im HUD.
 */
function lineDraft(ctx: CommandContext, a: Vec2, cursor: Vec2 | null): ToolDraft {
  if (!cursor) return { preview: [{ kind: "poly", pts: [a] }], vertices: [a] };
  const draft: ToolDraft = { preview: createPreview(ctx, { cmd: "sectionline" }, [a, cursor]).shapes, vertices: [a] };
  draft.hud = {
    at: cursor,
    text: `${Math.hypot(cursor.x - a.x, cursor.y - a.y).toFixed(2)} m`,
  };
  return draft;
}

/**
 * Commit (Kern): Linie [a, b] auf die EINE Ebene der Art ohne Linie, sonst eine neue Ebene (Name aus der
 * Vorlage, Buchstaben A, B, … nach Anzahl der Ebenen dieser Art); zu kurze Linien (< 0.1 m) → nichts.
 */
function lineMutation(ctx: CommandContext, a: Vec2, b: Vec2, kind: LineKind) {
  const key = kind === "section" ? "cmd.sectionline.newSection" : "cmd.sectionline.newElevation";
  return createMutation(ctx, { cmd: "sectionline", a, b, kind, name: t(key, { letter: "\u0001" }) });
}

interface LineIdle extends CommandState {
  phase: "start";
  kind: LineKind;
}
interface LineEnd extends CommandState {
  phase: "end";
  a: Vec2;
  cursor: Vec2 | null;
  kind: LineKind;
}
type LineState = LineIdle | LineEnd;

function makeCommand(name: string, startKind: LineKind): Command {
  const idle = (kind: LineKind): [CommandState, CommandResult] => [
    { phase: "start", kind, lastPoint: null } as LineIdle,
    { draft: null, done: true },
  ];
  return {
    name,
    labelKey: "cmd.sectionline.label",
    // Nicht floorOnly: eine Schnittlinie zieht man IM Grundriss, wo Bauteile
    // liegen — die aktive Ebene ist dann ein Geschoss. Aber der Befehl soll auch
    // auf freien Zeichnungsebenen nutzbar bleiben; die Prüfung übernimmt der
    // Grundriss-Kontext (keine harte Sperre nötig).
    floorOnly: true,
    prompt: (s) => ((s as LineState).phase === "end" ? "cmd.sectionline.end" : "cmd.sectionline.start"),
    accepts: () => ["point", "option"],
    options: () => KIND_OPTIONS,
    init: (): LineIdle => ({ phase: "start", kind: startKind, lastPoint: null }),

    onInput: (state, input, ctx): [CommandState, CommandResult] => {
      const s = state as LineState;
      if (input.kind === "option" && KIND_IDS.has(input.id)) {
        const ns = { ...s, kind: input.id as LineKind } as LineState;
        const draft =
          ns.phase === "end" ? lineDraft(ctx, ns.a, ns.cursor) : null;
        return [ns, { draft }];
      }
      if (input.kind !== "point") {
        return [
          s,
          { draft: s.phase === "end" ? lineDraft(ctx, s.a, s.cursor) : null },
        ];
      }
      if (s.phase !== "end") {
        const ns: LineEnd = {
          phase: "end",
          a: input.point,
          cursor: input.point,
          kind: s.kind,
          lastPoint: input.point,
        };
        return [ns, { draft: lineDraft(ctx, input.point, input.point) }];
      }
      const a = s.a;
      const b = input.point;
      const kind = s.kind;
      return [
        { phase: "start", kind, lastPoint: null } as LineIdle,
        { draft: null, done: true, commit: lineMutation(ctx, a, b, kind) },
      ];
    },

    onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
      const s = state as LineState;
      if (s.phase !== "end") return [s, { draft: null }];
      const ns: LineEnd = { ...s, cursor: point };
      return [ns, { draft: lineDraft(ctx, s.a, point) }];
    },

    onConfirm: (state): [CommandState, CommandResult] => idle((state as LineState).kind),
    onCancel: (state): [CommandState, CommandResult] => idle((state as LineState).kind),
  };
}

/** Schnittlinie (startet als „section"). */
export const sectionLineCommand: Command = makeCommand("sectionline", "section");
/** Ansichtslinie (startet als „elevation"; identische Mechanik). */
export const viewLineCommand: Command = makeCommand("viewline", "elevation");

// Für Tests: die reinen Datenpfad-Helfer.
