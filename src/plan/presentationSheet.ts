// [66] Präsentationsplan mit einem Klick: neues Blatt mit den Grundrissen (alle oder gewählte Geschosse),
// den Ansichten und optional einem Schnitt, in gemeinsamem Massstab im Raster angeordnet, mit Titeln,
// Nordpfeil und Schriftfeld (Master), Ausschnitte an die Standard-Vorlage „Präsentation" gebunden.
// Massstabswahl und Anordnung rechnet der Kern (`presentation_sheet.rs`, Abfrage `presentationSheet`);
// hier entstehen daraus die Ops (ein Undo-Schritt beim Aufrufer).

import type {
  DetailLevel,
  Drawing2D,
  Drawing2DGeom,
  DrawingLevel,
  Group,
  LayerCategory,
  Layout,
  LayoutOrientation,
  LayoutPaperFormat,
  LayoutViewport,
  MasterLayout,
  Project,
  ViewSnapshot,
  ViewTemplate,
} from "../model/types";
import type { CoreOp } from "../core/ops";
import { documentFor } from "../core/document";
import { addedItems, addItems, patchItem } from "../core/opsBuild";
import { standardsMergeOps } from "../model/standards";
import { createLayout, createMasterLayout, createSheetLevel, sheetMmToModel, sheetSizeMm } from "../model/layoutModel";
import { SHADOW_CATEGORY } from "../model/derivedCategories";
import { createPosterMaster, findPosterMaster, posterMetrics, posterTemplate, scaleLabelMetrics } from "../model/posterTemplates";

/** Id der Standard-Ansichtsvorlage „Präsentation" (`standards.rs`). */
export const PRESENTATION_TEMPLATE_ID = "std-vt-praesentation";
/** Rand zwischen Inhalt und Rahmen (mm, wie `FRAME_PAD_MM` im Kern). */
const FRAME_PAD_MM = 4;

export interface PresentationOptions {
  /** Geschosse (Ebenen der Art `floor`) in Blattreihenfolge. */
  floors: string[];
  /** Gewählte Ansichten (Ebenen der Art `elevation`) in Blattreihenfolge. */
  elevationIds: string[];
  /** Ein Schnitt (Ebene der Art `section`) oder keiner. */
  sectionId: string | null;
  paper: LayoutPaperFormat;
  orientation: LayoutOrientation;
  /** Skizzenstil ([67]) für die gezeigten Ebenen. */
  sketch: boolean;
  /** [224] Gemeinsamer Massstab (1:N); `null` = der grösste, der aufs Blatt passt. Vorgabe 1:200 (Wettbewerb). */
  scale: number | null;
  /** [224] Massstab je Ebene (übersteuert `scale`). */
  scales?: Record<string, number>;
  /** [224] Plakat-Vorlage ([208], Schlüssel in `POSTER_TEMPLATES`) als Ziel; fehlt sie, gilt `paper`/`orientation`. */
  poster?: string;
}

/** Massstäbe zur Wahl im Dialog (wie `SCALES` im Kern). */
export const PRESENTATION_SCALES = [50, 100, 200, 500, 1000] as const;
/** Vorgabe-Massstab für den Wettbewerb (WBW 1:200, Vorprojekt 1:100). */
export const PRESENTATION_DEFAULT_SCALE = 200;

export interface PresentationItem {
  levelId: string;
  /** Massstab dieses Viewports (gemeinsam oder je Ebene gewählt). */
  scale: number;
  group: number;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

export interface PresentationPlan {
  scale: number;
  fits: boolean;
  items: PresentationItem[];
  skipped: string[];
}

/** Beschriftungen (vom Aufrufer über `t()`). */
export interface PresentationLabels {
  sheetName: string;
  /** Name eines neu angelegten Masters, z. B. „Planrahmen A1 quer". */
  masterName: string;
  north: string;
  /** [137] Gruppen-Namen von Nordpfeil und Massstabsbalken (Objekt-Info). */
  northGroup?: string;
  scaleBarGroup?: string;
}

const isFloor = (l: DrawingLevel) => l.kind === "floor" && !l.layoutId;

/** [224] Hat die Ebene Bauteile oder Zeichnungen? Leere Geschosse (z. B. ein OG ohne Bauteile) werden nicht vorgewählt. */
export function levelHasContent(project: Project, levelId: string): boolean {
  for (const [key, v] of Object.entries(project as unknown as Record<string, unknown>)) {
    if (key === "drawingLevels" || !Array.isArray(v)) continue;
    if (v.some((it) => typeof it === "object" && it !== null && (it as { levelId?: string }).levelId === levelId)) return true;
  }
  return false;
}

/** Vorschlag für den Dialog: Geschosse mit Inhalt, alle Ansichten, erster Schnitt, 1:200; Blatt des meistgenutzten Masters, sonst A1 quer. */
export function presentationDefaults(project: Project): PresentationOptions {
  const levels = project.drawingLevels;
  const masters = project.masterLayouts ?? [];
  const uses = new Map<string, number>();
  for (const l of project.layouts ?? []) if (l.masterId) uses.set(l.masterId, (uses.get(l.masterId) ?? 0) + 1);
  const master = [...masters].sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0))[0];
  const usable = master && !master.customWidthMm;
  return {
    floors: levels.filter((l) => isFloor(l) && levelHasContent(project, l.id)).map((l) => l.id),
    elevationIds: levels.filter((l) => l.kind === "elevation").map((l) => l.id),
    sectionId: levels.find((l) => l.kind === "section")?.id ?? null,
    paper: usable ? master.paper : "a1",
    orientation: usable ? master.orientation : "landscape",
    sketch: false,
    scale: PRESENTATION_DEFAULT_SCALE,
  };
}

