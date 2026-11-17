// [211] Dialog „Rendering …": Renderer (eingebautes Cycles [215] oder installiertes Blender), Bildgrösse, Qualität, Sonne
// (Datum/Uhrzeit, vorbelegt aus der Sonnenstudie), Kamera → startet den Renderer als eigenen Prozess (Tauri/Electron), zeigt den
// Fortschritt („Sample x von y“, verstrichene Zeit, Restzeit), bietet Abbrechen und nach dem Lauf das Bild (Vorschau, Speichern,
// Ins Layout einsetzen). Cycles ist die Vorgabe, wenn es mitgeliefert ist (`cyclesAvailable`); im Browser ist die Option
// ausgegraut und es gibt stattdessen das Blender-Paket als ZIP. Cycles-Ablauf ohne Oberfläche: `state/cyclesAction.ts`.
// Registriert sich selbst als Öffner (`state/renderDialogHook`); Befehl `rendering`, Menüpunkt Ansicht → „Rendering …“.
// Overlay wie `PresentationDialog` (kein window.prompt).

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { useModalFocus } from "./modalFocus";
import {
  BLENDER_DOWNLOAD_URL,
  BlenderMissingError,
  CyclesCancelled,
  CyclesMissingError,
  RENDER_QUALITY_PRESETS,
  RenderCancelled,
  defaultRenderTime,
  paperPixels,
  projectRenderCameras,
  renderSun,
  type BlenderHost,
  type RenderCameraChoice,
  type RenderCameraSpec,
  exportProjectName,
} from "../core";
import { getState } from "../state/appStore";
import { setRenderDialogOpener } from "../state/renderDialogHook";
import { getBlenderPath, setBlenderPath } from "../state/blenderSettings";
import { buildPackage, currentRenderCamera, openInBlender, packageAsZip, renderHost, renderWithBlender, saveBlendWithBlender } from "../state/renderAction";
import { openExternalUrl } from "../native/blender";
import { cyclesAvailable } from "../native/cyclesRuntime";
import {
  CYCLES_MAX_EDGE,
  CYCLES_MAX_SAMPLES,
  CYCLES_QUALITIES,
  CyclesRenderError,
  cyclesSamples,
  defaultEngine,
  formatDuration,
  renderWithCycles,
  type CyclesStatus,
  type RenderEngine,
} from "../state/cyclesAction";
import { saveBinaryFile } from "../native/saveFile";
import { runWithAnonymityGate } from "../state/anonymityGate";
import { defaultTargetLayout, placeImageOnLayout } from "../state/layoutImageActions";
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

/** [228] Was gerade läuft: Bild rechnen, .blend speichern, in Blender öffnen. */
type Job = "render" | "save" | "open";

type Phase = "setup" | "preparing" | "running" | "done" | "error" | "missing";

/** `datetime-local`-Wert (Ortszeit) zu einem Zeitpunkt. */
const toInputValue = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const MAX_EDGE = 16000;

