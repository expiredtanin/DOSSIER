/**
 * `resolveCommand`/`allCommandNames` — insbesondere die NEUE `customAliases`-
 * Übersteuerung (Nutzer-Wunsch: „Befehls-Kürzel sind hart codiert, keine
 * Remap-UI"). Reihenfolge: exakter Befehlsname > Nutzer-Kürzel > eingebautes
 * Kürzel > eindeutiges Präfix.
 */

import { describe, it, expect } from "vitest";
import { resolveCommand, allCommandNames, COMMANDS } from "./registry";

describe("resolveCommand — ohne customAliases (unverändertes Verhalten)", () => {
  it("exakter Befehlsname", () => {
    expect(resolveCommand("line")?.name).toBe("line");
  });

  it("eingebautes Kürzel", () => {
    expect(resolveCommand("l")?.name).toBe("line");
  });

  it("unbekannt → null", () => {
    expect(resolveCommand("qqqq")).toBeNull();
  });
});

describe("resolveCommand — customAliases", () => {
  it("löst ein NEUES Nutzer-Kürzel auf, das kein eingebautes Kürzel ist", () => {
    expect(resolveCommand("zz", { zz: "circle" })?.name).toBe("circle");
  });

  it("überschreibt ein eingebautes Kürzel mit demselben Schlüssel", () => {
    // "l" ist eingebaut für "line" — ein Nutzer-Kürzel soll es übersteuern können.
    expect(resolveCommand("l")?.name).toBe("line");
    expect(resolveCommand("l", { l: "leader" })?.name).toBe("leader");
  });

  it("kann NIE einen exakten Befehlsnamen überschreiben", () => {
    // "wall" ist selbst ein exakter Befehlsname — ein Kürzel-Override mit
    // demselben Schlüssel darf ihn nicht kapern.
    expect(resolveCommand("wall", { wall: "circle" })?.name).toBe("wall");
  });

  it("ein Kürzel auf einen unbekannten Befehlsnamen liefert null (kein Absturz)", () => {
    expect(resolveCommand("zz", { zz: "does-not-exist" })).toBeNull();
  });

  it("case-insensitiv wie die eingebauten Kürzel", () => {
    expect(resolveCommand("ZZ", { zz: "circle" })?.name).toBe("circle");
  });
});

describe("allCommandNames", () => {
  it("liefert alle registrierten Befehle, alphabetisch, ohne Duplikate", () => {
    const names = allCommandNames();
    expect(names.length).toBe(Object.keys(COMMANDS).length);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it("enthält bekannte Befehle (Stichprobe)", () => {
    const names = allCommandNames();
    expect(names).toContain("line");
    expect(names).toContain("break");
    expect(names).toContain("detailref");
  });
});

describe("Körper-Befehle (truck)", () => {
  it("Kürzel führen zu den B-Rep-Befehlen", () => {
    expect(resolveCommand("kugel")?.name).toBe("solid");
    expect(resolveCommand("koerper")?.name).toBe("solid");
    expect(resolveCommand("bool")?.name).toBe("solidbool");
    expect(resolveCommand("verschneiden")?.name).toBe("solidbool");
  });
});
