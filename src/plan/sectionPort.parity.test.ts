// VORÜBERGEHEND ([K3c]): Gleichheit alte TS-Fassung gegen den Kern (Schnitt/Ansicht). Wird mit
// der TS-Fassung gelöscht.
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setWasmBytesProvider } from "../engine/wasmSource";
import { computeSection as oldCompute } from "./toSection";
import { generateSectionPlan as oldGen } from "./generatePlan";
import { sectionOpeningPrimitives } from "./sectionOpenings";
import { computeSection as newCompute, generateSectionPlan as newGen, generateElevationPlan as newElev } from "./sectionCore";
import { generateElevationPlan as oldElev, type ElevationOptions } from "./toElevation";
import { sampleProject } from "../model/sampleProject";
import { flattenCategories } from "../model/types";
import type { DrawingLevel, Project } from "../model/types";
import type { CategoryDisplayResolver, Plan, Primitive } from "./generatePlan";
import { planToRenderScene } from "./toRenderScene";
import { planToSvgString } from "../export/planToSvgString";
import { bigSectionProject, randomSectionProject, rng, sectionLevels } from "./sectionParity.testing";

beforeAll(() => {
  setWasmBytesProvider(async (name) =>
    readFileSync(join(process.cwd(), "src", "engine", name === "trucksolid" ? "pkgTruck/trucksolid_bg.wasm" : "pkg3d/render3d_bg.wasm")),
  );
});

