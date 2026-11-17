// [274] Sanierung je Schicht: Ops (neuer Aufbau je Wand, alle Wände eines Typs, Sanierungstyp anlegen, Typ-Paar),
// gemeinsamer Wert bei Mehrfachauswahl, Kern-Abfragen am Umbau-Beispiel (Typ-Paar, Zähler, Grundriss je Filter).

import { describe, expect, it } from "vitest";
import { applyOps } from "../core/ops";
import {
  buildUpKey,
  commonBuildUp,
  createRenovationTypeOps,
  parseBuildUpKey,
  renovateAllOfTypeOps,
  renovationPair,
  renovationPairs,
  setBuildUpOps,
  setPhasesOps,
  setRenovationOps,
  setTypePairOps,
  wallBuildUp,
} from "./renovation";
import { buildUmbauSampleProject } from "./sampleProjectUmbau";
import { generatePlan } from "../plan/generatePlan";
import { computeAreaTable } from "../analysis/areaTable";
import type { Project } from "./types";

const ALL = new Set(["20", "21", "30", "31", "40", "60"]);

function plan(p: Project, filter: string) {
  const q = { ...p, drawingLevels: p.drawingLevels.map((l) => (l.id === "eg" ? { ...l, renovationFilter: filter } : l)) };
  return generatePlan(q, "eg", ALL).primitives;
}

