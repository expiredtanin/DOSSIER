// Erstell-Dialoge für den Layouts-Baum (DOSSIER A3): „Neues Layout" und „Neues
// Masterlayout". Beide liefern beim Bestätigen die Startwerte (Papier/Custom-
// Grösse/Ausrichtung bzw. Master-Vorlage) nach oben; das Panel legt das Element
// an und versetzt es direkt in den Inline-Rename-Modus.
//
// Muster wie ExportSaveDialog: `imp-*`-Overlay/Dialog, Klick auf Hintergrund +
// Esc schliessen, Enter bestätigt. KEIN window.prompt/confirm (im Tauri-WKWebView
// deaktiviert). Bezeichner englisch, UI-Text deutsch via t() (CONVENTIONS.md).

import { useEffect, useState } from "react";
import { t } from "../i18n";
import type {
  LayoutOrientation,
  LayoutPaperFormat,
  MasterLayout,
} from "../model/types";
import { PAPER_FORMAT_GROUPS } from "../panels/layoutModel";

/** Startwerte eines neuen Blatts/Masters (Grösse). */
export interface LayoutSizeStart {
  paper: LayoutPaperFormat;
  orientation: LayoutOrientation;
  customWidthMm?: number;
  customHeightMm?: number;
}

/** Startwerte eines neuen Layouts: entweder Master-Vorlage ODER freie Grösse. */
export interface NewLayoutStart extends LayoutSizeStart {
  /** Gebundenes Masterlayout (erbt dessen Papier/Ausrichtung); sonst undefined. */
  masterId?: string;
}

type SizeMode = LayoutPaperFormat | "custom";

/** Baut die Grösse-Startwerte aus dem Grössen-Auswahlzustand. */
function sizeStart(
  mode: SizeMode,
  orientation: LayoutOrientation,
  wMm: number,
  hMm: number,
): LayoutSizeStart {
  if (mode === "custom") {
    return {
      paper: "a4",
      orientation,
      customWidthMm: Math.max(1, Math.round(wMm)),
      customHeightMm: Math.max(1, Math.round(hMm)),
    };
  }
  return { paper: mode, orientation };
}

