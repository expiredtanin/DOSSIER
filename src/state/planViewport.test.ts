// [266] Einpassen/Zoom der Oberleiste: gesperrt nur ohne Plan-Ansicht (3D), nicht in Zeichnung, Schnitt oder Ansicht.
import { describe, expect, it } from "vitest";
import { planViewMounted } from "./planViewport";

describe("planViewMounted [266]", () => {
  it("Plan-Ansicht in Geschoss, Schnitt, Ansicht, Zeichnung (z. B. Kataster-Import) und Deckenspiegel", () => {
    for (const kind of ["floor", "section", "elevation", "drawing", "ceiling"] as const) expect(planViewMounted(kind, "grundriss"), kind).toBe(true);
  });
  it("3D-Ansicht: keine Plan-Ansicht; Zeichnung und Deckenspiegel haben kein 3D und bleiben Plan", () => {
    expect(planViewMounted("floor", "perspektive")).toBe(false);
    expect(planViewMounted("section", "perspektive")).toBe(false);
    expect(planViewMounted("elevation", "perspektive")).toBe(false);
    expect(planViewMounted("drawing", "perspektive")).toBe(true);
    expect(planViewMounted("ceiling", "perspektive")).toBe(true);
  });
});
