import { describe, expect, it } from "vitest";
import { instantiatePreset, openingTypePresets } from "./openingPresets";
import { de } from "../i18n/de";
import { en } from "../i18n/en";

describe("openingTypePresets ([95])", () => {
  it("liefert Fenster- und Türvorlagen mit übersetzten Namen", () => {
    const { windowTypes, doorTypes } = openingTypePresets();
    expect(windowTypes.length).toBeGreaterThanOrEqual(5);
    expect(doorTypes.map((d) => d.kind)).toEqual(expect.arrayContaining(["schiebe", "hebeschiebe", "pendel"]));
    for (const t of [...windowTypes, ...doorTypes]) {
      expect((de as Record<string, string>)[`preset.${t.id}`]).toBeTruthy();
      expect((en as Record<string, string>)[`preset.${t.id}`]).toBeTruthy();
    }
    expect(windowTypes.some((w) => (w.transomSashes ?? []).length > 1)).toBe(true);
  });

  it("instantiatePreset kopiert tief und setzt id/Name", () => {
    const w = openingTypePresets().windowTypes.find((t) => t.sashes)!;
    const c = instantiatePreset(w, "ft-neu", "Neu");
    expect(c.id).toBe("ft-neu");
    expect(c.name).toBe("Neu");
    c.sashes![0].opening = "fest";
    expect(w.sashes![0].opening).not.toBe("fest");
  });
});
