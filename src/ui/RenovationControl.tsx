// [271] Umbau in der Statusleiste: zeigt den aktuellen Zeichen-Status (neue Bauteile tragen ihn) und den Umbaufilter der
// aktiven Ansicht; das Popover stellt beides ein (Status und Etappe zum Zeichnen; Filter und Etappe der Ebene — wie die
// Modelldarstellung ein Feld der Ebene, darum je Reiter/Ausschnitt eigen und mit Undo). Bei wenig Platz wandert es
// mit der Pausfolie in „⋯“ ([263]).

import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { useStore } from "../state/appStore";
import { BUILTIN_RENOVATION_FILTERS, patchItem, renovationPhases, RENOVATION_STATUSES } from "../core";
import type { RenovationStatus } from "../model/types";

/** Anzeigename eines Filters (eingebaut übersetzt, eigene mit ihrem Namen). */
export function renovationFilterLabel(id: string, own: readonly { id: string; name: string }[]): string {
  if ((BUILTIN_RENOVATION_FILTERS as readonly string[]).includes(id)) return t(`renovation.filter.${id}` as TranslationKey);
  return own.find((f) => f.id === id)?.name ?? id;
}

export function RenovationControl() {
  const project = useStore((s) => s.project);
  const activeLevelId = useStore((s) => s.activeLevelId);
  const draw = useStore((s) => s.drawRenovation);
  const setDraw = useStore((s) => s.setDrawRenovation);
  const applyChange = useStore((s) => s.applyChange);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const level = project.drawingLevels.find((l) => l.id === activeLevelId);
  const phases = renovationPhases(project);
  const own = useMemo(() => project.renovation?.filters ?? [], [project.renovation?.filters]);
  const filter = level?.renovationFilter ?? "";
  const levelEditable = !!level && (level.kind === "floor" || level.kind === "section" || level.kind === "elevation" || level.kind === "ceiling");
  const setLevel = (patch: { renovationFilter?: string; renovationPhase?: string }) => {
    if (!level) return;
    applyChange((p) =>
      patchItem(p, "drawingLevels", level.id, (l) => {
        const next = { ...l, ...patch };
        if (!next.renovationFilter) delete next.renovationFilter;
        if (!next.renovationPhase || !next.renovationFilter) delete next.renovationPhase;
        return next;
      }),
    );
  };
  const statusLabel = t(`renovation.status.${draw.status}` as TranslationKey);
  const filterLabel = filter ? renovationFilterLabel(filter, own) : t("renovation.filter.none");
  return (
    <span className="sb-snap-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`sb-toggle${open ? " active" : ""}${filter ? " sb-renovation-on" : ""}`}
        data-testid="renovation-toggle"
        aria-haspopup="true"
        aria-expanded={open}
        title={t("renovation.status.hint", { status: statusLabel, filter: filterLabel })}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`sb-renovation-dot sb-renovation-${draw.status}`} aria-hidden="true" />
        {t("renovation.short", { status: statusLabel })}
      </button>
      {open && (
        <div className="sb-snap-popover sb-renovation-popover" role="dialog" aria-label={t("renovation.title")} data-testid="renovation-panel">
          <div className="sb-snap-row sb-snap-head">{t("renovation.drawStatus")}</div>
          <label className="sb-snap-row sb-snap-row-num">
            <span>{t("renovation.label")}</span>
            <select
              value={draw.status}
              aria-label={t("renovation.drawStatus")}
              data-testid="renovation-draw-status"
              onChange={(e) => setDraw(e.target.value as RenovationStatus, draw.phase)}
            >
              {RENOVATION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`renovation.status.${s}` as TranslationKey)}
                </option>
              ))}
            </select>
          </label>
          {phases.length > 0 && (
            <label className="sb-snap-row sb-snap-row-num">
              <span>{t("renovation.phase")}</span>
              <select value={draw.phase ?? ""} aria-label={t("renovation.phase")} onChange={(e) => setDraw(draw.status, e.target.value || undefined)}>
                <option value="">{t("renovation.phase.none")}</option>
                {phases.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="sb-snap-row sb-snap-head">{t("renovation.filter")}</div>
          <label className="sb-snap-row sb-snap-row-num">
            <span>{t("renovation.filter")}</span>
            <select
              value={filter}
              disabled={!levelEditable}
              aria-label={t("renovation.filter")}
              data-testid="renovation-filter"
              onChange={(e) => setLevel({ renovationFilter: e.target.value || undefined, renovationPhase: level?.renovationPhase })}
            >
              <option value="">{t("renovation.filter.none")}</option>
              {BUILTIN_RENOVATION_FILTERS.map((id) => (
                <option key={id} value={id}>
                  {t(`renovation.filter.${id}` as TranslationKey)}
                </option>
              ))}
              {own.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          {phases.length > 0 && filter && (
            <label className="sb-snap-row sb-snap-row-num">
              <span>{t("renovation.filterPhase")}</span>
              <select
                value={level?.renovationPhase ?? ""}
                aria-label={t("renovation.filterPhase")}
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
        </div>
      )}
    </span>
  );
}
