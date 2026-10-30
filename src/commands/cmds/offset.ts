// Offset — DAS Architektur-Primitiv (auch für Wände, [113]) (docs §2.10/§3.4 Tier-1, §3.6 persistente
// Distanz). Erzeugt eine parallel versetzte Kopie einer 2D-Kurve (line/polyline/
// rect). Schritte:
//   1) Kurve bestimmen: ist genau EIN passendes Drawing2D (line/polyline/rect)
//      selektiert, wird es genommen; sonst „Kurve wählen:" → Klick auf eine Kurve.
//   2) „Seite/Distanz:" → Distanz tippen (PERSISTENT als Default über Aufrufe,
//      modulweite Variable) ODER Seite per Klick (Vorzeichen aus der Klickseite
//      relativ zur Kurve). → commit neue versetzte Drawing2D-Kurve.
//
// Distanz-Vorzeichen: Konvention `+d = links` (kernel2d/leftNormal). Die
// Klickseite bestimmt links/rechts: liegt der Klick links der Kurve (bzw. der
// nächsten Kante), wird +|d| genommen, sonst −|d|. Eine getippte Zahl nutzt das
// Vorzeichen der zuletzt gewählten Seite (Default links/+), bzw. ihr eigenes
// Vorzeichen, wenn negativ getippt.

//
// Treffer, Seite, versetzte Geometrie und Vorschau rechnet der Kern (`src-tauri/core/src/cmd_edit.rs`,
// [K4] S3, Geometrie `offsetSegment`/`offsetPolyline`/`offsetPolylineWithBulge` in `kernel2d`; Bögen
// bleiben konzentrisch); hier der Zustandsautomat und die persistente Distanz/Seite.

import type { Drawing2D } from "../../model/types";
import { uniqueStamp } from "../../tools/types";
import type {
  CmdInput,
  Command,
  CommandContext,
  CommandResult,
  CommandSelection,
  CommandState,
  Project,
  Vec2,
} from "../types";
import { cmdMutation } from "../../core";
import { cmdQuery, decodeShapes, pair } from "../../tools/coreCmd";

const EPS = 1e-6;

/**
 * Persistente Offset-Distanz über Aufrufe hinweg (§2.4/§3.6 — Nutzer erwarten,
 * dass die letzte Distanz als Default wiederkommt). Modulweite Variable, |d|;
 * das Vorzeichen (Seite) wird je Offset frisch aus Klick/Eingabe bestimmt.
 */
let lastDistance = 0.5;
/** Zuletzt gewählte Seite als Vorzeichen (+1 = links, −1 = rechts). */
let lastSign = 1;

/** Ist diese Form offset-fähig (line/polyline/rect)? */
function isOffsetable(d: Drawing2D): boolean {
  const g = d.geom;
  return g.shape === "line" || g.shape === "polyline" || g.shape === "rect";
}

/**
 * Genau ein passendes Element vorselektiert? Dann liefere seine id: ein offset-fähiges Drawing2D oder
 * genau eine Wand ([113]: parallele, bei Bogenwänden konzentrische Kopie im Achsabstand).
 */
function singleSelectedCurve(project: Project, sel: CommandSelection): { id: string } | null {
  if (!sel.drawingId && sel.wallIds.length === 1) {
    const w = project.walls.find((x) => x.id === sel.wallIds[0]);
    return w && !w.locked ? { id: w.id } : null;
  }
  if (!sel.drawingId || sel.wallIds.length > 0) return null;
  const d = project.drawings2d.find((x) => x.id === sel.drawingId);
  if (d && isOffsetable(d)) return d;
  return null;
}

/** Gibt es die Kurve (oder Wand) noch (Side-Zustand)? */
function hasCurve(project: Project, drawingId: string): boolean {
  if (project.walls.some((w) => w.id === drawingId)) return true;
  const src = project.drawings2d.find((x) => x.id === drawingId);
  return !!src && isOffsetable(src);
}

/** Seite (+1 links / −1 rechts) des Punkts zur Kurve und ggf. die Vorschau mit Betrag `dist` (Kern). */
function sideOf(project: Project, drawingId: string, pt: Vec2, dist?: number): { sign: number; shapes: number[] } {
  return cmdQuery<{ sign: number; shapes: number[] }>(project, { q: "offset", id: drawingId, pt: pair(pt), lastSign, ...(dist !== undefined ? { dist } : {}) });
}

/** Versetzte Kopie der Kurve um die vorzeichenbehaftete Distanz `d` anhängen. */
const appendOffset = (drawingId: string, d: number) => cmdMutation({ cmd: "offset", id: drawingId, d, stamp: uniqueStamp() });

// ── Zustand ───────────────────────────────────────────────────────────────────

// „pick": Kurve wählen (keine passende Vorselektion). „side": Kurve steht fest,
// jetzt Seite/Distanz. „done": Befehl beendet.
interface OffPick extends CommandState {
  phase: "pick";
}
interface OffSide extends CommandState {
  phase: "side";
  drawingId: string;
  cursor: Vec2 | null;
}
interface OffDone extends CommandState {
  phase: "done";
}
type OffState = OffPick | OffSide | OffDone;

const finish = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as OffDone,
  { draft: null, done: true },
];

