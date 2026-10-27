// Echtes ICC-Farbmanagement für den RGB/CMYK-Mischer (`ui/ColorMixer.tsx`) —
// nutzt `lcms-wasm` (WASM-Portierung der echten Little-CMS-Bibliothek, MIT-
// lizenziert, dieselbe Engine, die auch professionelle Druck-Software
// verwendet) gegen das von macOS mitgelieferte „Generic CMYK Profile"
// (ColorSync, `/System/Library/ColorSync/Profiles/`) als Referenzprofil.
//
// Bewusst KEIN mit der App gebündeltes/verteiltes Farbprofil: die Datei wird
// zur LAUFZEIT vom Betriebssystem gelesen (nur dieser eine, fest verdrahtete
// Pfad ist in `src-tauri/capabilities/default.json` per `fs:allow-read-file`
// freigegeben), nie kopiert oder mit dem App-Bundle verteilt — damit stellt
// sich die Lizenz-/Weitergabefrage für ein Fremd-Farbprofil (z. B. Adobes
// oder ECIs kommerzielle CMYK-Referenzprofile) gar nicht erst.
//
// Nur auf macOS verfügbar (ColorSync-Pfad existiert nur dort). Überall sonst
// — Windows/Linux, oder falls die Datei aus irgendeinem Grund fehlt/das
// WASM nicht lädt — liefern die Funktionen unten `undefined`; der Aufrufer
// (`ui/ColorMixer.tsx`) fällt dann auf die vereinfachte Formel in
// `model/color.ts` zurück (progressive enhancement, kein harter Fehler).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { readFile } from "@tauri-apps/plugin-fs";
import type { LcmsInstance } from "lcms-wasm";
import type { Cmyk, Rgb } from "../model/color";

const MACOS_GENERIC_CMYK_PROFILE = "/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc";

interface LcmsHandles {
  lcms: LcmsInstance;
  toCmyk: number;
  toRgb: number;
}

let handles: LcmsHandles | null = null;
let initPromise: Promise<boolean> | null = null;

/**
 * Lädt `lcms-wasm` + das System-CMYK-Profil EINMALIG (Ergebnis gecacht,
 * mehrfacher Aufruf gibt dasselbe Promise zurück). Nach erfolgreichem
 * Abschluss sind {@link rgbToCmykIcc}/{@link cmykToRgbIcc} synchron nutzbar
 * (wichtig fürs Mischer-UI: Regler ziehen darf nicht pro Schritt auf ein
 * Promise warten). `false` bei jedem Fehler (fehlende Datei, kein macOS,
 * WASM-Ladefehler) — kein Reject, der Aufrufer entscheidet selbst über den
 * Fallback.
 */
export function initIccColorManagement(): Promise<boolean> {
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

async function doInit(): Promise<boolean> {
  try {
    const [lcmsModule, wasmUrlModule, profileBytes] = await Promise.all([
      import("lcms-wasm"),
      import("lcms-wasm/dist/lcms.wasm?url"),
      readFile(MACOS_GENERIC_CMYK_PROFILE),
    ]);
    const wasmUrl = (wasmUrlModule as { default: string }).default;
    const lcms = await lcmsModule.instantiate({ locateFile: () => wasmUrl });

    const cmykProfile = lcms.cmsOpenProfileFromMem(profileBytes, profileBytes.byteLength);
    const srgbProfile = lcms.cmsCreate_sRGBProfile();
    if (!cmykProfile || !srgbProfile) return false;

    // Relative Colorimetric — Standard-Intent für RGB<->CMYK-Umwandlung in
    // gängiger DTP-/Druckvorstufen-Software (z. B. Adobe-Voreinstellung).
    const toCmyk = lcms.cmsCreateTransform(
      srgbProfile,
      lcmsModule.TYPE_RGB_8,
      cmykProfile,
      lcmsModule.TYPE_CMYK_8,
      lcmsModule.INTENT_RELATIVE_COLORIMETRIC,
      0,
    );
    const toRgb = lcms.cmsCreateTransform(
      cmykProfile,
      lcmsModule.TYPE_CMYK_8,
      srgbProfile,
      lcmsModule.TYPE_RGB_8,
      lcmsModule.INTENT_RELATIVE_COLORIMETRIC,
      0,
    );
    if (!toCmyk || !toRgb) return false;

    handles = { lcms, toCmyk, toRgb };
    return true;
  } catch {
    return false;
  }
}

/** `true`, sobald {@link initIccColorManagement} erfolgreich abgeschlossen hat. */
export function iccColorManagementAvailable(): boolean {
  return handles !== null;
}

const pctFrom255 = (v: number) => Math.round((v / 255) * 100);
const to255FromPct = (pct: number) => Math.round((pct / 100) * 255);

/** Echte ICC-Umwandlung RGB→CMYK (0..100 je Kanal). `undefined`, wenn nicht initialisiert. */
export function rgbToCmykIcc(rgb: Rgb): Cmyk | undefined {
  if (!handles) return undefined;
  const out = handles.lcms.cmsDoTransform(handles.toCmyk, [rgb.r, rgb.g, rgb.b], 1);
  return { c: pctFrom255(out[0]), m: pctFrom255(out[1]), y: pctFrom255(out[2]), k: pctFrom255(out[3]) };
}

/** Echte ICC-Umwandlung CMYK→RGB. `undefined`, wenn nicht initialisiert. */
export function cmykToRgbIcc(cmyk: Cmyk): Rgb | undefined {
  if (!handles) return undefined;
  const input = [to255FromPct(cmyk.c), to255FromPct(cmyk.m), to255FromPct(cmyk.y), to255FromPct(cmyk.k)];
  const out = handles.lcms.cmsDoTransform(handles.toRgb, input, 1);
  return { r: out[0], g: out[1], b: out[2] };
}
