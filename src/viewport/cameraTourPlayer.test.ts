import { describe, expect, it } from "vitest";
import { runTour } from "./cameraTourPlayer";
import type { TourKey } from "./cameraTour";
import type { ViewCamera } from "./cameraBridge";

const key = (x: number, fov = 50): TourKey => ({ position: [x, 0, 1.6], target: [x + 5, 0, 1.6], fovDeg: fov, orthoHeight: 10, ortho: false });

/** Manuelle Uhr: jeder `tick(ms)` lässt den nächsten Bildtakt laufen. */
function clock() {
  let t = 0;
  let cb: ((t: number) => void) | null = null;
  return {
    now: () => t,
    raf: (f: (t: number) => void) => {
      cb = f;
      return 1;
    },
    caf: () => {
      cb = null;
    },
    tick(ms: number) {
      t += ms;
      const f = cb;
      cb = null;
      f?.(t);
    },
    pending: () => cb !== null,
  };
}

describe("[246] Kamerafahrt abspielen", () => {
  it("setzt sofort Kamera 1, am Ende exakt die letzte; Fortschritt wächst; endet mit done", async () => {
    const c = clock();
    const views: ViewCamera[] = [];
    const progress: number[] = [];
    const run = runTour({ keys: [key(0, 40), key(10, 60)], seconds: 4, mode: "catmull", cancelOnInput: false, ...c, apply: (v) => (views.push(v), true), onProgress: (f) => progress.push(f) });
    expect(views).toHaveLength(1);
    expect(views[0]!.position[0]).toBe(0);
    c.tick(2000);
    expect(views[1]!.position[0]).toBeCloseTo(5, 9);
    expect(views[1]!.fovDeg).toBeCloseTo(50, 9);
    c.tick(2500);
    await expect(run.finished).resolves.toBe("done");
    expect(views.at(-1)!.position[0]).toBe(10);
    expect(views.at(-1)!.fovDeg).toBe(60);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(c.pending()).toBe(false);
  });

  it("cancel: keine weiteren Bilder, Ergebnis cancelled", async () => {
    const c = clock();
    let n = 0;
    const run = runTour({ keys: [key(0), key(10), key(20)], seconds: 4, mode: "smooth", cancelOnInput: false, ...c, apply: () => (n++, true) });
    c.tick(1000);
    const before = n;
    run.cancel();
    c.tick(1000);
    await expect(run.finished).resolves.toBe("cancelled");
    expect(n).toBe(before);
    expect(c.pending()).toBe(false);
  });

  it("eine Kamera: ein Bild, sofort fertig; keine Kamera: failed; apply false: failed", async () => {
    const c = clock();
    const one = runTour({ keys: [key(3)], seconds: 4, mode: "catmull", cancelOnInput: false, ...c, apply: () => true });
    await expect(one.finished).resolves.toBe("done");
    const none = runTour({ keys: [], seconds: 4, mode: "catmull", cancelOnInput: false, ...clock(), apply: () => true });
    await expect(none.finished).resolves.toBe("failed");
    const bad = runTour({ keys: [key(0), key(1)], seconds: 4, mode: "catmull", cancelOnInput: false, ...clock(), apply: () => false });
    await expect(bad.finished).resolves.toBe("failed");
  });
});
