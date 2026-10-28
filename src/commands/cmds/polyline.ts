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

import type { Drawing2D } from "../../model/types";
import { bulgePolylinePoints, bulgeThroughPoint } from "../../core";
import { segmentHud, uniqueId } from "../../tools/types";
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
 * Bulge eines Bogens, der in `a` TANGENTIAL an die Richtung `dir` anschliesst
 * und in `b` endet. Nach dem Sehnen-Tangenten-Satz ist der Winkel θ VON DER
 * SEHNE ZUR TANGENTE die halbe Zentriwinkel-Spanne (θ = Δ/2), und
 * `bulge = tan(Δ/4)` — also `tan(θ/2)`. Die Richtung der Winkelmessung ist
 * wesentlich: von der Sehne zur Tangente, passend zur Vorzeichenkonvention
 * von `bulge` (positiv = Ausbauchung LINKS von a→b). Andersherum gemessen
 * läge die Tangente am falschen Bogenende. Ohne Richtung (erstes Segment)
 * oder bei entarteter Sehne bleibt es gerade (0).
 */
function tangentBulge(a: Vec2, b: Vec2, dir: Vec2 | null): number {
  if (!dir) return 0;
  const cx = b.x - a.x, cy = b.y - a.y;
  const len = Math.hypot(cx, cy);
  const dl = Math.hypot(dir.x, dir.y);
  if (len < EPS || dl < EPS) return 0;
  const ux = cx / len, uy = cy / len;
  const dx = dir.x / dl, dy = dir.y / dl;
  const theta = Math.atan2(ux * dy - uy * dx, ux * dx + uy * dy);
  return Math.tan(theta / 2);
}

/** Richtung, in der das zuletzt gelegte Segment endet (Tangente für den nächsten Bogen). */
function lastDirection(points: Vec2[], bulges: number[]): Vec2 | null {
  const n = points.length;
  if (n < 2) return null;
  const a = points[n - 2];
  const b = points[n - 1];
  const bulge = bulges[n - 2] ?? 0;
  const chord = { x: b.x - a.x, y: b.y - a.y };
  if (Math.abs(bulge) < EPS) return chord;
  // Austritts-Tangente eines Bogens: die Sehne um den halben Zentriwinkel
  // gedreht (Δ/2 = 2·atan(bulge)) — am ENDE mit umgekehrtem Vorzeichen wie am
  // Anfang (der Bogen ist symmetrisch zur Sehne).
  const ang = -2 * Math.atan(bulge);
  const c = Math.cos(ang), si = Math.sin(ang);
  return { x: chord.x * c - chord.y * si, y: chord.x * si + chord.y * c };
}

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
  /** Bulge je Segment (Index = Segment `points[i] → points[i+1]`), 0 = gerade. */
  bulges: number[];
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
 * Bulge des SCHLUSS-Segments (letzter Punkt → Start), wenn ein Ring ohne
 * weiteren Klick geschlossen wird (Option „close" bzw. Ring-Toggle + Enter).
 * Ein bereits gesetzter Drei-Punkt-Durchgangspunkt gilt dann für DIESES
 * Segment; sonst tangential an den Vorgänger, wie bei jedem anderen Bogen.
 * Ohne diesen Eintrag liest `drawing2d.ts` dort einen fehlenden Bulge (Index
 * ausserhalb des Arrays) und zeichnet die Schlusskante immer gerade.
 */
function closingBulge(s: PolyDrawing): number {
  if (!s.arc) return 0;
  const prev = s.points[s.points.length - 1];
  const start = s.points[0];
  return s.pendingThrough
    ? bulgeThroughPoint(prev, s.pendingThrough, start)
    : tangentBulge(prev, start, lastDirection(s.points, s.bulges));
}

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
  points: Vec2[],
  bulges: number[],
  cursor: Vec2 | null,
  closed = false,
  arcMode = false,
  tangent = false,
  pendingThrough: Vec2 | null = null,
): ToolDraft {
  const all = cursor ? [...points, cursor] : points;
  const last = points[points.length - 1];
  // Vorschau-Bulge des Gummiband-Segments: Drei-Punkt (sobald der
  // Durchgangspunkt gesetzt ist), sonst tangential — oder gerade.
  const previewBulge =
    !cursor || !last || !arcMode
      ? 0
      : pendingThrough
        ? bulgeThroughPoint(last, pendingThrough, cursor)
        : tangent
          ? tangentBulge(last, cursor, lastDirection(points, bulges))
          : 0;
  const allBulges = cursor ? [...bulges, previewBulge] : bulges;
  // Bogen-Segmente für die Vorschau ausrollen.
  const pts = bulgePolylinePoints(all, allBulges, false);
  // Ring nur ab 3 Punkten zeigen; darunter bleibt die Vorschau offen.
  const showClosed = closed && all.length >= 3;
  const preview: DraftShape[] = [{ kind: "poly", pts, closed: showClosed }];
  const draft: ToolDraft = { preview, vertices: points };
  if (cursor && last && segLen(last, cursor) >= EPS) draft.hud = segmentHud(last, cursor);
  return draft;
}

