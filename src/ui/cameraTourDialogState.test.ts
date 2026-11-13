import { describe, expect, it } from "vitest";
import { TOUR_FPS, canRecord, canStart, effectiveSeconds, initialTourDialogState, parseSeconds, totalSeconds, tourDialogReducer, type TourDialogAction, type TourDialogState } from "./cameraTourDialogState";

const run = (actions: TourDialogAction[], from: TourDialogState = initialTourDialogState) => actions.reduce(tourDialogReducer, from);
const open = (n = 3, formats: ("mp4" | "webm")[] = ["webm"]): TourDialogAction => ({ type: "open", cameraCount: n, formats });

describe("[246] Kamerafahrt-Dialog: Zustand", () => {
  it("Vorgabe: 4 s je Abschnitt, flüssig, 30 fps, erstes verfügbares Format", () => {
    const s = run([open(3, ["mp4", "webm"])]);
    expect(s).toMatchObject({ open: true, phase: "setup", secondsText: "4", mode: "catmull", format: "mp4", progress: 0 });
    expect(TOUR_FPS).toBe(30);
    expect(totalSeconds(s)).toBe(8);
  });

  it("Dauer: Komma, Bereichsprüfung, Start nur bei gültiger Eingabe", () => {
    expect(parseSeconds("2,5")).toBe(2.5);
    expect(parseSeconds("0.4")).toBeNull();
    expect(parseSeconds("61")).toBeNull();
    expect(parseSeconds("abc")).toBeNull();
    expect(parseSeconds("")).toBeNull();
    const bad = run([open(), { type: "seconds", text: "x" }]);
    expect(canStart(bad)).toBe(false);
    expect(effectiveSeconds(bad)).toBe(4);
    expect(run([{ type: "start", recording: false }], bad).phase).toBe("setup");
    const ok = run([open(), { type: "seconds", text: "6" }]);
    expect(totalSeconds(ok)).toBe(12);
  });

  it("Aufnehmen braucht zwei Kameras und ein Format, Abspielen reicht eine Kamera", () => {
    expect(canStart(run([open(0)]))).toBe(false);
    expect(canStart(run([open(1)]))).toBe(true);
    expect(canRecord(run([open(1)]))).toBe(false);
    expect(canRecord(run([open(2, [])]))).toBe(false);
    expect(canRecord(run([open(2)]))).toBe(true);
  });

  it("Ablauf Aufnahme: start → Fortschritt → finish → done; Fortschritt geklemmt", () => {
    let s = run([open(), { type: "start", recording: true }]);
    expect(s).toMatchObject({ phase: "running", recording: true });
    s = run([{ type: "progress", fraction: 0.4 }], s);
    expect(s.progress).toBe(0.4);
    expect(run([{ type: "progress", fraction: 7 }], s).progress).toBe(1);
    expect(run([{ type: "progress", fraction: Number.NaN }], s).progress).toBe(0);
    s = run([{ type: "finish", recording: true }], s);
    expect(s).toMatchObject({ phase: "done", progress: 1, recording: false });
    expect(run([{ type: "again" }], s).phase).toBe("setup");
  });

  it("Vorschau endet wieder im Setup; Abbruch und Fehler", () => {
    const running = run([open(), { type: "start", recording: false }]);
    expect(run([{ type: "finish", recording: false }], running).phase).toBe("setup");
    expect(run([{ type: "cancel" }], running)).toMatchObject({ phase: "setup", progress: 0 });
    expect(run([{ type: "fail", message: "kaputt" }], running)).toMatchObject({ phase: "error", message: "kaputt" });
  });

  it("Schliessen ist während des Laufs gesperrt", () => {
    const running = run([open(), { type: "start", recording: true }]);
    expect(run([{ type: "close" }], running).open).toBe(true);
    expect(run([{ type: "close" }], run([open()])).open).toBe(false);
  });
});
