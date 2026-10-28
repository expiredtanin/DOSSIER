// Unit-Tests für den IFC4-Export (exportIfcSpf) — erste vollständige Scheibe.
//   • Strukturelle Validität: KEINE dangling references (jede #N-Referenz ist
//     definiert), KEINE doppelten Entity-IDs — der wichtigste Test.
//   • Header/FILE_SCHEMA('IFC4') vorhanden.
//   • Je "floor"-Geschoss genau ein IfcBuildingStorey.
//   • Wandanzahl → IfcWall-Anzahl.
//   • Eine Öffnung ⇒ IfcOpeningElement + IfcRelVoidsElement (+ IfcDoor/
//     IfcWindow + IfcRelFillsElement).
//   • GUID-Format (22 Zeichen, gültiger Zeichensatz), deterministisch.
//   • Leeres Projekt ⇒ valider Minimal-IFC (Project/Site/Building, kein Crash).
//
// Fixture-Muster gespiegelt von exportSchedule.test.ts.

import { describe, it, expect } from "vitest";
import { exportIfcSpf, ifcGuid, ifcString } from "./exportIfc";
import type {
  Ceiling,
  ExtrudedSolid,
  Opening,
  Project,
  Stair,
  Wall,
} from "../model/types";

/**
 * Minimalprojekt: 2 Geschosse (EG + OG, EG auch ein "section"-Level, das
 * NICHT zu einem Storey werden darf) + 2 Wände (Wandtyp T=0.4) + 1 Decke
 * (Deckentyp T=0.2) + 1 Tür + 1 Fenster (an W1 gehostet) + 1 Treppe +
 * 1 Extrusion.
 */
function fixtureProject(): Project {
  const walls: Wall[] = [
    {
      id: "W1",
      type: "wall",
      floorId: "eg",
      categoryCode: "20",
      start: { x: 0, y: 0 },
      end: { x: 5, y: 0 },
      wallTypeId: "aw",
      height: 2.6,
    },
    {
      id: "W2",
      type: "wall",
      floorId: "eg",
      categoryCode: "20",
      start: { x: 5, y: 0 },
      end: { x: 5, y: 4 },
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
      ],
      wallTypeId: "dt",
      ceilingTypeId: "dt",
    },
  ];
  const openings: Opening[] = [
    {
      id: "T1",
      type: "opening",
      hostWallId: "W1",
      categoryCode: "21",
      kind: "door",
      position: 1,
      width: 0.9,
      height: 2.1,
      sillHeight: 0,
    },
    {
      id: "F1",
      type: "opening",
      hostWallId: "W2",
      categoryCode: "21",
      kind: "window",
      position: 1,
      width: 1.2,
      height: 1.5,
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
      runLength: 3,
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
      ],
      height: 2.5,
    },
  ];
  return {
    id: "t",
    name: "Testprojekt",
    lineStyles: [],
    hatches: [],
    components: [{ id: "c", name: "C", color: "#ccc", hatchId: "none", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "Aussenwand", layers: [{ componentId: "c", thickness: 0.4 }] }],
    ceilingTypes: [{ id: "dt", name: "Betondecke", layers: [{ componentId: "c", thickness: 0.2 }] }],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
      { id: "og", name: "OG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 2.6 },
      { id: "schnitt-a", name: "Schnitt A", kind: "section", visible: true, locked: false, linePoints: [{ x: 0, y: 0 }, { x: 1, y: 0 }], directionSign: 1 },
    ],
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls,
    openings,
    ceilings,
    stairs,
    extrudedSolids,
    rooms: [],
    drawings2d: [],
    context: [],
  } as Project;
}

/**
 * Wie {@link fixtureProject}, aber beide Öffnungen sind Fenster mit Laibungs-Rücksprung an der
 * innersten Schicht: das Loch der (einzigen) Schicht ist grösser als die Öffnung, die Wand lässt sich
 * nicht als Extrusion minus Öffnung schreiben → Mesh-Pfad (IfcTriangulatedFaceSet).
 */
function meshFixture(): Project {
  const p = fixtureProject();
  (p as { windowTypes?: unknown[] }).windowTypes = [
    { id: "wt", name: "Holz-Metall IV", kind: "drehkipp", wingCount: 1, glazing: "dreifach", frameThickness: 0.08, defaultSillHeight: 0.9, defaultWidth: 1.2, defaultHeight: 1.2, innerLayerRecess: true },
  ];
  p.openings = [
    { ...p.openings![0], kind: "window", sillHeight: 0.9, height: 1.2, typeId: "wt" },
    { ...p.openings![1], height: 1.2, typeId: "wt" },
  ];
  return p;
}

/** `#N` einer Entity-Zeile. */
const idOf = (line: string) => line.slice(0, line.indexOf("="));

