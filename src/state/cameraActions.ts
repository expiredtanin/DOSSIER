// [213] Aktionen zu Kamera-Elementen (`Project.cameras`): aus der aktuellen 3D-Ansicht anlegen, eine Kamera im 3D
// öffnen (Ansicht exakt setzen, Sonne übernehmen), die Kamera mit der aktuellen Ansicht überschreiben. Die Umrechnung
// Kamera ↔ Ansicht steht rein in `viewport/cameraView.ts`; hier hängt sie am Store, an den Reitern und am Viewport.

import { addItems, patchItem, setField } from "../core";
import { t } from "../i18n";
import type { Camera } from "../model/types";
import { getCamera, getCameraTargetDistance, setCamera, viewportAvailable } from "../viewport/cameraBridge";
import { cameraFromView, cameraToView, nextCameraName } from "../viewport/cameraView";
import { getState } from "./appStore";
import { fromIds } from "./selection";
import { switchViewType } from "./tabNavigation";

function newCameraId(): string {
  const r = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `cam-${r}`;
}

/** Kamera aus der aktuellen 3D-Ansicht anlegen und wählen. Gibt die id zurück, `null` ohne 3D-Ansicht. */
export function createCameraFromView(): string | null {
  const st = getState();
  const view = viewportAvailable() ? getCamera() : null;
  if (!view) {
    st.notify(t("camera.noViewport"), "warning");
    return null;
  }
  const cam = cameraFromView(st.project, view, {
    id: newCameraId(),
    name: nextCameraName(st.project, t("camera.defaultName")),
    fallbackFloorId: st.activeLevelId,
    distance: getCameraTargetDistance() ?? undefined,
  });
  st.applyChange(addItems("cameras", [cam]));
  st.setSelection(fromIds("cameras", [cam.id]));
  st.notify(t("camera.created", { name: cam.name }), "info");
  return cam.id;
}

/** Wartet (höchstens `timeoutMs`), bis der 3D-Viewport Kamera-Zugriff meldet — nach dem Wechsel in den 3D-Reiter. */
function whenViewportReady(timeoutMs = 3000): Promise<boolean> {
  if (viewportAvailable()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t0 = performance.now();
    const poll = () => {
      if (viewportAvailable()) resolve(true);
      else if (performance.now() - t0 > timeoutMs) resolve(false);
      else requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
}

/**
 * Kamera im 3D öffnen: in den 3D-Reiter wechseln, die Ansicht exakt setzen (Standpunkt, Blickrichtung, Bildwinkel,
 * Projektion) und — hat die Kamera einen Sonnenstand — die Sonnenstudie darauf stellen (Schatten im 3D an).
 */
export async function openCamera(id: string): Promise<boolean> {
  const st = getState();
  const cam = (st.project.cameras ?? []).find((c) => c.id === id);
  if (!cam) return false;
  const view = cameraToView(st.project, cam);
  if (!view) {
    st.notify(t("camera.invalid", { name: cam.name }), "warning");
    return false;
  }
  if (!viewportAvailable()) switchViewType("perspektive");
  if (!(await whenViewportReady())) {
    st.notify(t("camera.noViewport"), "warning");
    return false;
  }
  // Seitenverhältnis des Viewports behalten (die Brücke füllt es aus der Live-Kamera).
  const live = getCamera();
  const placed = setCamera({ ...view, aspect: live?.aspect ?? view.aspect }, { animate: true });
  if (!placed) {
    st.notify(t("camera.invalid", { name: cam.name }), "warning");
    return false;
  }
  if (cam.sunWhen && Number.isFinite(new Date(cam.sunWhen).getTime())) {
    const study = getState().project.sunStudy;
    if (study?.when !== cam.sunWhen || study.shadows3d !== true) {
      getState().applyChange([setField("sunStudy", { ...(study ?? { show: false }), when: cam.sunWhen, shadows3d: true } as NonNullable<typeof study>)]);
    }
  }
  return true;
}

/** Kamera mit der aktuellen 3D-Ansicht überschreiben (Standpunkt, Ziel, Bildwinkel, Projektion; Name und Klasse bleiben). */
export function updateCameraFromView(id: string): boolean {
  const st = getState();
  const old = (st.project.cameras ?? []).find((c) => c.id === id);
  const view = viewportAvailable() ? getCamera() : null;
  if (!old || !view) {
    st.notify(t("camera.noViewport"), "warning");
    return false;
  }
  const fresh = cameraFromView(st.project, view, {
    id: old.id,
    name: old.name,
    fallbackFloorId: old.floorId,
    distance: getCameraTargetDistance() ?? undefined,
    categoryCode: old.categoryCode,
  });
  const next: Camera = { ...old, ...fresh, locked: old.locked, sunWhen: old.sunWhen };
  if (fresh.projection === "perspective") delete next.orthoHeight;
  st.applyChange((p) => patchItem(p, "cameras", id, () => next));
  st.notify(t("camera.updated", { name: old.name }), "info");
  return true;
}
