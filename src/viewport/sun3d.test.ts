// [64] Sonne fürs 3D aus der Sonnenstudie: Schalter (Vorgabe = „Schatten im Grundriss"), Sonnenstand.
import { describe, expect, it } from "vitest";
import { sun3dFor, sun3dKey } from "./sun3d";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";

const withStudy = (study: Project["sunStudy"]): Project => ({ ...sampleProject, sunStudy: study });

describe("sun3dFor", () => {
  it("ohne Sonnenstudie: aus", () => {
    expect(sun3dFor(withStudy(undefined)).active).toBe(false);
    expect(sun3dKey(sun3dFor(withStudy(undefined)))).toBe("off");
  });
  it("Vorgabe folgt „Schatten im Grundriss“, der eigene Schalter hat Vorrang", () => {
    const when = "2026-06-21T06:30:00Z";
    expect(sun3dFor(withStudy({ when, show: false })).active).toBe(false);
    expect(sun3dFor(withStudy({ when, show: true })).active).toBe(true);
    expect(sun3dFor(withStudy({ when, show: false, shadows3d: true })).active).toBe(true);
    expect(sun3dFor(withStudy({ when, show: true, shadows3d: false })).active).toBe(false);
  });
  it("Sommermorgen: Sonne im Osten über dem Horizont; Winternacht: darunter", () => {
    const morning = sun3dFor(withStudy({ when: "2026-06-21T06:30:00Z", show: true }));
    expect(morning.azimuth).toBeGreaterThan(60);
    expect(morning.azimuth).toBeLessThan(110);
    expect(morning.elevation).toBeGreaterThan(15);
    const night = sun3dFor(withStudy({ when: "2026-12-21T20:00:00Z", show: true }));
    expect(night.active).toBe(true);
    expect(night.elevation).toBeLessThan(0);
  });
  it("ungültige Zeit: aus", () => {
    expect(sun3dFor(withStudy({ when: "kein Datum", show: true })).active).toBe(false);
  });
});
