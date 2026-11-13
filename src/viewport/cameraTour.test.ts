import { describe, expect, it } from "vitest";
import type { Camera, Project } from "../model/types";
import { emptyProject } from "../model/sampleProject";
import { TOUR_DEFAULT_SECONDS, clampSeconds, sampleToView, sampleTour, tourDuration, tourKeys, type TourKey, type TourMode } from "./cameraTour";

const project = (): Project => ({
  ...emptyProject,
  drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false, baseElevation: 0, floorHeight: 2.8 } as Project["drawingLevels"][number]],
});

const cam = (id: string, x: number, y: number, over: Partial<Camera> = {}): Camera => ({
  id,
  type: "camera",
  name: id,
  floorId: "eg",
  categoryCode: "92",
  position: { x, y },
  eyeHeight: 1.6,
  target: { x: x + 5, y },
  targetHeight: 1.6,
  fovDeg: 50,
  projection: "perspective",
  ...over,
});

const keys3 = (): TourKey[] => tourKeys(project(), [cam("a", 0, 0, { fovDeg: 40 }), cam("b", 10, 5, { fovDeg: 60 }), cam("c", 20, -5, { fovDeg: 80 })]);
const modes: TourMode[] = ["catmull", "smooth"];

describe("[246] Kamerafahrt: Interpolation", () => {
  it("Stützpunkte aus Kameras: Standpunkt über Geschoss-OK, unbrauchbare fallen weg", () => {
    const k = tourKeys(project(), [cam("a", 1, 2), cam("kaputt", 0, 0, { target: { x: 0, y: 0 }, targetHeight: 1.6 }), cam("n", Number.NaN, 0)]);
    expect(k).toHaveLength(1);
    expect(k[0]!.position).toEqual([1, 2, 1.6]);
    expect(k[0]!.target).toEqual([6, 2, 1.6]);
  });

  it("Dauer: (n−1) Abschnitte, geklemmt, Vorgabe 4 s", () => {
    expect(TOUR_DEFAULT_SECONDS).toBe(4);
    expect(tourDuration(0, 4)).toBe(0);
    expect(tourDuration(1, 4)).toBe(0);
    expect(tourDuration(2, 4)).toBe(4);
    expect(tourDuration(5, 2.5)).toBe(10);
    expect(clampSeconds(0)).toBe(0.5);
    expect(clampSeconds(1e6)).toBe(60);
    expect(clampSeconds(Number.NaN)).toBe(4);
  });

  for (const mode of modes) {
    describe(mode, () => {
      it("Endpunkte und Abschnittsgrenzen exakt, ausserhalb geklemmt", () => {
        const k = keys3();
        expect(sampleTour(k, 4, mode, 0)).toEqual(k[0]);
        expect(sampleTour(k, 4, mode, 4)).toEqual(k[1]);
        expect(sampleTour(k, 4, mode, 8)).toEqual(k[2]);
        expect(sampleTour(k, 4, mode, -3)).toEqual(k[0]);
        expect(sampleTour(k, 4, mode, 99)).toEqual(k[2]);
        expect(sampleTour(k, 4, mode, Number.NaN)).toEqual(k[0]);
      });

      it("stetig: kleine Zeitschritte → kleine Sprünge, auch über die Stützpunkte hinweg", () => {
        const k = keys3();
        let prev = sampleTour(k, 4, mode, 0)!;
        let maxStep = 0;
        for (let t = 0.01; t <= 8.0001; t += 0.01) {
          const s = sampleTour(k, 4, mode, t)!;
          maxStep = Math.max(maxStep, Math.hypot(s.position[0] - prev.position[0], s.position[1] - prev.position[1], s.position[2] - prev.position[2]));
          expect(Math.abs(s.fovDeg - prev.fovDeg)).toBeLessThan(0.2);
          prev = s;
        }
        // 20 m in 8 s ≈ 2,5 m/s → 0,025 m je Schritt; auch Spitzen bleiben weit unter einem Sprung.
        expect(maxStep).toBeLessThan(0.1);
      });

      it("Bildwinkel liegt zwischen den Nachbarkameras", () => {
        const k = keys3();
        const s = sampleTour(k, 4, mode, 2)!;
        expect(s.fovDeg).toBeGreaterThan(40);
        expect(s.fovDeg).toBeLessThan(60);
      });
    });
  }

  it("Bildwinkel linear (flüssig): Mitte des Abschnitts = Mittelwert", () => {
    expect(sampleTour(keys3(), 4, "catmull", 2)!.fovDeg).toBeCloseTo(50, 12);
    expect(sampleTour(keys3(), 4, "catmull", 6)!.fovDeg).toBeCloseTo(70, 12);
  });

  it("zwei Kameras, flüssig: Mitte liegt auf der Strecke, Zeit ändert die Dauer nur über Abschnittslänge", () => {
    const k = tourKeys(project(), [cam("a", 0, 0), cam("b", 10, 0)]);
    const mid = sampleTour(k, 4, "catmull", 2)!;
    expect(mid.position[0]).toBeCloseTo(5, 9);
    expect(mid.position[1]).toBeCloseTo(0, 9);
    // Endpunkte doppelt → sanftes Anfahren: im ersten Viertel weniger als ein Viertel der Strecke.
    expect(sampleTour(k, 4, "catmull", 1)!.position[0]).toBeLessThan(2.5);
    // andere Abschnittsdauer: gleiche Stelle bei doppelter Zeit
    expect(sampleTour(k, 8, "catmull", 4)!.position[0]).toBeCloseTo(5, 9);
    expect(sampleTour(k, 8, "catmull", 8)!).toEqual(k[1]);
  });

  it("eine Kamera hält ihre Sicht, keine liefert null", () => {
    const k = tourKeys(project(), [cam("a", 3, 4)]);
    expect(sampleTour(k, 4, "catmull", 0)).toEqual(k[0]);
    expect(sampleTour(k, 4, "smooth", 123)).toEqual(k[0]);
    expect(sampleTour([], 4, "catmull", 0)).toBeNull();
  });

  it("Sicht: Blickrichtung normiert, Up senkrecht; Standpunkt = Ziel → null", () => {
    const s = sampleTour(keys3(), 4, "catmull", 3)!;
    const v = sampleToView(s, 2)!;
    expect(v.kind).toBe("perspective");
    expect(v.aspect).toBe(2);
    expect(Math.hypot(...v.direction)).toBeCloseTo(1, 12);
    expect(v.up[0] * v.direction[0] + v.up[1] * v.direction[1] + v.up[2] * v.direction[2]).toBeCloseTo(0, 12);
    expect(sampleToView({ ...s, target: s.position })).toBeNull();
  });

  it("Axonometrie: Art wechselt in der Mitte, Sichthöhe linear", () => {
    const k = tourKeys(project(), [cam("a", 0, 0, { projection: "perspective" }), cam("b", 10, 0, { projection: "axonometric" as Camera["projection"], orthoHeight: 20 })]);
    const early = sampleTour(k, 4, "catmull", 1)!;
    const late = sampleTour(k, 4, "catmull", 3)!;
    expect(early.ortho).toBe(false);
    expect(late.ortho).toBe(true);
    expect(sampleToView(late)!.kind).toBe("orthogonal");
    expect(late.orthoHeight).toBeGreaterThan(sampleTour(k, 4, "catmull", 2)!.orthoHeight);
  });
});
