// Rectangle — mehrere Konstruktionsmethoden (portiert + erweitert rectTool).
// Wählbar über die Option „Methode" (klickbar im Feld-Row, tippbar als „m",
// zyklisch): 2-Punkt · 3-Punkt · Zentrum.
//
//   • 2-Punkt (Default): zwei gegenüberliegende Ecken, achsparallel.
//       1) „Erste Ecke:"            → Punkt
//       2) „Gegenüberliegende Ecke:" → Punkt → commit (shape:"rect")
//   • 3-Punkt (gedreht): Basiskante + Höhe → beliebig gedrehtes Rechteck.
//       1) „Erste Ecke:"        → Punkt (Basis-Start)
//       2) „Zweite Ecke:"       → Punkt (Basis-Ende, definiert Winkel+Breite)
//       3) „Höhe:"              → Punkt → commit (geschlossene Polylinie)
//   • Zentrum: Mittelpunkt + Ecke, achsparallel.
//       1) „Mittelpunkt:"           → Punkt
//       2) „Ecke:"                   → Punkt → commit (shape:"rect")
//
// Getippte Maße: die zweite/dritte Ecke kann relativ (`r<dx>,<dy>`) eingegeben
// werden (die Engine löst `r…` relativ zu lastPoint auf).
//
// Eck-Radius (Nutzer-Wunsch: „kein Rundeck-Eck-Radius bei der Erzeugung,
// `Drawing2DGeom["rect"]` hat gar kein Radius-Feld, nur nachträgliches
// fillet möglich"): zweite, IMMER sichtbare Option „Radius" (zyklisch durch
// gängige Architektur-Werte 0/2/5/10/20/30 cm), orthogonal zur Methode — gilt
// für alle drei Konstruktionsarten (arbeitet rein über die 4 tatsächlichen
// Eckpunkte, unabhängig von Achsparallelität/Drehung). Bei Radius 0 (Default)
// BYTE-IDENTISCH zum bisherigen Verhalten (`shape:"rect"` bzw. scharfe
// Polylinie); bei Radius > 0 committet eine geschlossene `polyline` mit
// `bulge`-Bogensegmenten an den vier Ecken (kein neues Modellfeld nötig —
// `Drawing2DGeom["polyline"].bulge` existiert bereits für genau diesen Zweck,
// s. `model/types.ts`). Radius wird auf die halbe kürzere Kantenlänge
// geklammert (sonst würden sich benachbarte Fillets überlappen).

import type { Drawing2D } from "../../model/types";
import { deltaHud, segmentHud, uniqueId } from "../../tools/types";
import { filletCorner } from "../../core";
import { bulgeArcPoints, bulgeThroughPoint } from "../../core";
import type {
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  CmdOption,
  DraftShape,
  Project,
  ToolDraft,
  Vec2,
} from "../types";
import type { TranslationKey } from "../../i18n";

const EPS = 1e-6;

/** Konstruktionsmethode. */
type RectMethod = "corner" | "three" | "center";
const METHOD_ORDER: RectMethod[] = ["corner", "three", "center"];
const nextMethod = (m: RectMethod): RectMethod =>
  METHOD_ORDER[(METHOD_ORDER.indexOf(m) + 1) % METHOD_ORDER.length];
const methodValue = (m: RectMethod): string =>
  m === "corner" ? "2pt" : m === "three" ? "3pt" : "center";

/** Umschalt-Option für die Methode (im Feld-Row sichtbar, tippbar als „m"). */
const methodOption = (m: RectMethod): CmdOption => ({
  id: "method",
  labelKey: "cmd.rect.method",
  value: methodValue(m),
});