/** Hängt eine 2D-Polylinie ans Projekt (immutabel). Farbe/Strich erbt die Kategorie. */
function appendPolyline(pts: Vec2[],
  bulges: number[],
  closed: boolean,
  ctx: CommandContext,
): CoreOp[] {
  // `bulge` nur mitschreiben, wenn wirklich ein Bogen dabei ist — ein reiner
  // Geradenzug bleibt damit bitgleich zu vorher (additives Feld).
  const hasArc = bulges.some((b) => Math.abs(b) > EPS);
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: hasArc
      ? { shape: "polyline", pts, closed, bulge: bulges.slice(0, closed ? pts.length : pts.length - 1) }
      : { shape: "polyline", pts, closed },
  };
  return addItems("drawings2d", [d]);
}

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
                ? polyDraft(s.points, s.bulges, s.cursor, ns.closed, ns.arc, ns.tangent, null)
                : null,
          },
        ];
      }
      if (s.phase !== "next") return [s, { draft: null }];
      if (input.id === "undo") {
        // Wartet ein Durchgangspunkt, nimmt „Zurück" zuerst diesen zurück.
        if (s.pendingThrough) {
          const ns: PolyDrawing = { ...s, pendingThrough: null };
          return [ns, { draft: polyDraft(s.points, s.bulges, s.cursor, s.closed, s.arc, s.tangent, null) }];
        }
        const pts = s.points.slice(0, -1);
        const bulges = s.bulges.slice(0, Math.max(0, pts.length - 1));
        if (pts.length === 0)
          return [
            { phase: "start", lastPoint: null, closed: s.closed, arc: s.arc, tangent: s.tangent } as PolyIdle,
            { draft: null },
          ];
        const ns: PolyDrawing = {
          phase: "next",
          points: pts,
          bulges,
          cursor: s.cursor,
          lastPoint: pts[pts.length - 1],
          closed: s.closed,
          arc: s.arc,
          tangent: s.tangent,
          pendingThrough: null,
        };
        return [ns, { draft: polyDraft(pts, bulges, s.cursor, s.closed, s.arc, s.tangent, null) }];
      }
      // Sofort schließen: committet als Ring (unabhängig vom Toggle-Zustand).
      if (input.id === "close" && s.points.length >= 3) {
        const pts = s.points;
        const bl = [...s.bulges, closingBulge(s)];
        return [
          { phase: "start", lastPoint: null, closed: s.closed, arc: s.arc, tangent: s.tangent } as PolyIdle,
          { draft: null, done: true, commit: opsMutation(() => appendPolyline(pts, bl, true, ctx)) },
        ];
      }
      return [
        s,
        { draft: polyDraft(s.points, s.bulges, s.cursor, s.closed, s.arc, s.tangent, s.pendingThrough) },
      ];
    }

    if (input.kind !== "point") {
      return [
        s,
        {
          draft:
            s.phase === "next"
              ? polyDraft(s.points, s.bulges, s.cursor, s.closed, s.arc, s.tangent, s.pendingThrough)
              : null,
        },
      ];
    }
    const pt = input.point;
    if (s.phase !== "next") {
      const ns: PolyDrawing = {
        phase: "next",
        points: [pt],
        bulges: [],
        cursor: pt,
        lastPoint: pt,
        closed: s.closed,
        arc: s.arc,
        tangent: s.tangent,
        pendingThrough: null,
      };
      return [ns, { draft: polyDraft([pt], [], pt, s.closed, s.arc, s.tangent, null) }];
    }
    // Drei-Punkt-Bogen: der ERSTE Klick setzt nur den Durchgangspunkt; das
    // Segment entsteht erst mit dem zweiten Klick (Endpunkt).
    if (s.arc && !s.tangent && !s.pendingThrough) {
      const ns: PolyDrawing = { ...s, pendingThrough: pt, cursor: pt };
      return [ns, { draft: polyDraft(s.points, s.bulges, pt, s.closed, s.arc, s.tangent, pt) }];
    }
    // Bulge des neuen Segments: Drei-Punkt (über den gesetzten Durchgangspunkt)
    // oder tangential an den Vorgänger.
    const prev = s.points[s.points.length - 1];
    const newBulge = !s.arc
      ? 0
      : s.pendingThrough
        ? bulgeThroughPoint(prev, s.pendingThrough, pt)
        : tangentBulge(prev, pt, lastDirection(s.points, s.bulges));
    // Klick nahe Startpunkt → schließen (committet als Ring). `newBulge` ist
    // bereits die korrekte Krümmung des Schluss-Segments (prev→pt, genau wie
    // die Vorschau in `polyDraft` sie zeigt) — MUSS mit angehängt werden,
    // sonst liest `drawing2d.ts` dort einen fehlenden Bulge-Eintrag und
    // schliesst immer gerade, obwohl die Vorschau eben noch den Bogen zeigte.
    if (s.points.length >= 3 && segLen(s.points[0], pt) < CLOSE_HIT) {
      const pts = s.points;
      const bl = [...s.bulges, newBulge];
      return [
        { phase: "start", lastPoint: null, closed: s.closed, arc: s.arc, tangent: s.tangent } as PolyIdle,
        { draft: null, done: true, commit: opsMutation(() => appendPolyline(pts, bl, true, ctx)) },
      ];
    }
    const points = [...s.points, pt];
    const bulges = [...s.bulges, newBulge];
    const ns: PolyDrawing = {
      phase: "next",
      points,
      bulges,
      cursor: pt,
      lastPoint: pt,
      closed: s.closed,
      arc: s.arc,
      tangent: s.tangent,
      pendingThrough: null,
    };
    return [ns, { draft: polyDraft(points, bulges, pt, s.closed, s.arc, s.tangent, null) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as PolyState;
    if (s.phase !== "next") return [s, { draft: null }];
    const ns: PolyDrawing = { ...s, cursor: point };
    return [
      ns,
      { draft: polyDraft(s.points, s.bulges, point, s.closed, s.arc, s.tangent, s.pendingThrough) },
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
      const bl = close ? [...s.bulges, closingBulge(s)] : s.bulges;
      return [
        { phase: "start", lastPoint: null, closed: s.closed, arc: s.arc, tangent: s.tangent } as PolyIdle,
        { draft: null, done: true, commit: opsMutation(() => appendPolyline(pts, bl, close, ctx)) },
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
