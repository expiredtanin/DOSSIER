// [207] Kataster-DXF: Layer „Gebaeude", „Gewaesser", „Strassen"/„Strassennamen" landen beim Import auf den Kontext-Klassen
// „12 Gebäude", „17 Gewässer", „11 Strasse" (statt auf neuen, beliebig benannten Kategorien); der Situationsplan füllt
// geschlossene Polylinien dieser Klassen (Kern `plan/situation.rs`).

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseDxf } from "./dxfParser";
import { loadFileioForTests } from "../engine/fileioWasm.testing";
import { importInto } from "./importView.testutil";
import { emptyProject } from "../model/sampleProject";

beforeAll(loadFileioForTests);

const bytes = () => new Uint8Array(readFileSync(new URL("./testdata/kataster.dxf", import.meta.url)));

describe("[207] Kataster-Layer auf Kontext-Klassen", () => {
  it("Gebäude, Gewässer und Strassen(-namen) bekommen die Klassen 12, 17, 11", () => {
    const r = importInto(emptyProject, parseDxf(bytes()), { categoryMode: "byLayer" });
    const byCode = (code: string) => r.drawings.filter((d) => d.categoryCode === code);
    expect(byCode("12").filter((d) => d.geom.shape === "polyline" && d.geom.closed)).toHaveLength(5);
    expect(byCode("17")).toHaveLength(1);
    expect(byCode("11").filter((d) => d.geom.shape === "text").map((d) => (d.geom.shape === "text" ? d.geom.text : ""))).toEqual(["Bahnhofstrasse"]);
    expect(byCode("11").filter((d) => d.geom.shape === "line")).toHaveLength(2);
    const names = new Map<string, string>();
    const walk = (ls: typeof r.project.layers) => ls.forEach((l) => (names.set(l.code, l.name), walk(l.children ?? [])));
    walk(r.project.layers);
    expect(names.get("12")).toBe("Gebäude");
    expect(names.get("17")).toBe("Gewässer");
    expect(names.get("11")).toBe("Strasse");
  });

  it("andere Layer (Parzellen, Gebäudenummer) bleiben eigene Kategorien", () => {
    const r = importInto(emptyProject, parseDxf(bytes()), { categoryMode: "byLayer" });
    const codes = new Set(r.drawings.map((d) => d.categoryCode));
    // Parzellen + Gebäudenummer = zwei weitere Codes ausser 12, 17, 11.
    expect([...codes].filter((c) => !["12", "17", "11"].includes(c))).toHaveLength(2);
  });

  it("Modus „aktive Kategorie“ ändert nichts an der Zuordnung", () => {
    const r = importInto(emptyProject, parseDxf(bytes()), { categoryMode: "active", activeCategoryCode: emptyProject.layers[0].code });
    expect(new Set(r.drawings.map((d) => d.categoryCode))).toEqual(new Set([emptyProject.layers[0].code]));
  });
});
