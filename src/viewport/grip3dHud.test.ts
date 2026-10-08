import { describe, expect, it } from "vitest";
import type { Project } from "../model/types";
import { sampleProject } from "../model/sampleProject";
import {
  neighbor3dVertex,
  bodyMoveAnchor,
  hudFromAnchor,
  grip3dTargetKey,
  grip3dEditPoint,
  cycleGrip3dEditState,
  nextGrip3dEditState,
  grip3dEditFields,
  findCoincidentVertices,
  findMoveCoincidentVertices,
  type Grip3dEditState,
} from "./grip3dHud";

describe("neighbor3dVertex — Wand", () => {
  it("liefert das ANDERE Ende als Nachbar (Index 0 → end, Index 1 → start)", () => {
    // W1: start (0,0) → end (5,0).
    expect(neighbor3dVertex(sampleProject, { wallId: "W1" }, 0)).toEqual({ x: 5, y: 0 });
    expect(neighbor3dVertex(sampleProject, { wallId: "W1" }, 1)).toEqual({ x: 0, y: 0 });
  });

  it("liefert null für eine unbekannte Wand-Id", () => {
    expect(neighbor3dVertex(sampleProject, { wallId: "nope" }, 0)).toBeNull();
  });
});

describe("neighbor3dVertex — Zeichnung", () => {
  const withLine: Project = {
    ...sampleProject,
    drawings2d: [
      {
        id: "D1",
        type: "drawing2d",
        levelId: "eg",
        categoryCode: "2d-line",
        geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 3, y: 0 } },
      },
    ],
  };
  const withOpenPoly: Project = {
    ...sampleProject,
    drawings2d: [
      {
        id: "D2",
        type: "drawing2d",
        levelId: "eg",
        categoryCode: "2d-line",
        geom: {
          shape: "polyline",
          pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
          closed: false,
        },
      },
    ],
  };
  const withClosedPoly: Project = {
    ...sampleProject,
    drawings2d: [
      {
        id: "D3",
        type: "drawing2d",
        levelId: "eg",
        categoryCode: "2d-line",
        geom: {
          shape: "polyline",
          pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
          closed: true,
        },
      },
    ],
  };

  it("Linie: Index 0 → b, Index 1 → a", () => {
    expect(neighbor3dVertex(withLine, { drawingId: "D1" }, 0)).toEqual({ x: 3, y: 0 });
    expect(neighbor3dVertex(withLine, { drawingId: "D1" }, 1)).toEqual({ x: 0, y: 0 });
  });

  it("offene Polylinie: Endpunkte haben nur EINEN Nachbarn (kein Ring-Wrap)", () => {
    expect(neighbor3dVertex(withOpenPoly, { drawingId: "D2" }, 0)).toEqual({ x: 1, y: 0 });
    expect(neighbor3dVertex(withOpenPoly, { drawingId: "D2" }, 2)).toEqual({ x: 1, y: 0 });
  });

  it("geschlossene Polylinie: Endpunkte wickeln um den Ring", () => {
    // Index 0 (0,0): prev wäre -1 → wickelt zu Index 2 (1,1).
    expect(neighbor3dVertex(withClosedPoly, { drawingId: "D3" }, 0)).toEqual({ x: 1, y: 1 });
  });

  it("Rechteck: Ecken bilden einen geschlossenen 4-Punkte-Ring", () => {
    const withRect: Project = {
      ...sampleProject,
      drawings2d: [
        {
          id: "D4",
          type: "drawing2d",
          levelId: "eg",
          categoryCode: "2d-line",
          geom: { shape: "rect", min: { x: 0, y: 0 }, max: { x: 2, y: 1 } },
        },
      ],
    };
    // Ecken-Reihenfolge (drawingGripVertices): min, (max.x,min.y), max, (min.x,max.y).
    // Index 0 (min): prev wickelt zu Index 3 (min.x, max.y).
    expect(neighbor3dVertex(withRect, { drawingId: "D4" }, 0)).toEqual({ x: 0, y: 1 });
  });
});

describe("neighbor3dVertex — Decke/Dach", () => {
  it("Decke: geschlossener Ring über outline (sampleProject C1: (0,0),(5,0),(5,4),(0,4))", () => {
    // Index 0 (0,0): prev wäre -1 → wickelt zu Index 3 (0,4).
    expect(neighbor3dVertex(sampleProject, { ceilingId: "C1" }, 0)).toEqual({ x: 0, y: 4 });
    // Index 3 (0,4): der normale Vorgänger ist Index 2 (5,4) — kein Ring-Wrap nötig.
    expect(neighbor3dVertex(sampleProject, { ceilingId: "C1" }, 3)).toEqual({ x: 5, y: 4 });
  });
});

