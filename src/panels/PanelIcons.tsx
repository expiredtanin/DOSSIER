// Tab-Symbole der eingebauten Dock-Panels.
//
// Gleiche Konvention wie ToolIcon (ToolsPanel.tsx) und EyeIcon (ui/EyeIcon.tsx):
// schlichte Inline-SVG-Glyphen, ~16×16, stroke=currentColor, damit das Icon die
// Textfarbe des Tabs (inaktiv/hover/aktiv) übernimmt. Keine echten Asset-Icons
// vorhanden — daher hier je Panel eine eigene kleine Glyphe.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

const common = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
};

/** Werkzeuge — Palette (2×2-Raster). */
export function ToolsTabIcon() {
  return (
    <svg {...common}>
      <rect x="2" y="2" width="5" height="5" />
      <rect x="9" y="2" width="5" height="5" />
      <rect x="2" y="9" width="5" height="5" />
      <rect x="9" y="9" width="5" height="5" />
    </svg>
  );
}

/** Attribute — Federkiel (Stift/Füllung/Strichstärke der Auswahl). */
export function AttributesTabIcon() {
  return (
    <svg {...common}>
      <path d="M12.5 2.5 L14 4 L6 12 L3 13 L4 10 Z" />
      <line x1="9.5" y1="5.5" x2="11.5" y2="7.5" />
    </svg>
  );
}

/** Objekt-Info — umkreistes „i". */
export function ObjectInfoTabIcon() {
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="6" />
      <line x1="8" y1="7" x2="8" y2="11.2" />
      <circle cx="8" cy="4.8" r="0.15" fill="currentColor" stroke="none" />
      <circle cx="8" cy="4.8" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Zeichnungsebenen — gestapelte Geschosse (drei Bodenplatten). */
export function DrawingLevelsTabIcon() {
  return (
    <svg {...common}>
      <line x1="2" y1="3" x2="14" y2="3" />
      <line x1="2" y1="8" x2="14" y2="8" />
      <line x1="2" y1="13" x2="14" y2="13" />
      <line x1="4" y1="3" x2="4" y2="8" />
      <line x1="12" y1="8" x2="12" y2="13" />
    </svg>
  );
}

/** Ebenen — überlappende Kategorie-Blätter. */
export function LayersTabIcon() {
  return (
    <svg {...common}>
      <path d="M8 2.5 13.5 5.5 8 8.5 2.5 5.5 Z" />
      <path d="M2.5 8.5 8 11.5 13.5 8.5" />
      <path d="M2.5 11 8 14 13.5 11" />
    </svg>
  );
}

/** Gelände — Höhenlinien/Terrain. */
export function SiteTabIcon() {
  return (
    <svg {...common}>
      <path d="M1.5 12.5 5 6 7.5 10 10 5.5 14.5 12.5 Z" />
    </svg>
  );
}

/** Flächenbilanz — Balken unterschiedlicher Höhe (SIA-416-Auswertung). */
export function RoomBalanceTabIcon() {
  return (
    <svg {...common}>
      <line x1="3" y1="13.5" x2="3" y2="7" />
      <line x1="8" y1="13.5" x2="8" y2="2.5" />
      <line x1="13" y1="13.5" x2="13" y2="9.5" />
    </svg>
  );
}
