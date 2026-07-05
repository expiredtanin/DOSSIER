// Ribbon-Oberleiste (docs/design/ribbon-ui-plan.md, Phase 1) — datengetriebene
// Tab-Leiste unter der TopBar. Zeigt je Tab (2D · 3D · BIM · Ansichten) die
// gruppierten Werkzeuge/Befehle aus `RIBBON_TABS`. ADDITIV: die Werkzeug-Sidebar
// (ToolsPanel) bleibt vorerst funktionsfähig — beide teilen sich denselben
// Aktivierungs-Pfad (onSelectTool / engine.start), es gibt keine Duplikat-Logik.
//
// Werkzeug-Elemente laufen über `onSelectTool` (gekoppelte Befehle inklusive,
// wie in der Sidebar); Befehls-Elemente über `onRunCommand` (engine.start). Das
// Aktiv-Highlight spiegelt für Werkzeuge `activeTool`, für Befehle den laufenden
// Befehl (`activeCommand`).
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useState } from "react";
import type { ReactNode } from "react";
import { t } from "../../i18n";
import { ToolIcon } from "../../panels/ToolsPanel";
import { getTool } from "../../tools/tools";
import type { ToolId } from "../../tools/types";
import { getCommand } from "../../commands/registry";
import { RIBBON_TABS } from "./ribbonItems";
import type { RibbonItem, RibbonTabId } from "./ribbonItems";
import { CommandIcon } from "./CommandIcon";

export interface RibbonBarProps {
  /** Aktives Werkzeug (Highlight der `tool`-Elemente). */
  activeTool: ToolId;
  /** Name des laufenden Engine-Befehls (Highlight der `command`-Elemente). */
  activeCommand: string | null;
  /** Ob Boden-gebundene (`floorOnly`) Werkzeuge nutzbar sind (aktives Geschoss). */
  toolsEnabled: boolean;
  /** Werkzeug aktivieren (gleicher Pfad wie die Sidebar). */
  onSelectTool: (id: ToolId) => void;
  /** Engine-Befehl starten (Ändern-Gruppe u. a.). */
  onRunCommand: (name: string) => void;
  /**
   * Reicher Inhalt des „Ansichten"-Tabs (aus der TopBar gemergte Ansichts-/Zoom-/
   * Darstellungs-Steuerung, `ViewRibbonTab`). Von App geliefert, damit dessen
   * Setter/State dort bleiben — analog dazu, wie die TopBar das Layout-Menü als
   * Node bekommt. Fehlt er, zeigt der Tab den Leer-Hinweis.
   */
  viewsContent?: ReactNode;
}

/** Ein einzelner Ribbon-Button (Werkzeug ODER Befehl). */
function RibbonButton({
  item,
  activeTool,
  activeCommand,
  toolsEnabled,
  onSelectTool,
  onRunCommand,
}: {
  item: RibbonItem;
} & Omit<RibbonBarProps, "activeCommand"> & { activeCommand: string | null }) {
  if (item.kind === "tool") {
    const tool = getTool(item.id);
    // Nur Boden-gebundene Werkzeuge sind ohne aktives Geschoss gesperrt; freie
    // 2D-Werkzeuge (Linie/Kreis/…) bleiben auch auf Zeichnungsebenen nutzbar.
    const disabled = !!tool.floorOnly && !toolsEnabled;
    const active = activeTool === item.id;
    const label = t(tool.labelKey);
    return (
      <button
        type="button"
        className={`ribbon-btn${active ? " active" : ""}`}
        disabled={disabled}
        title={disabled ? t("tool.floorOnlyDisabled") : label}
        onClick={() => onSelectTool(item.id)}
      >
        <ToolIcon id={item.id} />
        <span>{label}</span>
      </button>
    );
  }
  // Befehls-Element: Label aus der Befehls-Registry ableiten.
  const cmd = getCommand(item.name);
  const label = cmd ? t(cmd.labelKey) : item.name;
  const active = activeCommand === item.name;
  return (
    <button
      type="button"
      className={`ribbon-btn${active ? " active" : ""}`}
      title={label}
      onClick={() => onRunCommand(item.name)}
    >
      <CommandIcon name={item.name} />
      <span>{label}</span>
    </button>
  );
}

export function RibbonBar(props: RibbonBarProps) {
  const [tab, setTab] = useState<RibbonTabId>("2d");
  const current = RIBBON_TABS.find((tt) => tt.id === tab) ?? RIBBON_TABS[0];

  return (
    <div className="ribbon">
      {/* Tab-Reiter */}
      <div className="ribbon-tabs" role="tablist">
        {RIBBON_TABS.map((tt) => (
          <button
            key={tt.id}
            type="button"
            role="tab"
            aria-selected={tt.id === tab}
            className={`ribbon-tab${tt.id === tab ? " active" : ""}`}
            onClick={() => setTab(tt.id)}
          >
            {t(tt.labelKey)}
          </button>
        ))}
      </div>

      {/* Gruppen des aktiven Tabs. Der „Ansichten"-Tab trägt reichen Custom-
          Inhalt (ViewRibbonTab) statt der datengetriebenen Item-Gruppen. */}
      <div className="ribbon-body">
        {current.id === "views" && props.viewsContent ? (
          props.viewsContent
        ) : current.groups.length === 0 ? (
          <div className="ribbon-empty">{t("ribbon.empty")}</div>
        ) : (
          current.groups.map((g) => (
            <div key={g.titleKey} className="ribbon-group">
              <div className="ribbon-items">
                {g.items.map((item) => (
                  <RibbonButton
                    key={item.kind === "tool" ? `t:${item.id}` : `c:${item.name}`}
                    item={item}
                    activeTool={props.activeTool}
                    activeCommand={props.activeCommand}
                    toolsEnabled={props.toolsEnabled}
                    onSelectTool={props.onSelectTool}
                    onRunCommand={props.onRunCommand}
                  />
                ))}
              </div>
              <div className="ribbon-group-title">{t(g.titleKey)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
