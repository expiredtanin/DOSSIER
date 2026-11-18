import { describe, expect, it } from "vitest";
import { FrameScheduler, countFrame, frameCounters } from "./renderOnDemand";

function fakeRaf() {
  const q = new Map<number, (t: number) => void>();
  let next = 1;
  return {
    raf: (cb: (t: number) => void) => {
      q.set(next, cb);
      return next++;
    },
    caf: (id: number) => void q.delete(id),
    tick() {
      const cbs = [...q.values()];
      q.clear();
      for (const cb of cbs) cb(0);
    },
    get size() {
      return q.size;
    },
  };
}

describe("[290] FrameScheduler: zeichnen nur auf Anforderung", () => {
  it("viele Anforderungen im selben Bildschirm-Frame zeichnen einmal", () => {
    const f = fakeRaf();
    let n = 0;
    const s = new FrameScheduler(() => n++, f.raf, f.caf);
    for (let i = 0; i < 1000; i++) s.request(); // z. B. 1000-Hz-Maus beim Drehen
    expect(s.pending).toBe(true);
    f.tick();
    expect(n).toBe(1);
    expect(s.pending).toBe(false);
  });

  it("ohne Anforderung keine Schleife und keine Frames", () => {
    const f = fakeRaf();
    let n = 0;
    const s = new FrameScheduler(() => n++, f.raf, f.caf);
    s.request();
    f.tick();
    for (let i = 0; i < 10; i++) f.tick();
    expect(n).toBe(1);
    expect(f.size).toBe(0);
  });

  it("flush zeichnet sofort, cancel verwirft", () => {
    const f = fakeRaf();
    let n = 0;
    const s = new FrameScheduler(() => n++, f.raf, f.caf);
    s.flush();
    expect(n).toBe(0);
    s.request();
    s.flush();
    expect(n).toBe(1);
    f.tick();
    expect(n).toBe(1);
    s.request();
    s.cancel();
    f.tick();
    expect(n).toBe(1);
  });

  it("Frame-Zähler", () => {
    const before = frameCounters()["3d"];
    countFrame("3d");
    expect(frameCounters()["3d"]).toBe(before + 1);
  });
});
