// [195] Inhalt des Fensters „Objekteinstellungen" (Taste T, wie Archicad Cmd+T): folgt der Auswahl und zeigt zwei
// Bereiche — „Objekt" (Objekt-Info samt Abschnitten) und „Darstellung" (Attribute: Stift, Füllung, Schraffur,
// Linienstil, Linienenden). Keine eigenen Felder: es sind dieselben Komponenten wie in den Dock-Panels, also
// dieselben Handler (Ops mit Undo, Regler/Tippen über coalesceKey) und keine Doppelspur.

import { useSyncExternalStore } from "react";
import { t } from "../../i18n";
import { useStore } from "../../state/appStore";
import { useSelectionInfo } from "../../state/useSelectionInfo";
import { AttributesPanel } from "../AttributesPanel";
import { usePanelHost } from "../host";
import { ObjectInfoPanel } from "../ObjectInfoPanel";
import { settingsAreas, type SettingsArea } from "./areas";
import { getSettingsArea, setSettingsArea, subscribeSettingsArea } from "./areaState";

const AREA_TITLE = { object: "objsettings.area.object", appearance: "objsettings.area.appearance" } as const;

export function ObjectSettingsPanel() {
  const host = usePanelHost();
  const sel = useSelectionInfo();
  const otherSelected = useStore((s) => s.selection.trees.length + s.selection.cameras.length + s.selection.site.length > 0);
  const isGrid = useStore((s) => (sel?.kind === "drawing2d" ? s.project.drawings2d.find((d) => d.id === sel.id)?.geom.shape === "grid" : false));
  const wanted = useSyncExternalStore(subscribeSettingsArea, getSettingsArea, getSettingsArea);

  const areas = settingsAreas({
    sel,
    otherSelected,
    isGrid,
    sectionLine: !!host.sectionLine,
    newComponentTool: host.activeTool === "wall" || host.activeTool === "ceiling",
  });
  if (areas.length === 0) {
    return (
      <div className="objset-panel">
        <div className="objset-empty">{t("attr.empty")}</div>
      </div>
    );
  }
  // Fehlt der gewünschte Bereich für diese Auswahl, zeigt das Fenster den ersten vorhandenen.
  const area: SettingsArea = areas.includes(wanted) ? wanted : areas[0];
  return (
    <div className="objset-panel" data-area={area}>
      {areas.length > 1 && (
        <div className="objset-tabs" role="tablist">
          {areas.map((a) => (
            <button
              key={a}
              type="button"
              role="tab"
              aria-selected={a === area}
              className="objset-tab"
              data-area={a}
              onClick={() => setSettingsArea(a)}
            >
              {t(AREA_TITLE[a])}
            </button>
          ))}
        </div>
      )}
      <div className="objset-body" role="tabpanel" aria-label={t(AREA_TITLE[area])}>
        {area === "object" ? <ObjectInfoPanel /> : <AttributesPanel />}
      </div>
    </div>
  );
}
