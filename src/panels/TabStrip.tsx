// Tab-Leiste eines Docks — ein Tab je Panel-ID, Icon+Titel aus der Registry.
//
// Rein darstellend: bekommt einen DockState (Reihenfolge der Panel-IDs +
// aktiver Tab) und meldet das Greifen eines Tabs über `onStartDrag`. Der
// Drag-Controller (panelDrag) entscheidet anhand der Bewegung, ob daraus ein
// Klick (Tab aktivieren) oder ein Ziehen (Reorder/Andocken/Lösen) wird — die
// Leiste selbst kennt diese Logik nicht.
//
// Jeder Tab zeigt nur das Panel-Icon; der Titel steht als Tooltip (title-
// Attribut) und aria-label am Button. Hat ein Panel kein Icon (z. B. ein
// Plugin ohne eigenes Symbol), fällt der Tab auf den Titeltext zurück.
//
// Icon+Titel werden über die Registry (getPanel) aufgelöst, sodass die Leiste
// nichts über konkrete Panels weiß. IDs ohne registriertes Panel (z. B. ein
// abgeschaltetes Plugin) werden übersprungen — vgl. Hinweis in layout.ts.
//
// Datenattribute für die Drag-Trefferprüfung (panelDrag.resolveHover):
//   data-tabstrip="<dock>"      an der Leiste,
//   data-group-index="<g>"      an der Leiste (welche Gruppe im Dock),
//   data-tab-index="<i>"        an jedem Tab.
//
// Viele Tabs laufen nicht um, sondern werden horizontal scrollbar (die Leiste
// trägt .tabstrip mit overflow-x in styles.css). So bleibt jeder Tab erreichbar,
// ohne ein zusätzliches Überlaufmenü zu brauchen.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { getPanel } from "./registry";
import type { DockGroup, DockId } from "./types";
import { t } from "../i18n";

export interface TabStripProps {
  /** Welches Dock diese Leiste darstellt (für die Drag-Auflösung). */
  side: DockId;
  /** Index der Gruppe im Dock (für die Drag-Auflösung). */
  groupIndex: number;
  /** Zustand der Gruppe (liefert tabs-Reihenfolge + activeTab). */
  group: DockGroup;
  /**
   * Beginn einer Tab-Geste (pointerdown auf einem Tab). Der Drag-Controller
   * entscheidet über die Bewegung, ob Klick oder Ziehen.
   */
  onStartDrag: (panelId: string, e: React.PointerEvent) => void;
}

/**
 * Reihe greifbarer Tabs für eine Dock-Gruppe. Der aktive Tab ist hervorgehoben;
 * das Greifen eines Tabs meldet `onStartDrag` (Klick vs. Ziehen klärt der
 * Controller).
 */
export function TabStrip({ side, groupIndex, group, onStartDrag }: TabStripProps) {
  return (
    <div
      className="tabstrip"
      role="tablist"
      data-tabstrip={side}
      data-group-index={groupIndex}
    >
      {group.tabs.map((id, index) => {
        const def = getPanel(id);
        // Unbekannte ID (kein registriertes Panel) überspringen.
        if (!def) return null;
        const active = id === group.activeTab;
        const title = t(def.title);
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={title}
            title={title}
            data-tab-index={index}
            className={`tab${active ? " active" : ""}`}
            onPointerDown={(e) => onStartDrag(id, e)}
          >
            {def.icon ?? title}
          </button>
        );
      })}
    </div>
  );
}
