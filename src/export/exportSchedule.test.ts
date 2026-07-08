// Unit-Tests für die Bauteilliste (Bauteil-Schedule CSV, AUDIT A6 + D2).
//   • Kopfzeile + eine Zeile je Bauteil-Vorkommen (2 Wände, 1 Decke, 1 Tür,
//     1 Fenster, 1 Treppe, 1 Extrusion).
//   • korrekte Kennwerte (Länge/Höhe/Dicke/Fläche) aus dem Modell abgeleitet.
//   • CSV-Escaping bei einem Typnamen mit Semikolon/Anführungszeichen.
//   • leeres Projekt ⇒ nur Kopfzeile (kein Crash).

import { describe, it, expect } from "vitest";
import { exportScheduleCsv, scheduleRows } from "./exportSchedule";
import type { Project, Wall, Ceiling, Door, Opening, Stair, ExtrudedSolid } from "../model/types";

/**
 * Minimalprojekt: 2 Wände (1 Wandtyp T=0.4) + 1 Decke (Deckentyp T=0.2) +
 * 1 Tür + 1 Fenster (je an W1 gehostet) + 1 Treppe + 1 Extrusion.
 */
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
  const doors: Door[] = [
    {
      id: "T1",
      type: "door",
      hostWallId: "W1",
      categoryCode: "21",
      position: 1,
      width: 0.9,
      height: 2.1, // Fläche 1.89
      swing: "left",
      hinge: "start",
    },
  ];
  const openings: Opening[] = [
    {
      id: "F1",
      type: "opening",
      hostWallId: "W2",
      categoryCode: "21",
      kind: "window",
      position: 1,
      width: 1.2,
      height: 1.5, // Fläche 1.80
      sillHeight: 0.9,
    },
  ];
  const stairs: Stair[] = [
    {
      id: "S1",
      type: "stair",
      floorId: "eg",
      categoryCode: "40",
      shape: "straight",
      start: { x: 0, y: 0 },
      dir: { x: 1, y: 0 },
      runLength: 3, // Länge 3 (kein 2. Lauf)
      width: 1.2,
      totalRise: 2.6,
      stepCount: 16,
    },
  ];
  const extrudedSolids: ExtrudedSolid[] = [
    {
      id: "E1",
      type: "extrudedSolid",
      levelId: "eg",
      points: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 3 },
        { x: 0, y: 3 },
      ], // 2×3 = 6 m²
      height: 2.5,
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
    doors,
    openings,
    ceilings,
    stairs,
    extrudedSolids,
    rooms: [],
    drawings2d: [],
    context: [],
  } as Project;
}

describe("exportScheduleCsv — Bauteilliste", () => {
  it("liefert Kopfzeile + je Bauteil eine Zeile mit korrekten Kennwerten", () => {
    const csv = exportScheduleCsv(fixtureProject(), { includeSummary: false });
    const lines = csv.split("\r\n");

    // Kopfzeile + 7 Bauteil-Zeilen (2 Wände, 1 Decke, 1 Tür, 1 Fenster, 1 Treppe, 1 Extrusion).
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe("Typ;ID;Bauteil;Geschoss;Länge [m];Höhe [m];Dicke [m];Fläche [m²]");

    // Wand W1: Länge 5, Höhe 2.6, Dicke 0.4, Ansichtsfläche 13.
    expect(lines[1]).toBe("Wand;W1;Aussenwand;EG;5.00;2.60;0.40;13.00");
    // Wand W2: Länge 4, Ansichtsfläche 10.40.
    expect(lines[2]).toBe("Wand;W2;Aussenwand;EG;4.00;2.60;0.40;10.40");
    // Decke D1: keine Länge/Höhe, Dicke 0.2, Grundrissfläche 20.
    expect(lines[3]).toBe("Decke;D1;Betondecke;EG;;;0.20;20.00");
    // Tür T1: Breite 0.9, Höhe 2.1, keine Dicke, Fläche 1.89.
    expect(lines[4]).toBe("Tür;T1;Tür;EG;0.90;2.10;;1.89");
    // Fenster F1: Breite 1.2, Höhe 1.5, keine Dicke, Fläche 1.80.
    expect(lines[5]).toBe("Fenster;F1;Fenster;EG;1.20;1.50;;1.80");
    // Treppe S1: Lauflänge 3 (kein 2. Lauf), Steighöhe 2.6, keine Dicke/Fläche.
    expect(lines[6]).toBe("Treppe;S1;Treppe;EG;3.00;2.60;;");
    // Extrusion E1: keine Länge, Höhe 2.5, keine Dicke, Grundrissfläche 6.
    expect(lines[7]).toBe("Extrusion;E1;Extrusion;EG;;2.50;;6.00");
  });

  it("hängt bei includeSummary einen Aggregat-Block je Bauteil-Typ an", () => {
    const csv = exportScheduleCsv(fixtureProject());
    const lines = csv.split("\r\n");
    // Kopf(1) + 7 Zeilen + Leerzeile + Titel + 6 Aggregate = 16.
    expect(lines).toHaveLength(16);
    expect(lines[8]).toBe("");
    expect(lines[9]).toContain("Zusammenfassung");
    // Wand-Aggregat: 2 Stk, Gesamtlänge 9, Gesamtfläche 23.40.
    expect(lines[10]).toBe("Wand;;Aussenwand;2 Stk;9.00;;;23.40");
    // Decken-Aggregat: 1 Stk, keine Länge, Fläche 20.
    expect(lines[11]).toBe("Decke;;Betondecke;1 Stk;;;;20.00");
    // Tür-Aggregat: 1 Stk, Gesamtbreite 0.9, Fläche 1.89.
    expect(lines[12]).toBe("Tür;;Tür;1 Stk;0.90;;;1.89");
    // Fenster-Aggregat: 1 Stk, Gesamtbreite 1.2, Fläche 1.80.
    expect(lines[13]).toBe("Fenster;;Fenster;1 Stk;1.20;;;1.80");
    // Treppen-Aggregat: 1 Stk, Gesamtlänge 3, keine bekannte Fläche (leer statt 0.00).
    expect(lines[14]).toBe("Treppe;;Treppe;1 Stk;3.00;;;");
    // Extrusions-Aggregat: 1 Stk, keine Länge, Fläche 6.
    expect(lines[15]).toBe("Extrusion;;Extrusion;1 Stk;;;;6.00");
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
    proj.doors = [];
    proj.openings = [];
    proj.stairs = [];
    proj.extrudedSolids = [];
    const csv = exportScheduleCsv(proj);
    expect(csv.split("\r\n")).toHaveLength(1);
    expect(scheduleRows(proj)).toHaveLength(0);
  });
});
