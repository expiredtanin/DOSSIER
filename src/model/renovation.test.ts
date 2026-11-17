// [271] Umbau: Ops zum Setzen von Status/Etappe, gemeinsame Werte bei Mehrfachauswahl, Etappen-Liste, Kern-Abfragen am
// Umbau-Beispiel (Grundriss je Filter, Kennzahlen Bestand/Endzustand, neue Bauteile mit Zeichen-Status).

import { describe, expect, it } from "vitest";
import { applyOps } from "../core/ops";
import { documentFor } from "../core/document";
import { commonRenovation, renovationFilterList, renovationForNew, setPhasesOps, setRenovationOps } from "./renovation";
import { buildUmbauSampleProject } from "./sampleProjectUmbau";
import { sampleProject } from "./sampleProject";
import { generatePlan } from "../plan/generatePlan";
import { computeKennzahlen } from "../analysis/kennzahlen";
import { computeAreaTable } from "../analysis/areaTable";
import type { Project } from "./types";

const ALL = new Set(["20", "21", "30", "31", "40", "60"]);

function fills(p: Project, filter?: string): string[] {
  const q = filter ? { ...p, drawingLevels: p.drawingLevels.map((l) => (l.id === "eg" ? { ...l, renovationFilter: filter } : l)) } : p;
  return generatePlan(q, "eg", ALL).primitives.flatMap((x) => (x.kind === "polygon" ? [x.fill] : []));
}

describe("[271] Umbau", () => {
  it("Status und Etappe setzen: ein Op je geändertem Element, Bestand ohne Etappe entfernt das Feld", () => {
    const p = sampleProject;
    const ops = setRenovationOps(p, ["W1", "W9", "O1", "nix"], "new", "e1");
    expect(ops).toHaveLength(3);
    const q = applyOps(p, ops);
    expect(q.walls.find((w) => w.id === "W1")?.renovation).toEqual({ status: "new", phase: "e1" });
    expect(commonRenovation(q, ["W1", "W9"])).toEqual({ status: "new", phase: "e1" });
    expect(commonRenovation(q, ["W1", "W2"]).status).toBe("mixed");
    // Nur den Status ändern: Etappe bleibt.
    const r = applyOps(q, setRenovationOps(q, ["W1"], "demolish"));
    expect(r.walls.find((w) => w.id === "W1")?.renovation).toEqual({ status: "demolish", phase: "e1" });
    // Zurück auf Bestand ohne Etappe: Feld weg.
    const s = applyOps(r, setRenovationOps(r, ["W1"], "existing", null));
    expect(s.walls.find((w) => w.id === "W1")).not.toHaveProperty("renovation");
    // Nichts zu ändern: keine Op (kein leerer Undo-Schritt).
    expect(setRenovationOps(s, ["W1"], "existing", null)).toHaveLength(0);
    expect(renovationForNew("existing")).toBeUndefined();
  });

  it("Etappe entfernen: Elemente verlieren sie, Status bleibt", () => {
    const p = buildUmbauSampleProject();
    const q = applyOps(p, setPhasesOps(p, [{ id: "etappe-1", name: "Etappe 1" }]));
    expect(q.renovation?.phases).toHaveLength(1);
    expect(q.walls.find((w) => w.id === "W10")?.renovation).toEqual({ status: "new" });
    expect(q.walls.find((w) => w.id === "W9")?.renovation).toEqual({ status: "demolish", phase: "etappe-1" });
  });

  it("Kern: Filterliste, Grundriss je Filter, Kennzahlen Bestand vs. Endzustand", () => {
    const p = buildUmbauSampleProject();
    expect(renovationFilterList(p).map((f) => f.id)).toEqual(["bestand", "abbruch", "neubau", "umbauplan", "endzustand"]);
    // Ohne Filter keine Umbau-Farben; Umbauplan grau, gelb und rot.
    expect(fills(p)).not.toContain("#e3001b");
    const u = fills(p, "umbauplan");
    for (const c of ["#a6a6a6", "#ffd800", "#e3001b"]) expect(u).toContain(c);
    // Neubau: kein Gelb (Abbruch weg), Rot da.
    const n = fills(p, "neubau");
    expect(n).not.toContain("#ffd800");
    expect(n).toContain("#e3001b");
    // Kennzahlen: der Anbau zählt nur im Endzustand.
    const b = computeKennzahlen(p, "bestand");
    const e = computeKennzahlen(p, "endzustand");
    expect(e.gf).toBeGreaterThan(b.gf);
    expect(computeAreaTable(p, "bestand")).not.toEqual(computeAreaTable(p, "endzustand"));
  });

  it("Zeichen-Status: der Kern gibt ihn neuen Bauteilen eines Zeichenbefehls", () => {
    const p = sampleProject;
    const doc = documentFor(p);
    const req = { cmd: "column", ctx: { level: "eg", cat: "50" }, stamp: "t271", at: { x: 1, y: 1 } };
    const added = (r: object) => doc.cmdOps(r).flatMap((o) => (o.kind === "add" ? (o.items as unknown as Array<{ renovation?: unknown }>) : []));
    expect(added({ ...req, renovation: { status: "new", phase: "e2" } })[0].renovation).toEqual({ status: "new", phase: "e2" });
    // Vorgabe Bestand: ohne Feld.
    expect(added(req)[0]).not.toHaveProperty("renovation");
  });
});
