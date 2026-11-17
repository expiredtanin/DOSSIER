// [271] Umbau in der Statusleiste: zeigt den aktuellen Zeichen-Status (neue Bauteile tragen ihn) und den Umbaufilter der
// aktiven Ansicht; das Popover stellt beides ein (Status und Etappe zum Zeichnen; Filter und Etappe der Ebene — wie die
// Modelldarstellung ein Feld der Ebene, darum je Reiter/Ausschnitt eigen und mit Undo). Bei wenig Platz wandert es
// mit der Pausfolie in „⋯“ ([263]).

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { renovationFilterLabel, useRenovationControls, useRenovationSwatches } from "../state/renovationHook";
import { BUILTIN_RENOVATION_FILTERS, RENOVATION_STATUSES } from "../core";
import type { RenovationStatus } from "../model/types";

export { renovationFilterLabel };

export function RenovationControl() {
  const { draw, setDraw, phases, own, filter, filterPhase, levelEditable, setLevel } = useRenovationControls();
  const sw = useRenovationSwatches();
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
        <span className={`sb-renovation-dot sb-renovation-${draw.status}`} style={{ background: sw[draw.status].fill }} aria-hidden="true" />
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
              onChange={(e) => setLevel({ renovationFilter: e.target.value || undefined, renovationPhase: filterPhase || undefined })}
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
                value={filterPhase}
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
