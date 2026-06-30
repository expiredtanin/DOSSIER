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
    default:
      return null;
  }
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function ToolsPanel() {
  const host = usePanelHost();
  const snap = host.snap;

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
          <select
            value={host.activeWallTypeId}
            disabled={!host.toolsEnabled}
            onChange={(e) => host.onActiveWallTypeId(e.target.value)}
          >
            {host.project.wallTypes.map((wt) => (
              <option key={wt.id} value={wt.id}>
                {wt.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {host.activeTool === "wall" && <div className="tools-sep" />}

      {/* Fang-Abschnitt. Master-Checkbox steuert die übrigen Fang-Optionen. */}
      <label className="tools-snap-row">
        <input
          type="checkbox"
          checked={snap.enabled}
          onChange={(e) => host.onSnapChange({ ...snap, enabled: e.target.checked })}
        />
        <span>{t("snap.enabled")}</span>
      </label>

      <label className="tools-snap-row">
        <input
          type="checkbox"
          checked={snap.endpoint}
          disabled={!snap.enabled}
          onChange={(e) => host.onSnapChange({ ...snap, endpoint: e.target.checked })}
        />
        <span>{t("snap.endpoint")}</span>
      </label>

      <label className="tools-snap-row">
        <input
          type="checkbox"
          checked={snap.midpoint}
          disabled={!snap.enabled}
          onChange={(e) => host.onSnapChange({ ...snap, midpoint: e.target.checked })}
        />
        <span>{t("snap.midpoint")}</span>
      </label>

      <label className="tools-snap-row">
        <input
          type="checkbox"
          checked={snap.intersection}
          disabled={!snap.enabled}
          onChange={(e) =>
            host.onSnapChange({ ...snap, intersection: e.target.checked })
          }
        />
        <span>{t("snap.intersection")}</span>
      </label>

      <label className="tools-snap-row">
        <input
          type="checkbox"
          checked={snap.onEdge}
          disabled={!snap.enabled}
          onChange={(e) => host.onSnapChange({ ...snap, onEdge: e.target.checked })}
        />
        <span>{t("snap.onEdge")}</span>
      </label>

      <label className="tools-snap-row">
        <input
          type="checkbox"
          checked={snap.grid}
          disabled={!snap.enabled}
          onChange={(e) => host.onSnapChange({ ...snap, grid: e.target.checked })}
        />
        <span>{t("snap.grid")}</span>
      </label>

      <label className="tools-snap-row">
        <input
          type="checkbox"
          checked={snap.ortho}
          disabled={!snap.enabled}
          onChange={(e) => host.onSnapChange({ ...snap, ortho: e.target.checked })}
        />
        <span>{t("snap.ortho")}</span>
      </label>

      <label className="tools-field">
        <span>{t("snap.gridSize")}</span>
        <input
          type="number"
          step={0.05}
          min={0.01}
          value={snap.gridSize}
          onChange={(e) =>
            host.onSnapChange({ ...snap, gridSize: Number(e.target.value) })
          }
        />
      </label>
    </div>
  );
}
