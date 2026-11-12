// [211] Dialog „Rendering mit Blender": Bildgrösse, Qualität, Sonne (Datum/Uhrzeit, vorbelegt aus der
// Sonnenstudie), Blender-Pfad → startet Blender als eigenen Prozess (Tauri/Electron), zeigt den Fortschritt
// („Sample x von y"), bietet Abbrechen und nach dem Lauf das Bild (Vorschau, Speichern). Im Browser gibt es
// stattdessen das Paket als ZIP. Registriert sich selbst als Öffner (`state/renderDialogHook`); Befehl
// `rendering`, Menüpunkt Ansicht → „Rendering mit Blender …". Overlay wie `PresentationDialog` (kein window.prompt).

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import {
  BLENDER_DOWNLOAD_URL,
  BlenderMissingError,
  RENDER_QUALITY_PRESETS,
  RenderCancelled,
  defaultRenderTime,
  paperPixels,
  renderSun,
  type BlenderHost,
  type RenderCameraSpec,
} from "../core";
import { getState } from "../state/appStore";
import { setRenderDialogOpener } from "../state/renderDialogHook";
import { getBlenderPath, setBlenderPath } from "../state/blenderSettings";
import { buildPackage, currentRenderCamera, packageAsZip, renderHost, renderWithBlender } from "../state/renderAction";
import { openExternalUrl } from "../native/blender";
import { saveBinaryFile } from "../native/saveFile";

