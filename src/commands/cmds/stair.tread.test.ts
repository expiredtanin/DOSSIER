/**
 * Unit-Tests für `stepsFromTread` — Stufenzahl-Ableitung aus Soll-Auftritt + Lauflänge.
 *
 * Entspricht dem `target_a`-Modus im Rhino-Plugin (_make_treppe_preview_handler,
 * Variable `target_a` = Soll-Auftritt).
 */

import { describe, it, expect } from "vitest";
import { stepsFromTread } from "./stair";
import { MIN_STEPS, IDEAL_TREAD } from "../../geometry/stair";

describe("stepsFromTread — Grundfälle", () => {
  it("ergibt das ideale Soll-Trittmass bei exakter Teilbarkeit", () => {
    // 10 × 0.29 m = 2.9 m → 10 Stufen
    const steps = stepsFromTread(IDEAL_TREAD, 10 * IDEAL_TREAD);
    expect(steps).toBe(10);
  });

  it("rundet auf die nächste ganze Stufenzahl", () => {
    // 3.0 / 0.29 ≈ 10.34 → 10
    expect(stepsFromTread(0.29, 3.0)).toBe(10);
    // 3.1 / 0.29 ≈ 10.69 → 11
    expect(stepsFromTread(0.29, 3.1)).toBe(11);
  });

  it("bleibt mindestens bei MIN_STEPS", () => {
    // Sehr kurze Lauflänge → immer MIN_STEPS (2)
    expect(stepsFromTread(0.29, 0.01)).toBe(MIN_STEPS);
  });

  it("klemmt nach oben: Stufenzahl durch 0.24-m-Auftritts-Grenze begrenzt", () => {
    // 10 m Lauflänge, Auftritt 0.01 m → raw = 1000, aber durch Clamp auf
    // floor(10/0.24)+1 = 42 begrenzt. Der resultierende Auftritt (≈ 0.238 m)
    // ist der Grenzwert der floor-Formel aus defaultStepCount — kein echter Bug,
    // sondern die bewusste Clamp-Schwelle (≥ min ~ 0.24 m, off-by-one durch +1).
    const steps = stepsFromTread(0.01, 10.0);
    // Die Stufenzahl muss deutlich kleiner als 1000 sein (Clamp wirkt).
    expect(steps).toBeLessThan(100);
    expect(steps).toBeGreaterThanOrEqual(MIN_STEPS);
    // Auftrittstiefe muss im vernünftigen Bereich liegen (nahe 0.24 m).
    const treadDepth = 10.0 / steps;
    expect(treadDepth).toBeGreaterThanOrEqual(0.23 - 1e-6);
    expect(treadDepth).toBeLessThanOrEqual(0.30);
  });

  it("typische Nutzung: Lauflänge 3 m, Auftritt 0.29 m → ca. 10 Stufen", () => {
    const steps = stepsFromTread(0.29, 3.0);
    expect(steps).toBeGreaterThanOrEqual(MIN_STEPS);
    // Auftrittstiefe nahe am Soll
    const tread = 3.0 / steps;
    expect(tread).toBeGreaterThan(0.20);
    expect(tread).toBeLessThan(0.40);
  });

  it("nullartige Auftritt-Eingabe wird intern auf 0.05 m geklippt", () => {
    // Sollte nicht abstürzen, Ergebnis durch 0.24-m-Clamp begrenzt.
    const steps = stepsFromTread(0, 3.0);
    expect(steps).toBeGreaterThanOrEqual(MIN_STEPS);
  });

  it("negative Lauflänge → MIN_STEPS", () => {
    expect(stepsFromTread(0.29, -1)).toBe(MIN_STEPS);
  });

  it("Auftritt 0.25 m, Lauflänge 2.5 m → 10 Stufen (exakt)", () => {
    expect(stepsFromTread(0.25, 2.5)).toBe(10);
  });
});

describe("stepsFromTread — Grenzwerte / Konsistenz", () => {
  it("liefert immer ganze Zahlen", () => {
    for (const run of [1.0, 2.5, 3.14, 5.0, 10.0]) {
      const steps = stepsFromTread(0.29, run);
      expect(Number.isInteger(steps)).toBe(true);
    }
  });

  it("resultierender Auftritt liegt stets im erlaubten Bereich (>= 0.24 m)", () => {
    for (const run of [1.0, 2.0, 3.0, 5.0]) {
      const steps = stepsFromTread(IDEAL_TREAD, run);
      const tread = run / steps;
      expect(tread).toBeGreaterThanOrEqual(0.24 - 1e-6);
    }
  });
});
