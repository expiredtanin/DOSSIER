// Inhalts-Panel „Werkzeuge" — die Werkzeug-Palette (ArchiCAD-/Vectorworks-Stil).
// Oben ein Umschalter „Liste ↔ Symbole" (Icon+Name als Zeilen ODER kompaktes
// Icon-Raster). Darunter drei einheitlich gestylte Rubriken: 2D (Zeichnen),
// 3D (BIM-Bauteile) und Bearbeiten (Ändern-Aktionen) — Werkzeuge UND Befehle
// teilen denselben Knopf-Look (`.tp-item`), damit „Ändern" nicht mehr optisch
// aus der Reihe fällt.
//
// Daten/Handler kommen über usePanelHost (kein Prop-Drilling). Werkzeug-Metadaten
// aus der Tools-Registry (getTool), Befehls-Labels aus der Command-Registry.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md). Alle sichtbaren
// Texte über t(...).

import { useState } from "react";
import { t } from "../i18n";
import { usePanelHost } from "./host";
import type { ToolId } from "./host";
import { getTool } from "../tools/tools";
import { getCommand } from "../commands/registry";
import { CommandIcon } from "../ui/ribbon/CommandIcon";

// ── Icons ──────────────────────────────────────────────────────────────────
// Keine echten Asset-Icons vorhanden: schlichte Inline-SVG-Glyphen je Werkzeug
// (~16×16, stroke=currentColor, fill=none), damit das Icon die Textfarbe der
// Zeile übernimmt.
export function ToolIcon({ id }: { id: ToolId }) {
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
      // Pfeil-Cursor (klassischer Zeiger mit Schweif).
      return (
        <svg {...common} fill="currentColor" stroke="currentColor" strokeWidth={0.8}>
          <path d="M4 2.5 L4 13.2 L6.9 10.4 L8.9 14.6 L10.7 13.8 L8.7 9.7 L12.6 9.6 Z" />
        </svg>
      );
    case "wall":
      // Wandband: zwei parallele Kanten mit geschlossenen Enden (Wandstück).
      return (
        <svg {...common}>
          <rect x="2" y="5.5" width="12" height="5" />
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
      // Fenster (SIA-Aufsicht): Wandöffnung mit doppelter Glaslinie.
      return (
        <svg {...common}>
          <line x1="2" y1="5.5" x2="14" y2="5.5" />
          <line x1="2" y1="10.5" x2="14" y2="10.5" />
          <line x1="2" y1="8" x2="14" y2="8" />
          <line x1="2" y1="5.5" x2="2" y2="10.5" />
          <line x1="14" y1="5.5" x2="14" y2="10.5" />
        </svg>
      );
    case "door":
      // Tür (SIA-Aufsicht): Türblatt aufrecht + Viertelkreis-Schwenkbogen.
      return (
        <svg {...common}>
          <line x1="3.5" y1="13" x2="3.5" y2="3" />
          <path d="M3.5 3 A9.5 9.5 0 0 1 13 12.5" strokeDasharray="1.4 1.4" />
          <line x1="3.5" y1="13" x2="13" y2="13" />
        </svg>
      );
    case "stair":
      // Treppe (SIA-Aufsicht): Wangen, gleichmäßige Tritte, Lauflinie mit
      // Aufwärts-Pfeil (Idee: Vollbogen ersetzt durch eine echte Treppe).
      return (
        <svg {...common}>
          <rect x="3" y="2" width="10" height="12" />
          <line x1="3" y1="4.4" x2="13" y2="4.4" />
          <line x1="3" y1="6.8" x2="13" y2="6.8" />
          <line x1="3" y1="9.2" x2="13" y2="9.2" />
          <line x1="3" y1="11.6" x2="13" y2="11.6" />
          <line x1="8" y1="13.2" x2="8" y2="3.4" />
          <polyline points="6.3,5.1 8,3.2 9.7,5.1" />
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
    case "arc":
      // Offener Bogen (gut 180°) mit Endpunkt-Markierungen.
      return (
        <svg {...common}>
          <path d="M 2.5 11 A 5.6 5.6 0 0 1 13.5 11" fill="none" />
          <circle cx="2.5" cy="11" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="13.5" cy="11" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );
    case "ellipse":
      // Ellipse-Umriss (geneigt, unterscheidbar vom Kreis).
      return (
        <svg {...common}>
          <ellipse cx="8" cy="8" rx="6" ry="4" />
        </svg>
      );
    case "spline":
      // Glatte S-Kurve durch drei Wegpunkte.
      return (
        <svg {...common}>
          <path d="M 2.5 12.5 C 2.5 6 6 10 8 8 C 10 6 10.5 3.5 13.5 3.5" fill="none" />
          <circle cx="2.5" cy="12.5" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="13.5" cy="3.5" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );
    case "bezier":
      // Kubische Bezier-Kurve mit sichtbaren Kontrollpunkt-Griffen.
      return (
        <svg {...common}>
          <path d="M 2.5 12.5 C 5 4 8 13 13.5 3.5" fill="none" />
          <line x1="2.5" y1="12.5" x2="5" y2="4" strokeDasharray="1.5 1.2" />
          <line x1="13.5" y1="3.5" x2="8" y2="13" strokeDasharray="1.5 1.2" />
          <circle cx="2.5" cy="12.5" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="13.5" cy="3.5" r="0.9" fill="currentColor" stroke="none" />
          <rect x="4.2" y="2.7" width="1.6" height="1.6" fill="currentColor" stroke="none" />
          <rect x="7.2" y="12.2" width="1.6" height="1.6" fill="currentColor" stroke="none" />
        </svg>
      );
    case "dimension":
      // Masslinie mit Massstrichen (Diagonalstriche) an beiden Enden.
      return (
        <svg {...common}>
          <line x1="2.5" y1="4" x2="2.5" y2="11" strokeWidth="0.9" />
          <line x1="13.5" y1="4" x2="13.5" y2="11" strokeWidth="0.9" />
          <line x1="2.5" y1="8" x2="13.5" y2="8" />
          <line x1="1.7" y1="6.6" x2="3.3" y2="9.4" strokeWidth="1.6" />
          <line x1="12.7" y1="6.6" x2="14.3" y2="9.4" strokeWidth="1.6" />
        </svg>
      );
    case "kote":
      // Höhenkote: Dreieck (Spitze unten, OK) + Zahl.
      return (
        <svg {...common}>
          <polygon points="8,10 5,5 11,5" fill="none" />
          <line x1="10.5" y1="6.5" x2="14" y2="6.5" />
          <line x1="10.5" y1="9" x2="14" y2="9" />
        </svg>
      );
    case "text":
      // Serifen-„A" als Text-Symbol.
      return (
        <svg {...common}>
          <path d="M 4 13 L 8 3 L 12 13" fill="none" />
          <path d="M 5.5 9.5 L 10.5 9.5" fill="none" />
        </svg>
      );
    case "textbox":
      // Spalten-Rahmen mit drei Textzeilen (Absatztext).
      return (
        <svg {...common}>
          <rect x="2.5" y="3" width="11" height="10" fill="none" />
          <line x1="4.5" y1="6" x2="11.5" y2="6" />
          <line x1="4.5" y1="8.5" x2="11.5" y2="8.5" />
          <line x1="4.5" y1="11" x2="9" y2="11" />
        </svg>
      );
    case "image":
      // Bild-Rahmen mit Bergsilhouette + Sonne (klassisches Bild-Icon).
      return (
        <svg {...common}>
          <rect x="2.5" y="3" width="11" height="10" fill="none" />
          <circle cx="6" cy="6.5" r="1" fill="currentColor" stroke="none" />
          <path d="M 3 12 L 7 8 L 9.5 10.5 L 11 9 L 13 12" fill="none" />
        </svg>
      );
    default:
      return null;
  }
}

// ── Kategorien ───────────────────────────────────────────────────────────────
// Werkzeuge/Befehle in drei Rubriken sortiert (Nutzerwunsch: „sortiere nach 2D
// und 3D und Bearbeiten"): reine Panel-Gruppierung (2D-Zeichnen · 3D/BIM-
// Bauteile · Bearbeiten-Aktionen).
const TOOLS_2D: ToolId[] = [
  "line",
  "polyline",
  "rect",
  "circle",
  "arc",
  "ellipse",
  "spline",
  "bezier",
  "dimension",
  "kote",
  "text",
  "textbox",
  "image",
];
const TOOLS_3D: ToolId[] = ["wall", "ceiling", "window", "door", "stair", "room"];
const COMMANDS_3D = ["column", "ceilingopening", "roof", "extrude", "sectionline", "viewline"];
const COMMANDS_EDIT = ["move", "copy", "rotate", "mirror", "offset", "multiline", "trim", "extend", "fillet", "chamfer", "join", "measure"];

type ToolsView = "list" | "icons";
const VIEW_STORAGE_KEY = "dossier.toolsPanel.view";

function loadView(): ToolsView {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "icons" ? "icons" : "list";
  } catch {
    return "list";
  }
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function ToolsPanel() {
  const host = usePanelHost();
  const [view, setView] = useState<ToolsView>(loadView);

  const chooseView = (v: ToolsView) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, v);
    } catch {
      /* Persistenz ist Best-Effort (privater Modus o. ä.). */
    }
  };

  // Ein Werkzeug-Knopf (Icon + Name). Boden-gebundene (`floorOnly`) Werkzeuge
  // sind ohne aktives Geschoss gesperrt; freie 2D-Werkzeuge bleiben nutzbar.
  const toolButton = (id: ToolId) => {
    const tool = getTool(id);
    const active = host.activeTool === id;
    const disabled = !!tool.floorOnly && !host.toolsEnabled;
    const label = t(tool.labelKey);
    const title = disabled ? t("tool.floorOnlyDisabled") : t(tool.hintKey(tool.init()));
    return (
      <button
        key={id}
        type="button"
        className={"tp-item" + (active ? " active" : "") + (disabled ? " disabled" : "")}
        title={view === "icons" ? label : title}
        disabled={disabled}
        onClick={() => host.onSelectTool(id)}
      >
        <ToolIcon id={id} />
        <span className="tp-label">{label}</span>
      </button>
    );
  };

  // Ein Befehls-Knopf (Ändern-/BIM-Kommando ohne eigenen Werkzeug-Modus) —
  // gleicher Look wie die Werkzeuge (Nutzerwunsch: nicht „ganz anders").
  const commandButton = (name: string) => {
    const cmd = getCommand(name);
    const label = cmd ? t(cmd.labelKey) : t(`cmd.${name}.label`);
    const active = host.activeCommand === name;
    return (
      <button
        key={name}
        type="button"
        className={"tp-item" + (active ? " active" : "")}
        title={label}
        onClick={() => host.onRunCommand(name)}
      >
        <CommandIcon name={name} />
        <span className="tp-label">{label}</span>
      </button>
    );
  };

  const bodyClass = "tp-body" + (view === "icons" ? " icons" : "");

  return (
    <div className="tools-panel">
      {/* Anzeige-Umschalter: nur Symbole ODER Symbol + Name (Liste). */}
      <div className="tp-head">
        <div className="tp-viewtoggle" role="group" aria-label={t("tools.view.label")}>
          <button
            type="button"
            className={"tp-viewbtn" + (view === "list" ? " active" : "")}
            aria-pressed={view === "list"}
            onClick={() => chooseView("list")}
          >
            {t("tools.view.list")}
          </button>
          <button
            type="button"
            className={"tp-viewbtn" + (view === "icons" ? " active" : "")}
            aria-pressed={view === "icons"}
            onClick={() => chooseView("icons")}
          >
            {t("tools.view.icons")}
          </button>
        </div>
      </div>

      {/* Auswahl-Werkzeug: immer als volle Zeile zuoberst (meistgenutzt). */}
      <div className="tp-select">{toolButton("select")}</div>

      <section className="tp-section">
        <div className="tp-section-title">{t("tools.cat.2d")}</div>
        <div className={bodyClass}>{TOOLS_2D.map(toolButton)}</div>
      </section>

      <section className="tp-section">
        <div className="tp-section-title">{t("tools.cat.3d")}</div>
        <div className={bodyClass}>
          {TOOLS_3D.map(toolButton)}
          {COMMANDS_3D.map(commandButton)}
        </div>
      </section>

      <section className="tp-section">
        <div className="tp-section-title">{t("tools.cat.edit")}</div>
        <div className={bodyClass}>{COMMANDS_EDIT.map(commandButton)}</div>
      </section>
    </div>
  );
}
