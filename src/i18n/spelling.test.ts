// [263] Rechtschreibung des deutschen Wörterbuchs: Schweizer Schreibweise (kein „ß“, also „Massstab“,
// „Schliessen“, „Aussenwand“) — die ganze App und die Fachsprache (SIA) nutzen „ss“; gemischte
// Schreibung wirkte inkonsequent (Dialog „Schliessen“ neben „Schließen“).
import { describe, expect, it } from "vitest";
import { de } from "./de";
import { en } from "./en";

describe("de.ts: Schweizer Rechtschreibung", () => {
  it("enthält kein ß", () => {
    const hits = Object.entries(de)
      .filter(([, v]) => typeof v === "string" && v.includes("ß"))
      .map(([k, v]) => `${k}: ${v}`);
    expect(hits).toEqual([]);
  });

  it("nennt die Fang-Funktion überall „Fang“, nicht „Snap“ (ausser Ausschnitt/Snapshot)", () => {
    const hits = Object.entries(de)
      .filter(([k, v]) => typeof v === "string" && /\bSnap\b|Snap-/.test(v) && !/napshot/.test(k))
      .map(([k, v]) => `${k}: ${v}`);
    expect(hits).toEqual([]);
  });
});

describe("en.ts: einheitliche Schreibweise", () => {
  it("color (nicht colour) und room programme (nicht room program)", () => {
    const hits = Object.entries(en)
      .filter(([, v]) => typeof v === "string" && (/colour/i.test(v) || /room program\b/i.test(v)))
      .map(([k, v]) => `${k}: ${v}`);
    expect(hits).toEqual([]);
  });
});
