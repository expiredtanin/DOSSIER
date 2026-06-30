// Globaler Store — dependency-freier Kern (useSyncExternalStore).
//
// Bewusst leichtgewichtig: kein Zustand-/Redux-Paket, sondern ein winziger
// Store nach demselben Muster wie src/i18n (externe Quelle + React-Hook). Er
// kombiniert die Slices (project/selection/view/layout) zu EINEM Zustand und
// bietet selektives Lesen über `useStore(selector)`, sodass Komponenten nur bei
// Änderung ihres Ausschnitts neu rendern (kein Re-Render-Sturm, kein
// Prop-Drilling).
//
// Eine Slice ist eine Factory `(set, get) => ({ ...state, ...actions })`. `set`
// nimmt ein Teil-Patch ODER eine Updater-Funktion (wie React-setState); `get`
// liest den aktuellen Gesamtzustand. Actions leben damit IM Zustand (z. B.
// `useStore(s => s.addFloor)`), genau wie in der Spec (state-architecture.md).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useSyncExternalStore } from "react";

/** Patch-Form für `set`: Teilobjekt oder Updater über den Gesamtzustand. */
export type SetStatePatch<T> = Partial<T> | ((state: T) => Partial<T>);

/** Was eine Slice-Factory bekommt, um Zustand zu lesen/schreiben. */
export type StoreApi<T> = {
  /** Schreibt ein Teil-Patch (oder Updater) und benachrichtigt Abonnenten. */
  set: (patch: SetStatePatch<T>) => void;
  /** Liefert den aktuellen Gesamtzustand (für Actions, die andere Felder lesen). */
  get: () => T;
};

/** Eine Slice: Factory, die ihren Zustands-/Action-Ausschnitt liefert. */
export type SliceCreator<T, S> = (api: StoreApi<T>) => S;

/** Öffentliche Store-Schnittstelle (Hook + imperative Helfer). */
export interface Store<T> {
  /** React-Hook: liest einen Ausschnitt; rendert nur bei dessen Änderung neu. */
  useStore: <U>(selector: (state: T) => U) => U;
  /** Imperatives Lesen (außerhalb von React, z. B. in Event-Handlern). */
  getState: () => T;
  /** Imperatives Schreiben (Teil-Patch oder Updater). */
  setState: (patch: SetStatePatch<T>) => void;
  /** Abonnement (selten direkt nötig; useStore nutzt es intern). */
  subscribe: (listener: () => void) => () => void;
}

/**
 * Baut den Store aus einer Initializer-Funktion, die mit `(set, get)` den
 * kompletten Zustand (Felder + Actions) erzeugt. Der Zustand wird flach mit dem
 * Patch zusammengeführt (`{ ...state, ...patch }`); für tiefe/immutable Updates
 * sind die Actions selbst verantwortlich (sie liefern fertige neue Werte).
 */
export function createStore<T>(init: SliceCreator<T, T>): Store<T> {
  let state: T;
  const listeners = new Set<() => void>();

  const set: StoreApi<T>["set"] = (patch) => {
    const partial = typeof patch === "function" ? (patch as (s: T) => Partial<T>)(state) : patch;
    // Referenz-Gleichheit als No-op-Schutz: identisches Objekt → kein Notify.
    let changed = false;
    for (const k in partial) {
      if ((partial as Record<string, unknown>)[k] !== (state as Record<string, unknown>)[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...partial };
    for (const l of listeners) l();
  };

  const get: StoreApi<T>["get"] = () => state;

  state = init({ set, get });

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const useStore = <U,>(selector: (s: T) => U): U =>
    useSyncExternalStore(
      subscribe,
      () => selector(state),
      () => selector(state),
    );

  return { useStore, getState: get, setState: set, subscribe };
}