/** Blattgrösse und Master-Papier der Wahl: Plakat-Vorlage, sonst `paper`/`orientation`. */
function targetSheet(o: PresentationOptions): { paper: LayoutPaperFormat; orientation: LayoutOrientation } {
  const tpl = o.poster ? posterTemplate(o.poster) : undefined;
  return tpl ? { paper: tpl.paper, orientation: tpl.orientation } : { paper: o.paper, orientation: o.orientation };
}

/** Die Vorlage „Präsentation" des Projekts bzw. aus den Standards (dann muss sie mit angelegt werden). */
export function presentationTemplate(project: Project): { template: ViewTemplate; isNew: boolean } {
  const own = (project.viewTemplates ?? []).find((t) => t.id === PRESENTATION_TEMPLATE_ID);
  if (own) return { template: own, isNew: false };
  const std = (addedItems(standardsMergeOps(project), "viewTemplates") as ViewTemplate[]).find((t) => t.id === PRESENTATION_TEMPLATE_ID);
  return {
    template: std ?? { id: PRESENTATION_TEMPLATE_ID, name: "Präsentation", detail: "mittel", mono: true, shadows: true, hiddenLines: false },
    isNew: true,
  };
}

function categoryCodes(cats: readonly LayerCategory[], out: string[] = []): string[] {
  for (const c of cats) {
    out.push(c.code);
    if (c.children) categoryCodes(c.children, out);
  }
  return out;
}

/**
 * Sichtbarkeit nach Vorlage (alle Kategorien sichtbar, ausser die von der Vorlage ausgeblendeten), dazu ohne
 * Umgebung (Kataster, Strassen, Baurecht, Gelände, Höhenlinien — dafür gibt es den Situationsplan): sonst
 * bestimmen Parzelle und Geländemodell Grösse und Massstab jeder Zeichnung.
 */
function presentationVisibility(project: Project, t: ViewTemplate): Record<string, boolean> {
  const vis: Record<string, boolean> = {};
  for (const c of categoryCodes(project.layers)) vis[c] = true;
  const out: Record<string, boolean> = { ...vis, ...(t.layerVisibility ?? {}) };
  for (const c of siteCodes(project)) out[c] = false;
  return out;
}

/** Vermessung und Umgebung im Standard-Ebenenbaum (`01`, `05` mit Unterkategorien Situation/Strasse/Bäume …). */
const SITE_ROOTS = ["01", "05"];

/** Codes der Umgebung: Vermessung/Umgebung samt Unterkategorien und die Kategorien der Kontext-Objekte (Gelände …). */
function siteCodes(project: Project): Set<string> {
  const out = new Set<string>();
  const walk = (cs: readonly LayerCategory[], inSite: boolean) => {
    for (const c of cs) {
      const site = inSite || SITE_ROOTS.includes(c.code);
      if (site) out.add(c.code);
      if (c.children) walk(c.children, site);
    }
  };
  walk(project.layers, false);
  for (const c of project.context ?? []) if (c.categoryCode) out.add(c.categoryCode);
  return out;
}

/** Die gewählten Ebenen in Blattreihenfolge mit Gruppe (0 Grundrisse, 1 Ansichten, 2 Schnitt). */
function chosenLevels(project: Project, o: PresentationOptions): { id: string; group: number }[] {
  const byId = new Map(project.drawingLevels.map((l) => [l.id, l]));
  const out: { id: string; group: number }[] = [];
  for (const id of o.floors) if (byId.get(id) && isFloor(byId.get(id)!)) out.push({ id, group: 0 });
  for (const id of o.elevationIds) if (byId.get(id)?.kind === "elevation") out.push({ id, group: 1 });
  if (o.sectionId && byId.get(o.sectionId)?.kind === "section") out.push({ id: o.sectionId, group: 2 });
  return out;
}

