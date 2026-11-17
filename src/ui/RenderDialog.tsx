// [211] Dialog „Rendering …": Renderer (eingebautes Cycles [215] oder installiertes Blender), Bildgrösse, Qualität, Sonne
// (Datum/Uhrzeit, vorbelegt aus der Sonnenstudie), Kamera → startet den Renderer als eigenen Prozess (Tauri/Electron), zeigt den
// Fortschritt („Sample x von y“, verstrichene Zeit, Restzeit), bietet Abbrechen und nach dem Lauf das Bild (Vorschau, Speichern,
// Ins Layout einsetzen). Cycles ist die Vorgabe, wenn es mitgeliefert ist (`cyclesAvailable`); im Browser ist die Option
// ausgegraut und es gibt stattdessen das Blender-Paket als ZIP. Cycles-Ablauf ohne Oberfläche: `state/cyclesAction.ts`.
// Registriert sich selbst als Öffner (`state/renderDialogHook`); Befehl `rendering`, Menüpunkt Ansicht → „Rendering …“.
//
// [277] Zwei Hüllen um EINE Ansicht (`RenderDialogView`, nur Daten rein/Befehle raus, kein Zugriff aufs Projekt):
//   · Tauri: eigenes Fenster (`native/RenderWindowApp.tsx`, Brücke `native/renderWindow.ts`) — das Hauptfenster bleibt frei;
//   · Browser/Electron (kein Nebenfenster): Overlay wie `PresentationDialog` (kein window.prompt) — Rückfall wie bei den Einstellungen.
// Der Auftrag (Szene aus dem Kern, Prozess, Bild) liegt in beiden Fällen im Hauptfenster: `state/renderJob.ts`.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { useModalFocus } from "./modalFocus";
import { BLENDER_DOWNLOAD_URL, RENDER_QUALITY_PRESETS, hasExportView, paperPixels, sunPosition } from "../core";
import { setRenderDialogOpener } from "../state/renderDialogHook";
import { openExternalUrl } from "../native/blender";
import { CYCLES_MAX_EDGE, CYCLES_MAX_SAMPLES, CYCLES_QUALITIES, cyclesSamples, defaultEngine, formatDuration, type RenderEngine } from "../state/cyclesAction";
import {
  buildRenderSetupInfo,
  isRenderBusy,
  renderCommands,
  renderJob,
  sameRenderSetupInfo,
  useRenderJob,
  type RenderCommands,
  type RenderJobRequest,
  type RenderJobState,
  type RenderSetupInfo,
} from "../state/renderJob";
import { getState as getAppState, subscribe as subscribeStore } from "../state/appStore";
import { isTauriRuntime } from "../native/projectFile";
import { bytesToBase64, openRenderWindowNative, renderWindowExists, useRenderWindowHost, type RenderSyncState } from "../native/renderWindow";
import { PreviewBadge } from "./PreviewBadge";

type SizeId = "sd" | "hd" | "uhd" | "a4" | "a3" | "a2" | "custom";
const SIZES: Record<Exclude<SizeId, "custom">, () => { width: number; height: number }> = {
  sd: () => ({ width: 960, height: 540 }),
  hd: () => ({ width: 1920, height: 1080 }),
  uhd: () => ({ width: 3840, height: 2160 }),
  a4: () => paperPixels("a4", "landscape", 300),
  a3: () => paperPixels("a3", "landscape", 300),
  a2: () => paperPixels("a2", "landscape", 300),
};

/** `datetime-local`-Wert (Ortszeit) zu einem Zeitpunkt. */
const toInputValue = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const MAX_EDGE = 16000;

export interface RenderDialogViewProps {
  info: RenderSetupInfo;
  job: RenderJobState;
  /** Vorschau des fertigen Bildes (Blob- oder Daten-URL). */
  imageSrc: string | null;
  commands: RenderCommands;
  /** Schliessen (Fenster zu bzw. Overlay zu); ein laufender Auftrag wird vorher mit Rückfrage abgebrochen. */
  onClose: () => void;
  /** Eigenes Fenster statt Overlay: füllt die Fensterfläche, kein ×. */
  windowed?: boolean;
  /** Zähler: jede Erhöhung = Schliessen angefordert (Fenster-Kreuz); während der Arbeit erscheint dann die Rückfrage. */
  closeRequest?: number;
}

