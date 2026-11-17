// Dock-Panel „Umbau“ ([271], Wunsch Maintainer 17.11., wie Archicads Palette Umbau): Zeichen-Status neuer Bauteile,
// Umbaufilter der aktiven Ansicht (mit Vorschau je Status), Status der Auswahl samt „nach Status wählen“ und die
// Etappen. Zustand und Aktionen teilt es mit dem Popover der Statusleiste (`state/renovationHook.ts`); Änderungen
// gehen als Ops über `applyChange` (ein Undo-Schritt je Aktion).
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useState } from "react";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { useStore } from "../state/appStore";
import { renovationFilterLabel, useRenovationControls, useRenovationSelection } from "../state/renovationHook";
import {
  BUILTIN_RENOVATION_FILTERS,
  newPhaseId,
  phaseUsage,
  renovationCounts,
  renovationFilterShows,
  renovationStyleOf,
  RENOVATION_STATUSES,
  setPhasesOps,
} from "../core";
import type { Project, RenovationShow, RenovationStatus } from "../model/types";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { usePanelHostAction } from "./host";
import { RenovationSanierung } from "./RenovationSanierung";

const MIXED = "__mixed";

/** Farbfeld eines Status (SIA-Farbmuster: Füllung, Linie, gestrichelt wie im Plan). */
function Swatch({ project, status, show }: { project: Project; status: RenovationStatus; show?: RenovationShow }) {
  const st = renovationStyleOf(project, status);
  const hidden = show === "hide";
  const plain = show === "show";
  return (
    <span
      className={`reno-swatch${hidden ? " is-hidden" : ""}${plain ? " is-plain" : ""}`}
      style={{
        background: hidden || plain ? "transparent" : st.fill,
        borderColor: st.line ?? "rgba(0,0,0,0.45)",
        borderStyle: st.dashed ? "dashed" : "solid",
      }}
      aria-hidden="true"
    />
  );
}

function ShowChip({ project, status, show }: { project: Project; status: RenovationStatus; show: RenovationShow }) {
  return (
    <span className="reno-chip" data-testid={`reno-chip-${status}`} data-show={show}>
      <Swatch project={project} status={status} show={show} />
      <span className="reno-chip-text">
        <span className="reno-chip-status">{t(`renovation.status.${status}` as TranslationKey)}</span>
        <span className="reno-chip-show">{t(`renovation.show.${show}` as TranslationKey)}</span>
      </span>
    </span>
  );
}