export const offsetCommand: Command = {
  name: "offset",
  labelKey: "cmd.offset.label",
  prompt: (s) => {
    const os = s as OffState;
    if (os.phase === "side") return "cmd.offset.side";
    return "cmd.offset.pick";
  },
  // Side-Schritt: Punkt (Seite klicken) ODER Zahl (Distanz tippen). Auch der
  // „pick"-Schritt nimmt eine Zahl an, damit eine getippte Distanz sofort greift,
  // wenn eine Kurve vorselektiert ist (dann wird „pick" live wie „side" behandelt).
  accepts: () => ["point", "number"],
  options: () => [],

  // init() kennt den Kontext nicht; die Vorselektion wird im ersten onMove/
  // onInput ausgewertet (geht direkt auf „side", wenn genau eine Kurve gewählt
  // ist). Bis dahin „pick".
  init: (): OffPick => ({ phase: "pick", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as OffState;
    if (s.phase === "done") return finish();

    // Vorselektion: gibt es genau eine passende Kurve, direkt in den Side-Schritt
    // springen (auch wenn die Engine erst onInput aufruft).
    if (s.phase === "pick") {
      const pre = singleSelectedCurve(ctx.project, ctx.selection);
      if (pre) {
        // Eingabe im selben Schritt direkt als Side/Distanz behandeln.
        return offsetSideInput(
          { phase: "side", drawingId: pre.id, cursor: null, lastPoint: null },
          input,
          ctx,
        );
      }
      // Keine Vorselektion → Kurve per Klick wählen.
      if (input.kind === "point") {
        const hit = cmdQuery<{ hit: string | null }>(ctx.project, { q: "pickCurve", level: ctx.level.id, pt: pair(input.point) }).hit;
        if (!hit) return [s, { draft: null }];
        const ns: OffSide = { phase: "side", drawingId: hit, cursor: null, lastPoint: null };
        return [ns, { draft: null }];
      }
      return [s, { draft: null }];
    }

    // phase === "side"
    return offsetSideInput(s as OffSide, input, ctx);
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as OffState;
    // Vorselektion live: in „pick" mit genau einer Kurve → als Side behandeln.
    if (s.phase === "pick") {
      const pre = singleSelectedCurve(ctx.project, ctx.selection);
      if (pre) {
        return offsetSideMove({ phase: "side", drawingId: pre.id, cursor: point, lastPoint: null }, point, ctx);
      }
      return [s, { draft: null }];
    }
    if (s.phase === "side") return offsetSideMove(s as OffSide, point, ctx);
    return [s, { draft: null }];
  },

  onConfirm: (): [CommandState, CommandResult] => finish(),
  onCancel: (): [CommandState, CommandResult] => finish(),

  // KEIN Tab-Feld-Zyklus: die Offset-Distanz ist ein reiner Skalar, der als
  // `number`-Eingabe in den Schritt läuft (nicht als feld-erzeugter Punkt). So
  // committet eine getippte Distanz direkt; die Seite kommt per Klick/Vorzeichen.
};

// ── Side-Schritt-Logik (für Vorselektion UND echten pick wiederverwendet) ─────

/** Eingabe im Side-Schritt: Punkt (Seite klicken) ODER Zahl (Distanz tippen). */
function offsetSideInput(
  s: OffSide,
  input: CmdInput,
  ctx: CommandContext,
): [CommandState, CommandResult] {
  if (!hasCurve(ctx.project, s.drawingId)) return finish();

  if (input.kind === "number") {
    // Getippte Distanz: Betrag merken; Vorzeichen aus der zuletzt gewählten
    // Seite (bzw. dem getippten Vorzeichen, falls negativ).
    const typed = input.value;
    const mag = Math.abs(typed);
    if (mag < EPS) return [s, { draft: null }];
    lastDistance = mag;
    const sign = typed < 0 ? -1 : lastSign;
    lastSign = sign;
    const d = sign * mag;
    return [
      { phase: "done", lastPoint: null } as OffDone,
      { draft: null, done: true, commit: appendOffset(s.drawingId, d) },
    ];
  }

  if (input.kind === "point") {
    // Seite per Klick: Vorzeichen aus der Klickseite, Betrag = letzte Distanz.
    const sign = sideOf(ctx.project, s.drawingId, input.point).sign;
    lastSign = sign;
    const d = sign * lastDistance;
    return [
      { phase: "done", lastPoint: null } as OffDone,
      { draft: null, done: true, commit: appendOffset(s.drawingId, d) },
    ];
  }

  return [s, { draft: null }];
}

/** Hover im Side-Schritt: Vorschau der versetzten Kurve an der Cursor-Seite. */
function offsetSideMove(
  s: OffSide,
  point: Vec2,
  ctx: CommandContext,
): [CommandState, CommandResult] {
  if (!hasCurve(ctx.project, s.drawingId)) return [s, { draft: null }];
  const preview = decodeShapes(sideOf(ctx.project, s.drawingId, point, lastDistance).shapes);
  const ns: OffSide = { ...s, cursor: point };
  return [
    ns,
    {
      draft: {
        preview,
        vertices: [],
        hud: { at: point, text: `${lastDistance.toFixed(2)} m` },
      },
    },
  ];
}
