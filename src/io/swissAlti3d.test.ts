// Tests für die reinen (netzwerkfreien) Bausteine des swissALTI3D-XYZ-Imports:
// ASCII-Parsing + Grid-Aufbau (Merge/Clip/Dezimierung). Der eigentliche
// Netzwerk-Fetch (`fetchTerrainXyz`) bleibt ungetestet, analog zu
// `swissTopo.ts::fetchTerrain`/`geocode` (kein Fetch-Mocking im Repo).

import { describe, it, expect } from "vitest";
import { parseXyzPoints, buildTerrainGrid } from "./swissAlti3d";

describe("parseXyzPoints", () => {
  it("parst 'E N Z'-Zeilen zu einer Punkt-Map + sortierten Achsen", () => {
    const text = "2600000.00 1200000.00 500.5\n2600002.00 1200000.00 501.0\n2600000.00 1200002.00 502.3\n";
    const { points, es, ns } = parseXyzPoints(text);
    expect(points.get("2600000,1200000")).toBe(500.5);
    expect(points.get("2600002,1200000")).toBe(501);
    expect(es).toEqual([2600000, 2600002]);
    expect(ns).toEqual([1200000, 1200002]);
  });

  it("überspringt Kopfzeilen/kaputte Zeilen ohne 3 Zahlen", () => {
    const text = "E N Z\nnot a number line\n2600000 1200000 500\n\n";
    const { points } = parseXyzPoints(text);
    expect(points.size).toBe(1);
  });

  it("liefert eine leere Map bei leerem Text", () => {
    const { points, es, ns } = parseXyzPoints("");
    expect(points.size).toBe(0);
    expect(es).toEqual([]);
    expect(ns).toEqual([]);
  });
});

describe("buildTerrainGrid", () => {
  it("baut ein reguläres Grid aus einer einzelnen Kachel, x/y relativ zur Origin", () => {
    const tile = parseXyzPoints(
      "2600000 1200000 500\n2600002 1200000 501\n2600000 1200002 502\n2600002 1200002 503\n",
    );
    const grid = buildTerrainGrid([tile], { e: 2600000, n: 1200000 }, [
      2599990, 1199990, 2600010, 1200010,
    ]);
    expect(grid).not.toBeNull();
    expect(grid!.xs).toEqual([0, 2]);
    expect(grid!.ys).toEqual([0, 2]);
    expect(grid!.z).toEqual([
      [500, 501],
      [502, 503],
    ]);
  });

  it("clippt Punkte ausserhalb der bbox weg", () => {
    const tile = parseXyzPoints("2600000 1200000 500\n2600100 1200100 999\n");
    const grid = buildTerrainGrid([tile], { e: 2600000, n: 1200000 }, [
      2599990, 1199990, 2600010, 1200010,
    ]);
    expect(grid!.xs).toEqual([0]);
    expect(grid!.ys).toEqual([0]);
    expect(grid!.z).toEqual([[500]]);
  });

  it("merged mehrere Kacheln zu einem gemeinsamen Grid", () => {
    const a = parseXyzPoints("2600000 1200000 500\n2600002 1200000 501\n");
    const b = parseXyzPoints("2600000 1200002 502\n2600002 1200002 503\n");
    const grid = buildTerrainGrid([a, b], { e: 2600000, n: 1200000 }, [
      2599990, 1199990, 2600010, 1200010,
    ]);
    expect(grid!.xs).toEqual([0, 2]);
    expect(grid!.ys).toEqual([0, 2]);
    expect(grid!.z).toEqual([
      [500, 501],
      [502, 503],
    ]);
  });

  it("liefert null, wenn nach dem Clipping nichts übrig bleibt", () => {
    const tile = parseXyzPoints("2600100 1200100 999\n");
    const grid = buildTerrainGrid([tile], { e: 2600000, n: 1200000 }, [
      2599990, 1199990, 2600010, 1200010,
    ]);
    expect(grid).toBeNull();
  });

  it("dezimiert das Raster gleichmässig, wenn es die Zellenzahl-Grenze überschreitet", { timeout: 60_000 }, () => {
    // 700×700 = 490'000 Zellen > MAX_GRID_CELLS (400'000) -> muss dezimiert werden.
    const lines: string[] = [];
    for (let i = 0; i < 700; i++) {
      for (let j = 0; j < 700; j++) lines.push(`${2600000 + i} ${1200000 + j} ${500 + i + j}`);
    }
    const tile = parseXyzPoints(lines.join("\n"));
    const grid = buildTerrainGrid([tile], { e: 2600000, n: 1200000 }, [
      2599000, 1199000, 2601000, 1201000,
    ]);
    expect(grid).not.toBeNull();
    expect(grid!.xs.length * grid!.ys.length).toBeLessThanOrEqual(490_000 / 4 + 1);
  });
});
