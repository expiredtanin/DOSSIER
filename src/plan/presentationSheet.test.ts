import { beforeEach, describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { buildWettbewerbSampleProject } from "../model/sampleProjectWettbewerb";
import { generatePlan } from "./generatePlan";
import { getState } from "../state/appStore";
import { sheetSizeMm } from "../model/layoutModel";
import { posterMetrics } from "../model/posterTemplates";
import { finerPresentationScale, fittingPresentationScale, POSTER_EXTRAS_DEFAULT, posterExtrasDefault, PRESENTATION_TEMPLATE_ID, levelHasContent, planPresentationSheet, presentationDefaults, presentationSheetOps } from "./presentationSheet";
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
  tableUnits: "Wohnungsspiegel",
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
    expect(d.sectionIds.length).toBeGreaterThan(0);
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
    expect(lay.viewports.length).toBe(o.floors.length + elevations + o.sectionIds.length);
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
    const res = presentationSheetOps(project, { floors, elevationIds: [], scale: null, sectionIds: [], paper: "a3", orientation: "landscape", sketch: true }, LABELS, "t2")!;
    expect(res.plan.items.map((i) => i.levelId)).toEqual(floors);
    expect(res.plan.scale).toBeGreaterThanOrEqual(100);
    st().applyChange(res.ops);
    const p = st().project;
    expect(p.layouts!.find((l) => l.id === res.layoutId)!.viewports.length).toBe(2);
    expect(floors.every((id) => p.drawingLevels.find((l) => l.id === id)!.sketch)).toBe(true);
  });

  it("nichts gewählt ⇒ null, Projekt unverändert", () => {
    expect(presentationSheetOps(project, { floors: [], elevationIds: [], scale: null, sectionIds: [], paper: "a1", orientation: "landscape", sketch: false }, LABELS, "t3")).toBeNull();
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

  // [266] Kataster-DXF mit den Vorgaben (neue Zeichnungsebene) importiert: die Situation des Plakats zeigte nur das Geschoss
  // (Gebäude und Parzelle), ohne Nachbarn, Strassen und Parzellennummern. Jetzt nimmt sie die Zeichnungsebene, deren
  // Zeichnung das Gebäude umgibt (dort zeichnet die Vorlage „Situation WBW“ das eigene Gebäude gefüllt dazu).
  it("[266] Plakat-Situation auf der Kataster-Zeichnungsebene, die das Gebäude umgibt", () => {
    const p0 = st().project;
    const floor = p0.drawingLevels.find((l) => l.kind === "floor" && !l.layoutId)!;
    const xs = p0.walls.filter((w) => w.floorId === floor.id).flatMap((w) => [w.start.x, w.end.x]);
    const ys = p0.walls.filter((w) => w.floorId === floor.id).flatMap((w) => [w.start.y, w.end.y]);
    const [x0, x1, y0, y1] = [Math.min(...xs) - 30, Math.max(...xs) + 30, Math.min(...ys) - 30, Math.max(...ys) + 30];
    const ring = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    const kat = { id: "lv-kataster", name: "kataster", kind: "drawing" as const, visible: true, locked: false };
    const d = (id: string, geom: unknown) => ({ id, type: "drawing2d", levelId: kat.id, categoryCode: "20", geom }) as unknown as Project["drawings2d"][number];
    const withKat: Project = {
      ...p0,
      drawingLevels: [...p0.drawingLevels, kat, { id: "lv-skizze", name: "Skizze", kind: "drawing", visible: true, locked: false }],
      drawings2d: [
        ...p0.drawings2d,
        d("k1", { shape: "polyline", pts: ring, closed: true }),
        d("k2", { shape: "text", at: { x: x0 + 1, y: y0 + 1 }, text: "1003", height: 2, rotation: 0 }),
        // Skizze weit weg: nicht die Situation.
        { ...d("s1", { shape: "line", a: { x: x1 + 500, y: y1 + 500 }, b: { x: x1 + 510, y: y1 + 500 } }), levelId: "lv-skizze" },
      ],
    };
    const sit0 = planPresentationSheet(p0, { ...presentationDefaults(p0), scale: 200, poster: "poster-a1-landscape", extras: POSTER_EXTRAS_DEFAULT }).items.find((i) => i.kind === "situation")!;
    // Ohne Kataster-Ebene bleibt es das Erdgeschoss.
    expect(p0.drawingLevels.find((l) => l.id === sit0.levelId)!.kind).toBe("floor");
    st().loadProject(withKat);
    const p1 = st().project;
    const o = { ...presentationDefaults(p1), scale: 200, poster: "poster-a1-landscape", extras: POSTER_EXTRAS_DEFAULT };
    const sit = planPresentationSheet(p1, o).items.find((i) => i.kind === "situation")!;
    expect(sit.levelId).toBe("lv-kataster");
  }, 60_000);

  it("[266] Geschoss nur mit Bauteilen (Wände/Räume tragen `floorId`, nicht `levelId`) gilt nicht als leer", () => {
    const floor = project.drawingLevels.find((l) => l.kind === "floor" && !l.layoutId)!;
    const wall = project.walls[0];
    const room = project.rooms![0];
    const onlyParts = {
      ...project,
      drawingLevels: [...project.drawingLevels, { ...floor, id: "lv-bau", name: "OG Bauteile", baseElevation: 99 }],
      walls: [...project.walls, { ...wall, id: "w-bau", floorId: "lv-bau" }],
      rooms: [...project.rooms!, { ...room, id: "r-bau", floorId: "lv-bau" }],
    };
    expect(levelHasContent(onlyParts, "lv-bau")).toBe(true);
    expect(presentationDefaults(onlyParts).floors).toContain("lv-bau");
  });

  it("[224] fester Massstab und Massstab je Viewport landen in Ausschnitt und Viewport", () => {
    const floors = project.drawingLevels.filter((l) => l.kind === "floor" && !l.layoutId).slice(0, 2).map((l) => l.id);
    const res = presentationSheetOps(project, { floors, elevationIds: [], scale: 200, scales: { [floors[1]]: 100 }, sectionIds: [], paper: "a1", orientation: "landscape", sketch: false }, LABELS, "t4")!;
    expect(res.plan.scale).toBe(200);
    expect(res.plan.items.map((i) => i.scale)).toEqual([200, 100]);
    st().applyChange(res.ops);
    const lay = st().project.layouts!.find((l) => l.id === res.layoutId)!;
    expect(lay.viewports.map((v) => v.scaleDenominator)).toEqual([200, 100]);
    expect(st().project.viewSnapshots!.filter((v) => v.id.startsWith("vs-pres-t4")).map((v) => v.scaleDenominator)).toEqual([200, 100]);
  });

  it("[224] Plakat-Vorlage als Ziel: Master der Vorlage, Viewports unter der Kopfzeile", () => {
    const floors = project.drawingLevels.filter((l) => l.kind === "floor" && !l.layoutId).slice(0, 2).map((l) => l.id);
    const res = presentationSheetOps(project, { floors, elevationIds: [], scale: 200, sectionIds: [], paper: "a4", orientation: "portrait", sketch: false, poster: "poster-a1-landscape" }, LABELS, "t5")!;
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
    // Marken ([266]) liegen weit ums Haus und werden vom Ausschnitt bewusst beschnitten: ohne sie vergleichen.
    const show = new Set(Object.entries(q.viewSnapshots!.find((v) => v.id === "vs-pres-t6-0")!.layerVisibility).filter(([k, v]) => v && k !== "91").map(([k]) => k));
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
    // [266] Mit Schnitt-/Ansichtsmarken brauchen die Grundrisse mehr Rand: Auswahl so, dass alles auf ein Blatt passt.
    const d = presentationDefaults(p);
    const o = { ...d, elevationIds: d.elevationIds.slice(0, 1), sectionIds: [], scale: 200, poster: "poster-a1-landscape", extras: POSTER_EXTRAS_DEFAULT };
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
    // [266] Freier Platz wird als Weissraum verteilt: die Situation steht an der ersten Zeile, nicht zwingend direkt unter der Kopfzeile.
    expect(sit.xMm).toBe(m.marginMm);
    expect(sit.yMm).toBeGreaterThanOrEqual(m.contentTopMm);
    expect(Math.min(...plan.items.map((i) => i.yMm))).toBe(sit.yMm);
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
    // Ops: ein Blatt, Viewports, zwei Blatt-Tabellen, Axonometrie im Bild-Rahmen, Master ohne eigenes Schriftfeld nötig (posterHeader).
    const res = presentationSheetOps(p, o, LABELS, "p1")!;
    st().applyChange(res.ops);
    const q = st().project;
    const lay = q.layouts!.find((l) => l.id === res.layoutId)!;
    // [266] Ohne gerendertes Bild: die Vektor-Axonometrie aus dem Kern im Bild-Rahmen (ein 3D-Ausschnitt mehr), kein Platzhalter.
    expect(lay.viewports).toHaveLength(plan.items.length + 1);
    const axoVp = lay.viewports[lay.viewports.length - 1];
    const axoSnap = q.viewSnapshots!.find((v) => v.id === axoVp.snapshotId)!;
    expect(axoSnap.viewType).toBe("perspektive");
    expect(axoSnap.doc3d?.view).toBe("southeast");
    expect([axoVp.xMm, axoVp.yMm, axoVp.widthMm, axoVp.heightMm]).toEqual([plan.image!.xMm, plan.image!.yMm, plan.image!.widthMm, plan.image!.heightMm]);
    expect(lay.tables!.map((t) => t.source)).toEqual(["areas", "siteProof"]);
    const sheet = q.drawingLevels.find((l) => l.layoutId === lay.id)!;
    const texts = q.drawings2d.filter((d) => d.levelId === sheet.id && d.geom.shape === "text").map((d) => (d.geom as { text: string }).text);
    expect(texts).not.toContain("3D-Bild hier einsetzen");
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

  // [266] Befunde aus dem Wettbewerbs-Durchlauf: Marken, mehrere Schnitte, Aussenbemassung, Planzeichen der Situation, Bildgrösse.
  it("[266] Schnitt-/Ansichtsmarken sind in den Plakat-Grundrissen sichtbar, mehrere Schnitte wählbar", () => {
    const sections = project.drawingLevels.filter((l) => l.kind === "section").map((l) => l.id);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    const floors = project.drawingLevels.filter((l) => l.kind === "floor" && !l.layoutId && levelHasContent(project, l.id)).slice(0, 2).map((l) => l.id);
    const res = presentationSheetOps(project, { floors, elevationIds: [], scale: 200, sectionIds: sections, paper: "a1", orientation: "landscape", sketch: false, poster: "poster-a1-landscape" }, LABELS, "m1")!;
    st().applyChange(res.ops);
    const q = st().project;
    const lay = q.layouts!.find((l) => l.id === res.layoutId)!;
    expect(lay.viewports).toHaveLength(floors.length + sections.length);
    const snap = (i: number) => q.viewSnapshots!.find((v) => v.id === lay.viewports[i].snapshotId)!;
    expect(snap(0).layerVisibility["91"]).toBe(true);
    // Ohne Schnitte und Ansichten bleibt die Vorlage (Marken aus).
    const none = presentationSheetOps(st().project, { floors, elevationIds: [], scale: 200, sectionIds: [], paper: "a1", orientation: "landscape", sketch: false, poster: "poster-a1-landscape" }, LABELS, "m2")!;
    st().applyChange(none.ops);
    expect(st().project.viewSnapshots!.find((v) => v.id === "vs-pres-m2-0")!.layerVisibility["91"]).toBe(false);
  }, 60_000);

  it("[266] Aussenbemassung wird für Grundrisse ohne Ketten ergänzt, vorhandene bleiben", () => {
    const strip = { ...project, drawings2d: project.drawings2d.filter((d) => !d.id.startsWith("autodim-")) };
    st().loadProject(strip);
    const p = st().project;
    const floors = p.drawingLevels.filter((l) => l.kind === "floor" && !l.layoutId && levelHasContent(p, l.id)).slice(0, 2).map((l) => l.id);
    const base = { floors, elevationIds: [], scale: 200, sectionIds: [], paper: "a1" as const, orientation: "landscape" as const, sketch: false };
    const off = presentationSheetOps(p, base, LABELS, "d0")!;
    st().applyChange(off.ops);
    expect(st().project.drawings2d.some((d) => d.id.startsWith("autodim-"))).toBe(false);
    st().loadProject(strip);
    const on = presentationSheetOps(st().project, { ...base, autoDim: true }, LABELS, "d1")!;
    st().applyChange(on.ops);
    for (const f of floors) expect(st().project.drawings2d.some((d) => d.id.startsWith(`autodim-${f}-`) && d.categoryCode === "81")).toBe(true);
    // Zweiter Lauf: nichts doppelt (die Ketten tragen feste Ids).
    const n = st().project.drawings2d.filter((d) => d.id.startsWith("autodim-")).length;
    const again = presentationSheetOps(st().project, { ...base, autoDim: true }, LABELS, "d2")!;
    st().applyChange(again.ops);
    expect(st().project.drawings2d.filter((d) => d.id.startsWith("autodim-")).length).toBe(n);
  }, 90_000);

  it("[266] Situation: Planzeichen am Rahmenrand statt in der Zeichnung, Bild nicht grösser als der grösste Plan", () => {
    st().loadProject(buildWettbewerbSampleProject());
    const p = st().project;
    const o = { ...presentationDefaults(p), scale: 200, poster: "poster-a1-portrait", extras: POSTER_EXTRAS_DEFAULT };
    const res = presentationSheetOps(p, o, LABELS, "s1")!;
    st().applyChange(res.ops);
    const q = st().project;
    const sit = res.plan.items.find((i) => i.kind === "situation")!;
    const lay = q.layouts!.find((l) => l.id === res.layoutId)!;
    const sitSnap = q.viewSnapshots!.find((v) => v.id === lay.viewports[0].snapshotId)!;
    expect(sitSnap.layerVisibility["84"]).toBe(false);
    const grp = q.groups!.find((g) => g.id === "grp-pres-s1-sit-n")!;
    const arrow = q.drawings2d.filter((d) => grp.drawingIds.includes(d.id) && d.geom.shape === "circle");
    expect(arrow).toHaveLength(1);
    // Mitte des Nordpfeils: unter dem Rahmen der Situation (Papier-mm = Modell-m × 1000).
    const c = (arrow[0].geom as { center: { x: number; y: number } }).center;
    expect(-c.y * 1000).toBeGreaterThan(sit.yMm + sit.heightMm);
    const plans = res.plan.items.filter((i) => i.group === 0);
    expect(res.plan.image!.heightMm).toBeLessThanOrEqual(Math.max(...plans.map((i) => i.heightMm), 0.14 * 700) + 1e-6);
    // Weissraum: der Inhalt reicht auf Blatt 1 nicht nur ins obere Drittel.
    const bottoms = [...res.plan.items, ...(res.plan.tables ?? []), ...(res.plan.image ? [res.plan.image] : [])].filter((i) => (i.page ?? 0) === 0).map((i) => i.yMm + i.heightMm);
    expect(Math.max(...bottoms)).toBeGreaterThan(841 * 0.6);
  }, 90_000);

  // [282] Passt der Plan im gewählten Massstab nicht: kein überlaufendes Blatt, sondern der grösste passende Massstab als Vorschlag.
  it("[282] Massstab-Vorschlag: 1:50 auf A4 passt nicht, vorgeschlagener Massstab passt", () => {
    st().loadProject(buildWettbewerbSampleProject());
    const p = st().project;
    const o = { ...presentationDefaults(p), paper: "a4" as const, orientation: "portrait" as const, scale: 50 };
    expect(planPresentationSheet(p, o).fits).toBe(false);
    const s = fittingPresentationScale(p, o);
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThan(50);
    expect(planPresentationSheet(p, { ...o, scale: s }).fits).toBe(true);
    // Der Vorschlag ist der grösste: der nächstgrössere Massstab passt nicht.
    const bigger = [50, 100, 200, 500, 1000].filter((x) => x > 50 && x < s!);
    for (const b of bigger) expect(planPresentationSheet(p, { ...o, scale: b }).fits).toBe(false);
    // Was schon passt, braucht keinen Vorschlag auf Kosten des Massstabs: A1 1:200.
    expect(planPresentationSheet(p, { ...presentationDefaults(p), scale: 200 }).fits).toBe(true);
  }, 60_000);

  // [208] Kleines Haus im groben Massstab: ein feinerer (>= 1:100) passt auch, dann Vorschlag; sonst keiner.
  it("[208] Vorschlag eines feineren Massstabs, nur wenn er passt und nicht unter 1:100", () => {
    st().loadProject(buildWettbewerbSampleProject());
    const p = st().project;
    const o = { ...presentationDefaults(p), paper: "a1" as const, orientation: "portrait" as const, scale: 500 };
    const f = finerPresentationScale(p, o);
    if (f !== null) {
      expect(f).toBeGreaterThanOrEqual(100);
      expect(f).toBeLessThan(500);
      expect(planPresentationSheet(p, { ...o, scale: f }).fits).toBe(true);
    }
    // 1:100 ist die feinste Stufe des Vorschlags, und was nicht passt, bekommt keinen.
    expect(finerPresentationScale(p, { ...o, scale: 100 })).toBeNull();
    expect(finerPresentationScale(p, { ...o, paper: "a4" as const, scale: 50 })).toBeNull();
  }, 60_000);

  // [285] Plakat: Situation um Baufeld statt alle Kataster-Parzellen, Wohnungsspiegel, Vorschlag 1:100.
  it("[285] Situation: Ausschnitt um die eigene Parzelle mit Rand, nicht um das ganze Ausmass", () => {
    st().loadProject(buildWettbewerbSampleProject());
    const p = st().project;
    const ring = p.siteRules!.parcel;
    const w = Math.max(...ring.map((q) => q.x)) - Math.min(...ring.map((q) => q.x));
    const h = Math.max(...ring.map((q) => q.y)) - Math.min(...ring.map((q) => q.y));
    const o = { ...presentationDefaults(p), scale: 200, poster: "poster-a1-landscape", extras: POSTER_EXTRAS_DEFAULT };
    const sit = planPresentationSheet(p, o).items.find((i) => i.kind === "situation")!;
    // Parzelle ± 10 m bei 1:500 (Papier-mm = Meter × 2) plus Rahmenrand 2 × 4 mm; weiter reicht der Ausschnitt nicht.
    expect(sit.widthMm).toBeLessThanOrEqual((w + 20) * 2 + 8 + 1e-6);
    expect(sit.heightMm).toBeLessThanOrEqual((h + 20) * 2 + 8 + 1e-6);
  }, 60_000);

  it("[285] Wohnungsspiegel kommt aufs Plakat, wenn das Projekt Einheiten hat", () => {
    st().loadProject(buildWettbewerbSampleProject());
    const p = st().project;
    expect(p.units!.length).toBeGreaterThan(0);
    const ex = posterExtrasDefault(p);
    expect(ex.tables).toEqual(["areas", "siteProof", "unitSchedule"]);
    const plan = planPresentationSheet(p, { ...presentationDefaults(p), scale: 200, poster: "poster-a1-landscape", extras: ex });
    expect(plan.tables!.map((t) => t.id)).toEqual(["areas", "siteProof", "unitSchedule"]);
    const res = presentationSheetOps(p, { ...presentationDefaults(p), scale: 200, poster: "poster-a1-landscape", extras: ex }, LABELS, "u1")!;
    st().applyChange(res.ops);
    const sources = st().project.layouts!.filter((l) => res.layoutIds.includes(l.id)).flatMap((l) => (l.tables ?? []).map((t) => t.source));
    expect(sources).toEqual(["areas", "siteProof", "unitSchedule"]);
    // Ohne Einheiten keine Tabelle.
    expect(posterExtrasDefault({ ...p, units: [] }).tables).toEqual(["areas", "siteProof"]);
  }, 60_000);
});
