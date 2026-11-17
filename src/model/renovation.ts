// [271] Umbau (Archicad „Renovation“): Status je Bauteil, Etappen, Umbaufilter. Die Regeln („sichtbar/wie gezeichnet im
// Filter F“) stehen im Kern (`src-tauri/core/src/renovation.rs`); hier nur, was die Oberfläche zum Lesen und Setzen braucht.

import type { CoreOp } from "../core/ops";
import { documentFor } from "../core/document";
import { patchItems, setField } from "../core/opsBuild";
import type { Project, Renovation, RenovationPhase, RenovationStatus } from "./types";

/** Eingebaute Umbaufilter (Ids; Namen über `t("renovation.filter.<id>")`). */
export const BUILTIN_RENOVATION_FILTERS = ["bestand", "abbruch", "neubau", "umbauplan", "endzustand"] as const;

/** Status in der Reihenfolge der Oberfläche. */
export const RENOVATION_STATUSES: readonly RenovationStatus[] = ["existing", "demolish", "new"];

/** Listen mit Umbau-Status (Räume nur Sichtbarkeit/Flächen, keine Farbe). */
export const RENOVATION_COLLECTIONS = ["walls", "openings", "ceilings", "roofs", "stairs", "columns", "extrudedSolids", "rooms"] as const;
export type RenovationCollection = (typeof RENOVATION_COLLECTIONS)[number];

/** SIA-400-Vorgabe der Umbau-Farben (gleich wie `renovation::default_style` im Kern). */
export const DEFAULT_RENOVATION_STYLES: Record<RenovationStatus, { fill: string; line?: string; dashed: boolean }> = {
  existing: { fill: "#a6a6a6", dashed: false },
  demolish: { fill: "#ffd800", dashed: true },
  new: { fill: "#e3001b", line: "#c00016", dashed: false },
};

export interface RenovationFilterEntry {
  id: string;
  name: string;
  builtin: boolean;
}

/** Eingebaute und eigene Umbaufilter (Kern-Abfrage `renovationFilters`). */
export function renovationFilterList(project: Project): RenovationFilterEntry[] {
  return documentFor(project).query<RenovationFilterEntry[]>("renovationFilters");
}

/** Status eines Elements (fehlt/unbekannt ⇒ Bestand). */
export function renovationStatus(r: Renovation | undefined | null): RenovationStatus {
  return r?.status === "demolish" || r?.status === "new" ? r.status : "existing";
}

/** Etappen des Projekts in ihrer Reihenfolge. */
export function renovationPhases(project: Project): readonly RenovationPhase[] {
  return project.renovation?.phases ?? [];
}

/**
 * Umbau-Angaben für ein neues Element nach dem aktuellen Zeichen-Status: Bestand (Vorgabe) ohne Feld, sonst Status
 * und Etappe.
 */
export function renovationForNew(status: RenovationStatus, phase?: string | null): Renovation | undefined {
  if (status === "existing" && !phase) return undefined;
  return phase ? { status, phase } : { status };
}

/**
 * Ops: Status (und Etappe) für alle Elemente mit id in `ids` setzen (ein Undo-Schritt, wenn zusammen angewandt).
 * `phase`: `undefined` = Etappe unverändert, `null` = keine Etappe. Bestand ohne Etappe entfernt das Feld.
 */
export function setRenovationOps(project: Project, ids: Iterable<string>, status: RenovationStatus | undefined, phase?: string | null): CoreOp[] {
  const set = new Set(ids);
  const ops: CoreOp[] = [];
  for (const c of RENOVATION_COLLECTIONS) {
    ops.push(
      ...patchItems(project, c, set, (e) => {
        const old = (e as { renovation?: Renovation }).renovation;
        const st = status ?? renovationStatus(old);
        const ph = phase === undefined ? old?.phase : phase ?? undefined;
        const next = renovationForNew(st, ph);
        const { renovation: _drop, ...rest } = e as { renovation?: Renovation } & Record<string, unknown>;
        void _drop;
        return (next ? { ...rest, renovation: next } : rest) as unknown as typeof e;
      }),
    );
  }
  return ops;
}

/** Element-Ids der Auswahl, die einen Umbau-Status tragen können. */
export function renovatableIds(project: Project, ids: Iterable<string>): string[] {
  const set = new Set(ids);
  const out: string[] = [];
  for (const c of RENOVATION_COLLECTIONS) {
    for (const e of (project[c] ?? []) as { id: string }[]) if (set.has(e.id)) out.push(e.id);
  }
  return out;
}

/** Gemeinsamer Status bzw. gemeinsame Etappe der Elemente `ids` (`"mixed"` bei verschiedenen Werten, `null` ohne Elemente). */
export function commonRenovation(project: Project, ids: Iterable<string>): { status: RenovationStatus | "mixed" | null; phase: string | "mixed" | null } {
  const set = new Set(ids);
  let status: RenovationStatus | "mixed" | null = null;
  let phase: string | "mixed" | null = null;
  let first = true;
  for (const c of RENOVATION_COLLECTIONS) {
    for (const e of (project[c] ?? []) as { id: string; renovation?: Renovation }[]) {
      if (!set.has(e.id)) continue;
      const s = renovationStatus(e.renovation);
      const ph = e.renovation?.phase ?? "";
      if (first) {
        status = s;
        phase = ph;
        first = false;
      } else {
        if (status !== s) status = "mixed";
        if (phase !== ph) phase = "mixed";
      }
    }
  }
  return { status, phase };
}

/** Ops: Etappen-Liste ersetzen (Namen, Reihenfolge); Elemente mit einer entfernten Etappe verlieren sie. */
export function setPhasesOps(project: Project, phases: readonly RenovationPhase[]): CoreOp[] {
  const keep = new Set(phases.map((p) => p.id));
  const settings = { ...(project.renovation ?? {}), phases: phases.length ? [...phases] : undefined };
  if (!settings.phases) delete settings.phases;
  const ops: CoreOp[] = [setField("renovation", Object.keys(settings).length ? settings : undefined)];
  for (const c of RENOVATION_COLLECTIONS) {
    ops.push(
      ...patchItems(
        project,
        c,
        (e) => {
          const ph = (e as { renovation?: Renovation }).renovation?.phase;
          return !!ph && !keep.has(ph);
        },
        (e) => {
          const r = (e as { renovation?: Renovation }).renovation!;
          const next = renovationForNew(renovationStatus(r), null);
          const { renovation: _drop, ...rest } = e as { renovation?: Renovation } & Record<string, unknown>;
          void _drop;
          return (next ? { ...rest, renovation: next } : rest) as unknown as typeof e;
        },
      ),
    );
  }
  return ops;
}

/** Nächste freie Etappen-Id. */
export function newPhaseId(project: Project): string {
  const used = new Set(renovationPhases(project).map((p) => p.id));
  let i = used.size + 1;
  while (used.has(`etappe-${i}`)) i++;
  return `etappe-${i}`;
}