/** Eck-Radius: gängige Architektur-Werte (Meter), 0 = scharfe Ecken (Default). */
const RADIUS_PRESETS = [0, 0.02, 0.05, 0.1, 0.2, 0.3];
let lastRadius = 0;
const nextRadius = (): number => RADIUS_PRESETS[(RADIUS_PRESETS.indexOf(lastRadius) + 1) % RADIUS_PRESETS.length];
/** Umschalt-Option fürs Eck-Radius (tippbar als „r", IMMER sichtbar — gilt für alle Methoden). */
const radiusOption = (): CmdOption => ({ id: "radius", labelKey: "cmd.rect.radius", value: String(lastRadius) });

/** Tab-Felder des Breite/Höhe-Schritts (2-Punkt & Zentrum). */
const RECT_FIELDS: CommandField[] = [
  { id: "width", labelKey: "cmd.field.width" },
  { id: "height", labelKey: "cmd.field.height" },
];
/** Tab-Felder des Basis-Schritts (3-Punkt): Länge + Winkel der Basiskante. */
const BASE_FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];
/** Tab-Feld des Höhen-Schritts (3-Punkt): senkrechter Abstand. */
const RISE_FIELDS: CommandField[] = [{ id: "height", labelKey: "cmd.field.height" }];

const DEG = Math.PI / 180;
const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

// ── 2-Punkt / Zentrum: achsparallele Ableitung ───────────────────────────────

/**
 * Gegenüberliegende Ecke aus gelockten Feldern (width/height) + Cursor: eine
 * gelockte Kantenlänge nimmt ihren Betrag, das Vorzeichen (Quadrant) folgt dem
 * Cursor relativ zur ersten Ecke `a`; ungelockt folgt die Kante direkt dem Cursor.
 */
function rectCornerFromFields(a: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const cur = cursor ?? a;
  const dx = cur.x - a.x;
  const dy = cur.y - a.y;
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  const w = "width" in locks ? sx * Math.abs(locks.width) : dx;
  const h = "height" in locks ? sy * Math.abs(locks.height) : dy;
  return { x: a.x + w, y: a.y + h };
}

// ── 3-Punkt: Basiskante + Höhe ───────────────────────────────────────────────

/** Basis-Endpunkt aus gelockten Feldern (length/angle) + Cursor, relativ zu `a`. */
function baseFromFields(a: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const ref = cursor ?? a;
  const length = "length" in locks ? locks.length : segLen(a, ref);
  const angleDeg = "angle" in locks ? locks.angle : segAngleDeg(a, ref);
  const ang = angleDeg * DEG;
  return { x: a.x + Math.cos(ang) * length, y: a.y + Math.sin(ang) * length };
}

/**
 * Vier Ecken des gedrehten Rechtecks aus Basiskante (a→b) und einem dritten
 * Punkt `p`: die Höhe ist der vorzeichenbehaftete senkrechte Abstand von `p` zur
 * Basislinie; das Rechteck wird zu dieser Seite hin aufgespannt.
 */
function rotatedCorners(a: Vec2, b: Vec2, p: Vec2): Vec2[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < EPS) return [a, b, b, a];
  // Einheits-Normale (links der Basisrichtung).
  const nx = -dy / len;
  const ny = dx / len;
  const h = (p.x - a.x) * nx + (p.y - a.y) * ny; // signierte Höhe
  const c3 = { x: b.x + nx * h, y: b.y + ny * h };
  const c4 = { x: a.x + nx * h, y: a.y + ny * h };
  return [a, b, c3, c4];
}

/** Senkrechter (signierter) Abstand eines Punktes zur Basislinie a→b. */
function riseFrom(a: Vec2, b: Vec2, p: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < EPS) return 0;
  return (p.x - a.x) * (-dy / len) + (p.y - a.y) * (dx / len);
}

/** Dritten Punkt aus gelockter Höhe rekonstruieren (auf der Cursor-Seite). */
function riseToPoint(a: Vec2, b: Vec2, height: number, cursor: Vec2 | null): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < EPS) return cursor ?? b;
  const nx = -dy / len;
  const ny = dx / len;
  const sign = cursor && riseFrom(a, b, cursor) < 0 ? -1 : 1;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const h = sign * Math.abs(height);
  return { x: mid.x + nx * h, y: mid.y + ny * h };
}

