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
import { Dropdown } from "../Dropdown";
import type { DropdownItem } from "../Dropdown";
import { RIBBON_TABS, ALL_RIBBON_ITEMS, itemKey, itemFromKey } from "./ribbonItems";
import type { RibbonItem, RibbonTabId } from "./ribbonItems";
import { CommandIcon } from "./CommandIcon";

/** Aufgelöste Beschriftung eines Items (Werkzeug bzw. Befehl). */
function itemLabel(item: RibbonItem): string {
  if (item.kind === "tool") return t(getTool(item.id).labelKey);
  const cmd = getCommand(item.name);
  return cmd ? t(cmd.labelKey) : item.name;
}

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
   * Reicher Custom-Inhalt je Tab (statt datengetriebener Item-Gruppen) — z. B.
   * „Ansichten" (`ViewRibbonTab`) und „Text" (`TextGroup`). Von App geliefert,
   * damit deren Setter/State dort bleiben. Ein Tab ohne Custom-Inhalt und ohne
   * Gruppen zeigt den Leer-Hinweis.
   */
  tabContent?: Partial<Record<RibbonTabId, ReactNode>>;
  /** Persistierte Item-Schlüssel der modularen Custom-Bar (Tab „Eigene"). */
  customItems: string[];
  /** Ein Item in der Custom-Bar an-/abwählen (Picker im „Eigene"-Tab). */
  onToggleCustomItem: (key: string) => void;
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
  // Befehls-Element: Label aus der Befehls-Registry ableiten. Für Aktionen ohne
  // eigenes Engine-Kommando (z. B. „rotate", das über die interaktive
  // Transformation läuft) auf den i18n-Schlüssel `cmd.<name>.label` zurückfallen.
  const cmd = getCommand(item.name);
  const label = cmd ? t(cmd.labelKey) : t(`cmd.${item.name}.label`);
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

/**
 * Modulare Custom-Bar (Tab „Eigene") — rendert die vom Nutzer gewählten Items
 * plus einen „＋"-Picker, der ALLE verfügbaren Werkzeuge/Befehle mit Häkchen für
 * die bereits enthaltenen listet (Klick = an-/abwählen). Gleiche Item-Typen +
 * gleiche Aktivierung wie die normalen Tabs — kein Sonderweg.
 */
function CustomBar({
  customItems,
  onToggle,
  ctx,
}: {
  customItems: string[];
  onToggle: (key: string) => void;
  ctx: ButtonCtx;
}) {
  const pickerItems: DropdownItem[] = ALL_RIBBON_ITEMS.map((it) => {
    const key = itemKey(it);
    return {
      label: itemLabel(it),
      active: customItems.includes(key),
      onSelect: () => onToggle(key),
    };
  });
  const items = customItems
    .map(itemFromKey)
    .filter((it): it is RibbonItem => it !== null);
  return (
    <div className="ribbon-group">
      <div className="ribbon-items">
        {items.length === 0 && (
          <div className="ribbon-empty">{t("ribbon.custom.empty")}</div>
        )}
        {items.map((item, i) => (
          <RibbonButton key={`${itemKey(item)}-${i}`} item={item} ctx={ctx} />
        ))}
        <Dropdown
          items={pickerItems}
          placeholder={t("ribbon.custom.add")}
          title={t("ribbon.custom.add")}
          triggerClassName="ribbon-add"
        />
      </div>
      <div className="ribbon-group-title">{t("ribbon.group.custom")}</div>
    </div>
  );
}

export function RibbonBar(props: RibbonBarProps) {
  const current = RIBBON_TABS.find((tt) => tt.id === props.tab) ?? RIBBON_TABS[0];
  const custom = props.tabContent?.[current.id];
  const ctx: ButtonCtx = {
    activeTool: props.activeTool,
    activeCommand: props.activeCommand,
    toolsEnabled: props.toolsEnabled,
    onSelectTool: props.onSelectTool,
    onRunCommand: props.onRunCommand,
  };

  return (
    <div className="ribbon">
      {/* Inhalt des aktiven Tabs. Tabs mit reichem Custom-Inhalt („Ansichten",
          „Text") rendern diesen; der „Eigene"-Tab die modulare Custom-Bar; sonst
          die datengetriebenen Item-Gruppen. */}
      <div className="ribbon-body">
        {current.id === "custom" ? (
          <CustomBar
            customItems={props.customItems}
            onToggle={props.onToggleCustomItem}
            ctx={ctx}
          />
        ) : custom ? (
          custom
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