export const RenderDialogHost = memo(function RenderDialogHost() {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<SizeId>("hd");
  const [dims, setDims] = useState(SIZES.hd());
  const [quality, setQuality] = useState<(typeof RENDER_QUALITY_PRESETS)[number]["id"]>("normal");
  const [when, setWhen] = useState("");
  const [camera, setCamera] = useState<RenderCameraSpec>({ preset: "iso" });
  // [213] "live" = aktuelle 3D-Ansicht, sonst die Id einer gespeicherten Kamera.
  const [cameraKey, setCameraKey] = useState("live");
  const [cameras, setCameras] = useState<RenderCameraChoice[]>([]);
  // [227] Baugrube im Bild ausblenden (Gelände hinterfüllt); das 3D im Modell bleibt wie es ist.
  const [backfilled, setBackfilled] = useState(true);
  // [215] Renderer: eingebautes Cycles oder Blender; `cyclesOk` undefined, bis die Suche nach dem mitgelieferten Programm fertig ist.
  const [engine, setEngine] = useState<RenderEngine>("blender");
  const [cyclesOk, setCyclesOk] = useState<boolean | undefined>(undefined);
  const [denoise, setDenoise] = useState(true);
  const [context, setContext] = useState(true);
  // Belichtungskorrektur in EV auf die automatische Belichtung (0 = automatisch).
  const [exposureEv, setExposureEv] = useState(0);
  // Eigene Samples (nur Cycles); null = die der Qualitätsstufe.
  const [samplesCustom, setSamplesCustom] = useState<number | null>(null);
  const [cyclesStatus, setCyclesStatus] = useState<CyclesStatus | null>(null);
  const startedAt = useRef(0);
  const [tick, setTick] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [blenderPath, setPath] = useState("");
  // Letzte Ausgabezeile von Blender (zeigt z. B. das erstmalige Übersetzen der Metal-Kernel, das Minuten dauern kann).
  const [lastLine, setLastLine] = useState("");
  const [host, setHost] = useState<BlenderHost | null | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>("setup");
  const [job, setJob] = useState<Job>("render");
  const [status, setStatus] = useState("");
  const [fraction, setFraction] = useState(0);
  const [message, setMessage] = useState("");
  const [png, setPng] = useState<Uint8Array | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  // [208] Ziel-Blatt für „Ins Layout einsetzen" (vorgewählt: das offene Blatt).
  const [layoutTarget, setLayoutTarget] = useState("");

  useEffect(() => {
    setRenderDialogOpener(() => {
      const st = getState();
      setWhen(toInputValue(defaultRenderTime(st.project)));
      setCamera(currentRenderCamera());
      setCameraKey("live");
      setCameras(projectRenderCameras(st.project));
      setPath(getBlenderPath());
      setPhase("setup");
      setMessage("");
      setPng(null);
      setHost(undefined);
      setCyclesOk(undefined);
      setCyclesStatus(null);
      setSamplesCustom(null);
      setLayoutTarget(defaultTargetLayout(st.project, st.activeLevelId)?.id ?? "");
      setOpen(true);
      void renderHost().then(setHost, () => setHost(null));
      void cyclesAvailable().then((ok) => {
        setCyclesOk(ok);
        setEngine(defaultEngine(ok));
      });
    });
    return () => setRenderDialogOpener(null);
  }, []);

  // Bildvorschau als Blob-URL (frei geben, wenn das Bild wechselt oder der Dialog schliesst).
  useEffect(() => {
    if (!png) {
      setImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [png]);

  const busy = phase === "preparing" || phase === "running";
  // [215] Sekundentakt für die verstrichene Zeit, solange gerechnet wird.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [busy]);
  const close = useCallback(() => {
    abort.current?.abort();
    setOpen(false);
    setPng(null);
  }, []);

  // [249] Fokus ins erste Feld, Tab-Falle, Esc (nicht während der Arbeit), Enter im Feld = Starten, Fokus zurück.
  const startRef = useRef<() => void>(() => {});
  const dialogRef = useModalFocus({ onEscape: busy ? undefined : close, onEnter: () => startRef.current() });
  // Während der Arbeit ist „Starten" gesperrt: der Fokus wandert auf „Abbrechen".
  useEffect(() => {
    if (busy) document.querySelector<HTMLElement>('[data-testid="render-abort"]')?.focus();
  }, [busy]);

  const date = useMemo(() => {
    const d = new Date(when);
    return Number.isFinite(d.getTime()) ? d : null;
  }, [when]);
  const sun = useMemo(() => (open && date ? renderSun(getState().project, date) : null), [open, date]);

  if (!open) return null;

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
    const choice = cameras.find((c) => c.id === key);
    if (!choice) {
      setCamera(currentRenderCamera());
      return;
    }
    setCamera(choice.camera);
    // Sonnenzeit der Kamera übernehmen (änderbar).
    if (choice.sunWhen) setWhen(toInputValue(choice.sunWhen));
  };
  const request = () => ({ width: dims.width, height: dims.height, samples, when: date!, camera, backfilled });
  const stageText = (e: { stage: string; done: number; total: number }) =>
    e.stage === "render"
      ? t("render.stage.render", { done: e.done, total: e.total })
      : e.stage === "done"
        ? t("render.stage.done")
        : e.stage === "import" || e.stage === "materials" || e.stage === "camera" || e.stage === "sky" || e.stage === "organize" || e.stage === "save"
          ? t(`render.stage.${e.stage}`)
          : e.stage;
  const cyclesStageText = (s: CyclesStatus): string =>
    s.stage === "scene" ? t("render.working") : s.stage === "start" ? t("render.cycles.starting") : s.stage === "render" ? t("render.stage.render", { done: s.sample, total: s.samples }) : s.stage === "tonemap" ? t("render.cycles.tonemap") : t("render.stage.done");
  const failWith = (err: unknown) => {
    if (err instanceof RenderCancelled || err instanceof CyclesCancelled) {
      setPhase("setup");
      setMessage(t("render.cancelled"));
    } else if (err instanceof BlenderMissingError) {
      setPhase("missing");
    } else if (err instanceof CyclesMissingError || err instanceof CyclesRenderError) {
      // Programm fehlt, Start gescheitert, Absturz, kein Bild: klare Meldung im Dialog und als Hinweis.
      const text =
        err instanceof CyclesRenderError
          ? t(`render.cycles.error.${err.kind}`, { code: err.code, detail: err.detail })
          : t("render.cycles.error.missing");
      setPhase("error");
      setMessage(text);
      getState().notify(text, "error");
    } else {
      setPhase("error");
      setMessage(t("render.error", { message: err instanceof Error ? err.message : String(err) }));
    }
  };

  const start = async () => {
    if (!canStart) return;
    const st = getState();
    setJob("render");
    setPhase("preparing");
    setStatus(t("render.working"));
    setFraction(0);
    setMessage("");
    setPng(null);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const pkg = await buildPackage(st.project, request());
      if (pkg.missingTextures.length > 0) st.notify(t("render.missingTextures", { n: pkg.missingTextures.length }), "warning");
      if (!host) throw new Error("kein Gastgeber");
      setPhase("running");
      setLastLine("");
      const res = await renderWithBlender(host, pkg, {
        signal: ac.signal,
        onLine: (l) => {
          const v = l.trim();
          if (v) setLastLine(v.length > 160 ? `${v.slice(0, 157)}…` : v);
        },
        onProgress: (e) => {
          setFraction(e.fraction);
          setStatus(stageText(e));
        },
      });
      setPng(res.png);
      setPhase("done");
    } catch (err) {
      failWith(err);
    } finally {
      abort.current = null;
    }
  };

  // [215] Bild mit dem eingebauten Cycles: Szene aus dem Kern, Programm mit Fortschritt/Abbruch, EXR → Tonwert → PNG.
  const startCycles = async () => {
    if (!canStart) return;
    const st = getState();
    setJob("render");
    setPhase("preparing");
    setStatus(t("render.working"));
    setFraction(0);
    setMessage("");
    setPng(null);
    setCyclesStatus(null);
    setElapsedMs(0);
    startedAt.current = Date.now();
    const ac = new AbortController();
    abort.current = ac;
    try {
      const res = await renderWithCycles(
        st.project,
        { width: dims.width, height: dims.height, samples, denoise, when: date!, camera, backfilled, context, extraEv: exposureEv },
        {
          signal: ac.signal,
          onMissingTextures: (n) => st.notify(t("render.missingTextures", { n }), "warning"),
          onStatus: (s) => {
            setCyclesStatus(s);
            setFraction(s.fraction);
            setStatus(cyclesStageText(s));
            if (s.stage !== "scene") setPhase("running");
          },
        },
      );
      setElapsedMs(res.millis);
      setPng(res.png);
      setPhase("done");
    } catch (err) {
      failWith(err);
    } finally {
      abort.current = null;
    }
  };

  // [228] Statt eines Bildes die Szene als Blender-Datei: speichern (nativer Dialog) oder direkt in Blender öffnen.
  const blendJob = async (kind: "save" | "open") => {
    if (!canStart || !host) return;
    const st = getState();
    setJob(kind);
    setPhase("preparing");
    setStatus(t("render.working"));
    setFraction(0);
    setMessage("");
    setPng(null);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const pkg = await buildPackage(st.project, { ...request(), mode: "save" });
      if (pkg.missingTextures.length > 0) st.notify(t("render.missingTextures", { n: pkg.missingTextures.length }), "warning");
      setPhase("running");
      setLastLine("");
      const hooks = {
        signal: ac.signal,
        onLine: (l: string) => {
          const v = l.trim();
          if (v) setLastLine(v.length > 160 ? `${v.slice(0, 157)}…` : v);
        },
        onProgress: (e: { stage: string; done: number; total: number }) => setStatus(stageText(e)),
      };
      if (kind === "open") {
        await openInBlender(host, pkg, hooks);
        st.notify(t("render.blend.opened"), "info");
      } else {
        const res = await saveBlendWithBlender(host, pkg, hooks);
        const name = `${(exportProjectName(st.project) || "projekt").replace(/[^\w.-]+/g, "_")}.blend`;
        runWithAnonymityGate(st.project, [name], async () => {
          if (await saveBinaryFile(res.blend, name, "application/octet-stream")) st.notify(t("render.blend.saved"), "info");
        });
      }
      setPhase("setup");
    } catch (err) {
      failWith(err);
    } finally {
      abort.current = null;
    }
  };

  const saveZip = async () => {
    if (!canStart) return;
    const st = getState();
    setPhase("preparing");
    setStatus(t("render.working"));
    try {
      const pkg = await buildPackage(st.project, request());
      const bytes = await packageAsZip(pkg);
      const name = `${(exportProjectName(st.project) || "projekt").replace(/[^\w.-]+/g, "_")}-render.zip`;
      runWithAnonymityGate(st.project, [name], async () => {
        if (await saveBinaryFile(bytes, name, "application/zip")) st.notify(t("render.zip.saved"), "info");
      });
      setPhase("setup");
    } catch (err) {
      setPhase("error");
      setMessage(t("render.error", { message: err instanceof Error ? err.message : String(err) }));
    }
  };

  // [208] Rendering als Bild aufs gewählte Blatt (mittig, Seitenverhältnis gehalten, volle Auflösung).
  const placeInLayout = () => {
    if (!png) return;
    const st = getState();
    const layout = (st.project.layouts ?? []).find((l) => l.id === layoutTarget);
    const name = `${(exportProjectName(st.project) || "projekt").replace(/[^\w.-]+/g, "_")}-rendering.png`;
    if (layout && placeImageOnLayout(layout.id, name, png)) st.notify(t("render.toLayout.done", { name: layout.name }), "info");
    else st.notify(t("render.toLayout.none"), "warning");
  };

  const savePng = async () => {
    if (!png) return;
    const st = getState();
    const name = `${(exportProjectName(st.project) || "projekt").replace(/[^\w.-]+/g, "_")}-rendering.png`;
    runWithAnonymityGate(st.project, [name], async () => {
      if (await saveBinaryFile(png, name, "image/png")) st.notify(t("render.saved"), "info");
    });
  };

  const camLabel = cameraKey !== "live" ? t("render.camera.saved", { name: cameras.find((c) => c.id === cameraKey)?.name ?? "" }) : "preset" in camera ? t("render.camera.preset", { name: t(`view3d.${camera.preset === "right" ? "side" : camera.preset}` as never) }) : t("render.camera.view");
  const browserOnly = host === null && cyclesOk === false;
  // Warum das eingebaute Cycles nicht wählbar ist: Browser-Build oder Paket ohne Cycles.
  const engineHint = browserOnly ? t("render.engine.cycles.browser") : t("render.engine.cycles.missing");
  const etaMs = useCycles && cyclesStatus?.stage === "render" ? cyclesStatus.etaMs : null;
  // Verstrichene Zeit läuft im Sekundentakt (tick), auch zwischen zwei Samples.
  void tick;
  const shownElapsed = busy ? Date.now() - startedAt.current : elapsedMs;
  startRef.current = () => {
    if (phase === "done" || phase === "missing" || host === undefined) return;
    if (useCycles) void startCycles();
    else if (browserOnly) void saveZip();
    else void start();
  };

  return (
    <div className="imp-overlay" onClick={() => !busy && close()}>
      <div ref={dialogRef} className="imp-dialog render-dialog" role="dialog" aria-modal="true" aria-label={t("render.title")} onClick={(e) => e.stopPropagation()}>
        <header className="imp-head">
          <span className="imp-head-title">
            {t("render.title")}
            <PreviewBadge />
          </span>
          <button className="imp-close" onClick={close} aria-label={t("export.close")} disabled={busy}>
            ×
          </button>
        </header>
        <div className="imp-body">
          <p className="imp-note">{t("render.intro")}</p>
          {/* Fortschritt oben, damit er sichtbar bleibt, auch wenn die Einstellungen darunter den Dialog füllen. */}
          {busy && (
            <section className="imp-section" data-testid="render-progress">
              <progress max={1} value={phase === "running" && job === "render" ? fraction : undefined} style={{ width: "100%" }} />
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
          {phase !== "done" && cameras.length > 0 && (
            <section className="imp-section">
              <div className="imp-section-title">{t("render.camera.title")}</div>
              <select className="imp-select" aria-label={t("render.camera.title")} data-testid="render-camera-select" value={cameraKey} disabled={busy} onChange={(e) => pickCamera(e.target.value)}>
                <option value="live">{t("render.camera.live")}</option>
                {cameras.map((c) => (
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
                      setBlenderPath(e.target.value);
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

          {phase === "done" && imageUrl && (
            <section className="imp-section" data-testid="render-result">
              <div className="imp-note">{useCycles ? t("render.cycles.done", { width: dims.width, height: dims.height, time: formatDuration(elapsedMs) }) : t("render.done", { width: dims.width, height: dims.height })}</div>
              <img src={imageUrl} alt={t("render.title")} style={{ maxWidth: "100%", maxHeight: 360, display: "block", marginTop: 6 }} />
              {(getState().project.layouts ?? []).length > 0 && (
                <label className="imp-field-label" style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
                  <span>{t("render.toLayout.target")}</span>
                  <select className="imp-select" data-testid="render-layout-target" value={layoutTarget} onChange={(e) => setLayoutTarget(e.target.value)}>
                    {(getState().project.layouts ?? []).map((l) => (
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
          {busy && phase === "running" ? (
            <button className="imp-btn" data-testid="render-abort" onClick={() => abort.current?.abort()}>
              {t("render.abort")}
            </button>
          ) : (
            <button className="imp-btn" onClick={close} disabled={busy}>
              {t("export.close")}
            </button>
          )}
          {phase === "done" ? (
            <>
              <button className="imp-btn" onClick={() => setPhase("setup")}>
                {t("render.again")}
              </button>
              <button
                className="imp-btn"
                data-testid="render-to-layout"
                disabled={(getState().project.layouts ?? []).length === 0}
                title={(getState().project.layouts ?? []).length === 0 ? t("render.toLayout.none") : undefined}
                onClick={placeInLayout}
              >
                {t("render.toLayout")}
              </button>
              <button className="imp-btn primary" data-testid="render-save" data-autofocus onClick={() => void savePng()}>
                {t("render.save")}
              </button>
            </>
          ) : browserOnly ? (
            <button className="imp-btn primary" data-testid="render-zip" disabled={!canStart} onClick={() => void saveZip()}>
              {t("render.zip.save")}
            </button>
          ) : useCycles ? (
            <button className="imp-btn primary" data-testid="render-start" disabled={!canStart} onClick={() => void startCycles()}>
              {t("render.start")}
            </button>
          ) : (
            <>
              <button className="imp-btn" data-testid="render-blend-save" disabled={!canStart || host === undefined} title={t("render.blend.hint")} onClick={() => void blendJob("save")}>
                {t("render.blend.save")}
              </button>
              <button className="imp-btn" data-testid="render-blend-open" disabled={!canStart || host === undefined} title={t("render.blend.hint")} onClick={() => void blendJob("open")}>
                {t("render.blend.open")}
              </button>
              <button className="imp-btn primary" data-testid="render-start" disabled={!canStart || host === undefined} onClick={() => void start()}>
                {t("render.start")}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
});
