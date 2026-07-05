// Ribbon-Inhaltsleiste (docs/design/ribbon-ui-plan.md) — rendert den INHALT des
// aktiven Ribbon-Tabs. Die Tab-REITER selbst sitzen in der TopBar-Zeile (eine
// Leiste: globales Chrome + Tabs), damit es nur ZWEI Bänder gibt: TopBar-Zeile
// (mit Tabs) oben, Ribbon-Inhalt darunter. Der aktive Tab wird als `tab`-Prop
// hereingereicht (State liegt in App, geteilt mit der TopBar).
//
// Werkzeug-Elemente laufen über `onSelectTool` (gekoppelte Befehle inklusive, wie
// in der Sidebar); Befehls-Elemente über `onRunCommand` (engine.start). Der
// „Ansichten"-Tab trägt reichen Custom-Inhalt (`viewsContent`, aus der TopBar
// gemergt) statt datengetriebener Item-Gruppen.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

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
  /** Aktiver Tab (State liegt in App, geteilt mit den Reitern in der TopBar). */
  tab: RibbonTabId;
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
   * Setter/State dort bleiben. Fehlt er, zeigt der Tab den Leer-Hinweis.
   */
  viewsContent?: ReactNode;
}

/** Aktivierungs-/Highlight-Kontext, den jeder Button-Typ braucht. */
interface ButtonCtx {
  activeTool: ToolId;
  activeCommand: string | null;
  toolsEnabled: boolean;
  onSelectTool: (id: ToolId) => void;
  onRunCommand: (name: string) => void;
}

/** Ein einzelner Ribbon-Button (Werkzeug ODER Befehl). */
function RibbonButton({ item, ctx }: { item: RibbonItem; ctx: ButtonCtx }) {
  if (item.kind === "tool") {
    const tool = getTool(item.id);
    // Nur Boden-gebundene Werkzeuge sind ohne aktives Geschoss gesperrt; freie
    // 2D-Werkzeuge (Linie/Kreis/…) bleiben auch auf Zeichnungsebenen nutzbar.
    const disabled = !!tool.floorOnly && !ctx.toolsEnabled;
    const active = ctx.activeTool === item.id;
    const label = t(tool.labelKey);
    return (
      <button
        type="button"
        className={`ribbon-btn${active ? " active" : ""}`}
        disabled={disabled}
        title={disabled ? t("tool.floorOnlyDisabled") : label}
        onClick={() => ctx.onSelectTool(item.id)}
      >
        <ToolIcon id={item.id} />
        <span>{label}</span>
      </button>
    );
  }
  // Befehls-Element: Label aus der Befehls-Registry ableiten.
  const cmd = getCommand(item.name);
  const label = cmd ? t(cmd.labelKey) : item.name;
  const active = ctx.activeCommand === item.name;
  return (
    <button
      type="button"
      className={`ribbon-btn${active ? " active" : ""}`}
      title={label}
      onClick={() => ctx.onRunCommand(item.name)}
    >
      <CommandIcon name={item.name} />
      <span>{label}</span>
    </button>
  );
}

/**
 * Die Tab-REITER — als eigene Komponente exportiert, weil sie in der TopBar-Zeile
 * gerendert werden (nicht hier). Rein gesteuert über `tab`/`onTab`.
 */
export function RibbonTabs({
  tab,
  onTab,
}: {
  tab: RibbonTabId;
  onTab: (id: RibbonTabId) => void;
}) {
  return (
    <div className="ribbon-tabs" role="tablist">
      {RIBBON_TABS.map((tt) => (
        <button
          key={tt.id}
          type="button"
          role="tab"
          aria-selected={tt.id === tab}
          className={`ribbon-tab${tt.id === tab ? " active" : ""}`}
          onClick={() => onTab(tt.id)}
        >
          {t(tt.labelKey)}
        </button>
      ))}
    </div>
  );
}

export function RibbonBar(props: RibbonBarProps) {
  const current = RIBBON_TABS.find((tt) => tt.id === props.tab) ?? RIBBON_TABS[0];
  const ctx: ButtonCtx = {
    activeTool: props.activeTool,
    activeCommand: props.activeCommand,
    toolsEnabled: props.toolsEnabled,
    onSelectTool: props.onSelectTool,
    onRunCommand: props.onRunCommand,
  };

  return (
    <div className="ribbon">
      {/* Inhalt des aktiven Tabs. Der „Ansichten"-Tab trägt reichen Custom-Inhalt
          (ViewRibbonTab) statt der datengetriebenen Item-Gruppen. */}
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
                    ctx={ctx}
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