// ── Zentrum: Ecke aus Mittelpunkt ────────────────────────────────────────────

/** Achsparallele Ecken aus Zentrum + einer Ecke. */
function centerGeom(center: Vec2, corner: Vec2): { min: Vec2; max: Vec2 } {
  const hx = Math.abs(corner.x - center.x);
  const hy = Math.abs(corner.y - center.y);
  return {
    min: { x: center.x - hx, y: center.y - hy },
    max: { x: center.x + hx, y: center.y + hy },
  };
}

/** Ecke aus Zentrum + gelockten Halbmaßen (width/height als volle Kantenmaße). */
function centerCornerFromFields(
  center: Vec2,
  locks: Record<string, number>,
  cursor: Vec2 | null,
): Vec2 {
  const cur = cursor ?? center;
  const dx = cur.x - center.x;
  const dy = cur.y - center.y;
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  const hx = "width" in locks ? Math.abs(locks.width) / 2 : Math.abs(dx);
  const hy = "height" in locks ? Math.abs(locks.height) / 2 : Math.abs(dy);
  return { x: center.x + sx * hx, y: center.y + sy * hy };
}

// ── Zustand ──────────────────────────────────────────────────────────────────

interface RectIdle extends CommandState {
  phase: "corner1";
  method: RectMethod;
}
interface RectCorner2 extends CommandState {
  phase: "corner2";
  method: RectMethod;
  a: Vec2;
  cursor: Vec2 | null;
}
interface RectRise extends CommandState {
  phase: "rise";
  method: "three";
  a: Vec2;
  b: Vec2;
  cursor: Vec2 | null;
}
type RectState = RectIdle | RectCorner2 | RectRise;

function rectGeom(a: Vec2, b: Vec2): { min: Vec2; max: Vec2 } {
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
  };
}

// ── Eck-Radius ───────────────────────────────────────────────────────────────

/**
 * Rundet die 4 Ecken eines Rechtecks (beliebige Umlaufreihenfolge/Ausrichtung
 * — arbeitet rein über die tatsächliche Punkt-Geometrie, keine Achsparallel-
 * Annahme) mit Radius `r`, geklammert auf die halbe kürzeste Kantenlänge
 * (sonst würden sich benachbarte Fillets überlappen). `null` bei `r<=0` oder
 * wenn selbst der geklammerte Radius nicht mehr passt (entartetes Rechteck).
 */
function roundedRectPts(corners: Vec2[], r: number): { pts: Vec2[]; bulge: number[] } | null {
  if (r < EPS) return null;
  const n = corners.length;
  let maxR = Infinity;
  for (let i = 0; i < n; i++) {
    maxR = Math.min(maxR, segLen(corners[i], corners[(i + 1) % n]) / 2);
  }
  const rr = Math.min(r, maxR - EPS);
  if (rr < EPS) return null;

  const pts: Vec2[] = [];
  const bulge: number[] = [];
  for (let i = 0; i < n; i++) {
    const prev = corners[(i - 1 + n) % n];
    const cur = corners[i];
    const next = corners[(i + 1) % n];
    const f = filletCorner(cur, prev, next, rr);
    if (!f) return null; // (nahezu) kollineare Ecke — sollte bei einem Rechteck nicht vorkommen
    // Bogen-Mittelpunkt: auf dem Fillet-Kreis, in Richtung der ursprünglichen
    // (jetzt weggerundeten) Ecke vom Bogen-Zentrum aus gesehen.
    const dx = cur.x - f.center.x;
    const dy = cur.y - f.center.y;
    const dl = Math.hypot(dx, dy) || 1;
    const mid: Vec2 = { x: f.center.x + (dx / dl) * rr, y: f.center.y + (dy / dl) * rr };
    pts.push(f.tangentA, f.tangentB);
    bulge.push(bulgeThroughPoint(f.tangentA, mid, f.tangentB), 0);
  }
  return { pts, bulge };
}