export function RenovationPanel() {
  const project = useStore((s) => s.project);
  const { levelEditable, draw, setDraw, phases, own, filter, filterPhase, setLevel } = useRenovationControls();
  const sel = useRenovationSelection();
  const applyChange = useStore((s) => s.applyChange);
  const openResources = usePanelHostAction("onOpenResources");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const counts = renovationCounts(project, sel.floorId);
  const shows = filter ? renovationFilterShows(project, filter) : null;
  const filterIds = ["", ...BUILTIN_RENOVATION_FILTERS, ...own.map((f) => f.id)];

  const statusValue = sel.common.status === "mixed" || sel.common.status === null ? null : sel.common.status;
  const phaseValue = sel.common.phase === "mixed" ? MIXED : (sel.common.phase ?? "");

  const setPhases = (next: { id: string; name: string }[], key?: string) => applyChange((p) => setPhasesOps(p, next), key);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= phases.length) return;
    const next = [...phases];
    [next[i], next[j]] = [next[j], next[i]];
    setPhases(next);
  };
  const confirmPhase = confirmId ? phases.find((p) => p.id === confirmId) : undefined;
  const confirmUsage = confirmPhase ? phaseUsage(project, confirmPhase.id) : 0;

  return (
    <section className="reno-panel" data-testid="renovation-dock">
      {/* Neue Bauteile zeichnen als */}
      <div className="reno-block">
        <div className="reno-head">{t("renovation.drawStatus")}</div>
        <div className="reno-status-row" role="radiogroup" aria-label={t("renovation.panel.draw.status")}>
          {RENOVATION_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={draw.status === s}
              className={`reno-status-btn${draw.status === s ? " active" : ""}`}
              data-testid={`reno-draw-${s}`}
              onClick={() => setDraw(s, draw.phase)}
            >
              <Swatch project={project} status={s} />
              <span>{t(`renovation.status.${s}` as TranslationKey)}</span>
            </button>
          ))}
        </div>
        {phases.length > 0 && (
          <label className="reno-field">
            <span>{t("renovation.phase")}</span>
            <select value={draw.phase ?? ""} data-testid="reno-draw-phase" onChange={(e) => setDraw(draw.status, e.target.value || undefined)}>
              <option value="">{t("renovation.phase.none")}</option>
              {phases.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="reno-hint">{t("renovation.panel.draw.hint")}</div>
      </div>

      {/* Umbaufilter der aktiven Ansicht */}
      <div className="reno-block">
        <div className="reno-head">{t("renovation.panel.filter.title")}</div>
        {!levelEditable && <div className="reno-hint">{t("renovation.panel.filter.locked")}</div>}
        <ul className="reno-filters" role="radiogroup" aria-label={t("renovation.filter")}>
          {filterIds.map((id) => {
            const fs = id ? renovationFilterShows(project, id) : null;
            return (
              <li key={id || "none"}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={filter === id}
                  disabled={!levelEditable}
                  className={`reno-filter${filter === id ? " active" : ""}`}
                  data-testid={`reno-filter-${id || "none"}`}
                  onClick={() => setLevel({ renovationFilter: id || undefined, renovationPhase: filterPhase || undefined })}
                >
                  <span className="reno-filter-name">{id ? renovationFilterLabel(id, own) : t("renovation.filter.none")}</span>
                  <span className="reno-filter-sw">
                    {fs && RENOVATION_STATUSES.map((s) => <Swatch key={s} project={project} status={s} show={fs[s]} />)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {phases.length > 0 && filter && (
          <label className="reno-field">
            <span>{t("renovation.filterPhase")}</span>
            <select
              value={filterPhase}
              disabled={!levelEditable}
              data-testid="reno-filter-phase"
              onChange={(e) => setLevel({ renovationFilter: filter, renovationPhase: e.target.value || undefined })}
            >
              <option value="">{t("renovation.phase.all")}</option>
              {phases.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {shows && (
          <div className="reno-preview" aria-label={t("renovation.panel.filter.preview")} data-testid="reno-preview">
            {RENOVATION_STATUSES.map((s) => (
              <ShowChip key={s} project={project} status={s} show={shows[s]} />
            ))}
          </div>
        )}
      </div>

      {/* Auswahl */}
      <div className="reno-block">
        <div className="reno-head">{t("renovation.panel.selection.title")}</div>
        {sel.ids.length === 0 ? (
          <div className="reno-hint" data-testid="reno-sel-none">
            {t("renovation.panel.selection.none")}
          </div>
        ) : (
          <>
            <div className="reno-sel-state" data-testid="reno-sel-state" data-status={statusValue ?? "mixed"}>
              {statusValue ? <Swatch project={project} status={statusValue} /> : <span className="reno-swatch is-mixed" aria-hidden="true" />}
              <span>{statusValue ? t(`renovation.status.${statusValue}` as TranslationKey) : t("renovation.mixed")}</span>
              <span className="reno-sel-count">{t("renovation.panel.selection.count", { n: String(sel.ids.length) })}</span>
            </div>
            <div className="reno-status-row">
              {RENOVATION_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`reno-status-btn small${statusValue === s ? " active" : ""}`}
                  data-testid={`reno-set-${s}`}
                  onClick={() => sel.setStatus(s)}
                >
                  <Swatch project={project} status={s} />
                  <span>{t("renovation.panel.set", { status: t(`renovation.status.${s}` as TranslationKey) })}</span>
                </button>
              ))}
            </div>
            {phases.length > 0 && (
              <label className="reno-field">
                <span>{t("renovation.panel.selectionPhase")}</span>
                <select
                  value={phaseValue}
                  data-testid="reno-sel-phase"
                  onChange={(e) => e.target.value !== MIXED && sel.setPhase(e.target.value || null)}
                >
                  {phaseValue === MIXED && <option value={MIXED}>{t("renovation.mixed")}</option>}
                  <option value="">{t("renovation.phase.none")}</option>
                  {phases.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        <div className="reno-head sub">{t("renovation.panel.selectBy")}</div>
        <div className="reno-select-by">
          {RENOVATION_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className="reno-link-btn"
              disabled={counts[s] === 0}
              data-testid={`reno-select-${s}`}
              onClick={() => sel.selectByStatus(s)}
            >
              <Swatch project={project} status={s} />
              {t("renovation.panel.selectAll", { status: t(`renovation.status.${s}` as TranslationKey), n: String(counts[s]) })}
            </button>
          ))}
        </div>
      </div>

      {/* [274] Sanierung je Schicht: Typ-Paare Bestand → Sanierungstyp */}
      <RenovationSanierung project={project} />

      {/* Etappen */}
      <div className="reno-block">
        <div className="reno-head">{t("renovation.phases.title")}</div>
        {phases.length === 0 && <div className="reno-hint">{t("renovation.phases.empty")}</div>}
        {phases.map((ph, i) => (
          <div className="reno-phase-row" key={ph.id} data-testid="reno-phase-row">
            <input
              type="text"
              value={ph.name}
              aria-label={t("renovation.panel.phases.name")}
              data-testid="reno-phase-name"
              onChange={(e) => setPhases(phases.map((x) => (x.id === ph.id ? { ...x, name: e.target.value } : x)), `reno-phase-${ph.id}`)}
            />
            <button type="button" className="reno-icon-btn" disabled={i === 0} title={t("renovation.phases.up")} aria-label={t("renovation.phases.up")} onClick={() => move(i, -1)}>
              ▲
            </button>
            <button type="button" className="reno-icon-btn" disabled={i === phases.length - 1} title={t("renovation.phases.down")} aria-label={t("renovation.phases.down")} onClick={() => move(i, 1)}>
              ▼
            </button>
            <button type="button" className="reno-icon-btn" title={t("renovation.phases.remove")} aria-label={t("renovation.phases.remove")} data-testid="reno-phase-remove" onClick={() => setConfirmId(ph.id)}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="reno-add-btn"
          data-testid="reno-phase-add"
          onClick={() => setPhases([...phases, { id: newPhaseId(project), name: t("renovation.phases.defaultName", { n: String(phases.length + 1) }) }])}
        >
          {t("renovation.phases.add")}
        </button>
        <button type="button" className="reno-link-btn" data-testid="reno-open-colors" onClick={() => openResources("renovation")}>
          {t("renovation.panel.colors")}
        </button>
      </div>

      {confirmPhase && (
        <ConfirmDialog
          title={t("renovation.panel.phases.deleteTitle")}
          message={
            confirmUsage > 0
              ? t("renovation.panel.phases.deleteMessage", { name: confirmPhase.name, n: String(confirmUsage) })
              : t("renovation.panel.phases.deleteMessageUnused", { name: confirmPhase.name })
          }
          confirmLabel={t("renovation.panel.phases.delete")}
          danger
          onClose={() => setConfirmId(null)}
          onConfirm={() => {
            setPhases(phases.filter((x) => x.id !== confirmPhase.id));
            setConfirmId(null);
          }}
        />
      )}
    </section>
  );
}

/** Reiter-Symbol: Wand in drei Status (voll, gestrichelt, Umriss) — Bestand, Abbruch, Neu. */
export function RenovationTabIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="2" y="2.5" width="12" height="3" fill="currentColor" fillOpacity="0.45" />
      <rect x="2" y="6.5" width="12" height="3" strokeDasharray="2 1.6" />
      <rect x="2" y="10.5" width="12" height="3" />
    </svg>
  );
}
