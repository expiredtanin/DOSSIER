// Abschnitt „Neues Bauteil" der Objekt-Info ([189], früher im Attribute-Panel): Aufbau-Typ für die nächste
// Wand bzw. Decke, solange das Wand-/Decken-Werkzeug aktiv ist. Wand und Decke teilen sich denselben Typ.

import { t } from "../../i18n";
import { wallTypeLabel } from "../../model/types";
import { useStore } from "../../state/appStore";
import { Dropdown } from "../../ui/Dropdown";
import type { usePanelHost } from "../host";

export function NewComponentSection({ host }: { host: ReturnType<typeof usePanelHost> }) {
  const wallTypes = useStore((s) => s.project.wallTypes);
  const components = useStore((s) => s.project.components);
  return (
    <div className="objinfo-field">
      <span className="objinfo-flabel">{t(host.activeTool === "wall" ? "tool.wallType" : "tool.ceilingType")}</span>
      <Dropdown
        value={host.activeWallTypeId}
        disabled={!host.toolsEnabled}
        onChange={(v) => host.onActiveWallTypeId(v)}
        options={wallTypes.map((wt) => ({ value: wt.id, label: wallTypeLabel(wt, components), title: wt.name }))}
      />
    </div>
  );
}
