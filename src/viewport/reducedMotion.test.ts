// [C10] „Bewegung reduzieren": prefersReducedMotion folgt der Systemeinstellung (matchMedia), ohne Fenster false.
import { afterEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion } from "./cameraBridge";

describe("prefersReducedMotion", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("folgt matchMedia", () => {
    vi.stubGlobal("window", { matchMedia: (q: string) => ({ matches: q.includes("reduce") }) });
    expect(prefersReducedMotion()).toBe(true);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    expect(prefersReducedMotion()).toBe(false);
  });
  it("ohne matchMedia: false", () => {
    vi.stubGlobal("window", {});
    expect(prefersReducedMotion()).toBe(false);
  });
});