/** Alle GlobalIds (erstes Attribut jeder IfcRoot-Entity: 22-Zeichen-String gefolgt von der OwnerHistory). */
function globalIds(spf: string): string[] {
  return [...spf.matchAll(/^#\d+=IFC\w+\('([0-9A-Za-z_$]{22})',#\d+,/gm)].map((m) => m[1]);
}

/** GlobalId der ersten Entity vom Typ `type`, deren Zeile `needle` enthält. */
function guidOf(spf: string, type: string, needle = ""): string | undefined {
  const line = spf.split("\n").find((l) => l.includes(`=${type}(`) && l.includes(needle));
  return line ? /\('([^']{22})'/.exec(line)?.[1] : undefined;
}

/** Sammelt alle definierten Entity-IDs (`#N=`) und alle referenzierten `#N`. */
function collectIds(spf: string): { defined: Set<number>; referenced: Set<number>; duplicates: number[] } {
  const defined = new Set<number>();
  const duplicates: number[] = [];
  const referenced = new Set<number>();
  for (const line of spf.split("\n")) {
    const defMatch = /^#(\d+)=/.exec(line);
    if (defMatch) {
      const id = Number(defMatch[1]);
      if (defined.has(id)) duplicates.push(id);
      defined.add(id);
    }
    const refs = line.matchAll(/#(\d+)/g);
    for (const r of refs) {
      // Der erste Treffer je Zeile ist ggf. die Definition selbst — trotzdem
      // harmlos mitgezählt, da sie ja in `defined` steht (Selbstreferenz-Check
      // unten prüft nur: JEDE referenzierte ID muss iRGENDWO definiert sein).
      referenced.add(Number(r[1]));
    }
  }
  return { defined, referenced, duplicates };
}

describe("exportIfcSpf — IFC4-Export", () => {
  it("erzeugt keine dangling references und keine doppelten Entity-IDs", () => {
    const spf = exportIfcSpf(fixtureProject());
    const { defined, referenced, duplicates } = collectIds(spf);
    expect(duplicates).toEqual([]);
    const dangling = [...referenced].filter((id) => !defined.has(id));
    expect(dangling).toEqual([]);
    expect(defined.size).toBeGreaterThan(0);
  });

  it("trägt einen gültigen IFC4-Header", () => {
    const spf = exportIfcSpf(fixtureProject());
    expect(spf).toContain("ISO-10303-21;");
    expect(spf).toContain("FILE_SCHEMA(('IFC4'));");
    expect(spf).toContain("END-ISO-10303-21;");
  });

  it("erzeugt je 'floor'-Geschoss genau ein IfcBuildingStorey (Schnitte NICHT)", () => {
    const spf = exportIfcSpf(fixtureProject());
    const storeyLines = spf.split("\n").filter((l) => l.includes("=IFCBUILDINGSTOREY("));
    expect(storeyLines).toHaveLength(2); // EG + OG, NICHT "Schnitt A"
    expect(storeyLines.some((l) => l.includes("'EG'"))).toBe(true);
    expect(storeyLines.some((l) => l.includes("'OG'"))).toBe(true);
  });

  it("bildet jede Wand auf genau ein IfcWall ab", () => {
    const spf = exportIfcSpf(fixtureProject());
    const wallLines = spf.split("\n").filter((l) => l.includes("=IFCWALL("));
    expect(wallLines).toHaveLength(2);
  });

  it("Tür/Fenster: IfcOpeningElement in der Wand (RelVoids) und IfcDoor/IfcWindow darin (RelFills)", () => {
    const spf = exportIfcSpf(fixtureProject());
    const lines = spf.split("\n");
    expect(lines.filter((l) => l.includes("=IFCDOOR("))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("=IFCWINDOW("))).toHaveLength(1);
    const openings = lines.filter((l) => l.includes("=IFCOPENINGELEMENT("));
    expect(openings).toHaveLength(2);
    for (const o of openings) expect(o).toContain(".OPENING.");
    const voids = lines.filter((l) => l.includes("=IFCRELVOIDSELEMENT("));
    const fills = lines.filter((l) => l.includes("=IFCRELFILLSELEMENT("));
    expect(voids).toHaveLength(2);
    expect(fills).toHaveLength(2);
    // RelVoids: Wand → Öffnung; RelFills: Öffnung → Tür/Fenster.
    const wallIds = lines.filter((l) => l.includes("=IFCWALL(")).map(idOf);
    const openingIds = openings.map(idOf);
    const fillIds = lines.filter((l) => l.includes("=IFCDOOR(") || l.includes("=IFCWINDOW(")).map(idOf);
    for (const v of voids) {
      const m = /,(#\d+),(#\d+)\);$/.exec(v)!;
      expect(wallIds).toContain(m[1]);
      expect(openingIds).toContain(m[2]);
    }
    for (const f of fills) {
      const m = /,(#\d+),(#\d+)\);$/.exec(f)!;
      expect(openingIds).toContain(m[1]);
      expect(fillIds).toContain(m[2]);
    }
    // Öffnungen hängen nur über RelVoids an der Wand, nicht im Geschoss.
    const contained = lines.filter((l) => l.includes("=IFCRELCONTAINEDINSPATIALSTRUCTURE("));
    for (const o of openingIds) for (const c of contained) expect(c).not.toMatch(new RegExp(`${o}[,)]`));
  });

  it("einfache Wände: ungeschnittene Profil-Extrusion (SweptSolid) je Schicht-Band, kein Mesh", () => {
    const spf = exportIfcSpf(fixtureProject());
    const lines = spf.split("\n");
    expect(lines.filter((l) => l.includes("=IFCTRIANGULATEDFACESET("))).toHaveLength(0);
    // Der Fenster-Wand-Körper ist voll: 5 m × 0.4 m Rechteck, 2.6 m hoch (das Loch macht die Öffnung).
    expect(spf).toMatch(/=IFCEXTRUDEDAREASOLID\(#\d+,#\d+,#\d+,2\.6\);/);
  });

  it("Wand mit Laibungs-Rücksprung (innerste Schicht weiter offen): Mesh bleibt, Öffnung+Füllung trotzdem als Beziehung", () => {
    const p = fixtureProject();
    p.components.push({ id: "d", name: "Dämmung", color: "#eee", hatchId: "none", joinPriority: 5 });
    p.wallTypes[0].layers = [{ componentId: "d", thickness: 0.16 }, { componentId: "c", thickness: 0.24 }];
    (p as { windowTypes?: unknown[] }).windowTypes = [
      { id: "wt", name: "Holz-Metall IV", kind: "drehkipp", wingCount: 1, glazing: "dreifach", frameThickness: 0.08, defaultSillHeight: 0.9, defaultWidth: 1.2, defaultHeight: 1.2, innerLayerRecess: true },
    ];
    p.openings![1] = { ...p.openings![1], typeId: "wt" };
    const lines = exportIfcSpf(p).split("\n");
    // W2 (Fenster mit Rücksprung) als Mesh, W1 (Tür) als Extrusion.
    expect(lines.filter((l) => l.includes("=IFCTRIANGULATEDFACESET("))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("=IFCOPENINGELEMENT("))).toHaveLength(2);
    expect(lines.filter((l) => l.includes("=IFCRELVOIDSELEMENT("))).toHaveLength(2);
    expect(lines.filter((l) => l.includes("=IFCRELFILLSELEMENT("))).toHaveLength(2);
  });

  it("bildet Decke, Treppe und Extrusion auf die erwarteten Entity-Typen ab", () => {
    const spf = exportIfcSpf(fixtureProject());
    const lines = spf.split("\n");
    expect(lines.filter((l) => l.includes("=IFCSLAB("))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("=IFCSTAIR("))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("=IFCBUILDINGELEMENTPROXY("))).toHaveLength(1);
  });

  it("das Wand-Face-Set enthält das ausgeschnittene Fenster-Loch (Loch-Vertices + volle Dreieckszahl, keine dangling refs)", () => {
    // Einschichtige Wände mit Rücksprung-Fenster: die einzige (= innerste) Schicht hat das geweitete
    // Loch → Mesh-Pfad; Zerlegung wie bisher.
    // W2 hat das Fenster F1 (position 1, width 1.2, sill 0.9, height 1.5) → das
    // Loch liegt voll im Wand-Inneren; das Face-Set der Wand hat exakt die
    // Rust-Zerlegung: 8 Langseiten-Teilrechtecke ×2×2 + 8 (Deckel/Boden/Kappen)
    // + 8 (4 Laibungen) = 48 Dreiecke, 144 Punkte.
    const spf = exportIfcSpf(meshFixture());
    const lines = spf.split("\n");
    const faceSets = lines.filter((l) => l.includes("=IFCTRIANGULATEDFACESET("));
    // Das Loch-Face-Set hat 48 CoordIndex-Tripel.
    const triCounts = faceSets.map((l) => (l.match(/\(\d+,\d+,\d+\)/g) ?? []).length);
    expect(triCounts).toContain(48);
    // Zugehörige Punktliste hat 144 Punkte (3er-Koordinaten-Tupel).
    const pointLists = lines.filter((l) => l.includes("=IFCCARTESIANPOINTLIST3D("));
    const ptCounts = pointLists.map((l) => (l.match(/\([^()]*,[^()]*,[^()]*\)/g) ?? []).length);
    expect(ptCounts).toContain(144);
    // Keine dangling refs (der Kern-Invarianten-Check gilt auch mit Face-Sets).
    const { defined, referenced } = collectIds(spf);
    expect([...referenced].filter((id) => !defined.has(id))).toEqual([]);
  });

  it("Wand-Face-Sets sind NACH AUSSEN orientiert (positives Volumen) — Regression gegen die Reflexions-Wicklung, die die Wand hohl machte", () => {
    // Der IFC-Achsen-Swap (x,y,z)→(x,z,y) ist eine Reflexion und kehrte die
    // Dreiecks-Wicklung um → Normalen zeigten nach INNEN → Viewer cullten die
    // Vorderseiten → Wand wirkte oben/unten offen. Nach dem Wicklungs-Ausgleich
    // muss das signierte Volumen jedes Wandkörpers POSITIV sein (aussen orientiert).
    const spf = exportIfcSpf(meshFixture());
    const lines = spf.split("\n");
    const byId = new Map<number, string>();
    for (const l of lines) {
      const m = /^#(\d+)=/.exec(l);
      if (m) byId.set(Number(m[1]), l);
    }
    const parsePoints = (line: string): number[][] =>
      [...line.matchAll(/\(([-\d.]+),([-\d.]+),([-\d.]+)\)/g)].map((m) => [
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
      ]);
    const faceSets = lines.filter((l) => l.includes("=IFCTRIANGULATEDFACESET("));
    expect(faceSets.length).toBeGreaterThan(0);
    let closedCount = 0;
    for (const fs of faceSets) {
      const ptListId = Number(/=IFCTRIANGULATEDFACESET\(#(\d+),/.exec(fs)![1]);
      const closed = /=IFCTRIANGULATEDFACESET\(#\d+,\$,([^,]+),/.exec(fs)![1];
      if (closed === ".T.") closedCount++;
      const pts = parsePoints(byId.get(ptListId)!);
      const tris = [...fs.matchAll(/\((\d+),(\d+),(\d+)\)/g)].map((m) => [
        Number(m[1]) - 1,
        Number(m[2]) - 1,
        Number(m[3]) - 1,
      ]);
      // 6× signiertes Volumen Σ v0·(v1×v2): > 0 ⇒ Normalen zeigen nach aussen.
      let vol6 = 0;
      for (const [a, b, c] of tris) {
        const [ax, ay, az] = pts[a];
        const [bx, by, bz] = pts[b];
        const [cx, cy, cz] = pts[c];
        vol6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
      }
      expect(vol6).toBeGreaterThan(0);
    }
    // Beide Wände sind geschlossene Prisma-Körper (Fenster = Durchgangsloch,
    // Tür = umlaufende П-Kerbe) → Closed=.T. bei beiden.
    expect(closedCount).toBe(2);
  });

  it("GUIDs sind 22 Zeichen lang, nutzen den gültigen IFC-Zeichensatz und sind deterministisch", () => {
    const guid = ifcGuid("W1");
    expect(guid).toHaveLength(22);
    // 128 Bit in 22 Zeichen: das erste Zeichen trägt nur 2 Bit (0–3).
    expect(guid).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/);
    expect(ifcGuid("W1")).toBe(guid); // stabil über Re-Export
    expect(ifcGuid("W2")).not.toBe(guid); // unterschiedliche IDs → unterschiedliche GUIDs
  });

  it("[B5] dauerhafte GUIDs: zweimal exportieren liefert dieselben GlobalIds", () => {
    const a = globalIds(exportIfcSpf(fixtureProject()));
    const b = globalIds(exportIfcSpf(fixtureProject()));
    expect(a.length).toBeGreaterThan(20);
    expect(b).toEqual(a);
  });

  it("[B5] GlobalIds sind in der Datei eindeutig — auch bei gleicher id verschiedener Bauteilarten", () => {
    // Decke und Dach heissen beide „D1": Namensraum je Bauteilart trennt sie.
    const p: Project = {
      ...meshFixture(),
      roofs: [
        {
          id: "D1", type: "roof", floorId: "og", categoryCode: "35",
          outline: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }],
          shape: "sattel", pitchDeg: 35, overhang: 0.3, ridgeAxis: "x", thickness: 0.25,
        },
      ],
      rooms: [
        { id: "R1", type: "room", floorId: "eg", categoryCode: "45", siaCategory: "HNF", name: "Küche", boundary: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }], color: "#ccc" },
      ],
      columns: [
        { id: "S2", type: "column", floorId: "eg", categoryCode: "50", position: { x: 2, y: 2 }, profile: { kind: "round", radius: 0.1 }, rotation: 0, height: 2.6, componentId: "c" },
      ],
    };
    const ids = globalIds(exportIfcSpf(p));
    expect(ids.length).toBeGreaterThan(30);
    expect(new Set(ids).size).toBe(ids.length);
    // Ebenso im Demo-Haus mit Extrusions-Wänden.
    const ids2 = globalIds(exportIfcSpf(fixtureProject()));
    expect(new Set(ids2).size).toBe(ids2.length);
  });

  it("[B5] GUID eines Bauteils hängt nur an Projekt und Bauteil, nicht an anderen Bauteilen oder der Reihenfolge", () => {
    const base = exportIfcSpf(fixtureProject());
    const p = fixtureProject();
    p.walls = [
      { id: "W0", type: "wall", floorId: "og", categoryCode: "20", start: { x: 0, y: 4 }, end: { x: 0, y: 0 }, wallTypeId: "aw", height: 2.6 },
      ...[...p.walls].reverse(),
    ];
    const more = exportIfcSpf(p);
    for (const type of ["IFCWALL", "IFCSLAB", "IFCDOOR", "IFCOPENINGELEMENT", "IFCWALLTYPE"]) {
      const g = guidOf(base, type);
      expect(g, type).toBeDefined();
      expect(globalIds(more), type).toContain(g);
    }
    // Geschoss und räumliche Eingliederung des EG bleiben gleich, obwohl das OG neu Bauteile hat.
    expect(guidOf(more, "IFCBUILDINGSTOREY", "'EG'")).toBe(guidOf(base, "IFCBUILDINGSTOREY", "'EG'"));
    const containEg = (spf: string) => {
      const eg = idOf(spf.split("\n").find((l) => l.includes("=IFCBUILDINGSTOREY(") && l.includes("'EG'"))!);
      return guidOf(spf, "IFCRELCONTAINEDINSPATIALSTRUCTURE", `,${eg});`);
    };
    expect(containEg(base)).toBeDefined();
    expect(containEg(more)).toBe(containEg(base));
  });

  it("[B5] anderes Projekt ⇒ andere GUIDs (gleiche Bauteil-ids kollidieren nicht projektübergreifend)", () => {
    const a = new Set(globalIds(exportIfcSpf(fixtureProject())));
    const b = globalIds(exportIfcSpf({ ...fixtureProject(), id: "anderes" }));
    expect(b.filter((g) => a.has(g))).toEqual([]);
  });

  it("georeferenziert: mit geoAnchor werden die ECHTEN LV95-Koordinaten geschrieben (lokal bearbeitet, weltweit lagerichtig)", () => {
    // Modell lokal nahe (0,0), aber geoAnchor sagt: Modell (0,0) = LV95
    // (2600000,1200000). Der Export muss die Profil-/Punkt-Koordinaten auf die
    // echten Landeskoordinaten (Millionenbereich) verschoben schreiben.
    const local = fixtureProject();
    const withoutAnchor = exportIfcSpf(local);
    // Ohne Bezug: lokale Koordinaten, KEINE Millionenwerte im Text.
    expect(withoutAnchor).not.toMatch(/26000\d\d\./);

    const geo: Project = {
      ...local,
      geoAnchor: { lv95: { e: 2600000, n: 1200000 }, model: { x: 0, y: 0 } },
    };
    const spf = exportIfcSpf(geo);
    // W1.start (0,0) -> LV95 (2600000,1200000); W2.end (5,4) -> (2600005,1200004).
    expect(spf).toContain("2600000.");
    expect(spf).toContain("1200000.");
    expect(spf).toContain("2600005.");
    // Koordinatensystem deklariert (IFC4): EPSG:2056 + Identitäts-Abbildung.
    expect(spf).toContain("IFCPROJECTEDCRS('EPSG:2056'");
    expect(spf).toContain("IFCMAPCONVERSION(");
    expect(withoutAnchor).not.toContain("IFCMAPCONVERSION");
    // Struktur bleibt valide (keine dangling refs / Duplikate).
    const { defined, referenced, duplicates } = collectIds(spf);
    expect(duplicates).toEqual([]);
    expect([...referenced].filter((id) => !defined.has(id))).toEqual([]);
  });

  it("geoAnchor.height wird als IfcSite.RefElevation geschrieben (Vermessungspunkt-Höhe)", () => {
    const local = fixtureProject();
    const geo: Project = {
      ...local,
      geoAnchor: { lv95: { e: 2600000, n: 1200000 }, height: 683.5, model: { x: 0, y: 0 } },
    };
    const spf = exportIfcSpf(geo);
    // Die IFCSITE-Zeile trägt die reale Datumshöhe (RefElevation, 12. Attribut).
    const siteLine = spf.split("\n").find((l) => l.includes("=IFCSITE("));
    expect(siteLine).toBeDefined();
    expect(siteLine).toContain("683.5");
    // Ohne Höhe bleibt RefElevation leer ($) — kein 683.5 irgendwo.
    const noH = exportIfcSpf({
      ...local,
      geoAnchor: { lv95: { e: 2600000, n: 1200000 }, model: { x: 0, y: 0 } },
    });
    expect(noH).not.toContain("683.5");
  });

  it("leeres Projekt ⇒ valider Minimal-IFC (Project/Site/Building, kein Crash)", () => {
    const proj = fixtureProject();
    proj.walls = [];
    proj.ceilings = [];
    proj.openings = [];
    proj.stairs = [];
    proj.extrudedSolids = [];
    proj.drawingLevels = [];
    const spf = exportIfcSpf(proj);
    expect(spf).toContain("=IFCPROJECT(");
    expect(spf).toContain("=IFCSITE(");
    expect(spf).toContain("=IFCBUILDING(");
    const { defined, referenced, duplicates } = collectIds(spf);
    expect(duplicates).toEqual([]);
    expect([...referenced].filter((id) => !defined.has(id))).toEqual([]);
  });
});