/** Master des Blatts: einer mit gleichem Format und gleicher Ausrichtung, sonst ein neuer. */
function masterFor(project: Project, o: PresentationOptions): MasterLayout | undefined {
  const tpl = o.poster ? posterTemplate(o.poster) : undefined;
  if (tpl) return findPosterMaster(project, tpl.key);
  return (project.masterLayouts ?? []).find(
    (m) => m.paper === o.paper && m.orientation === o.orientation && m.customWidthMm === undefined && !m.template,
  );
}

/** Massstab und Rahmen aus dem Kern (ohne das Projekt zu ändern). */
export function planPresentationSheet(project: Project, o: PresentationOptions): PresentationPlan {
  const { template } = presentationTemplate(project);
  const { paper, orientation } = targetSheet(o);
  const size = sheetSizeMm(paper, orientation);
  // Plakat: Kopfzeile und Ränder der Vorlage, kein Schriftfeld des Masters.
  const poster = o.poster && posterTemplate(o.poster) ? posterMetrics(size.w, size.h) : null;
  const levels = chosenLevels(project, o);
  const vis = presentationVisibility(project, template);
  const text = JSON.stringify({
    levels: levels.map((l) => l.id),
    groups: levels.map((l) => l.group),
    layerVisibility: vis,
    detail: (template.detail ?? "mittel") satisfies DetailLevel,
    sheetW: size.w,
    sheetH: size.h,
    titleBlock: !poster,
    shadows: template.shadows ?? false,
    template,
    ...(o.scale ? { scale: o.scale } : {}),
    scales: o.scales ?? {},
    ...(poster ? { marginMm: poster.marginMm, topMm: poster.contentTopMm } : {}),
  });
  return documentFor(project).query<PresentationPlan>("presentationSheet", [], text);
}

/** Text auf der Blatt-Ebene (Papier-mm, Schrifthöhe mm). */
function sheetText(id: string, levelId: string, cat: string, xMm: number, yMm: number, text: string, hMm: number, bold = false): Drawing2D {
  return {
    id,
    type: "drawing2d",
    levelId,
    categoryCode: cat,
    geom: { shape: "text", at: sheetMmToModel(xMm, yMm), text, height: hMm / 1000, angle: 0, ...(bold ? { marks: { bold: true } } : {}) },
    color: "#111111",
  } as Drawing2D;
}

function sheetShape(id: string, levelId: string, cat: string, geom: Drawing2DGeom, extra: Partial<Drawing2D> = {}): Drawing2D {
  return { id, type: "drawing2d", levelId, categoryCode: cat, geom, color: "#111111", weightMm: 0.25, ...extra } as Drawing2D;
}

/** Nordpfeil (Norden = +y im Modell, Grundrisse sind nicht gedreht): Kreis, halb gefüllte Spitze, „N". */
function northArrow(stamp: string, levelId: string, cat: string, cx: number, cy: number, r: number, north: string): Drawing2D[] {
  const P = (x: number, y: number) => sheetMmToModel(cx + x, cy + y);
  return [
    sheetShape(`d-pres-${stamp}-n0`, levelId, cat, { shape: "circle", center: P(0, 0), r: r / 1000 }),
    sheetShape(`d-pres-${stamp}-n1`, levelId, cat, { shape: "polyline", closed: true, pts: [P(0, -r), P(r * 0.45, r * 0.75), P(0, r * 0.35)] }, { fillColor: "#111111" }),
    sheetShape(`d-pres-${stamp}-n2`, levelId, cat, { shape: "polyline", closed: true, pts: [P(0, -r), P(0, r * 0.35), P(-r * 0.45, r * 0.75)] }),
    sheetText(`d-pres-${stamp}-n3`, levelId, cat, cx - r - 4, cy + 1.4, north, r * 0.8, true),
  ];
}

/** Massstabsbalken-Längen (Modell-Meter), kleinste zuerst. */
const SCALEBAR_TOTALS = [1, 2, 5, 10, 20, 50, 100, 200];

/**
 * Massstabsbalken auf der Blatt-Ebene (Papier-mm): fünf abwechselnd gefüllte Felder, rechtes Ende bei `rightMm`,
 * Mitte bei `cyMm`; Gesamtlänge die grösste runde Länge bis 50 mm auf dem Papier. Ein Massstabsbalken-Element
 * (`shape: "scalebar"`) passt nicht, weil die Blatt-Ebene 1:1 in Papier-mm rechnet.
 */
