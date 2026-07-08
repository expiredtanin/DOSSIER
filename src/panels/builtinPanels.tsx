// Registrierung der eingebauten Inhalts-Panels.
//
// Importiert man dieses Modul (Seiteneffekt), tragen sich die beiden
// dockbaren Kern-Panels in die Registry ein und tauchen damit in den Docks auf:
//   • "drawing-levels" — Zeichnungsebenen (mit Darstellungsmodus).
//   • "layers"         — Ebenen (Kategorie-Baum, mit Darstellungsmodus).
//
// „Ressourcen" ist KEIN Dock-Panel mehr: der ResourceManager ist ein
// schwebendes Fenster (Overlay über allem), das die Oberleiste öffnet — siehe
// App.tsx. Es wird daher hier nicht (mehr) registriert.
//
// Reine Verdrahtung: jedes Panel liest seinen Zustand selbst über den
// Host-Context (usePanelHost), daher reicht render() ohne ctx-Auswertung.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { registerPanel } from "./registry";
import { DrawingLevelsPanel } from "./DrawingLevelsPanel";
import { LayersPanel } from "./LayersPanel";
import { ToolsPanel } from "./ToolsPanel";
import { AttributesPanel } from "./AttributesPanel";
import { ObjectInfoPanel } from "./ObjectInfoPanel";
import { SitePanel } from "./SitePanel";
import { RoomBalancePanel } from "./RoomBalancePanel";
import { ElementTreePanel, ElementsTabIcon } from "./ElementTreePanel";
import { ViewSnapshotsPanel, ViewSnapshotsTabIcon } from "./ViewSnapshotsPanel";
import { LayoutsPanel, LayoutsTabIcon } from "./LayoutsPanel";
import {
  ToolsTabIcon,
  AttributesTabIcon,
  ObjectInfoTabIcon,
  DrawingLevelsTabIcon,
  LayersTabIcon,
  SiteTabIcon,
  RoomBalanceTabIcon,
} from "./PanelIcons";

/** IDs der eingebauten Dock-Panels (auch für defaultLayout/Filter nutzbar). */
export const BUILTIN_PANEL_IDS = {
  tools: "tools",
  drawingLevels: "drawing-levels",
  layers: "layers",
  attributes: "attributes",
  objectInfo: "object-info",
  site: "site",
  roomBalance: "room-balance",
  elements: "elements",
  viewSnapshots: "view-snapshots",
  layouts: "layouts",
} as const;

// Werkzeug-Palette (Symbol + Name je Werkzeug, ArchiCAD/Vectorworks-Stil).
registerPanel({
  id: BUILTIN_PANEL_IDS.tools,
  title: "nav.tools",
  icon: <ToolsTabIcon />,
  hasDisplayMode: false,
  render: () => <ToolsPanel />,
});

// Attribute-Palette (Stift/Füllung/Strichstärke der Auswahl, Vectorworks-Stil).
registerPanel({
  id: BUILTIN_PANEL_IDS.attributes,
  title: "nav.attributes",
  icon: <AttributesTabIcon />,
  hasDisplayMode: false,
  render: () => <AttributesPanel />,
});

// Objekt-Info-Palette (Bezugspunkt-Würfel + X/Y, Maße B×H der Auswahl).
registerPanel({
  id: BUILTIN_PANEL_IDS.objectInfo,
  title: "nav.objectInfo",
  icon: <ObjectInfoTabIcon />,
  hasDisplayMode: false,
  render: () => <ObjectInfoPanel />,
});

registerPanel({
  id: BUILTIN_PANEL_IDS.drawingLevels,
  // i18n-Key statt fertigem Text: TabStrip/PanelFrame lösen ihn über t() auf,
  // damit der Titel der gewählten Sprache folgt.
  title: "nav.drawingLevels",
  icon: <DrawingLevelsTabIcon />,
  hasDisplayMode: true,
  render: () => <DrawingLevelsPanel />,
});

registerPanel({
  id: BUILTIN_PANEL_IDS.layers,
  title: "nav.layers",
  icon: <LayersTabIcon />,
  hasDisplayMode: true,
  render: () => <LayersPanel />,
});

// Gelände-/Kontext-Palette (DXF-Import, Konturen-Liste, Gelände-Erzeugung).
registerPanel({
  id: BUILTIN_PANEL_IDS.site,
  title: "nav.site",
  icon: <SiteTabIcon />,
  hasDisplayMode: false,
  render: () => <SitePanel />,
});

// Flächenbilanz (SIA 416) — Raumliste + Kategorie-Summen + CSV-Export.
registerPanel({
  id: BUILTIN_PANEL_IDS.roomBalance,
  title: "nav.roomBalance",
  icon: <RoomBalanceTabIcon />,
  hasDisplayMode: false,
  render: () => <RoomBalancePanel />,
});

// Element-Baum (ROADMAP §11) — Geschoss → Bauteilklasse → Element, Suche + Klick-Selektion.
registerPanel({
  id: BUILTIN_PANEL_IDS.elements,
  title: "elements.title",
  icon: <ElementsTabIcon />,
  hasDisplayMode: false,
  render: () => <ElementTreePanel />,
});

// Ausschnitte / View-Snapshots (DOSSIER A2, ROADMAP §2c/§11) — benannte,
// wiederherstellbare Ansichten (Darstellungszustand als Preset).
registerPanel({
  id: BUILTIN_PANEL_IDS.viewSnapshots,
  title: "viewsnap.title",
  icon: <ViewSnapshotsTabIcon />,
  hasDisplayMode: false,
  render: () => <ViewSnapshotsPanel />,
});

// Layouts / Masterlayouts (DOSSIER A3, ROADMAP §11) — Druck-/Plan-Blätter mit
// platzierten Viewports (an Ausschnitte gebunden), Editor als schwebendes Fenster.
registerPanel({
  id: BUILTIN_PANEL_IDS.layouts,
  title: "layouts.panelTitle",
  icon: <LayoutsTabIcon />,
  hasDisplayMode: false,
  render: () => <LayoutsPanel />,
});
