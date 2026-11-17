// [271] Umbau: gemeinsamer Zustand und gemeinsame Aktionen für das Dock-Panel „Umbau“ und das Statusleisten-Popover
// (ein Ort, keine Doppelspur): Zeichen-Status neuer Bauteile, Umbaufilter und Etappe der aktiven Ansicht (Felder der
// Zeichnungsebene wie die Modelldarstellung [173], darum je Reiter eigen und mit Undo), Status der Auswahl.

import { useCallback, useMemo } from "react";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { getState, useStore } from "./appStore";
import { EMPTY_SELECTION } from "./selection";
import type { Selection } from "./selection";
import {
  BUILTIN_RENOVATION_FILTERS,
  commonRenovation,
  idsByRenovationStatus,
  patchItem,
  setRenovationOps,
} from "../core";
import type { RenovationStatus } from "../model/types";

/** Anzeigename eines Filters (eingebaut übersetzt, eigene mit ihrem Namen). */
export function renovationFilterLabel(id: string, own: readonly { id: string; name: string }[]): string {
  if ((BUILTIN_RENOVATION_FILTERS as readonly string[]).includes(id)) return t(`renovation.filter.${id}` as TranslationKey);
  return own.find((f) => f.id === id)?.name ?? id;
}

/** Ids der Auswahl, die einen Umbau-Status tragen (Wände, Öffnungen, Decken, Dächer, Treppen, Stützen, Körper, Räume, 2D-Elemente, Bäume). */
export function selectionRenovationIds(sel: Selection): string[] {
  return [...sel.walls, ...sel.openings, ...sel.ceilings, ...sel.roofs, ...sel.stairs, ...sel.columns, ...sel.solids, ...sel.rooms, ...sel.drawings, ...sel.trees];
}

const NO_PHASES: readonly { id: string; name: string }[] = [];
const NO_FILTERS: readonly { id: string; name: string }[] = [];

/**
 * Zeichen-Status, Filter/Etappe der aktiven Ansicht und deren Setzer. Liest bewusst nur schmale Teile des Projekts
 * (Ebene, Etappen, eigene Filter), damit Statusleiste und Panel nicht bei jeder Op neu rendern ([121]).
 */
export function useRenovationControls() {
  const level = useStore((s) => s.project.drawingLevels.find((l) => l.id === s.activeLevelId));
  const rPhases = useStore((s) => s.project.renovation?.phases);
  const rFilters = useStore((s) => s.project.renovation?.filters);
  const draw = useStore((s) => s.drawRenovation);
  const setDraw = useStore((s) => s.setDrawRenovation);
  const applyChange = useStore((s) => s.applyChange);
  const phases = rPhases ?? NO_PHASES;
  const own = rFilters ?? NO_FILTERS;
  const filter = level?.renovationFilter ?? "";
  const levelEditable = !!level && (level.kind === "floor" || level.kind === "section" || level.kind === "elevation" || level.kind === "ceiling");
  const setLevel = useCallback(
    (patch: { renovationFilter?: string; renovationPhase?: string }) => {
      if (!level) return;
      applyChange((p) =>
        patchItem(p, "drawingLevels", level.id, (l) => {
          const next = { ...l, ...patch };
          if (!next.renovationFilter) delete next.renovationFilter;
          if (!next.renovationPhase || !next.renovationFilter) delete next.renovationPhase;
          return next;
        }),
      );
    },
    [level, applyChange],
  );
  return { level, levelEditable, draw, setDraw, phases, own, filter, filterPhase: level?.renovationPhase ?? "", setLevel };
}

/** Status der Auswahl und Aktionen darauf (setzen: ein Undo-Schritt; nach Status wählen). Ohne Projekt-Abonnement. */
export function useRenovationSelection() {
  const selection = useStore((s) => s.selection);
  const applyChange = useStore((s) => s.applyChange);
  const setSelection = useStore((s) => s.setSelection);
  const ids = useMemo(() => selectionRenovationIds(selection), [selection]);
  // Gemeinsamer Status/Etappe als Text: rendert nur bei echter Änderung neu, nicht bei jeder Op.
  const key = useStore((s) => JSON.stringify(commonRenovation(s.project, selectionRenovationIds(s.selection))));
  const common = useMemo(() => JSON.parse(key) as ReturnType<typeof commonRenovation>, [key]);
  const floorId = useStore((s) => (s.project.drawingLevels.find((l) => l.id === s.activeLevelId)?.kind === "floor" ? s.activeLevelId : null));
  const setStatus = (status: RenovationStatus) => applyChange((p) => setRenovationOps(p, ids, status));
  const setPhase = (phase: string | null) => applyChange((p) => setRenovationOps(p, ids, undefined, phase));
  /** Alle Bauteile des Geschosses mit Status `status` wählen; liefert die Zahl. */
  const selectByStatus = (status: RenovationStatus) => {
    const found = idsByRenovationStatus(getState().project, status, { floorId });
    setSelection({ ...EMPTY_SELECTION, ...found });
    return Object.values(found).reduce((a, v) => a + v.length, 0);
  };
  return { ids, common, floorId, setStatus, setPhase, selectByStatus };
}