describe("bodyMoveAnchor", () => {
  it("Wand: Achsmitte", () => {
    expect(bodyMoveAnchor(sampleProject, { wallId: "W1" })).toEqual({ x: 2.5, y: 0 });
  });

  it("unbekanntes Ziel: null", () => {
    expect(bodyMoveAnchor(sampleProject, {})).toBeNull();
  });
});

describe("hudFromAnchor", () => {
  it("berechnet Länge + Winkel relativ zum Anker (0° = Ost)", () => {
    const hud = hudFromAnchor({ x: 0, y: 0 }, { x: 3, y: 0 });
    expect(hud.length).toBeCloseTo(3, 6);
    expect(hud.angleDeg).toBeCloseTo(0, 6);
    expect(hud.at).toEqual({ x: 3, y: 0 });
  });

  it("90° bei Bewegung entlang +y (Nord)", () => {
    const hud = hudFromAnchor({ x: 0, y: 0 }, { x: 0, y: 5 });
    expect(hud.angleDeg).toBeCloseTo(90, 6);
  });
});

describe("grip3dTargetKey", () => {
  it("liefert die gesetzte Id, leer bei keinem Ziel", () => {
    expect(grip3dTargetKey({ wallId: "W1" })).toBe("W1");
    expect(grip3dTargetKey({ drawingId: "D1" })).toBe("D1");
    expect(grip3dTargetKey({})).toBe("");
  });
});

describe("grip3dEditPoint — getippte Werteingabe während eines 3D-Griff-Drags", () => {
  it("ohne Locks: folgt exakt dem rohen (Maus-)Punkt", () => {
    expect(grip3dEditPoint({ x: 0, y: 0 }, {}, { x: 3, y: 4 })).toEqual({ x: 3, y: 4 });
  });

  it("gelockte Länge, live Winkel: Länge fix, Richtung folgt der Maus", () => {
    const pt = grip3dEditPoint({ x: 0, y: 0 }, { length: 10 }, { x: 3, y: 4 }); // Winkel aus (3,4) = 53.13°
    expect(pt.x).toBeCloseTo(6, 5); // 10 * cos(53.13°)
    expect(pt.y).toBeCloseTo(8, 5); // 10 * sin(53.13°)
  });

  it("beide gelockt: Maus-Position (raw) ist wirkungslos", () => {
    const a = grip3dEditPoint({ x: 1, y: 1 }, { length: 5, angle: 0 }, { x: 999, y: -999 });
    const b = grip3dEditPoint({ x: 1, y: 1 }, { length: 5, angle: 0 }, { x: -50, y: 50 });
    expect(a).toEqual(b);
    expect(a.x).toBeCloseTo(6, 5);
    expect(a.y).toBeCloseTo(1, 5);
  });
});

describe("cycleGrip3dEditState — Tab öffnet/zykelt den 3D-Feld-Controller", () => {
  const info = {
    target: { wallId: "W1" },
    index: 0,
    kind: "vertex" as const,
    anchor: { x: 0, y: 0 },
    raw: { x: 3, y: 4 },
  };

  it("ÖFFNEN (prev=null): friert BEIDE Felder an der aktuellen Position ein", () => {
    const st = cycleGrip3dEditState(null, info);
    expect(st.active).toBe("length");
    expect(st.locks.length).toBeCloseTo(5, 5); // hypot(3,4)
    expect(st.locks.angle).toBeCloseTo(53.130102, 4);
    expect(st.anchor).toEqual({ x: 0, y: 0 });
    expect(st.target).toEqual({ wallId: "W1" });
  });

  it("ZYKELN (prev vorhanden): wechselt das aktive Feld und LÖST dessen Lock, der andere bleibt fix", () => {
    const opened = cycleGrip3dEditState(null, info);
    const cycled = cycleGrip3dEditState(opened, info);
    expect(cycled.active).toBe("angle");
    expect(cycled.locks.angle).toBeUndefined(); // neu aktives Feld: entsperrt
    expect(cycled.locks.length).toBeCloseTo(5, 5); // verlassenes Feld: bleibt fix
  });

  it("zweimal Zykeln kommt zurück zu 'length' — JEDES verlassene Feld verliert seinen Lock beim nächsten Zykeln", () => {
    // opened: {length, angle} beide gelockt. once (-> angle aktiv): angle
    // entsperrt, length bleibt. twice (-> length aktiv): length JETZT auch
    // entsperrt (frisch verlassen) — angle bleibt entsperrt (nie wieder
    // gelockt ohne erneute Werteingabe). Am Ende sind beide frei/live.
    const opened = cycleGrip3dEditState(null, info);
    const once = cycleGrip3dEditState(opened, info);
    const twice = cycleGrip3dEditState(once, info);
    expect(twice.active).toBe("length");
    expect(twice.locks.length).toBeUndefined();
    expect(twice.locks.angle).toBeUndefined();
  });
});

