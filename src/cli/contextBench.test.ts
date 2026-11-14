// [257] Leistung mit grossen Kontext-Importen: der synthetische Wettbewerbs-Kontext (`src/model/sampleContext.ts`:
// Kataster-DXF, Höhenlinien-DXF, Gebäudenetze) wird wie in der App importiert, danach messen `dossier-cli bench --context`
// die Ableitungen, Änderungen am eigenen Haus und Speichern/Laden. Die Schwellen sind grosszügig (Faktor ≥ 10 über den
// Werten auf einem Entwicklungsrechner, Container unter Last): sie fangen quadratisches Verhalten, keine Prozente.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { run } from "./main";
import { buildContextBuildingsObj, buildContextCadastreDxf, buildContextContoursDxf } from "../core";

beforeAll(() => {
  process.env.DOSSIER_WASM_DIR = join(process.cwd(), "src", "engine");
});

describe("synthetischer Kontext (Generator)", () => {
  it("ist deterministisch und liefert die angeforderten Mengen", () => {
    const o = { footprints: 120, buildings: 25, triangles: 5000, contours: 10, contourPoints: 16 };
    expect(buildContextCadastreDxf(o)).toBe(buildContextCadastreDxf(o));
    expect(buildContextBuildingsObj(o)).toBe(buildContextBuildingsObj(o));
    expect(buildContextContoursDxf(o)).toBe(buildContextContoursDxf(o));
    const obj = buildContextBuildingsObj(o);
    expect(obj.match(/^o /gm)).toHaveLength(25);
    const tris = obj.match(/^f /gm)?.length ?? 0;
    expect(tris).toBeGreaterThan(4000);
    expect(tris).toBeLessThan(6500);
    expect(buildContextCadastreDxf(o).match(/^LWPOLYLINE$/gm)!.length).toBeGreaterThanOrEqual(240); // Parzellen + Umrisse
    expect(buildContextContoursDxf(o).match(/^LWPOLYLINE$/gm)).toHaveLength(10);
    // Verschiebung wirkt (LV95-artig), sonst gleiche Struktur.
    expect(buildContextBuildingsObj({ ...o, originX: 2_600_000, originY: 1_200_000 })).not.toBe(obj);
  });
});

/** Zeilen „Name  12.3 ms" der Bench-Ausgabe. */
function rowsOf(text: string): Map<string, number> {
  const rows = new Map<string, number>();
  for (const l of text.split("\n")) {
    const m = /^(.*?)\s{2,}([\d.]+) ms$/.exec(l.trimEnd());
    if (m) rows.set(m[1].trim(), Number(m[2]));
  }
  return rows;
}

describe("dossier-cli bench --context", () => {
  it("Import, Ableitungen, Änderung am eigenen Haus und Speichern/Laden innerhalb der Schwellen", { timeout: 300_000 }, async () => {
    let text = "";
    const w = vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
      text += String(c);
      return true;
    });
    let code: number;
    try {
      code = await run([":beispiel", "bench", "--context", "--runs", "2", "--footprints", "400", "--buildings", "80", "--triangles", "30000", "--extent", "250"]);
    } finally {
      w.mockRestore();
    }
    expect(code).toBe(0);
    const rows = rowsOf(text);
    const get = (prefix: string): number => {
      const k = [...rows.keys()].find((n) => n.startsWith(prefix));
      if (k === undefined) throw new Error(`Zeile „${prefix}“ fehlt:\n${text}`);
      return rows.get(k)!;
    };
    // Der Kontext ist im Projekt (Netze auf dem Gelände gelandet).
    expect(text).toMatch(/Aufs Gelände setzen \(80 Netze\)/);
    // Import und Ableitungen (Entwicklungsrechner: 30–250 ms; Schwellen ≥ 10-fach).
    expect(get("Import Kataster.dxf: in den Kern")).toBeLessThan(2_000);
    expect(get("Import Gebäudenetz: in den Kern")).toBeLessThan(3_000);
    expect(get("Aufs Gelände setzen (")).toBeLessThan(3_000);
    expect(get("Grundriss eg 1:100 (kalt)")).toBeLessThan(2_000);
    expect(get("Schnitt (Kern)")).toBeLessThan(2_000);
    expect(get("generateElevationPlan")).toBeLessThan(4_000);
    expect(get("projectToModel3d (kalt)")).toBeLessThan(2_000);
    expect(get("Speichern (")).toBeLessThan(2_000);
    expect(get("Laden: parseProjectFile")).toBeLessThan(2_000);
    // Eine kleine Änderung am eigenen Haus: Undo/Redo und die Ableitungen rechnen den Kontext nicht neu (Undo/Redo:
    // Bruchteile einer Millisekunde; die Schwelle läge weit unter jeder Neuberechnung des Kontexts).
    expect(get("Doc: undo")).toBeLessThan(50);
    expect(get("Doc: redo")).toBeLessThan(50);
    expect(get("Grundriss eg 1:100 nach Wand verschieben")).toBeLessThan(1_500);
    expect(get("projectToModel3d nach 1 Wand-Änderung")).toBeLessThan(500);
    expect(get("Schnitt nach Wand verschieben")).toBeLessThan(2_000);
    expect(get("Ansicht nach Wand verschieben")).toBeLessThan(4_000);
  });
});
