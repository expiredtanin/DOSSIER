// Raum (Room / SIA-416-Fläche) als Engine-Befehl. Zwei Modi (togglebar über die
// Option „Modus"):
//
//   1) „innen" (Default) — EIN Klick IN einen von Wänden umschlossenen Bereich.
//      Der Umriss wird über den reinen Rechenkern (geometry/roomBoundary,
//      `roomFromPointInside`) aus den Wänden des aktiven Geschosses automatisch
//      als lichte Innenkontur erkannt. Findet der Klick keine geschlossene Zelle,
//      passiert nichts (der Nutzer kann in den Manuell-Modus wechseln).
//
//   2) „manuell" — ein GESCHLOSSENER Umriss wird Punkt für Punkt gezeichnet
//      (wie eine geschlossene Polylinie); Klick auf den Start / Option „Schliessen"
//      / Enter (≥3 Punkte) committet den Raum.
//
// Der committete Raum bekommt SIA-Blatt HNF, einen Default-Namen und die
// Kategorie „45 Räume" (Fallback: aktive Kategorie). Fläche/Umfang/Schwerpunkt
// werden NICHT gespeichert (bei jedem Rendern aus `boundary` abgeleitet).
//
// Bezeichner englisch, sichtbarer Text via t() (CONVENTIONS.md). Einheit: METER.

import type { Room } from "../../model/types";
import { wallTypeThickness } from "../../model/types";
import { roomFromPointInside, type WallSegment } from "../../core";
import { polygonArea, centroid } from "../../core";
import { docFromText } from "../../text/richText";
import { uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  CmdOption,
  DraftShape,
  ToolDraft,
  Vec2,
} from "../types";
import { addItems, opsMutation } from "../../core";
import type { CoreOp } from "../../core";

const EPS = 1e-6;
const DEG = Math.PI / 180;
const CLOSE_HIT = 0.08; // Modell-Meter: Klick nahe Startpunkt schließt den Umriss
/** Default-Ebene (Kategorie) für Räume: „60" Räume (Fallback: aktive). */
const ROOM_CATEGORY = "60";
/** Default-Raumfarbe (falls Kategorie nicht auflösbar). */
const ROOM_COLOR = "#5a7a9a";

const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/** Existiert die Raum-Kategorie („45")? Sonst Fallback auf die aktive Kategorie. */
function roomCategory(ctx: CommandContext): string {
  const flat: { code: string }[] = [];
  const walk = (list: { code: string; children?: unknown[] }[]) => {
    for (const c of list) {
      flat.push({ code: c.code });
      if (c.children) walk(c.children as { code: string; children?: unknown[] }[]);
    }
  };
  walk(ctx.project.layers as { code: string; children?: unknown[] }[]);
  return flat.some((c) => c.code === ROOM_CATEGORY)
    ? ROOM_CATEGORY
    : ctx.defaultCategoryCode;
}

/** Farbe der Raum-Kategorie (Ebene) — sonst Default. */
function roomColor(ctx: CommandContext, code: string): string {
  const flat: { code: string; color?: string; children?: unknown[] }[] = [];
  const walk = (list: { code: string; color?: string; children?: unknown[] }[]) => {
    for (const c of list) {
      flat.push(c);
      if (c.children)
        walk(
          c.children as {
            code: string;
            color?: string;
            children?: unknown[];
          }[],
        );
    }
  };
  walk(
    ctx.project.layers as {
      code: string;
      color?: string;
      children?: unknown[];
    }[],
  );
  return flat.find((c) => c.code === code)?.color ?? ROOM_COLOR;
}

/**
 * Wände des aktiven Geschosses in die vom Rechenkern erwartete Form bringen:
 * Mittellinie (start→end) + Gesamtdicke des Wandtyps. Grafik-2D-Geometrie und
 * andere Geschosse bleiben außen vor.
 */
function wallsOfFloor(ctx: CommandContext): WallSegment[] {
  const { project, level } = ctx;
  const out: WallSegment[] = [];
  for (const w of project.walls) {
    if (w.floorId !== level.id) continue;
    const wt = project.wallTypes.find((t) => t.id === w.wallTypeId);
    const thickness = wt ? wallTypeThickness(wt) : 0.2;
    out.push({ a: w.start, b: w.end, thickness });
  }
  return out;
}

