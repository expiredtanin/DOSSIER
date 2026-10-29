// Polyline — mehrteiliger Zug (portiert polylineTool). Schritte:
//   1) „Startpunkt:" → Punkt
//   2) „Nächster Punkt ( Bogen Schliessen Zurück ):" → Punkt … (Enter beendet
//      offen, „Schliessen" schließt; Klick auf den Startpunkt schließt ebenfalls)
//
// Akzeptiert je Punkt Maus-Picks UND getippte Koordinaten (0,0 · r3,0 · 5<45).
//
// BOGEN-MODUS (Option „Bogen"): statt einer Geraden entsteht ein Kreisbogen.
// Gespeichert wird er als `bulge` am Segment (DXF-Konvention), also im selben
// Element; Bogen- und Geradenstücke mischen sich frei in EINER Polylinie.
// Zwei Varianten, umschaltbar über die Unteroption „Tangential":
//   • AUS (Default): DREI-PUNKT-Bogen — erst ein Durchgangspunkt, dann der
//     Endpunkt. Radius und Wölbung hängen NUR an diesen drei Punkten, jedes
//     Segment ist also unabhängig einstellbar (Nutzer-Anforderung: die Grösse
//     soll nicht am vorherigen/ersten Punkt der Kette hängen).
//   • AN: der Bogen schliesst TANGENTIAL ans vorherige Segment an (AutoCADs
//     PLINE-Default) — bequem für weiche Übergänge, aber die Krümmung ergibt
//     sich dann zwangsläufig aus dem Vorgänger. Das erste Segment hat keine
//     Tangenten-Referenz und bleibt gerade.

import { segmentHud } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  CmdOption,
  ToolDraft,
  Vec2,
} from "../types";
import { createMutation, createPreview } from "../createCore";

const EPS = 1e-6;
const DEG = Math.PI / 180;
const CLOSE_HIT = 0.08; // Modell-Meter: Klick nahe Startpunkt schließt den Zug
const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/** Tab-Felder je weiteren Punkt: Länge + Winkel relativ zum letzten Punkt. */
const POLY_FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];

/** Nächster Punkt aus gelockten Feldern (length/angle) + Cursor, relativ zu `last`. */
function polyNextFromFields(last: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const ref = cursor ?? last;
  const length = "length" in locks ? locks.length : segLen(last, ref);
  const angleDeg = "angle" in locks ? locks.angle : segAngleDeg(last, ref);
  const ang = angleDeg * DEG;
  return { x: last.x + Math.cos(ang) * length, y: last.y + Math.sin(ang) * length };
}

/**
 * Art eines Segments (Index = Segment `points[i] → points[i+1]`): gerade (`0`), Bogen tangential an den
 * Vorgänger (`1`) oder Drei-Punkt-Bogen durch einen Durchgangspunkt. Die Bulges (`tan(Δ/4)`, tangential
 * aus der Endrichtung des Vorgängers) rechnet der Kern (`cmd_draw.rs`) der Reihe nach.
 */
type Seg = 0 | 1 | Vec2;

interface PolyIdle extends CommandState {
  phase: "start";
  /** Gewählter Schließ-Modus (bleibt über den Befehl hinweg erhalten). */
  closed: boolean;
  /** Bogen-Modus (bleibt über den Befehl hinweg erhalten, wie `closed`). */
  arc: boolean;
  /** Im Bogen-Modus: tangential an den Vorgänger statt Drei-Punkt-Bogen. */
  tangent: boolean;
}
interface PolyDrawing extends CommandState {
  phase: "next";
  points: Vec2[];
  /** Art je Segment (s. {@link Seg}). */
  segs: Seg[];
  cursor: Vec2 | null;
  /** Soll der committete Zug als Ring (geschlossen) gelten? Default: offen. */
  closed: boolean;
  arc: boolean;
  tangent: boolean;
  /**
   * Drei-Punkt-Bogen: bereits gesetzter Durchgangspunkt, der noch auf seinen
   * Endpunkt wartet. `null` = kein Bogen in Arbeit.
   */
  pendingThrough: Vec2 | null;
}
type PolyState = PolyIdle | PolyDrawing;