export function RenderDialogView({ info, job, imageSrc, commands, onClose, windowed = false, closeRequest = 0 }: RenderDialogViewProps) {
  const [size, setSize] = useState<SizeId>("hd");
  const [dims, setDims] = useState(SIZES.hd());
  const [quality, setQuality] = useState<(typeof RENDER_QUALITY_PRESETS)[number]["id"]>("normal");
  const [when, setWhen] = useState(() => toInputValue(new Date(info.defaultWhenMs)));
  // [213] "live" = aktuelle 3D-Ansicht (beim Start gelesen), sonst die Id einer gespeicherten Kamera.
  const [cameraKey, setCameraKey] = useState("live");
  // [227] Baugrube im Bild ausblenden (Gelände hinterfüllt); das 3D im Modell bleibt wie es ist.
  const [backfilled, setBackfilled] = useState(true);
  // [271][272] Ansicht der aktiven 3D-Ansicht (Umbaufilter, Variantenkombination); übernehmen oder Hauptvarianten/alles.
  const [useView, setUseView] = useState(true);
  const [renoColors, setRenoColors] = useState(false);
  // [215] Renderer: eingebautes Cycles oder Blender.
  const [engine, setEngine] = useState<RenderEngine>("blender");
  const [denoise, setDenoise] = useState(true);
  const [context, setContext] = useState(true);
  // Belichtungskorrektur in EV auf die automatische Belichtung (0 = automatisch).
  const [exposureEv, setExposureEv] = useState(0);
  // Eigene Samples (nur Cycles); null = die der Qualitätsstufe.
  const [samplesCustom, setSamplesCustom] = useState<number | null>(null);
  const [blenderPath, setPath] = useState(info.blenderPath);
  // [208] Ziel-Blatt für „Ins Layout einsetzen" (vorgewählt: das offene Blatt).
  const [layoutTarget, setLayoutTarget] = useState(info.defaultLayoutId);
  const [confirmClose, setConfirmClose] = useState(false);
  const [tick, setTick] = useState(0);

  const { phase, status, fraction, message, lastLine, cyclesStatus, notice } = job;
  const jobKind = job.job;
  const cyclesOk = job.cyclesOk ?? undefined;
  const hostPending = job.hasHost === null;
  const busy = isRenderBusy(job);

  // Vorgabe des Renderers, sobald die Suche nach dem mitgelieferten Cycles fertig ist.
  useEffect(() => {
    if (job.cyclesOk !== null) setEngine(defaultEngine(job.cyclesOk));
  }, [job.cyclesOk]);
  // Blatt und Kamera können im Hauptfenster entstehen/verschwinden: Auswahl gültig halten.
  useEffect(() => {
    if (!info.layouts.some((l) => l.id === layoutTarget)) setLayoutTarget(info.defaultLayoutId);
  }, [info.layouts, info.defaultLayoutId, layoutTarget]);
  useEffect(() => {
    if (cameraKey !== "live" && !info.cameras.some((c) => c.id === cameraKey)) setCameraKey("live");
  }, [info.cameras, cameraKey]);
  // [215] Sekundentakt für die verstrichene Zeit, solange gerechnet wird.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const requestClose = useCallback(() => {
    if (busy) setConfirmClose(true);
    else onClose();
  }, [busy, onClose]);
  // Fenster-Kreuz (Schliessen von aussen): derselbe Weg, mit Rückfrage während der Arbeit.
  const lastCloseRequest = useRef(closeRequest);
  useEffect(() => {
    if (closeRequest === lastCloseRequest.current) return;
    lastCloseRequest.current = closeRequest;
    requestClose();
  }, [closeRequest, requestClose]);
  // Ist die Arbeit zu Ende, braucht es die Rückfrage nicht mehr.
  useEffect(() => {
    if (!busy) setConfirmClose(false);
  }, [busy]);

  // [249] Fokus ins erste Feld, Tab-Falle, Esc (nicht während der Arbeit), Enter im Feld = Starten, Fokus zurück.
  const startRef = useRef<() => void>(() => {});
  const dialogRef = useModalFocus({ onEscape: busy || windowed ? undefined : requestClose, onEnter: () => startRef.current() });
  // Während der Arbeit ist „Starten" gesperrt: der Fokus wandert auf „Abbrechen".
  useEffect(() => {
    if (busy) document.querySelector<HTMLElement>('[data-testid="render-abort"]')?.focus();
  }, [busy]);

  const date = useMemo(() => {
    const d = new Date(when);
    return Number.isFinite(d.getTime()) ? d : null;
  }, [when]);
  const sun = useMemo(() => (date ? sunPosition(info.latLon.lat, info.latLon.lon, date) : null), [info.latLon.lat, info.latLon.lon, date]);

  const pickSize = (id: SizeId) => {
    setSize(id);
    if (id !== "custom") setDims(SIZES[id]());
  };
  const useCycles = engine === "cycles";
  const maxEdge = useCycles ? CYCLES_MAX_EDGE : MAX_EDGE;
  const validDims = dims.width >= 16 && dims.height >= 16 && dims.width <= maxEdge && dims.height <= maxEdge;
  // „Final“ gibt es nur für Blender; mit Cycles gilt dann „Hoch“.
  const qualityId = useCycles && quality === "final" ? "high" : quality;
  const samples = useCycles ? (samplesCustom ?? cyclesSamples(qualityId)) : (RENDER_QUALITY_PRESETS.find((q) => q.id === quality)?.samples ?? 128);
  const canStart = validDims && date !== null && !busy && (!useCycles || (cyclesOk === true && samples >= 1 && samples <= CYCLES_MAX_SAMPLES));
  const qualities = useCycles ? CYCLES_QUALITIES : RENDER_QUALITY_PRESETS;
  const pickCamera = (key: string) => {
    setCameraKey(key);
    const choice = info.cameras.find((c) => c.id === key);
    // Sonnenzeit der Kamera übernehmen (änderbar).
    if (choice?.sunWhenMs !== undefined) setWhen(toInputValue(new Date(choice.sunWhenMs)));
  };
  const view = info.view;
  const viewActive = hasExportView(view.view);
  const request = (): RenderJobRequest => ({
    engine,
    width: dims.width,
    height: dims.height,
    samples,
    denoise,
    whenMs: date!.getTime(),
    cameraKey,
    backfilled,
    context,
    exposureEv,
    useView: viewActive && useView,
    renoColors,
    blenderPath,
  });
  const startCycles = () => {
    if (canStart) commands.start({ ...request(), engine: "cycles" });
  };
  const startBlender = () => {
    if (canStart) commands.start({ ...request(), engine: "blender" });
  };
  const blendJob = (kind: "save" | "open") => {
    if (canStart && job.hasHost) commands.blend(kind, request());
  };
  const saveZip = () => {
    if (canStart) commands.zip(request());
  };
  const placeInLayout = () => commands.placeInLayout(layoutTarget);

  const camLabel =
    cameraKey !== "live"
      ? t("render.camera.saved", { name: info.cameras.find((c) => c.id === cameraKey)?.name ?? "" })
      : info.livePreset
        ? t("render.camera.preset", { name: t(`view3d.${info.livePreset === "right" ? "side" : info.livePreset}` as never) })
        : t("render.camera.view");
  const browserOnly = job.hasHost === false && cyclesOk === false;
  // Warum das eingebaute Cycles nicht wählbar ist: Browser-Build oder Paket ohne Cycles.
  const engineHint = browserOnly ? t("render.engine.cycles.browser") : t("render.engine.cycles.missing");
  const etaMs = useCycles && cyclesStatus?.stage === "render" ? cyclesStatus.etaMs : null;
  // Verstrichene Zeit läuft im Sekundentakt (tick), auch zwischen zwei Samples.
  void tick;
  const shownElapsed = busy ? Date.now() - job.startedAt : job.elapsedMs;
  startRef.current = () => {
    if (phase === "done" || phase === "missing" || hostPending) return;
    if (useCycles) startCycles();
    else if (browserOnly) saveZip();
    else startBlender();
  };
  const layouts = info.layouts;

  const dialog = (
      <div ref={dialogRef} className={`imp-dialog render-dialog${windowed ? " imp-dialog-embedded" : ""}`} role="dialog" aria-modal="true" aria-label={t("render.title")} onClick={windowed ? undefined : (e) => e.stopPropagation()}>
        <header className="imp-head" {...(windowed ? { "data-tauri-drag-region": true } : {})}>
          <span className="imp-head-title">
            {t("render.title")}
            <PreviewBadge />
          </span>
          {!windowed && (
            <button className="imp-close" onClick={requestClose} aria-label={t("export.close")}>
              ×
            </button>
          )}
        </header>
        <div className="imp-body">
          <p className="imp-note">{t("render.intro")}</p>
          {/* Fortschritt oben, damit er sichtbar bleibt, auch wenn die Einstellungen darunter den Dialog füllen. */}
          {busy && (
            <section className="imp-section" data-testid="render-progress">
              <progress max={1} value={phase === "running" && jobKind === "render" ? fraction : undefined} style={{ width: "100%" }} />
              <div className="imp-note" data-testid="render-status">
                {status}
              </div>
              {useCycles && (
                <div className="imp-note" data-testid="render-eta">
                  {etaMs !== null ? t("render.cycles.timeEta", { elapsed: formatDuration(shownElapsed), eta: formatDuration(etaMs) }) : t("render.cycles.time", { elapsed: formatDuration(shownElapsed) })}
                </div>
              )}
              {lastLine && !useCycles && (
                <div className="imp-note" data-testid="render-last-line" style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, opacity: 0.7, overflowWrap: "anywhere" }}>
                  {lastLine}
                </div>
              )}
            </section>
          )}
          {message && (
            <p className="imp-note" role="status" data-testid="render-message">
              {message}
            </p>
          )}
          {notice && !busy && (
            <p className="imp-note" role="status" data-testid="render-notice">
              {notice}
            </p>
          )}
          <p className="imp-note" data-testid="render-camera">
            {camLabel}
          </p>
          {phase !== "done" && (
            <section className="imp-section">
              <div className="imp-section-title">{t("render.engine")}</div>
              <select
                className="imp-select"
                aria-label={t("render.engine")}
                data-testid="render-engine"
                value={engine}
                disabled={busy || cyclesOk === undefined}
                title={cyclesOk === false ? engineHint : undefined}
                onChange={(e) => setEngine(e.target.value as RenderEngine)}
              >
                <option value="cycles" disabled={cyclesOk !== true} title={cyclesOk === false ? engineHint : undefined}>
                  {t("render.engine.cycles")}
                </option>
                <option value="blender">{t("render.engine.blender")}</option>
              </select>
              <div className="imp-note" data-testid="render-engine-hint">
                {cyclesOk === false ? engineHint : useCycles ? t("render.engine.cycles.hint") : t("render.engine.blender.hint")}
              </div>
            </section>
          )}
          {phase !== "done" && info.cameras.length > 0 && (
            <section className="imp-section">
              <div className="imp-section-title">{t("render.camera.title")}</div>
              <select className="imp-select" aria-label={t("render.camera.title")} data-testid="render-camera-select" value={cameraKey} disabled={busy} onChange={(e) => pickCamera(e.target.value)}>
                <option value="live">{t("render.camera.live")}</option>
                {info.cameras.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </section>
          )}

          {phase !== "done" && (
            <>
              <section className="imp-section">
                <div className="imp-section-title">{t("render.size")}</div>
                <select className="imp-select" aria-label={t("render.size")} data-testid="render-size" value={size} disabled={busy} onChange={(e) => pickSize(e.target.value as SizeId)}>
                  {(["sd", "hd", "uhd", "a4", "a3", "a2", "custom"] as SizeId[]).map((id) => (
                    <option key={id} value={id}>
                      {t(`render.size.${id}`)}
                    </option>
                  ))}
                </select>
                <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
                  <label className="imp-field-label">
                    {t("render.width")}{" "}
                    <input className="imp-input imp-input-flush" type="number" min={16} max={maxEdge} style={{ width: 90 }} value={dims.width} disabled={busy} onChange={(e) => { setSize("custom"); setDims({ ...dims, width: Number(e.target.value) }); }} />
                  </label>
                  <label className="imp-field-label">
                    {t("render.height")}{" "}
                    <input className="imp-input imp-input-flush" type="number" min={16} max={maxEdge} style={{ width: 90 }} value={dims.height} disabled={busy} onChange={(e) => { setSize("custom"); setDims({ ...dims, height: Number(e.target.value) }); }} />
                  </label>
                </div>
                {!validDims && (
                  <div className="imp-note" data-testid="render-size-hint">
                    {t("render.size.range", { max: maxEdge })}
                  </div>
                )}
              </section>
              <section className="imp-section">
                <div className="imp-section-title">{t("render.quality")}</div>
                <select className="imp-select" aria-label={t("render.quality")} data-testid="render-quality" value={useCycles && samplesCustom !== null ? "custom" : qualityId}
                  disabled={busy}
                  onChange={(e) => {
                    if (e.target.value === "custom") return;
                    setSamplesCustom(null);
                    setQuality(e.target.value as typeof quality);
                  }}
                >
                  {qualities.map((q) => (
                    <option key={q.id} value={q.id}>
                      {t(`render.quality.${q.id}`)}
                    </option>
                  ))}
                  {useCycles && <option value="custom">{t("render.quality.custom")}</option>}
                </select>
                {useCycles && (
                  <label className="imp-field-label" style={{ display: "block", marginTop: 6 }}>
                    {t("render.samples")}{" "}
                    <input
                      className="imp-input imp-input-flush"
                      type="number"
                      min={1}
                      max={CYCLES_MAX_SAMPLES}
                      style={{ width: 80 }}
                      data-testid="render-samples"
                      value={samples}
                      disabled={busy}
                      onChange={(e) => setSamplesCustom(Number.isFinite(e.target.valueAsNumber) ? Math.round(e.target.valueAsNumber) : 1)}
                    />
                  </label>
                )}
              </section>
              <section className="imp-section">
                <div className="imp-section-title">{t("render.time")}</div>
                <input className="imp-input imp-input-flush" type="datetime-local" aria-label={t("render.time")} data-testid="render-time" value={when} disabled={busy} onChange={(e) => setWhen(e.target.value)} />
                {sun && (
                  <div className="imp-note" data-testid="render-sun">
                    {t("render.sun", { az: sun.azimuth.toFixed(0), el: sun.elevation.toFixed(0) })}
                    {sun.elevation < 1 && <div>{t("render.sun.night")}</div>}
                  </div>
                )}
              </section>
              <section className="imp-section">
                <label className="imp-field-label">
                  <input type="checkbox" data-testid="render-backfilled" checked={backfilled} disabled={busy} onChange={(e) => setBackfilled(e.target.checked)} /> {t("render.backfilled")}
                </label>
                <div className="imp-note">{t("render.backfilled.hint")}</div>
              </section>
              <section className="imp-section" data-testid="render-view">
                <div className="imp-section-title">{t("render.view")}</div>
                {viewActive ? (
                  <>
                    <label className="imp-field-label">
                      <input type="checkbox" data-testid="render-view-use" checked={useView} disabled={busy} onChange={(e) => setUseView(e.target.checked)} /> {t("render.view.use")}
                    </label>
                    <div className="imp-note" data-testid="render-view-summary">
                      {useView
                        ? [view.labels.renovation ? t("render.view.renovation", { name: view.labels.renovation }) : "", view.labels.combination ? t("render.view.combination", { name: view.labels.combination }) : ""].filter(Boolean).join(" · ")
                        : t("render.view.off")}
                    </div>
                  </>
                ) : (
                  <div className="imp-note" data-testid="render-view-summary">
                    {t("render.view.none")}
                  </div>
                )}
                {useCycles && viewActive && useView && !!view.view.renovation && (
                  <>
                    <label className="imp-field-label" style={{ display: "block", marginTop: 4 }}>
                      <input type="checkbox" data-testid="render-reno-colors" checked={renoColors} disabled={busy} onChange={(e) => setRenoColors(e.target.checked)} /> {t("render.view.colors")}
                    </label>
                    <div className="imp-note">{t("render.view.colorsHint")}</div>
                  </>
                )}
              </section>
              {useCycles && (
                <section className="imp-section" data-testid="render-cycles-options">
                  <label className="imp-field-label">
                    <input type="checkbox" data-testid="render-context" checked={context} disabled={busy} onChange={(e) => setContext(e.target.checked)} /> {t("render.cycles.context")}
                  </label>
                  <label className="imp-field-label" style={{ display: "block", marginTop: 4 }}>
                    <input type="checkbox" data-testid="render-denoise" checked={denoise} disabled={busy} onChange={(e) => setDenoise(e.target.checked)} /> {t("render.cycles.denoise")}
                  </label>
                  <label className="imp-field-label" style={{ display: "block", marginTop: 4 }}>
                    {t("render.cycles.exposure")}{" "}
                    <input
                      className="imp-input imp-input-flush"
                      type="number"
                      min={-5}
                      max={5}
                      step={0.5}
                      style={{ width: 70 }}
                      data-testid="render-exposure"
                      value={exposureEv}
                      disabled={busy}
                      onChange={(e) => setExposureEv(Number.isFinite(e.target.valueAsNumber) ? Math.max(-5, Math.min(5, e.target.valueAsNumber)) : 0)}
                    />
                  </label>
                </section>
              )}
              {!browserOnly && !useCycles && (
                <section className="imp-section">
                  <div className="imp-section-title">{t("render.blenderPath")}</div>
                  <input
                    className="imp-input imp-input-flush"
                    type="text"
                    aria-label={t("render.blenderPath")}
                    data-testid="render-blender-path"
                    style={{ width: "100%" }}
                    placeholder={t("render.blenderPath.placeholder")}
                    value={blenderPath}
                    disabled={busy}
                    onChange={(e) => {
                      setPath(e.target.value);
                    }}
                  />
                </section>
              )}
            </>
          )}

          {browserOnly && phase !== "done" && <p className="imp-note">{t("render.browser.text")}</p>}
          {!browserOnly && !useCycles && phase !== "done" && !busy && <p className="imp-note" data-testid="render-blend-hint">{t("render.blend.hint")}</p>}

          {phase === "missing" && (
            <section className="imp-section" data-testid="render-missing">
              <div className="imp-section-title">{t("render.missing.title")}</div>
              <p className="imp-note">{t("render.missing.text")}</p>
              <button className="imp-btn" onClick={() => void openExternalUrl(BLENDER_DOWNLOAD_URL)}>
                {t("render.missing.download")}
              </button>
            </section>
          )}

          {phase === "done" && imageSrc && (
            <section className="imp-section" data-testid="render-result">
              <div className="imp-note">{useCycles ? t("render.cycles.done", { width: job.dims.width, height: job.dims.height, time: formatDuration(job.elapsedMs) }) : t("render.done", { width: job.dims.width, height: job.dims.height })}</div>
              <img src={imageSrc} alt={t("render.title")} style={{ maxWidth: "100%", maxHeight: 360, display: "block", marginTop: 6 }} />
              {layouts.length > 0 && (
                <label className="imp-field-label" style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
                  <span>{t("render.toLayout.target")}</span>
                  <select className="imp-select" data-testid="render-layout-target" value={layoutTarget} onChange={(e) => setLayoutTarget(e.target.value)}>
                    {layouts.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </section>
          )}

        </div>
        <footer className="imp-foot">
          {busy ? (
            <button className="imp-btn" data-testid="render-abort" onClick={() => commands.abort()}>
              {t("render.abort")}
            </button>
          ) : (
            <button className="imp-btn" onClick={requestClose}>
              {t("export.close")}
            </button>
          )}
          {phase === "done" ? (
            <>
              <button className="imp-btn" data-testid="render-again" onClick={() => commands.reset()}>
                {t("render.again")}
              </button>
              <button
                className="imp-btn"
                data-testid="render-to-layout"
                disabled={layouts.length === 0}
                title={layouts.length === 0 ? t("render.toLayout.none") : undefined}
                onClick={placeInLayout}
              >
                {t("render.toLayout")}
              </button>
              <button className="imp-btn primary" data-testid="render-save" data-autofocus onClick={() => commands.savePng()}>
                {t("render.save")}
              </button>
            </>
          ) : browserOnly ? (
            <button className="imp-btn primary" data-testid="render-zip" disabled={!canStart} onClick={saveZip}>
              {t("render.zip.save")}
            </button>
          ) : useCycles ? (
            <button className="imp-btn primary" data-testid="render-start" disabled={!canStart} onClick={startCycles}>
              {t("render.start")}
            </button>
          ) : (
            <>
              <button className="imp-btn" data-testid="render-blend-save" disabled={!canStart || hostPending} title={t("render.blend.hint")} onClick={() => blendJob("save")}>
                {t("render.blend.save")}
              </button>
              <button className="imp-btn" data-testid="render-blend-open" disabled={!canStart || hostPending} title={t("render.blend.hint")} onClick={() => blendJob("open")}>
                {t("render.blend.open")}
              </button>
              <button className="imp-btn primary" data-testid="render-start" disabled={!canStart || hostPending} onClick={startBlender}>
                {t("render.start")}
              </button>
            </>
          )}
        </footer>
      </div>
  );

  const confirm = confirmClose && (
    <div className="imp-overlay" style={{ zIndex: 1300 }} role="presentation">
      <div className="imp-dialog" role="alertdialog" aria-modal="true" aria-label={t("render.close.title")} data-testid="render-close-confirm" style={{ width: "min(380px, 92vw)" }}>
        <header className="imp-head">
          <span className="imp-head-title">{t("render.close.title")}</span>
        </header>
        <div className="imp-body">
          <p className="imp-note">{t("render.close.text")}</p>
        </div>
        <footer className="imp-foot">
          <button className="imp-btn" data-testid="render-close-keep" data-autofocus onClick={() => setConfirmClose(false)}>
            {t("render.close.keep")}
          </button>
          <button
            className="imp-btn primary"
            data-testid="render-close-abort"
            onClick={() => {
              setConfirmClose(false);
              commands.abort();
              onClose();
            }}
          >
            {t("render.close.abort")}
          </button>
        </footer>
      </div>
    </div>
  );

  if (windowed) {
    return (
      <>
        {dialog}
        {confirm}
      </>
    );
  }
  return (
    <>
      <div className="imp-overlay" onClick={() => !busy && requestClose()}>
        {dialog}
      </div>
      {confirm}
    </>
  );
}

/** Fragt, ob das Fenster noch offen ist. */
type Probe = { (): Promise<boolean> };
const alwaysThere: Probe = async () => true;

/**
 * Vorgaben für die Einstellungen aus dem Projekt: gebaut beim Öffnen und neu bei Änderungen an Projekt, aktiver Ebene und 3D-Ansicht
 * (gebündelt, inhaltlich gleiche Vorgaben bleiben dieselbe Referenz). `stillOpen` prüft vor jedem Neubau, ob das Fenster noch da ist.
 */
function useRenderSetupInfo(active: boolean, stillOpen: Probe, onGone: () => void): RenderSetupInfo | null {
  const [info, setInfo] = useState<RenderSetupInfo | null>(null);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const apply = () => {
      const next = buildRenderSetupInfo();
      setInfo((prev) => (sameRenderSetupInfo(prev, next) ? prev : next));
    };
    apply();
    let last = getAppState();
    const off = subscribeStore(() => {
      const s = getAppState();
      const changed = s.project !== last.project || s.activeLevelId !== last.activeLevelId || s.view3d !== last.view3d;
      last = s;
      if (!changed || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void stillOpen().then((open) => {
          if (disposed) return;
          if (open) apply();
          else goneRef.current();
        });
      }, 150);
    });
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      off();
    };
  }, [active, stillOpen]);
  return info;
}

