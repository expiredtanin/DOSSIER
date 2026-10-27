// IFC-Export gegen ifcopenshell prüfen ([B1]/[18]): Schema, Express-Regeln und Geometrie je Bauteil
// (`scripts/validate-ifc.py`). Ohne Python/ifcopenshell wird der Test übersprungen — in der CI ist
// es installiert (.github/workflows/check.yml).

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportIfcSpf } from "./exportIfc";
import { sampleProject } from "../model/sampleProject";

const hasIfcOpenShell = spawnSync("python3", ["-c", "import ifcopenshell, ifcopenshell.validate, _pytest"]).status === 0;

function validate(name: string, ifc: string): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "dossier-ifc-"));
  const file = join(dir, `${name}.ifc`);
  writeFileSync(file, ifc);
  const r = spawnSync("python3", ["scripts/validate-ifc.py", file], { encoding: "utf8", timeout: 120_000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe.skipIf(!hasIfcOpenShell)("IFC-Export gegen ifcopenshell", () => {
  it("Demo-Haus: gültig, alle Körper erzeugbar", () => {
    const r = validate("demo-haus", exportIfcSpf(sampleProject));
    expect(r.out).toContain("0 Befunde");
    expect(r.status).toBe(0);
  });
  it("Umlaute in Namen", () => {
    const p = { ...sampleProject, name: "Wohnüberbauung «Süd»", rooms: (sampleProject.rooms ?? []).map((r) => ({ ...r, name: "Küche/Essen" })) };
    const r = validate("umlaute", exportIfcSpf(p));
    expect(r.out).toContain("0 Befunde");
    expect(r.status).toBe(0);
  });
  it("mit Stütze (Rechteck und rund)", () => {
    const col = (id: string, profile: { kind: "rect"; width: number; depth: number } | { kind: "round"; radius: number }) => ({
      id, type: "column" as const, floorId: "eg", categoryCode: "50", position: { x: 1, y: 1 }, profile, rotation: 0.3, height: 2.5,
    });
    const p = { ...sampleProject, columns: [col("S1", { kind: "rect", width: 0.3, depth: 0.2 }), col("S2", { kind: "round", radius: 0.15 })] };
    const r = validate("stuetzen", exportIfcSpf(p));
    expect(r.out).toContain("0 Befunde");
    expect(r.status).toBe(0);
  });
});