/** Geteilte Grössen-Auswahl: Format (A4/A3) als Segment ODER freie mm-Felder + Ausrichtung. */
function SizePicker({
  mode,
  setMode,
  orientation,
  setOrientation,
  wMm,
  setWMm,
  hMm,
  setHMm,
}: {
  mode: SizeMode;
  setMode: (m: SizeMode) => void;
  orientation: LayoutOrientation;
  setOrientation: (o: LayoutOrientation) => void;
  wMm: number;
  setWMm: (v: number) => void;
  hMm: number;
  setHMm: (v: number) => void;
}) {
  return (
    <>
      <section className="imp-section">
        <div className="imp-section-title">{t("layouts.size.format")}</div>
        <select
          className="imp-select"
          value={mode}
          onChange={(e) => setMode(e.target.value as SizeMode)}
        >
          {PAPER_FORMAT_GROUPS.map((g) => (
            <optgroup
              key={g.label}
              label={g.label === "A" ? t("layouts.paperGroup.a") : t("layouts.paperGroup.b")}
            >
              {g.formats.map((f) => (
                <option key={f} value={f}>
                  {f.toUpperCase()}
                </option>
              ))}
            </optgroup>
          ))}
          <option value="custom">{t("layouts.size.custom")}</option>
        </select>
      </section>

      {mode === "custom" ? (
        <section className="imp-section">
          <div className="imp-size-row">
            <label className="imp-size-field">
              <span>{t("layouts.size.widthMm")}</span>
              <input
                className="settings-num-input"
                type="number"
                min={1}
                value={wMm}
                onChange={(e) => setWMm(parseFloat(e.target.value) || 0)}
              />
            </label>
            <span className="imp-size-x">×</span>
            <label className="imp-size-field">
              <span>{t("layouts.size.heightMm")}</span>
              <input
                className="settings-num-input"
                type="number"
                min={1}
                value={hMm}
                onChange={(e) => setHMm(parseFloat(e.target.value) || 0)}
              />
            </label>
          </div>
        </section>
      ) : (
        <section className="imp-section">
          <div className="imp-section-title">{t("layouts.orientation")}</div>
          <div className="imp-seg">
            {(["portrait", "landscape"] as const).map((o) => (
              <button
                key={o}
                type="button"
                className={`imp-seg-btn${orientation === o ? " active" : ""}`}
                onClick={() => setOrientation(o)}
              >
                {o === "portrait" ? t("layouts.portrait") : t("layouts.landscape")}
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** Overlay-Rahmen (geteilt von beiden Dialogen). */
function DialogFrame({
  title,
  onClose,
  onConfirm,
  children,
}: {
  title: string;
  onClose: () => void;
  onConfirm: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onConfirm]);

  return (
    <div className="imp-overlay" onClick={onClose}>
      <div
        className="imp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{title}</span>
          <button className="imp-close" onClick={onClose} aria-label={t("export.close")}>
            ×
          </button>
        </header>
        <div className="imp-body">{children}</div>
        <footer className="imp-foot">
          <button className="imp-btn" onClick={onClose}>
            {t("export.cancel")}
          </button>
          <button className="imp-btn primary" onClick={onConfirm}>
            {t("layouts.size.create")}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Dialog „Neues Masterlayout" — Format/freie Grösse + Ausrichtung. */
export function NewMasterLayoutDialog({
  onCreate,
  onClose,
}: {
  onCreate: (start: LayoutSizeStart) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<SizeMode>("a4");
  const [orientation, setOrientation] = useState<LayoutOrientation>("portrait");
  const [wMm, setWMm] = useState(210);
  const [hMm, setHMm] = useState(297);
  const confirm = () => onCreate(sizeStart(mode, orientation, wMm, hMm));

  return (
    <DialogFrame title={t("layouts.newMaster.title")} onClose={onClose} onConfirm={confirm}>
      <SizePicker
        mode={mode}
        setMode={setMode}
        orientation={orientation}
        setOrientation={setOrientation}
        wMm={wMm}
        setWMm={setWMm}
        hMm={hMm}
        setHMm={setHMm}
      />
    </DialogFrame>
  );
}

/**
 * Dialog „Neues Layout" — Masterlayout als Vorlage (erbt dessen Grösse) ODER
 * freie Grösse (Format/Custom + Ausrichtung).
 */
export function NewLayoutDialog({
  masters,
  onCreate,
  onClose,
}: {
  masters: MasterLayout[];
  onCreate: (start: NewLayoutStart) => void;
  onClose: () => void;
}) {
  const hasMasters = masters.length > 0;
  const [source, setSource] = useState<"master" | "free">(
    hasMasters ? "master" : "free",
  );
  const [masterId, setMasterId] = useState<string>(masters[0]?.id ?? "");
  const [mode, setMode] = useState<SizeMode>("a4");
  const [orientation, setOrientation] = useState<LayoutOrientation>("portrait");
  const [wMm, setWMm] = useState(210);
  const [hMm, setHMm] = useState(297);

  const confirm = () => {
    if (source === "master" && masterId) {
      // Grösse erbt der Aufrufer vom Master; wir liefern nur die Bindung + eine
      // sinnvolle Rückfall-Grösse (A4 hoch), falls der Master unauflösbar ist.
      onCreate({ masterId, paper: "a4", orientation: "portrait" });
      return;
    }
    onCreate(sizeStart(mode, orientation, wMm, hMm));
  };

  return (
    <DialogFrame title={t("layouts.newLayout.title")} onClose={onClose} onConfirm={confirm}>
      <section className="imp-section">
        <div className="imp-section-title">{t("layouts.newLayout.source")}</div>
        <label className="imp-radio">
          <input
            type="radio"
            checked={source === "master"}
            disabled={!hasMasters}
            onChange={() => setSource("master")}
          />
          <span>{t("layouts.newLayout.fromMaster")}</span>
        </label>
        <label className="imp-radio">
          <input
            type="radio"
            checked={source === "free"}
            onChange={() => setSource("free")}
          />
          <span>{t("layouts.newLayout.freeSize")}</span>
        </label>
      </section>

      {source === "master" ? (
        <section className="imp-section">
          {hasMasters ? (
            <select
              className="imp-select"
              value={masterId}
              onChange={(e) => setMasterId(e.target.value)}
            >
              {masters.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="imp-note">{t("layouts.newLayout.noMasters")}</div>
          )}
        </section>
      ) : (
        <SizePicker
          mode={mode}
          setMode={setMode}
          orientation={orientation}
          setOrientation={setOrientation}
          wMm={wMm}
          setWMm={setWMm}
          hMm={hMm}
          setHMm={setHMm}
        />
      )}
    </DialogFrame>
  );
}
