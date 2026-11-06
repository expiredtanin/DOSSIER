import { describe, expect, it } from "vitest";
import { NativeFrameQueue } from "./nativeFrameQueue";

/** Aufruf, dessen Antwort der Test von Hand freigibt. */
function deferred() {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("NativeFrameQueue", () => {
  it("meldet den Versand synchron mit dem Aufruf, nicht erst nach der Antwort", () => {
    const q = new NativeFrameQueue();
    const log: string[] = [];
    const d = deferred();
    q.send(
      () => {
        log.push("invoke");
        return d.p;
      },
      () => log.push("overlay"),
    );
    // Noch keine Antwort — das Overlay ist trotzdem schon im selben Takt gesetzt.
    expect(log).toEqual(["invoke", "overlay"]);
  });

  it("schickt bei laufendem Aufruf nur den neuesten nach, samt dessen Overlay", async () => {
    const q = new NativeFrameQueue();
    const log: string[] = [];
    const d1 = deferred();
    const d3 = deferred();
    q.send(() => (log.push("f1"), d1.p), () => log.push("o1"));
    q.send(() => (log.push("f2"), Promise.resolve()), () => log.push("o2"));
    q.send(() => (log.push("f3"), d3.p), () => log.push("o3"));
    expect(log).toEqual(["f1", "o1"]);
    d1.resolve();
    await tick();
    // f2 wurde verworfen (nie gezeichnet) → auch sein Overlay nie angewandt.
    expect(log).toEqual(["f1", "o1", "f3", "o3"]);
    d3.resolve();
    await tick();
    q.send(() => (log.push("f4"), Promise.resolve()), () => log.push("o4"));
    expect(log.slice(-2)).toEqual(["f4", "o4"]);
  });

  it("ein fehlschlagender Aufruf blockiert die Schlange nicht", async () => {
    const errors: unknown[] = [];
    const q = new NativeFrameQueue((e) => errors.push(e));
    const log: string[] = [];
    q.send(() => Promise.reject(new Error("weg")), () => log.push("o1"));
    q.send(() => {
      throw new Error("sync");
    }, () => log.push("o2"));
    await tick();
    await tick();
    q.send(() => Promise.resolve(), () => log.push("o3"));
    expect(log).toEqual(["o1", "o2", "o3"]);
    expect(errors.length).toBe(2);
  });
});