/** Baut einen Raum aus einem fertigen Umriss (immutabel; keine abgeleiteten Felder). */
function buildRoom(ctx: CommandContext, boundary: Vec2[]): Room {
  const code = roomCategory(ctx);
  const name = defaultRoomName(ctx);
  return {
    id: uniqueId("RM"),
    type: "room",
    floorId: ctx.level.id,
    categoryCode: code,
    siaCategory: "HNF",
    name,
    boundary,
    color: roomColor(ctx, code),
    // Stempel-Anker EINMALIG auf den Zentroid setzen (danach frei verschiebbar,
    // bleibt beim Ändern der Kontur an seiner Stelle).
    stampAnchor: centroid(boundary),
    // Frei editierbarer Stempel-Text: ein zentrierter Absatz mit dem Raumnamen.
    stampDoc: { ...docFromText(name), paragraphs: docFromText(name).paragraphs.map((p) => ({ ...p, align: "center" as const })) },
  };
}

/** Fortlaufender Default-Name „Raum N" (N = Anzahl vorhandener Räume + 1). */
function defaultRoomName(ctx: CommandContext): string {
  const n = (ctx.project.rooms ?? []).length + 1;
  return `Raum ${n}`;
}

/** Hängt einen Raum ans Projekt (immutabel); entartete Umrisse werden verworfen. */
function appendRoom(boundary: Vec2[], ctx: CommandContext): CoreOp[] {
  if (boundary.length < 3 || polygonArea(boundary) < 1e-4) return [];
  const room = buildRoom(ctx, boundary);
  return addItems("rooms", [room]);
}

// ── Zustand ──────────────────────────────────────────────────────────────────

type RoomMode = "inside" | "manual";

interface RoomIdle extends CommandState {
  phase: "start";
  mode: RoomMode;
}
interface RoomDrawing extends CommandState {
  phase: "draw";
  mode: RoomMode;
  points: Vec2[];
  cursor: Vec2 | null;
}
type RoomCmdState = RoomIdle | RoomDrawing;

const MODE: CmdOption = { id: "mode", labelKey: "cmd.room.mode", value: "inside" };
const CLOSE: CmdOption = { id: "close", labelKey: "cmd.polyline.close" };
const UNDO: CmdOption = { id: "undo", labelKey: "cmd.polyline.undo" };

/** Tab-Felder je weiteren Punkt (Manuell-Modus): Länge + Winkel relativ zum letzten. */
const ROOM_FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];

function nextFromFields(
  last: Vec2,
  locks: Record<string, number>,
  cursor: Vec2 | null,
): Vec2 {
  const ref = cursor ?? last;
  const length = "length" in locks ? locks.length : segLen(last, ref);
  const angleDeg = "angle" in locks ? locks.angle : segAngleDeg(last, ref);
  const ang = angleDeg * DEG;
  return { x: last.x + Math.cos(ang) * length, y: last.y + Math.sin(ang) * length };
}

/** Vorschau des manuellen Umrisses (geschlossener Ring ab 3 Punkten) + HUD. */
function manualDraft(points: Vec2[], cursor: Vec2 | null): ToolDraft {
  const pts = cursor ? [...points, cursor] : points;
  const showClosed = pts.length >= 3;
  const preview: DraftShape[] = [{ kind: "poly", pts, closed: showClosed }];
  const draft: ToolDraft = { preview, vertices: points };
  const last = points[points.length - 1];
  if (cursor && last && segLen(last, cursor) >= EPS) {
    draft.hud = {
      at: cursor,
      text: `${segLen(last, cursor).toFixed(2)} m · ${Math.abs(
        (segAngleDeg(last, cursor) + 360) % 360,
      ).toFixed(0)}°`,
    };
  }
  return draft;
}

const idle = (mode: RoomMode): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null, mode } as RoomIdle,
  { draft: null, done: true },
];