describe("[274] Sanierung je Schicht", () => {
  it("Aufbau-Schlüssel: keiner, wie Typ, anderer Typ", () => {
    expect(wallBuildUp(undefined)).toEqual({ kind: "none" });
    expect(wallBuildUp({ status: "existing", renovated: true })).toEqual({ kind: "type" });
    expect(wallBuildUp({ status: "existing", renovated: true, newTypeId: "x" })).toEqual({ kind: "other", typeId: "x" });
    for (const k of ["", "type", "t:abc"]) expect(buildUpKey(parseBuildUpKey(k))).toBe(k);
    expect(parseBuildUpKey("t:")).toEqual({ kind: "none" });
  });

  it("Neuer Aufbau für mehrere Wände in einem Schritt; Status/Etappe ändern behält die Sanierung", () => {
    const p = buildUmbauSampleProject();
    const ops = setBuildUpOps(p, ["W2", "W3"], { kind: "other", typeId: "aw-saniert" });
    expect(ops).toHaveLength(2);
    const q = applyOps(p, ops);
    expect(q.walls.find((w) => w.id === "W2")?.renovation).toEqual({ status: "existing", renovated: true, newTypeId: "aw-saniert" });
    expect(commonBuildUp(q, ["W2", "W3"])).toBe("t:aw-saniert");
    expect(commonBuildUp(q, ["W1", "W2"])).toBe("mixed");
    expect(commonBuildUp(q, ["O1"])).toBeNull();
    // Status setzen: Sanierung bleibt.
    const r = applyOps(q, setRenovationOps(q, ["W2"], "existing", "etappe-2"));
    expect(r.walls.find((w) => w.id === "W2")?.renovation).toEqual({ status: "existing", phase: "etappe-2", renovated: true, newTypeId: "aw-saniert" });
    // Etappe löschen: Sanierung bleibt.
    const s = applyOps(p, setPhasesOps(p, [{ id: "etappe-2", name: "Etappe 2" }]));
    expect(s.walls.find((w) => w.id === "W1")?.renovation).toEqual({ status: "existing", renovated: true });
    // Keiner: Feld weg (Bestand ohne Etappe).
    const t = applyOps(q, setBuildUpOps(q, ["W2"], { kind: "none" }));
    expect(t.walls.find((w) => w.id === "W2")).not.toHaveProperty("renovation");
  });

  it("Sanierungstyp anlegen, alle Wände vom Typ sanieren, Typ-Paar mit Zuordnung", () => {
    const p = buildUmbauSampleProject();
    const { ops, id } = createRenovationTypeOps(p, "aw", "Aussenwand saniert");
    const q = applyOps(p, ops);
    expect(q.wallTypes.find((t) => t.id === "aw")?.renovationTarget).toBe(id);
    expect(q.wallTypes.find((t) => t.id === id)?.layers).toEqual(p.wallTypes.find((t) => t.id === "aw")?.layers);
    // Alle Bestandswände vom Typ „aw“ (W2, W3, W4 auf EG; W5–W8 auf OG; nicht die neuen W10–W12) in einem Schritt.
    const r = applyOps(q, renovateAllOfTypeOps(q, "aw"));
    const renovated = r.walls.filter((w) => w.renovation?.renovated).map((w) => w.id).sort();
    expect(renovated).toEqual(["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8"]);
    // Gleiche Schichten: alles Bestand (nichts abgebrochen, nichts neu).
    const pr = renovationPair(r, "aw");
    expect(pr?.old.every((l) => l.fate === "kept")).toBe(true);
    // Manuelle Zuordnung am Typ-Paar: die Dämmung wird ersetzt.
    const s = applyOps(r, setTypePairOps(r, "aw", { old: ["auto", "demolish"] }));
    expect(renovationPair(s, "aw")?.old.map((l) => l.fate)).toEqual(["kept", "demolish", "kept", "kept"]);
    expect(renovationPair(s, "aw")?.new.map((l) => l.fate)).toEqual(["kept", "new", "kept", "kept"]);
    // Alles „automatisch“: Feld weg.
    const u = applyOps(s, setTypePairOps(s, "aw", { old: ["auto", "auto"] }));
    expect(u.wallTypes.find((t) => t.id === "aw")).not.toHaveProperty("renovationOld");
    expect(renovationPairs(u).pairs.filter((x) => x.kind === "wall").map((x) => x.type).sort()).toEqual(["aw", "aw-bestand"]);
  });

  it("Beispiel Umbau: Typ-Paar der Südwand, Zähler, Grundriss und GF je Filter", () => {
    const p = buildUmbauSampleProject();
    const pr = renovationPair(p, "aw-bestand");
    expect(pr?.old.map((l) => l.fate)).toEqual(["demolish", "demolish", "kept"]);
    expect(pr?.new.map((l) => l.fate)).toEqual(["new", "new", "kept"]);
    expect(pr?.result.map((q) => q.kind)).toEqual(["new", "new", "newOverDemolish", "newOverDemolish", "kept"]);
    // Südwand W1, Decke C1, Dach RF1.
    expect(renovationPairs(p).renovated).toBe(3);
    // Grundriss: Abbruch gelb, Umbauplan mit gelber gestrichelter Kontur über Rot.
    const dashedYellow = (prims: ReturnType<typeof plan>) => prims.some((x) => x.kind === "line" && !!x.dash && x.color === "#e8c35a");
    expect(dashedYellow(plan(p, "umbauplan"))).toBe(true);
    expect(dashedYellow(plan(p, "endzustand"))).toBe(false);
    // GF im Endzustand: die Südwand ist 10 cm dicker als ohne Sanierung (die Aussenkante rückt nach aussen).
    const unsaniert = applyOps(p, setBuildUpOps(p, ["W1"], { kind: "none" }));
    const gf = (q: Project) => computeAreaTable(q, JSON.stringify({ renovation: "endzustand", renovationPhase: "etappe-1" })).total.gf;
    expect(gf(p) - gf(unsaniert)).toBeGreaterThan(0.25);
    const gfB = (q: Project) => computeAreaTable(q, "bestand").total.gf;
    expect(gfB(p)).toBeCloseTo(gfB(unsaniert), 9);
  });

  it("Decken und Dächer: Typ-Paare, Ops je Bauteilart, Bezugsseite unten", () => {
    const p = buildUmbauSampleProject();
    const kinds = renovationPairs(p).pairs.map((x) => `${x.kind}:${x.type}:${x.renovated}/${x.elements}`).sort();
    expect(kinds).toEqual(["ceiling:decke-bestand:1/1", "roof:dach-bestand:1/1", "wall:aw-bestand:1/1"]);
    // Decke: Rohdecke bleibt (Bezugsseite unten = „inside“), darüber alles neu.
    const pc = renovationPair(p, "decke-bestand", undefined, "ceiling");
    expect(pc?.kind).toBe("ceiling");
    expect(pc?.side).toBe("inside");
    expect(pc?.old.map((l) => l.fate)).toEqual(["demolish", "demolish", "demolish", "kept"]);
    expect(pc?.new.map((l) => l.fate)).toEqual(["new", "new", "new", "kept"]);
    // Dach: Sparren und Verkleidung bleiben, Ziegel ab, Dämmung und Ziegel neu.
    const pr = renovationPair(p, "dach-bestand", undefined, "roof");
    expect(pr?.old.map((l) => l.fate)).toEqual(["demolish", "kept", "kept"]);
    expect(pr?.new.map((l) => l.fate)).toEqual(["new", "new", "kept", "kept"]);
    // Bezugsseite oben (gleiche Gesamtdicke: die Rohdecke liegt auch von oben her gleich und bleibt).
    const q = applyOps(p, setTypePairOps(p, "decke-bestand", { side: "outside" }, "ceiling"));
    expect(q.ceilingTypes?.find((t) => t.id === "decke-bestand")?.renovationSide).toBe("outside");
    expect(renovationPair(q, "decke-bestand", undefined, "ceiling")?.side).toBe("outside");
    expect(renovationPair(q, "decke-bestand", undefined, "ceiling")?.old.map((l) => l.fate)).toEqual(["demolish", "demolish", "demolish", "kept"]);
    // Ops je Art: keiner / wie Typ, gemeinsamer Wert, Sanierungstyp anlegen, alle sanieren.
    const none = applyOps(p, setBuildUpOps(p, ["C1"], { kind: "none" }, "ceiling"));
    expect(none.ceilings?.find((c) => c.id === "C1")?.renovation).toEqual({ status: "existing", phase: "etappe-1" });
    expect(commonBuildUp(p, ["C1"], "ceiling")).toBe("type");
    expect(commonBuildUp(p, ["RF1"], "roof")).toBe("type");
    expect(commonBuildUp(p, ["W1"], "ceiling")).toBeNull();
    const { ops, id } = createRenovationTypeOps(p, "dg-massiv", "Decke saniert", "ceiling");
    const r = applyOps(p, ops);
    expect(r.ceilingTypes?.find((t) => t.id === "dg-massiv")?.renovationTarget).toBe(id);
    const s = applyOps(r, renovateAllOfTypeOps(r, "dg-massiv", "ceiling"));
    // C2 (Anbau) ist neu: nicht saniert; sonst trägt keine Decke „dg-massiv“.
    expect((s.ceilings ?? []).filter((c) => c.renovation?.renovated).map((c) => c.id)).toEqual(["C1"]);
  });
});
