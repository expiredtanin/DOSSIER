import { describe, expect, it } from "vitest";
import { createPaletteDrag, DRAG_THRESHOLD_PX, registerPlanDropTarget, currentPlanDropTarget, type PlanDropTarget } from "./planDropTarget";

const MODS = { shift: false, ctrl: false, alt: false };

function fakeTarget(inside: (x: number, y: number) => boolean) {
  const log: string[] = [];
  const t: PlanDropTarget = {
    hit: inside,
    modelAt: (x, y) => ({ x: x / 100, y: y / 100 }),
    pxPerMeter: () => 100,
    move: (m) => log.push(`move ${m.x},${m.y}`),
    drop: (m) => log.push(`drop ${m.x},${m.y}`),
    cancel: () => log.push("cancel"),
  };
  return { t, log };
}

describe("Paletten-Ziehen ([253])", () => {
  it("Klick ohne Ziehen: nichts weiterreichen", () => {
    const { t, log } = fakeTarget(() => true);
    const d = createPaletteDrag(() => t);
    d.down(10, 10);
    d.move(10 + DRAG_THRESHOLD_PX - 1, 10, MODS);
    expect(d.up(12, 10, MODS)).toBe("click");
    expect(log).toEqual([]);
  });

  it("Ziehen über die Fläche und Loslassen setzt den Punkt", () => {
    const { t, log } = fakeTarget((x) => x >= 100);
    const d = createPaletteDrag(() => t);
    d.down(10, 10);
    d.move(50, 10, MODS); // schon gezogen, aber noch ausserhalb: keine Vorschau
    d.move(200, 100, MODS);
    expect(d.dragging()).toBe(true);
    expect(d.up(300, 100, MODS)).toBe("dropped");
    expect(log).toEqual(["move 2,1", "drop 3,1"]);
  });

  it("Loslassen ausserhalb der Fläche bricht ab", () => {
    const { t, log } = fakeTarget((x) => x >= 100);
    const d = createPaletteDrag(() => t);
    d.down(10, 10);
    d.move(200, 10, MODS);
    expect(d.up(20, 10, MODS)).toBe("cancelled");
    expect(log).toEqual(["move 2,0.1", "cancel"]);
  });

  it("Esc bricht ab; das folgende Loslassen tut nichts mehr", () => {
    const { t, log } = fakeTarget(() => true);
    const d = createPaletteDrag(() => t);
    d.down(0, 0);
    d.move(50, 0, MODS);
    d.abort();
    expect(log).toEqual(["move 0.5,0", "cancel"]);
    expect(d.up(60, 0, MODS)).toBe("idle");
    expect(log).toHaveLength(2);
  });

  it("Esc ohne Ziehen lässt den Befehl dem Befehlsfeld", () => {
    const { t, log } = fakeTarget(() => true);
    const d = createPaletteDrag(() => t);
    d.down(0, 0);
    d.abort();
    expect(log).toEqual([]);
  });

  it("ohne Plan-Ansicht bricht das Ziehen ab", () => {
    const d = createPaletteDrag(() => null);
    d.down(0, 0);
    d.move(50, 0, MODS);
    expect(d.up(50, 0, MODS)).toBe("cancelled");
  });

  it("Registrierung: die jüngste gilt, Abmelden nur der eigenen", () => {
    const a = fakeTarget(() => true).t;
    const b = fakeTarget(() => true).t;
    const offA = registerPlanDropTarget(a);
    const offB = registerPlanDropTarget(b);
    expect(currentPlanDropTarget()).toBe(b);
    offA();
    expect(currentPlanDropTarget()).toBe(b);
    offB();
    expect(currentPlanDropTarget()).toBe(null);
  });
});
