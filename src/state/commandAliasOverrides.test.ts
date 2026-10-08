/**
 * `isValidAliasKey` — reine Validierung für die Kürzel-Remap-Sektion
 * (Einstellungen). `loadAliasOverrides`/`saveAliasOverrides` sind
 * localStorage-gekoppelt und bleiben — wie jeder localStorage-Code in diesem
 * Projekt (Theme/Renderer-Modus) — ohne dediziertes Unit-Test, s. Kopfkommentar
 * in `commandAliasOverrides.ts` (beide Funktionen sind bewusst defensiv:
 * try/catch, No-op statt Absturz ohne funktionierendes localStorage).
 */
import { describe, it, expect } from "vitest";
import { isValidAliasKey } from "./commandAliasOverrides";

describe("isValidAliasKey", () => {
  it("akzeptiert ein einfaches Kürzel", () => {
    expect(isValidAliasKey("zz")).toBe(true);
    expect(isValidAliasKey("dr")).toBe(true);
  });

  it("trimmt und ist case-insensitiv (Grossbuchstaben sind gültig, werden aber wie klein behandelt)", () => {
    expect(isValidAliasKey("  ZZ  ")).toBe(true);
  });

  it("lehnt leere/nur-Leerzeichen-Strings ab", () => {
    expect(isValidAliasKey("")).toBe(false);
    expect(isValidAliasKey("   ")).toBe(false);
  });

  it("lehnt Leerzeichen/Kommas innerhalb des Kürzels ab", () => {
    expect(isValidAliasKey("z z")).toBe(false);
    expect(isValidAliasKey("z,z")).toBe(false);
  });

  it("lehnt 'r' und 'r<Ziffer>...' ab (Kollision mit relativ-Koordinaten)", () => {
    expect(isValidAliasKey("r")).toBe(false);
    expect(isValidAliasKey("r5")).toBe(false);
    expect(isValidAliasKey("r5,3")).toBe(false);
  });

  it("erlaubt andere mit 'r' beginnende Kürzel, die NICHT von einer Ziffer gefolgt werden", () => {
    expect(isValidAliasKey("rf")).toBe(true); // z. B. bereits als eingebautes Kürzel für "roof" genutzt
    expect(isValidAliasKey("raum")).toBe(true);
  });
});
