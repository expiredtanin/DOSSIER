// Bündelt die PDF-/DXF-Plan-Export-Handler (Papier-/Modell-Space-Export der
// aktuellen Grundriss-Ansicht) — die Schnellexporte (CSV/IFC/OBJ/STL) liegen
// bereits in useProjectFileActions(). Nur aus App.tsx herausgezogen, um die
// Funktion zu entlasten — reine Verlagerung, keine Verhaltensänderung. Dazu das Inhaltsmass
// des Plans für die „passt aufs Blatt?"-Warnung im PDF-Dialog ([163]).
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useMemo } from "react";
import { generatePlan, withDocument } from "../core";
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
import { getState, useStore } from "./appStore";
import { t } from "../i18n";

export function useExportHandlers(opts: {
  /** PDF-Export-Dialog offen? Nur dann wird das Inhaltsmass gerechnet. */
  exportOpen: boolean;
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
  exportContentMeters: { w: number; h: number } | undefined;
  onExportPdf: (decision: ExportPdfDecision) => Promise<void>;
  onExportSvg: (decision: ExportPdfDecision) => void;
  onExportDxf: (decision: ExportDxfDecision) => Promise<void>;
} {
  const {
    exportOpen,
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

  // Massstäbliche Inhalts-Maße (Meter) des aktuellen Plans — nur berechnet, wenn
  // der Export-Dialog offen ist (für die „passt aufs Blatt?"-Warnung). Das Projekt nur dann abonnieren
  // ([121]: sonst rendert der Aufrufer `App` bei jeder Modelländerung).
  const project = useStore((s) => (exportOpen ? s.project : null));
  const exportContentMeters = useMemo(() => {
    if (!project) return undefined;
    const b = generatePlan(
      project,
      activeLevelId,
      visibleCodes,
      categoryDisplay,
      detail,
      referenceLines,
      planColorMode === "mono",
    ).bounds;
    return { w: b.maxX - b.minX, h: b.maxY - b.minY };
  }, [
    exportOpen,
    project,
    activeLevelId,
    visibleCodes,
    categoryDisplay,
    detail,
    referenceLines,
    planColorMode,
  ]);

  const scopedProject = (selectionOnly: boolean): Project => {
    const p = getState().project;
    return selectionOnly ? filterProjectToSelection(p, selectionMembers) : p;
  };

  // Gefilterte/verschobene Kopie = eigenes, kurzlebiges Kern-Dokument ([122]); das ganze Projekt läuft
  // direkt über das Dokument des Stores.
  const onExportPdf = async (decision: ExportPdfDecision) => {
    const scoped = scopedProject(decision.selectionOnly);
    const plan = withDocument(scoped, () => generatePlan(
      scoped,
      activeLevelId,
      visibleCodes,
      categoryDisplay,
      detail,
      referenceLines,
      planColorMode === "mono",
      true, // includeGlobal (Default, explizit weil forPrint danach folgt)
      decision.scaleDenominator, // Export-Massstab: Bemassung in Papier-mm, Strichstärken nach Massstab
      true, // forPrint: `Drawing2D.noPrint`-Elemente ausschliessen
    ));
    await savePlanPdf(plan, {
      scaleDenominator: decision.scaleDenominator,
      paper: decision.paper,
      orientation: decision.orientation,
      title: activeLevelName,
      subtitle: getState().project.name,
      fileName: `${getState().project.name}-${activeLevelName}`,
    });
    setExportOpen(false);
  };

  // SVG-Export: dieselbe Plan-Erzeugung + denselben Massstab/Papier/
  // Ausrichtung wie der PDF-Export (Nutzer-Wunsch „Kein SVG-Export"), nur
  // ohne den jsPDF/svg2pdf-Umweg — reiner Download des Druck-SVG.
  const onExportSvg = (decision: ExportPdfDecision) => {
    const scoped = scopedProject(decision.selectionOnly);
    const plan = withDocument(scoped, () => generatePlan(
      scoped,
      activeLevelId,
      visibleCodes,
      categoryDisplay,
      detail,
      referenceLines,
      planColorMode === "mono",
      true, // includeGlobal (Default)
      decision.scaleDenominator, // wie PDF
      true, // forPrint: `Drawing2D.noPrint`-Elemente ausschliessen
    ));
    savePlanSvg(plan, {
      scaleDenominator: decision.scaleDenominator,
      paper: decision.paper,
      orientation: decision.orientation,
      fileName: `${getState().project.name}-${activeLevelName}`,
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
    const scoped = scopedProject(decision.selectionOnly);
    const exportProject = withDocument(scoped, () => projectToWorldCoords(scoped));
    await withDocument(exportProject, async () => {
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
        fileName: `${getState().project.name}-${activeLevelName}`,
      });
    } catch (err) {
      getState().notify(`${t("exportDxf.failed")}: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    });
    setExportDxfOpen(false);
  };

  return { exportContentMeters, onExportPdf, onExportSvg, onExportDxf };
}
