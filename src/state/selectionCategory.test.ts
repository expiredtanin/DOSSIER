import { describe, expect, it } from "vitest";
import { applyOps } from "../core/ops";
import { sampleProject } from "../model/sampleProject";
import { emptySelection } from "./selection";
import { categoryOpsForSelection, selectionCounts } from "./selectionCategory";

describe("categoryOpsForSelection", () => {
  // [287] (6) Klasse im Objekt-Info-Kopf gilt für die ganze Auswahl, nicht nur für das erste Element.
  it("setzt die Klasse für alle gewählten Wände und Öffnungen", () => {
    const p = sampleProject;
    const walls = p.walls.slice(0, 2).map((w) => w.id);
    const op = (p.openings ?? [])[0].id;
    const sel = { ...emptySelection(), walls, openings: [op] };
    const next = applyOps(p, categoryOpsForSelection(p, sel, "99"));
    expect(next.walls.filter((w) => w.categoryCode === "99").map((w) => w.id)).toEqual(walls);
    expect(next.openings?.find((o) => o.id === op)?.categoryCode).toBe("99");
    expect(selectionCounts(sel)).toEqual([{ kind: "walls", n: 2 }, { kind: "openings", n: 1 }]);
  });
});
