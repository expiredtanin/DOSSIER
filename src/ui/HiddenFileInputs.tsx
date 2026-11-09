// Versteckte Datei-Felder der App ([163], aus App.tsx herausgelöst): DXF/DWG/IFC/PDF, STEP, IFC,
// Bild/PDF, Projektdatei und Vorlage, dazu die Hosts für Punktwolken- und Mesh-Import. Menüs, Befehle
// und Werkzeuge öffnen den Dateidialog über die Refs (`ref.current.click()`); die gewählte Datei geht
// an den jeweiligen Handler. Gerendert von `App.tsx` ganz oben im Editor; memoisiert ([121]), die
// Handler kommen mit stabiler Identität aus dem Handler-Bündel der App.

import { memo, type RefObject } from "react";
import { PROJECT_TEMPLATE_EXT } from "../native/projectFile";
import type { MeshPlacement, MeshRead } from "../io/meshImport";
import { MeshImportHost } from "./MeshImportDialog";
import { PointCloudImportHost } from "./PointCloudImportDialog";
import type { NotifyKind } from "../state/notifySlice";

export const HiddenFileInputs = memo(function HiddenFileInputs(props: {
  dxfInputRef: RefObject<HTMLInputElement>;
  stepInputRef: RefObject<HTMLInputElement>;
  ifcInputRef: RefObject<HTMLInputElement>;
  imageInputRef: RefObject<HTMLInputElement>;
  projectFileInputRef: RefObject<HTMLInputElement>;
  projectTemplateFileInputRef: RefObject<HTMLInputElement>;
  openImportForAnyFile: (f: File) => void;
  importStepFile: (f: File) => void;
  importIfcFile: (f: File) => void;
  onImageOrPdfFileChosen: (f: File) => void;
  onProjectFileChosen: (f: File) => void;
  onProjectTemplateFileChosen: (f: File) => void;
  notify: (message: string, kind?: NotifyKind) => void;
  /** Stabile Identität (aus dem Handler-Bündel der App). */
  onMeshImport: (read: MeshRead, fileName: string, placement: MeshPlacement) => void;
}) {
  const {
    dxfInputRef,
    stepInputRef,
    ifcInputRef,
    imageInputRef,
    projectFileInputRef,
    projectTemplateFileInputRef,
    openImportForAnyFile,
    importStepFile,
    importIfcFile,
    onImageOrPdfFileChosen,
    onProjectFileChosen,
    onProjectTemplateFileChosen,
    notify,
  } = props;
  return (
    <>
    {/* Verstecktes DXF-Datei-Input (Site-Panel/„import"-Befehl triggern es). */}
    <input
      ref={dxfInputRef}
      type="file"
      accept=".dxf,.dwg,.ifc,.pdf,text/plain"
      style={{ display: "none" }}
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) openImportForAnyFile(f);
        e.target.value = "";
      }}
    />
    {/* Verstecktes STEP-Datei-Input (Menü Datei, STEP importieren). */}
    <input
      ref={stepInputRef}
      type="file"
      accept=".stp,.step,.p21"
      style={{ display: "none" }}
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;
        importStepFile(f);
      }}
    />
    {/* Punktwolken-Import ([27]): verstecktes Datei-Feld + Dialog (UI-Store, nicht im Projekt). */}
    <PointCloudImportHost />
    {/* 3D-Modell-Import (OBJ/STL/glTF/GLB/PLY): verstecktes Datei-Feld + Dialog. */}
    <MeshImportHost notify={notify} onImport={props.onMeshImport} />
    {/* Verstecktes IFC-Datei-Input (Menü Datei, IFC importieren). */}
    <input
      ref={ifcInputRef}
      type="file"
      accept=".ifc"
      style={{ display: "none" }}
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) importIfcFile(f);
      }}
    />
    {/* Verstecktes Bild/PDF-Datei-Input (Werkzeug „image"). */}
    <input
      ref={imageInputRef}
      type="file"
      accept="image/*,.pdf,application/pdf"
      style={{ display: "none" }}
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) onImageOrPdfFileChosen(f);
        e.target.value = "";
      }}
    />
    {/* Verstecktes Projekt-Datei-Input (Datei-Burger „Öffnen"). */}
    <input
      ref={projectFileInputRef}
      type="file"
      accept="application/json,.json,.obp"
      style={{ display: "none" }}
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) onProjectFileChosen(f);
        e.target.value = "";
      }}
    />
    {/* Verstecktes Vorlagen-Datei-Input („Neu aus Vorlage" → Datei wählen). */}
    <input
      ref={projectTemplateFileInputRef}
      type="file"
      accept={`.${PROJECT_TEMPLATE_EXT}`}
      style={{ display: "none" }}
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) onProjectTemplateFileChosen(f);
        e.target.value = "";
      }}
    />
    </>
  );
});
