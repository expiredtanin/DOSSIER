// [189] Zustand der einklappbaren Abschnitte der Objekt-Info: welche Abschnitte zugeklappt sind (je Viewer in
// localStorage) und die Anfrage „diesen Abschnitt aufklappen und fokussieren" (Taste T). Ausserhalb von React
// lesbar, damit der Tastendruck (`state/objectSettings.ts`) den Abschnitt auch öffnen kann, bevor das Panel
// montiert ist.

import type { InfoGroupId } from "./groups";

interface GroupState {
  collapsed: ReadonlySet<string>;
  /** Offene Fokus-Anfrage; die Gruppe löscht sie, sobald sie fokussiert hat. */
  focus: { id: InfoGroupId } | null;
}

const KEY = "dossier.objinfo.collapsed";

function load(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function save(c: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...c]));
  } catch {
    // Bestes Bemühen (Quota/privates Fenster).
  }
}

let state: GroupState = { collapsed: load(), focus: null };
const listeners = new Set<() => void>();

function set(next: GroupState): void {
  state = next;
  for (const l of [...listeners]) l();
}

export function subscribeInfoGroups(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getInfoGroupState(): GroupState {
  return state;
}

export function toggleInfoGroup(id: InfoGroupId): void {
  const c = new Set(state.collapsed);
  if (!c.delete(id)) c.add(id);
  save(c);
  set({ ...state, collapsed: c });
}

/** Klappt den Abschnitt auf und bittet ihn, den Fokus zu nehmen (sobald er sichtbar ist). */
export function expandAndFocusInfoGroup(id: InfoGroupId): void {
  const c = new Set(state.collapsed);
  c.delete(id);
  save(c);
  set({ collapsed: c, focus: { id } });
}

export function clearInfoGroupFocus(): void {
  if (state.focus) set({ ...state, focus: null });
}

/** Nur für Tests. */
export function resetInfoGroupsForTest(): void {
  state = { collapsed: new Set(), focus: null };
}
