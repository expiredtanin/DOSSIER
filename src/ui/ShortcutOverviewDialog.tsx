// [210] Overlay-Dialog „Tastaturkürzel" (Menü Hilfe): alle Tastenkombinationen und Befehlskürzel, abgeleitet aus den
// Registries (`state/shortcutOverview.ts`), samt Nutzer-Übersteuerungen aus den Einstellungen. Kein window.alert.

import { memo, useEffect, useMemo, useState } from "react";
import { t, type TranslationKey } from "../i18n";
import { setShortcutOverviewOpener } from "../state/shortcutOverviewHook";
import { buildShortcutOverview } from "../state/shortcutOverview";
import { loadShortcutOverrides } from "../state/keyboardShortcuts";
import { loadAliasOverrides } from "../state/commandAliasOverrides";
import { useModalFocus } from "./modalFocus";

export const ShortcutOverviewDialogHost = memo(function ShortcutOverviewDialogHost() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setShortcutOverviewOpener(() => {
      setFilter("");
      setOpen(true);
    });
    return () => setShortcutOverviewOpener(null);
  }, []);

  // [249] Fokus ins Suchfeld, Tab-Falle, Esc, Fokus zurück zum Auslöser (Hilfe-Menü).
  const dialogRef = useModalFocus({ onEscape: () => setOpen(false) });

  const overview = useMemo(() => (open ? buildShortcutOverview(loadShortcutOverrides(), loadAliasOverrides()) : null), [open]);
  if (!open || !overview) return null;

  const q = filter.trim().toLowerCase();
  const tr = (k: string) => t(k as TranslationKey);
  const combos = overview.combos
    .map((g) => ({ ...g, rows: g.rows.filter((r) => !q || tr(r.labelKey).toLowerCase().includes(q) || r.combo.toLowerCase().includes(q)) }))
    .filter((g) => g.rows.length > 0);
  const commands = overview.commands.filter(
    (c) => !q || c.name.includes(q) || tr(c.labelKey).toLowerCase().includes(q) || c.aliases.some((a) => a.toLowerCase().includes(q)),
  );

  return (
    <div className="imp-overlay" onClick={() => setOpen(false)}>
      <div ref={dialogRef} className="imp-dialog" role="dialog" aria-modal="true" aria-label={t("help.shortcuts.title")} data-testid="shortcut-overview" onClick={(e) => e.stopPropagation()}>
        <header className="imp-head">
          <span className="imp-head-title">{t("help.shortcuts.title")}</span>
          <button className="imp-close" onClick={() => setOpen(false)} aria-label={t("export.close")}>
            ×
          </button>
        </header>
        <div className="imp-body" style={{ maxHeight: "70vh", overflowY: "auto" }}>
          <p className="imp-note">{t("help.shortcuts.intro")}</p>
          <input
            className="imp-input imp-input-flush"
            type="search"
            data-autofocus
            value={filter}
            placeholder={t("help.shortcuts.filter")}
            aria-label={t("help.shortcuts.filter")}
            onChange={(e) => setFilter(e.target.value)}
          />
          <section className="imp-section">
            <div className="imp-section-title">{t("help.shortcuts.keys")}</div>
            {combos.map((g) => (
              <div className="settings-shortcut-category" key={g.category}>
                <div className="settings-shortcut-category-title">{tr(`settings.keyboardShortcuts.category.${g.category}`)}</div>
                {g.rows.map((r) => (
                  <div className="settings-alias-row" key={r.labelKey}>
                    <span style={{ flex: 1 }}>{tr(r.labelKey)}</span>
                    <kbd>{r.combo}</kbd>
                  </div>
                ))}
              </div>
            ))}
          </section>
          <section className="imp-section">
            <div className="imp-section-title">{t("help.shortcuts.commands")}</div>
            <p className="imp-note">{t("help.shortcuts.commandsHint")}</p>
            {commands.map((c) => (
              <div className="settings-alias-row" key={c.name}>
                <span style={{ flex: 1 }}>{tr(c.labelKey)}</span>
                <kbd>{c.aliases.join(" · ")}</kbd>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
});
