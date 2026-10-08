// Ambient-Deklarationen für `lcms-wasm` (liefert selbst keine Typen) + den
// per Vite `?url` aufgelösten Pfad zu seiner `.wasm`-Datei. Nur die
// Teilmenge der API, die `model/colorIcc.ts` tatsächlich nutzt — die
// Bibliothek selbst ist ein sehr dünner Emscripten-Wrapper um Little-CMS
// mit deutlich mehr Funktionen/Konstanten, s. node_modules/lcms-wasm/dist/
// lcms.js für die vollständige (untypisierte) Oberfläche.

declare module "lcms-wasm" {
  /** Low-Level-WASM-Instanz (Handles sind einfache Zahlen, wie in Little-CMS selbst). */
  export interface LcmsInstance {
    cmsOpenProfileFromMem(bytes: Uint8Array, size: number): number;
    cmsCreate_sRGBProfile(): number;
    cmsCloseProfile(profile: number): void;
    cmsCreateTransform(
      inputProfile: number,
      inputFormat: number,
      outputProfile: number,
      outputFormat: number,
      intent: number,
      flags: number,
    ): number;
    cmsDeleteTransform(transform: number): void;
    /** `size` = Anzahl Pixel (nicht Bytes) — Kanalzahl ergibt sich aus dem Transform-Format. */
    cmsDoTransform(transform: number, input: number[], size: number): Uint8Array | Float32Array;
  }

  export function instantiate(opts?: {
    locateFile?: (filename: string) => string;
  }): Promise<LcmsInstance>;

  export const TYPE_RGB_8: number;
  export const TYPE_CMYK_8: number;
  export const INTENT_RELATIVE_COLORIMETRIC: number;
}

declare module "lcms-wasm/dist/lcms.wasm?url" {
  /** Von Vite aufgelöste URL der WASM-Datei (gehashtes Asset im Build). */
  const url: string;
  export default url;
}
