// Bündelt die PDF-/DXF-Plan-Export-Handler (Papier-/Modell-Space-Export der
// aktuellen Grundriss-Ansicht) — die Schnellexporte (CSV/IFC/OBJ/STL) liegen
// bereits in useProjectFileActions(). Nur aus App.tsx herausgezogen, um die
// Funktion zu entlasten — reine Verlagerung, keine Verhaltensänderung.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { generatePlan } from "../core";
import type { CategoryDisplayResolver } from "../core";
import type { DetailLevel } from "../model/viewTypes";
import type { DisplayResolver } from "../viewport/Viewport3D";
import { savePlanPdf } from "../export/exportPdf";
import { savePlanSvg } from "../export/exportSvg";
import { savePlanDxf } from "../export/exportDxf";
import type { ExportPdfDecision } from "../ui/ExportPdfDialog";
import type { ExportDxfDecision } from "../ui/ExportDxfDialog";
import { projectToWorldCoords } from "../model/geoRebase";
import type { Project } from "../model/types";
import { filterProjectToSelection } from "./exportScope";
import type { GroupMembership } from "./groupActions";
import { getState } from "./appStore";
import { t } from "../i18n";

export function useExportHandlers(opts: {
  project: Project;
  activeLevelId: string;
  activeLevelName: string;
  visibleCodes: Set<string>;
  categoryDisplay: CategoryDisplayResolver & DisplayResolver;
  detail: DetailLevel;
  referenceLines: boolean;
  planColorMode: "color" | "mono";
  /** Aktuelle Auswahl (alle Arten) — für den „nur Auswahl exportieren"-Scope. */
  selectionMembers: Partial<GroupMembership>;
  setExportOpen: (open: boolean) => void;
  setExportDxfOpen: (open: boolean) => void;
}): {
  onExportPdf: (decision: ExportPdfDecision) => Promise<void>;
  onExportSvg: (decision: ExportPdfDecision) => void;
  onExportDxf: (decision: ExportDxfDecision) => Promise<void>;
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
    selectionMembers,
    setExportOpen,
    setExportDxfOpen,
  } = opts;

  const scopedProject = (selectionOnly: boolean): Project =>
    selectionOnly ? filterProjectToSelection(project, selectionMembers) : project;

  const onExportPdf = async (decision: ExportPdfDecision) => {
    const plan = generatePlan(
      scopedProject(decision.selectionOnly),
      activeLevelId,
      visibleCodes,
      categoryDisplay,
      detail,
      referenceLines,
      planColorMode === "mono",
      true, // includeGlobal (Default, explizit weil forPrint danach folgt)
      decision.scaleDenominator, // Export-Massstab: Bemassung in Papier-mm, Strichstärken nach Massstab
      true, // forPrint: `Drawing2D.noPrint`-Elemente ausschliessen
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

  // SVG-Export: dieselbe Plan-Erzeugung + denselben Massstab/Papier/
  // Ausrichtung wie der PDF-Export (Nutzer-Wunsch „Kein SVG-Export"), nur
  // ohne den jsPDF/svg2pdf-Umweg — reiner Download des Druck-SVG.
  const onExportSvg = (decision: ExportPdfDecision) => {
    const plan = generatePlan(
      scopedProject(decision.selectionOnly),
      activeLevelId,
      visibleCodes,
      categoryDisplay,
      detail,
      referenceLines,
      planColorMode === "mono",
      true, // includeGlobal (Default)
      decision.scaleDenominator, // wie PDF
      true, // forPrint: `Drawing2D.noPrint`-Elemente ausschliessen
    );
    savePlanSvg(plan, {
      scaleDenominator: decision.scaleDenominator,
      paper: decision.paper,
      orientation: decision.orientation,
      fileName: `${project.name}-${activeLevelName}`,
    });
    setExportOpen(false);
  };

  // DXF-/DWG-Export: erzeugt den Plan mit EXAKT denselben Eingaben wie die Ansicht und
  // schreibt ihn als Modell-Space-Datei in echten Metern (1:1). Layer aus den
  // Kategorie-Ebenen; jede Entity auf ihrem Kategorie-Layer. Asynchron, weil das
  // Format-Modul (acadrust, pkgFileIo) erst beim ersten Export nachgeladen wird.
  const onExportDxf = async (decision: ExportDxfDecision) => {
    // Georeferenziert exportieren: bei gesetztem Standort-Bezug (geoAnchor)
    // schreibt der Modell-DXF die ECHTEN LV95-Koordinaten (weit vom Nullpunkt),
    // damit die Datei in anderer CAD-Software lagerichtig ankommt — auch wenn
    // lokal nahe (0,0) gezeichnet wurde. Ohne Bezug bleibt alles lokal.
    // (Der Papier-/Layout-Export bleibt bewusst in lokalen Koordinaten.)
    const exportProject = projectToWorldCoords(scopedProject(decision.selectionOnly));
    const plan = generatePlan(
      exportProject,
      activeLevelId,
      visibleCodes,
      categoryDisplay,
      detail,
      referenceLines,
      planColorMode === "mono",
      true, // includeGlobal (Default)
      decision.scaleDenominator, // Export-Massstab (wie PDF): Strichstärken, Bemassung
      true, // forPrint: `Drawing2D.noPrint`-Elemente ausschliessen
    );
    try {
      await savePlanDxf(plan, exportProject, {
        title: activeLevelName,
        includeHatches: decision.includeHatches,
        format: decision.format,
        scaleDenominator: decision.scaleDenominator,
        dimUnit: decision.dimUnit,
        paperLayout: decision.paperLayout,
        levelId: activeLevelId,
        fileName: `${project.name}-${activeLevelName}`,
      });
    } catch (err) {
      getState().notify(`${t("exportDxf.failed")}: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    setExportDxfOpen(false);
  };

  return { onExportPdf, onExportSvg, onExportDxf };
}
