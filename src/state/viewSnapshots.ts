// Ausschnitte / View-Snapshots — reine Erfassungs-/Wiederherstellungslogik.
//
// Ein „Ausschnitt" (View-Snapshot, DOSSIER A2) ist eine benannte, gespeicherte
// Ansicht, die den kompletten Darstellungszustand einfängt und wiederherstellt.
// KERN-PRINZIP: nichts neu erfinden — die Bausteine existieren schon (View-
// State, Sichtbarkeits-Snapshots wie `LayerCombo`/`DrawingCombo`, Overrides,
// aktives Geschoss) und werden hier nur KOMPONIERT + benannt gebündelt.
//
// Dieses Modul hält die eigentliche Logik als PURE Funktionen (testbar, ohne
// React/Store): Capture aus einem Zustandsobjekt → ViewSnapshot, und Read eines
// ViewSnapshots → wiederherstellbarer Kernzustand (den das Wiring in App.tsx auf
// die konkreten Setter abbildet). Das Setter-/rAF-Wiring bleibt in App.tsx.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { OverrideRule, ViewSnapshot } from "../model/types";
import type { DetailLevel, View3d, ViewType } from "../ui/TopBar";

/**
 * Der wiederherstellbare KERNZUSTAND eines Ausschnitts — alle Felder, die ein
 * Snapshot einfängt, OHNE Meta (`id`/`name`/`folder`). Sowohl `captureViewSnapshot`
 * (Eingang) als auch `readViewSnapshot` (Ausgang) sprechen diese Form; damit ist
 * ein sauberer Roundtrip (capture → read) trivial prüfbar.
 */
export interface ViewSnapshotState {
  viewType: ViewType;
  view3d: View3d;
  fov: number;
  scaleDenominator: number;
  detail: DetailLevel;
  activeLevelId: string;
  layerVisibility: Record<string, boolean>;
  drawingVisibility: Record<string, boolean>;
  /** Ids der aktiven (`enabled`) Override-Regeln zum Erfassungszeitpunkt. */
  enabledOverrideRuleIds: string[];
}

/**
 * Baut aus einem Kernzustand einen benannten Ausschnitt. Pure — `id`/`name`
 * kommen vom Aufrufer (App erzeugt die Id, der Nutzer den Namen); die
 * Sichtbarkeits-/Overrides-Maps werden defensiv kopiert, damit der Snapshot vom
 * Live-Zustand entkoppelt ist. `folder` optional (Phase 1: flach).
 */
export function captureViewSnapshot(
  id: string,
  name: string,
  state: ViewSnapshotState,
  folder?: string,
): ViewSnapshot {
  const snap: ViewSnapshot = {
    id,
    name,
    viewType: state.viewType,
    view3d: state.view3d,
    fov: state.fov,
    scaleDenominator: state.scaleDenominator,
    detail: state.detail,
    activeLevelId: state.activeLevelId,
    layerVisibility: { ...state.layerVisibility },
    drawingVisibility: { ...state.drawingVisibility },
    enabledOverrideRuleIds: [...state.enabledOverrideRuleIds],
  };
  if (folder && folder.trim()) snap.folder = folder.trim();
  return snap;
}

/**
 * Liest den wiederherstellbaren Kernzustand aus einem Ausschnitt. Fehlende
 * optionale Felder (aus hand-/altangelegten Snapshots) werden defensiv
 * aufgefüllt (`fov` → 50, `enabledOverrideRuleIds` → []). Die Sichtbarkeits-Maps
 * werden kopiert, damit der Aufrufer sie gefahrlos weiterreichen kann.
 */
export function readViewSnapshot(snap: ViewSnapshot): ViewSnapshotState {
  return {
    viewType: snap.viewType,
    view3d: snap.view3d,
    fov: snap.fov ?? 50,
    scaleDenominator: snap.scaleDenominator,
    detail: snap.detail,
    activeLevelId: snap.activeLevelId,
    layerVisibility: { ...snap.layerVisibility },
    drawingVisibility: { ...snap.drawingVisibility },
    enabledOverrideRuleIds: snap.enabledOverrideRuleIds
      ? [...snap.enabledOverrideRuleIds]
      : [],
  };
}

/** Deep-Equal zweier `Record<string, boolean>`-Maps: gleiche Keys UND Werte. */
export function boolMapEqual(
  a: Record<string, boolean>,
  b: Record<string, boolean>,
): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Sucht unter den gespeicherten Kombinationen (`names` + `load`) diejenige,
 * deren Map EXAKT `target` entspricht — liefert den Namen oder `null`. Basis
 * der Footer-Anzeige im Ausschnitte-Panel UND der Auto-Benennung neuer
 * Ausschnitt-Tabs (Nutzer-Wunsch: Tab heisst wie die aktive Zeichnungs-
 * kombination, falls eine exakt passt).
 */
export function matchingComboName(
  names: string[],
  load: (name: string) => Record<string, boolean> | null,
  target: Record<string, boolean>,
): string | null {
  for (const name of names) {
    const map = load(name);
    if (map && boolMapEqual(map, target)) return name;
  }
  return null;
}

/** Mengengleichheit zweier Id-Listen (Reihenfolge egal, Duplikate ignoriert). */
function idSetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const id of b) {
    if (!sa.has(id)) return false;
  }
  return sa.size === new Set(b).size;
}

/**
 * Prüft, ob ein Ausschnitt-Kernzustand EXAKT dem aktuellen Live-Zustand
 * entspricht — Grundlage der „angewählt bleibt bis zur Abweichung"-Logik im
 * Ausschnitte-Panel. Vergleicht ALLE erfassten Felder feldweise (Enums/Zahlen
 * strikt, Sichtbarkeits-Maps deep-equal, Override-Ids als Menge). Weicht auch
 * nur EIN Feld ab → `false`. Pure/testbar; der Aufrufer (App.tsx) normalisiert
 * den gespeicherten Snapshot vorher über `readViewSnapshot`, damit fehlende
 * optionale Felder (fov/overrides) fair verglichen werden.
 */
export function snapshotMatchesLiveState(
  snap: ViewSnapshotState,
  live: ViewSnapshotState,
): boolean {
  return (
    snap.viewType === live.viewType &&
    snap.view3d === live.view3d &&
    snap.fov === live.fov &&
    snap.scaleDenominator === live.scaleDenominator &&
    snap.detail === live.detail &&
    snap.activeLevelId === live.activeLevelId &&
    boolMapEqual(snap.layerVisibility, live.layerVisibility) &&
    boolMapEqual(snap.drawingVisibility, live.drawingVisibility) &&
    idSetEqual(snap.enabledOverrideRuleIds, live.enabledOverrideRuleIds)
  );
}

/**
 * Setzt bei jeder Override-Regel `enabled = enabledIds.includes(rule.id)`
 * (immutabel). Reproduziert die Aktiv-Menge, die ein Ausschnitt gespeichert hat.
 * Regeln, die es beim Erfassen noch nicht gab, bleiben unberührt deaktiviert;
 * inzwischen gelöschte Regel-Ids werden schlicht ignoriert. Liefert eine NEUE
 * Liste nur, wenn sich etwas ändert (sonst dieselbe Referenz → No-Op-freundlich
 * für den setProject-History-Schutz).
 */
export function applyOverrideRuleEnabled(
  rules: OverrideRule[],
  enabledIds: string[],
): OverrideRule[] {
  const active = new Set(enabledIds);
  let changed = false;
  const next = rules.map((r) => {
    const enabled = active.has(r.id);
    if (enabled === r.enabled) return r;
    changed = true;
    return { ...r, enabled };
  });
  return changed ? next : rules;
}
