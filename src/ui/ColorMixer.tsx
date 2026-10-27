// Farbmischer mit fünf Modellen — Segmented-Umschalter zwischen RGB, CMYK,
// HSL, HSV und einem visuellen Spektrum-Wähler; je Kanal ein Slider +
// Zahlenfeld, oben eine Live-Vorschau der aktuellen Farbe. Eigenständig,
// ohne Popover-Hülle — wird von `FreeColorPicker.tsx` eingebettet.
//
// CMYK nutzt, wenn verfügbar, ECHTES ICC-Farbmanagement (`model/colorIcc.ts`,
// lcms-wasm gegen macOS' Generic CMYK Profile) — sonst automatisch die
// vereinfachte Formel (`model/color.ts`) als Fallback (anderes Betriebs-
// system, Datei fehlt, WASM-Ladefehler). Der Hinweistext unten sagt, welcher
// der beiden Fälle gerade aktiv ist.
//
// WARUM EIN PUFFER (`draft`): die Farbe selbst lebt als Hex/RGB beim
// Aufrufer. CMYK (4 Kanäle) und HSL/HSV (Farbton bei Grau/Schwarz/Weiss
// undefiniert) haben aber Freiheitsgrade, die beim Rückrechnen aus RGB
// verloren gehen — ohne Puffer würden beim Ziehen EINES Reglers die anderen
// sichtbar springen (Nutzer-Report zu CMYK). Der Puffer wird nur dann aus
// `color` neu aufgebaut, wenn die Farbe von AUSSEN kommt (Palette, Hex-Feld,
// anderes Modell) — erkannt über die zuletzt selbst gesendete Farbe.

import { useEffect, useRef, useState } from "react";
import {
  cmykToRgb,
  hexToRgb,
  hslToRgb,
  hsvToRgb,
  rgbToCmyk,
  rgbToHex,
  rgbToHsl,
  rgbToHsv,
} from "../model/color";
import type { Cmyk, Hsl, Hsv, Rgb } from "../model/color";
import { initIccColorManagement, iccColorManagementAvailable, rgbToCmykIcc, cmykToRgbIcc } from "../native/colorIcc";
import { SpectrumPicker } from "./SpectrumPicker";
import { Segmented } from "./resourceManager/fields";
import { t } from "../i18n";

type Mode = "spectrum" | "rgb" | "cmyk" | "hsl" | "hsv";

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Kanal-Definition einer Modell-Zeile: Feldname, Beschriftung, Wertebereich. */
interface Channel<T> {
  key: keyof T;
  label: string;
  max: number;
}
const RGB_CHANNELS: Channel<Rgb>[] = [
  { key: "r", label: "R", max: 255 },
  { key: "g", label: "G", max: 255 },
  { key: "b", label: "B", max: 255 },
];
const CMYK_CHANNELS: Channel<Cmyk>[] = [
  { key: "c", label: "C", max: 100 },
  { key: "m", label: "M", max: 100 },
  { key: "y", label: "Y", max: 100 },
  { key: "k", label: "K", max: 100 },
];
const HSL_CHANNELS: Channel<Hsl>[] = [
  { key: "h", label: "H", max: 360 },
  { key: "s", label: "S", max: 100 },
  { key: "l", label: "L", max: 100 },
];
const HSV_CHANNELS: Channel<Hsv>[] = [
  { key: "h", label: "H", max: 360 },
  { key: "s", label: "S", max: 100 },
  { key: "v", label: "V", max: 100 },
];

/** RGB→CMYK mit ICC-Vorrang, Formel-Fallback. */
function toCmyk(rgb: Rgb): Cmyk {
  return rgbToCmykIcc(rgb) ?? rgbToCmyk(rgb);
}
/** CMYK→RGB mit ICC-Vorrang, Formel-Fallback. */
function fromCmyk(cmyk: Cmyk): Rgb {
  return cmykToRgbIcc(cmyk) ?? cmykToRgb(cmyk);
}

/** Alle gepufferten Modelle einer Farbe (s. Modul-Kommentar). */
interface Draft {
  cmyk: Cmyk;
  hsl: Hsl;
  hsv: Hsv;
}
const draftOf = (rgb: Rgb): Draft => ({
  cmyk: toCmyk(rgb),
  hsl: rgbToHsl(rgb),
  hsv: rgbToHsv(rgb),
});

