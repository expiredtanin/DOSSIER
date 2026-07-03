// Inhalts-Panel „Zeichnungsebenen" — die obere Navigator-Liste als Panel.
//
// Zeigt die Zeichnungsebenen gruppiert in vier einklappbaren Kategorien
// (Geschosse / Schnitte / Ansichten / 2D-Zeichnungen, in dieser Reihenfolge).
// Jede Kategorie hat einen eigenen Kopf mit Titel, Ein-/Ausklapp-Chevron und
// einem blanken „+"-Glyph zum Anlegen einer neuen Zeichnungsebene dieser Art.
// Innerhalb einer Kategorie: EyeIcon schaltet die Sichtbarkeit, die aktive
// Ebene ist hervorgehoben, Höhen-Readout (+OKFF) bei Geschossen.
//
// Das Panel deklariert hasDisplayMode und liest den gewählten DisplayMode aus
// dem Host-Context. `itemDisplay` entscheidet je Zeile, ob sie gezeichnet und
// ob sie ausgegraut wird (aktives Element = Arbeitsfokus, immer sichtbar).
// Daten/Handler kommen über usePanelHost — kein Prop-Drilling.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useState } from "react";
import { EyeIcon } from "../ui/EyeIcon";
import { itemDisplay } from "./displayMode";
import { usePanelHost } from "./host";
import type { DrawingLevel } from "./host";
import type { DisplayMode } from "./types";
import type { DrawingLevelKind } from "../model/types";
import { t } from "../i18n";

/** i18n-Key des Kurzbadges für die Art einer Zeichnungsebene. */
const KIND_BADGE_KEY: Record<DrawingLevelKind, string> = {
  floor: "badge.floor",
  section: "badge.section",
  elevation: "badge.elevation",
  drawing: "badge.drawing",
};

/** Kategorien der Zeichnungsebenen, in Anzeigereihenfolge. */
const CATEGORY_ORDER: DrawingLevelKind[] = [
  "floor",
  "section",
  "elevation",
  "drawing",
];

/** i18n-Key des Kategorie-Titels. */
const CATEGORY_TITLE_KEY: Record<DrawingLevelKind, string> = {
  floor: "levelCat.floor",
  section: "levelCat.section",
  elevation: "levelCat.elevation",
  drawing: "levelCat.drawing",
};

/** i18n-Key der Beschriftung des „+"-Glyphs (Tooltip/aria-label). */
const CATEGORY_ADD_KEY: Record<DrawingLevelKind, string> = {
  floor: "levels.addFloor",
  section: "levels.addSection",
  elevation: "levels.addElevation",
  drawing: "levels.addDrawing",
};

