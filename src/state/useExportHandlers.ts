// Bündelt die PDF-/DXF-Plan-Export-Handler (Papier-/Modell-Space-Export der
// aktuellen Grundriss-Ansicht) — die Schnellexporte (CSV/IFC/OBJ/STL) liegen
// bereits in useProjectFileActions(). Nur aus App.tsx herausgezogen, um die
// Funktion zu entlasten — reine Verlagerung, keine Verhaltensänderung.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { generatePlan } from "../plan/generatePlan";
import type { CategoryDisplayResolver } from "../plan/generatePlan";
import type { DetailLevel } from "../ui/TopBar";
import type { DisplayResolver } from "../viewport/Viewport3D";
import { savePlanPdf } from "../export/exportPdf";
import { savePlanDxf } from "../export/exportDxf";
import type { ExportPdfDecision } from "../ui/ExportPdfDialog";
import type { ExportDxfDecision } from "../ui/ExportDxfDialog";
import { projectToWorldCoords } from "../model/geoRebase";
import type { Project } from "../model/types";

export function useExportHandlers(opts: {
  project: Project;
  activeLevelId: string;
  activeLevelName: string;
  visibleCodes: Set<string>;
  categoryDisplay: CategoryDisplayResolver & DisplayResolver;
  detail: DetailLevel;
  referenceLines: boolean;
  planColorMode: "color" | "mono";
  setExportOpen: (open: boolean) => void;
  setExportDxfOpen: (open: boolean) => void;
}): {
  onExportPdf: (decision: ExportPdfDecision) => Promise<void>;
  onExportDxf: (decision: ExportDxfDecision) => void;
} {
  const {
    project,
    activeLevelId,
    activeLevelName,
    visibleCodes,
    categoryDisplay,
    detail,
    referenceLines,
    planColorMode,
    setExportOpen,
    setExportDxfOpen,
  } = opts;

  const onExportPdf = async (decision: ExportPdfDecision) => {
    const plan = generatePlan(
      project,
      activeLevelId,
      visibleCodes,
      categoryDisplay,
      detail,
      referenceLines,
      planColorMode === "mono",
    );
    await savePlanPdf(plan, {
      scaleDenominator: decision.scaleDenominator,
      paper: decision.paper,
      orientation: decision.orientation,
      title: activeLevelName,
      subtitle: project.name,
      fileName: `${project.name}-${activeLevelName}`,
    });
    setExportOpen(false);
  };

  // DXF-Export: erzeugt den Plan mit EXAKT denselben Eingaben wie die Ansicht und
  // schreibt ihn als Modell-Space-DXF in echten Metern (1:1). Layer aus den
  // Kategorie-Ebenen; jede Entity auf ihrem Kategorie-Layer.
  const onExportDxf = (decision: ExportDxfDecision) => {
    // Georeferenziert exportieren: bei gesetztem Standort-Bezug (geoAnchor)
    // schreibt der Modell-DXF die ECHTEN LV95-Koordinaten (weit vom Nullpunkt),
    // damit die Datei in anderer CAD-Software lagerichtig ankommt — auch wenn
    // lokal nahe (0,0) gezeichnet wurde. Ohne Bezug bleibt alles lokal.
    // (Der Papier-/Layout-Export bleibt bewusst in lokalen Koordinaten.)
    const exportProject = projectToWorldCoords(project);
    const plan = generatePlan(
      exportProject,
      activeLevelId,
      visibleCodes,
      categoryDisplay,
      detail,
      referenceLines,
      planColorMode === "mono",
    );
    savePlanDxf(plan, exportProject, {
      title: activeLevelName,
      includeHatches: decision.includeHatches,
      fileName: `${project.name}-${activeLevelName}`,
    });
    setExportDxfOpen(false);
  };

  return { onExportPdf, onExportDxf };
}
