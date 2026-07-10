// Ribbon-Registry (docs/design/ribbon-ui-plan.md §Architektur) — EINE
// datengetriebene Beschreibung aller Ribbon-Elemente. Die Ribbon-Tabs UND eine
// spätere modulare Custom-Bar (Phase 4) sind bloß zwei Ansichten über dieselbe
// Registry, ohne Sonderweg pro Element.
//
// Ein `RibbonItem` ist entweder ein Werkzeug (`tool` → onSelectTool, wie die
// Werkzeug-Sidebar) oder ein Engine-Befehl (`command` → engine.start). Beide
// münden in exakt DENSELBEN Pfad wie Klick in der alten Sidebar bzw. das Tippen
// des Befehlsnamens — keine Duplikate.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md). Sichtbare
// Texte kommen als i18n-Schlüssel und werden erst in der Komponente über t(...)
// aufgelöst.

import type { ToolId } from "../../tools/types";

/** Ein aktivierbares Ribbon-Element. Bei `command` wird die Beschriftung aus der
 *  Befehls-Registry (`getCommand(name).labelKey`) abgeleitet — kein doppeltes
 *  Pflegen von Labels. */
export type RibbonItem =
  | { kind: "tool"; id: ToolId }
  | { kind: "command"; name: string };

/** Eine benannte Gruppe von Elementen innerhalb eines Tabs. */
export interface RibbonGroup {
  titleKey: string;
  items: RibbonItem[];
}

/** Kennung eines Ribbon-Tabs (fest, für Tab-State + i18n). */
export type RibbonTabId = "views" | "2d" | "3d" | "bim" | "custom";

/** Ein Ribbon-Tab: Beschriftung + gruppierte Elemente. */
export interface RibbonTab {
  id: RibbonTabId;
  labelKey: string;
  groups: RibbonGroup[];
}

const t = (id: ToolId): RibbonItem => ({ kind: "tool", id });
const c = (name: string): RibbonItem => ({ kind: "command", name });

/**
 * Die Ribbon-Tabs (Reihenfolge Ansichten·2D·3D·BIM). „Ansichten" ist der
 * Standard-Tab (zuerst, initial aktiv) und trägt reichen Custom-Inhalt: die aus
 * der TopBar gemergte Ansichts-/Zoom-/Darstellungs-Steuerung UND die Text-/Font-
 * Formatierung auf DERSELBEN Leiste (`ViewRibbonTab` — `groups` bleibt leer). 2D
 * (Zeichnen + Ändern) und BIM (Bauteile) sind datengetrieben aus Werkzeugen/
 * Befehlen; 3D ist vorerst leer (spätere Phase).
 */
export const RIBBON_TABS: RibbonTab[] = [
  {
    // Custom-Inhalt (ViewRibbonTab): Ansichts-/Zoom-/Darstellungssteuerung + Text.
    id: "views",
    labelKey: "ribbon.tab.views",
    groups: [],
  },
  {
    id: "2d",
    labelKey: "ribbon.tab.2d",
    groups: [
      {
        titleKey: "ribbon.group.draw",
        items: [
          t("select"),
          t("line"),
          t("polyline"),
          t("rect"),
          t("circle"),
          t("arc"),
          t("text"),
          t("textbox"),
        ],
      },
      {
        titleKey: "ribbon.group.modify",
        items: [
          c("move"),
          c("copy"),
          c("rotate"),
          c("mirror"),
          c("offset"),
          c("trim"),
          c("join"),
          c("measure"),
        ],
      },
    ],
  },
  {
    id: "3d",
    labelKey: "ribbon.tab.3d",
    groups: [],
  },
  {
    id: "bim",
    labelKey: "ribbon.tab.bim",
    groups: [
      {
        titleKey: "ribbon.group.components",
        items: [
          t("wall"),
          t("window"),
          t("door"),
          t("stair"),
          c("column"),
          t("ceiling"),
          c("ceilingopening"),
          c("roof"),
          t("room"),
        ],
      },
      {
        titleKey: "ribbon.group.sections",
        items: [c("sectionline"), c("viewline")],
      },
    ],
  },
  {
    // Modulare Custom-Bar (Phase 4): der Nutzer stellt sich die Elemente selbst
    // zusammen (persistiert). Gerendert aus `customItems`, nicht aus `groups`.
    id: "custom",
    labelKey: "ribbon.tab.custom",
    groups: [],
  },
];

/** Stabiler Schlüssel eines Items für die Persistenz der Custom-Bar. */
export function itemKey(item: RibbonItem): string {
  return item.kind === "tool" ? `tool:${item.id}` : `command:${item.name}`;
}

/** Parst einen Item-Schlüssel zurück (oder null bei unbekanntem Präfix). */
export function itemFromKey(key: string): RibbonItem | null {
  const i = key.indexOf(":");
  if (i < 0) return null;
  const kind = key.slice(0, i);
  const rest = key.slice(i + 1);
  if (kind === "tool") return { kind: "tool", id: rest as ToolId };
  if (kind === "command") return { kind: "command", name: rest };
  return null;
}

/**
 * Alle datengetriebenen Items (aus den Werkzeug-/Befehls-Tabs) — die wählbare
 * Menge für den Custom-Bar-Picker. „views"/„custom" tragen keine `groups`.
 */
export const ALL_RIBBON_ITEMS: RibbonItem[] = RIBBON_TABS.flatMap((tab) =>
  tab.groups.flatMap((g) => g.items),
);
