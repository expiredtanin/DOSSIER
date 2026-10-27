/**
 * `polyUsesPattern` für Verlauf-Schraffuren (`kind === "gradient"`) — muss
 * wie bei Bild-Schraffuren `true` liefern, damit die PlanView tatsächlich
 * einen `<linearGradient>`/`<radialGradient>`-Eintrag in `<defs>` anlegt
 * (sonst bliebe die Fläche ohne jede sichtbare Füllung, da `fill="url(#…)"`
 * ins Leere zeigen würde). JSX-Rendering selbst wird in diesem Projekt nicht
 * per Testing-Library geprüft (keine `.test.tsx`-Dateien) — die eigentliche
 * `<linearGradient>`/`<radialGradient>`-Erzeugung bleibt manuelle Prüfung
 * (s. PENDENZEN.md „Nutzer prüft in der Tauri-App").
 */

import { describe, expect, it } from "vitest";
import { polyUsesPattern } from "./primitives";
import type { HatchRender } from "../../../plan/generatePlan/shared";

function hatch(over: Partial<HatchRender> = {}): HatchRender {
  return {
    pattern: "none",
    scale: 1,
    angle: 0,
    color: "#123456",
    lineWeight: 0.13,
    dash: null,
    ...over,
  };
}

describe("polyUsesPattern — gradient", () => {
  it("kind:'gradient' MIT gesetzten Verlauf-Parametern → true (defs-Eintrag nötig)", () => {
    expect(
      polyUsesPattern(
        hatch({ kind: "gradient", gradient: { color1: "#fff", color2: "#000", angle: 0, type: "linear" } }),
      ),
    ).toBe(true);
  });

  it("kind:'gradient' OHNE gesetzte Verlauf-Parameter (Inkonsistenz) → false, kein leerer defs-Eintrag", () => {
    expect(polyUsesPattern(hatch({ kind: "gradient" }))).toBe(false);
  });

  it("kind:'vector' (Default) bleibt unverändert vom `pattern`-Feld gesteuert", () => {
    expect(polyUsesPattern(hatch({ pattern: "diagonal" }))).toBe(true);
    expect(polyUsesPattern(hatch({ pattern: "none" }))).toBe(false);
  });
});