/** Inhalt des Panels „Zeichnungsebenen". */
export function DrawingLevelsPanel() {
  const host = usePanelHost();
  const { project, activeLevelId, displayMode } = host;

  // Auf-/Zu-Zustand je Kategorie, lokal — Default: alle aufgeklappt.
  const [collapsed, setCollapsed] = useState<Record<DrawingLevelKind, boolean>>(
    { floor: false, section: false, elevation: false, drawing: false },
  );
  const toggleCategory = (kind: DrawingLevelKind) =>
    setCollapsed((c) => ({ ...c, [kind]: !c[kind] }));

  const onAddByKind: Record<DrawingLevelKind, () => void> = {
    floor: host.onAddFloor,
    section: host.onAddSection,
    elevation: host.onAddElevation,
    drawing: host.onAddDrawing,
  };

  // Oberstes Geschoss zuoberst (wie DOSSIER): Anzeige umkehren.
  const levelsTopDown = [...project.drawingLevels].reverse();

  // Klick aufs Auge in „Alle anzeigen"/„Nur aktive" schaltet automatisch auf
  // „Ausgewählte" (DOSSIER-Regel), damit das Sichtbarkeits-Flag sofort greift.
  const toggle = (id: string) => {
    const m = displayMode.mode;
    if (m === "all_force" || m === "active") displayMode.setMode("all");
    host.onToggleLevel(id);
  };

  // Rechtsklick auf eine Zeile → Kontextmenü in App öffnen (Browser-Menü aus).
  const onRowContext = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    host.onLevelContextMenu(id, e.clientX, e.clientY);
  };

  return (
    <section className="nav-group">
      <header className="nav-group-head">
        <span className="nav-group-title">{t("nav.drawingLevels")}</span>
      </header>

      {CATEGORY_ORDER.map((kind) => {
        const levelsOfKind = levelsTopDown.filter((l) => l.kind === kind);
        const isOpen = !collapsed[kind];
        return (
          <div className="level-cat" key={kind}>
            <header
              className="level-cat-head"
              onClick={() => toggleCategory(kind)}
            >
              <span
                className={`level-cat-chevron${isOpen ? " open" : ""}`}
                aria-hidden="true"
              >
                ▸
              </span>
              <span className="level-cat-title">
                {t(CATEGORY_TITLE_KEY[kind])}
              </span>
              <span
                className="level-cat-add"
                role="button"
                aria-label={t(CATEGORY_ADD_KEY[kind])}
                title={t(CATEGORY_ADD_KEY[kind])}
                onClick={(e) => {
                  e.stopPropagation();
                  onAddByKind[kind]();
                }}
              >
                +
              </span>
            </header>

            {isOpen && (
              <div className="nav-list">
                {levelsOfKind.map((level) => (
                  <LevelRow
                    key={level.id}
                    level={level}
                    active={level.id === activeLevelId}
                    mode={displayMode.mode}
                    onSelect={() => host.onSelectLevel(level.id)}
                    onToggle={() => toggle(level.id)}
                    onContext={(e) => onRowContext(level.id, e)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** Eine Zeile im Zeichnungsebenen-Bereich. */
function LevelRow({
  level,
  active,
  mode,
  onSelect,
  onToggle,
  onContext,
}: {
  level: DrawingLevel;
  active: boolean;
  mode: DisplayMode;
  onSelect: () => void;
  onToggle: () => void;
  onContext: (e: React.MouseEvent) => void;
}) {
  // Darstellungsmodus auf diese Zeile anwenden: greyed steuert das Dimmen,
  // render würde im Modus "active" Nicht-Aktive ausblenden. Im Navigator bleibt
  // jede Zeile bedienbar (Liste = Steuerung), daher blenden wir nicht ganz aus,
  // sondern dimmen nicht gezeichnete Zeilen wie ausgegraute.
  const display = itemDisplay(mode, active, level.visible);
  const dimmed = display.greyed || !display.render;

  // In „Alle anzeigen" sind die Augen gedimmt (Sichtbarkeit erzwungen, Flag
  // ohne Wirkung). „grey_locked" sperrt nicht-aktive Zeilen.
  const eyeDimmed = mode === "all_force";

  const cls = [
    "nav-row",
    active ? "active" : "",
    display.locked ? "locked" : "",
    // Bisheriges Verhalten: nicht-aktive, unsichtbare Zeilen gedimmt.
    !active && !level.visible ? "hidden" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Zusätzliches Dimmen aus dem DisplayMode (nicht in styles.css → inline).
  // Aktiv bleibt immer voll sichtbar.
  const style = !active && dimmed ? { opacity: 0.45 } : undefined;

  return (
    <div
      className={cls}
      style={style}
      onClick={onSelect}
      onContextMenu={onContext}
    >
      <button
        className={`eye${level.visible ? " is-on" : ""}`}
        aria-label={t("nav.visibility")}
        title={level.visible ? t("nav.hide") : t("nav.show")}
        style={eyeDimmed ? { opacity: 0.5 } : undefined}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        <EyeIcon open={level.visible} />
      </button>

      <span className="nav-label">{level.name}</span>

      {level.kind === "floor" && level.baseElevation !== undefined && (
        <span className="nav-elev">+{level.baseElevation.toFixed(2)}</span>
      )}

      <span className={`chip badge-${level.kind}`}>
        {t(KIND_BADGE_KEY[level.kind])}
      </span>
    </div>
  );
}
