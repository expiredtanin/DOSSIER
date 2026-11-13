// [189] Zustand der einklappbaren Abschnitte der Objekt-Info: welche Abschnitte zugeklappt sind (je Viewer in
// localStorage) und die Anfrage „diesen Abschnitt aufklappen und fokussieren" (Taste T). Ausserhalb von React
// lesbar, damit der Tastendruck (`state/objectSettings.ts`) den Abschnitt auch öffnen kann, bevor das Panel
// montiert ist.

import { INFO_GROUP_DEFAULT_COLLAPSED, type InfoGroupId } from "./groups";

interface GroupState {
  /** Ausdrückliche Wahl je Abschnitt (true = offen); fehlt ein Eintrag, gilt der Standard. */
  overrides: Readonly<Record<string, boolean>>;
  /** Offene Fokus-Anfrage; die Gruppe löscht sie, sobald sie fokussiert hat. */
  focus: { id: InfoGroupId } | null;
}

// [239] Standard je Abschnitts-Art: `INFO_GROUP_DEFAULT_COLLAPSED`; nur abweichende Wahlen werden gemerkt.
const KEY = "dossier.objinfo.groups";

function load(): Readonly<Record<string, boolean>> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const o: unknown = raw ? JSON.parse(raw) : {};
    const out: Record<string, boolean> = {};
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o)) if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function save(o: Readonly<Record<string, boolean>>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    // Bestes Bemühen (Quota/privates Fenster).
  }
}

let state: GroupState = { overrides: load(), focus: null };
const listeners = new Set<() => void>();

function set(next: GroupState): void {
  state = next;
  for (const l of [...listeners]) l();
}

/** Ob der Abschnitt offen ist: gemerkte Wahl, sonst Standard. */
export function isInfoGroupOpen(st: GroupState, id: InfoGroupId): boolean {
  return st.overrides[id] ?? !INFO_GROUP_DEFAULT_COLLAPSED.has(id);
}

function withOpen(id: InfoGroupId, open: boolean): Readonly<Record<string, boolean>> {
  const o = { ...state.overrides };
  if (open === !INFO_GROUP_DEFAULT_COLLAPSED.has(id)) delete o[id];
  else o[id] = open;
  save(o);
  return o;
}

export function subscribeInfoGroups(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getInfoGroupState(): GroupState {
  return state;
}

export function toggleInfoGroup(id: InfoGroupId): void {
  set({ ...state, overrides: withOpen(id, !isInfoGroupOpen(state, id)) });
}

/** Klappt den Abschnitt auf und bittet ihn, den Fokus zu nehmen (sobald er sichtbar ist). */
export function expandAndFocusInfoGroup(id: InfoGroupId): void {
  set({ overrides: withOpen(id, true), focus: { id } });
}

export function clearInfoGroupFocus(): void {
  if (state.focus) set({ ...state, focus: null });
}

/** Nur für Tests: Zustand zurücksetzen (ohne Speicher) bzw. neu aus dem Speicher laden. */
export function resetInfoGroupsForTest(reload = false): void {
  state = { overrides: reload ? load() : {}, focus: null };
}
