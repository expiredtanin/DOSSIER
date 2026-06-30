// Inhalts-Panel „Ebenen" — der Kategorie-Baum als Panel.
//
// Zeigt den Grafik-Kategorie-Baum (LayerCategory) exakt wie der bisherige
// Navigator: Farb-Swatch, Code, Name, EyeIcon zum Schalten, eingerückte
// Kinder, Kopfzeile mit + Ebene. Daten/Handler über usePanelHost.
//
// Das Panel deklariert hasDisplayMode. Kategorien kennen keine „aktive"
// Auswahl (anders als Zeichnungsebenen), daher ist isActive je Zeile false;
// `itemDisplay` ergibt damit (fünf DOSSIER-Modi):
//   • "all_force"   — alle erzwungen sichtbar; Augen gedimmt.
//   • "all"         — alle sichtbaren normal (Standard, wie bisher).
//   • "active"      — keine Kategorie aktiv → alle gedimmt.
//   • "grey"        — sichtbare Kategorien ausgegraut.
//   • "grey_locked" — wie „grey", zusätzlich gesperrt.
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
      <header className="nav-group-head">
        <span className="nav-group-title">{t("nav.layers")}</span>
        <span className="nav-group-actions">
          <button className="nav-add" onClick={host.onAddCategory}>
            {t("layers.addCategory")}
          </button>
        </span>
      </header>

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
}: {
  category: LayerCategory;
  depth: number;
  mode: DisplayMode;
  activeCode: string;
  onSelect: (code: string) => void;
  onToggle: (code: string) => void;
  onContext: (code: string, e: React.MouseEvent) => void;
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
        />
      ))}
    </>
  );
}
