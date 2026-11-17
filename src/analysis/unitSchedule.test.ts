// [278] Wohnungsspiegel: Fassade über den Kern, Ops der Oberfläche (ein Undo-Schritt), Bericht/CSV, Blatt-Tabelle, Beispielprojekt.
import { beforeEach, describe, expect, it } from "vitest";
import { withDocument } from "../core/document";
import { getState } from "../state/appStore";
import { buildWettbewerbSampleProject } from "../model/sampleProjectWettbewerb";
import type { Project } from "../model/types";
import { computeUnitSchedule, unitScheduleCsv } from "./unitSchedule";
import { buildAreaReport, areaReportToCsv, hasUnits } from "../export/areaReport";
import { sheetTables } from "../export/sheetTable";
import { patchItem } from "../core/opsBuild";
import { addUnitOps, assignRoomsOps, deleteUnitOps, draftUnit, patchUnitOps } from "../panels/unitOps";

const st = () => getState();
let wb: Project;

beforeEach(() => {
  st().loadProject(buildWettbewerbSampleProject());
  st().clearHistory();
  wb = st().project;
});

describe("Wohnungsspiegel (Beispiel Wettbewerb)", () => {
  it("sechs Wohnungen: Typ, Zimmerzahl, Fläche je Einheit; Treppenhaus/Abstellraum ohne Einheit", () => {
    const s = computeUnitSchedule(wb);
    expect(s.units.map((u) => u.name)).toEqual(["0.1", "0.2", "1.1", "1.2", "2.1", "2.2"]);
    expect(s.units.map((u) => u.typeLabel)).toEqual(["2-Zi-Whg", "2.5-Zi-Whg", "2-Zi-Whg", "2.5-Zi-Whg", "2-Zi-Whg", "2.5-Zi-Whg"]);
    expect(s.units.map((u) => u.rooms)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(s.units.map((u) => u.floors)).toEqual([["Erdgeschoss"], ["Erdgeschoss"], ["1. Obergeschoss"], ["1. Obergeschoss"], ["2. Obergeschoss"], ["2. Obergeschoss"]]);
    // HNF = Wohnen/Essen + Zimmer + Diele, NNF = Bad; NF = HNF + NNF (Handrechnung gegen die Raumliste).
    const area = (id: string) => computeUnitSchedule(wb).units.find((u) => u.id === id)!;
    const u = area("whg-eg-w");
    expect(u.hnf).toBeGreaterThan(40);
    expect(u.nnf).toBeGreaterThan(3);
    expect(u.nf).toBeCloseTo(u.hnf + u.nnf, 9);
    expect(u.agf).toBe(0);
    // Typ-Summen: je 3 Wohnungen.
    expect(s.byType.map((t) => [t.typeLabel, t.count, t.roomCount])).toEqual([["2-Zi-Whg", 3, 6], ["2.5-Zi-Whg", 3, 7.5]]);
    expect(s.total.count).toBe(6);
    expect(s.total.roomCount).toBeCloseTo(13.5, 9);
    // Geschoss-Summen: drei Geschosse mit je zwei Wohnungen.
    expect(s.byLevel.map((l) => l.count)).toEqual([2, 2, 2]);
    expect(s.byLevel.reduce((a, l) => a + l.hnf, 0)).toBeCloseTo(s.total.hnf, 9);
    // Gemeinschaftsflächen: je Geschoss Treppenhaus + Abstellraum/Eingang.
    expect(s.unassigned.rooms).toBe(6);
    expect(s.unassigned.vf).toBeGreaterThan(10);
  });

  it("CSV: Kopf und je Einheit eine Zeile; Bericht hat Spiegel, Typ- und Geschoss-Summen", () => {
    const csv = unitScheduleCsv(wb, ["Nr", "Geschoss", "Typ", "Nutzung", "Zimmer", "HNF", "NNF", "NF", "Aussen"]);
    expect(csv.trim().split("\n").length).toBe(7);
    expect(csv.split("\n")[1]).toMatch(/^0\.1;Erdgeschoss;2-Zi-Whg;living;2;\d+\.\d\d;/);
    expect(hasUnits(wb)).toBe(true);
    const r = buildAreaReport(wb, { areas: false, units: true });
    expect(r.sections.length).toBe(3);
    expect(r.sections[0].rows.length).toBe(7);
    expect(r.sections[0].rows.at(-1)!.total).toBe(true);
    expect(areaReportToCsv(r)).toContain("2.5-Zi-Whg");
    // Ohne Einheiten kein Abschnitt.
    const none: Project = { ...wb, units: undefined };
    expect(withDocument(none, () => buildAreaReport(none, { areas: false, units: true })).sections.length).toBe(0);
  });

  it("Blatt-Tabelle: Layout „Wohnungsspiegel“ rechnet mit dem Modell mit", () => {
    const lay = wb.layouts!.find((l) => l.id === "lay-wohnungsspiegel")!;
    const [t] = sheetTables(wb, lay.id);
    expect(t.total).toBe(7);
    const texts = t.prims.filter((p) => p.k === "text").map((p) => (p as { s: string }).s);
    expect(texts).toContain("2.5-Zi-Whg");
    expect(texts).toContain("1. Obergeschoss");
    // Eine Wohnung mehr im Modell: die Tabelle hat eine Zeile mehr.
    const more: Project = { ...wb, units: [...wb.units!, { id: "neu", name: "3.1", unitType: "Atelier" }] };
    const [t2] = withDocument(more, () => sheetTables(more, lay.id));
    expect(t2.total).toBe(8);
  });
});

describe("Ops der Oberfläche: eine Aktion = ein Undo-Schritt", () => {
  it("neue Einheit aus Auswahl, Zuordnen, Ändern, Löschen", () => {
    const p0 = st().project;
    const ids = ["raum-E.10", "raum-1.10"];
    const unit = draftUnit(p0, "Whg");
    expect(unit.name).toBe("Whg 7");
    st().applyChange((p: Project) => addUnitOps(p, unit, ids));
    expect(st().undoDepth).toBe(1);
    expect(st().project.units!.length).toBe(7);
    expect(st().project.rooms!.filter((r) => r.unitId === unit.id).map((r) => r.id)).toEqual(ids);
    st().undo();
    expect(st().project.units!.length).toBe(6);
    expect(st().project.rooms!.find((r) => r.id === "raum-E.10")!.unitId).toBeUndefined();

    st().applyChange((p: Project) => assignRoomsOps(p, ["raum-E.09", "raum-1.09"], "whg-eg-w"));
    expect(st().project.rooms!.find((r) => r.id === "raum-1.09")!.unitId).toBe("whg-eg-w");
    expect(computeUnitSchedule(st().project).units.find((u) => u.id === "whg-eg-w")!.floors).toEqual(["Erdgeschoss", "1. Obergeschoss"]);

    st().applyChange((p: Project) => patchUnitOps(p, "whg-eg-w", { unitType: "Maisonette" }), "unit:whg-eg-w:type");
    expect(computeUnitSchedule(st().project).units.find((u) => u.id === "whg-eg-w")!.typeLabel).toBe("Maisonette");

    const before = st().undoDepth;
    st().applyChange((p: Project) => deleteUnitOps(p, "whg-eg-w"));
    expect(st().undoDepth).toBe(before + 1);
    expect(st().project.units!.some((u) => u.id === "whg-eg-w")).toBe(false);
    expect(st().project.rooms!.some((r) => r.unitId === "whg-eg-w")).toBe(false);
    st().undo();
    expect(st().project.rooms!.filter((r) => r.unitId === "whg-eg-w").length).toBe(6);
  });

  it("alle Einheiten gelöscht: Feld verschwindet; Zimmer-Zählung eines Raums ändert den Typ", () => {
    for (const u of structuredClone(st().project.units!)) st().applyChange((p: Project) => deleteUnitOps(p, u.id));
    expect(st().project.units).toBeUndefined();
    expect(computeUnitSchedule(st().project).units).toEqual([]);
    st().clearHistory();
    st().loadProject(buildWettbewerbSampleProject());
    st().applyChange((p: Project) => patchItem(p, "rooms", "raum-E.01", { roomCount: 1.5 }));
    expect(computeUnitSchedule(st().project).units.find((u) => u.id === "whg-eg-w")!.typeLabel).toBe("2.5-Zi-Whg");
  });
});