/**
 * Art des SCHLUSS-Segments (letzter Punkt → Start), wenn ein Ring ohne weiteren Klick geschlossen wird
 * (Option „close" bzw. Ring-Toggle + Enter): ein bereits gesetzter Drei-Punkt-Durchgangspunkt gilt dann
 * für DIESES Segment; sonst im Bogen-Modus tangential an den Vorgänger. Ohne diesen Eintrag läse der
 * Plan dort einen fehlenden Bulge und zeichnete die Schlusskante immer gerade.
 */
const closingSeg = (s: PolyDrawing): Seg => (!s.arc ? 0 : (s.pendingThrough ?? 1));

/** Sofort-schließen-Aktion (nur ≥3 Punkte): committet als Ring und beendet. */
const CLOSE: CmdOption = { id: "close", labelKey: "cmd.polyline.close" };
const UNDO: CmdOption = { id: "undo", labelKey: "cmd.polyline.undo" };
/** Toggle-Option: Ergebnis geschlossen (Ring) oder offen — im Feld-Row sichtbar. */
const closedOption = (closed: boolean): CmdOption => ({
  id: "mode",
  labelKey: "cmd.polyline.closedOpt",
  value: closed ? "on" : "off",
});
/** Toggle-Option: folgende Segmente als Kreisbogen statt gerade. */
const arcOption = (arc: boolean): CmdOption => ({
  id: "arc",
  labelKey: "cmd.polyline.arcOpt",
  value: arc ? "on" : "off",
});
/** Unteroption (nur im Bogen-Modus): tangential an den Vorgänger statt Drei-Punkt. */
const tangentOption = (on: boolean): CmdOption => ({
  id: "tangent",
  labelKey: "cmd.polyline.tangentOpt",
  value: on ? "on" : "off",
});

/**
 * Vorschau (Zug + Gummiband zum Cursor) + HUD (Länge·Winkel des letzten
 * Segments). Bogen-Segmente werden für die VORSCHAU tesselliert — der Draft
 * kennt nur Linien/Polygonzüge; gespeichert wird selbstverständlich der
 * exakte `bulge` (s. `appendPolyline`).
 */
function polyDraft(
  ctx: CommandContext,
  points: Vec2[],
  segs: Seg[],
  cursor: Vec2 | null,
  closed = false,
  arcMode = false,
  tangent = false,
  pendingThrough: Vec2 | null = null,
): ToolDraft {
  const all = cursor ? [...points, cursor] : points;
  const req = { cmd: "polyline", segs, closed, arc: arcMode, tangent, through: pendingThrough, cursor: !!cursor };
  const draft: ToolDraft = { preview: createPreview(ctx, req, all).shapes, vertices: points };
  const last = points[points.length - 1];
  if (cursor && last && segLen(last, cursor) >= EPS) draft.hud = segmentHud(last, cursor);
  return draft;
}

/**
 * Commit (Kern): 2D-Polylinie aus Punkten und Segment-Arten; `closing` = Art des Schluss-Segments
 * (geschlossen), `closingEnd` = sein Endpunkt, falls ein Klick nahe dem Start schloss. Farbe/Strich erbt
 * die Kategorie.
 */
const appendPolyline = (
  pts: Vec2[],
  segs: Seg[],
  closing: Seg | null,
  closed: boolean,
  ctx: CommandContext,
  closingEnd: Vec2 | null = null,
) => createMutation(ctx, { cmd: "polyline", pts, segs, closing, closingEnd, closed });

/** Ruhezustand; behält den zuletzt gewählten Schließ-Modus bei. */
const idle = (closed = false, arc = false, tangent = false): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null, closed, arc, tangent } as PolyIdle,
  { draft: null, done: true },
];

