// Offenes Layout-Blatt ([121] aus App.tsx herausgelöst; DOSSIER A3, Phase 2b): Blatt-Ebene als
// aktive Ebene, Rückkehr zur vorigen Ebene beim Schliessen und die Viewport-/Tabellen-/Legenden-
// Handler des Blatts. Die Handler sind referenzstabil, `sheetPane` ändert sich nur mit Blatt/Ebene.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useMemo, useRef } from "react";
import type { Layout, LayoutLegend, LayoutTable, LayoutTitleBlock, LayoutViewport } from "../model/types";
import { useStore } from "./appStore";
import { addItems, patchItem } from "../core";
import type { ProjectSlice } from "./projectSlice";
import {
  createViewport,
  createSheetLevel,
  isSheetLevel,
  sheetLevelOf,
  addViewport as addViewportToLayout,
  removeViewport as removeViewportFromLayout,
  patchViewport as patchViewportInLayout,
  addTable as addTableToLayout,
  patchTable as patchTableInLayout,
  removeTable as removeTableFromLayout,
} from "../model/layoutModel";
import { addLegend, patchLegend, removeLegend } from "../analysis/legend";
import { useEventBundle } from "./useEvent";

export function useSheetPane(opts: {
  activeLayoutId: string | null;
  setActiveLayoutId: (id: string | null) => void;
  activeLevelId: string;
  setActiveLevelId: (id: string) => void;
  applyChange: ProjectSlice["applyChange"];
}) {
  const { activeLayoutId, setActiveLayoutId, activeLevelId, setActiveLevelId, applyChange } = opts;
  // Nur Layouts und Zeichnungsebenen abonnieren ([121]): eine Op an Bauteilen rendert den Aufrufer nicht.
  const layouts = useStore((s) => s.project.layouts);
  const drawingLevels = useStore((s) => s.project.drawingLevels);
  // ── Layout-Blatt (DOSSIER A3, Phase 2b): das offene Blatt + Viewport-Handler ─
  // Das offene Layout wird live aus dem Projekt gelesen (Single Source of Truth);
  // wurde es zwischenzeitlich gelöscht, ist es undefined → der Haupt-Viewport
  // zeigt wieder die Modell-Ansicht. Die Handler mutieren immutabel über die
  // pure CRUD-Ebene (panels/layoutModel.ts).
  const activeLayout =
    activeLayoutId !== null
      ? (layouts ?? []).find((l) => l.id === activeLayoutId)
      : undefined;
  const patchOpenLayout = (id: string, fn: (l: Layout) => Layout, coalesceKey?: string) =>
    applyChange((p) => patchItem(p, "layouts", id, fn), coalesceKey);

  // Ein offenes Blatt IST eine Zeichnungsebene: seine Blatt-Ebene (`layoutId`) wird die aktive Ebene,
  // damit Werkzeuge, Befehle, Fang, Griffe, Auswahl und Undo genau wie im Grundriss wirken. Beim
  // Schliessen kehrt die vorige Ebene zurück; wählt man im Navigator eine andere Ebene, schliesst
  // das Blatt.
  const sheetLevel = activeLayout ? sheetLevelOf({ drawingLevels }, activeLayout.id) : undefined;
  const levelBeforeSheetRef = useRef<string | null>(null);
  const enteredSheetRef = useRef<string | null>(null);
  useEffect(() => {
    const current = drawingLevels.find((l) => l.id === activeLevelId);
    if (activeLayout) {
      if (!sheetLevel) {
        // Layout ohne Blatt-Ebene (z. B. per CLI angelegt): einmal nachtragen.
        applyChange(addItems("drawingLevels", [createSheetLevel(`sheet-${activeLayout.id}`, activeLayout)]));
        return;
      }
      if (activeLevelId === sheetLevel.id) {
        enteredSheetRef.current = activeLayout.id;
        return;
      }
      if (enteredSheetRef.current === activeLayout.id) {
        enteredSheetRef.current = null;
        setActiveLayoutId(null);
        return;
      }
      if (current && !isSheetLevel(current)) levelBeforeSheetRef.current = current.id;
      setActiveLevelId(sheetLevel.id);
      return;
    }
    enteredSheetRef.current = null;
    if (current && !isSheetLevel(current)) return;
    const back =
      drawingLevels.find((l) => l.id === levelBeforeSheetRef.current && !isSheetLevel(l)) ??
      drawingLevels.find((l) => !isSheetLevel(l));
    if (back && back.id !== activeLevelId) setActiveLevelId(back.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLayout?.id, sheetLevel?.id, activeLevelId]);
  // Handler wirken auf das jeweils OFFENE Blatt (stabile Identität, aktueller Stand beim Aufruf).
  const openId = () => activeLayout?.id ?? "";
  const handlers = useEventBundle({
    onBack: () => setActiveLayoutId(null),
    onPatchViewport: (viewportId: string, patch: Partial<Omit<LayoutViewport, "id" | "snapshotId">>) =>
      patchOpenLayout(openId(), (l) => patchViewportInLayout(l, viewportId, patch)),
    onRemoveViewport: (viewportId: string) =>
      patchOpenLayout(openId(), (l) => removeViewportFromLayout(l, viewportId)),
    onAddTable: (table: LayoutTable) => patchOpenLayout(openId(), (l) => addTableToLayout(l, table)),
    onPatchTable: (tableId: string, patch: Partial<Omit<LayoutTable, "id">>, coalesceKey?: string) =>
      patchOpenLayout(openId(), (l) => patchTableInLayout(l, tableId, patch), coalesceKey),
    onRemoveTable: (tableId: string) => patchOpenLayout(openId(), (l) => removeTableFromLayout(l, tableId)),
    onAddViewport: (snapshotId: string, init: Partial<Omit<LayoutViewport, "id" | "snapshotId">>) =>
      patchOpenLayout(openId(), (l) =>
        addViewportToLayout(l, createViewport(`vp-${Date.now()}`, snapshotId, init)),
      ),
    onAddLegend: (init: Omit<LayoutLegend, "id">) => {
      const id = `legend-${Date.now()}`;
      patchOpenLayout(openId(), (l) => addLegend(l, { ...init, id }));
      return id;
    },
    onPatchLegend: (legendId: string, patch: Partial<Omit<LayoutLegend, "id">>) =>
      patchOpenLayout(openId(), (l) => patchLegend(l, legendId, patch), `legend-${legendId}`),
    onRemoveLegend: (legendId: string) => patchOpenLayout(openId(), (l) => removeLegend(l, legendId)),
    // [137] Schriftfeld: Blatt-Felder am Layout, gemeinsame am Master (Tippen = ein Undo-Schritt je Feld).
    onPatchTitleBlock: (layoutPatch: Partial<Pick<Layout, "name" | "planNumber" | "revision">>, masterPatch?: Partial<LayoutTitleBlock>) => {
      const id = openId();
      const key = `titleBlock:${id}:${Object.keys(layoutPatch).join()}${Object.keys(masterPatch ?? {}).join()}`;
      if (Object.keys(layoutPatch).length > 0) patchOpenLayout(id, (l) => ({ ...l, ...layoutPatch }), key);
      if (masterPatch) {
        applyChange((p) => {
          const lay = (p.layouts ?? []).find((l) => l.id === id);
          const m = (p.masterLayouts ?? []).find((x) => x.id === lay?.masterId);
          return m ? patchItem(p, "masterLayouts", m.id, { titleBlock: { ...m.titleBlock, ...masterPatch } }) : [];
        }, key);
      }
    },
  });
  const open = !!activeLayout && !!sheetLevel && activeLevelId === sheetLevel.id;
  return useMemo(
    () => (open && activeLayout ? { layout: activeLayout, handlers } : null),
    [open, activeLayout, handlers],
  );
}
