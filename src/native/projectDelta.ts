// Differenz zweier Projekt-Stände auf oberster Ebene ([121]) — für die Sync-Brücke der
// Nebenfenster. Die Leseansicht teilt unveränderte Listen (`applyOps` legt nur geänderte neu an),
// ein Referenzvergleich je Feld findet also genau die geänderten Teile. Statt des ganzen Projekts
// geht nur `{ set, unset }` über IPC; das Fenster setzt das Projekt daraus wieder zusammen.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Project } from "../model/types";

export interface ProjectDelta {
  /** Geänderte oder neue Felder (ganze Werte). */
  set: Partial<Project>;
  /** Entfernte Felder. */
  unset: string[];
}

/** Felder von `next`, deren Referenz sich gegenüber `prev` geändert hat; `null` = keine Änderung. */
export function projectDelta(prev: Project, next: Project): ProjectDelta | null {
  const a = prev as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  let changed = false;
  // `undefined` übersteht die JSON-Serialisierung der Brücke nicht: solche Felder gelten als entfernt.
  const has = (o: Record<string, unknown>, k: string) => o[k] !== undefined;
  for (const k of Object.keys(b)) {
    if (has(b, k) && a[k] !== b[k]) {
      set[k] = b[k];
      changed = true;
    }
  }
  for (const k of Object.keys(a)) {
    if (has(a, k) && !has(b, k)) {
      unset.push(k);
      changed = true;
    }
  }
  return changed ? { set: set as Partial<Project>, unset } : null;
}

/** Wendet eine Differenz an (neues Objekt; `base` bleibt unverändert). */
export function applyProjectDelta(base: Project, delta: ProjectDelta): Project {
  const out = { ...(base as unknown as Record<string, unknown>), ...(delta.set as Record<string, unknown>) };
  for (const k of delta.unset) delete out[k];
  return out as unknown as Project;
}