export const polylineCommand: Command = {
  name: "polyline",
  labelKey: "cmd.polyline.label",
  prompt: (s) => {
    const ps = s as PolyState;
    if (ps.phase !== "next") return "cmd.polyline.start";
    // Drei-Punkt-Bogen: erst Durchgangspunkt, dann Endpunkt.
    if (ps.arc && !ps.tangent && !ps.pendingThrough) return "cmd.polyline.arcThrough";
    return "cmd.polyline.next";
  },
  // Auch im Startschritt darf der Schließ-Modus gewählt werden.
  accepts: () => ["point", "number", "option"],
  options: (s) => {
    const ps = s as PolyState;
    const toggle = closedOption(ps.closed);
    const arc = arcOption(ps.arc);
    const sub = ps.arc ? [tangentOption(ps.tangent)] : [];
    if (ps.phase !== "next") return [arc, ...sub, toggle];
    return ps.points.length >= 2
      ? [CLOSE, arc, ...sub, toggle, UNDO]
      : [arc, ...sub, toggle, UNDO];
  },
  init: (): PolyIdle => ({ phase: "start", lastPoint: null, closed: false, arc: false, tangent: false }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as PolyState;

    if (input.kind === "option") {
      // Schließ-Modus umschalten (Tastenkürzel „C" bzw. Klick im Feld-Row);
      // in jedem Schritt verfügbar, ohne den laufenden Zug zu beenden.
      if (input.id === "mode" || input.id === "arc" || input.id === "tangent") {
        // Modus-Wechsel verwirft einen halb gesetzten Drei-Punkt-Bogen —
        // sonst bezöge sich der wartende Durchgangspunkt auf eine andere
        // Bogen-Variante als die jetzt gewählte.
        const base =
          input.id === "mode"
            ? { ...s, closed: !s.closed }
            : input.id === "arc"
              ? { ...s, arc: !s.arc }
              : { ...s, tangent: !s.tangent };
        const ns = (s.phase === "next" ? { ...base, pendingThrough: null } : base) as PolyState;
        return [
          ns,
          {
            draft:
              s.phase === "next"
                ? polyDraft(ctx, s.points, s.segs, s.cursor, ns.closed, ns.arc, ns.tangent, null)
                : null,
          },
        ];
      }
      if (s.phase !== "next") return [s, { draft: null }];
      if (input.id === "undo") {
        // Wartet ein Durchgangspunkt, nimmt „Zurück" zuerst diesen zurück.
        if (s.pendingThrough) {
          const ns: PolyDrawing = { ...s, pendingThrough: null };
          return [ns, { draft: polyDraft(ctx, s.points, s.segs, s.cursor, s.closed, s.arc, s.tangent, null) }];
        }
        const pts = s.points.slice(0, -1);
        const segs = s.segs.slice(0, Math.max(0, pts.length - 1));
        if (pts.length === 0)
          return [
            { phase: "start", lastPoint: null, closed: s.closed, arc: s.arc, tangent: s.tangent } as PolyIdle,
            { draft: null },
          ];
        const ns: PolyDrawing = {
          phase: "next",
          points: pts,
          segs,
          cursor: s.cursor,
          lastPoint: pts[pts.length - 1],
          closed: s.closed,
          arc: s.arc,
          tangent: s.tangent,
          pendingThrough: null,
        };
        return [ns, { draft: polyDraft(ctx, pts, segs, s.cursor, s.closed, s.arc, s.tangent, null) }];
      }
      // Sofort schließen: committet als Ring (unabhängig vom Toggle-Zustand).
      if (input.id === "close" && s.points.length >= 3) {
        const pts = s.points;
        const segs = s.segs;
        const closing = closingSeg(s);
        return [
          { phase: "start", lastPoint: null, closed: s.closed, arc: s.arc, tangent: s.tangent } as PolyIdle,
          { draft: null, done: true, commit: appendPolyline(pts, segs, closing, true, ctx) },
        ];
      }
      return [
        s,
        { draft: polyDraft(ctx, s.points, s.segs, s.cursor, s.closed, s.arc, s.tangent, s.pendingThrough) },
      ];
    }

    if (input.kind !== "point") {
      return [
        s,
        {
          draft:
            s.phase === "next"
              ? polyDraft(ctx, s.points, s.segs, s.cursor, s.closed, s.arc, s.tangent, s.pendingThrough)
              : null,
        },
      ];
    }
    const pt = input.point;
    if (s.phase !== "next") {
      const ns: PolyDrawing = {
        phase: "next",
        points: [pt],
        segs: [],
        cursor: pt,
        lastPoint: pt,
        closed: s.closed,
        arc: s.arc,
        tangent: s.tangent,
        pendingThrough: null,
      };
      return [ns, { draft: polyDraft(ctx, [pt], [], pt, s.closed, s.arc, s.tangent, null) }];
    }
    // Drei-Punkt-Bogen: der ERSTE Klick setzt nur den Durchgangspunkt; das
    // Segment entsteht erst mit dem zweiten Klick (Endpunkt).
    if (s.arc && !s.tangent && !s.pendingThrough) {
      const ns: PolyDrawing = { ...s, pendingThrough: pt, cursor: pt };
      return [ns, { draft: polyDraft(ctx, s.points, s.segs, pt, s.closed, s.arc, s.tangent, pt) }];
    }
    // Bulge des neuen Segments: Drei-Punkt (über den gesetzten Durchgangspunkt)
    // oder tangential an den Vorgänger.
    const newSeg: Seg = !s.arc ? 0 : (s.pendingThrough ?? 1);
    // Klick nahe Startpunkt → schließen (committet als Ring). `newBulge` ist
    // bereits die korrekte Krümmung des Schluss-Segments (prev→pt, genau wie
    // die Vorschau in `polyDraft` sie zeigt) — MUSS mit angehängt werden,
    // sonst liest der Plan (`plan/drawings.rs`) dort einen fehlenden Bulge-Eintrag und
    // schliesst immer gerade, obwohl die Vorschau eben noch den Bogen zeigte.
    if (s.points.length >= 3 && segLen(s.points[0], pt) < CLOSE_HIT) {
      const pts = s.points;
      const segs = s.segs;
      return [
        { phase: "start", lastPoint: null, closed: s.closed, arc: s.arc, tangent: s.tangent } as PolyIdle,
        { draft: null, done: true, commit: appendPolyline(pts, segs, newSeg, true, ctx, pt) },
      ];
    }
    const points = [...s.points, pt];
    const segs = [...s.segs, newSeg];
    const ns: PolyDrawing = {
      phase: "next",
      points,
      segs,
      cursor: pt,
      lastPoint: pt,
      closed: s.closed,
      arc: s.arc,
      tangent: s.tangent,
      pendingThrough: null,
    };
    return [ns, { draft: polyDraft(ctx, points, segs, pt, s.closed, s.arc, s.tangent, null) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as PolyState;
    if (s.phase !== "next") return [s, { draft: null }];
    const ns: PolyDrawing = { ...s, cursor: point };
    return [
      ns,
      { draft: polyDraft(ctx, s.points, s.segs, point, s.closed, s.arc, s.tangent, s.pendingThrough) },
    ];
  },

  // Enter/Space/Rechtsklick: Zug beenden (≥2 Punkte). Der Schließ-Modus des
  // Toggles bestimmt, ob als Ring oder offen committet wird. Ein Ring braucht
  // ≥3 Punkte, sonst fällt er auf „offen" zurück.
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as PolyState;
    if (s.phase === "next" && s.points.length >= 2) {
      const pts = s.points;
      const close = s.closed && pts.length >= 3;
      const closing = close ? closingSeg(s) : null;
      return [
        { phase: "start", lastPoint: null, closed: s.closed, arc: s.arc, tangent: s.tangent } as PolyIdle,
        { draft: null, done: true, commit: appendPolyline(pts, s.segs, closing, close, ctx) },
      ];
    }
    return idle(s.closed, s.arc, s.tangent);
  },
  onCancel: (state): [CommandState, CommandResult] =>
    idle((state as PolyState).closed, (state as PolyState).arc, (state as PolyState).tangent),

  // Tab-Feld-Zyklus nur im „next"-Schritt: Länge + Winkel relativ zum letzten
  // Punkt. (Erster Punkt = freie Koordinate, kein Feld-Modus.)
  fields: (state) => ((state as PolyState).phase === "next" ? POLY_FIELDS : []),
  pointFromFields: (state, locks, cursor) => {
    const s = state as PolyState;
    if (s.phase !== "next" || s.points.length === 0) return null;
    return polyNextFromFields(s.points[s.points.length - 1], locks, cursor);
  },
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as PolyState;
    if (s.phase !== "next" || s.points.length === 0 || !cursor) return {};
    const last = s.points[s.points.length - 1];
    return {
      length: segLen(last, cursor),
      angle: ((segAngleDeg(last, cursor) % 360) + 360) % 360,
    };
  },
};
