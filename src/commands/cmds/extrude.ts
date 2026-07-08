// Extrudieren — truck-Integration Phase 3 (docs/design/truck-plan.md, PENDENZEN
// "truck-Integration"). Erzeugt aus einer geschlossenen 2D-Kurve (Polylinie-Ring,
// Rechteck oder Kreis) einen 3D-Körper: Schritte:
//   1) Profil bestimmen: ist genau EIN passendes geschlossenes Drawing2D
//      selektiert, wird es genommen; sonst „Profil wählen:" → Klick auf einen Ring.
//   2) „Höhe:" → Zahl tippen (PERSISTENT als Default über Aufrufe) ODER Enter
//      bestätigt den zuletzt genutzten Default.
//   3) „Verjüngung:" → Zahl 0..1 tippen (0=Prisma/Default, 1=Spitze — Kegel bei
//      Kreis-, Pyramide bei Polygon-Profil) ODER Enter für den zuletzt
//      genutzten Default (persistent, wie Höhe). → commit neues ExtrudedSolid.
//
// Die eigentliche Extrusion (truck-WASM) läuft asynchron erst in toWalls3d.ts
// (emitExtrudedSolids); dieser Befehl legt nur die Rohdaten (Punkte + Höhe +
// Verjüngung) im Projekt ab.

import type { Drawing2D, ExtrudedSolid } from "../../model/types";
import { uniqueId } from "../../tools/types";
import { polylineEdges, pointSegmentDistance } from "../../geometry/kernel2d";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandSelection,
  CommandState,
  Project,
  Vec2,
} from "../types";

const HIT_TOL = 0.25; // Modell-Meter: Pick-Toleranz für die Profil-Wahl

/** Persistente Extrusionshöhe über Aufrufe hinweg (Default: Geschosshöhe). */
let lastHeight = 2.6;
/** Persistente Verjüngung über Aufrufe hinweg (Default: Prisma, kein Kegel/Pyramide). */
let lastTaper = 0;

// ── Profil-Abstraktion: geschlossene polyline/rect/circle → Punktliste ─────

/** Kreis-Tessellierung für Footprint/Auswahl/bbox (48-Eck, wie circle.ts). */
function circlePts(center: Vec2, r: number): Vec2[] {
  const N = 48;
  const pts: Vec2[] = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    pts.push({ x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) });
  }
  return pts;
}

/** Ein extrudierfähiges Profil: Tessellierung + optional die echte Kreis-Geometrie. */
interface Profile {
  pts: Vec2[];
  circle?: { center: Vec2; r: number };
}

/** Wandelt ein extrudierfähiges (geschlossenes) Drawing2D in ein Profil. */
function geomToProfile(d: Drawing2D): Profile | null {
  const g = d.geom;
  if (g.shape === "polyline" && g.closed && g.pts.length >= 3) return { pts: g.pts };
  if (g.shape === "rect") {
    return { pts: [g.min, { x: g.max.x, y: g.min.y }, g.max, { x: g.min.x, y: g.max.y }] };
  }
  if (g.shape === "circle") {
    return { pts: circlePts(g.center, g.r), circle: { center: g.center, r: g.r } };
  }
  return null;
}

/** Genau ein passendes Drawing2D vorselektiert? Dann liefere sein Profil. */
function singleSelectedProfile(
  project: Project,
  sel: CommandSelection,
): ({ d: Drawing2D } & Profile) | null {
  if (!sel.drawingId || sel.wallIds.length > 0) return null;
  const d = project.drawings2d.find((x) => x.id === sel.drawingId);
  if (!d) return null;
  const profile = geomToProfile(d);
  return profile ? { d, ...profile } : null;
}

/** Nächstes extrudierfähige Drawing2D zum Klickpunkt (innerhalb Toleranz). */
function pickProfileAt(
  project: Project,
  levelId: string,
  pt: Vec2,
): ({ d: Drawing2D } & Profile) | null {
  let best: ({ d: Drawing2D } & Profile) | null = null;
  let bestD = HIT_TOL;
  for (const d of project.drawings2d) {
    if (d.levelId !== levelId) continue;
    const profile = geomToProfile(d);
    if (!profile) continue;
    for (const [a, b] of polylineEdges(profile.pts, true)) {
      const dd = pointSegmentDistance(pt, a, b);
      if (dd < bestD) {
        bestD = dd;
        best = { d, ...profile };
      }
    }
  }
  return best;
}

/**
 * Hängt den neuen Körper an UND entfernt das Quell-Profil (`sourceId`) aus
 * `drawings2d` — die Polylinie/das Rechteck WIRD zur Extrusion, sie bleibt
 * nicht als unabhängiges Duplikat liegen (sonst zwei Objekte am selben Ort,
 * eines davon im Grundriss unsichtbar verwaist).
 */
function appendExtrudedSolid(
  p: Project,
  profile: Profile,
  height: number,
  taper: number,
  sourceId: string,
  ctx: CommandContext,
): Project {
  const solid: ExtrudedSolid = {
    id: uniqueId("extrude"),
    type: "extrudedSolid",
    levelId: ctx.level.id,
    points: profile.pts,
    height,
    circle: profile.circle,
    ...(taper > 0 ? { taper } : {}),
  };
  return {
    ...p,
    drawings2d: p.drawings2d.filter((d) => d.id !== sourceId),
    extrudedSolids: [...(p.extrudedSolids ?? []), solid],
  };
}