/** Tessellierte Punkte einer gerundeten geschlossenen Kontur — für die Live-Vorschau. */
function tessellateRounded(pts: Vec2[], bulge: number[]): Vec2[] {
  const out: Vec2[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    out.push(...bulgeArcPoints(pts[i], pts[(i + 1) % n], bulge[i]).slice(0, -1));
  }
  return out;
}

// ── Vorschau ─────────────────────────────────────────────────────────────────

function corners4Draft(pts: Vec2[], hud: ToolDraft["hud"] | null): ToolDraft {
  const rounded = roundedRectPts(pts, lastRadius);
  const previewPts = rounded ? tessellateRounded(rounded.pts, rounded.bulge) : pts;
  const preview: DraftShape[] = [{ kind: "poly", pts: previewPts, closed: true }];
  const draft: ToolDraft = { preview, vertices: [pts[0]] };
  if (hud) draft.hud = hud;
  return draft;
}

/** Vorschau des 2-Punkt-Rechtecks (achsparallel) — HUD zeigt die Diagonale a→cursor. */
function cornerDraft(a: Vec2, cursor: Vec2 | null): ToolDraft {
  if (!cursor) return { preview: [], vertices: [a] };
  const g = rectGeom(a, cursor);
  const pts: Vec2[] = [g.min, { x: g.max.x, y: g.min.y }, g.max, { x: g.min.x, y: g.max.y }];
  return corners4Draft(pts, segLen(a, cursor) >= EPS ? deltaHud(a, cursor) : null);
}

/** Vorschau des Zentrum-Rechtecks (achsparallel) — HUD zeigt die Diagonale center→cursor. */
function centerDraft(center: Vec2, cursor: Vec2 | null): ToolDraft {
  if (!cursor) return { preview: [], vertices: [center] };
  const g = centerGeom(center, cursor);
  const pts: Vec2[] = [g.min, { x: g.max.x, y: g.min.y }, g.max, { x: g.min.x, y: g.max.y }];
  return corners4Draft(
    pts,
    segLen(center, cursor) >= EPS
      ? { at: cursor, dx: 2 * (cursor.x - center.x), dy: 2 * (cursor.y - center.y) }
      : null,
  );
}

/** Vorschau der Basiskante (3-Punkt, erster Teil). */
function baseDraft(a: Vec2, cursor: Vec2 | null): ToolDraft {
  if (!cursor || segLen(a, cursor) < EPS) return { preview: [{ kind: "line", a, b: a }], vertices: [a] };
  return { preview: [{ kind: "line", a, b: cursor }], vertices: [a], hud: segmentHud(a, cursor) };
}

/** Vorschau des gedrehten Rechtecks (3-Punkt, zweiter Teil) — HUD: Basisbreite + Höhe am Cursor. */
function riseDraft(a: Vec2, b: Vec2, cursor: Vec2 | null): ToolDraft {
  if (!cursor) return { preview: [{ kind: "line", a, b }], vertices: [a] };
  const pts = rotatedCorners(a, b, cursor);
  const w = segLen(a, b);
  const h = Math.abs(riseFrom(a, b, cursor));
  return corners4Draft(pts, { at: cursor, text: `B: ${w.toFixed(3)}m    H: ${h.toFixed(3)}m` });
}

// ── Commit ───────────────────────────────────────────────────────────────────

/** Achsparalleles Rechteck als `shape:"rect"` (geschlossen behandelt). */
function appendRect(p: Project, min: Vec2, max: Vec2, ctx: CommandContext): Project {
  if (max.x - min.x < EPS || max.y - min.y < EPS) return p; // Null-Rechteck
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "rect", min, max },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

