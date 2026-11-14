import { beforeEach, describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { buildWettbewerbSampleProject } from "../model/sampleProjectWettbewerb";
import { generatePlan } from "./generatePlan";
import { getState } from "../state/appStore";
import { sheetSizeMm } from "../model/layoutModel";
import { posterMetrics } from "../model/posterTemplates";
import { POSTER_EXTRAS_DEFAULT, PRESENTATION_TEMPLATE_ID, levelHasContent, planPresentationSheet, presentationDefaults, presentationSheetOps } from "./presentationSheet";
import type { Project } from "../model/types";

const LABELS = {
  sheetName: "Präsentationsplan",
  masterName: "Planrahmen",
  north: "N",
  northGroup: "Nordpfeil",
  scaleBarGroup: "Massstabsbalken",
  situation: "Situation",
  tableAreas: "Kennzahlen (SIA 416)",
  tableSiteProof: "Baurecht-Nachweis",
  imagePlaceholder: "3D-Bild hier einsetzen",
  imageHint: "Hinweis",
};
const st = () => getState();

function overlaps(a: { xMm: number; yMm: number; widthMm: number; heightMm: number }, b: typeof a): boolean {
  return a.xMm < b.xMm + b.widthMm && b.xMm < a.xMm + a.widthMm && a.yMm < b.yMm + b.heightMm && b.yMm < a.yMm + a.heightMm;
}

describe("[66] Präsentationsplan", () => {
  let project: Project;
  beforeEach(() => {
    st().loadProject(buildComplexSampleProject());
    st().clearHistory();
    project = st().project;
  });

  it("Vorschlag: alle Geschosse, Ansichten, ein Schnitt, A1 quer (Master)", () => {
    const d = presentationDefaults(project);
    expect(d.floors.length).toBeGreaterThanOrEqual(4);
    expect(d.elevationIds.length).toBeGreaterThan(0);
    expect(d.sectionId).not.toBeNull();
    expect([d.paper, d.orientation]).toEqual(["a1", "landscape"]);
    expect(d.sketch).toBe(false);
  });

  it("ein Undo-Schritt: Blatt mit je einem Viewport pro Ebene, alle auf dem Blatt, ohne Überlappung", () => {
    const o = presentationDefaults(project);
    const elevations = project.drawingLevels.filter((l) => l.kind === "elevation").length;
    const layoutsBefore = (project.layouts ?? []).length;
    const res = presentationSheetOps(project, o, LABELS, "t1");
    expect(res).not.toBeNull();
    const { ops, layoutId, plan } = res!;
    expect([50, 100, 200]).toContain(plan.scale);
    expect(plan.fits).toBe(true);
    st().applyChange(ops);
    expect(st().undoDepth).toBe(1);
    const p = st().project;
    const lay = p.layouts!.find((l) => l.id === layoutId)!;
    expect(lay.viewports.length).toBe(o.floors.length + elevations + 1);
    expect(lay.masterId).toBeTruthy();
    const size = sheetSizeMm(lay.paper, lay.orientation);
    for (const [i, v] of lay.viewports.entries()) {
      expect(v.xMm).toBeGreaterThanOrEqual(0);
      expect(v.yMm).toBeGreaterThanOrEqual(0);
      expect(v.xMm + v.widthMm).toBeLessThanOrEqual(size.w);
      expect(v.yMm + v.heightMm).toBeLessThanOrEqual(size.h);
      expect(v.scaleDenominator).toBe(plan.scale);
      for (const w of lay.viewports.slice(i + 1)) expect(overlaps(v, w)).toBe(false);
      const snap = p.viewSnapshots!.find((s) => s.id === v.snapshotId)!;
      expect(snap.templateId).toBe(PRESENTATION_TEMPLATE_ID);
      expect(snap.templateLinked).toBe(true);
    }
    // Titel je Viewport + Nordpfeil + Massstabsbalken (2 Beschriftungen) auf der Blatt-Ebene.
    const sheet = p.drawingLevels.find((l) => l.layoutId === layoutId)!;
    const onSheet = p.drawings2d.filter((d) => d.levelId === sheet.id);
    const texts = onSheet.filter((d) => d.geom.shape === "text");
    expect(texts.length).toBe(lay.viewports.length + 1 + 2);
    expect(onSheet.filter((d) => /-s\d$/.test(d.id) && d.geom.shape === "polyline").length).toBe(5);
    // [137] Nordpfeil und Massstabsbalken sind je eine Gruppe (Klick wählt, verschiebt und löscht sie als Ganzes).
    const groups = (p.groups ?? []).filter((g) => g.drawingIds.some((id) => onSheet.some((d) => d.id === id)));
    expect(groups.map((g) => g.drawingIds.length).sort()).toEqual([4, 7]);
    expect(groups.every((g) => g.name && g.drawingIds.every((id) => onSheet.some((d) => d.id === id)))).toBe(true);
    // Titel und Balken liegen auf dem Blatt.
    for (const d of onSheet) if (d.geom.shape === "text") {
      expect(d.geom.at.x * 1000).toBeGreaterThan(0);
      expect(d.geom.at.x * 1000).toBeLessThan(size.w);
      expect(-d.geom.at.y * 1000).toBeLessThan(size.h);
    }
    // Skizze aus: Ebenen unverändert; Ansichten mit Schatten (Vorlage).
    expect(p.drawingLevels.some((l) => l.sketch)).toBe(false);
    expect(p.drawingLevels.filter((l) => l.kind === "elevation").every((l) => l.shadows)).toBe(true);
    st().undo();
    expect((st().project.layouts ?? []).length).toBe(layoutsBefore);
    expect(st().project.viewSnapshots?.some((s) => s.id.startsWith("vs-pres-"))).toBe(false);
    // [207] 60 s: mit den Nachbargebäuden des Musterhauses rechnet das Blatt im Container knapp über die 30 s des Standards.
  }, 60_000);

  it("gewählte Geschosse, ohne Ansichten/Schnitt, Skizze an, A3: kleinerer Massstab", () => {
    const floors = project.drawingLevels.filter((l) => l.kind === "floor" && !l.layoutId).slice(0, 2).map((l) => l.id);
    const res = presentationSheetOps(project, { floors, elevationIds: [], scale: null, sectionId: null, paper: "a3", orientation: "landscape", sketch: true }, LABELS, "t2")!;
    expect(res.plan.items.map((i) => i.levelId)).toEqual(floors);
    expect(res.plan.scale).toBeGreaterThanOrEqual(100);
    st().applyChange(res.ops);
    const p = st().project;
    expect(p.layouts!.find((l) => l.id === res.layoutId)!.viewports.length).toBe(2);
    expect(floors.every((id) => p.drawingLevels.find((l) => l.id === id)!.sketch)).toBe(true);
  });

  it("nichts gewählt ⇒ null, Projekt unverändert", () => {
    expect(presentationSheetOps(project, { floors: [], elevationIds: [], scale: null, sectionId: null, paper: "a1", orientation: "landscape", sketch: false }, LABELS, "t3")).toBeNull();
  });

  it("[224] Vorschlag: leere Geschosse nicht vorgewählt, Vorgabe 1:200", () => {
    const floor = project.drawingLevels.find((l) => l.kind === "floor" && !l.layoutId)!;
    const withEmpty = { ...project, drawingLevels: [...project.drawingLevels, { ...floor, id: "lv-leer", name: "OG leer", baseElevation: 99 }] };
    const d = presentationDefaults(withEmpty);
    expect(d.floors).not.toContain("lv-leer");
    expect(d.floors).toContain(floor.id);
    expect(d.scale).toBe(200);
    expect(levelHasContent(withEmpty, "lv-leer")).toBe(false);
    expect(levelHasContent(withEmpty, floor.id)).toBe(true);
  });

  it("[224] fester Massstab und Massstab je Viewport landen in Ausschnitt und Viewport", () => {
    const floors = project.drawingLevels.filter((l) => l.kind === "floor" && !l.layoutId).slice(0, 2).map((l) => l.id);
    const res = presentationSheetOps(project, { floors, elevationIds: [], scale: 200, scales: { [floors[1]]: 100 }, sectionId: null, paper: "a1", orientation: "landscape", sketch: false }, LABELS, "t4")!;
    expect(res.plan.scale).toBe(200);
    expect(res.plan.items.map((i) => i.scale)).toEqual([200, 100]);
    st().applyChange(res.ops);
    const lay = st().project.layouts!.find((l) => l.id === res.layoutId)!;
    expect(lay.viewports.map((v) => v.scaleDenominator)).toEqual([200, 100]);
    expect(st().project.viewSnapshots!.filter((v) => v.id.startsWith("vs-pres-t4")).map((v) => v.scaleDenominator)).toEqual([200, 100]);
  });

  it("[224] Plakat-Vorlage als Ziel: Master der Vorlage, Viewports unter der Kopfzeile", () => {
    const floors = project.drawingLevels.filter((l) => l.kind === "floor" && !l.layoutId).slice(0, 2).map((l) => l.id);
    const res = presentationSheetOps(project, { floors, elevationIds: [], scale: 200, sectionId: null, paper: "a4", orientation: "portrait", sketch: false, poster: "poster-a1-landscape" }, LABELS, "t5")!;
    st().applyChange(res.ops);
    const p = st().project;
    const lay = p.layouts!.find((l) => l.id === res.layoutId)!;
    const master = p.masterLayouts!.find((m) => m.id === lay.masterId)!;
    expect([master.template, lay.paper, lay.orientation]).toEqual(["poster-a1-landscape", "a1", "landscape"]);
    const top = posterMetrics(841, 594).contentTopMm;
    for (const v of lay.viewports) expect(v.yMm).toBeGreaterThanOrEqual(top - 1e-6);
  }, 60_000);

  // Abgabe-Review [208]: Der Rahmen eines Grundrisses muss den ganzen Inhalt umfassen, auch die Schattenstudie des Projekts
  // (Wettbewerb-Beispiel: Studie eingeschaltet) — sonst wird der Grundriss im Viewport links/oben beschnitten.
  it("[208] Rahmen der Grundrisse umfasst Inhalt samt Schattenstudie", () => {
    st().loadProject(buildWettbewerbSampleProject());
    const p = st().project;
    expect(p.sunStudy?.show).toBe(true);
    const o = { ...presentationDefaults(p), scale: 200, poster: "poster-a1-landscape" };
    const res = presentationSheetOps(p, o, LABELS, "t6")!;
    st().applyChange(res.ops);
    const q = st().project;
    const tpl = q.viewTemplates!.find((t) => t.id === PRESENTATION_TEMPLATE_ID)!;
    const show = new Set(Object.entries(q.viewSnapshots!.find((v) => v.id === "vs-pres-t6-0")!.layerVisibility).filter(([, v]) => v).map(([k]) => k));
    for (const it of res.plan.items.filter((i) => i.group === 0)) {
      const b = generatePlan(q, it.levelId, show, undefined, tpl.detail, false, true, true, 200, false, false).bounds;
      // Rahmen um die eigene Bildmitte (deckungsgleiche Grundrisse) umfasst das ganze Ausmass (hier ohne fernen Kontext).
      const c = it.center!;
      expect(((c.x - b.minX) * 1000) / 200).toBeLessThanOrEqual(it.widthMm / 2 + 1e-6);
      expect(((b.maxX - c.x) * 1000) / 200).toBeLessThanOrEqual(it.widthMm / 2 + 1e-6);
      expect(((c.y - b.minY) * 1000) / 200).toBeLessThanOrEqual(it.heightMm / 2 + 1e-6);
      expect(((b.maxY - c.y) * 1000) / 200).toBeLessThanOrEqual(it.heightMm / 2 + 1e-6);
    }
  }, 60_000);

  // [208] Plakat wie eine Architektin: strenge Zeilen (Situation + Bild | Grundrisse | Schnitte + Ansichten | Tabellen), Grundrisse
  // deckungsgleich, ±0.00 auf einer Linie, Rahmen eng um den Inhalt an Spaltenkanten.
  for (const [name, build] of [["Wettbewerb", buildWettbewerbSampleProject], ["Musterhaus komplex", buildComplexSampleProject]] as const) {
    it(`[208] Plakat-Zeilen ${name}: Gruppen je Zeile, deckungsgleiche Grundrisse, gleiche ±0.00, enge Rahmen`, () => {
      st().loadProject(build());
      const p = st().project;
      const o = { ...presentationDefaults(p), scale: 200, poster: "poster-a1-landscape", extras: POSTER_EXTRAS_DEFAULT };
      const plan = planPresentationSheet(p, o);
      expect(plan.fits).toBe(true);
      const m = posterMetrics(841, 594);
      const band = plan.bandMm!;
      const colW = (841 - 2 * m.marginMm - (m.columns - 1) * m.gutterMm) / m.columns;
      const colEdges = Array.from({ length: m.columns }, (_, k) => m.marginMm + k * (colW + m.gutterMm));
      const sit = plan.items.filter((i) => i.kind === "situation");
      const floors = plan.items.filter((i) => i.kind === "view" && i.group === 0);
      const views = plan.items.filter((i) => i.kind === "view" && i.group > 0);
      expect(sit).toHaveLength(1);
      expect(floors.length).toBeGreaterThanOrEqual(3);
      expect(views.length).toBeGreaterThanOrEqual(4);
      // Strenge Zeilen: jede Gruppe beginnt unter der vorigen (gleiches Blatt) oder auf einem späteren Blatt.
      const order = [sit, floors, views];
      for (let k = 1; k < order.length; k++) {
        for (const a of order[k - 1])
          for (const b of order[k]) {
            const pa = a.page ?? 0;
            const pb = b.page ?? 0;
            expect(pb).toBeGreaterThanOrEqual(pa);
            if (pa === pb) expect(b.yMm).toBeGreaterThanOrEqual(a.yMm + a.heightMm + band - 1e-6);
          }
      }
      // Zeilen: gleiche Zeile ⇒ gleiche Oberkante; jeder Rahmen beginnt an einer Spaltenkante.
      for (const a of plan.items) {
        expect(colEdges.some((x) => Math.abs(x - a.xMm) < 1e-6)).toBe(true);
        for (const b of plan.items) if (a.line === b.line) expect(b.yMm).toBeCloseTo(a.yMm, 6);
      }
      // Bild neben der Situation, Tabellen nach den Ansichten.
      expect(plan.image!.yMm).toBeCloseTo(sit[0].yMm, 6);
      const lastViewTop = Math.max(...views.filter((v) => (v.page ?? 0) === Math.max(...views.map((w) => w.page ?? 0))).map((v) => v.yMm));
      for (const t of plan.tables!) expect(t.page > (views[0].page ?? 0) || t.yMm >= lastViewTop - 1e-6).toBe(true);
      // Grundrisse deckungsgleich: gleiche Rahmengrösse und gleiche Bildmitte.
      for (const f of floors) {
        expect([f.widthMm, f.heightMm, f.center!.x, f.center!.y]).toEqual([floors[0].widthMm, floors[0].heightMm, floors[0].center!.x, floors[0].center!.y]);
      }
      // Schnitte/Ansichten: ±0.00 (Modell-y 0) liegt in jeder Zeile auf derselben Papierhöhe.
      const zeroY = (v: (typeof views)[number]) => v.yMm + v.heightMm / 2 + (v.center!.y * 1000) / v.scale;
      for (const a of views) for (const b of views) if (a.line === b.line) expect(zeroY(b)).toBeCloseTo(zeroY(a), 6);
      // Enge Rahmen: nicht breiter als der Inhalt samt Rand, und der gemeinsame Inhalt aller Grundrisse füllt den Rahmen
      // (Weissraum im Rahmen < 15 %); ferner Kontext wird beschnitten statt den Rahmen aufzublasen.
      const res = presentationSheetOps(p, o, LABELS, "z")!;
      st().applyChange(res.ops);
      const q = st().project;
      const pad = 4;
      const frame = (f: (typeof floors)[number]) => {
        const hw = (f.widthMm * f.scale) / 2000;
        const hh = (f.heightMm * f.scale) / 2000;
        return { minX: f.center!.x - hw, minY: f.center!.y - hh, maxX: f.center!.x + hw, maxY: f.center!.y + hh };
      };
      let u = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const f of floors) {
        const i = plan.items.indexOf(f);
        const snap = q.viewSnapshots!.find((v) => v.id === `vs-pres-z-${i}`)!;
        const vis = new Set(Object.entries(snap.layerVisibility).filter(([, v]) => v).map(([k]) => k));
        const b = generatePlan(q, f.levelId, vis, undefined, snap.detail, false, true, true, 200, false, false).bounds;
        u = { minX: Math.min(u.minX, b.minX), minY: Math.min(u.minY, b.minY), maxX: Math.max(u.maxX, b.maxX), maxY: Math.max(u.maxY, b.maxY) };
      }
      // Gemeinsamer Rahmen nicht grösser als der gemeinsame Inhalt aller Geschosse samt Rand.
      expect(floors[0].widthMm).toBeLessThanOrEqual(((u.maxX - u.minX) * 1000) / 200 + 2 * pad + 1e-6);
      expect(floors[0].heightMm).toBeLessThanOrEqual(((u.maxY - u.minY) * 1000) / 200 + 2 * pad + 1e-6);
      const fr = frame(floors[0]);
      const inside = (Math.min(u.maxX, fr.maxX) - Math.max(u.minX, fr.minX)) * (Math.min(u.maxY, fr.maxY) - Math.max(u.minY, fr.minY));
      expect(inside / ((fr.maxX - fr.minX) * (fr.maxY - fr.minY))).toBeGreaterThan(0.85);
      // Viewports übernehmen die Bildmitte.
      const vps = q.layouts!.filter((l) => res.layoutIds.includes(l.id)).flatMap((l) => l.viewports);
      expect(vps.every((v) => v.center && Number.isFinite(v.center.x))).toBe(true);
    }, 120_000);
  }

  // [208] Plakat als abgabefähiges Grundgerüst: Situation 1:500, Pläne 1:200, Tabellen, Bild-Rahmen auf dem 6-Spalten-Raster.
  it("[208] Plakat mit Situation, Tabellen und Bild-Rahmen: alles im Satzspiegel, ohne Überlappung, feste Massstäbe, Blatt bis unten gefüllt", () => {
    st().loadProject(buildWettbewerbSampleProject());
    const p = st().project;
    const o = { ...presentationDefaults(p), scale: 200, poster: "poster-a1-landscape", extras: POSTER_EXTRAS_DEFAULT };
    const plan = planPresentationSheet(p, o);
    expect(plan.pages ?? 1).toBe(1);
    expect(plan.fits).toBe(true);
    const m = posterMetrics(841, 594);
    const band = plan.bandMm!;
    type Box = { xMm: number; yMm: number; widthMm: number; heightMm: number };
    const boxes: Box[] = [
      ...plan.items.map((i) => ({ ...i, heightMm: i.heightMm + band })),
      ...plan.tables!,
      plan.image!,
    ];
    expect(plan.items.filter((i) => i.kind === "situation")).toHaveLength(1);
    expect(plan.tables!.map((t) => t.id)).toEqual(["areas", "siteProof"]);
    expect(plan.image).toBeTruthy();
    for (const i of plan.items) expect(i.scale).toBe(i.kind === "situation" ? 500 : 200);
    // Situation steht am Anfang (oben links).
    const sit = plan.items.find((i) => i.kind === "situation")!;
    expect([sit.xMm, sit.yMm]).toEqual([m.marginMm, m.contentTopMm]);
    const left = m.marginMm;
    const right = 841 - m.marginMm;
    const bottom = 594 - m.marginMm;
    for (const [k, b] of boxes.entries()) {
      expect(b.xMm).toBeGreaterThanOrEqual(left - 1e-6);
      expect(b.xMm + b.widthMm).toBeLessThanOrEqual(right + 1e-6);
      expect(b.yMm).toBeGreaterThanOrEqual(m.contentTopMm - 1e-6);
      expect(b.yMm + b.heightMm).toBeLessThanOrEqual(bottom + 1e-6);
      for (const c of boxes.slice(k + 1)) expect(overlaps(b, c)).toBe(false);
    }
    // Rahmen sind eng um den Inhalt (kein Flächenmass mehr); die Zeilen füllen den Satzspiegel bis unten.
    const lowest = Math.max(...boxes.map((b) => b.yMm + b.heightMm));
    expect((lowest - m.contentTopMm) / (bottom - m.contentTopMm)).toBeGreaterThanOrEqual(0.85);
    // Ops: ein Blatt, Viewports, zwei Blatt-Tabellen, Platzhalter-Beschriftung, Master ohne eigenes Schriftfeld nötig (posterHeader).
    const res = presentationSheetOps(p, o, LABELS, "p1")!;
    st().applyChange(res.ops);
    const q = st().project;
    const lay = q.layouts!.find((l) => l.id === res.layoutId)!;
    expect(lay.viewports).toHaveLength(plan.items.length);
    expect(lay.tables!.map((t) => t.source)).toEqual(["areas", "siteProof"]);
    const sheet = q.drawingLevels.find((l) => l.layoutId === lay.id)!;
    const texts = q.drawings2d.filter((d) => d.levelId === sheet.id && d.geom.shape === "text").map((d) => (d.geom as { text: string }).text);
    expect(texts).toContain("3D-Bild hier einsetzen");
    expect(texts).toContain("Situation");
    expect(q.masterLayouts!.find((x) => x.id === lay.masterId)!.posterHeader).toBe(true);
    expect(q.viewSnapshots!.find((v) => v.id === lay.viewports[0].snapshotId)!.templateId).toBe("std-vt-situation-wbw");
  }, 90_000);

  it("[208] zu viele Grundrisse für ein Blatt: zweites Plakat statt kleinerem Massstab", () => {
    const o = { ...presentationDefaults(project), scale: 100, poster: "poster-a1-landscape", extras: POSTER_EXTRAS_DEFAULT };
    const res = presentationSheetOps(project, o, LABELS, "p2")!;
    expect(res.plan.pages).toBeGreaterThanOrEqual(2);
    expect(res.layoutIds.length).toBe(res.plan.pages);
    expect(res.plan.items.filter((i) => i.kind !== "situation").every((i) => i.scale === 100)).toBe(true);
    st().applyChange(res.ops);
    const lays = st().project.layouts!.filter((l) => res.layoutIds.includes(l.id));
    expect(lays.every((l) => l.viewports.length > 0 || (l.tables ?? []).length > 0)).toBe(true);
  }, 90_000);

  it("[208] Plakat ohne Zusatzinhalt bleibt auf dem Raster (nur Pläne)", () => {
    const o = { ...presentationDefaults(project), scale: 200, poster: "poster-a1-landscape" };
    const plan = planPresentationSheet(project, o);
    expect(plan.items.every((i) => i.kind === "view")).toBe(true);
    expect(plan.tables).toEqual([]);
    expect(plan.image ?? null).toBeNull();
  }, 60_000);
});