/**
 * Hauptfenster-Seite des Renderings (von `AppDialogs` immer gemountet): registriert den Öffner (Befehl `rendering`, Menü),
 * hält unter Tauri das Rendering-Fenster synchron und führt dessen Befehle aus ([277]); im Browser/Electron öffnet er den Overlay-Dialog.
 */
export const RenderDialogHost = memo(function RenderDialogHost() {
  const native = isTauriRuntime();
  const [open, setOpen] = useState(false);
  const job = useRenderJob();
  const info = useRenderSetupInfo(open, native ? renderWindowExists : alwaysThere, () => setOpen(false));

  // Browser: Vorschau als Blob-URL (freigeben, wenn das Bild wechselt oder der Dialog schliesst).
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    const png = native || !open || !job.hasImage ? null : renderJob.getImage();
    if (!png) {
      setImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [native, open, job.hasImage, job.imageSeq]);
  // Tauri: Vorschau als Base64 an das Fenster (nur beim Wechsel des Bildes).
  const imageB64 = useMemo(() => {
    const png = !native || !open || !job.hasImage ? null : renderJob.getImage();
    return png ? bytesToBase64(png) : null;
  }, [native, open, job.hasImage, job.imageSeq]);
  const syncState = useMemo<RenderSyncState>(() => ({ info, job, image: imageB64 }), [info, job, imageB64]);
  useRenderWindowHost(syncState, renderCommands);

  useEffect(() => {
    setRenderDialogOpener(() => {
      void (async () => {
        // Ein schon offenes Fenster behält seinen Stand (Bild, Einstellungen) und kommt nur nach vorne.
        const fresh = native ? !(await renderWindowExists()) : true;
        if (fresh) {
          renderJob.reset();
          renderJob.detectEnvironment();
        }
        setOpen(true);
        if (native) await openRenderWindowNative();
      })();
    });
    return () => setRenderDialogOpener(null);
  }, [native]);

  const close = useCallback(() => {
    setOpen(false);
    renderJob.reset();
  }, []);

  if (native || !open || !info) return null;
  return <RenderDialogView info={info} job={job} imageSrc={imageUrl} commands={renderCommands} onClose={close} />;
});
