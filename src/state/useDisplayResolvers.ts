// Effektive Darstellung der Hauptansicht ([121] aus App.tsx herausgelöst): Resolver je Geschoss
// und je Kategorie-Code aus den Darstellungsmodi der Zeichnungsebenen-/Ebenen-Panels plus ein
// stabiler Schlüssel für den 3D-Neuaufbau.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useMemo } from "react";
import { flattenCategories } from "../model/types";
import { isSheetLevel } from "../model/layoutModel";
import type { CategoryDisplayResolver } from "../core";
import type { DisplayResolver } from "../viewport/Viewport3D";
import { itemDisplay } from "../panels/displayMode";
import type { DisplayMode } from "../panels/types";
import { BUILTIN_PANEL_IDS } from "../panels/builtinPanels";
import { useStore } from "./appStore";

export function useDisplayResolvers(opts: {
  activeLevelId: string;
  activeCategoryCode: string;
}) {
  const { activeLevelId, activeCategoryCode } = opts;
  // Nur Ebenen-Baum und Zeichnungsebenen abonnieren ([121]).
  const layers = useStore((s) => s.project.layers);
  const drawingLevels = useStore((s) => s.project.drawingLevels);
  const displayModes = useStore((s) => s.displayModes) as Record<string, DisplayMode | undefined>;
  // ── Effektive Darstellung für die Hauptansicht ────────────────────────────
  // 3D: Geschosse nach dem Modus des Zeichnungsebenen-Panels, Kategorien nach
  // dem Modus des Ebenen-Panels. Grundriss: Kategorien nach dem Ebenen-Panel.
  // Aus der abonnierten Map lesen (nicht über modeFor), damit ein Moduswechsel
  // garantiert ein Re-Render auslöst und die Resolver neu rechnen.
  const drawingLevelsMode =
    displayModes[BUILTIN_PANEL_IDS.drawingLevels] ?? "all";
  const layersMode = displayModes[BUILTIN_PANEL_IDS.layers] ?? "all";

  // Sichtbarkeit je Kategorie-Code (für categoryDisplay), Baum berücksichtigt.
  const codeVisible = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const c of flattenCategories(layers)) map.set(c.code, c.visible);
    return map;
  }, [layers]);

  // Resolver: je Geschoss-ID die Render-Entscheidung (aktiv = Arbeitsfokus).
  // Memoisiert, damit Plan/3D nicht bei jedem Render neu rechnen.
  const floorDisplay: CategoryDisplayResolver & DisplayResolver = useMemo(() => {
    const visible = new Map(
      drawingLevels.map((z) => [z.id, z.visible]),
    );
    // Blatt-Ebenen stehen für sich: nur sichtbar, wenn ihr Blatt offen ist, und dann allein.
    const sheets = new Set(drawingLevels.filter(isSheetLevel).map((z) => z.id));
    const onSheet = sheets.has(activeLevelId);
    return (id) =>
      onSheet || sheets.has(id)
        ? { render: id === activeLevelId, greyed: false, locked: false }
        : itemDisplay(drawingLevelsMode, id === activeLevelId, visible.get(id) ?? false);
  }, [drawingLevels, drawingLevelsMode, activeLevelId]);

  // Resolver: je Kategorie-Code die Render-Entscheidung. „Aktiv" = die per
  // Klick im Ebenen-Panel gewählte Kategorie (activeCategoryCode, wie schon
  // in LayersPanel.tsx für die Zeilen-Hervorhebung genutzt). Wirkt in
  // Grundriss UND 3D.
  const categoryDisplay: CategoryDisplayResolver & DisplayResolver = useMemo(
    () => (code) =>
      itemDisplay(layersMode, code === activeCategoryCode, codeVisible.get(code) ?? false),
    [layersMode, codeVisible, activeCategoryCode],
  );

  // Stabiler Schlüssel der 3D-Display-Entscheidungen (Resolver sind nicht
  // referenzstabil → triggert sonst keinen Neuaufbau).
  const displayKey = `${drawingLevelsMode}|${layersMode}|${activeLevelId}|${activeCategoryCode}`;
  return { floorDisplay, categoryDisplay, displayKey, drawingLevelsMode };
}
