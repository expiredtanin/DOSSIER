// Regelmässiges Vieleck — Mittelpunkt + Radius, Anzahl Ecken zyklt über eine
// Inline-Option (3..12, Default 6, analog zum `count`-Zyklus bei Multiline),
// eine zweite Option „Modus" (eingeschrieben/umschrieben, analog AutoCADs
// POLYGON-Befehl):
//   • Eingeschrieben (Default): Radius = Zentrum→Eckpunkt (die Eckpunkte
//     liegen AUF dem Radius-Kreis, das Vieleck liegt IM Kreis).
//   • Umschrieben: Radius = Zentrum→Kantenmitte (Apothema) — das Vieleck
//     liegt UM den Radius-Kreis, jede Kante berührt ihn mittig. Umrechnung
//     auf den tatsächlichen Eckpunkt-Radius über `r / cos(π/n)`.
// UND eine dritte Option „Konstruktion" (Zentrum/Kante, ebenfalls analog
// AutoCADs POLYGON „Edge"-Option):
//   • Zentrum (Default): wie oben, Mittelpunkt + Radius.
//   • Kante: zwei Punkte definieren EINE Kante direkt — das Vieleck wird
//     davon ausgehend aufgebaut (nach links abbiegend, Aussenwinkel 2π/n je
//     Ecke — ein konvexes, CCW aufgebautes Vieleck). „Modus" ist hier
//     irrelevant (die Kante legt die Grösse schon eindeutig fest) und wird
//     ausgeblendet.
// Committet als geschlossene `polyline` — kein neuer Shape-Typ nötig, erbt
// dadurch Rendering/Snapping/Griffe/Export komplett vom bestehenden
// Polylinien-Pfad. Schritte:
//   • Zentrum: 1) „Mittelpunkt:" → Punkt
//              2) „Radius:" → Punkt (Abstand+Richtung des ersten Eckpunkts)
//                 ODER getippte Zahl (Radius, Richtung +X) → commit.
//   • Kante:   1) „Erster Kantenpunkt:" → Punkt
//              2) „Zweiter Kantenpunkt:" → Punkt → commit.
// Ecken-Zahl/Modus/Konstruktion per Option.

import type { Drawing2D } from "../../model/types";
import { segmentHud, uniqueId } from "../../tools/types";
import type {
  CmdOption,
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  DraftShape,
  Project,
  ToolDraft,
  Vec2,
} from "../types";
import type { TranslationKey } from "../../i18n";

const EPS = 1e-6;
const MIN_SIDES = 3;
const MAX_SIDES = 12;
const DEG = Math.PI / 180;

let lastSides = 6;

type PolygonMode = "inscribed" | "circumscribed";
let lastMode: PolygonMode = "inscribed";
const nextMode = (m: PolygonMode): PolygonMode => (m === "inscribed" ? "circumscribed" : "inscribed");
const modeValue = (m: PolygonMode): string => (m === "inscribed" ? "insc" : "circ");

/** Konstruktionsart: Zentrum+Radius (Default) oder Kante (zwei Punkte). */
type PolygonMethod = "center" | "edge";
let lastMethod: PolygonMethod = "center";
const nextConstructMethod = (m: PolygonMethod): PolygonMethod => (m === "center" ? "edge" : "center");

interface PolyP1 extends CommandState {
  phase: "p1";
  method: PolygonMethod;
}
interface PolyRadius extends CommandState {
  phase: "radius";
  method: "center";
  center: Vec2;
  cursor: Vec2 | null;
}
interface PolyEdge2 extends CommandState {
  phase: "edge2";
  method: "edge";
  a: Vec2;
  cursor: Vec2 | null;
}
type PolyState = PolyP1 | PolyRadius | PolyEdge2;

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

const RADIUS_FIELDS: CommandField[] = [{ id: "radius", labelKey: "cmd.field.radius" }];
const EDGE_FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];
const CONSTRUCT_OPTION: CmdOption = { id: "construct", labelKey: "cmd.polygon.construct" };
const SIDES_OPTION: CmdOption = { id: "sides", labelKey: "cmd.polygon.sides" };
const MODE_OPTION: CmdOption = { id: "mode", labelKey: "cmd.polygon.mode" };

/**
 * Eckpunkt-Radius aus dem EINGEGEBENEN Radius: bei „eingeschrieben" ist das
 * bereits der Eckpunkt-Radius (unverändert); bei „umschrieben" ist der
 * eingegebene Radius das Apothema (Zentrum→Kantenmitte) — der tatsächliche
 * Eckpunkt-Radius ist grösser, `apothem / cos(π/n)`.
 */
function vertexRadius(r: number, sides: number, mode: PolygonMode): number {
  return mode === "circumscribed" ? r / Math.cos(Math.PI / sides) : r;
}