/** Erster Unterschied (Pfad) zweier Werte; Zahlen per Object.is, fehlend = undefined. */
function diff(a: unknown, b: unknown, path = ""): string | null {
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b) ? null : `${path}: ${a} != ${b}`;
  if (a === b) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: Länge ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
      const d = diff(ra[k], rb[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}

const FALLBACK_HATCH = { pattern: "diagonal", scale: 1, angle: 45, color: "#0f0f0f", lineWeight: 0.13, dash: null };

/** Alte Ausgabe: render3d-interne Schraffur (Muster als Zahl), die als Plan-Schraffur durchsickerte, wird
 *  zur vorgesehenen Rückfall-Schraffur (Fehler der alten Fassung, s. TODO [K3c]). */
function fixOld(p: Primitive, mono: boolean): Primitive {
  if (p.kind !== "polygon" || typeof (p.hatch as { pattern: unknown }).pattern !== "number") return p;
  stats.foreignHatch++;
  return { ...p, hatch: mono ? { ...FALLBACK_HATCH, color: "#1f242c" } : FALLBACK_HATCH, fill: mono ? "#f0f0f0" : p.fill } as Primitive;
}

interface Opts { mono: boolean; hiddenLines?: boolean; visibleCodes?: Set<string>; categoryDisplay?: CategoryDisplayResolver; openings: boolean }

function optionSets(project: Project, seed: number): Opts[] {
  const r = rng(seed * 13 + 5);
  const codes = [...flattenCategories(project.layers).map((c) => c.code), "22", "99"];
  const vis = new Set(codes.filter(() => r() < 0.75));
  const grey = new Set(codes.filter(() => r() < 0.3));
  const hide = new Set(codes.filter(() => r() < 0.15));
  const disp: CategoryDisplayResolver = (c) => ({ render: !hide.has(c), greyed: grey.has(c), locked: false });
  return [
    { mono: false, openings: false, visibleCodes: new Set(codes) },
    { mono: true, openings: true, hiddenLines: true, visibleCodes: vis, categoryDisplay: disp },
    { mono: false, openings: true, categoryDisplay: disp },
  ];
}

async function oldPlan(project: Project, level: DrawingLevel, o: Opts): Promise<{ prims: Primitive[]; raw: Primitive[]; bounds: Plan["bounds"] } | null> {
  const out = await oldCompute(project, level);
  if (!out) return null;
  const plan = oldGen(out, o.mono, { hiddenLines: o.hiddenLines, visibleCodes: o.visibleCodes, categoryDisplay: o.categoryDisplay });
  const ops = o.openings ? sectionOpeningPrimitives(project, level, o.visibleCodes, o.categoryDisplay) : [];
  return { prims: [...plan.primitives.map((p) => fixOld(p, o.mono)), ...ops], raw: [...plan.primitives, ...ops], bounds: plan.bounds };
}

async function newPlan(project: Project, level: DrawingLevel, o: Opts): Promise<{ prims: Primitive[]; bounds: Plan["bounds"]; plan: Plan } | null> {
  const out = await newCompute(project, level);
  if (!out) return null;
  const plan = newGen(out, o.mono, o);
  return { prims: plan.primitives, bounds: plan.bounds, plan };
}

/** Szene (render2d) und SVG wie die Verbraucher: alt als gewöhnlicher Plan, neu aus dem Puffer. */
function outputsDiffer(a: { prims: Primitive[]; raw: Primitive[]; bounds: Plan["bounds"] }, b: Plan): string | null {
  const sa = JSON.stringify(planToRenderScene({ primitives: a.prims, bounds: a.bounds }, 100));
  const sb = JSON.stringify(planToRenderScene(b, 100));
  if (sa !== sb) return "Szene verschieden";
  const va = planToSvgString({ primitives: a.raw, bounds: a.bounds }, { scaleDenominator: 100 });
  const vb = planToSvgString(b, { scaleDenominator: 100 });
  return va === vb ? null : "SVG verschieden";
}

async function settle<T>(f: () => Promise<T>): Promise<{ ok: T } | { err: string }> {
  try {
    return { ok: await f() };
  } catch (e) {
    return { err: String(e) };
  }
}

/** Vergleicht alt/neu für eine Ebene; liefert Fehlertext oder null. */
async function compareSection(project: Project, level: DrawingLevel, o: Opts): Promise<string | null> {
  const a = await settle(() => oldPlan(project, level, o));
  const b = await settle(() => newPlan(project, level, o));
  if ("err" in a || "err" in b) {
    if ("err" in a && "err" in b) {
      stats.errors++;
      return null;
    }
    return `Fehler nur auf einer Seite: alt ${"err" in a ? a.err : "ok"}, neu ${"err" in b ? b.err : "ok"}`;
  }
  stats.prims += a.ok?.prims.length ?? 0;
  if (!a.ok || !b.ok) return a.ok === b.ok ? null : "null nur auf einer Seite";
  return diff({ prims: a.ok.prims, bounds: a.ok.bounds }, { prims: b.ok.prims, bounds: b.ok.bounds }) ?? (FULL ? outputsDiffer(a.ok, b.ok.plan) : null);
}

/** Szene und SVG mitvergleichen (langsamer). */
const FULL = process.env.PARITY_FULL !== "0";

let stats = { levels: 0, prims: 0, errors: 0, foreignHatch: 0, elevations: 0, elevPrims: 0, elevErrors: 0 };

function elevOptions(project: Project, seed: number): ElevationOptions[] {
  const [, b, c] = optionSets(project, seed);
  return [{}, { mono: true, visibleCodes: b.visibleCodes, categoryDisplay: b.categoryDisplay }, { shadows: true, categoryDisplay: c.categoryDisplay }, { shadows: false, visibleCodes: b.visibleCodes }];
}

function compareElevation(project: Project, level: DrawingLevel, o: ElevationOptions): string | null {
  const run = (f: typeof oldElev) => {
    try {
      const pl = f(project, level, o);
      return { ok: pl ? { prims: pl.primitives, bounds: pl.bounds, plan: pl } : null };
    } catch (e) {
      return { err: String(e) };
    }
  };
  const a = run(oldElev);
  const b = run(newElev);
  if ("err" in a || "err" in b) {
    if ("err" in a && "err" in b) {
      stats.elevErrors++;
      return null;
    }
    return `Fehler nur auf einer Seite: alt ${"err" in a ? a.err : "ok"}, neu ${"err" in b ? b.err : "ok"}`;
  }
  stats.elevPrims += a.ok?.prims.length ?? 0;
  if (!a.ok || !b.ok) return a.ok === b.ok ? null : "null nur auf einer Seite";
  return diff({ prims: a.ok.prims, bounds: a.ok.bounds }, { prims: b.ok.prims, bounds: b.ok.bounds }) ??
    (FULL ? outputsDiffer({ prims: a.ok.prims, raw: a.ok.prims, bounds: a.ok.bounds }, b.ok.plan) : null);
}

async function check(project: Project, levels: DrawingLevel[], label: string, seed = 1) {
  const sets = optionSets(project, seed);
  for (const level of levels.filter((l) => l.kind === "section")) {
    for (const [k, o] of sets.entries()) {
      const d = await compareSection(project, level, o);
      expect(d, `${label} ${level.id} Optionen ${k}`).toBeNull();
      stats.levels++;
    }
  }
  for (const level of levels.filter((l) => l.kind === "elevation")) {
    for (const [k, o] of elevOptions(project, seed).entries()) {
      const d = compareElevation(project, level, o);
      expect(d, `${label} ${level.id} Ansicht-Optionen ${k}`).toBeNull();
      stats.elevations++;
    }
  }
}

describe("Schnitt und Ansicht: Kern gleich alter TS-Fassung", () => {
  it("Beispielprojekt, viele Schnittlinien", async () => {
    const own = sampleProject.drawingLevels;
    await check(sampleProject, [...own, ...sectionLevels(sampleProject, 1, 40)], "Beispiel");
  }, 600_000);

  it("Zufallsprojekte", async () => {
    const n = Number(process.env.PARITY_N ?? 60);
    for (let seed = 1; seed <= n; seed++) {
      const p = randomSectionProject(seed);
      await check(p, sectionLevels(p, seed, 12), `Saat ${seed}`, seed);
    }
    console.log("Gleichheit:", stats);
  }, 3_600_000);

  it("Grosses Projekt (6×6)", async () => {
    const p = bigSectionProject(6);
    await check(p, p.drawingLevels, "big6");
    console.log("Gleichheit (gesamt):", stats);
  }, 600_000);
});
