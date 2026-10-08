import { describe, expect, it } from "vitest";
import { hudSegments } from "./hudFormat";

describe("hudSegments — Cursor-HUD-Formatierung (2D + 3D gemeinsam)", () => {
  it("liefert L/W bei length+angleDeg ohne Feld-Zustand", () => {
    const segs = hudSegments({ at: { x: 0, y: 0 }, length: 3, angleDeg: 45 }, null);
    expect(segs).toEqual([
      { text: "L: 3.000m", active: false, locked: false },
      { text: "W: 45.000°", active: false, locked: false },
    ]);
  });

  it("liefert Δx/Δy, wenn dx+dy gesetzt sind (Rechteck-Werkzeug)", () => {
    const segs = hudSegments({ at: { x: 0, y: 0 }, dx: 2, dy: 1.5 }, null);
    expect(segs).toEqual([
      { text: "Δx: 2.000m", active: false, locked: false },
      { text: "Δy: 1.500m", active: false, locked: false },
    ]);
  });

  it("fällt auf freien Text zurück (z. B. Radius/Fläche), wenn kein L/W/Δ-Paar vorliegt", () => {
    const segs = hudSegments({ at: { x: 0, y: 0 }, text: "r: 1.200m" }, null);
    expect(segs).toEqual([{ text: "r: 1.200m", active: false, locked: false }]);
  });

  it("liefert nichts ohne jegliche HUD-Angabe", () => {
    expect(hudSegments({ at: { x: 0, y: 0 } }, null)).toEqual([]);
  });

  it("spiegelt den Tab-Feld-Zyklus-Zustand (gelockt/live/aktiv), sobald hudFields gesetzt ist", () => {
    const segs = hudSegments(
      { at: { x: 0, y: 0 }, length: 3, angleDeg: 45 },
      {
        fields: [
          { id: "length", value: 5, locked: true, active: false },
          { id: "angle", value: null, locked: false, active: true },
        ],
        typed: "",
      },
    );
    expect(segs).toEqual([
      { text: "L: 5.000m", active: false, locked: true },
      { text: "W: 45.000°", active: true, locked: false },
    ]);
  });

  it("zeigt den LIVE getippten Text im aktiven Feld statt des gelockten/live Werts", () => {
    const segs = hudSegments(
      { at: { x: 0, y: 0 }, length: 3, angleDeg: 45 },
      {
        fields: [{ id: "length", value: null, locked: false, active: true }],
        typed: "2.5",
      },
    );
    expect(segs).toEqual([{ text: "L: 2.5m", active: true, locked: false }]);
  });
});