/**
 * Gedrehtes Rechteck als geschlossene Polylinie (`shape:"polyline", closed:true`)
 * — `shape:"rect"` kann nur achsparallel, deshalb hier ein Ring aus vier Ecken.
 * Downstream (Füllung/Offset) behandelt einen geschlossenen Polygonzug als Ring.
 */
function appendRotated(p: Project, pts: Vec2[], ctx: CommandContext): Project {
  // Fläche prüfen: entartete Rechtecke verwerfen.
  const w = segLen(pts[0], pts[1]);
  const h = segLen(pts[1], pts[2]);
  if (w < EPS || h < EPS) return p;
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "polyline", pts, closed: true },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

/**
 * Gerundetes Rechteck (Eck-Radius > 0) als geschlossene `polyline` MIT
 * `bulge` — ersetzt `appendRect`/`appendRotated`, wenn `lastRadius` > 0 ist,
 * unabhängig von der Konstruktionsmethode (`corners` sind die 4 scharfen
 * Ecken, egal ob achsparallel oder gedreht). No-Op, wenn der Radius nicht
 * passt (`roundedRectPts` liefert dann `null`, z. B. bei einem entarteten
 * Rechteck).
 */
function appendRectRounded(p: Project, corners: Vec2[], ctx: CommandContext): Project {
  const rr = roundedRectPts(corners, lastRadius);
  if (!rr) return p;
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "polyline", pts: rr.pts, closed: true, bulge: rr.bulge },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (method: RectMethod): [CommandState, CommandResult] => [
  { phase: "corner1", lastPoint: null, method } as RectIdle,
  { draft: null, done: true },
];

// ── Prompt je Schritt/Methode ────────────────────────────────────────────────

function promptKey(s: RectState): TranslationKey {
  if (s.phase === "corner1") return s.method === "center" ? "cmd.rect.center" : "cmd.rect.first";
  if (s.phase === "rise") return "cmd.rect.rise";
  // corner2
  if (s.method === "three") return "cmd.rect.baseEnd";
  if (s.method === "center") return "cmd.rect.corner";
  return "cmd.rect.second";
}

