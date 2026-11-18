// [66] Dialog „Präsentationsplan": Geschosse, Ansichten/Schnitt, Blattformat, Skizzenstil. Registriert sich
// selbst als Öffner (`state/presentationSheetHook`), damit Befehl `praesentation` und der Knopf im
// Layouts-Panel ihn öffnen. Beim Bestätigen entsteht das Blatt in EINEM Undo-Schritt
// (`state/presentationSheet.ts`); `onCreated` öffnet es. Overlay wie `LayoutCreateDialogs` (kein window.prompt).

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../i18n";
import { enterConfirmsDialog, useModalFocus } from "./modalFocus";
import { finerPresentationScale, posterExtrasDefault, PRESENTATION_SCALES, levelHasContent, presentationDefaults, type PosterTableKind, type PresentationOptions } from "../core";
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
    // [282] Nicht angelegt (z. B. passt nicht aufs Blatt): Dialog bleibt offen, Massstab/Format anpassbar.
    if (!id) return;
    setOpts(null);
    onCreated(id);
  }, [opts, onCreated]);

  const dialogRef = useModalFocus({});
  useEffect(() => {
    if (!opts) return;
    const onKey = (e: KeyboardEvent) => {
      // Enter aus der Befehlszeile (die den Dialog eben geöffnet hat) bestätigt nicht.
      if (e.target instanceof Element && e.target.closest("input, textarea") && !e.target.closest(".presentation-dialog")) return;
      if (e.key === "Escape") close();
      else if (e.key === "Enter" && enterConfirmsDialog(e.target)) confirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opts, close, confirm]);

  // [285] Passt ein feinerer Massstab (≥ 1:100) auch aufs Blatt, wird er angeboten: sonst bleibt das Blatt eines kleinen Hauses halb leer.
  const finer = useMemo(() => {
    if (!opts?.scale || (opts.floors.length === 0 && opts.elevationIds.length === 0 && opts.sectionIds.length === 0)) return null;
    try {
      return finerPresentationScale(project, opts);
    } catch {
      return null;
    }
  }, [project, opts]);
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
  const toggleSection = (id: string, on: boolean) =>
    set({ sectionIds: sections.map((x) => x.id).filter((x) => (x === id ? on : opts.sectionIds.includes(x))) });
  const toggleTable = (kind: PosterTableKind, on: boolean): PosterTableKind[] =>
    (["areas", "siteProof", "unitSchedule"] as const).filter((k) => (k === kind ? on : (opts.extras?.tables ?? []).includes(k)));
  const empty = opts.floors.length === 0 && opts.elevationIds.length === 0 && opts.sectionIds.length === 0;
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
            {sections.length === 0 && <div style={{ color: "var(--muted)" }}>{t("presentation.noSection")}</div>}
            {sections.map((sec) => (
              <label key={sec.id} className="imp-check" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  data-testid={`presentation-section-${sec.id}`}
                  checked={opts.sectionIds.includes(sec.id)}
                  onChange={(ev) => toggleSection(sec.id, ev.target.checked)}
                />
                {sec.name}
                {scaleSelect(sec.id)}
              </label>
            ))}
          </section>
          <section className="imp-section">
            <div className="imp-section-title">{t("presentation.sheet")}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <select
                className="imp-select"
                data-testid="presentation-target"
                aria-label={t("presentation.sheet")}
                value={opts.poster ?? ""}
                onChange={(e) => set({ poster: e.target.value || undefined, extras: e.target.value ? (opts.extras ?? posterExtrasDefault(project)) : undefined })}
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
            {finer && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, fontSize: 12 }} data-testid="presentation-finer">
                <span>{t("presentation.finerSuggest", { scale: opts.scale!, finer })}</span>
                <button type="button" className="imp-btn" data-testid="presentation-finer-apply" onClick={() => set({ scale: finer })}>
                  {t("presentation.finerApply", { finer })}
                </button>
              </div>
            )}
            {/* [283] Mit Plakat-Vorlage gilt deren Format: die ausgegraute Zeile zeigte ein falsches („A1“) und wird ausgeblendet. */}
            {!poster && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select
                className="imp-select"
                data-testid="presentation-paper"
                aria-label={t("export.paper")}
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
            )}
          </section>
          {poster && opts.extras && (
            <section className="imp-section" data-testid="presentation-extras">
              <div className="imp-section-title">{t("presentation.extras")}</div>
              {(
                [
                  ["situation", t("presentation.extras.situation"), opts.extras.situation, (on: boolean) => ({ situation: on })],
                  ["areas", t("presentation.extras.areas"), opts.extras.tables.includes("areas"), (on: boolean) => ({ tables: toggleTable("areas", on) })],
                  ["siteProof", t("presentation.extras.siteProof"), opts.extras.tables.includes("siteProof"), (on: boolean) => ({ tables: toggleTable("siteProof", on) })],
                  ...((project.units ?? []).length > 0 ? ([["unitSchedule", t("presentation.extras.units"), opts.extras.tables.includes("unitSchedule"), (on: boolean) => ({ tables: toggleTable("unitSchedule", on) })]] as const) : []),
                  ["image", t("presentation.extras.image"), opts.extras.image, (on: boolean) => ({ image: on })],
                ] as const
              ).map(([key, label, on, patch]) => (
                <label key={key} className="imp-check" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    data-testid={`presentation-extra-${key}`}
                    checked={on}
                    onChange={(e) => set({ extras: { ...opts.extras!, ...patch(e.target.checked) } })}
                  />
                  {label}
                </label>
              ))}
            </section>
          )}
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
            <label className="imp-check" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                data-testid="presentation-autodim"
                checked={!!opts.autoDim}
                onChange={(e) => set({ autoDim: e.target.checked })}
              />
              {t("presentation.autoDim")}
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
