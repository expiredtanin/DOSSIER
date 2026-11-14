// [66] Dialog „Präsentationsplan": Geschosse, Ansichten/Schnitt, Blattformat, Skizzenstil. Registriert sich
// selbst als Öffner (`state/presentationSheetHook`), damit Befehl `praesentation` und der Knopf im
// Layouts-Panel ihn öffnen. Beim Bestätigen entsteht das Blatt in EINEM Undo-Schritt
// (`state/presentationSheet.ts`); `onCreated` öffnet es. Overlay wie `LayoutCreateDialogs` (kein window.prompt).

import { memo, useCallback, useEffect, useState } from "react";
import { t } from "../i18n";
import { useModalFocus } from "./modalFocus";
import { PRESENTATION_SCALES, levelHasContent, presentationDefaults, type PresentationOptions } from "../core";
import type { LayoutOrientation, LayoutPaperFormat } from "../model/types";
import { PAPER_FORMAT_GROUPS } from "../model/layoutModel";
import { POSTER_TEMPLATES, posterTemplateLabel } from "../model/posterTemplates";
import { getState, useStore } from "../state/appStore";
import { setPresentationDialogOpener } from "../state/presentationSheetHook";
import { createPresentationSheet } from "../state/presentationSheet";

/** Memoisiert und nur auf die Zeichnungsebenen abonniert ([121]): rendert nicht bei jeder Op. */
export const PresentationDialogHost = memo(function PresentationDialogHost({
  onCreated,
}: {
  onCreated: (layoutId: string) => void;
}) {
  const [opts, setOpts] = useState<PresentationOptions | null>(null);
  const drawingLevels = useStore((s) => s.project.drawingLevels);
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

  const dialogRef = useModalFocus({});
  useEffect(() => {
    if (!opts) return;
    const onKey = (e: KeyboardEvent) => {
      // Enter aus der Befehlszeile (die den Dialog eben geöffnet hat) bestätigt nicht.
      if (e.target instanceof Element && e.target.closest("input, textarea") && !e.target.closest(".presentation-dialog")) return;
      if (e.key === "Escape") close();
      else if (e.key === "Enter") confirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opts, close, confirm]);

  if (!opts) return null;
  const floors = drawingLevels.filter((l) => l.kind === "floor" && !l.layoutId);
  const sections = drawingLevels.filter((l) => l.kind === "section");
  const elevations = drawingLevels.filter((l) => l.kind === "elevation");
  const set = (patch: Partial<PresentationOptions>) => setOpts({ ...opts, ...patch });
  const toggleFloor = (id: string, on: boolean) =>
    // Blattreihenfolge = Reihenfolge der Geschosse im Projekt.
    set({ floors: floors.map((f) => f.id).filter((f) => (f === id ? on : opts.floors.includes(f))) });
  const toggleElevation = (id: string, on: boolean) =>
    set({ elevationIds: elevations.map((e) => e.id).filter((e) => (e === id ? on : opts.elevationIds.includes(e))) });
  const empty = opts.floors.length === 0 && opts.elevationIds.length === 0 && !opts.sectionId;
  // [224] Massstab je Viewport: "" = gemeinsamer Massstab.
  const scaleOf = (id: string) => String(opts.scales?.[id] ?? "");
  const setScaleOf = (id: string, v: string) => {
    const next = { ...(opts.scales ?? {}) };
    if (v) next[id] = Number(v);
    else delete next[id];
    set({ scales: next });
  };
  const scaleSelect = (id: string) => (
    <select className="imp-select" style={{ marginLeft: "auto" }} data-testid={`presentation-scale-${id}`} aria-label={`${t("export.scale")} ${drawingLevels.find((l) => l.id === id)?.name ?? ""}`.trim()} value={scaleOf(id)} onChange={(e) => setScaleOf(id, e.target.value)}>
      <option value="">{t("presentation.scale.common")}</option>
      {PRESENTATION_SCALES.map((n) => (
        <option key={n} value={n}>{`1:${n}`}</option>
      ))}
    </select>
  );
  const poster = !!opts.poster;

  return (
    <div className="imp-overlay" onClick={close}>
      <div
        className="imp-dialog presentation-dialog"
        ref={dialogRef}
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
                {!levelHasContent(project, f.id) && <span style={{ color: "var(--muted)" }}>{t("presentation.floorEmpty")}</span>}
                {scaleSelect(f.id)}
              </label>
            ))}
          </section>
          <section className="imp-section">
            <div className="imp-section-title">{t("presentation.elevations")}</div>
            {elevations.length === 0 && <div style={{ color: "var(--muted)" }}>{t("presentation.noElevations")}</div>}
            {elevations.map((e) => (
              <label key={e.id} className="imp-check" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  data-testid={`presentation-elevation-${e.id}`}
                  checked={opts.elevationIds.includes(e.id)}
                  onChange={(ev) => toggleElevation(e.id, ev.target.checked)}
                />
                {e.name}
                {scaleSelect(e.id)}
              </label>
            ))}
          </section>
          <section className="imp-section">
            <div className="imp-section-title">{t("presentation.section")}</div>
            <select
              className="imp-select"
              data-testid="presentation-section"
              aria-label={t("presentation.section")}
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
            {opts.sectionId && <div style={{ display: "flex", marginTop: 4 }}>{scaleSelect(opts.sectionId)}</div>}
          </section>
          <section className="imp-section">
            <div className="imp-section-title">{t("presentation.sheet")}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <select
                className="imp-select"
                data-testid="presentation-target"
                aria-label={t("presentation.sheet")}
                value={opts.poster ?? ""}
                onChange={(e) => set({ poster: e.target.value || undefined })}
              >
                <option value="">{t("presentation.target.sheet")}</option>
                {POSTER_TEMPLATES.map((tpl) => (
                  <option key={tpl.key} value={tpl.key}>
                    {posterTemplateLabel(tpl)}
                  </option>
                ))}
              </select>
              <select
                className="imp-select"
                data-testid="presentation-scale"
                aria-label={t("export.scale")}
                value={opts.scale ?? ""}
                onChange={(e) => set({ scale: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">{t("presentation.scale.auto")}</option>
                {PRESENTATION_SCALES.map((n) => (
                  <option key={n} value={n}>{`1:${n}`}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", opacity: poster ? 0.5 : 1 }}>
              <select
                className="imp-select"
                data-testid="presentation-paper"
                aria-label={t("export.paper")}
                value={opts.paper}
                disabled={poster}
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
                    disabled={poster}
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
});
