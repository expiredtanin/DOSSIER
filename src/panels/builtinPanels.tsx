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

/** IDs der eingebauten Dock-Panels (auch für defaultLayout/Filter nutzbar). */
export const BUILTIN_PANEL_IDS = {
  tools: "tools",
  drawingLevels: "drawing-levels",
  layers: "layers",
  attributes: "attributes",
  objectInfo: "object-info",
  site: "site",
  roomBalance: "room-balance",
} as const;

// Werkzeug-Palette (Symbol + Name je Werkzeug, ArchiCAD/Vectorworks-Stil).
registerPanel({
  id: BUILTIN_PANEL_IDS.tools,
  title: "nav.tools",
  hasDisplayMode: false,
  render: () => <ToolsPanel />,
});

// Attribute-Palette (Stift/Füllung/Strichstärke der Auswahl, Vectorworks-Stil).
registerPanel({
  id: BUILTIN_PANEL_IDS.attributes,
  title: "nav.attributes",
  hasDisplayMode: false,
  render: () => <AttributesPanel />,
});

// Objekt-Info-Palette (Bezugspunkt-Würfel + X/Y, Maße B×H der Auswahl).
registerPanel({
  id: BUILTIN_PANEL_IDS.objectInfo,
  title: "nav.objectInfo",
  hasDisplayMode: false,
  render: () => <ObjectInfoPanel />,
});

registerPanel({
  id: BUILTIN_PANEL_IDS.drawingLevels,
  // i18n-Key statt fertigem Text: TabStrip/PanelFrame lösen ihn über t() auf,
  // damit der Titel der gewählten Sprache folgt.
  title: "nav.drawingLevels",
  hasDisplayMode: true,
  render: () => <DrawingLevelsPanel />,
});

registerPanel({
  id: BUILTIN_PANEL_IDS.layers,
  title: "nav.layers",
  hasDisplayMode: true,
  render: () => <LayersPanel />,
});

// Gelände-/Kontext-Palette (DXF-Import, Konturen-Liste, Gelände-Erzeugung).
registerPanel({
  id: BUILTIN_PANEL_IDS.site,
  title: "nav.site",
  hasDisplayMode: false,
  render: () => <SitePanel />,
});

// Flächenbilanz (SIA 416) — Raumliste + Kategorie-Summen + CSV-Export.
registerPanel({
  id: BUILTIN_PANEL_IDS.roomBalance,
  title: "nav.roomBalance",
  hasDisplayMode: false,
  render: () => <RoomBalancePanel />,
});
