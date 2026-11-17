// [266] „3D-Dokument erstellen“ (Archicad-artig): die aktuelle 3D-Kamera als Vektorzeichnung mit verdeckten Kanten aus dem
// Kern. Legt einen Ausschnitt (Ansichtstyp „perspektive“, `doc3d.camera`) und ein Blatt A3 quer mit diesem Ausschnitt an; die
// Zeichnung rechnet der Kern bei jeder Anzeige neu (Modelländerungen wirken), Exporte SVG/PDF/DXF gehen über das Blatt.

import { addItems, generateAxoPlan } from "../core";
import { t } from "../i18n";
import type { Doc3d, Project, ViewSnapshot } from "../model/types";
import { createLayout, createSheetLevel, createViewport, sheetSizeMm } from "../model/layoutModel";
import { getCamera, viewportAvailable } from "../viewport/cameraBridge";
import { getState } from "./appStore";

/** Massstäbe, aus denen das Blatt den kleinsten passenden nimmt. */
const SCALES = [20, 50, 100, 200, 250, 500, 1000, 2000, 5000];
/** Rand des Viewports auf dem Blatt (mm). */
const MARGIN_MM = 20;

/** Einstellungen des 3D-Dokuments aus der Kamera der 3D-Ansicht (ohne Viewport: die Vorgabe der Ansichtsleiste). */
export function doc3dFromView(view: ReturnType<typeof getCamera>, view3d: string): Doc3d {
  if (!view) return { view: view3d };
  return { camera: { kind: view.kind, position: [...view.position], direction: [...view.direction], up: [...view.up], fovDeg: view.fovDeg, aspect: view.aspect } };
}

/** Ausschnitt, Blatt-Ebene und Blatt eines 3D-Dokuments als Ops; `null`, wenn der Kern kein Bild liefert (nichts sichtbar). */
export function doc3dOps(project: Project, doc3d: Doc3d, opts: { stamp: string; name: string; view3d: ViewSnapshot["view3d"]; activeLevelId: string; layerVisibility: Record<string, boolean> }) {
  const codes = new Set(Object.keys(opts.layerVisibility).filter((k) => opts.layerVisibility[k]));
  const plan = generateAxoPlan(project, { ...doc3d, visibleCodes: codes.size ? codes : undefined });
  if (!plan) return null;
  const size = sheetSizeMm("a3", "landscape");
  const b = plan.bounds;
  const w = size.w - 2 * MARGIN_MM;
  const h = size.h - 2 * MARGIN_MM;
  const need = Math.max(((b.maxX - b.minX) * 1000) / w, ((b.maxY - b.minY) * 1000) / h);
  const scale = SCALES.find((s) => s >= need) ?? SCALES[SCALES.length - 1];
  const snapId = `vs-doc3d-${opts.stamp}`;
  const snap: ViewSnapshot = {
    id: snapId,
    name: opts.name,
    viewType: "perspektive",
    view3d: opts.view3d,
    scaleDenominator: scale,
    detail: "mittel",
    activeLevelId: opts.activeLevelId,
    layerVisibility: { ...opts.layerVisibility },
    drawingVisibility: {},
    doc3d,
  };
  const layout = createLayout(`lay-doc3d-${opts.stamp}`, opts.name, "a3", "landscape");
  layout.viewports = [createViewport(`vp-doc3d-${opts.stamp}`, snapId, { xMm: MARGIN_MM, yMm: MARGIN_MM, widthMm: w, heightMm: h, scaleDenominator: scale, center: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } })];
  return { ops: [...addItems("viewSnapshots", [snap]), ...addItems("layouts", [layout]), ...addItems("drawingLevels", [createSheetLevel(`sheet-${layout.id}`, layout)])], snapId, layoutId: layout.id, scale };
}

/** Aus der aktuellen 3D-Ansicht ein 3D-Dokument anlegen (ein Undo-Schritt). Gibt die Id des Blatts zurück. */
export function create3dDocument(): string | null {
  const st = getState();
  const view = viewportAvailable() ? getCamera() : null;
  const n = (st.project.viewSnapshots ?? []).filter((s) => s.doc3d).length + 1;
  const name = t("doc3d.name", { n });
  const res = doc3dOps(st.project, doc3dFromView(view, st.view3d), { stamp: `${Date.now()}`, name, view3d: st.view3d, activeLevelId: st.activeLevelId, layerVisibility: st.snapshotLayerVisibility() });
  if (!res) {
    st.notify(t("doc3d.empty"), "warning");
    return null;
  }
  st.applyChange(res.ops);
  st.notify(t("doc3d.created", { name, scale: res.scale }), "info");
  return res.layoutId;
}