/** Eckpunkte des regelmässigen Vielecks (erste Ecke Richtung `dir`), `r` = eingegebener Radius (Modus-abhängig). */
function polygonPts(center: Vec2, r: number, sides: number, mode: PolygonMode, dir: Vec2 | null): Vec2[] {
  const rv = vertexRadius(r, sides, mode);
  const t0 = dir && dist(center, dir) > EPS ? Math.atan2(dir.y - center.y, dir.x - center.x) : 0;
  const pts: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const t = t0 + (i / sides) * Math.PI * 2;
    pts.push({ x: center.x + rv * Math.cos(t), y: center.y + rv * Math.sin(t) });
  }
  return pts;
}

/**
 * Eckpunkte des regelmässigen Vielecks aus einer EINZELNEN Kante `a→b`: die
 * Kantenlänge/Richtung legt die Grösse/Drehung eindeutig fest. Läuft von `b`
 * aus nach LINKS abbiegend weiter (Aussenwinkel 2π/n je Ecke) — ein
 * konvexes, CCW aufgebautes Vieleck auf der linken Seite von a→b.
 */
function polygonFromEdge(a: Vec2, b: Vec2, sides: number): Vec2[] {
  const edgeLen = dist(a, b);
  const ext = (2 * Math.PI) / sides;
  const pts: Vec2[] = [a, b];
  let cur = b;
  let dir = Math.atan2(b.y - a.y, b.x - a.x);
  for (let i = 2; i < sides; i++) {
    dir += ext;
    const next: Vec2 = { x: cur.x + edgeLen * Math.cos(dir), y: cur.y + edgeLen * Math.sin(dir) };
    pts.push(next);
    cur = next;
  }
  return pts;
}

function polygonDraft(center: Vec2, r: number, dir: Vec2 | null, at: Vec2 | null): ToolDraft {
  if (r < EPS) return { preview: [], vertices: [center] };
  const preview: DraftShape[] = [
    { kind: "poly", pts: polygonPts(center, r, lastSides, lastMode, dir), closed: true },
  ];
  const draft: ToolDraft = { preview, vertices: [center] };
  if (at) draft.hud = { at, text: `R: ${r.toFixed(3)}m × ${lastSides}` };
  return draft;
}

/** Vorschau der Kanten-Konstruktion — zeigt das VOLLE Vieleck, sobald die Kante eine Länge hat. */
function edgeDraft(a: Vec2, cursor: Vec2 | null): ToolDraft {
  if (!cursor || dist(a, cursor) < EPS) return { preview: [{ kind: "line", a, b: a }], vertices: [a] };
  const pts = polygonFromEdge(a, cursor, lastSides);
  return { preview: [{ kind: "poly", pts, closed: true }], vertices: [a], hud: segmentHud(a, cursor) };
}

function appendPolygon(p: Project, center: Vec2, r: number, dir: Vec2 | null, ctx: CommandContext): Project {
  if (r < EPS) return p;
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "polyline", pts: polygonPts(center, r, lastSides, lastMode, dir), closed: true },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

function appendPolygonFromEdge(p: Project, a: Vec2, b: Vec2, ctx: CommandContext): Project {
  if (dist(a, b) < EPS) return p;
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "polyline", pts: polygonFromEdge(a, b, lastSides), closed: true },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "p1", method: lastMethod, lastPoint: null } as PolyP1,
  { draft: null, done: true },
];

function promptKey(s: PolyState): TranslationKey {
  if (s.phase === "p1") return s.method === "edge" ? "cmd.polygon.edgeStart" : "cmd.polygon.center";
  if (s.phase === "edge2") return "cmd.polygon.edgeEnd";
  return "cmd.polygon.radius";
}

