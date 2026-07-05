// Inhalts-Panel „Werkzeuge" — die vertikale Werkzeug-Palette (ArchiCAD-/
// Vectorworks-Stil): eine Zeile je Zeichenwerkzeug, jeweils Icon + Name, das
// aktive Werkzeug hervorgehoben. Darunter — wenn das Wand-Werkzeug aktiv ist —
// ein Wandtyp-Auswahlfeld, und ein kompakter Fang-Abschnitt mit Checkboxen.
//
// Daten/Handler kommen über usePanelHost (kein Prop-Drilling). Die Werkzeug-
// Liste und ihre Metadaten stammen aus der Tools-Registry (TOOL_ORDER/getTool).
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md). Alle sichtbaren
// Texte über t(...).

import { t } from "../i18n";
import { usePanelHost } from "./host";
import type { ToolId } from "./host";
import { TOOL_ORDER, getTool } from "../tools/tools";
import { Dropdown } from "../ui/Dropdown";

// ── Icons ──────────────────────────────────────────────────────────────────
// Keine echten Asset-Icons vorhanden: schlichte Inline-SVG-Glyphen je Werkzeug
// (~16×16, stroke=currentColor, fill=none), damit das Icon die Textfarbe der
// Zeile übernimmt.
function ToolIcon({ id }: { id: ToolId }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (id) {
    case "select":
      // Pfeil-Cursor.
      return (
        <svg {...common} fill="currentColor" stroke="none">
          <path d="M3 2l9 5-3.6 1.1L10.4 13 8.5 13.7 6.6 9.4 3 11z" />
        </svg>
      );
    case "wall":
      // Zwei parallele Linien (Wandband).
      return (
        <svg {...common}>
          <line x1="2" y1="5.5" x2="14" y2="5.5" />
          <line x1="2" y1="10.5" x2="14" y2="10.5" />
        </svg>
      );
    case "ceiling":
      // Deckenplatte: gefülltes Rechteck mit Diagonal-Schraffur (Slab-Symbol).
      return (
        <svg {...common}>
          <rect x="2.5" y="4" width="11" height="8" />
          <line x1="4" y1="12" x2="8" y2="4" />
          <line x1="8" y1="12" x2="12" y2="4" />
        </svg>
      );
    case "window":
      // Fenster: Rahmen-Rechteck mit Mittelsprosse (Verglasung).
      return (
        <svg {...common}>
          <rect x="2.5" y="4" width="11" height="8" />
          <line x1="8" y1="4" x2="8" y2="12" />
        </svg>
      );
    case "door":
      // Tür: Pfosten + Türblatt mit Schwenkbogen.
      return (
        <svg {...common}>
          <line x1="3" y1="13" x2="3" y2="4" />
          <line x1="3" y1="4" x2="11" y2="4" />
          <path d="M3 13 A9 9 0 0 0 11 4" />
        </svg>
      );
    case "stair":
      // Treppensymbol: gestufte Linie (Tritte) + Lauflinie mit Pfeil.
      return (
        <svg {...common}>
          <polyline points="2,14 2,11 6,11 6,8 10,8 10,5 14,5 14,2" />
          <line x1="4" y1="12.5" x2="12" y2="3.5" />
          <polyline points="10.5,3 12,3.5 11.5,5" />
        </svg>
      );
    case "room":
      // Raum: umschlossene Fläche (Rechteck) mit Flächen-Marke (kleines Kreuz).
      return (
        <svg {...common}>
          <rect x="2.5" y="3.5" width="11" height="9" />
          <line x1="6" y1="8" x2="10" y2="8" />
          <line x1="8" y1="6" x2="8" y2="10" />
        </svg>
      );
    case "line":
      // Einzelne Diagonale.
      return (
        <svg {...common}>
          <line x1="3" y1="13" x2="13" y2="3" />
        </svg>
      );
    case "polyline":
      // Dreisegmentiger Zickzack.
      return (
        <svg {...common}>
          <polyline points="2,12 6,5 10,11 14,4" />
        </svg>
      );
    case "rect":
      // Rechteck-Umriss.
      return (
        <svg {...common}>
          <rect x="2.5" y="3.5" width="11" height="9" />
        </svg>
      );
    case "circle":
      // Kreis-Umriss.
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
        </svg>
      );
    default:
      return null;
  }
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function ToolsPanel() {
  const host = usePanelHost();

  return (
    <div className="tools-panel">
      {/* Werkzeug-Zeilen: Icon + Name, aktives hervorgehoben. */}
      {TOOL_ORDER.map((id) => {
        const tool = getTool(id);
        const active = host.activeTool === id;
        const disabled = id !== "select" && !host.toolsEnabled;
        const title = disabled
          ? t("tool.floorOnlyDisabled")
          : t(tool.hintKey(tool.init()));
        const cls =
          "tool-row" + (active ? " active" : "") + (disabled ? " disabled" : "");
        return (
          <button
            key={id}
            type="button"
            className={cls}
            title={title}
            disabled={disabled}
            onClick={() => host.onSelectTool(id)}
          >
            <ToolIcon id={id} />
            <span>{t(tool.labelKey)}</span>
          </button>
        );
      })}

      <div className="tools-sep" />

      {/* Wandtyp-Auswahl — nur sichtbar, wenn das Wand-Werkzeug aktiv ist. */}
      {host.activeTool === "wall" && (
        <label className="tools-field">
          <span>{t("tool.wallType")}</span>
          <Dropdown
            value={host.activeWallTypeId}
            disabled={!host.toolsEnabled}
            onChange={(v) => host.onActiveWallTypeId(v)}
            options={host.project.wallTypes.map((wt) => ({
              value: wt.id,
              label: wt.name,
            }))}
          />
        </label>
      )}

      {host.activeTool === "wall" && <div className="tools-sep" />}

      {/* Deckentyp-Auswahl — nur sichtbar, wenn das Decken-Werkzeug aktiv ist.
          Nutzt denselben Aufbau-Typ (WallType) wie die Wand. */}
      {host.activeTool === "ceiling" && (
        <label className="tools-field">
          <span>{t("tool.ceilingType")}</span>
          <Dropdown
            value={host.activeWallTypeId}
            disabled={!host.toolsEnabled}
            onChange={(v) => host.onActiveWallTypeId(v)}
            options={host.project.wallTypes.map((wt) => ({
              value: wt.id,
              label: wt.name,
            }))}
          />
        </label>
      )}

      {host.activeTool === "ceiling" && <div className="tools-sep" />}
    </div>
  );
}
