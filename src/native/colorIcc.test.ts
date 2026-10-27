import { describe, expect, it } from "vitest";
import { initIccColorManagement, iccColorManagementAvailable, rgbToCmykIcc, cmykToRgbIcc } from "./colorIcc";

// `@tauri-apps/plugin-fs`s `readFile` braucht die echte Tauri-IPC-Bridge
// (`window.__TAURI_INTERNALS__`), die es in vitest/Node NICHT gibt — hier
// kann also nur der GRACEFUL-FALLBACK-Vertrag geprüft werden (kein Wurf,
// sauberes `false`/`undefined`), nicht die echte ICC-Umrechnung selbst. Das
// ist dieselbe Grenze wie bei anderen Tauri-Runtime-Features dieser Codebase
// (s. render3d/Wasm3DViewport) — die echte Umrechnung gegen macOS' Generic
// CMYK Profile wird in der laufenden Tauri-App von Hand geprüft, nicht hier.
describe("colorIcc — Fallback-Vertrag ausserhalb der Tauri-Runtime", () => {
  it("initIccColorManagement wirft nie, liefert sauber false ohne Tauri-Bridge", async () => {
    const ok = await initIccColorManagement();
    expect(ok).toBe(false);
    expect(iccColorManagementAvailable()).toBe(false);
  });

  it("rgbToCmykIcc/cmykToRgbIcc liefern undefined statt zu werfen, wenn nicht initialisiert", () => {
    expect(rgbToCmykIcc({ r: 255, g: 0, b: 0 })).toBeUndefined();
    expect(cmykToRgbIcc({ c: 0, m: 100, y: 100, k: 0 })).toBeUndefined();
  });
});
