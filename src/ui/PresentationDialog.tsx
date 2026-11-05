// [66] Dialog „Präsentationsplan": Geschosse, Ansichten/Schnitt, Blattformat, Skizzenstil. Registriert sich
// selbst als Öffner (`state/presentationSheetHook`), damit Befehl `praesentation` und der Knopf im
// Layouts-Panel ihn öffnen. Beim Bestätigen entsteht das Blatt in EINEM Undo-Schritt
// (`state/presentationSheet.ts`); `onCreated` öffnet es. Overlay wie `LayoutCreateDialogs` (kein window.prompt).

import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n";
import { presentationDefaults, type PresentationOptions } from "../core";
import type { LayoutOrientation, LayoutPaperFormat } from "../model/types";
import { PAPER_FORMAT_GROUPS } from "../model/layoutModel";
import { getState, useStore } from "../state/appStore";
import { setPresentationDialogOpener } from "../state/presentationSheetHook";
import { createPresentationSheet } from "../state/presentationSheet";

export function PresentationDialogHost({ onCreated }: { onCreated: (layoutId: string) => void }) {
  const [opts, setOpts] = useState<PresentationOptions | null>(null);
  const project = useStore((s) => s.project);

  useEffect(() => {
    setPresentationDialogOpener(() => setOpts(presentationDefaults(getState().project)));
    return () => setPresentationDialogOpener(null);
  }, []);

  const close = useCallback(() => setOpts(null), []);
  const confirm = useCallback(() => {
    if (!opts) return;
    const id = createPresentationSheet(opts);
    setOpts(null);
    if (id) onCreated(id);
  }, [opts, onCreated]);

  useEffect(() => {
    if (!opts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "Enter") confirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opts, close, confirm]);

  if (!opts) return null;
  const floors = project.drawingLevels.filter((l) => l.kind === "floor" && !l.layoutId);
  const sections = project.drawingLevels.filter((l) => l.kind === "section");
  const hasElevations = project.drawingLevels.some((l) => l.kind === "elevation");
  const set = (patch: Partial<PresentationOptions>) => setOpts({ ...opts, ...patch });
  const toggleFloor = (id: string, on: boolean) =>
    // Blattreihenfolge = Reihenfolge der Geschosse im Projekt.
    set({ floors: floors.map((f) => f.id).filter((f) => (f === id ? on : opts.floors.includes(f))) });
  const empty = opts.floors.length === 0 && !(opts.elevations && hasElevations) && !opts.sectionId;

  return (
    <div className="imp-overlay" onClick={close}>
      <div
        className="imp-dialog presentation-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("presentation.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{t("presentation.title")}</span>
          <button className="imp-close" onClick={close} aria-label={t("export.close")}>
            ×
          </button>
        </header>
        <div className="imp-body">
          <section className="imp-section">
            <div className="imp-section-title">{t("presentation.floors")}</div>
            {floors.map((f) => (
              <label key={f.id} className="imp-check" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  data-floor={f.id}
                  checked={opts.floors.includes(f.id)}
                  onChange={(e) => toggleFloor(f.id, e.target.checked)}
                />
                {f.name}
              </label>
            ))}
          </section>
          <section className="imp-section">
            <label className="imp-check" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                data-testid="presentation-elevations"
                disabled={!hasElevations}
                checked={opts.elevations && hasElevations}
                onChange={(e) => set({ elevations: e.target.checked })}
              />
              {t("presentation.elevations")}
            </label>
          </section>
          <section className="imp-section">
            <div className="imp-section-title">{t("presentation.section")}</div>
            <select
              className="imp-select"
              data-testid="presentation-section"
              value={opts.sectionId ?? ""}
              onChange={(e) => set({ sectionId: e.target.value || null })}
            >
              <option value="">{t("presentation.noSection")}</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </section>
          <section className="imp-section">
            <div className="imp-section-title">{t("presentation.sheet")}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select
                className="imp-select"
                data-testid="presentation-paper"
                value={opts.paper}
                onChange={(e) => set({ paper: e.target.value as LayoutPaperFormat })}
              >
                {PAPER_FORMAT_GROUPS.flatMap((g) => g.formats).map((f) => (
                  <option key={f} value={f}>
                    {f.toUpperCase()}
                  </option>
                ))}
              </select>
              <div className="imp-seg">
                {(["portrait", "landscape"] as LayoutOrientation[]).map((o) => (
                  <button
                    key={o}
                    type="button"
                    className={`imp-seg-btn${opts.orientation === o ? " active" : ""}`}
                    onClick={() => set({ orientation: o })}
                  >
                    {o === "portrait" ? t("layouts.portrait") : t("layouts.landscape")}
                  </button>
                ))}
              </div>
            </div>
          </section>
          <section className="imp-section">
            <label className="imp-check" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                data-testid="presentation-sketch"
                checked={opts.sketch}
                onChange={(e) => set({ sketch: e.target.checked })}
              />
              {t("presentation.sketch")}
            </label>
          </section>
          <p style={{ fontSize: 11, color: "var(--muted)", margin: "4px 0 0" }}>{t("presentation.hint")}</p>
        </div>
        <footer className="imp-foot">
          <button className="imp-btn" onClick={close}>
            {t("export.cancel")}
          </button>
          <button className="imp-btn primary" data-testid="presentation-create" disabled={empty} onClick={confirm}>
            {t("presentation.create")}
          </button>
        </footer>
      </div>
    </div>
  );
}
