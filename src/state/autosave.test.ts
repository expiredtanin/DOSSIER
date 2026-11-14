import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { autosaveKey, autosavePrevKey, clearAutosave, createAutosaveTracker, pickAutosave, readAutosave, setAutosaveBackend, writeAutosave } from "./autosave";
import type { AutosaveBackend } from "./autosave";
import { parseProjectFile, serializeProject } from "../io/projectFormat";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";

const edit = (p: Project, name: string): Project => ({ ...p, name });
const empty = { ...sampleProject, walls: [], drawings2d: [], openings: [], ceilings: [], roofs: [], stairs: [], rooms: [], columns: [], extrudedSolids: [], context: [] } as Project;

describe("Autosave-Entscheidung", () => {
  it("schreibt nur ungespeicherte, noch nicht gesicherte Stände mit Inhalt", () => {
    const tr = createAutosaveTracker();
    const saved = sampleProject;
    expect(tr.shouldWrite(saved, saved)).toBe(false);
    const a = edit(saved, "A");
    expect(tr.shouldWrite(a, saved)).toBe(true);
    expect(tr.shouldWrite(a, saved)).toBe(false); // schon gesichert
    expect(tr.shouldWrite(empty, saved)).toBe(false);
  });
  it("nach dem Löschen der Kopie wird derselbe ungespeicherte Stand wieder gesichert", () => {
    // Ablauf: Speichern beginnt mit Stand S, währenddessen Änderung A (vom Autosave gesichert),
    // Speichern endet → Kopie gelöscht, gespeichert ist aber nur S. A muss wieder gesichert werden.
    const tr = createAutosaveTracker();
    const s = edit(sampleProject, "S");
    const a = edit(s, "A");
    expect(tr.shouldWrite(a, sampleProject)).toBe(true);
    tr.cleared();
    expect(tr.shouldWrite(a, s)).toBe(true);
  });
});

/** Speicher im Arbeitsspeicher; `failWrites` simuliert volles Kontingent. */
function memoryBackend() {
  const m = new Map<string, { project: string; savedAt: number }>();
  let clock = 1000;
  const state = { failWrites: false };
  const b: AutosaveBackend = {
    read: async (n) => m.get(n) ?? null,
    write: async (n, text, savedAt) => {
      if (state.failWrites) return false;
      m.set(n, { project: text, savedAt: savedAt ?? ++clock });
      return true;
    },
    remove: async (n) => void m.delete(n),
  };
  return { b, m, state };
}
const valid = (text: string) => parseProjectFile(text).ok;

describe("Autosave-Speicher: zwei Stände, beschädigte Kopien, Fehler", () => {
  let mem: ReturnType<typeof memoryBackend>;
  beforeEach(() => {
    mem = memoryBackend();
    setAutosaveBackend(mem.b);
  });
  afterEach(() => setAutosaveBackend(null));

  const textA = serializeProject(edit(sampleProject, "A"));
  const textB = serializeProject(edit(sampleProject, "B"));

  it("neueste Kopie wird gelesen, die vorige bleibt als zweiter Stand", async () => {
    expect(await writeAutosave("/x/a.obp", textA)).toBe(true);
    expect(await writeAutosave("/x/a.obp", textB)).toBe(true);
    expect((await readAutosave("/x/a.obp"))?.text).toBe(textB);
    expect(mem.m.get(autosavePrevKey("/x/a.obp"))?.project).toBe(textA);
    const r = await pickAutosave("/x/a.obp", valid);
    expect(r.damaged).toBe(false);
    expect(r.found?.text).toBe(textB);
  });

  it("abgeschnittene neueste Kopie: kein Absturz, Hinweis, ältere Kopie wird angeboten", async () => {
    await writeAutosave(null, textA);
    await writeAutosave(null, textB);
    mem.m.set(autosaveKey(null), { project: textB.slice(0, textB.length >> 1), savedAt: 5000 });
    const r = await pickAutosave(null, valid);
    expect(r.damaged).toBe(true);
    expect(r.found?.text).toBe(textA);
    expect(mem.m.has(autosaveKey(null))).toBe(false); // beschädigte Kopie weg, wird nicht wieder angeboten
  });

  it("beide Kopien kaputt: leer plus Hinweis, beide gelöscht", async () => {
    mem.m.set(autosaveKey(null), { project: "{\"walls\": [", savedAt: 1 });
    mem.m.set(autosavePrevKey(null), { project: "", savedAt: 1 });
    const r = await pickAutosave(null, valid);
    expect(r).toEqual({ found: null, damaged: true });
    expect(mem.m.size).toBe(0);
  });

  it("keine Kopie: leer, ohne Hinweis", async () => {
    expect(await pickAutosave("/nie.obp", valid)).toEqual({ found: null, damaged: false });
  });

  it("Prüffunktion, die wirft, zählt als beschädigt", async () => {
    await writeAutosave(null, textA);
    const r = await pickAutosave(null, () => {
      throw new Error("Kern");
    });
    expect(r).toEqual({ found: null, damaged: true });
  });

  it("Schreibfehler (Kontingent voll) wird gemeldet, die vorige Kopie bleibt", async () => {
    await writeAutosave(null, textA);
    mem.state.failWrites = true;
    expect(await writeAutosave(null, textB)).toBe(false);
    expect((await readAutosave(null))?.text).toBe(textA);
  });

  it("wirft der Speicher, liefert writeAutosave false statt zu werfen", async () => {
    setAutosaveBackend({ ...mem.b, read: async () => { throw new Error("IDB"); } });
    await expect(writeAutosave(null, textA)).resolves.toBe(false);
  });

  it("Kopien liegen nur unter eigenen Schlüsseln, nie am Dateipfad; Löschen räumt beide Stände", async () => {
    await writeAutosave("/x/a.obp", textA);
    await writeAutosave("/x/a.obp", textB);
    for (const k of mem.m.keys()) expect(k.startsWith("autosave:")).toBe(true);
    expect(mem.m.has("/x/a.obp")).toBe(false);
    await clearAutosave("/x/a.obp");
    expect(mem.m.size).toBe(0);
  });

  it("Dateipfade sind getrennt (Speichern unter neuem Pfad schreibt nicht unter den alten)", async () => {
    await writeAutosave("/x/alt.obp", textA);
    await writeAutosave("/x/neu.obp", textB);
    expect((await readAutosave("/x/alt.obp"))?.text).toBe(textA);
    expect((await readAutosave("/x/neu.obp"))?.text).toBe(textB);
  });
});

describe("Autosave blockiert die Oberfläche nicht ([116])", () => {
  it("Grossgebäude (≈ 4000 Wände): Serialisieren + Prüfen je unter 500 ms (gemessen ≈ 35 ms, 1.7 MB)", async () => {
    const { buildBigSampleProject } = await import("../model/sampleProjectBig");
    const p = buildBigSampleProject();
    let t = performance.now();
    const text = serializeProject(p);
    const ser = performance.now() - t;
    t = performance.now();
    const ok = parseProjectFile(text).ok;
    const par = performance.now() - t;
    expect(ok).toBe(true);
    expect(ser).toBeLessThan(500);
    expect(par).toBeLessThan(500);
  });
});
