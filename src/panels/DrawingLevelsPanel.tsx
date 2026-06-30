// Inhalts-Panel „Zeichnungsebenen" — die obere Navigator-Liste als Panel.
//
// Zeigt die Zeichnungsebenen (Geschosse + Schnitte/Ansichten/Zeichnungen)
// exakt wie der bisherige Navigator: EyeIcon schaltet die Sichtbarkeit, ein
// Kind-Badge zeigt die Art, die aktive Ebene ist hervorgehoben, Höhen-Readout
// (+OKFF) bei Geschossen. Kopfzeile mit + Geschoss / + Zeichnung.
//
// Neu gegenüber dem Inline-Navigator: das Panel deklariert hasDisplayMode und
// liest den gewählten DisplayMode aus dem Host-Context. `itemDisplay`
// entscheidet je Zeile, ob sie gezeichnet und ob sie ausgegraut wird (aktives
// Element = Arbeitsfokus, immer sichtbar). Daten/Handler kommen über
// usePanelHost — kein Prop-Drilling.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

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

/** Inhalt des Panels „Zeichnungsebenen". */
export function DrawingLevelsPanel() {
  const host = usePanelHost();
  const { project, activeLevelId, displayMode } = host;

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
        <span className="nav-group-actions">
          <button className="nav-add" onClick={host.onAddFloor}>
            {t("levels.addFloor")}
          </button>
          <button className="nav-add" onClick={host.onAddDrawing}>
            {t("levels.addDrawing")}
          </button>
        </span>
      </header>

      <div className="nav-list">
        {levelsTopDown.map((level) => (
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