describe("STEP-Zeichenketten (ISO 10303-21)", () => {
  it("Umlaute als \\X2\\…\\X0\\, ASCII unverändert, Apostroph verdoppelt", () => {
    expect(ifcString("Gebäude")).toBe("'Geb\\X2\\00E4\\X0\\ude'");
    expect(ifcString("Grösse Ü")).toBe("'Gr\\X2\\00F6\\X0\\sse \\X2\\00DC\\X0\\'");
    expect(ifcString("it's a\\b")).toBe("'it''s a\\\\b'");
  });
  it("aufeinanderfolgende Zeichen in einem Block, Zeichen ausserhalb BMP als \\X4\\", () => {
    expect(ifcString("äö")).toBe("'\\X2\\00E400F6\\X0\\'");
    expect(ifcString("a😀")).toBe("'a\\X4\\0001F600\\X0\\'");
  });
  it("Steuerzeichen werden kodiert, die Datei bleibt reines ASCII", () => {
    expect(ifcString("a\nb")).toBe("'a\\X2\\000A\\X0\\b'");
    const spf = exportIfcSpf({ ...fixtureProject(), name: "Wohnüberbauung «Süd»" });
    expect(/^[\x20-\x7e\n\r]*$/.test(spf)).toBe(true);
  });
});

