// Tests für die SIA-416-Flächenbilanz (roomArea.ts): Roll-up-Hierarchie,
// insbesondere die Einhängung der Kategorie AGF (Aussengeschossfläche).

import { describe, expect, it } from "vitest";
import { core } from "../engine/coreWasm";
import { balance, centroid, evaluateRoom, polygonArea, roomsToCsv, SIA_CATEGORIES, siaLabel } from "./roomArea";

describe("Kern-Anbindung", () => {
  it("Kategorie-Namen und -Reihenfolge stimmen mit dem Rust-Kern überein", () => {
    expect(core().room_sia_categories()).toEqual([...SIA_CATEGORIES]);
  });

  it("evaluateRoom: Brutto/Netto/Umfang/Schwerpunkt, Abzug geklemmt", () => {
    const r = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];
    const e = evaluateRoom(r, "NNF", { deduction: 2 });
    expect(e).toMatchObject({ grossArea: 12, netArea: 10, perimeter: 14, category: "NNF", label: "Nebennutzfläche" });
    expect(e.centroid).toEqual({ x: 2, y: 1.5 });
    expect(evaluateRoom(r, "HNF", { deduction: 99 }).netArea).toBe(0);
    expect(evaluateRoom(r, "HNF", { deduction: -1 }).netArea).toBe(12);
    expect(polygonArea([...r].reverse())).toBe(12);
    expect(centroid([])).toEqual({ x: 0, y: 0 });
  });

  it("Unsinn ergibt NaN statt Fehler", () => {
    expect(polygonArea([{ x: Number.NaN, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }])).toBeNaN();
    expect(balance([{ category: "HNF", area: Number.NaN }]).total).toBe(0);
  });
});

describe("SIA_CATEGORIES", () => {
  it("enthält AGF als Blatt-Kategorie", () => {
    expect(SIA_CATEGORIES).toContain("AGF");
  });

  it("liefert das deutsche Label für AGF", () => {
    expect(siaLabel("AGF")).toBe("Aussengeschossfläche");
  });
});

describe("balance() — Roll-up-Hierarchie", () => {
  it("rollt HNF/NNF/VF/FF/KGF wie bisher auf (Referenzfall ohne AGF)", () => {
    const bal = balance([
      { category: "HNF", area: 20 },
      { category: "NNF", area: 5 },
      { category: "VF", area: 8 },
      { category: "FF", area: 2 },
      { category: "KGF", area: 10 },
    ]);
    expect(bal.byKey.NF).toBeCloseTo(25);
    expect(bal.byKey.NGF).toBeCloseTo(35);
    expect(bal.byKey.GF).toBeCloseTo(45);
    expect(bal.byKey.AGF).toBe(0);
  });

  it("zählt AGF zur GF, aber NICHT zu NF/NGF", () => {
    const bal = balance([
      { category: "HNF", area: 20 },
      { category: "AGF", area: 12 },
    ]);
    // NGF bleibt unverändert (nur HNF trägt bei) — AGF fliesst hier nicht ein.
    expect(bal.byKey.NF).toBeCloseTo(20);
    expect(bal.byKey.NGF).toBeCloseTo(20);
    // GF = NGF + KGF + AGF = 20 + 0 + 12
    expect(bal.byKey.AGF).toBeCloseTo(12);
    expect(bal.byKey.GF).toBeCloseTo(32);
    expect(bal.total).toBeCloseTo(32);
  });

  it("GF = NGF + KGF + AGF bei gemischter Belegung", () => {
    const bal = balance([
      { category: "HNF", area: 40 },
      { category: "NNF", area: 6 },
      { category: "VF", area: 9 },
      { category: "FF", area: 3 },
      { category: "KGF", area: 15 },
      { category: "AGF", area: 7.5 },
    ]);
    expect(bal.byKey.NF).toBeCloseTo(46);
    expect(bal.byKey.NGF).toBeCloseTo(58);
    expect(bal.byKey.KGF).toBeCloseTo(15);
    expect(bal.byKey.AGF).toBeCloseTo(7.5);
    expect(bal.byKey.GF).toBeCloseTo(bal.byKey.NGF + bal.byKey.KGF + bal.byKey.AGF);
    expect(bal.byKey.GF).toBeCloseTo(80.5);
    expect(bal.total).toBeCloseTo(80.5);
  });

  it("führt eine eigene Bilanzzeile für AGF, positioniert nach KGF und vor GF", () => {
    const bal = balance([{ category: "AGF", area: 4 }]);
    const keys = bal.rows.map((r) => r.key);
    expect(keys).toEqual(["HNF", "NNF", "NF", "VF", "FF", "NGF", "KGF", "AGF", "GF"]);
    const agfRow = bal.rows.find((r) => r.key === "AGF");
    expect(agfRow).toBeDefined();
    expect(agfRow?.aggregate).toBe(false);
    expect(agfRow?.area).toBeCloseTo(4);
    expect(agfRow?.count).toBe(1);
  });
});

describe("roomsToCsv() — Bilanzblock mit AGF", () => {
  it("weist einen Raum mit Kategorie AGF in Raumliste und Bilanz korrekt aus", () => {
    const csv = roomsToCsv([
      { number: "R.01", name: "Wohnen", category: "HNF", area: 20 },
      { number: "R.02", name: "Balkon", category: "AGF", area: 6 },
    ]);
    const lines = csv.split("\r\n");

    // Raumliste enthält den AGF-Raum mit Kategorie + Label.
    const roomLine = lines.find((l) => l.startsWith("R.02"));
    expect(roomLine).toBeDefined();
    expect(roomLine).toContain("AGF");
    expect(roomLine).toContain("Aussengeschossfläche");
    expect(roomLine).toContain("6.00");

    // Bilanzblock enthält eine AGF-Zeile mit der Fläche des Raums.
    const balanceAgfLine = lines.find((l) => l.includes(";AGF;"));
    expect(balanceAgfLine).toBeDefined();
    expect(balanceAgfLine).toContain("Aussengeschossfläche");
    expect(balanceAgfLine).toContain("6.00");

    // GF-Summe berücksichtigt AGF (20 HNF + 6 AGF = 26).
    const gfLine = lines.find((l) => l.includes(";GF;"));
    expect(gfLine).toBeDefined();
    expect(gfLine).toContain("26.00");
  });
});
