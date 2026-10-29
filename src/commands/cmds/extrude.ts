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

import type {
  Command,
  CommandContext,
  CommandResult,
  CommandSelection,
  CommandState,
  Project,
  Vec2,
} from "../types";
import { createMutation, createQuery, xy } from "../createCore";

/** Persistente Extrusionshöhe über Aufrufe hinweg (Default: Geschosshöhe). */
let lastHeight = 2.6;
/** Persistente Verjüngung über Aufrufe hinweg (Default: Prisma, kein Kegel/Pyramide). */
let lastTaper = 0;

// ── Profil (Kern, `cmd_create.rs`): geschlossene polyline/rect/circle → Punktliste ─

/** Profil eines extrudierbaren 2D-Elements (Kreis: 48-Eck + Mittelpunkt/Radius). */
interface Profile {
  pts: Vec2[];
  circle?: { center: Vec2; r: number };
}

type ProfileHit = { id: string } & Profile;

function profileQuery(project: Project, req: { q: string } & Record<string, unknown>): ProfileHit | null {
  return createQuery<{ hit: (ProfileHit & { circle: Profile["circle"] | null }) | null }>(project, req).hit ?? null;
}

/** Genau EIN geeignetes Profil vorgewählt (sonst null). */
function singleSelectedProfile(project: Project, sel: CommandSelection): ProfileHit | null {
  if (!sel.drawingId || sel.wallIds.length > 0) return null;
  return profileQuery(project, { q: "profile", id: sel.drawingId });
}

/** Nächstes Profil der Ebene am Klickpunkt (Kanten-Abstand < 0.25 m). */
const pickProfileAt = (project: Project, levelId: string, pt: Vec2): ProfileHit | null =>
  profileQuery(project, { q: "pickProfile", level: levelId, pt: xy(pt) });

/** Commit (Kern): Quelle entfernen, Körper (Punkte + Höhe + Verjüngung) anlegen. */
const appendExtrudedSolid = (height: number, taper: number, sourceId: string, ctx: CommandContext) =>
  createMutation(ctx, { cmd: "extrude", source: sourceId, height, taper });

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
  height: number,
  taper: number,
  sourceId: string,
  ctx: CommandContext,
): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as ExDone,
  { draft: null, done: true, commit: appendExtrudedSolid(height, taper, sourceId, ctx) },
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
          return enterTaperPhase(pre, h, pre.id);
        }
        // Punkt im vorselektierten Fall: Höhen-Schritt betreten (HUD zeigt Default).
        const ns: ExHeight = { phase: "height", profile: pre, sourceId: pre.id, cursor: null, lastPoint: null };
        return [ns, { draft: null }];
      }
      if (input.kind === "point") {
        const hit = pickProfileAt(ctx.project, ctx.level.id, input.point);
        if (!hit) return [s, { draft: null }];
        const ns: ExHeight = { phase: "height", profile: hit, sourceId: hit.id, cursor: null, lastPoint: null };
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
      return commitTaper(ts.height, t, ts.sourceId, ctx);
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
    if (s.phase === "taper") return commitTaper(s.height, lastTaper, s.sourceId, ctx);
    return finish();
  },
  onCancel: (): [CommandState, CommandResult] => finish(),
};