describe("Räume als IfcSpace", () => {
  const withRooms = (): Project => ({
    ...fixtureProject(),
    rooms: [
      {
        id: "R1", type: "room", floorId: "eg", categoryCode: "45", siaCategory: "HNF", name: "Küche",
        boundary: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], color: "#cccccc",
      },
      {
        id: "R2", type: "room", floorId: "verwaist", categoryCode: "45", siaCategory: "VF", name: "Gang",
        boundary: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], color: "#cccccc",
      },
    ],
  });
  it("je Raum ein IfcSpace mit Langname, im Geschoss aggregiert (nicht enthalten)", () => {
    const spf = exportIfcSpf(withRooms());
    const spaces = spf.split("\n").filter((l) => /=IFCSPACE\(/.test(l));
    expect(spaces).toHaveLength(2);
    expect(spaces[0]).toContain("'K\\X2\\00FC\\X0\\che'");
    expect(spaces[0]).toContain(".INTERNAL.");
    const spaceIds = spaces.map((l) => l.slice(0, l.indexOf("=")));
    const agg = spf.split("\n").filter((l) => /=IFCRELAGGREGATES\(/.test(l) && spaceIds.some((id) => l.includes(id)));
    expect(agg.length).toBeGreaterThan(0);
    const contained = spf.split("\n").filter((l) => /=IFCRELCONTAINEDINSPATIALSTRUCTURE\(/.test(l) && spaceIds.some((id) => new RegExp(`${id}[,)]`).test(l)));
    expect(contained).toEqual([]);
  });
  it("Netto-Geschossfläche und SIA-416-Kategorie", () => {
    const spf = exportIfcSpf(withRooms());
    expect(spf).toMatch(/IFCQUANTITYAREA\('NetFloorArea',\$,\$,12\.0,\$\)/);
    expect(spf).toContain("'Qto_SpaceBaseQuantities'");
    expect(spf).toMatch(/IFCPROPERTYSINGLEVALUE\('SIA416',\$,IFCLABEL\('HNF'\),\$\)/);
  });
});

describe("Materialschichten über Bauteiltypen", () => {
  const lines = (spf: string, type: string) => spf.split("\n").filter((l) => l.includes(`=${type}(`));
  it("Wandtyp → IfcWallType mit IfcMaterialLayerSet, Wände über IfcRelDefinesByType", () => {
    const p = fixtureProject();
    p.components.push({ id: "d", name: "Dämmung", color: "#eee", hatchId: "none", joinPriority: 5 });
    p.wallTypes[0].layers = [{ componentId: "d", thickness: 0.16 }, { componentId: "c", thickness: 0.24 }];
    const spf = exportIfcSpf(p);
    const types = lines(spf, "IFCWALLTYPE");
    expect(types).toHaveLength(1);
    expect(types[0]).toContain("'Aussenwand'");
    const layers = lines(spf, "IFCMATERIALLAYER");
    expect(layers.map((l) => l.match(/,(0\.\d+),/)?.[1]).slice(0, 2)).toEqual(["0.16", "0.24"]);
    expect(lines(spf, "IFCMATERIAL").map((l) => l.match(/\('([^']*)'/)?.[1])).toEqual(["D\\X2\\00E4\\X0\\mmung", "C"]);
    const walls = lines(spf, "IFCWALL").map(idOf);
    const rel = lines(spf, "IFCRELDEFINESBYTYPE").find((l) => l.endsWith(`${idOf(types[0])});`))!;
    for (const w of walls) expect(rel).toMatch(new RegExp(`${w}[,)]`));
    const assoc = lines(spf, "IFCRELASSOCIATESMATERIAL");
    expect(assoc.some((l) => l.includes(`(${idOf(types[0])})`))).toBe(true);
  });
  it("Deckentyp → IfcSlabType; gleiches Material nur einmal", () => {
    const spf = exportIfcSpf(fixtureProject());
    expect(lines(spf, "IFCSLABTYPE")).toHaveLength(1);
    expect(lines(spf, "IFCMATERIAL")).toHaveLength(1);
  });
});

describe("Dächer und Stützen", () => {
  const withRoofAndColumn = (): Project => ({
    ...fixtureProject(),
    roofTypes: [{ id: "rt", name: "Ziegeldach", layers: [{ componentId: "c", thickness: 0.05 }, { componentId: "c", thickness: 0.2 }] }],
    roofs: [
      {
        id: "D1", type: "roof", floorId: "og", categoryCode: "35",
        outline: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }],
        shape: "sattel", pitchDeg: 35, overhang: 0.3, ridgeAxis: "x", thickness: 0.25, roofTypeId: "rt",
      },
    ],
    columns: [
      {
        id: "S1", type: "column", floorId: "eg", categoryCode: "50",
        position: { x: 2, y: 2 }, profile: { kind: "rect", width: 0.3, depth: 0.3 }, rotation: 0, height: 2.6, componentId: "c",
      },
    ],
  });
  it("Dach → IfcRoof (Satteldach) mit geschlossenem Mesh und IfcRoofType", () => {
    const spf = exportIfcSpf(withRoofAndColumn());
    const roof = spf.split("\n").find((l) => l.includes("=IFCROOF("))!;
    expect(roof).toContain(".GABLE_ROOF.");
    expect(spf.split("\n").filter((l) => l.includes("=IFCTRIANGULATEDFACESET(") && l.includes(".T."))).not.toHaveLength(0);
    expect(spf).toMatch(/=IFCROOFTYPE\(.*'Ziegeldach'.*\.GABLE_ROOF\.\);/);
  });
  it("Stütze → IfcColumn mit Material", () => {
    const spf = exportIfcSpf(withRoofAndColumn());
    const col = spf.split("\n").find((l) => l.includes("=IFCCOLUMN("))!;
    expect(col).toContain(".COLUMN.");
    const colId = col.slice(0, col.indexOf("="));
    expect(spf.split("\n").some((l) => l.includes("=IFCRELASSOCIATESMATERIAL(") && l.includes(`(${colId})`))).toBe(true);
  });
});

describe("[B5] Pset_*Common mit den Werten aus dem Modell", () => {
  const byId = (spf: string) => {
    const m = new Map<string, string>();
    for (const l of spf.split("\n")) {
      const k = /^(#\d+)=/.exec(l);
      if (k) m.set(k[1], l);
    }
    return m;
  };
  /** Eigenschaften (Name → Wert-Ausdruck) des Psets `pset` am Bauteil `elementLine`. */
  const psetOf = (spf: string, elementLine: string, pset: string): Record<string, string> | null => {
    const lines = byId(spf);
    const el = idOf(elementLine);
    for (const rel of spf.split("\n").filter((l) => l.includes("=IFCRELDEFINESBYPROPERTIES("))) {
      const m = /,\(([^)]*)\),(#\d+)\);$/.exec(rel)!;
      if (!m[1].split(",").includes(el)) continue;
      const ps = lines.get(m[2])!;
      if (!ps.includes(`'${pset}'`)) continue;
      const props = /,\(([^)]*)\)\);$/.exec(ps)![1].split(",");
      const out: Record<string, string> = {};
      for (const pid of props) {
        const pm = /IFCPROPERTYSINGLEVALUE\('([^']*)',\$,(.*),\$\);$/.exec(lines.get(pid)!)!;
        out[pm[1]] = pm[2];
      }
      return out;
    }
    return null;
  };
  const project = (): Project => ({
    ...fixtureProject(),
    doorTypes: [
      { id: "dt-glas", name: "Glastür", kind: "dreh", leafCount: 1, leafStyle: "glas", glazingRatio: 0.6, frameThickness: 0.06, defaultWidth: 0.9, defaultHeight: 2.1 },
    ],
    windowTypes: [{ id: "wt", name: "Holz-Metall IV", kind: "drehkipp", wingCount: 1, glazing: "dreifach", frameThickness: 0.08, defaultSillHeight: 0.9, defaultWidth: 1.2, defaultHeight: 1.5 }],
    openings: [
      { ...fixtureProject().openings![0], typeId: "dt-glas" },
      { ...fixtureProject().openings![1], typeId: "wt" },
    ],
    roofTypes: [{ id: "rt", name: "Ziegeldach", layers: [{ componentId: "c", thickness: 0.25 }] }],
    roofs: [
      {
        id: "DA", type: "roof", floorId: "og", categoryCode: "35",
        outline: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }],
        shape: "sattel", pitchDeg: 35, overhang: 0.3, ridgeAxis: "x", thickness: 0.25, roofTypeId: "rt",
      },
    ],
    columns: [
      { id: "S1", type: "column", floorId: "eg", categoryCode: "50", position: { x: 2, y: 2 }, profile: { kind: "rect", width: 0.3, depth: 0.2 }, rotation: 0, height: 2.6 },
    ],
    rooms: [
      { id: "R1", type: "room", floorId: "eg", categoryCode: "45", siaCategory: "HNF", name: "Küche", boundary: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], color: "#ccc", stamp: { number: "E.01" } as never },
      { id: "R2", type: "room", floorId: "eg", categoryCode: "45", siaCategory: "AGF", name: "Terrasse", boundary: [{ x: 6, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 3 }, { x: 6, y: 3 }], color: "#ccc" },
    ],
  }) as Project;
  const line = (spf: string, type: string, needle = "") => spf.split("\n").find((l) => l.includes(`=${type}(`) && l.includes(needle))!;

  it("Wand/Decke: Reference = Typname, keine erfundenen Werte (IsExternal/LoadBearing/U-Wert fehlen im Modell)", () => {
    const spf = exportIfcSpf(project());
    expect(psetOf(spf, line(spf, "IFCWALL"), "Pset_WallCommon")).toEqual({ Reference: "IFCIDENTIFIER('Aussenwand')" });
    expect(psetOf(spf, line(spf, "IFCSLAB"), "Pset_SlabCommon")).toEqual({ Reference: "IFCIDENTIFIER('Betondecke')" });
    expect(spf).not.toContain("'ThermalTransmittance'");
    expect(spf).not.toContain("'LoadBearing'");
  });
  it("Dach: Reference = Dachtyp, IsExternal (ein Dach ist Gebäudehülle)", () => {
    const spf = exportIfcSpf(project());
    expect(psetOf(spf, line(spf, "IFCROOF"), "Pset_RoofCommon")).toEqual({ Reference: "IFCIDENTIFIER('Ziegeldach')", IsExternal: "IFCBOOLEAN(.T.)" });
  });
  it("Stütze: Reference = Profilbezeichnung", () => {
    const spf = exportIfcSpf(project());
    expect(psetOf(spf, line(spf, "IFCCOLUMN"), "Pset_ColumnCommon")).toEqual({ Reference: "IFCIDENTIFIER('St\\X2\\00FC\\X0\\tze 30\\X2\\00D7\\X0\\20')" });
  });
  it("Tür/Fenster: Reference = Bauteiltyp, Glasanteil der Glastür", () => {
    const spf = exportIfcSpf(project());
    expect(psetOf(spf, line(spf, "IFCDOOR"), "Pset_DoorCommon")).toEqual({
      Reference: "IFCIDENTIFIER('Glast\\X2\\00FC\\X0\\r')",
      GlazingAreaFraction: "IFCPOSITIVERATIOMEASURE(0.6)",
    });
    expect(psetOf(spf, line(spf, "IFCWINDOW"), "Pset_WindowCommon")).toEqual({ Reference: "IFCIDENTIFIER('Holz-Metall IV')" });
    // Ohne Typ kein leeres Pset.
    const plain = exportIfcSpf(fixtureProject());
    expect(psetOf(plain, line(plain, "IFCDOOR"), "Pset_DoorCommon")).toBeNull();
  });
  it("Raum: Reference = Raumnummer, IsExternal aus SIA 416 (AGF = Aussengeschossfläche)", () => {
    const spf = exportIfcSpf(project());
    const kueche = line(spf, "IFCSPACE", "'K\\X2\\00FC\\X0\\che'");
    const terrasse = line(spf, "IFCSPACE", "'Terrasse'");
    expect(psetOf(spf, kueche, "Pset_SpaceCommon")).toEqual({ Reference: "IFCIDENTIFIER('E.01')", IsExternal: "IFCBOOLEAN(.F.)" });
    expect(psetOf(spf, terrasse, "Pset_SpaceCommon")).toEqual({ IsExternal: "IFCBOOLEAN(.T.)" });
    expect(terrasse).toContain(".EXTERNAL.");
    expect(kueche).toContain(".INTERNAL.");
  });
});
