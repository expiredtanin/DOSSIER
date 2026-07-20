// Eigenständiger React-Root für das native Zeichnungsebenen-Fenster (siehe
// drawingLevelsWindow.ts für die Hauptfenster-Seite der Sync-Brücke). Von
// main.tsx gerendert, wenn die URL `?window=drawing-levels` trägt.
//
// Spiegelt die Kategorie-/Zeilen-Darstellung des Dock-Panels
// (panels/DrawingLevelsPanel.tsx) — nutzt dessen exportierte `LevelRow` +
// Kategorie-Konstanten direkt (keine Duplikation), aber NICHT `usePanelHost`
// (das ist an den riesigen, docked-Panel-spezifischen PanelHostContext
// gebunden); stattdessen der schmale Sync-/Command-Zustand von
// drawingLevelsWindow.ts, analog SettingsWindowApp.tsx.
//
// Bezeichner englisch, UI-Text über i18n (CONVENTIONS.md).

import { useEffect, useMemo, useState } from "react";
import {
  LevelRow,
  CATEGORY_ORDER,
  CATEGORY_TITLE_KEY,
  CATEGORY_ADD_KEY,
} from "../panels/DrawingLevelsPanel";
import type { DrawingLevelsCommandHandlers, DrawingLevelsSyncState } from "./drawingLevelsWindow";
import type { DrawingLevelKind } from "../model/types";
import { t } from "../i18n";

type HandlerName = keyof DrawingLevelsCommandHandlers;

export function DrawingLevelsWindowApp() {
  const [state, setState] = useState<DrawingLevelsSyncState | null>(null);
  const [collapsed, setCollapsed] = useState<Record<DrawingLevelKind, boolean>>({
    floor: false,
    section: false,
    elevation: false,
    drawing: false,
  });
  const toggleCategory = (kind: DrawingLevelKind) =>
    setCollapsed((c) => ({ ...c, [kind]: !c[kind] }));

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    void (async () => {
      const { listen, emitTo } = await import("@tauri-apps/api/event");
      if (disposed) return;
      unlisten.push(
        await listen<DrawingLevelsSyncState>("drawing-levels-sync-state", (e) =>
          setState(e.payload),
        ),
      );
      await emitTo("main", "drawing-levels-window-ready").catch(() => {});
    })();
    return () => {
      disposed = true;
      unlisten.forEach((u) => u());
    };
  }, []);

  const handlers = useMemo<DrawingLevelsCommandHandlers>(
    () =>
      new Proxy({} as DrawingLevelsCommandHandlers, {
        get(_target, prop: string) {
          return (...args: unknown[]) => {
            void import("@tauri-apps/api/event").then(({ emitTo }) =>
              emitTo("main", "drawing-levels-command", { name: prop as HandlerName, args }).catch(
                () => {},
              ),
            );
          };
        },
      }),
    [],
  );

  if (!state) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          color: "var(--ink-dim, #8a8a8a)",
          fontSize: 13,
        }}
      >
        {t("resources.loading")}
      </div>
    );
  }

  const onAddByKind: Record<DrawingLevelKind, () => void> = {
    floor: handlers.onAddFloor,
    section: handlers.onAddSection,
    elevation: handlers.onAddElevation,
    drawing: handlers.onAddDrawing,
  };

  // Oberstes Geschoss zuoberst (wie das Dock-Panel/DOSSIER): Anzeige umkehren.
  const levelsTopDown = [...state.drawingLevels].reverse();

  // Klick aufs Auge in „Alle anzeigen"/„Nur aktive" schaltet automatisch auf
  // „Ausgewählte" — dieselbe DOSSIER-Regel wie im Dock-Panel.
  const toggle = (id: string) => {
    if (state.displayMode === "all_force" || state.displayMode === "active") {
      handlers.onSetDisplayMode("all");
    }
    handlers.onToggleLevel(id);
  };

  return (
    <section
      className="nav-group"
      style={{ height: "100vh", overflowY: "auto" }}
    >
      {/* Selber Kopf wie die übrigen vier Fenster (.res-head/.imp-head):
          44px, border-bottom, 76px Ampel-Abstand — kein Dock-Panel-Look mehr. */}
      <header className="res-head" data-tauri-drag-region style={{ paddingLeft: 88 }}>
        <span className="res-head-title">{t("nav.drawingLevels")}</span>
      </header>

      {CATEGORY_ORDER.map((kind) => {
        const levelsOfKind = levelsTopDown.filter((l) => l.kind === kind);
        const isOpen = !collapsed[kind];
        return (
          <div className="level-cat" key={kind}>
            <header className="level-cat-head" onClick={() => toggleCategory(kind)}>
              <span className={`level-cat-chevron${isOpen ? " open" : ""}`} aria-hidden="true">
                ▸
              </span>
              <span className="level-cat-title">{t(CATEGORY_TITLE_KEY[kind])}</span>
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
                    active={level.id === state.activeLevelId}
                    mode={state.displayMode}
                    onSelect={() => handlers.onSelectLevel(level.id)}
                    onToggle={() => toggle(level.id)}
                    // Rechtsklick-Kontextmenü bewusst kein Bestandteil des
                    // Fensters (s. drawingLevelsWindow.ts Kopfkommentar).
                    onContext={(e) => e.preventDefault()}
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
