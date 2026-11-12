// [205] Pausfolie in der Statusleiste: Ein/Aus (wie Cmd/Ctrl+Shift+T) und ein Popover für Quelle, Farbe, Deckkraft,
// unter/über, Versatz, Drehung, Verschieben/Drehen per Klick (Befehle `tracemove`/`tracerotate`) und Zurücksetzen.
// Liest und schreibt nur `state.trace` (UI-Zustand des Reiters, s. `state/traceRef.ts`).

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { useStore } from "../state/appStore";
import { patchTraceAction, resetTraceAction, showAsTraceAction, toggleTraceAction } from "../state/traceActions";
import { traceMoved } from "../state/traceRef";
import { traceSourceAllowed } from "../core";

/** Farben zur Wahl (fehlt = Grau, die Vorgabe). */
const COLORS: Array<{ value: string; key: TranslationKey }> = [
  { value: "", key: "trace.color.grey" },
  { value: "#d0342c", key: "trace.color.red" },
  { value: "#2060c0", key: "trace.color.blue" },
  { value: "#2e8b3a", key: "trace.color.green" },
  { value: "#e07b00", key: "trace.color.orange" },
];

const num = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0);

export function TraceControl({ enabled, onRunCommand }: { enabled: boolean; onRunCommand?: (name: string) => void }) {
  const trace = useStore((s) => s.trace);
  const project = useStore((s) => s.project);
  const activeLevelId = useStore((s) => s.activeLevelId);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const active = project.drawingLevels.find((l) => l.id === activeLevelId);
  const sources = active ? project.drawingLevels.filter((l) => traceSourceAllowed(active, l)) : [];
  const on = enabled && !!trace?.show;
  const run = (name: string) => {
    setOpen(false);
    onRunCommand?.(name);
  };
  return (
    <span className="sb-snap-wrap" ref={wrapRef}>
      <span className={`sb-seg${open ? " open" : ""}${enabled ? "" : " disabled"}`} role="group" aria-label={t("trace.title")}>
        <button
          type="button"
          className={`sb-seg-btn${on ? " active" : ""}`}
          aria-pressed={on}
          disabled={!enabled}
          data-testid="trace-toggle"
          title={enabled ? t("trace.hint") : t("trace.hintDisabled")}
          onClick={toggleTraceAction}
        >
          {t("trace.title")}
        </button>
        <button
          type="button"
          className={`sb-seg-btn sb-seg-caret${open ? " active" : ""}`}
          aria-haspopup="true"
          aria-expanded={open}
          disabled={!enabled}
          aria-label={t("trace.settings")}
          title={t("trace.settings")}
          onClick={() => setOpen((v) => !v)}
        >
          ▴
        </button>
      </span>
      {open && enabled && (
        <div className="sb-snap-popover sb-trace-popover" role="dialog" aria-label={t("trace.settings")}>
          <label className="sb-snap-row sb-snap-row-num">
            <span>{t("trace.source")}</span>
            <select
              value={trace?.sourceId ?? ""}
              aria-label={t("trace.source")}
              onChange={(e) => e.target.value && showAsTraceAction(e.target.value)}
            >
              {!trace && <option value="">{t("trace.source.none")}</option>}
              {sources.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="sb-snap-row sb-snap-row-num">
            <span>{t("trace.color")}</span>
            <select value={trace?.color ?? ""} disabled={!trace} aria-label={t("trace.color")} onChange={(e) => patchTraceAction({ color: e.target.value || undefined })}>
              {COLORS.map((c) => (
                <option key={c.value} value={c.value}>
                  {t(c.key)}
                </option>
              ))}
            </select>
          </label>
          <label className="sb-snap-row sb-snap-row-num">
            <span>{t("trace.opacity")}</span>
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              disabled={!trace}
              aria-label={t("trace.opacity")}
              value={Math.round((trace?.opacity ?? 0.5) * 100)}
              onChange={(e) => patchTraceAction({ opacity: Number(e.target.value) / 100 })}
            />
          </label>
          <label className="sb-snap-row">
            <input type="checkbox" disabled={!trace} checked={!!trace?.above} onChange={(e) => patchTraceAction({ above: e.target.checked || undefined })} />
            <span>{t("trace.above")}</span>
          </label>
          <label className="sb-snap-row sb-snap-row-num">
            <span>{t("trace.offsetX")}</span>
            <input
              type="number"
              step={0.1}
              disabled={!trace}
              aria-label={t("trace.offsetX")}
              value={num(trace?.offset.x ?? 0)}
              onChange={(e) => trace && Number.isFinite(e.target.valueAsNumber) && patchTraceAction({ offset: { ...trace.offset, x: e.target.valueAsNumber } })}
            />
          </label>
          <label className="sb-snap-row sb-snap-row-num">
            <span>{t("trace.offsetY")}</span>
            <input
              type="number"
              step={0.1}
              disabled={!trace}
              aria-label={t("trace.offsetY")}
              value={num(trace?.offset.y ?? 0)}
              onChange={(e) => trace && Number.isFinite(e.target.valueAsNumber) && patchTraceAction({ offset: { ...trace.offset, y: e.target.valueAsNumber } })}
            />
          </label>
          <label className="sb-snap-row sb-snap-row-num">
            <span>{t("trace.rotation")}</span>
            <input
              type="number"
              step={1}
              disabled={!trace}
              aria-label={t("trace.rotation")}
              value={num(trace?.rotation ?? 0)}
              onChange={(e) => trace && Number.isFinite(e.target.valueAsNumber) && patchTraceAction({ rotation: e.target.valueAsNumber })}
            />
          </label>
          <div className="sb-trace-actions">
            <button type="button" className="sb-toggle" disabled={!on || !onRunCommand} onClick={() => run("tracemove")}>
              {t("trace.move")}
            </button>
            <button type="button" className="sb-toggle" disabled={!on || !onRunCommand} onClick={() => run("tracerotate")}>
              {t("trace.rotate")}
            </button>
            <button type="button" className="sb-toggle" disabled={!traceMoved(trace)} onClick={resetTraceAction}>
              {t("trace.reset")}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
