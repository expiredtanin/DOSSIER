// Unit-Tests für die Bauteilliste (Bauteil-Schedule CSV, AUDIT A6).
//   • Kopfzeile + eine Zeile je Bauteil-Vorkommen (2 Wände + 1 Decke).
//   • korrekte Kennwerte (Länge/Höhe/Dicke/Fläche) aus dem Modell abgeleitet.
//   • CSV-Escaping bei einem Typnamen mit Semikolon/Anführungszeichen.
//   • leeres Projekt ⇒ nur Kopfzeile (kein Crash).

import { describe, it, expect } from "vitest";
import { exportScheduleCsv, scheduleRows } from "./exportSchedule";
import type { Project, Wall, Ceiling } from "../model/types";

/** Minimalprojekt: 2 Wände (1 Wandtyp T=0.4) + 1 Decke (Deckentyp T=0.2). */
function fixtureProject(): Project {
  const walls: Wall[] = [
    {
      id: "W1",
      type: "wall",
      floorId: "eg",
      categoryCode: "20",
      start: { x: 0, y: 0 },
      end: { x: 5, y: 0 }, // Länge 5
      wallTypeId: "aw",
      height: 2.6,
    },
    {
      id: "W2",
      type: "wall",
      floorId: "eg",
      categoryCode: "20",
      start: { x: 5, y: 0 },
      end: { x: 5, y: 4 }, // Länge 4
      wallTypeId: "aw",
      height: 2.6,
    },
  ];
  const ceilings: Ceiling[] = [
    {
      id: "D1",
      type: "ceiling",
      floorId: "eg",
      categoryCode: "30",
      outline: [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 4 },
        { x: 0, y: 4 },
      ], // 5×4 = 20 m²
      wallTypeId: "dt",
      ceilingTypeId: "dt",
    },
  ];
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [{ id: "c", name: "C", color: "#ccc", hatchId: "none", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "Aussenwand", layers: [{ componentId: "c", thickness: 0.4 }] }],
    ceilingTypes: [{ id: "dt", name: "Betondecke", layers: [{ componentId: "c", thickness: 0.2 }] }],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls,
    doors: [],
    openings: [],
    ceilings,
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  } as Project;
}

describe("exportScheduleCsv — Bauteilliste", () => {
  it("liefert Kopfzeile + je Bauteil eine Zeile mit korrekten Kennwerten", () => {
    const csv = exportScheduleCsv(fixtureProject(), { includeSummary: false });
    const lines = csv.split("\r\n");

    // Kopfzeile + 3 Bauteil-Zeilen (2 Wände, 1 Decke).
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("Typ;ID;Bauteil;Geschoss;Länge [m];Höhe [m];Dicke [m];Fläche [m²]");

    // Wand W1: Länge 5, Höhe 2.6, Dicke 0.4, Ansichtsfläche 13.
    expect(lines[1]).toBe("Wand;W1;Aussenwand;EG;5.00;2.60;0.40;13.00");
    // Wand W2: Länge 4, Ansichtsfläche 10.40.
    expect(lines[2]).toBe("Wand;W2;Aussenwand;EG;4.00;2.60;0.40;10.40");
    // Decke D1: keine Länge/Höhe, Dicke 0.2, Grundrissfläche 20.
    expect(lines[3]).toBe("Decke;D1;Betondecke;EG;;;0.20;20.00");
  });

  it("hängt bei includeSummary einen Aggregat-Block je Bauteil-Typ an", () => {
    const csv = exportScheduleCsv(fixtureProject());
    const lines = csv.split("\r\n");
    // Kopf(1) + 3 Zeilen + Leerzeile + Titel + 2 Aggregate (Aussenwand, Betondecke) = 8.
    expect(lines).toHaveLength(8);
    expect(lines[4]).toBe("");
    expect(lines[5]).toContain("Zusammenfassung");
    // Wand-Aggregat: 2 Stk, Gesamtlänge 9, Gesamtfläche 23.40.
    expect(lines[6]).toBe("Wand;;Aussenwand;2 Stk;9.00;;;23.40");
    // Decken-Aggregat: 1 Stk, keine Länge, Fläche 20.
    expect(lines[7]).toBe("Decke;;Betondecke;1 Stk;;;;20.00");
  });

  it("quotet Felder mit Sonderzeichen (Semikolon/Anführungszeichen) RFC-4180-konform", () => {
    const proj = fixtureProject();
    proj.wallTypes[0].name = 'Wand; "Spezial"';
    const csv = exportScheduleCsv(proj, { includeSummary: false });
    const line = csv.split("\r\n")[1];
    // Semikolon + verdoppelte Anführungszeichen, Feld in "..." eingefasst.
    expect(line).toContain('"Wand; ""Spezial"""');
  });

  it("leeres Projekt ⇒ nur Kopfzeile (kein Crash)", () => {
    const proj = fixtureProject();
    proj.walls = [];
    proj.ceilings = [];
    const csv = exportScheduleCsv(proj);
    expect(csv.split("\r\n")).toHaveLength(1);
    expect(scheduleRows(proj)).toHaveLength(0);
  });
});
