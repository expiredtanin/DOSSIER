import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLanguage, setLanguage, t } from "./translate";
import { applyLanguagePref, getStoredLanguagePref, resolveLanguage, setStoredLanguagePref } from "./languagePref";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
  };
});
afterEach(() => {
  setLanguage("de");
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("[264] Sprachwahl", () => {
  it("Automatisch folgt der ersten bekannten Systemsprache, sonst Deutsch", () => {
    expect(resolveLanguage("auto", ["de-CH"])).toBe("de");
    expect(resolveLanguage("auto", ["en-US", "de"])).toBe("en");
    expect(resolveLanguage("auto", ["fr-CH", "en-GB"])).toBe("en");
    expect(resolveLanguage("auto", ["fr-CH"])).toBe("de");
    expect(resolveLanguage("auto", [])).toBe("de");
  });

  it("feste Wahl übersteuert das System", () => {
    expect(resolveLanguage("en", ["de-CH"])).toBe("en");
    expect(resolveLanguage("de", ["en-US"])).toBe("de");
  });

  it("Wahl wird gespeichert; ohne Eintrag oder bei Unsinn gilt Automatisch", () => {
    expect(getStoredLanguagePref()).toBe("auto");
    setStoredLanguagePref("en");
    expect(getStoredLanguagePref()).toBe("en");
    store.set("dossier.language", "klingon");
    expect(getStoredLanguagePref()).toBe("auto");
  });

  it("applyLanguagePref schaltet t() sofort um", () => {
    expect(t("settings.theme")).toBe("Erscheinungsbild");
    expect(applyLanguagePref("en")).toBe("en");
    expect(getLanguage()).toBe("en");
    expect(t("settings.theme")).toBe("Appearance");
  });
});
