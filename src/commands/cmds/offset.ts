// Offset — DAS Architektur-Primitiv (docs §2.10/§3.4 Tier-1, §3.6 persistente
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

import type { Drawing2D, Drawing2DGeom } from "../../model/types";
import { bulgeArcPoints, hasRealBulge } from "../../core";
import { uniqueId } from "../../tools/types";
import { leftNormal, normalize, sub } from "../../model/geometry";
import { offsetPolyline, offsetPolylineWithBulge, offsetSegment, pointSegmentDistance, polylineEdges } from "../../core";
import type {
  CmdInput,
  Command,
  CommandContext,
  CommandResult,
  CommandSelection,
  CommandState,
  DraftShape,
  Project,
  Vec2,
} from "../types";

const EPS = 1e-6;
const HIT_TOL = 0.25; // Modell-Meter: Pick-Toleranz für die Kurvenwahl

/**
 * Persistente Offset-Distanz über Aufrufe hinweg (§2.4/§3.6 — Nutzer erwarten,
 * dass die letzte Distanz als Default wiederkommt). Modulweite Variable, |d|;
 * das Vorzeichen (Seite) wird je Offset frisch aus Klick/Eingabe bestimmt.
 */
let lastDistance = 0.5;
/** Zuletzt gewählte Seite als Vorzeichen (+1 = links, −1 = rechts). */
let lastSign = 1;

// ── Kurven-Abstraktion: line/polyline/rect → Punktliste + closed ──────────────

interface Curve {
  pts: Vec2[];
  closed: boolean;
  /** Bogen-Segmente (DXF-bulge, s. `geometry/bulge.ts`) — nur bei polyline. */
  bulge?: number[];
}

/** Wandelt eine offset-fähige 2D-Form in eine Punktliste (+closed[/bulge]) oder null. */
function geomToCurve(g: Drawing2DGeom): Curve | null {
  if (g.shape === "line") return { pts: [g.a, g.b], closed: false };
  if (g.shape === "polyline") return { pts: g.pts, closed: g.closed, bulge: g.bulge };
  if (g.shape === "rect") {
    // Rechteck als geschlossene 4-Punkt-Polylinie offsetten (Task).
    return {
      pts: [
        g.min,
        { x: g.max.x, y: g.min.y },
        g.max,
        { x: g.min.x, y: g.max.y },
      ],
      closed: true,
    };
  }
  return null; // circle/arc/text: hier nicht offset-fähig
}

/** Ist diese Form offset-fähig (line/polyline/rect)? */
function isOffsetable(d: Drawing2D): boolean {
  const g = d.geom;
  return g.shape === "line" || g.shape === "polyline" || g.shape === "rect";
}

/** Genau ein passendes Drawing2D vorselektiert? Dann liefere es. */
function singleSelectedCurve(project: Project, sel: CommandSelection): Drawing2D | null {
  if (!sel.drawingId || sel.wallIds.length > 0) return null;
  const d = project.drawings2d.find((x) => x.id === sel.drawingId);
  if (d && isOffsetable(d)) return d;
  return null;
}

/**
 * Kanten für Klick-Trefftests/Vorschau: bei Bogen-Segmenten (bulge) wird die
 * Kurve zu Geradenstücken tesselliert (`bulgeArcPoints`), damit Klick-/Seiten-
 * Tests entlang der TATSÄCHLICHEN (runden) Kontur funktionieren statt entlang
 * der geraden Sehne. Die eigentliche Offset-Geometrie bleibt exakt (bulge-
 * erhaltend, s. `offsetPolylineWithBulge`) — nur diese Hilfsfunktion approximiert.
 */
function curveHitEdges(curve: Curve): [Vec2, Vec2][] {
  if (!hasRealBulge(curve.bulge)) return polylineEdges(curve.pts, curve.closed);
  const n = curve.pts.length;
  const edgeCount = curve.closed ? n : n - 1;
  const chain: Vec2[] = [curve.pts[0]];
  for (let i = 0; i < edgeCount; i++) {
    const seg = bulgeArcPoints(curve.pts[i], curve.pts[(i + 1) % n], curve.bulge?.[i]);
    chain.push(...seg.slice(1));
  }
  return polylineEdges(chain, false); // Schlusskante (falls closed) ist bereits mit-tesselliert
}

/** Nächstes offset-fähiges Drawing2D zum Klickpunkt (innerhalb Toleranz). */
function pickCurveAt(project: Project, levelId: string, pt: Vec2): Drawing2D | null {
  let best: Drawing2D | null = null;
  let bestD = HIT_TOL;
  for (const d of project.drawings2d) {
    if (d.levelId !== levelId) continue;
    const curve = geomToCurve(d.geom);
    if (!curve) continue;
    for (const [a, b] of curveHitEdges(curve)) {
      const dd = pointSegmentDistance(pt, a, b);
      if (dd < bestD) {
        bestD = dd;
        best = d;
      }
    }
  }
  return best;
}

