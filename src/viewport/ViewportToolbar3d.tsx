// [240] Schwebende Werkzeugleiste im 3D-Viewport: Begehen (an/aus), Kamera aus der Ansicht anlegen, dazu die
// Statuszeile des Pathtracers ([212]) und die kurze Tastenhilfe im Begehen-Modus ([213]). Eigene Komponente mit
// eigenem CSS-Block (`.vp3t-*` in styles.css), damit `Wasm3DViewport.tsx` nur noch einbindet.
// Gestaltung wie die übrigen Viewport-Knöpfe (Raster, Explosion): Material-Symbols-Icons, 30 px, Radius 7,
// leicht durchscheinender Grund mit Unschärfe — lesbar über hellem wie dunklem 3D-Bild, Farben über CSS-Variablen.

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";

export interface PathtraceStatus3d {
  samples: number;
  rate: number;
  done: boolean;
  /** [212] Modell überschreitet die Puffer-Grenzen der GPU: nur Himmel. */
  tooBig?: boolean;
}

/** Obergrenze der Samples (Renderer, [212]). */
export const PT_MAX_SAMPLES = 1024;
/** So lange bleibt die Tastenhilfe nach dem Einschalten sichtbar (ms). */
export const WALK_HELP_MS = 6000;
/** Frühestens so oft (ms) ändert sich die Zahl der Statuszeile — ruhig statt flackernd. */
export const PT_STATUS_THROTTLE_MS = 250;

export interface ViewportToolbar3dProps {
  walkMode: boolean;
  onToggleWalk: () => void;
  /** [245] Geist: Kollision und Bodenfolge im Begehen aus. Ohne `onToggleGhost` kein Knopf. */
  ghost?: boolean;
  onToggleGhost?: () => void;
  onCreateCamera: () => void;
  /** null = Pathtracing aus. */
  pathtrace: PathtraceStatus3d | null;
}

/** Fortschritt 0–1 der Samples. */
export function pathtraceProgress(samples: number, max = PT_MAX_SAMPLES): number {
  if (!(max > 0) || !Number.isFinite(samples)) return 0;
  return Math.max(0, Math.min(1, samples / max));
}

/** Zeigt den Wert höchstens alle `ms` neu an (Trailing), damit schnelle Zähler nicht flackern. */
function useThrottledValue<T>(value: T, ms: number, force: boolean): T {
  const [shown, setShown] = useState(value);
  const latest = useRef(value);
  const lastAt = useRef(0);
  latest.current = value;
  useEffect(() => {
    if (force) {
      setShown(value);
      lastAt.current = Date.now();
      return;
    }
    const wait = Math.max(0, lastAt.current + ms - Date.now());
    const id = setTimeout(() => {
      lastAt.current = Date.now();
      setShown(latest.current);
    }, wait);
    return () => clearTimeout(id);
  }, [value, ms, force]);
  return shown;
}

function ToolButton(props: {
  icon: string;
  label: string;
  testId: string;
  on?: boolean;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`vp3t-btn${props.on ? " is-on" : ""}`}
      aria-label={props.label}
      aria-pressed={props.pressed}
      data-tip={props.label}
      data-testid={props.testId}
      // Der Viewport startet Kamerageste auf pointerdown — Knöpfe sollen sie nicht auslösen.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={props.onClick}
    >
      <span className="material-symbols-outlined" aria-hidden="true">
        {props.icon}
      </span>
    </button>
  );
}

function PathtraceLine({ status }: { status: PathtraceStatus3d }) {
  const shown = useThrottledValue(status, PT_STATUS_THROTTLE_MS, status.done);
  const pct = Math.round(pathtraceProgress(shown.samples) * 100);
  const text = shown.tooBig
    ? t("viewport.pathtrace.tooBig")
    : shown.done
    ? t("viewport.pathtrace.done", { samples: shown.samples })
    : t("viewport.pathtrace.status", { samples: shown.samples, rate: shown.rate.toFixed(1) });
  return (
    <div className={`vp3t-status${shown.done ? " is-done" : ""}`} data-testid="pathtrace-status" role="status" aria-live="off">
      <span className="vp3t-status-text">{text}</span>
      <span
        className="vp3t-bar"
        role="progressbar"
        aria-label={t("viewport.pathtrace.progress")}
        aria-valuemin={0}
        aria-valuemax={PT_MAX_SAMPLES}
        aria-valuenow={Math.min(shown.samples, PT_MAX_SAMPLES)}
      >
        <span className="vp3t-bar-fill" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

function WalkHelp({ visible }: { visible: boolean }) {
  const rows: Array<[string, string]> = [
    ["W A S D", t("walk.help.move")],
    ["Q / E", t("walk.help.updown")],
    ["G", t("walk.help.ghost")],
    ["⇧ / Alt", t("walk.help.speed")],
    [t("walk.help.mouseKey"), t("walk.help.look")],
    ["Esc", t("walk.help.exit")],
  ];
  return (
    <div className={`vp3t-help${visible ? " is-visible" : ""}`} data-testid="walk-help" aria-hidden={!visible}>
      <div className="vp3t-help-title">{t("walk.toggle")}</div>
      {rows.map(([keys, what]) => (
        <div className="vp3t-help-row" key={what}>
          <kbd>{keys}</kbd>
          <span>{what}</span>
        </div>
      ))}
    </div>
  );
}

export function ViewportToolbar3d({ walkMode, onToggleWalk, ghost = false, onToggleGhost, onCreateCamera, pathtrace }: ViewportToolbar3dProps) {
  // Tastenhilfe: beim Einschalten sichtbar, nach ein paar Sekunden aus.
  const [helpOn, setHelpOn] = useState(false);
  useEffect(() => {
    if (!walkMode) {
      setHelpOn(false);
      return;
    }
    setHelpOn(true);
    const id = setTimeout(() => setHelpOn(false), WALK_HELP_MS);
    return () => clearTimeout(id);
  }, [walkMode]);

  return (
    <>
      <div className="vp3t-bar-wrap" role="toolbar" aria-label={t("viewport3d.toolbar")} data-testid="viewport3d-tools">
        <div className="vp3t-group" role="group" aria-label={t("viewport3d.toolbar.navigate")}>
          <ToolButton
            icon="directions_walk"
            label={walkMode ? t("walk.tip.off") : t("walk.tip.on")}
            testId="walk-toggle"
            on={walkMode}
            pressed={walkMode}
            onClick={onToggleWalk}
          />
          {walkMode && onToggleGhost && (
            <ToolButton
              icon="ghost"
              label={ghost ? t("walk.tip.ghostOff") : t("walk.tip.ghostOn")}
              testId="walk-ghost"
              on={ghost}
              pressed={ghost}
              onClick={onToggleGhost}
            />
          )}
        </div>
        <div className="vp3t-group" role="group" aria-label={t("viewport3d.toolbar.cameras")}>
          <ToolButton icon="add_a_photo" label={t("viewport3d.camera.create")} testId="camera-create-3d" onClick={onCreateCamera} />
        </div>
      </div>
      {walkMode && <WalkHelp visible={helpOn} />}
      {pathtrace && <PathtraceLine status={pathtrace} />}
    </>
  );
}
