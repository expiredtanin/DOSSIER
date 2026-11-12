// Eingaben der Editier-Griffe ([163], aus App.tsx herausgelöst): das einzeln gewählte Element je Art
// (2D-Element, Decke, Baugrube, Raum samt Stempel-Anker), das Schnitt-/Ansichts-Blatt für waagrechtes
// Ziehen und der Fang ohne Entwurfspunkte (`snapFor`). Aufgerufen von `App.tsx`; die Werte gehen an
// `useGripEditing` und an die Hauptansicht (`roomStamp`).

import { useMemo } from "react";
import type { DrawingLevel, Project, Vec2 } from "../model/types";
import { roomLabelPoint, sectionPlaneFromLevel, sectionUAxisModel } from "../core";
import { computeSnap } from "../tools/snapping";
import type { SnapSettings, ToolMods } from "../tools/types";
import type { useSelectionState } from "./useSelectionState";

type Sel = ReturnType<typeof useSelectionState>;

export function useGripInputs(opts: {
  project: Project;
  activeLevel: DrawingLevel;
  selection: Sel["selection"];
  selectedDrawingId: string | null;
  selectedCeilingId: string | null;
  selectedRoomId: string | null;
  visibleCodes: Set<string>;
  snap: SnapSettings;
  /** Massstab der Arbeitsebene (Blatt: 1:1). */
  planScale: number;
}) {
  const { project, activeLevel, selection, selectedDrawingId, selectedCeilingId, selectedRoomId, visibleCodes, snap, planScale } =
    opts;

  // ── Editier-Griffe (Grips) des einzeln selektierten Elements ──────────────
  // Genau eine Wand ODER ein 2D-Element → dessen Eckpunkte als ziehbare Griffe.
  const selectedDrawing = useMemo(
    () => project.drawings2d.find((d) => d.id === selectedDrawingId) ?? null,
    [project.drawings2d, selectedDrawingId],
  );
  const selectedCeiling = useMemo(
    () => (project.ceilings ?? []).find((c) => c.id === selectedCeilingId) ?? null,
    [project.ceilings, selectedCeilingId],
  );
  // [68] Genau eine gewählte Baugrube (Griffe für Umriss und Sohle).
  const selectedExcavation = useMemo(() => {
    if (selection.contextObjects.length !== 1) return null;
    const o = (project.context ?? []).find((c) => c.id === selection.contextObjects[0]);
    return o && o.type === "excavation" ? o : null;
  }, [project.context, selection.contextObjects]);
  // [26] Genau ein gewähltes Dach (Ecken-/Kanten-Griffe von Umriss und Höfen).
  const selectedRoof = useMemo(() => {
    if (selection.roofs.length !== 1) return null;
    return (project.roofs ?? []).find((r) => r.id === selection.roofs[0]) ?? null;
  }, [project.roofs, selection.roofs]);
  const selectedRoom = useMemo(
    () => (project.rooms ?? []).find((r) => r.id === selectedRoomId) ?? null,
    [project.rooms, selectedRoomId],
  );
  // Stempel-Griff des (einzeln) gewählten Raums: sein fixer Anker (Meter) + ID.
  const roomStamp = useMemo(
    () =>
      selectedRoom
        ? {
            roomId: selectedRoom.id,
            anchor: selectedRoom.stampAnchor ?? roomLabelPoint(selectedRoom.boundary),
          }
        : null,
    [selectedRoom],
  );

  // Schnitt-/Ansichts-Blatt: geschnittene (bzw. in der Ansicht sichtbare)
  // Wände/Decken lassen sich dort waagrecht entlang der Linie ziehen (s.
  // useGripEditing `sheet`).
  const sectionSheet = useMemo(() => {
    if (activeLevel.kind !== "section" && activeLevel.kind !== "elevation") return null;
    const plane = sectionPlaneFromLevel(activeLevel);
    if (!plane) return null;
    const u = sectionUAxisModel(plane);
    const len = Math.hypot(u.x, u.y) || 1;
    return { levelId: activeLevel.id, uAxis: { x: u.x / len, y: u.y / len }, base: { x: plane.point[0], y: plane.point[2] } };
  }, [activeLevel]);

  // Snap ohne Entwurfspunkte (Griff-Ziehen, s. useGripEditing).
  const snapFor = (raw: Vec2, pxPerMeter: number, mods: ToolMods) => {
    const pts: Vec2[] = [];
    return computeSnap({
      raw,
      project,
      levelId: activeLevel.id,
      visibleCodes,
      settings: snap,
      draftPoints: pts,
      lastPoint: pts.length ? pts[pts.length - 1] : null,
      scale: planScale,
      pxPerMeter,
      shift: mods.shift,
      ctrl: mods.ctrl,
    });
  };

  return { selectedDrawing, selectedCeiling, selectedExcavation, selectedRoof, selectedRoom, roomStamp, sectionSheet, snapFor };
}