describe("nextGrip3dEditState — getippter Zahlenwert", () => {
  const base: Grip3dEditState = {
    target: { wallId: "W1" },
    index: 0,
    kind: "vertex",
    anchor: { x: 0, y: 0 },
    active: "length",
    locks: { length: 5, angle: 53.13 },
  };

  it("locked das AKTIVE Feld auf den getippten Wert und rückt aufs andere vor", () => {
    const next = nextGrip3dEditState(base, 7.5);
    expect(next.locks.length).toBe(7.5);
    expect(next.locks.angle).toBe(53.13); // unverändert
    expect(next.active).toBe("angle"); // vorgerückt
  });

  it("funktioniert symmetrisch für das Winkel-Feld", () => {
    const angleActive: Grip3dEditState = { ...base, active: "angle" };
    const next = nextGrip3dEditState(angleActive, 90);
    expect(next.locks.angle).toBe(90);
    expect(next.locks.length).toBe(5);
    expect(next.active).toBe("length");
  });
});

describe("grip3dEditFields — Befehlszeilen-/HUD-Felder des 3D-Feld-Controllers", () => {
  it("zeigt gelockte Werte als 'locked', live (unlocked) Werte aus raw berechnet", () => {
    const state: Grip3dEditState = {
      target: { wallId: "W1" },
      index: 0,
      kind: "vertex",
      anchor: { x: 0, y: 0 },
      active: "angle",
      locks: { length: 5 }, // angle NICHT gelockt -> folgt raw
    };
    const fields = grip3dEditFields(state, { x: 0, y: 10 }); // raw entlang +y -> 90°
    const length = fields.find((f) => f.id === "length")!;
    const angle = fields.find((f) => f.id === "angle")!;
    expect(length.locked).toBe(true);
    expect(length.value).toBe(5);
    expect(length.active).toBe(false);
    expect(angle.locked).toBe(false);
    expect(angle.value).toBeCloseTo(90, 5);
    expect(angle.active).toBe(true);
  });
});

// sampleProject-Wände bilden einen geschlossenen Ring: W1 (0,0)->(5,0),
// W2 (5,0)->(5,4), W3 (5,4)->(0,4), W4 (0,4)->(0,0) — W1.end fällt mit
// W2.start zusammen, W1.start mit W4.end.
describe("findCoincidentVertices", () => {
  it("findet den Endpunkt-Griff der ANDEREN Wand an derselben Ecke", () => {
    const out = findCoincidentVertices(sampleProject, { x: 5, y: 0 }, { wallId: "W1" });
    expect(out).toContainEqual({ target: { wallId: "W2" }, index: 0 });
  });

  it("schliesst SELBST aus (W1 selbst nie als koinzident gemeldet)", () => {
    const out = findCoincidentVertices(sampleProject, { x: 5, y: 0 }, { wallId: "W1" });
    expect(out.some((c) => c.target.wallId === "W1")).toBe(false);
  });

  it("kein Treffer weit ausserhalb der Toleranz", () => {
    const out = findCoincidentVertices(sampleProject, { x: 2.5, y: 2 }, { wallId: "W1" });
    expect(out).toEqual([]);
  });

  it("findet auch koinzidente Zeichnungs-Vertices", () => {
    const withLine: Project = {
      ...sampleProject,
      drawings2d: [
        {
          id: "D1",
          type: "drawing2d",
          levelId: "eg",
          categoryCode: "2d-line",
          geom: { shape: "line", a: { x: 5, y: 0 }, b: { x: 5, y: 2 } },
        },
      ],
    };
    const out = findCoincidentVertices(withLine, { x: 5, y: 0 }, { wallId: "W1" });
    expect(out).toContainEqual({ target: { drawingId: "D1" }, index: 0 });
  });
});

describe("findMoveCoincidentVertices", () => {
  it("liefert je Ecke der Wand die koinzidenten Sibling-Endpunkte (u. a. W4/W2 an den Eckpunkten)", () => {
    const out = findMoveCoincidentVertices(sampleProject, { wallId: "W1" });
    // W1.start(0,0) <-> W4.end(index 1); W1.end(5,0) <-> W2.start(index 0).
    // sampleProject hat noch weitere Elemente an denselben Ecken (Fenster/
    // Türen/2D-Referenzgeometrie) — keine exakte Länge erwartet, nur dass
    // diese beiden strukturell wichtigen Nachbarn sicher dabei sind, ohne
    // Duplikate (dedupliziert je target+index).
    expect(out).toContainEqual({ target: { wallId: "W4" }, index: 1, pos: { x: 0, y: 0 } });
    expect(out).toContainEqual({ target: { wallId: "W2" }, index: 0, pos: { x: 5, y: 0 } });
    const keys = out.map((c) => `${c.target.wallId ?? ""}|${c.target.drawingId ?? ""}|${c.index}`);
    expect(new Set(keys).size).toBe(keys.length); // keine Duplikate
  });

  it("leeres Ergebnis für ein unbekanntes Ziel", () => {
    expect(findMoveCoincidentVertices(sampleProject, {})).toEqual([]);
  });
});
