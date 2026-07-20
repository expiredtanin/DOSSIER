// Inhalts-Panel „Ebenen" — der Kategorie-Baum als Panel.
//
// Zeigt den Grafik-Kategorie-Baum (LayerCategory) exakt wie der bisherige
// Navigator: Farb-Swatch, Code, Name, EyeIcon zum Schalten, eingerückte
// Kinder, Kopfzeile mit + Ebene. Daten/Handler über usePanelHost.
//
// Das Panel deklariert hasDisplayMode. „Aktiv" ist die per Klick gewählte
// Kategorie (activeCategoryCode, Zeichen-Ziel für neue Elemente); dieselbe
// activeCategoryCode speist auch App.tsx' categoryDisplay-Resolver, der die
// tatsächliche Grundriss-/3D-Darstellung steuert. `itemDisplay` ergibt damit
// (fünf DOSSIER-Modi plus eigene Ergänzung "locked"):
//   • "all_force"   — alle erzwungen sichtbar; Augen gedimmt.
//   • "all"         — alle sichtbaren normal (Standard, wie bisher).
//   • "active"      — nur die gewählte Kategorie sichtbar, Rest ausgeblendet.
//   • "grey"        — gewählte normal, übrige sichtbare ausgegraut.
//   • "grey_locked" — wie „grey", übrige zusätzlich gesperrt.
//   • "locked"      — gewählte normal, übrige sichtbare UNVERÄNDERT farbig,
//                     nur gesperrt (nicht anwählbar/bearbeitbar).
// Wie im Zeichnungsebenen-Panel bleibt jede Zeile bedienbar (die Liste ist die
// Steuerung); statt auszublenden dimmen wir gedimmte Zeilen per Inline-Opacity
// (styles.css bleibt unangetastet).
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { EyeIcon } from "../ui/EyeIcon";
import { itemDisplay } from "./displayMode";
import { usePanelHost } from "./host";
import type { LayerCategory } from "./host";
import type { DisplayMode } from "./types";
import { DisplayModeSelect } from "./DisplayModeSelect";
import { t } from "../i18n";

/** Inhalt des Panels „Ebenen". */
export function LayersPanel() {
  const host = usePanelHost();
  const { project, displayMode } = host;

  // Klick aufs Auge in „Alle anzeigen"/„Nur aktive" schaltet automatisch auf
  // „Ausgewählte" (DOSSIER-Regel), damit das Sichtbarkeits-Flag sofort greift.
  const toggle = (code: string) => {
    const m = displayMode.mode;
    if (m === "all_force" || m === "active") displayMode.setMode("all");
    host.onToggleCategory(code);
  };

  // Rechtsklick auf eine Zeile → Kontextmenü in App öffnen (Browser-Menü aus).
  const onRowContext = (code: string, e: React.MouseEvent) => {
    e.preventDefault();
    host.onLayerContextMenu(code, e.clientX, e.clientY);
  };

  return (
    <section className="nav-group">
      {/* Kein eigener Titel/Kopf mehr — der PanelFrame liefert die EINE
          Kopfzeile; die „+ Kategorie"-Aktion sitzt dort via headerActions
          (LayersHeaderActions), kein doppelter „Ebenen"-Titel. */}
      <div className="panel-vis">
        <span className="panel-vis-label">{t("nav.visibility")}</span>
        <DisplayModeSelect value={displayMode.mode} onChange={displayMode.setMode} />
      </div>
      <div className="nav-list">
        {project.layers.map((cat) => (
          <CategoryRow
            key={cat.code}
            category={cat}
            depth={0}
            mode={displayMode.mode}
            activeCode={host.activeCategoryCode}
            onSelect={host.onSelectCategory}
            onToggle={toggle}
            onContext={onRowContext}
            onSettings={host.onOpenLayerSettings}
          />
        ))}
      </div>
    </section>
  );
}

/** Eine Kategorie-Zeile im Ebenen-Baum (rekursiv für Kinder). */
function CategoryRow({
  category,
  depth,
  mode,
  activeCode,
  onSelect,
  onToggle,
  onContext,
  onSettings,
}: {
  category: LayerCategory;
  depth: number;
  mode: DisplayMode;
  activeCode: string;
  onSelect: (code: string) => void;
  onToggle: (code: string) => void;
  onContext: (code: string, e: React.MouseEvent) => void;
  onSettings: (code: string, clientX: number, clientY: number) => void;
}) {
  // „aktiv" = diese Kategorie ist das Zeichen-Ziel (per Klick gesetzt).
  const isActive = category.code === activeCode;
  const display = itemDisplay(mode, isActive, category.visible);
  const dimmed = display.greyed || !display.render;

  // In „Alle anzeigen" sind die Augen gedimmt (Sichtbarkeit erzwungen).
  const eyeDimmed = mode === "all_force";

  const cls = [
    "cat-row",
    isActive ? "active" : "",
    display.locked ? "locked" : "",
    !category.visible ? "hidden" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Einrückung wie bisher; zusätzliches Dimmen aus dem DisplayMode inline.
  // In „Alle anzeigen" erzwungen sichtbar → auch unsichtbare Zeilen normal.
  const style: React.CSSProperties = { paddingLeft: 6 + depth * 14 };
  if (dimmed) style.opacity = 0.45;

  return (
    <>
      <div
        className={cls}
        style={style}
        onClick={() => onSelect(category.code)}
        onContextMenu={(e) => onContext(category.code, e)}
        title={t("nav.categorySelect", { name: category.name })}
      >
        <button
          className={`eye${category.visible ? " is-on" : ""}`}
          aria-label={t("nav.categoryVisible", { name: category.name })}
          title={category.visible ? t("nav.hide") : t("nav.show")}
          style={eyeDimmed ? { opacity: 0.5 } : undefined}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(category.code);
          }}
        >
          <EyeIcon open={category.visible} />
        </button>
        <span className="cat-code">{category.code}</span>
        <span className="cat-swatch" style={{ background: category.color }} />
        <span className="cat-name">{category.name}</span>
        <button
          className="cat-settings"
          aria-label={t("nav.categorySettings", { name: category.name })}
          title={t("nav.categorySettings", { name: category.name })}
          onClick={(e) => {
            e.stopPropagation();
            onSettings(category.code, e.clientX, e.clientY);
          }}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            settings
          </span>
        </button>
      </div>
      {category.children?.map((child) => (
        <CategoryRow
          key={child.code}
          category={child}
          depth={depth + 1}
          mode={mode}
          activeCode={activeCode}
          onSelect={onSelect}
          onToggle={onToggle}
          onContext={onContext}
          onSettings={onSettings}
        />
      ))}
    </>
  );
}

/** Aktionen für die gemeinsame PanelFrame-Kopfzeile (statt eigener Titelzeile):
 *  „+ Kategorie" + Zahnrad → Einstellungen (wie im Zeichnungsebenen-Kopf).
 *  Läuft im PanelHostContext, nutzt daher usePanelHost. */
export function LayersHeaderActions() {
  const host = usePanelHost();
  return (
    <>
      <button
        className="nav-settings"
        onClick={host.onOpenSettings}
        aria-label={t("topbar.settings")}
        title={t("topbar.settings")}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          settings
        </span>
      </button>
      <button
        className="nav-add"
        onClick={host.onAddCategory}
        aria-label={t("layers.addCategory")}
        title={t("layers.addCategory")}
      >
        +
      </button>
    </>
  );
}
