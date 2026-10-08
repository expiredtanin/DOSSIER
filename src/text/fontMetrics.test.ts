// `contentFontBaselineFromTop` misst per Canvas — im Testlauf (vitest.config.ts:
// environment "node") gibt es kein `document`, der try/catch-Fallback greift.
// Testet hier NUR den robusten Fallback-Pfad (kein Crash ohne DOM) + Caching;
// die echte Canvas-Messung selbst ist nur im Browser sinnvoll prüfbar.

import { describe, it, expect } from "vitest";
import { contentFontBaselineFromTop, resetFontMetricsCacheForTest } from "./fontMetrics";

describe("contentFontBaselineFromTop", () => {
  it("liefert ohne DOM (kein `document`) den dokumentierten Fallback-Wert, ohne zu crashen", () => {
    resetFontMetricsCacheForTest();
    expect(contentFontBaselineFromTop(1.25)).toBe(0.9);
  });

  it("cacht je lineHeightMultiplier (liefert bei wiederholtem Aufruf denselben Wert)", () => {
    resetFontMetricsCacheForTest();
    const a = contentFontBaselineFromTop(1.25);
    const b = contentFontBaselineFromTop(1.25);
    expect(a).toBe(b);
  });

  it("liefert für unterschiedliche lineHeightMultiplier-Werte je einen eigenen Cache-Eintrag", () => {
    resetFontMetricsCacheForTest();
    const a = contentFontBaselineFromTop(1.0);
    const b = contentFontBaselineFromTop(1.55);
    // Ohne echtes Font-Measuring (Fallback) identisch — der Test dokumentiert
    // nur, dass unterschiedliche Keys unabhängig funktionieren (kein Crash/
    // Cache-Kollision), nicht den (hier nicht messbaren) echten Unterschied.
    expect(a).toBe(0.9);
    expect(b).toBe(0.9);
  });
});