export const roomCommand: Command = {
  name: "room",
  labelKey: "cmd.room.label",
  // Räume leben auf Geschossen — wie Wand/Decke nur dort aktiv.
  floorOnly: true,
  prompt: (s) => {
    const st = s as RoomCmdState;
    if (st.phase === "draw") return "cmd.room.next";
    return st.mode === "inside" ? "cmd.room.inside" : "cmd.room.first";
  },
  accepts: (s) =>
    (s as RoomCmdState).phase === "draw"
      ? ["point", "number", "option"]
      : ["point", "option"],
  options: (s): CmdOption[] => {
    const st = s as RoomCmdState;
    const modeOpt: CmdOption = { ...MODE, value: st.mode };
    if (st.phase !== "draw") return [modeOpt];
    return st.points.length >= 3 ? [modeOpt, CLOSE, UNDO] : [modeOpt, UNDO];
  },
  init: (): RoomIdle => ({ phase: "start", lastPoint: null, mode: "inside" }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as RoomCmdState;

    if (input.kind === "option") {
      if (input.id === "mode") {
        // Modus umschalten; ein laufender Manuell-Entwurf wird verworfen.
        const mode: RoomMode = s.mode === "inside" ? "manual" : "inside";
        return idle(mode);
      }
      if (s.phase !== "draw") return [s, { draft: null }];
      if (input.id === "undo") {
        const pts = s.points.slice(0, -1);
        if (pts.length === 0)
          return [
            { phase: "start", lastPoint: null, mode: s.mode } as RoomIdle,
            { draft: null },
          ];
        const ns: RoomDrawing = {
          phase: "draw",
          mode: s.mode,
          points: pts,
          cursor: s.cursor,
          lastPoint: pts[pts.length - 1],
        };
        return [ns, { draft: manualDraft(pts, s.cursor) }];
      }
      if (input.id === "close" && s.points.length >= 3) {
        const pts = s.points;
        return [
          { phase: "start", lastPoint: null, mode: s.mode } as RoomIdle,
          { draft: null, done: true, commit: opsMutation(() => appendRoom(pts, ctx)) },
        ];
      }
      return [s, { draft: s.phase === "draw" ? manualDraft(s.points, s.cursor) : null }];
    }

    if (input.kind !== "point") {
      return [
        s,
        { draft: s.phase === "draw" ? manualDraft(s.points, s.cursor) : null },
      ];
    }

    const pt = input.point;

    // ── Modus „innen": ein Klick → Umriss automatisch erkennen + committen ──
    if (s.mode === "inside" && s.phase !== "draw") {
      const boundary = roomFromPointInside(pt, wallsOfFloor(ctx));
      if (boundary && boundary.length >= 3) {
        return [
          { phase: "start", lastPoint: null, mode: "inside" } as RoomIdle,
          { draft: null, done: true, commit: opsMutation(() => appendRoom(boundary, ctx)) },
        ];
      }
      // Kein umschlossener Bereich getroffen → im Werkzeug bleiben (kein Commit).
      return [s, { draft: null }];
    }

    // ── Modus „manuell": Umriss Punkt für Punkt ──
    if (s.phase !== "draw") {
      const ns: RoomDrawing = {
        phase: "draw",
        mode: "manual",
        points: [pt],
        cursor: pt,
        lastPoint: pt,
      };
      return [ns, { draft: manualDraft([pt], pt) }];
    }
    // Klick nahe Startpunkt → schließen + committen.
    if (s.points.length >= 3 && segLen(s.points[0], pt) < CLOSE_HIT) {
      const pts = s.points;
      return [
        { phase: "start", lastPoint: null, mode: s.mode } as RoomIdle,
        { draft: null, done: true, commit: opsMutation(() => appendRoom(pts, ctx)) },
      ];
    }
    const last = s.points[s.points.length - 1];
    if (segLen(last, pt) < EPS) {
      return [s, { draft: manualDraft(s.points, s.cursor) }];
    }
    const points = [...s.points, pt];
    const ns: RoomDrawing = {
      phase: "draw",
      mode: "manual",
      points,
      cursor: pt,
      lastPoint: pt,
    };
    return [ns, { draft: manualDraft(points, pt) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as RoomCmdState;
    if (s.phase !== "draw") return [s, { draft: null }];
    const ns: RoomDrawing = { ...s, cursor: point };
    return [ns, { draft: manualDraft(s.points, point) }];
  },

  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as RoomCmdState;
    if (s.phase === "draw" && s.points.length >= 3) {
      const pts = s.points;
      return [
        { phase: "start", lastPoint: null, mode: s.mode } as RoomIdle,
        { draft: null, done: true, commit: opsMutation(() => appendRoom(pts, ctx)) },
      ];
    }
    return idle(s.mode);
  },
  onCancel: (state): [CommandState, CommandResult] =>
    idle((state as RoomCmdState).mode),

  fields: (state) => ((state as RoomCmdState).phase === "draw" ? ROOM_FIELDS : []),
  pointFromFields: (state, locks, cursor) => {
    const s = state as RoomCmdState;
    if (s.phase !== "draw" || s.points.length === 0) return null;
    return nextFromFields(s.points[s.points.length - 1], locks, cursor);
  },
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as RoomCmdState;
    if (s.phase !== "draw" || s.points.length === 0 || !cursor) return {};
    const last = s.points[s.points.length - 1];
    return {
      length: segLen(last, cursor),
      angle: ((segAngleDeg(last, cursor) % 360) + 360) % 360,
    };
  },
};