export const rectCommand: Command = {
  name: "rect",
  labelKey: "cmd.rect.label",
  prompt: (s) => promptKey(s as RectState),
  accepts: () => ["point", "number", "option"],
  options: (s) => [methodOption((s as RectState).method), radiusOption()],
  init: (): RectIdle => ({ phase: "corner1", lastPoint: null, method: "corner" }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as RectState;

    if (input.kind === "option") {
      if (input.id === "method") {
        // Methode zyklisch umschalten; laufende Konstruktion verwerfen und den
        // Befehl AKTIV lassen (kein done) — nur zum ersten Schritt zurück.
        const m = nextMethod(s.method);
        const ns: RectIdle = { phase: "corner1", lastPoint: null, method: m };
        return [ns, { draft: null }];
      }
      if (input.id === "radius") {
        // Radius zyklisch umschalten — anders als „Methode" wird die laufende
        // Konstruktion NICHT verworfen, nur die Vorschau aktualisiert (der
        // Radius wirkt erst beim Commit, betrifft also keine Punkt-Historie).
        lastRadius = nextRadius();
        return [s, { draft: draftFor(s) }];
      }
      return [s, { draft: null }];
    }

    if (input.kind !== "point") {
      return [s, { draft: draftFor(s) }];
    }
    const pt = input.point;

    if (s.phase === "corner1") {
      if (s.method === "three") {
        const ns: RectCorner2 = { phase: "corner2", method: "three", a: pt, cursor: pt, lastPoint: pt };
        return [ns, { draft: baseDraft(pt, pt) }];
      }
      const ns: RectCorner2 = { phase: "corner2", method: s.method, a: pt, cursor: pt, lastPoint: pt };
      return [ns, { draft: draftFor(ns) }];
    }

    if (s.phase === "corner2") {
      if (s.method === "three") {
        // Basiskante gesetzt → dritter Punkt bestimmt Höhe.
        if (segLen(s.a, pt) < EPS) return [s, { draft: baseDraft(s.a, s.cursor) }];
        const ns: RectRise = { phase: "rise", method: "three", a: s.a, b: pt, cursor: pt, lastPoint: pt };
        return [ns, { draft: riseDraft(s.a, pt, pt) }];
      }
      const a = s.a;
      const method = s.method;
      return [
        { phase: "corner1", lastPoint: null, method } as RectIdle,
        {
          draft: null,
          done: true,
          commit: (p) => {
            const g = method === "center" ? centerGeom(a, pt) : rectGeom(a, pt);
            if (lastRadius >= EPS) {
              const corners = [g.min, { x: g.max.x, y: g.min.y }, g.max, { x: g.min.x, y: g.max.y }];
              return appendRectRounded(p, corners, ctx);
            }
            return appendRect(p, g.min, g.max, ctx);
          },
        },
      ];
    }

    // phase "rise" (3-Punkt) → committen als gedrehte, geschlossene Polylinie
    // (scharf) oder mit gerundeten Ecken (Radius > 0).
    const { a, b } = s;
    return [
      { phase: "corner1", lastPoint: null, method: "three" } as RectIdle,
      {
        draft: null,
        done: true,
        commit: (p) => {
          const corners = rotatedCorners(a, b, pt);
          return lastRadius >= EPS ? appendRectRounded(p, corners, ctx) : appendRotated(p, corners, ctx);
        },
      },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as RectState;
    if (s.phase === "corner1") return [s, { draft: null }];
    const ns = { ...s, cursor: point } as RectState;
    return [ns, { draft: draftFor(ns) }];
  },

  onConfirm: (state): [CommandState, CommandResult] => idle((state as RectState).method),
  onCancel: (state): [CommandState, CommandResult] => idle((state as RectState).method),

  // Tab-Feld-Zyklus je Schritt/Methode.
  fields: (state) => {
    const s = state as RectState;
    if (s.phase === "corner2") return s.method === "three" ? BASE_FIELDS : RECT_FIELDS;
    if (s.phase === "rise") return RISE_FIELDS;
    return [];
  },
  pointFromFields: (state, locks, cursor) => {
    const s = state as RectState;
    if (s.phase === "corner2") {
      if (s.method === "three") return baseFromFields(s.a, locks, cursor);
      if (s.method === "center") return centerCornerFromFields(s.a, locks, cursor);
      return rectCornerFromFields(s.a, locks, cursor);
    }
    if (s.phase === "rise") {
      if ("height" in locks) return riseToPoint(s.a, s.b, locks.height, cursor);
      return cursor;
    }
    return null;
  },
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as RectState;
    if (!cursor) return {};
    if (s.phase === "corner2") {
      if (s.method === "three") {
        return {
          length: segLen(s.a, cursor),
          angle: ((segAngleDeg(s.a, cursor) % 360) + 360) % 360,
        };
      }
      return { width: Math.abs(cursor.x - s.a.x) * (s.method === "center" ? 2 : 1),
               height: Math.abs(cursor.y - s.a.y) * (s.method === "center" ? 2 : 1) };
    }
    if (s.phase === "rise") return { height: Math.abs(riseFrom(s.a, s.b, cursor)) };
    return {};
  },
};

/** Vorschau passend zum Zustand. */
function draftFor(s: RectState): ToolDraft {
  if (s.phase === "corner2") {
    if (s.method === "three") return baseDraft(s.a, s.cursor);
    if (s.method === "center") return centerDraft(s.a, s.cursor);
    return cornerDraft(s.a, s.cursor);
  }
  if (s.phase === "rise") return riseDraft(s.a, s.b, s.cursor);
  return { preview: [], vertices: [] };
}
