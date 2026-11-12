// [205] Pausfolie (Archicad „Pausfolie & Referenz“): eine andere Ansicht gedämpft hinter (oder über) der aktiven.
//
// Dünne Fassade über der Kern-Abfrage `tracePlan` (`src-tauri/core/src/plan/trace.rs`): Die Quelle stellt diese
// Datei als Teil-Abfragen genau so zusammen, wie die Ansicht der Quelle selbst sie stellt — Grundriss/Zeichnung/
// Deckenspiegel `planDomains`, Schnitt `sectionPlan` (+ seine eigenen 2D-Elemente), Ansicht `elevationPlan`
// (+ 2D-Elemente) —; der Kern richtet aus (Schnitt an der Linie aufgeklappt, Grundriss unter den Schnitt), wendet
// Verschieben/Drehen an, nimmt die Auswahl-Ids weg und färbt. Die Pause ist nie anwählbar und nie im Druck.

import type { DetailLevel, DrawingLevel, Project, TraceReference } from "../model/types";
import { documentFor } from "../core/document";
import { decodePlanBuf } from "./planBuf";
import { lazyPlan, piecesOf, planCount, planFields } from "./planLazy";
import { planDomainsQuery, type Plan } from "./generatePlan";
import { SHOW_ALL, type CategoryDisplayResolver } from "./generatePlan/shared";
import { prepareSection, sectionPlanQuery, type SectionOutput } from "./toSection";
import { elevationPlanQuery } from "./toElevation";

/** Darstellung der Quelle (wie die Ansicht der Quelle sie hätte). */
export interface TraceContext {
  visibleCodes: Set<string>;
  categoryDisplay?: CategoryDisplayResolver;
  detail?: DetailLevel;
  referenceLines?: boolean;
  mono?: boolean;
  scaleDenominator?: number;
  /** Ausmass der aktiven Ansicht (Aufklappen eines Schnitts jenseits des Grundrisses, Grundriss unter dem Schnitt). */
  activeBounds?: Plan["bounds"];
}

/** Vorgaben einer neuen Pausfolie: Grau, halbe Deckkraft, unter der Ansicht, nicht verschoben. */
export function defaultTrace(sourceId: string): TraceReference {
  return { sourceId, show: true, opacity: 0.5, offset: { x: 0, y: 0 }, rotation: 0 };
}

/** Darf `source` Pausfolie der aktiven Ebene sein? Nicht sie selbst, kein Blatt (Papier-Raum eines Layouts). */
export function traceSourceAllowed(active: DrawingLevel, source: DrawingLevel): boolean {
  return source.id !== active.id && !source.layoutId && !active.layoutId;
}

// Vorbereitete Schnitte je Projektstand und Ebene: der Schnitt-Cache des Kerns hängt am Schlüssel, ein neuer
// Schlüssel je Aufruf rechnete den Schnitt bei jedem Darstellungswechsel neu.
const sections = new WeakMap<Project, Map<DrawingLevel, SectionOutput | null>>();
function sectionOf(project: Project, level: DrawingLevel): SectionOutput | null {
  let m = sections.get(project);
  if (!m) sections.set(project, (m = new Map()));
  if (!m.has(level)) m.set(level, prepareSection(project, level));
  return m.get(level) ?? null;
}

/** Teil-Abfragen der Quelle (s. Kopf). */
function sourceParts(project: Project, active: DrawingLevel, source: DrawingLevel, ctx: TraceContext) {
  const cd = ctx.categoryDisplay ?? SHOW_ALL;
  const detail = ctx.detail ?? "mittel";
  const scale = ctx.scaleDenominator ?? 100;
  const mono = !!ctx.mono;
  // Die eigenen 2D-Elemente der Quelle (bei Schnitt/Ansicht: Bemassung, Koten, Beschriftung im Blatt-Raum).
  // Achsraster, die auch in der aktiven Ebene stehen, nur einmal (wie [203]).
  const planLike = (l: DrawingLevel) => l.kind === "floor" || l.kind === "drawing" || l.kind === "ceiling";
  const own = planDomainsQuery(source.id, ctx.visibleCodes, cd, detail, !!ctx.referenceLines, mono, scale, planLike(active) && planLike(source) ? active.id : null);
  if (source.kind === "section") {
    const out = sectionOf(project, source);
    if (!out) return [];
    const q = sectionPlanQuery(out, mono, { hiddenLines: source.hiddenLines, visibleCodes: ctx.visibleCodes, categoryDisplay: cd, openings: true, scaleDenominator: scale, detail });
    return [{ name: q.name, args: [...q.args], text: q.text }, own];
  }
  if (source.kind === "elevation") {
    const q = elevationPlanQuery(project, source, { mono, visibleCodes: ctx.visibleCodes, categoryDisplay: cd, scaleDenominator: scale });
    return [q, own];
  }
  return [own];
}

/**
 * Plan der Pausfolie `trace` hinter/über der Ebene `active`; `null`, wenn ausgeschaltet, ohne (gültige) Quelle
 * oder leer. Einheiten der Quelle bleiben Meter (ein Schnitt im Grundriss misst u längs seiner Linie und die Höhe).
 */
export function tracePlan(project: Project, active: DrawingLevel, trace: TraceReference | null | undefined, ctx: TraceContext): Plan | null {
  if (!trace?.show) return null;
  const source = project.drawingLevels.find((l) => l.id === trace.sourceId);
  if (!source || !traceSourceAllowed(active, source)) return null;
  const parts = sourceParts(project, active, source, ctx);
  if (parts.length === 0) return null;
  const b = ctx.activeBounds;
  const text = JSON.stringify({
    parts,
    source: source.id,
    active: active.id,
    ...(b && Number.isFinite(b.minX) ? { activeBounds: [b.minX, b.minY, b.maxX, b.maxY] } : {}),
    ...(trace.color ? { color: trace.color } : {}),
    opacity: trace.opacity,
    offset: trace.offset,
    rotation: trace.rotation,
    above: !!trace.above,
  });
  const buf = decodePlanBuf(documentFor(project).queryBin("tracePlan", [], text));
  if (buf.groups.length === 0 || buf.count === 0) return null;
  const [minX, minY, maxX, maxY] = buf.bounds ?? [0, 0, 1, 1];
  return lazyPlan({ bounds: { minX, minY, maxX, maxY } }, buf.groups.map(([from, to]) => ({ buf, from, to })));
}

/**
 * Legt die Pause unter (`above` = false) bzw. über den Plan, ohne dessen Primitive zu lesen. Das Ausmass des Plans
 * bleibt (Einpassen zeigt die Ansicht, nicht die Pause); gedimmte Bereiche rücken mit.
 */
export function withTrace(plan: Plan, trace: Plan | null, above = false): Plan {
  if (!trace) return plan;
  const n = planCount(trace);
  if (n === 0) return plan;
  const rest = planFields(plan);
  const shift = above ? 0 : n;
  const greyed = plan.greyedRanges?.map(([a, c]): [number, number] => [a + shift, c + shift]);
  const pieces = above ? [...piecesOf(plan), ...piecesOf(trace)] : [...piecesOf(trace), ...piecesOf(plan)];
  return lazyPlan({ ...rest, ...(greyed ? { greyedRanges: greyed } : {}) }, pieces);
}
