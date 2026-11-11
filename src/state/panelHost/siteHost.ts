// Panel-Host, Teil Lage und Elemente-Baum ([121], aus `usePanelHostBase` herausgelöst):
// Gelände-/Umgebungs-Elemente (Gelände, Aushub, Georeferenz, DXF-Import, Auswahl im Elemente-Panel) und die Auswahl einer Zeile im
// Elemente-Panel samt Geschosswechsel und Zoom.

import { setFieldIfChanged } from "../../core";
import { clearKinds, type SelectionKind } from "../selection";
import type { ScheduleKind } from "../../export/exportSchedule";
import type { FlatHostOpts, HostPart } from "./types";

export function buildSiteHost(c: FlatHostOpts) {
  const { activeLevelId, addContextObjectsAndFit, applyChange, dxfInputRef, generateTerrain, onRunCommand, patchContextObject, planViewRef, setActiveLevelId, setSelection } = c;
  return {
    // ── Gelände und Umgebung ───────────────────────────────────────────────
    onAddContextObjects: addContextObjectsAndFit,
    onSelectSiteElement: (id: string, opts?: { zoom?: boolean }) => {
      setSelection({ ...clearKinds(), contextObjects: [id] });
      if (opts?.zoom) requestAnimationFrame(() => planViewRef.current?.fit());
    },
    onGenerateTerrain: generateTerrain,
    onPatchContextObject: patchContextObject,
    onStartExcavation: () => onRunCommand("excavation"),
    onSetGeoAnchor: (anchor) => {
      applyChange((p) => setFieldIfChanged(p, "geoAnchor", anchor));
    },
    onImportDxf: () => dxfInputRef.current?.click(),
    onStartGeoref: () => onRunCommand("georef"),
    // ── Element-Baum (Elemente-Panel) ────────────────────────────────────
    onSelectScheduleRow: (
      kind: ScheduleKind,
      id: string,
      floorId: string | undefined,
      opts?: { zoom?: boolean },
    ) => {
      const applySelection = () => {
        const kindOf: Partial<Record<ScheduleKind, SelectionKind>> = {
          Wand: "walls",
          Decke: "ceilings",
          Fenster: "openings",
          Öffnung: "openings",
          Treppe: "stairs",
          Extrusion: "solids",
          Dach: "roofs",
          Stütze: "columns",
        };
        const k = kindOf[kind];
        setSelection({ ...clearKinds(), ...(k ? { [k]: [id] } : {}) });
        // z. B. Legacy-„Tür"-Datensätze (project.doors) — kein Auswahl-Kanal.
        if (!k) return;
        if (opts?.zoom) requestAnimationFrame(() => planViewRef.current?.fit());
      };
      if (floorId && floorId !== activeLevelId) {
        // Der Geschosswechsel-Effekt (oben, deps [activeLevelId]) leert die
        // Auswahl NACH diesem Render — die neue Auswahl daher einen Tick
        // später anwenden, sonst überschreibt der Effekt sie sofort wieder.
        setActiveLevelId(floorId);
        requestAnimationFrame(applySelection);
      } else {
        applySelection();
      }
    },

  } satisfies HostPart;
}
