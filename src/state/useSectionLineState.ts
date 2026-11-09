// Auswahl-Sicht und Schnittlinien ([163], aus App.tsx herausgelöst): die Objekt-Info der Auswahl
// (`deriveSelection`), die gewählte bzw. aktive Schnitt-/Ansichtslinie für das Objekt-Info-Panel und
// die 3D-Schnittebene des Live-Schnitts samt Umschalter. Aufgerufen von `App.tsx`; die Werte gehen an
// die Panels (`usePanelHostBase`) und die Hauptansicht.

import { useCallback, useEffect, useMemo } from "react";
import type { DrawingLevel, Project, ViewType } from "../model/types";
import { sectionPlaneFromLevel } from "../core";
import { deriveSelection } from "./selectionInfo";
import type { SelectionInfo } from "./selectionInfo";
import type { useSelectionState } from "./useSelectionState";

type Sel = ReturnType<typeof useSelectionState>;

export function useSectionLineState(opts: {
  project: Project;
  selection: Sel["selection"];
  activeLevel: DrawingLevel;
  viewType: ViewType;
  selectedSectionLineId: string | null;
  section3dCutId: Sel["section3dCutId"];
  setSection3dCutId: Sel["setSection3dCutId"];
}) {
  const { project, selection, activeLevel, viewType, selectedSectionLineId, section3dCutId, setSection3dCutId } = opts;

  // ── Selektions-Attribut-Kontrakt (Attributes-/Object-Info-Paletten) ───────
  // Normalisierte, effektiv aufgelöste Sicht auf das erste selektierte Element.
  const selectionInfo = useMemo(
    (): SelectionInfo | null => deriveSelection(project, selection),
    [project, selection],
  );

  // Gewählte Schnitt-/Ansichtslinie (DrawingLevel) — separat von `selection`, da
  // eine Schnittlinie KEIN Projekt-Bauteil ist. Speist die Schnittlinien-Sektion
  // des Object-Info-Panels.
  // Ohne gewählte Linie, aber mit aktivem Schnitt/aktiver Ansicht: deren
  // Einstellungen (Tiefe, verdeckte Kanten, Grundriss-Unterlage …) direkt im
  // Leerzustand zeigen — man arbeitet ja gerade IN diesem Schnitt.
  const sectionLineId =
    selectedSectionLineId ??
    (activeLevel.kind === "section" || activeLevel.kind === "elevation" ? activeLevel.id : null);
  const sectionLine = useMemo(
    () =>
      sectionLineId
        ? project.drawingLevels.find(
            (z) =>
              z.id === sectionLineId &&
              (z.kind === "section" || z.kind === "elevation"),
          ) ?? null
        : null,
    [project.drawingLevels, sectionLineId],
  );

  // Abgeleitete 3D-Schnittebene der gebundenen Schnittlinie (world point+normal
  // via sectionPlaneFromLevel) — speist Viewport3D/Wasm3DViewport. Fehlt die
  // Linie (gelöscht/ohne linePoints), liefert der Helfer null → kein Schnitt.
  const section3dPlane = useMemo(() => {
    if (!section3dCutId) return null;
    const lvl = project.drawingLevels.find(
      (z) =>
        z.id === section3dCutId &&
        (z.kind === "section" || z.kind === "elevation"),
    );
    return lvl ? sectionPlaneFromLevel(lvl) : null;
  }, [project.drawingLevels, section3dCutId]);

  // Aus einem Schnitt ins 3D ([115]): der Live-Schnitt folgt der Schnittlinie dieses Schnitts (einmal
  // beim Wechsel; im 3D lässt er sich wie sonst aufheben).
  const sectionLevelIn3d = activeLevel.kind === "section" && viewType === "perspektive" ? activeLevel.id : null;
  useEffect(() => {
    if (sectionLevelIn3d) setSection3dCutId(sectionLevelIn3d);
  }, [sectionLevelIn3d, setSection3dCutId]);

  // Bindet den 3D-Live-Schnitt an eine Schnittlinie (Toggle im Objekt-Info).
  const onToggleSection3dCut = useCallback(
    (id: string) => setSection3dCutId((cur) => (cur === id ? null : id)),
    [],
  );

  return { selectionInfo, sectionLine, section3dPlane, onToggleSection3dCut };
}