// ── Zustand ───────────────────────────────────────────────────────────────────

interface ExPick extends CommandState {
  phase: "pick";
}
interface ExHeight extends CommandState {
  phase: "height";
  profile: Profile;
  /** Id des Quell-Drawing2D, das beim Commit ersetzt (entfernt) wird. */
  sourceId: string;
  cursor: Vec2 | null;
}
interface ExTaper extends CommandState {
  phase: "taper";
  profile: Profile;
  sourceId: string;
  height: number;
  cursor: Vec2 | null;
}
interface ExDone extends CommandState {
  phase: "done";
}
type ExState = ExPick | ExHeight | ExTaper | ExDone;

const finish = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as ExDone,
  { draft: null, done: true },
];

/** Höhe entgegengenommen → Verjüngungs-Schritt betreten (HUD zeigt Default). */
const enterTaperPhase = (
  profile: Profile,
  height: number,
  sourceId: string,
): [CommandState, CommandResult] => [
  { phase: "taper", profile, sourceId, height, cursor: null } as ExTaper,
  { draft: null },
];

const commitTaper = (
  profile: Profile,
  height: number,
  taper: number,
  sourceId: string,
  ctx: CommandContext,
): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as ExDone,
  { draft: null, done: true, commit: (p) => appendExtrudedSolid(p, profile, height, taper, sourceId, ctx) },
];

export const extrudeCommand: Command = {
  name: "extrude",
  labelKey: "cmd.extrude.label",
  prompt: (s) => {
    const phase = (s as ExState).phase;
    if (phase === "height") return "cmd.extrude.height";
    if (phase === "taper") return "cmd.extrude.taper";
    return "cmd.extrude.pick";
  },
  // Auch der „pick"-Schritt nimmt eine Zahl an, damit eine getippte Höhe sofort
  // greift, wenn ein Profil vorselektiert ist (dann wird „pick" live wie
  // „height" behandelt — analog offset.ts).
  accepts: () => ["point", "number"],
  options: () => [],
  floorOnly: true,

  init: (): ExPick => ({ phase: "pick", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as ExState;
    if (s.phase === "done") return finish();

    if (s.phase === "pick") {
      const pre = singleSelectedProfile(ctx.project, ctx.selection);
      if (pre) {
        if (input.kind === "number") {
          const h = Math.abs(input.value);
          if (h < 1e-6) return [s, { draft: null }];
          lastHeight = h;
          return enterTaperPhase(pre, h, pre.d.id);
        }
        // Punkt im vorselektierten Fall: Höhen-Schritt betreten (HUD zeigt Default).
        const ns: ExHeight = { phase: "height", profile: pre, sourceId: pre.d.id, cursor: null, lastPoint: null };
        return [ns, { draft: null }];
      }
      if (input.kind === "point") {
        const hit = pickProfileAt(ctx.project, ctx.level.id, input.point);
        if (!hit) return [s, { draft: null }];
        const ns: ExHeight = { phase: "height", profile: hit, sourceId: hit.d.id, cursor: null, lastPoint: null };
        return [ns, { draft: null }];
      }
      return [s, { draft: null }];
    }

    if (s.phase === "height") {
      if (input.kind === "number") {
        const h = Math.abs(input.value);
        if (h < 1e-6) return [s, { draft: null }];
        lastHeight = h;
        return enterTaperPhase(s.profile, h, s.sourceId);
      }
      return [s, { draft: null }];
    }

    // phase === "taper"
    const ts = s as ExTaper;
    if (input.kind === "number") {
      const t = Math.min(1, Math.max(0, input.value));
      lastTaper = t;
      return commitTaper(ts.profile, ts.height, t, ts.sourceId, ctx);
    }
    return [ts, { draft: null }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as ExState;
    if (s.phase === "height") {
      const ns: ExHeight = { ...s, cursor: point };
      return [
        ns,
        {
          draft: {
            preview: [{ kind: "poly", pts: s.profile.pts, closed: true }],
            vertices: [],
            hud: { at: point, text: `${lastHeight.toFixed(2)} m` },
          },
        },
      ];
    }
    if (s.phase === "taper") {
      const ns: ExTaper = { ...s, cursor: point };
      return [
        ns,
        {
          draft: {
            preview: [{ kind: "poly", pts: s.profile.pts, closed: true }],
            vertices: [],
            hud: { at: point, text: lastTaper.toFixed(2) },
          },
        },
      ];
    }
    return [s, { draft: null }];
  },

  // Enter/Rechtsklick: Höhen-Schritt → Default-Höhe übernehmen + Verjüngungs-
  // Schritt betreten; Verjüngungs-Schritt → Default-Verjüngung übernehmen + committen.
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as ExState;
    if (s.phase === "height") return enterTaperPhase(s.profile, lastHeight, s.sourceId);
    if (s.phase === "taper") return commitTaper(s.profile, s.height, lastTaper, s.sourceId, ctx);
    return finish();
  },
  onCancel: (): [CommandState, CommandResult] => finish(),
};
