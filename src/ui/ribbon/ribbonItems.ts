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
export type RibbonTabId = "2d" | "3d" | "bim" | "text" | "views";

/** Ein Ribbon-Tab: Beschriftung + gruppierte Elemente. */
export interface RibbonTab {
  id: RibbonTabId;
  labelKey: string;
  groups: RibbonGroup[];
}

const t = (id: ToolId): RibbonItem => ({ kind: "tool", id });
const c = (name: string): RibbonItem => ({ kind: "command", name });

/**
 * Die Ribbon-Tabs (Reihenfolge 2D·3D·BIM·Ansichten). 2D (Zeichnen + Ändern) und
 * BIM (Bauteile) sind datengetrieben aus Werkzeugen/Befehlen; „Ansichten" trägt
 * reichen Custom-Inhalt (aus der TopBar gemergt, siehe `ViewRibbonTab` — die
 * Registry lässt seine `groups` leer). 3D ist vorerst leer (spätere Phase).
 */
export const RIBBON_TABS: RibbonTab[] = [
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
        ],
      },
      {
        titleKey: "ribbon.group.modify",
        items: [
          c("move"),
          c("copy"),
          c("mirror"),
          c("offset"),
          c("trim"),
          c("join"),
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
          t("ceiling"),
          t("room"),
        ],
      },
    ],
  },
  {
    // Custom-Inhalt: die Text-/Font-Formatierung (TextGroup), via tabContent.
    id: "text",
    labelKey: "ribbon.tab.text",
    groups: [],
  },
  {
    id: "views",
    labelKey: "ribbon.tab.views",
    groups: [],
  },
];