export function scaleBar(stamp: string, levelId: string, cat: string, rightMm: number, cyMm: number, scale: number): Drawing2D[] {
  const total = [...SCALEBAR_TOTALS].reverse().find((m) => (m * 1000) / scale <= 50) ?? SCALEBAR_TOTALS[0];
  const len = (total * 1000) / scale;
  const n = 5;
  const h = 1.6;
  const x0 = rightMm - len;
  const out: Drawing2D[] = [];
  for (let i = 0; i < n; i++) {
    const a = x0 + (len * i) / n;
    const b = x0 + (len * (i + 1)) / n;
    const pts = [sheetMmToModel(a, cyMm - h / 2), sheetMmToModel(b, cyMm - h / 2), sheetMmToModel(b, cyMm + h / 2), sheetMmToModel(a, cyMm + h / 2)];
    out.push(sheetShape(`d-pres-${stamp}-s${i}`, levelId, cat, { shape: "polyline", closed: true, pts }, { weightMm: 0.18, ...(i % 2 === 0 ? { fillColor: "#111111" } : {}) }));
  }
  out.push(sheetText(`d-pres-${stamp}-s${n}`, levelId, cat, x0 - 0.6, cyMm + h / 2 + 2.6, "0", 2));
  const label = `${total} m`;
  out.push(sheetText(`d-pres-${stamp}-s${n + 1}`, levelId, cat, rightMm - label.length * 1.2, cyMm + h / 2 + 2.6, label, 2));
  return out;
}

/** Kategorie für Titel und Nordpfeil: „Text"/„Beschriftung", sonst die erste. */
function annotationCategory(project: Project): string {
  const all: LayerCategory[] = [];
  const walk = (cs: readonly LayerCategory[]) => cs.forEach((c) => (all.push(c), c.children && walk(c.children)));
  walk(project.layers);
  return (all.find((c) => /beschrift|text|annot/i.test(c.name)) ?? all.find((c) => c.code === "80") ?? all[0])?.code ?? "0";
}

/**
 * Ops für das Präsentationsblatt (ein Undo-Schritt, wenn sie zusammen angewendet werden): Layout mit
 * Blatt-Ebene und Master (neu, falls keiner zum Format passt), je Ebene ein an „Präsentation" gebundener
 * Ausschnitt und ein Viewport, Titel und Nordpfeil auf der Blatt-Ebene, Schatten/Skizze an den Ebenen.
 * `stamp` macht die Ids eindeutig. Keine Ebene mit Inhalt ⇒ `null`.
 */
