// Panel-Host, Darstellungszustand für Ausschnitte und Reiter ([121], aus `usePanelHostBase`
// herausgelöst): `liveViewState` liest Ansicht, Kamera, Massstab, Detail, Geschoss, Sichtbarkeit und
// aktive Overrides; `applyViewState` stellt einen solchen Zustand wieder her (Projektdaten nur bei
// echter Abweichung, als ein Undo-Schritt).

import { fieldOps } from "../../core";
import type { RefObject } from "react";
import type { ViewType } from "../../model/viewTypes";
import type { PlanViewHandle } from "../../views/plan/PlanView";
import { getState } from "../appStore";
import { applyOverrideRuleEnabled, type ViewSnapshotState } from "../viewSnapshots";
import type { FlatHostOpts } from "./types";

/**
 * Grundriss-Kamera für einen View-Snapshot einsammeln (Bildmitte + Zoom) —
 * nur möglich, wenn gerade ein Grundriss gemountet ist (`viewType==="grundriss"`,
 * `planViewRef.current` also nicht null); sonst leeres Objekt (kein Feld
 * gesetzt), damit `{...captureCameraState(...)}` additiv in ein
 * `ViewSnapshotState`-Objektliteral eingemischt werden kann, ohne `undefined`-
 * Werte explizit zu setzen.
 */
function captureCameraState(
  planViewRef: RefObject<PlanViewHandle | null>,
  viewType: ViewType,
): Partial<Pick<ViewSnapshotState, "cameraCenter" | "cameraPxPerMeter">> {
  if (viewType !== "grundriss") return {};
  const pv = planViewRef.current;
  if (!pv) return {};
  const pxPerMeter = pv.pxPerMeter();
  if (!(pxPerMeter > 0)) return {};
  return { cameraCenter: pv.viewCenterModel(), cameraPxPerMeter: pxPerMeter };
}

/** Stimmt die Live-Sichtbarkeit mit der gespeicherten überein (nur gespeicherte Schlüssel zählen)? */
function visibilityMatches(live: Record<string, boolean>, stored: Record<string, boolean>): boolean {
  for (const k of Object.keys(stored)) if (k in live && live[k] !== stored[k]) return false;
  return true;
}

/** Lesen und Wiederherstellen des Darstellungszustands (s. Kopf). */
export interface ViewStateFns {
  liveViewState: () => ViewSnapshotState;
  applyViewState: (st: ViewSnapshotState) => void;
}

export function buildViewStateFns(c: FlatHostOpts): ViewStateFns {
  const { activeLevelId, applyChange, applyDrawingVisibility, applyLayerVisibility, detail, fov, planViewRef, scaleDenominator, setActiveLayoutId, setActiveLevelId, setDetail, setFov, setScaleDenominator, setView3d, setViewType, snapshotDrawingVisibility, snapshotLayerVisibility, view3d, viewType } = c;
  // Aktueller Darstellungszustand (Ansicht/Kamera/Massstab/Detail/Geschoss + Sichtbarkeit + Overrides).
  const liveViewState = (): ViewSnapshotState => ({
    viewType,
    view3d,
    fov,
    scaleDenominator,
    detail,
    activeLevelId,
    layerVisibility: snapshotLayerVisibility(),
    drawingVisibility: snapshotDrawingVisibility(),
    enabledOverrideRuleIds: (getState().project.overrideRules ?? []).filter((r) => r.enabled).map((r) => r.id),
    ...captureCameraState(planViewRef, viewType),
    // [205] Pausfolie des Reiters.
    ...(getState().trace ? { trace: getState().trace! } : {}),
  });
  // Darstellungszustand wiederherstellen. Reihenfolge: Geschoss ZUERST (setActiveLevelId setzt viewType
  // provisorisch aus viewTypeByLevel), danach die Ansicht (überschreibt es synchron), dann Sichtbarkeit +
  // Overrides — diese sind Projektdaten: nur bei echter Abweichung und dann als EIN Undo-Schritt.
  // Den imperativen Massstab-Zoom (Plan muss für den neuen View gemountet sein) via rAF nachziehen.
  const applyViewState = (st: ViewSnapshotState) => {
    setActiveLevelId(st.activeLevelId);
    // [182] Reiter eines Layouts: das Blatt wieder öffnen (sonst schickt der Blatt-Effekt zur vorigen Ebene zurück).
    const sheetLayout = getState().project.drawingLevels.find((l) => l.id === st.activeLevelId)?.layoutId;
    if (sheetLayout) setActiveLayoutId(sheetLayout);
    setViewType(st.viewType);
    setView3d(st.view3d);
    setFov(st.fov);
    setDetail(st.detail);
    setScaleDenominator(st.scaleDenominator);
    getState().setTrace(st.trace ?? null);
    const layersDiffer = !visibilityMatches(snapshotLayerVisibility(), st.layerVisibility);
    const drawingsDiffer = !visibilityMatches(snapshotDrawingVisibility(), st.drawingVisibility);
    const wanted = new Set(st.enabledOverrideRuleIds);
    const overridesDiffer = (getState().project.overrideRules ?? []).some((r) => !!r.enabled !== wanted.has(r.id));
    if (layersDiffer || drawingsDiffer || overridesDiffer) {
      getState().groupChanges(() => {
        if (layersDiffer) applyLayerVisibility(st.layerVisibility);
        if (drawingsDiffer) applyDrawingVisibility(st.drawingVisibility);
        if (overridesDiffer)
          applyChange((p) =>
            fieldOps(p, "overrideRules", applyOverrideRuleEnabled(p.overrideRules ?? [], st.enabledOverrideRuleIds)),
          );
      });
    }
    if (sheetLayout) return; // Blatt: das Layout passt sich selbst ein (1:1), kein Plan-Massstab
    requestAnimationFrame(() => {
      planViewRef.current?.applyScale(st.scaleDenominator);
      // Kamera NACH `applyScale` restaurieren (nicht statt): `applyScale` setzt auch die
      // Papier-Massstab-Referenz für Strichbreiten, hält aber die BISHERIGE Bildmitte; `setCamera`
      // schwenkt danach im selben Tick auf die erfasste Mitte — nur wenn der Zustand eine Kamera trägt.
      if (st.cameraCenter && st.cameraPxPerMeter) {
        planViewRef.current?.setCamera(st.cameraCenter, st.cameraPxPerMeter);
      }
    });
  };
  return { liveViewState, applyViewState };
}