export const polygonCommand: Command = {
  name: "polygon",
  labelKey: "cmd.polygon.label",
  prompt: (s) => promptKey(s as PolyState),
  accepts: (s) => ((s as PolyState).phase === "radius" ? ["point", "number", "option"] : ["point", "option"]),
  options: (s) => {
    const st = s as PolyState;
    // „Konstruktion" und „Ecken" sind IMMER wählbar (auch vor dem ersten
    // Klick — die Eckenzahl betrifft beide Konstruktionsarten gleichermassen);
    // „Modus" (eingeschrieben/umschrieben) ist NUR bei der Zentrum-Methode
    // sinnvoll, dort ausserdem erst NACH dem Zentrum-Klick sichtbar (Radius
    // bezieht sich auf den geklickten Mittelpunkt).
    const base: CmdOption[] = [
      { ...CONSTRUCT_OPTION, value: st.method },
      { ...SIDES_OPTION, value: String(lastSides) },
    ];
    if (st.phase === "radius") {
      return [...base, { ...MODE_OPTION, value: modeValue(lastMode) }];
    }
    return base;
  },
  init: (): PolyP1 => ({ phase: "p1", method: lastMethod, lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as PolyState;

    if (input.kind === "option") {
      if (input.id === "construct") {
        lastMethod = nextConstructMethod(s.method);
        return [{ phase: "p1", method: lastMethod, lastPoint: null } as PolyP1, { draft: null }];
      }
      if (input.id === "sides") {
        lastSides = lastSides >= MAX_SIDES ? MIN_SIDES : lastSides + 1;
        if (s.phase === "radius") {
          const r = s.cursor ? dist(s.center, s.cursor) : 0;
          return [s, { draft: polygonDraft(s.center, r, s.cursor, s.cursor) }];
        }
        if (s.phase === "edge2") return [s, { draft: edgeDraft(s.a, s.cursor) }];
        return [s, { draft: null }];
      }
      if (input.id === "mode" && s.phase === "radius") {
        lastMode = nextMode(lastMode);
        const r = s.cursor ? dist(s.center, s.cursor) : 0;
        return [s, { draft: polygonDraft(s.center, r, s.cursor, s.cursor) }];
      }
      return [s, { draft: null }];
    }

    if (s.phase === "p1") {
      if (input.kind !== "point") return [s, { draft: null }];
      if (s.method === "edge") {
        const ns: PolyEdge2 = { phase: "edge2", method: "edge", a: input.point, cursor: input.point, lastPoint: input.point };
        return [ns, { draft: edgeDraft(input.point, input.point) }];
      }
      const ns: PolyRadius = { phase: "radius", method: "center", center: input.point, cursor: input.point, lastPoint: input.point };
      return [ns, { draft: polygonDraft(input.point, 0, null, null) }];
    }

    if (s.phase === "edge2") {
      if (input.kind !== "point" || dist(s.a, input.point) < EPS) {
        return [s, { draft: edgeDraft(s.a, s.cursor) }];
      }
      const a = s.a;
      const b = input.point;
      return [idle()[0], { draft: null, done: true, commit: (p) => appendPolygonFromEdge(p, a, b, ctx) }];
    }

    // phase "radius"
    let r: number;
    let dir: Vec2 | null;
    if (input.kind === "number") {
      r = input.value;
      dir = s.cursor;
    } else if (input.kind === "point") {
      r = dist(s.center, input.point);
      dir = input.point;
    } else {
      const rr = s.cursor ? dist(s.center, s.cursor) : 0;
      return [s, { draft: polygonDraft(s.center, rr, s.cursor, s.cursor) }];
    }
    const center = s.center;
    return [
      idle()[0],
      { draft: null, done: true, commit: (p) => appendPolygon(p, center, r, dir, ctx) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as PolyState;
    if (s.phase === "radius") {
      const r = dist(s.center, point);
      const ns: PolyRadius = { ...s, cursor: point };
      return [ns, { draft: polygonDraft(s.center, r, point, point) }];
    }
    if (s.phase === "edge2") {
      const ns: PolyEdge2 = { ...s, cursor: point };
      return [ns, { draft: edgeDraft(s.a, point) }];
    }
    return [s, { draft: null }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),

  fields: (state) => {
    const s = state as PolyState;
    if (s.phase === "radius") return RADIUS_FIELDS;
    if (s.phase === "edge2") return EDGE_FIELDS;
    return [];
  },
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as PolyState;
    if (!cursor) return {};
    if (s.phase === "radius") return { radius: dist(s.center, cursor) };
    if (s.phase === "edge2") {
      return { length: dist(s.a, cursor), angle: ((segAngleDeg(s.a, cursor) % 360) + 360) % 360 };
    }
    return {};
  },
  pointFromFields: (state, locks, cursor) => {
    const s = state as PolyState;
    if (s.phase === "radius") {
      const r = "radius" in locks ? Math.abs(locks.radius) : cursor ? dist(s.center, cursor) : 0;
      if (cursor) {
        const d = dist(s.center, cursor);
        if (d > EPS) {
          return {
            x: s.center.x + ((cursor.x - s.center.x) / d) * r,
            y: s.center.y + ((cursor.y - s.center.y) / d) * r,
          };
        }
      }
      return { x: s.center.x + r, y: s.center.y };
    }
    if (s.phase === "edge2") {
      const ref = cursor ?? s.a;
      const length = "length" in locks ? locks.length : dist(s.a, ref);
      const angleDeg = "angle" in locks ? locks.angle : segAngleDeg(s.a, ref);
      const ang = angleDeg * DEG;
      return { x: s.a.x + Math.cos(ang) * length, y: s.a.y + Math.sin(ang) * length };
    }
    return null;
  },
};