type SizeId = "hd" | "uhd" | "a4" | "a3" | "a2" | "custom";
const SIZES: Record<Exclude<SizeId, "custom">, () => { width: number; height: number }> = {
  hd: () => ({ width: 1920, height: 1080 }),
  uhd: () => ({ width: 3840, height: 2160 }),
  a4: () => paperPixels("a4", "landscape", 300),
  a3: () => paperPixels("a3", "landscape", 300),
  a2: () => paperPixels("a2", "landscape", 300),
};

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
  const [blenderPath, setPath] = useState("");
  const [host, setHost] = useState<BlenderHost | null | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>("setup");
  const [status, setStatus] = useState("");
  const [fraction, setFraction] = useState(0);
  const [message, setMessage] = useState("");
  const [png, setPng] = useState<Uint8Array | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    setRenderDialogOpener(() => {
      const st = getState();
      setWhen(toInputValue(defaultRenderTime(st.project)));
      setCamera(currentRenderCamera());
      setPath(getBlenderPath());
      setPhase("setup");
      setMessage("");
      setPng(null);
      setHost(undefined);
      setOpen(true);
      void renderHost().then(setHost, () => setHost(null));
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
  const close = useCallback(() => {
    abort.current?.abort();
    setOpen(false);
    setPng(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, close]);

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
  const validDims = dims.width >= 16 && dims.height >= 16 && dims.width <= MAX_EDGE && dims.height <= MAX_EDGE;
  const canStart = validDims && date !== null && !busy;
  const samples = RENDER_QUALITY_PRESETS.find((q) => q.id === quality)?.samples ?? 128;
  const request = () => ({ width: dims.width, height: dims.height, samples, when: date!, camera });

  const start = async () => {
    if (!canStart) return;
    const st = getState();
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
      const res = await renderWithBlender(host, pkg, {
        signal: ac.signal,
        onProgress: (e) => {
          setFraction(e.fraction);
          setStatus(
            e.stage === "render"
              ? t("render.stage.render", { done: e.done, total: e.total })
              : e.stage === "done"
                ? t("render.stage.done")
                : e.stage === "import" || e.stage === "materials" || e.stage === "camera" || e.stage === "sky"
                  ? t(`render.stage.${e.stage}`)
                  : e.stage,
          );
        },
      });
      setPng(res.png);
      setPhase("done");
    } catch (err) {
      if (err instanceof RenderCancelled) {
        setPhase("setup");
        setMessage(t("render.cancelled"));
      } else if (err instanceof BlenderMissingError) {
        setPhase("missing");
      } else {
        setPhase("error");
        setMessage(t("render.error", { message: err instanceof Error ? err.message : String(err) }));
      }
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
      const name = `${(st.project.name || "projekt").replace(/[^\w.-]+/g, "_")}-render.zip`;
      if (await saveBinaryFile(bytes, name, "application/zip")) st.notify(t("render.zip.saved"), "info");
      setPhase("setup");
    } catch (err) {
      setPhase("error");
      setMessage(t("render.error", { message: err instanceof Error ? err.message : String(err) }));
    }
  };

  const savePng = async () => {
    if (!png) return;
    const st = getState();
    const name = `${(st.project.name || "projekt").replace(/[^\w.-]+/g, "_")}-rendering.png`;
    if (await saveBinaryFile(png, name, "image/png")) st.notify(t("render.saved"), "info");
  };

  const camLabel = "preset" in camera ? t("render.camera.preset", { name: t(`view3d.${camera.preset === "right" ? "side" : camera.preset}` as never) }) : t("render.camera.view");
  const browserOnly = host === null;

  return (
    <div className="imp-overlay" onClick={() => !busy && close()}>
      <div className="imp-dialog render-dialog" role="dialog" aria-modal="true" aria-label={t("render.title")} onClick={(e) => e.stopPropagation()}>
        <header className="imp-head">
          <span className="imp-head-title">{t("render.title")}</span>
          <button className="imp-close" onClick={close} aria-label={t("export.close")} disabled={busy}>
            ×
          </button>
        </header>
        <div className="imp-body">
          <p className="imp-note">{t("render.intro")}</p>
          <p className="imp-note" data-testid="render-camera">
            {camLabel}
          </p>

          {phase !== "done" && (
            <>
              <section className="imp-section">
                <div className="imp-section-title">{t("render.size")}</div>
                <select className="imp-select" data-testid="render-size" value={size} disabled={busy} onChange={(e) => pickSize(e.target.value as SizeId)}>
                  {(["hd", "uhd", "a4", "a3", "a2", "custom"] as SizeId[]).map((id) => (
                    <option key={id} value={id}>
                      {t(`render.size.${id}`)}
                    </option>
                  ))}
                </select>
                <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
                  <label>
                    {t("render.width")}{" "}
                    <input className="imp-input" type="number" min={16} max={MAX_EDGE} style={{ width: 90 }} value={dims.width} disabled={busy} onChange={(e) => { setSize("custom"); setDims({ ...dims, width: Number(e.target.value) }); }} />
                  </label>
                  <label>
                    {t("render.height")}{" "}
                    <input className="imp-input" type="number" min={16} max={MAX_EDGE} style={{ width: 90 }} value={dims.height} disabled={busy} onChange={(e) => { setSize("custom"); setDims({ ...dims, height: Number(e.target.value) }); }} />
                  </label>
                </div>
              </section>
              <section className="imp-section">
                <div className="imp-section-title">{t("render.quality")}</div>
                <select className="imp-select" data-testid="render-quality" value={quality} disabled={busy} onChange={(e) => setQuality(e.target.value as typeof quality)}>
                  {RENDER_QUALITY_PRESETS.map((q) => (
                    <option key={q.id} value={q.id}>
                      {t(`render.quality.${q.id}`)}
                    </option>
                  ))}
                </select>
              </section>
              <section className="imp-section">
                <div className="imp-section-title">{t("render.time")}</div>
                <input className="imp-input" type="datetime-local" data-testid="render-time" value={when} disabled={busy} onChange={(e) => setWhen(e.target.value)} />
                {sun && (
                  <div className="imp-note" data-testid="render-sun">
                    {t("render.sun", { az: sun.azimuth.toFixed(0), el: sun.elevation.toFixed(0) })}
                    {sun.elevation < 1 && <div>{t("render.sun.night")}</div>}
                  </div>
                )}
              </section>
              {!browserOnly && (
                <section className="imp-section">
                  <div className="imp-section-title">{t("render.blenderPath")}</div>
                  <input
                    className="imp-input"
                    type="text"
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

          {busy && (
            <section className="imp-section" data-testid="render-progress">
              <progress max={1} value={phase === "running" ? fraction : undefined} style={{ width: "100%" }} />
              <div className="imp-note">{status}</div>
            </section>
          )}

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
              <div className="imp-note">{t("render.done", { width: dims.width, height: dims.height })}</div>
              <img src={imageUrl} alt={t("render.title")} style={{ maxWidth: "100%", maxHeight: 360, display: "block", marginTop: 6 }} />
            </section>
          )}

          {message && (
            <p className="imp-note" role="status" data-testid="render-message">
              {message}
            </p>
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
              <button className="imp-btn primary" data-testid="render-save" onClick={() => void savePng()}>
                {t("render.save")}
              </button>
            </>
          ) : browserOnly ? (
            <button className="imp-btn primary" data-testid="render-zip" disabled={!canStart} onClick={() => void saveZip()}>
              {t("render.zip.save")}
            </button>
          ) : (
            <button className="imp-btn primary" data-testid="render-start" disabled={!canStart || host === undefined} onClick={() => void start()}>
              {t("render.start")}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
});
