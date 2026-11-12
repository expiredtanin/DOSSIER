// Native Nebenfenster der App ([163], aus App.tsx herausgelöst): Ebeneneinstellungen,
// Standort-Import und Zeichnungsebenen-Manager als eigene Tauri-Fenster, je über ihre Sync-Brücke
// (`src/native/*Window.ts`). Ausserhalb von Tauri sind die Hosts No-ops; `openLayerSettings` öffnet
// dann den Inline-Editor. Aufgerufen von `App.tsx`.

import type { ContextObject } from "../model/types";
import type { ImportedLine } from "../io/geoContext";
import { setFieldIfChanged } from "../core";
import { isTauriRuntime } from "../native/projectFile";
import { useContextImportWindowHost } from "../native/contextImportWindow";
import { useDrawingLevelsWindowHost } from "../native/drawingLevelsWindow";
import { openLayerSettingsWindowNative, useLayerSettingsWindowHost } from "../native/layerSettingsWindow";
import { BUILTIN_PANEL_IDS } from "../panels/builtinPanels";
import type { useContextMenuState } from "../menus/useContextMenuState";
import { useStore, type RootState } from "./appStore";
import { openLevel } from "./tabNavigation";
import type { useDisplayResolvers } from "./useDisplayResolvers";
import type { useProjectActions } from "./useProjectActions";

type Menu = ReturnType<typeof useContextMenuState>;

export function useNativeWindowHosts(opts: {
  applyChange: RootState["applyChange"];
  activeLevelId: string;
  setModeFor: RootState["setModeFor"];
  drawingLevelsMode: ReturnType<typeof useDisplayResolvers>["drawingLevelsMode"];
  nativeLayerSettingsCode: Menu["nativeLayerSettingsCode"];
  setNativeLayerSettingsCode: Menu["setNativeLayerSettingsCode"];
  setEditor: Menu["setEditor"];
  pa: ReturnType<typeof useProjectActions>;
}) {
  const {
    applyChange,
    activeLevelId,
    setModeFor,
    drawingLevelsMode,
    nativeLayerSettingsCode,
    setNativeLayerSettingsCode,
    setEditor,
  } = opts;
  const {
    patchCategory,
    addContextObjectsAndFit,
    toggleLevelVisible,
    addFloor,
    addSection,
    addElevation,
    addCeiling,
    addDrawing,
  } = opts.pa;

  // Ebeneneinstellungen als eigenes natives Fenster (DOSSIER-Rhino-Referenz)
  // — ersetzt unter Tauri den InlineEditor-Popover, s. native/layerSettingsWindow.ts.
  // Schmale Abos ([121]): Ebenen-Baum, Schraffuren, Standort-Bezug, Zeichnungsebenen.
  const layers = useStore((s) => s.project.layers);
  const hatches = useStore((s) => s.project.hatches);
  const geoAnchor = useStore((s) => s.project.geoAnchor);
  const drawingLevels = useStore((s) => s.project.drawingLevels);
  useLayerSettingsWindowHost({ layers, hatches }, nativeLayerSettingsCode, patchCategory);
  const openLayerSettings = (code: string, x: number, y: number) => {
    if (isTauriRuntime()) {
      setNativeLayerSettingsCode(code);
      void openLayerSettingsWindowNative(code);
    } else {
      setEditor({ kind: "layer", code, x, y });
    }
  };

  // Standort-Import als eigenes natives Fenster — s. native/contextImportWindow.ts.
  useContextImportWindowHost(geoAnchor, {
    onImport: (objs, lines) => addContextObjectsAndFit(objs as ContextObject[], lines as ImportedLine[]),
    onSetGeoAnchor: (anchor) => applyChange((p) => setFieldIfChanged(p, "geoAnchor", anchor)),
  });

  // Zeichnungsebenen-Manager als eigenes natives Fenster (DOSSIER-Rhino-
  // Referenz) — additiv NEBEN dem bestehenden Dock-Panel, siehe
  // native/drawingLevelsWindow.ts Kopfkommentar (Rechtsklick-Kontextmenü
  // bewusst nicht mitgenommen).
  useDrawingLevelsWindowHost(
    {
      drawingLevels: drawingLevels.filter((z) => !z.layoutId),
      activeLevelId,
      displayMode: drawingLevelsMode,
    },
    {
      onSelectLevel: openLevel,
      onToggleLevel: toggleLevelVisible,
      onAddFloor: addFloor,
      onAddSection: addSection,
      onAddElevation: addElevation,
      onAddCeiling: addCeiling,
      onAddDrawing: addDrawing,
      onSetDisplayMode: (mode) => setModeFor(BUILTIN_PANEL_IDS.drawingLevels, mode),
    },
  );

  return { openLayerSettings };
}
