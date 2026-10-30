// „Standards aktualisieren" ([109]): Bestätigungs-Overlay (kein window.confirm — im Tauri-WKWebView stumm).
// Listet die Standard-Einträge des Projekts, die von der heutigen Bibliothek abweichen, mit den betroffenen
// Feldern. Ob ein Eintrag selbst angepasst wurde, lässt sich nicht erkennen: umbenannte Einträge sind
// abgewählt, alle anderen vorgewählt; „Alle überschreiben" wählt alles. Regel: `core/src/standards.rs`.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Project } from "../../model/types";
import { standardsChangeKey, standardsUpdatePlan } from "../../model/standards";
import { t } from "../../i18n";

const COLLECTION_ORDER = ["components", "hatches", "lineStyles", "wallTypes", "ceilingTypes", "roofTypes"];

export function StandardsUpdateDialog({
  project,
  onApply,
  onClose,
}: {
  project: Project;
  onApply: (selected: string[]) => void;
  onClose: () => void;
}) {
  const plan = useMemo(() => standardsUpdatePlan(project), [project]);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(plan.changes.filter((c) => !c.renamed).map(standardsChangeKey)),
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (key: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const groups = COLLECTION_ORDER.map((col) => ({ col, items: plan.changes.filter((c) => c.collection === col) })).filter((g) => g.items.length > 0);
  const nothing = plan.changes.length === 0 && plan.added === 0;
  const canApply = selected.size > 0 || plan.added > 0;

  return createPortal(
    <div className="imp-overlay" onClick={onClose}>
      <div className="imp-dialog" role="dialog" aria-modal="true" aria-label={t("resources.updateStandards")} style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <header className="imp-head">
          <span className="imp-head-title">{t("resources.updateStandards")}</span>
          <button className="imp-close" onClick={onClose} aria-label={t("export.close")}>
            ×
          </button>
        </header>
        <div className="imp-body" style={{ maxHeight: "60vh", overflow: "auto" }}>
          {nothing ? (
            <section className="imp-section">
              <div className="imp-section-title">{t("resources.updateStandards.none")}</div>
            </section>
          ) : (
            <>
              <section className="imp-section">
                <div className="imp-section-title" style={{ fontWeight: 400 }}>
                  {t("resources.updateStandards.intro")}
                </div>
                {plan.added > 0 && (
                  <div className="imp-section-title" style={{ fontWeight: 400, opacity: 0.8 }}>
                    {t("resources.updateStandards.added", { n: plan.added })}
                  </div>
                )}
              </section>
              {groups.map((g) => (
                <section className="imp-section" key={g.col}>
                  <div className="imp-section-title">{t(`resources.updateStandards.col.${g.col}`)}</div>
                  {g.items.map((c) => {
                    const key = standardsChangeKey(c);
                    return (
                      <label key={key} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "2px 0", cursor: "pointer" }}>
                        <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
                        <span>
                          {c.name}
                          {c.renamed && <em style={{ opacity: 0.7 }}> ({t("resources.updateStandards.renamed")})</em>}
                          <span style={{ opacity: 0.6, fontSize: 11 }}> — {c.fields.map((f) => t(`resources.updateStandards.field.${f}`)).join(", ")}</span>
                        </span>
                      </label>
                    );
                  })}
                </section>
              ))}
            </>
          )}
        </div>
        <footer className="imp-foot">
          {!nothing && plan.changes.length > 0 && (
            <>
              <button className="imp-btn" onClick={() => setSelected(new Set(plan.changes.map(standardsChangeKey)))}>
                {t("resources.updateStandards.all")}
              </button>
              <button className="imp-btn" onClick={() => setSelected(new Set())}>
                {t("resources.updateStandards.noneSelected")}
              </button>
            </>
          )}
          <button className="imp-btn" onClick={onClose}>
            {t("export.cancel")}
          </button>
          {!nothing && (
            <button
              className="imp-btn primary"
              disabled={!canApply}
              onClick={() => {
                onApply([...selected]);
                onClose();
              }}
            >
              {t("resources.updateStandards.apply", { n: selected.size })}
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
