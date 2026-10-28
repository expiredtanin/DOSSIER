import { describe, expect, it } from "vitest";
import "../engine/fileioWasm.setup";
import { applyRoomProgram, cellNumber, detectHeaderRow, importedRows, mapRows, parseKind, readSheetFile, suggestMapping } from "./roomProgramImport";
import type { SheetCell } from "./roomProgramImport";
import { emptyProject } from "../model/sampleProject";

const enc = (s: string) => new TextEncoder().encode(s);

describe("cellNumber", () => {
  it("Zahlen mit Komma, Apostroph und Einheit", () => {
    expect(cellNumber(12.5)).toBe(12.5);
    expect(cellNumber("1'250,5")).toBe(1250.5);
    expect(cellNumber("28,5 m²")).toBe(28.5);
    expect(cellNumber("abc")).toBeNull();
    expect(cellNumber("")).toBeNull();
    expect(cellNumber(null)).toBeNull();
  });
});

describe("readSheetFile", () => {
  it("liest CSV mit Semikolon und Dezimalkomma", async () => {
    const sheets = await readSheetFile(enc("Raum;Fläche;Anzahl\nWohnen;28,5;1\n"), "p.csv");
    expect(sheets).toHaveLength(1);
    expect(sheets[0].rows[1]).toEqual(["Wohnen", "28,5", "1"]);
  });
  it("kaputte Datei → Fehler statt Absturz", async () => {
    await expect(readSheetFile(enc(""), "x.xlsx")).rejects.toBeDefined();
  });
});

const T: SheetCell[][] = [
  ["Raumprogramm Schulhaus", null, null, null],
  [null, null, null, null],
  ["Raum", "Fläche [m²]", "Anzahl", "Bemerkung", "Flächenart"],
  ["Unterricht", null, null, null],
  ["Klassenzimmer", "72,0", 6, "hell", "HNF"],
  ["Gruppenraum", 36, 4, null, "Hauptnutzfläche"],
  ["Total", 576, 10, null, null],
  ["Lehrerzimmer", "1'050,5", null, null, "xyz"],
  [null, null, null, null, null],
  [null, 1626.5, null, null, null],
];

describe("Zuordnung", () => {
  it("erkennt Kopfzeile und Spalten", () => {
    expect(detectHeaderRow(T)).toBe(2);
    const m = suggestMapping(T);
    expect(m.headerRow).toBe(2);
    expect(m.columns).toEqual({ name: 0, area: 1, count: 2, note: 3, kind: 4 });
  });
  it("englische und französische Überschriften", () => {
    expect(suggestMapping([["Room name", "Area (m2)", "Qty"], ["A", 10, 1]]).columns).toEqual({ name: 0, area: 1, count: 2 });
    expect(suggestMapping([["Désignation", "Surface", "Nombre", "Étage"], ["A", 10, 1, "EG"]]).columns).toEqual({ name: 0, area: 1, count: 2, group: 3 });
    expect(suggestMapping([["Bezeichnung", "m2", "Stk"], ["A", 10, 1]]).columns).toEqual({ name: 0, area: 1, count: 2 });
  });
  it("ohne Kopfzeile: Spalten aus den Daten", () => {
    const m = suggestMapping([["Küche", 12.5, 1], ["Bad", 6, 2], ["Zimmer", 14, 3]]);
    expect(m.headerRow).toBeNull();
    expect(m.columns).toEqual({ name: 0, area: 1, count: 2 });
  });
  it("Zeilen: Gruppentitel, Summenzeilen, Flächenart, Komma/Apostroph", () => {
    const m = suggestMapping(T);
    const lines = mapRows(T, m);
    const rows = importedRows(lines);
    expect(rows).toEqual([
      { name: "Klassenzimmer", area: 72, count: 6, siaCategory: "HNF", group: "Unterricht", note: "hell" },
      { name: "Gruppenraum", area: 36, count: 4, siaCategory: "HNF", group: "Unterricht" },
      { name: "Lehrerzimmer", area: 1050.5, group: "Unterricht" },
    ]);
    const by = Object.fromEntries(lines.map((l) => [l.sheetRow, l]));
    expect(by[3].groupHeading).toBe("Unterricht");
    expect(by[6].skip).toBe("sum");
    expect(by[7].unknownKind).toBe("xyz");
    expect(by[8].skip).toBe("empty");
    expect(by[9].skip).toBe("noName"); // Summe ohne Name, aber nicht gleich der laufenden Summe
    expect(mapRows(T, m, { skipSums: false }).find((l) => l.sheetRow === 6)?.row?.name).toBe("Total");
  });
  it("Summe ohne Namen, gleich der laufenden Summe, wird übersprungen", () => {
    const rows: SheetCell[][] = [["Raum", "Fläche"], ["A", 10], ["B", 20], [null, 30], ["C", 5]];
    const lines = mapRows(rows, suggestMapping(rows));
    expect(lines[3].skip).toBe("sum");
    expect(importedRows(lines).map((r) => r.name)).toEqual(["A", "B", "C"]);
  });
  it("Gruppenspalte hat Vorrang vor Zwischentiteln", () => {
    const rows: SheetCell[][] = [["Raum", "Fläche", "Geschoss"], ["A", 10, "EG"], ["B", 20, "OG"]];
    expect(importedRows(mapRows(rows, suggestMapping(rows))).map((r) => r.group)).toEqual(["EG", "OG"]);
  });
  it("Flächenart erkennen", () => {
    expect(parseKind("HNF 1.1")).toBe("HNF");
    expect(parseKind("Verkehrsfläche")).toBe("VF");
    expect(parseKind("foo")).toBeUndefined();
  });
});

describe("applyRoomProgram", () => {
  const p = { ...emptyProject, roomProgram: [{ name: "Alt", area: 5 }] };
  it("ersetzen und anhängen", () => {
    expect(applyRoomProgram(p, [{ name: "Neu", area: 9 }], "replace").roomProgram).toEqual([{ name: "Neu", area: 9 }]);
    expect(applyRoomProgram(p, [{ name: "Neu", area: 9 }], "append").roomProgram).toHaveLength(2);
    expect(applyRoomProgram(p, [], "replace")).toBe(p);
  });
});
