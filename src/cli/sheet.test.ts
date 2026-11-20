// [323] dossier-cli sheet: Layout-Blatt als SVG (Viewports, Schriftfeld, Tabellen) und Präsentationsblatt/Plakat headless anlegen.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./main";
import { makeTmpDir } from "../test/tmpDir";

const dir = makeTmpDir("dossier-sheet-");

beforeAll(() => {
  process.env.DOSSIER_WASM_DIR = join(process.cwd(), "src", "engine");
});

async function quiet<T>(fn: () => Promise<T>): Promise<{ code: T; err: string }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((c) => (chunks.push(String(c)), true));
  try {
    return { code: await fn(), err: chunks.join("") };
  } finally {
    spy.mockRestore();
  }
}

describe("dossier-cli sheet", () => {
  it("exportiert das Präsentationsblatt des Wettbewerb-Beispiels mit Viewports und Schriftfeld", async () => {
    const out = join(dir, "pres.svg");
    const r = await quiet(() => run([":wettbewerb", "sheet", "--name", "Präsentationsplan", "--out", out]));
    expect(r.code).toBe(0);
    const svg = readFileSync(out, "utf8");
    expect(svg).toContain('viewBox="0 0 841 594"');
    // Neun Viewports (3 Geschosse, 4 Ansichten, 2 Schnitte) als verschachtelte <svg>, dazu Schriftfeld mit Projektname.
    expect((svg.match(/<svg /g) ?? []).length).toBeGreaterThanOrEqual(10);
    expect(svg).toContain("Wettbewerb Hofwiesen");
    expect(svg).toContain("Erdgeschoss");
  });

  it("--create-presentation --poster: Plakat mit Kopfzeile und Tabellen", async () => {
    const out = join(dir, "plakat.svg");
    const r = await quiet(() => run([":wettbewerb", "sheet", "--create-presentation", "--poster", "poster-a0-portrait", "--out", out]));
    expect(r.code).toBe(0);
    expect(r.err).toContain("Präsentationsblatt angelegt");
    const svg = readFileSync(out, "utf8");
    expect(svg).toContain('viewBox="0 0 841 1189"');
    expect(svg).toContain("Kennzahlen (SIA 416)");
    expect(svg).toContain("Plan 1/1");
    expect(svg).toContain("1:500");
  });

  it("--list nennt die Blätter, unbekannter Name und PDF-Ziel scheitern verständlich", async () => {
    expect((await quiet(() => run([":wettbewerb", "sheet", "--list"]))).code).toBe(0);
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    try {
      const bad = await quiet(() => run([":wettbewerb", "sheet", "--name", "gibtsnicht", "--out", join(dir, "x.svg")]).catch((e: Error) => e.message));
      expect(bad.code).toBe("exit 1");
      expect(bad.err).toContain("Blatt nicht gefunden");
      const pdf = await quiet(() => run([":wettbewerb", "sheet", "--out", join(dir, "x.pdf")]).catch((e: Error) => e.message));
      expect(pdf.code).toBe("exit 1");
      expect(pdf.err).toContain("PDF braucht ein DOM");
    } finally {
      exit.mockRestore();
    }
    expect(existsSync(join(dir, "x.pdf"))).toBe(false);
  });
});
