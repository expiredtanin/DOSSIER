import { describe, expect, it } from "vitest";
import { markSessionClean, markSessionStart } from "./startupGuard";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("Start-Protokoll", () => {
  it("erster Start: kein Absturz gemeldet", () => {
    expect(markSessionStart(mem()).previousCrashed).toBe(false);
  });
  it("sauber beendet → nächster Start ohne Meldung", () => {
    const s = mem();
    markSessionStart(s, 1);
    markSessionClean(s);
    expect(markSessionStart(s, 2).previousCrashed).toBe(false);
  });
  it("nicht sauber beendet → nächster Start meldet Absturz mit Startzeit", () => {
    const s = mem();
    markSessionStart(s, 1000);
    const r = markSessionStart(s, 2000);
    expect(r).toEqual({ previousCrashed: true, previousStartedAt: 1000 });
  });
  it("kaputter Speicherinhalt und fehlender Speicher werfen nicht", () => {
    const s = mem();
    s.setItem("dossier.session", "{kaputt");
    expect(markSessionStart(s).previousCrashed).toBe(false);
    expect(markSessionStart(null).previousCrashed).toBe(false);
    expect(() => markSessionClean(null)).not.toThrow();
  });
});