/**
 * Vorzeichen (+links / −rechts) für einen Klickpunkt relativ zur Kurve: die
 * nächste Kante bestimmen, dann das Vorzeichen der Skalarprojektion von
 * (klick − Kantenmitte) auf die LINKS-Normale der Kante. So zeigt das Resultat
 * auf die angeklickte Seite (Konvention `+d = links`).
 */
function sideSign(curve: Curve, pt: Vec2): number {
  let bestD = Infinity;
  let sign = lastSign;
  for (const [a, b] of curveHitEdges(curve)) {
    const mid: Vec2 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dd = pointSegmentDistance(pt, a, b);
    if (dd < bestD) {
      bestD = dd;
      const u = normalize(sub(b, a));
      const n = leftNormal(u);
      const rel = sub(pt, mid);
      const s = rel.x * n.x + rel.y * n.y;
      sign = s >= 0 ? 1 : -1;
    }
  }
  return sign;
}

/** Offset einer Kurve um die vorzeichenbehaftete Distanz `d` → neue Geometrie (bulge-erhaltend). */
function offsetCurveGeom(curve: Curve, d: number): { pts: Vec2[]; bulge?: number[] } {
  if (!curve.closed && curve.pts.length === 2 && !hasRealBulge(curve.bulge)) {
    const [a, b] = offsetSegment(curve.pts[0], curve.pts[1], d);
    return { pts: [a, b] };
  }
  if (hasRealBulge(curve.bulge)) {
    return offsetPolylineWithBulge(curve.pts, curve.bulge, d, curve.closed);
  }
  return { pts: offsetPolyline(curve.pts, d, curve.closed) };
}

/** Versetzte Form als neues Drawing2D (gleiche Attribute, neue ID/Geometrie). */
function offsetGeom(src: Drawing2D, d: number): Drawing2DGeom | null {
  const curve = geomToCurve(src.geom);
  if (!curve) return null;
  const { pts, bulge } = offsetCurveGeom(curve, d);
  if (src.geom.shape === "line" && pts.length === 2) {
    return { shape: "line", a: pts[0], b: pts[1] };
  }
  const geom: Drawing2DGeom = { shape: "polyline", pts, closed: curve.closed };
  if (bulge && hasRealBulge(bulge)) geom.bulge = bulge;
  return geom;
}

/** Vorschau-Formen der versetzten Kurve (für den Draft — tesselliert, s. `DraftShape`). */
function offsetDraftShapes(curve: Curve, d: number): DraftShape[] {
  const { pts, bulge } = offsetCurveGeom(curve, d);
  if (pts.length < 2) return [];
  if (!curve.closed && pts.length === 2 && !hasRealBulge(bulge)) {
    return [{ kind: "line", a: pts[0], b: pts[1] }];
  }
  const tess = hasRealBulge(bulge)
    ? curveHitEdges({ pts, closed: curve.closed, bulge }).reduce<Vec2[]>((out, [a, b], i) => {
        if (i === 0) out.push(a);
        out.push(b);
        return out;
      }, [])
    : pts;
  return [{ kind: "poly", pts: tess, closed: curve.closed }];
}

function appendOffset(p: Project, src: Drawing2D, d: number): Project {
  const geom = offsetGeom(src, d);
  if (!geom) return p;
  const copy: Drawing2D = { ...src, id: uniqueId("dr2d"), geom };
  return { ...p, drawings2d: [...p.drawings2d, copy] };
}

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

/** Aktuelle Kurve aus dem Side-Zustand (oder null, wenn weg). */
function curveOf(project: Project, drawingId: string): { src: Drawing2D; curve: Curve } | null {
  const src = project.drawings2d.find((x) => x.id === drawingId);
  if (!src) return null;
  const curve = geomToCurve(src.geom);
  if (!curve) return null;
  return { src, curve };
}

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
        const hit = pickCurveAt(ctx.project, ctx.level.id, input.point);
        if (!hit) return [s, { draft: null }];
        const ns: OffSide = { phase: "side", drawingId: hit.id, cursor: null, lastPoint: null };
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
  const cc = curveOf(ctx.project, s.drawingId);
  if (!cc) return finish();
  const { src, curve } = cc;

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
      { draft: null, done: true, commit: (p) => appendOffset(p, src, d) },
    ];
  }

  if (input.kind === "point") {
    // Seite per Klick: Vorzeichen aus der Klickseite, Betrag = letzte Distanz.
    const sign = sideSign(curve, input.point);
    lastSign = sign;
    const d = sign * lastDistance;
    return [
      { phase: "done", lastPoint: null } as OffDone,
      { draft: null, done: true, commit: (p) => appendOffset(p, src, d) },
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
  const cc = curveOf(ctx.project, s.drawingId);
  if (!cc) return [s, { draft: null }];
  const { curve } = cc;
  const sign = sideSign(curve, point);
  const d = sign * lastDistance;
  const preview = offsetDraftShapes(curve, d);
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
