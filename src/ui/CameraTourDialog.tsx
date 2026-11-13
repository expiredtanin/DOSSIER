// [246] Dialog „Kamerafahrt": Dauer je Abschnitt, Interpolation, Videoformat (WebM, MP4 wenn der Browser es kann), Abspielen
// im 3D-Viewport und Aufnahme als Video (`MediaRecorder` auf dem Canvas, Auflösung = Viewport, 30 Bilder/s). Während
// Abspielen/Aufnahme schrumpft der Dialog zu einer Leiste mit Fortschritt und „Abbrechen" (der Viewport bleibt sichtbar;
// Esc oder Klick in den Viewport brechen ebenfalls ab). Zustand: `cameraTourDialogState.ts`; Öffner `state/cameraTourDialogHook`.

import { memo, useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { t } from "../i18n";
import { getState } from "../state/appStore";
import { cancelCameraTour, currentTourKeys, getTourSettings, playCameraTour, recordCameraTour, setTourSettings } from "../state/cameraTourActions";
import { setCameraTourDialogOpener } from "../state/cameraTourDialogHook";
import { saveBinaryFile } from "../native/saveFile";
import { getViewportCanvas } from "../viewport/cameraBridge";
import { availableVideoFormats, videoFileName } from "../viewport/videoRecorder";
import type { TourMode } from "../viewport/cameraTour";
import {
  TOUR_FPS,
  canRecord,
  canStart,
  initialTourDialogState,
  parseSeconds,
  totalSeconds,
  tourDialogReducer,
} from "./cameraTourDialogState";

export const CameraTourDialogHost = memo(function CameraTourDialogHost() {
  const [s, dispatch] = useReducer(tourDialogReducer, initialTourDialogState);
  const resultRef = useRef<{ blob: Blob; ext: string } | null>(null);
  const formats = useMemo(() => (s.open ? availableVideoFormats() : []), [s.open]);

  useEffect(() => {
    setCameraTourDialogOpener(() => {
      resultRef.current = null;
      const cur = getTourSettings();
      dispatch({ type: "open", cameraCount: currentTourKeys().length, seconds: cur.seconds, mode: cur.mode, formats: availableVideoFormats().map((f) => f.id) });
    });
    return () => setCameraTourDialogOpener(null);
  }, []);

  const close = useCallback(() => dispatch({ type: "close" }), []);
  useEffect(() => {
    if (!s.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && s.phase !== "running") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.open, s.phase, close]);

  if (!s.open) return null;

  const commitSettings = () => {
    const seconds = parseSeconds(s.secondsText);
    if (seconds !== null) setTourSettings({ seconds, mode: s.mode });
  };

  const play = async () => {
    if (!canStart(s)) return;
    commitSettings();
    dispatch({ type: "start", recording: false });
    const r = await playCameraTour((f) => dispatch({ type: "progress", fraction: f }));
    if (r.status === "unavailable" || r.status === "failed") dispatch({ type: "cancel" });
    else dispatch({ type: "finish", recording: false });
  };

  const record = async () => {
    const format = availableVideoFormats().find((f) => f.id === s.format);
    if (!canRecord(s) || !format) return;
    commitSettings();
    resultRef.current = null;
    dispatch({ type: "start", recording: true });
    const r = await recordCameraTour(format, TOUR_FPS, (f) => dispatch({ type: "progress", fraction: f }));
    if (r.status === "done" && r.blob) {
      resultRef.current = { blob: r.blob, ext: format.ext };
      dispatch({ type: "finish", recording: true });
    } else if (r.status === "cancelled") {
      dispatch({ type: "cancel" });
      getState().notify(t("tour.cancelled"), "info");
    } else {
      dispatch({ type: "cancel" });
    }
  };

  const save = async () => {
    const res = resultRef.current;
    if (!res) return;
    try {
      const bytes = new Uint8Array(await res.blob.arrayBuffer());
      if (await saveBinaryFile(bytes, videoFileName(getState().project.name, res.ext), res.blob.type || "video/webm")) getState().notify(t("tour.saved"), "info");
    } catch (err) {
      getState().notify(t("tour.recordFailed", { reason: err instanceof Error ? err.message : String(err) }), "warning");
    }
  };

  if (s.phase === "running") {
    return (
      <div
        data-tour-ui
        data-testid="tour-bar"
        role="status"
        style={{ position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", zIndex: 1000, background: "var(--panel, #fff)", color: "var(--text, #111)", border: "1px solid var(--border, #888)", borderRadius: 6, padding: "8px 12px", display: "flex", gap: 10, alignItems: "center", boxShadow: "0 4px 16px rgba(0,0,0,.25)", maxWidth: "calc(100vw - 32px)" }}
      >
        <span style={{ fontSize: 12 }}>{s.recording ? t("tour.recording") : t("tour.playing")}</span>
        <progress style={{ width: 160 }} max={1} value={s.progress} data-testid="tour-progress" />
        <span style={{ fontSize: 12, minWidth: 34 }}>{Math.round(s.progress * 100)} %</span>
        <button className="imp-btn" data-testid="tour-cancel" onClick={() => cancelCameraTour()}>
          {t("tour.cancel")}
        </button>
      </div>
    );
  }

  const canvas = getViewportCanvas();
  const total = totalSeconds(s);
  const secondsOk = parseSeconds(s.secondsText) !== null;
  const res = resultRef.current;
  return (
    <div className="imp-overlay" data-tour-ui onClick={close}>
      <div className="imp-dialog render-dialog" role="dialog" aria-modal="true" aria-label={t("tour.title")} data-testid="tour-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="imp-head">
          <span className="imp-head-title">{t("tour.title")}</span>
          <button className="imp-close" onClick={close} aria-label={t("export.close")}>
            ×
          </button>
        </header>
        <div className="imp-body">
          {s.phase === "done" && res ? (
            <section className="imp-section" data-testid="tour-result">
              <div className="imp-note">{t("tour.done", { size: (res.blob.size / 1_048_576).toFixed(1), ext: res.ext.toUpperCase() })}</div>
            </section>
          ) : (
            <>
              <p className="imp-note">{t("tour.intro", { count: s.cameraCount })}</p>
              <section className="imp-section">
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                  <label className="imp-field-label">
                    {t("tour.seconds")}{" "}
                    <input
                      className="imp-input imp-input-flush"
                      style={{ width: 70 }}
                      inputMode="decimal"
                      data-testid="tour-seconds"
                      aria-invalid={!secondsOk}
                      value={s.secondsText}
                      onChange={(e) => dispatch({ type: "seconds", text: e.target.value })}
                    />
                  </label>
                  <label className="imp-field-label">
                    {t("tour.mode")}{" "}
                    <select className="imp-select" data-testid="tour-mode" value={s.mode} onChange={(e) => dispatch({ type: "mode", mode: e.target.value as TourMode })}>
                      <option value="catmull">{t("tour.mode.catmull")}</option>
                      <option value="smooth">{t("tour.mode.smooth")}</option>
                    </select>
                  </label>
                </div>
                <div className="imp-note" data-testid="tour-total">
                  {secondsOk ? t("tour.total", { seconds: total.toFixed(1) }) : t("tour.secondsBad")}
                </div>
              </section>
              <section className="imp-section">
                <div className="imp-section-title">{t("tour.video")}</div>
                {formats.length === 0 ? (
                  <div className="imp-note" data-testid="tour-noformat">
                    {t("tour.noRecorder")}
                  </div>
                ) : (
                  <label className="imp-field-label">
                    {t("tour.format")}{" "}
                    <select className="imp-select" data-testid="tour-format" value={s.format ?? ""} onChange={(e) => dispatch({ type: "format", format: e.target.value as "mp4" | "webm" })}>
                      {formats.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.ext.toUpperCase()}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="imp-note" data-testid="tour-resolution">
                  {canvas ? t("tour.resolution", { width: canvas.width, height: canvas.height, fps: TOUR_FPS }) : t("tour.resolutionUnknown", { fps: TOUR_FPS })}
                </div>
                {s.cameraCount < 2 && <div className="imp-note">{t("tour.needTwo")}</div>}
                {getState().renderMode === "pathtrace" && <div className="imp-note" data-testid="tour-pathtrace">{t("tour.pathtrace")}</div>}
              </section>
            </>
          )}
          {s.message && (
            <p className="imp-note" role="status">
              {s.message}
            </p>
          )}
        </div>
        <footer className="imp-foot">
          <button className="imp-btn" onClick={close}>
            {t("export.close")}
          </button>
          {s.phase === "done" && res ? (
            <>
              <button className="imp-btn" onClick={() => dispatch({ type: "again" })}>
                {t("tour.again")}
              </button>
              <button className="imp-btn primary" data-testid="tour-save" onClick={() => void save()}>
                {t("tour.save")}
              </button>
            </>
          ) : (
            <>
              <button className="imp-btn" data-testid="tour-play" disabled={!canStart(s)} onClick={() => void play()}>
                {t("tour.play")}
              </button>
              <button className="imp-btn primary" data-testid="tour-record" disabled={!canRecord(s)} onClick={() => void record()}>
                {t("tour.record")}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
});
