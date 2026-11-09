// Modell-Importe mit eigenem Ablauf ([163], aus App.tsx herausgelöst): IFC (erst Wahl Mesh/Bauteile,
// dann Bericht), STEP und 3D-Meshes (OBJ/STL/glTF/PLY) werden im Kern als EIN Undo-Schritt übernommen
// (`commitImport`). `openImportForAnyFile` verteilt eine Datei aus Dialog oder Drag & Drop auf den
// passenden Import. Aufgerufen von `App.tsx` nach `useProjectFileActions` (braucht `openImportForFile`).

import { useState, type RefObject } from "react";
import type { ContextObject, Wall } from "../model/types";
import { addedItems } from "../core";
import { readStepFlat } from "../engine/truckSolid";
import { formatIfcElementsSummary, formatIfcReport, readIfcFlat, type IfcElementsSummary } from "../io/ifcImport";
import { formatMeshReport, isMeshFile, type MeshPlacement, type MeshRead } from "../io/meshImport";
import { isPointCloudFile } from "../io/pointCloud";
import type { IfcImportMode } from "../ui/IfcImportDialog";
import type { PlanViewHandle } from "../views/plan/PlanView";
import { t } from "../i18n";
import { getState, type RootState } from "./appStore";
import { requestMeshImport } from "./meshImportStore";
import { requestPointCloudImport } from "./pointCloudStore";
import type { useProjectActions } from "./useProjectActions";

export function useModelImport(opts: {
  notify: RootState["notify"];
  planViewRef: RefObject<PlanViewHandle | null>;
  fitToContextObjects: ReturnType<typeof useProjectActions>["fitToContextObjects"];
  /** DXF/DWG/PDF-Import-Dialog (aus `useProjectFileActions`). */
  openImportForFile: (f: File) => void;
}) {
  const { notify, planViewRef, fitToContextObjects, openImportForFile } = opts;

  // IFC-Import: erst die Wahl Mesh/Bauteile (`IfcImportDialog`), dann liest das Format-Modul (Web-Worker) und der
  // Kern übernimmt [B3] Kontext-Meshes oder [B4] echte Bauteile als EINEN Undo-Schritt ([K4] S4, `importIfc`).
  const [pendingIfc, setPendingIfc] = useState<File | null>(null);
  // Bericht nach dem Bauteil-Import ([B4]): erkannt je Bauteilart, als Mesh geblieben mit Grund.
  const [ifcReport, setIfcReport] = useState<{ fileName: string; summary: IfcElementsSummary } | null>(null);
  const importIfcFile = (f: File) => setPendingIfc(f);
  const runIfcImport = (f: File, mode: IfcImportMode) => {
    const elements = mode === "elements";
    void f
      .arrayBuffer()
      .then((buf) => readIfcFlat(new Uint8Array(buf), elements))
      .then((flat) => {
        const r = getState().commitImport((doc, base, now) => doc.importIfc(base, flat, { fileName: f.name, elements }, now), "history.import.ifc");
        if (!r) return;
        const report = r.report;
        if (elements && r.summary) {
          const bounds = addedItems(r.ops, "walls").flatMap((w) => [(w as Wall).start, (w as Wall).end]);
          if (bounds.length) planViewRef.current?.fitBounds(bounds);
          const s = r.summary;
          const empty = s.walls + s.ceilings + s.columns + s.rooms + s.meshes === 0;
          notify(formatIfcElementsSummary(s, report, t), empty || report.truncated ? "warning" : "info");
          setIfcReport({ fileName: f.name, summary: s });
          return;
        }
        fitToContextObjects(addedItems(r.ops, "context") as ContextObject[]);
        const warn = r.contextObjects === 0 || report.truncated || report.productsWithoutGeometry > 0;
        notify(formatIfcReport(report, t), warn ? "warning" : "info");
      })
      .catch((err) =>
        notify(`${t("ifc.import.failed")}: ${err instanceof Error ? err.message : String(err)}`, "error"),
      );
  };
  /** Datei aus Import-Dialog oder Drag & Drop: IFC direkt, sonst DXF/DWG-Dialog. */
  const openImportForAnyFile = (f: File) => {
    if (isMeshFile(f.name)) return requestMeshImport(f);
    if (isPointCloudFile(f.name)) return requestPointCloudImport(f);
    if (/\.ifc$/i.test(f.name)) importIfcFile(f);
    else openImportForFile(f);
  };

  // STEP-Import (Menü Datei, STEP importieren).
  const importStepFile = (f: File) => {
    void f
      .text()
      .then((text) => readStepFlat(text))
      .then((flat) => {
        // Der Kern macht je Körper ein Kontext-Mesh und übernimmt sie als EINEN Undo-Schritt ([K4] S4).
        const r = getState().commitImport((doc, base, now) => doc.importStep(base, flat, { fileName: f.name }, now));
        if (r) fitToContextObjects(addedItems(r.ops, "context") as ContextObject[]);
      })
      .catch((err) =>
        notify(`${t("step.import.failed")}: ${err instanceof Error ? err.message : String(err)}`, "error"),
      );
  };

  // 3D-Modell-Import (OBJ/STL/glTF/GLB/PLY) aus dem MeshImportHost.
  const onMeshImport = (read: MeshRead, fileName: string, placement: MeshPlacement) => {
    // Der Kern macht die Kontext-Meshes und übernimmt sie als EINEN Undo-Schritt ([K4] S4).
    const r = getState().commitImport((doc, base, now) => doc.importMesh(base, read.flat, { fileName, placement }, now), "history.import.mesh");
    if (!r) return;
    fitToContextObjects(addedItems(r.ops, "context") as ContextObject[]);
    notify(formatMeshReport(read.report, t), r.contextObjects === 0 || read.report.truncated ? "warning" : "info");
  };

  return {
    pendingIfc,
    setPendingIfc,
    ifcReport,
    setIfcReport,
    importIfcFile,
    runIfcImport,
    openImportForAnyFile,
    importStepFile,
    onMeshImport,
  };
}
