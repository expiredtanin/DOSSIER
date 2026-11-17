// [271] Umbau: Ops zum Setzen von Status/Etappe, gemeinsame Werte bei Mehrfachauswahl, Etappen-Liste, Kern-Abfragen am
// Umbau-Beispiel (Grundriss je Filter, Kennzahlen Bestand/Endzustand, neue Bauteile mit Zeichen-Status).

import { describe, expect, it } from "vitest";
import { applyOps } from "../core/ops";
import { documentFor } from "../core/document";
import {
  commonRenovation, idsByRenovationStatus, phaseUsage, renovatableIds, renovationCounts, renovationFilterList, renovationFilterShows, renovationForNew, renovationStyleOf, RENOVATION_STATUSES,
  setPhasesOps, setRenovationOps,
} from "./renovation";
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

  // ── Panel „Umbau“ ──
  it("Panel: Vorschau je Filter stimmt mit dem Grundriss des Kerns überein (Override = Farbe da, Hide/Show = keine)", () => {
    const p = buildUmbauSampleProject();
    const colour = { existing: "#a6a6a6", demolish: "#ffd800", new: "#e3001b" } as const;
    for (const f of renovationFilterList(p)) {
      const shows = renovationFilterShows(p, f.id)!;
      const got = fills(p, f.id);
      for (const st of RENOVATION_STATUSES) {
        expect(renovationStyleOf(p, st).fill).toBe(colour[st]);
        expect(got.includes(colour[st]), `${f.id}/${st}`).toBe(shows[st] === "override");
      }
    }
    expect(renovationFilterShows(p, "gibtsnicht")).toBeNull();
    const own = { ...p, renovation: { ...p.renovation, filters: [{ id: "x", name: "X", existing: "hide" as const, demolish: "show" as const, new: "override" as const }], styles: { new: { fill: "#00ff00" } } } };
    expect(renovationFilterShows(own, "x")).toEqual({ existing: "hide", demolish: "show", new: "override" });
    expect(renovationStyleOf(own, "new").fill).toBe("#00ff00");
    expect(renovationStyleOf(own, "new").dashed).toBe(false);
  });

  it("Panel: Auswahl nach Status (Öffnung folgt der Wand), Geschoss- und Etappenfilter, Zählung", () => {
    const p = buildUmbauSampleProject();
    const dem = idsByRenovationStatus(p, "demolish");
    expect(dem.walls).toContain("W9");
    expect(dem.openings).toContain("O2");
    // Öffnung ohne eigenen Status: der Status ihrer Wand.
    const o = p.openings!.find((x) => !x.renovation)!;
    const host = p.walls.find((w) => w.id === o.hostWallId)!;
    expect(idsByRenovationStatus(p, host.renovation?.status ?? "existing").openings).toContain(o.id);
    expect(idsByRenovationStatus(p, "demolish", { floorId: "og-gibts-nicht" })).toEqual({});
    expect(idsByRenovationStatus(p, "demolish", { phase: "etappe-1" }).walls).toContain("W9");
    expect(idsByRenovationStatus(p, "demolish", { phase: "etappe-2" }).walls ?? []).not.toContain("W9");
    const n = renovationCounts(p);
    expect(n.demolish).toBeGreaterThan(0);
    expect(n.new).toBeGreaterThan(0);
    expect(n.existing + n.demolish + n.new).toBe(Object.values(idsByRenovationStatus(p, "existing")).flat().length + n.demolish + n.new);
  });

  it("Panel: Etappen-Nutzung für die Rückfrage beim Löschen", () => {
    const p = buildUmbauSampleProject();
    expect(phaseUsage(p, "etappe-1")).toBeGreaterThan(0);
    expect(phaseUsage(p, "nix")).toBe(0);
  });

  it("Möbel und Bäume tragen den Umbau-Status (Baum: sein Bestand ist der Status)", () => {
    const p = buildUmbauSampleProject();
    // Beispiel: Sofa Bestand, Tisch Abbruch, Sofa neu; Baum zu fällen = Abbruch, neuer Baum = Neu.
    const dem = idsByRenovationStatus(p, "demolish");
    expect(dem.drawings).toEqual(["M2"]);
    expect(dem.trees).toEqual(["B1"]);
    expect(idsByRenovationStatus(p, "new").drawings).toEqual(["M3"]);
    expect(idsByRenovationStatus(p, "new").trees).toEqual(["B2"]);
    expect(idsByRenovationStatus(p, "existing").drawings).toEqual(["M1"]);
    // Linien und Masse ohne Angabe nehmen nicht teil (sonst wären sie im Umbauplan grau).
    const withLine = { ...p, drawings2d: [...p.drawings2d, { id: "L0", type: "drawing2d" as const, levelId: "eg", categoryCode: "20", geom: { shape: "line" as const, a: { x: 0, y: 0 }, b: { x: 1, y: 0 } } }] };
    expect(idsByRenovationStatus(withLine, "existing").drawings).toEqual(["M1"]);
    // Setzen: Möbel bekommen `renovation`, Bäume ihren `status` (zu fällen = Abbruch).
    const ops = setRenovationOps(p, ["M1", "B2"], "demolish");
    expect(ops).toHaveLength(2);
    const q = applyOps(p, ops);
    expect(q.drawings2d.find((d) => d.id === "M1")?.renovation?.status).toBe("demolish");
    expect(q.trees?.find((t) => t.id === "B2")?.status).toBe("remove");
    expect(commonRenovation(q, ["M1", "B2"]).status).toBe("demolish");
    expect(commonRenovation(p, ["M1", "B1"]).status).toBe("mixed");
    // Zurück auf Bestand: das Möbel verliert das Feld, der Baum wird bestehend.
    const back = applyOps(q, setRenovationOps(q, ["M1", "B2"], "existing"));
    expect(back.drawings2d.find((d) => d.id === "M1")?.renovation).toBeUndefined();
    expect(back.trees?.find((t) => t.id === "B2")?.status).toBe("existing");
    expect(renovatableIds(p, ["M1", "B1", "gibts-nicht"]).sort()).toEqual(["B1", "M1"]);
  });
});
