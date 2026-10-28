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
import type { DrawingLevel, DrawingLevelKind } from "../../model/types";
import { leftNormal, normalize, sub } from "../../model/geometry";
import { addItems, opsMutation, patchItem } from "../../core";
import type { CoreOp } from "../../core";
import type {
  Command,
  CommandResult,
  CommandState,
  CmdOption,
  DraftShape,
  Project,
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
 * Richtungspfeil-Vorschau: kurze Linie vom Mittelpunkt der Schnittlinie entlang
 * der Blicknormalen (leftNormal der Linie, per directionSign gedreht) plus zwei
 * Flügel-Segmente — zeigt, wohin der Schnitt „blickt".
 */
function directionArrow(a: Vec2, b: Vec2, sign: 1 | -1): DraftShape[] {
  const dir = sub(b, a);
  const len = Math.hypot(dir.x, dir.y);
  if (len < 1e-6) return [];
  const u = normalize(dir);
  const n = leftNormal(u); // (-uy, ux)
  const nx = n.x * sign;
  const ny = n.y * sign;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  // Pfeillänge ~ min(1 m, Viertel der Linienlänge), damit die Vorschau lesbar bleibt.
  const arrowLen = Math.min(1, len / 4);
  const tip = { x: mid.x + nx * arrowLen, y: mid.y + ny * arrowLen };
  const wing = arrowLen * 0.35;
  // Flügel: vom Spitzenpunkt zurück, je halb entlang −u und +u geneigt.
  const back = { x: tip.x - nx * wing * 2, y: tip.y - ny * wing * 2 };
  const w1 = { x: back.x + u.x * wing, y: back.y + u.y * wing };
  const w2 = { x: back.x - u.x * wing, y: back.y - u.y * wing };
  return [
    { kind: "line", a: mid, b: tip },
    { kind: "line", a: tip, b: w1 },
    { kind: "line", a: tip, b: w2 },
  ];
}

/** Vorschau: Schnittlinie + Richtungspfeil + Länge im HUD. */
function lineDraft(a: Vec2, cursor: Vec2 | null, sign: 1 | -1): ToolDraft {
  if (!cursor) return { preview: [{ kind: "poly", pts: [a] }], vertices: [a] };
  const preview: DraftShape[] = [
    { kind: "line", a, b: cursor },
    ...directionArrow(a, cursor, sign),
  ];
  const draft: ToolDraft = { preview, vertices: [a] };
  draft.hud = {
    at: cursor,
    text: `${Math.hypot(cursor.x - a.x, cursor.y - a.y).toFixed(2)} m`,
  };
  return draft;
}

/** Nächster freier Ebenen-Name der Art (A, B, C … über die Anzahl bestehender). */
function nextLevelName(p: Project, kind: LineKind): string {
  const count = p.drawingLevels.filter((z) => z.kind === kind).length;
  // Buchstaben-Suffix (A, B, …, Z, dann AA…) — klassische Schnitt-Benennung.
  let n = count;
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  const key = kind === "section" ? "cmd.sectionline.newSection" : "cmd.sectionline.newElevation";
  return t(key, { letter: letters });
}

/**
 * Setzt die Schnittlinie [a, b] auf die Ziel-Ebene (immutabel). Existiert GENAU
 * EINE Ebene der Art ohne Linie, wird sie belegt; sonst wird eine neue angelegt.
 * Entartete (zu kurze) Linien werden verworfen.
 */
function lineOps(p: Project, a: Vec2, b: Vec2, kind: LineKind): CoreOp[] {
  if (Math.hypot(b.x - a.x, b.y - a.y) < 0.1) return [];
  const line: [Vec2, Vec2] = [a, b];
  const orphans = p.drawingLevels.filter((z) => z.kind === kind && !z.linePoints);
  if (orphans.length === 1) {
    return patchItem(p, "drawingLevels", orphans[0].id, (z) => ({ ...z, linePoints: line, directionSign: z.directionSign ?? 1 }));
  }
  const level: DrawingLevel = {
    id: `${kind}-${Date.now()}`,
    name: nextLevelName(p, kind),
    kind: kind as DrawingLevelKind,
    visible: true,
    locked: false,
    linePoints: line,
    directionSign: 1,
  };
  return addItems("drawingLevels", [level]);
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

const DIRECTION_SIGN: 1 = 1;

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

    onInput: (state, input): [CommandState, CommandResult] => {
      const s = state as LineState;
      if (input.kind === "option" && KIND_IDS.has(input.id)) {
        const ns = { ...s, kind: input.id as LineKind } as LineState;
        const draft =
          ns.phase === "end" ? lineDraft(ns.a, ns.cursor, DIRECTION_SIGN) : null;
        return [ns, { draft }];
      }
      if (input.kind !== "point") {
        return [
          s,
          { draft: s.phase === "end" ? lineDraft(s.a, s.cursor, DIRECTION_SIGN) : null },
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
        return [ns, { draft: lineDraft(input.point, input.point, DIRECTION_SIGN) }];
      }
      const a = s.a;
      const b = input.point;
      const kind = s.kind;
      return [
        { phase: "start", kind, lastPoint: null } as LineIdle,
        { draft: null, done: true, commit: opsMutation((p) => lineOps(p, a, b, kind)) },
      ];
    },

    onMove: (state, point): [CommandState, CommandResult] => {
      const s = state as LineState;
      if (s.phase !== "end") return [s, { draft: null }];
      const ns: LineEnd = { ...s, cursor: point };
      return [ns, { draft: lineDraft(s.a, point, DIRECTION_SIGN) }];
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
export const _test = { lineOps, nextLevelName, directionArrow };