export function ColorMixer({ color, onChange }: { color: string; onChange: (hex: string) => void }) {
  const [mode, setMode] = useState<Mode>("spectrum");
  // Einmaliger, formularunabhängiger Ladeversuch — mehrere ColorMixer-
  // Instanzen (Popover kann mehrfach geöffnet werden) teilen sich das
  // gecachte Promise in `colorIcc.ts`, hier nur der lokale Re-Render-Trigger.
  const [iccReady, setIccReady] = useState(iccColorManagementAvailable());
  useEffect(() => {
    if (iccReady) return;
    let cancelled = false;
    initIccColorManagement().then((ok) => {
      if (!cancelled && ok) setIccReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [iccReady]);

  const rgb = hexToRgb(color);
  const [draft, setDraft] = useState<Draft>(() => draftOf(rgb));
  const lastEmitted = useRef<string | null>(null);
  useEffect(() => {
    if (color === lastEmitted.current) return;
    setDraft(draftOf(hexToRgb(color)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color]);

  /** Emittiert die Farbe aus einem geänderten Modell und hält den Puffer konsistent. */
  const emit = (next: Partial<Draft>, nextRgb: Rgb) => {
    const hex = rgbToHex(nextRgb);
    lastEmitted.current = hex;
    // Nur das BEARBEITETE Modell übernimmt die Nutzerwerte 1:1; die übrigen
    // werden aus der neuen Farbe abgeleitet (sonst zeigten sie veraltete Werte).
    setDraft({ ...draftOf(hexToRgb(hex)), ...next });
    onChange(hex);
  };

  const setRgbChannel = (key: keyof Rgb, v: number) =>
    emit({}, { ...rgb, [key]: clamp(v, 0, 255) });
  const setCmykChannel = (key: keyof Cmyk, v: number) => {
    const cmyk = { ...draft.cmyk, [key]: clamp(v, 0, 100) };
    emit({ cmyk }, fromCmyk(cmyk));
  };
  const setHslChannel = (key: keyof Hsl, v: number) => {
    const hsl = { ...draft.hsl, [key]: clamp(v, 0, key === "h" ? 360 : 100) };
    emit({ hsl }, hslToRgb(hsl));
  };
  const setHsvChannel = (key: keyof Hsv, v: number) => {
    const hsv = { ...draft.hsv, [key]: clamp(v, 0, key === "h" ? 360 : 100) };
    emit({ hsv }, hsvToRgb(hsv));
  };

  /** Eine Kanal-Zeile (Beschriftung + Slider + Zahlenfeld). */
  const channelRows = <T,>(channels: Channel<T>[], values: T, set: (key: keyof T, v: number) => void) =>
    channels.map((ch) => {
      const value = values[ch.key] as number;
      return (
        <div className="color-mixer-row" key={String(ch.key)}>
          <span className="color-mixer-label">{ch.label}</span>
          <input
            type="range"
            min={0}
            max={ch.max}
            value={value}
            onChange={(e) => set(ch.key, Number(e.target.value))}
          />
          <input
            type="number"
            min={0}
            max={ch.max}
            className="color-mixer-num"
            value={value}
            onChange={(e) => set(ch.key, Number(e.target.value))}
          />
        </div>
      );
    });

  return (
    <div className="color-mixer">
      <div className="color-mixer-head">
        <span className="color-mixer-preview" style={{ background: color }} title={color} />
        <Segmented<Mode>
          value={mode}
          onChange={setMode}
          options={[
            { value: "spectrum", label: t("colorMixer.spectrum") },
            { value: "rgb", label: "RGB" },
            { value: "cmyk", label: "CMYK" },
            { value: "hsl", label: "HSL" },
            { value: "hsv", label: "HSV" },
          ]}
        />
      </div>
      {mode === "spectrum" && (
        <SpectrumPicker hsv={draft.hsv} onChange={(hsv) => emit({ hsv }, hsvToRgb(hsv))} />
      )}
      {mode === "rgb" && channelRows(RGB_CHANNELS, rgb, setRgbChannel)}
      {mode === "cmyk" && channelRows(CMYK_CHANNELS, draft.cmyk, setCmykChannel)}
      {mode === "hsl" && channelRows(HSL_CHANNELS, draft.hsl, setHslChannel)}
      {mode === "hsv" && channelRows(HSV_CHANNELS, draft.hsv, setHsvChannel)}
      {mode === "cmyk" && (
        <div className="color-mixer-hint">
          {t(iccReady ? "colorMixer.cmykHintIcc" : "colorMixer.cmykHint")}
        </div>
      )}
    </div>
  );
}
