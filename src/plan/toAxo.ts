// [266] 3D-Dokument aus dem Kern: Vektor-Axonometrie bzw. -Perspektive mit verdeckten Kanten (Abfrage `axoPlan`,
// `src-tauri/core/src/plan/axo.rs`). Liefert den Plan-Puffer wie Schnitt und Ansicht, damit SVG, PDF, DXF und Blatt
// dieselbe Ausgabe nutzen. Einheiten: Meter in der Zeichenebene (u nach rechts, v nach oben).

import type { Doc3d, Project, ViewSnapshot } from "../model/types";
import { documentFor } from "../core/document";
import { lineEndsCode } from "../model/lineEnds";
import { storedChoice } from "../model/designOptions";
import { decodePlanBuf } from "./planBuf";
import { lazyPlan } from "./planLazy";
import { visibilityArgs } from "./toSection";
import type { Plan } from "./generatePlan";

/** Vorgaben (Blick von …; Norden = +y). */
export const AXO_VIEWS = ["southeast", "southwest", "northeast", "northwest"] as const;
/** Projektionsarten der Vorgaben: Isometrie, Militär 45°/45°, Militär 30°/60°. */
export const AXO_PROJECTIONS = ["iso", "military", "military30"] as const;

export interface AxoOptions extends Doc3d {
  /** Sichtbare Klassen (fehlt: alle). Bauteile ausgeblendeter Klassen verdecken auch nichts. */
  visibleCodes?: Set<string>;
  mono?: boolean;
  /** Massstabsnenner (Strichstärken nach Massstab); Vorgabe 100. */
  scaleDenominator?: number;
  /** [271] Umbaufilter (Id oder Name) und Etappe. */
  renovation?: string;
  renovationPhase?: string;
  /** [272] Variantenkombination (Satz-Id → Varianten-Id); fehlt = Hauptvarianten. */
  designOptions?: Record<string, string>;
}

/** Kern-Abfrage `axoPlan`. */
export function axoPlanQuery(project: Project, opts: AxoOptions = {}): { name: "axoPlan"; args: number[]; text: string } {
  const { visibleCodes, mono, scaleDenominator, ...doc3d } = opts;
  const text = JSON.stringify({ ...doc3d, ...visibilityArgs(project, visibleCodes) });
  return { name: "axoPlan", args: [mono ? 1 : 0, scaleDenominator ?? 100], text };
}

/** 3D-Dokument als Plan; `null` ohne sichtbares Bauteil oder mit unbrauchbarer Kamera. */
export function generateAxoPlan(project: Project, opts: AxoOptions = {}): Plan | null {
  const q = axoPlanQuery(project, opts);
  const buf = decodePlanBuf(documentFor(project).queryBin(q.name, q.args, q.text));
  if (buf.groups.length === 0 || !buf.bounds) return null;
  const b = buf.bounds;
  return lazyPlan(
    { bounds: { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] }, lineEnds: lineEndsCode(project) },
    buf.groups.map(([from, to]) => ({ buf, from, to })),
  );
}

/** Ob ein Ausschnitt auf dem Blatt ein 3D-Dokument zeigt (Ansichtstyp „perspektive“). */
export function isDoc3dSnapshot(snap: Pick<ViewSnapshot, "viewType">): boolean {
  return snap.viewType === "perspektive";
}

/** 3D-Dokument eines Ausschnitts (Kern: `sheet_viewports::doc3d_buf`): `doc3d`, sonst sein Blickwinkel `view3d`. */
export function snapshotAxoPlan(project: Project, snap: ViewSnapshot, visibleCodes: Set<string>, scaleDenominator: number, mono = true, designOptions?: Record<string, string> | null): Plan | null {
  // [272] Variantenkombination des Ausschnitts bzw. Viewports.
  const opts = designOptions ?? storedChoice(project, snap);
  return generateAxoPlan(project, { view: snap.view3d, ...(snap.doc3d ?? {}), visibleCodes, scaleDenominator, mono, ...(opts && Object.keys(opts).length ? { designOptions: opts } : {}) });
}