export function presentationSheetOps(
  project: Project,
  o: PresentationOptions,
  labels: PresentationLabels,
  stamp: string,
): { ops: CoreOp[]; layoutId: string; plan: PresentationPlan } | null {
  const plan = planPresentationSheet(project, o);
  if (plan.items.length === 0) return null;
  const { template, isNew } = presentationTemplate(project);
  const ops: CoreOp[] = [];
  if (isNew) ops.push(...addItems("viewTemplates", [template]));
  const sheet = targetSheet(o);
  const tpl = o.poster ? posterTemplate(o.poster) : undefined;
  let master = masterFor(project, o);
  if (!master && tpl) {
    master = createPosterMaster(`mas-${tpl.key}`, tpl);
    ops.push(...addItems("masterLayouts", [master]));
  } else if (!master) {
    const first = (project.masterLayouts ?? [])[0];
    master = { ...createMasterLayout(`mas-pres-${stamp}`, labels.masterName, sheet.paper, sheet.orientation), titleBlock: { ...(first?.titleBlock ?? {}) } };
    ops.push(...addItems("masterLayouts", [master]));
  }
  const layoutId = `lay-pres-${stamp}`;
  const layout: Layout = { ...createLayout(layoutId, labels.sheetName, sheet.paper, sheet.orientation), masterId: master.id };
  const sheetLevel = createSheetLevel(`sheet-${layoutId}`, layout);
  const vis = presentationVisibility(project, template);
  const labelM = scaleLabelMetrics(sheetSizeMm(sheet.paper, sheet.orientation));
  const cat = annotationCategory(project);
  const byId = new Map(project.drawingLevels.map((l) => [l.id, l]));
  const snaps: ViewSnapshot[] = [];
  const vps: LayoutViewport[] = [];
  const drawings: Drawing2D[] = [];
  // [137] Nordpfeil und Massstabsbalken als je eine Gruppe: ein Klick wählt, verschiebt und löscht sie als Ganzes.
  const groups: Group[] = [];
  const group = (id: string, name: string | undefined, members: Drawing2D[]) =>
    groups.push({ id, name, wallIds: [], drawingIds: members.map((d) => d.id), ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: [] });
  plan.items.forEach((it, i) => {
    const level = byId.get(it.levelId)!;
    const snapId = `vs-pres-${stamp}-${i}`;
    snaps.push({
      id: snapId,
      name: `${level.name} · ${template.name}`,
      viewType: "grundriss",
      view3d: "top",
      scaleDenominator: it.scale,
      detail: template.detail ?? "mittel",
      activeLevelId: level.id,
      // Grundrisse ohne die Schattenstudie des Projekts (Klasse „Schatten"): ihr Wurf läge über den Rahmen hinaus und
      // würde beschnitten; die Schatten der Ansichten (Vorlage) bleiben.
      layerVisibility: it.group === 0 ? { ...vis, [SHADOW_CATEGORY]: false } : vis,
      drawingVisibility: {},
      ...(template.enabledOverrideRuleIds ? { enabledOverrideRuleIds: [...template.enabledOverrideRuleIds] } : {}),
      templateId: template.id,
      templateLinked: true,
    } as ViewSnapshot);
    vps.push({ id: `vp-pres-${stamp}-${i}`, snapshotId: snapId, xMm: it.xMm, yMm: it.yMm, widthMm: it.widthMm, heightMm: it.heightMm, scaleDenominator: it.scale });
    // Plakat: die Massstabsangabe des Masters steht links unter dem Viewport (Grundlinie `scaleLabelMetrics`);
    // der Titel folgt rechts daneben auf derselben Linie, sonst überdecken sich beide.
    drawings.push(
      tpl
        ? sheetText(`d-pres-${stamp}-t${i}`, sheetLevel.id, cat, it.xMm + labelM.sizeMm * 3.6, it.yMm + it.heightMm + labelM.dyMm, level.name, 4, true)
        : sheetText(`d-pres-${stamp}-t${i}`, sheetLevel.id, cat, it.xMm + FRAME_PAD_MM, it.yMm + it.heightMm + 6, `${level.name}   1:${it.scale}`, 4, true),
    );
  });
  // Nordpfeil rechts neben dem Titel des ersten Grundrisses.
  const firstFloor = plan.items.find((it) => it.group === 0);
  if (firstFloor) {
    const cx = firstFloor.xMm + firstFloor.widthMm - 8;
    const cy = firstFloor.yMm + firstFloor.heightMm + 4.8;
    const north = northArrow(stamp, sheetLevel.id, cat, cx, cy, 3.6, labels.north);
    drawings.push(...north);
    group(`grp-pres-${stamp}-n`, labels.northGroup, north);
    // Massstabsbalken links vom Nordpfeil, sofern er den Titel nicht berührt (Breite grob 0.65 × Schrifthöhe je Zeichen).
    const bar = scaleBar(stamp, sheetLevel.id, cat, cx - 3.6 - 10, cy - 1, firstFloor.scale);
    const title = byId.get(firstFloor.levelId)!.name;
    const titleEnd = firstFloor.xMm + FRAME_PAD_MM + (title.length + 8) * 4 * 0.65;
    const barLeft = Math.min(...bar.flatMap((d) => (d.geom.shape === "polyline" ? d.geom.pts.map((p) => p.x * 1000) : [])));
    if (barLeft - 6 > titleEnd) {
      drawings.push(...bar);
      group(`grp-pres-${stamp}-s`, labels.scaleBarGroup, bar);
    }
  }
  ops.push(...addItems("layouts", [{ ...layout, viewports: vps }]), ...addItems("drawingLevels", [sheetLevel]));
  ops.push(...addItems("viewSnapshots", snaps), ...addItems("drawings2d", drawings));
  if (groups.length > 0) ops.push(...addItems("groups", groups));
  // Schatten (Vorlage) für Ansichten/Schnitt, Skizze nach Wahl für alle gezeigten Ebenen.
  for (const it of plan.items) {
    const level = byId.get(it.levelId)!;
    const patch: Partial<DrawingLevel> = {};
    if (it.group > 0 && template.shadows !== undefined && level.shadows !== template.shadows) patch.shadows = template.shadows;
    if (o.sketch && !level.sketch) patch.sketch = true;
    if (Object.keys(patch).length > 0) ops.push(...patchItem(project, "drawingLevels", level.id, patch));
  }
  return { ops, layoutId, plan };
}
