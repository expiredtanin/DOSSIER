import { describe, expect, it } from "vitest";
import { defaultStudyIso, formatMinutes, isoToLocal, localToIso } from "./sunStudyTime";

describe("Zeitregler der Schattenstudie", () => {
  it("Ortszeit ↔ UTC hin und zurück", () => {
    const iso = localToIso({ date: "2026-12-21", minutes: 11 * 60 + 15 })!;
    expect(isoToLocal(iso)).toEqual({ date: "2026-12-21", minutes: 675 });
  });
  it("ungültige Eingaben → null, Minuten werden begrenzt", () => {
    expect(localToIso({ date: "21.12.2026", minutes: 600 })).toBeNull();
    expect(isoToLocal("kein Datum")).toBeNull();
    expect(isoToLocal(localToIso({ date: "2026-06-21", minutes: 5000 })!)!.minutes).toBe(1439);
  });
  it("Anzeige und Vorgabe", () => {
    expect(formatMinutes(605)).toBe("10:05");
    expect(isoToLocal(defaultStudyIso(new Date(2027, 4, 2)))).toEqual({ date: "2027-03-21", minutes: 720 });
  });
});
