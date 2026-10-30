// Grafische Legende auf dem Layout-Blatt ([82]): welche Schraffuren/Materialien, Linientypen und Kategorien
// die gezeigten Viewports verwenden (oder die Handauswahl der Legende) und wie die Legende als Zeichnung
// aussieht. Die Legende ist KEIN eigener Renderer: sie wird als gewöhnliche 2D-Elemente auf der Blatt-Ebene
// (Papier 1:1 in Metern) beschrieben — Schraffur-Muster, Linien und Schrift erzeugt derselbe Kern wie im
// Plan; Bildschirm, PDF und DXF lesen dasselbe Ergebnis, und sie folgt dem Projekt bei jeder Änderung.

import type { Drawing2D, Layout, LayoutLegend, Project, ViewSnapshot } from "../model/types";
import { getLayerCategory } from "../model/types";
import { findSnapshot, sheetMmToModel, visibleCodesFromSnapshot } from "../model/layoutModel";

export type LegendKind = "hatch" | "lineType" | "category";

export interface LegendEntry {
  /** `component:<id>` (Material mit Schnitt-Schraffur), `hatch:<id>`, `lineType:<id>`, `category:<code>`. */
  key: string;
  kind: LegendKind;
  label: string;
  /** Schraffur des Musters (kind "hatch"). */
  hatchId?: string;
  /** Linienfarbe der Schraffur bzw. des Linientyps / Füllfarbe der Kategorie. */
  color?: string;
  /** Füllfarbe hinter der Schraffur. */
  background?: string;
  lineStyleId?: string;
}

const DEFAULT_KINDS: LegendKind[] = ["hatch"];
const MIN_ORDER: Record<LegendKind, number> = { hatch: 0, lineType: 1, category: 2 };

function kindOfKey(key: string): LegendKind | undefined {
  const k = key.slice(0, key.indexOf(":"));
  if (k === "component" || k === "hatch") return "hatch";
  return k === "lineType" || k === "category" ? k : undefined;
}

/** Schlüssel, die EIN Ausschnitt braucht: Material der Wände/Decken/Dächer/Stützen, Schraffuren/Linientypen der Zeichnungen, Kategorien. */
function keysOfSnapshot(project: Project, snap: ViewSnapshot, out: Set<string>): void {
  const visible = visibleCodesFromSnapshot(snap);
  const level = snap.activeLevelId;
  const comps = (layers: { componentId: string }[] | undefined) => {
    for (const l of layers ?? []) out.add(`component:${l.componentId}`);
  };
  const cat = (code: string | undefined) => {
    if (code && visible.has(code)) out.add(`category:${code}`);
    return !!code && visible.has(code);
  };
  for (const w of project.walls) {
    if (w.floorId !== level || !cat(w.categoryCode)) continue;
    if (w.hatchId) out.add(`hatch:${w.hatchId}`);
    comps(project.wallTypes.find((t) => t.id === w.wallTypeId)?.layers);
  }
  for (const c of project.ceilings ?? []) {
    if (c.floorId !== level || !cat(c.categoryCode)) continue;
    if (c.hatchId) out.add(`hatch:${c.hatchId}`);
    comps((project.ceilingTypes ?? []).find((t) => t.id === c.ceilingTypeId)?.layers ?? project.wallTypes.find((t) => t.id === c.wallTypeId)?.layers);
  }
  for (const r of project.roofs ?? []) {
    if (r.floorId !== level || !cat(r.categoryCode)) continue;
    comps((project.roofTypes ?? []).find((t) => t.id === r.roofTypeId)?.layers);
  }
  for (const c of project.columns ?? []) {
    if (c.floorId !== level || !cat(c.categoryCode)) continue;
    if (c.hatchId) out.add(`hatch:${c.hatchId}`);
    if (c.componentId) out.add(`component:${c.componentId}`);
  }
  for (const r of project.rooms ?? []) if (r.floorId === level) cat(r.categoryCode);
  for (const d of project.drawings2d) {
    if (d.levelId !== level || !cat(d.categoryCode)) continue;
    if (d.hatchId) out.add(`hatch:${d.hatchId}`);
    if (d.lineStyleId) out.add(`lineType:${d.lineStyleId}`);
  }
}

/** Alle Schlüssel der Viewports eines Blatts (Reihenfolge des ersten Auftretens). */
export function legendKeysOfViewports(project: Project, layout: Layout): string[] {
  const out = new Set<string>();
  for (const vp of layout.viewports) {
    const snap = findSnapshot(project, vp.snapshotId);
    if (snap) keysOfSnapshot(project, snap, out);
  }
  return [...out];
}

function entryOf(project: Project, key: string): LegendEntry | undefined {
  const i = key.indexOf(":");
  const id = key.slice(i + 1);
  switch (key.slice(0, i)) {
    case "component": {
      const c = project.components.find((x) => x.id === id);
      if (!c?.hatchId) return undefined;
      return { key, kind: "hatch", label: c.name, hatchId: c.hatchId, color: c.foreground, background: c.background ?? c.color };
    }
    case "hatch": {
      const h = project.hatches.find((x) => x.id === id);
      return h ? { key, kind: "hatch", label: h.name, hatchId: h.id, color: h.color } : undefined;
    }
    case "lineType": {
      const l = project.lineStyles.find((x) => x.id === id);
      return l ? { key, kind: "lineType", label: l.name, lineStyleId: l.id, color: l.color } : undefined;
    }
    case "category": {
      const c = getLayerCategory(project, id);
      return c ? { key, kind: "category", label: `${c.code} ${c.name}`, color: c.color } : undefined;
    }
  }
  return undefined;
}

/**
 * Einträge der Legende: Handauswahl (`manualKeys`) in deren Reihenfolge, sonst automatisch aus den Viewports;
 * nur die gewählten Arten (`kinds`, Standard Schraffuren), ohne Doppelte, Unbekanntes entfällt.
 */
export function legendEntries(project: Project, layout: Layout, legend: LayoutLegend): LegendEntry[] {
  const kinds = new Set<LegendKind>((legend.kinds as LegendKind[] | undefined)?.length ? (legend.kinds as LegendKind[]) : DEFAULT_KINDS);
  const manual = legend.manualKeys ?? [];
  const keys = manual.length > 0 ? manual : legendKeysOfViewports(project, layout);
  const seen = new Set<string>();
  const out: LegendEntry[] = [];
  for (const key of keys) {
    const kind = kindOfKey(key);
    if (!kind || !kinds.has(kind) || seen.has(key)) continue;
    seen.add(key);
    const e = entryOf(project, key);
    if (e) out.push(e);
  }
  if (manual.length === 0) out.sort((a, b) => MIN_ORDER[a.kind] - MIN_ORDER[b.kind]);
  return out;
}

// ── Aussehen (Papier-mm) ──────────────────────────────────────────────────────

const TITLE_H = 3.5; // Schrifthöhe Titel
const TEXT_H = 2.5; // Schrifthöhe Einträge
const PAD = 3;
const SWATCH_W = 14;
const SWATCH_H = 6;
const GAP = 2;
const ROW = SWATCH_H + GAP;
const CHAR_W = 0.65; // mittlere Zeichenbreite in Schrifthöhen (nur für die Rahmenbreite, grosszügig)

export interface LegendDrawings {
  drawings: Drawing2D[];
  widthMm: number;
  heightMm: number;
}

/** Die Legende als 2D-Elemente auf der Blatt-Ebene `levelId` (Papier 1:1, Ursprung oben links, Papier-y = −y). */
export function legendDrawings(project: Project, legend: LayoutLegend, entries: readonly LegendEntry[], levelId: string): LegendDrawings {
  const title = legend.title?.trim() || "Legende";
  const categoryCode = project.layers[0]?.code ?? "";
  const textW = Math.max(title.length * TITLE_H, ...entries.map((e) => e.label.length * TEXT_H)) * CHAR_W;
  const w = PAD * 2 + SWATCH_W + 3 + textW;
  const h = PAD * 2 + TITLE_H + GAP + Math.max(1, entries.length) * ROW - GAP;
  const x0 = legend.xMm;
  const y0 = legend.yMm;
  const p = (x: number, y: number) => sheetMmToModel(x, y);
  const m = (v: number) => v / 1000;
  let n = 0;
  const base = (): Pick<Drawing2D, "id" | "type" | "levelId" | "categoryCode"> => ({ id: `${legend.id}-${n++}`, type: "drawing2d", levelId, categoryCode });
  const out: Drawing2D[] = [];
  out.push({ ...base(), geom: { shape: "rect", min: p(x0, y0 + h), max: p(x0 + w, y0) }, background: "#ffffff", color: "#111111", weightMm: 0.25 });
  out.push({
    ...base(),
    geom: { shape: "text", at: p(x0 + PAD, y0 + PAD + TITLE_H), text: title, height: m(TITLE_H), angle: 0 },
    color: "#111111",
  });
  let y = y0 + PAD + TITLE_H + GAP;
  for (const e of entries) {
    const sx = x0 + PAD;
    if (e.kind === "hatch") {
      out.push({
        ...base(),
        geom: { shape: "rect", min: p(sx, y + SWATCH_H), max: p(sx + SWATCH_W, y) },
        hatchId: e.hatchId,
        ...(e.color ? { foreground: e.color } : {}),
        background: e.background ?? "#ffffff",
        color: "#111111",
        weightMm: 0.18,
      });
    } else if (e.kind === "lineType") {
      out.push({
        ...base(),
        geom: { shape: "line", a: p(sx, y + SWATCH_H / 2), b: p(sx + SWATCH_W, y + SWATCH_H / 2) },
        lineStyleId: e.lineStyleId,
        weightMm: 0.35,
      });
    } else {
      out.push({
        ...base(),
        geom: { shape: "rect", min: p(sx, y + SWATCH_H), max: p(sx + SWATCH_W, y) },
        background: e.color ?? "#cccccc",
        color: "#111111",
        weightMm: 0.18,
      });
    }
    out.push({
      ...base(),
      geom: { shape: "text", at: p(sx + SWATCH_W + 3, y + SWATCH_H / 2 + TEXT_H * 0.35), text: e.label, height: m(TEXT_H), angle: 0 },
      color: "#111111",
    });
    y += ROW;
  }
  return { drawings: out, widthMm: w, heightMm: h };
}

// ── Listen-Änderungen am Layout ───────────────────────────────────────────────

/** Fläche der Legende auf dem Blatt (mm): Lage aus dem Modell, Grösse aus Inhalt (Treffer-Test, Rahmen). */
export function legendBox(project: Project, layout: Layout, legend: LayoutLegend): { xMm: number; yMm: number; widthMm: number; heightMm: number } {
  const { widthMm, heightMm } = legendDrawings(project, legend, legendEntries(project, layout, legend), "x");
  return { xMm: legend.xMm, yMm: legend.yMm, widthMm, heightMm };
}

export function addLegend(layout: Layout, legend: LayoutLegend): Layout {
  return { ...layout, legends: [...(layout.legends ?? []), legend] };
}

export function patchLegend(layout: Layout, id: string, patch: Partial<Omit<LayoutLegend, "id">>): Layout {
  return { ...layout, legends: (layout.legends ?? []).map((l) => (l.id === id ? { ...l, ...patch } : l)) };
}

export function removeLegend(layout: Layout, id: string): Layout {
  const legends = (layout.legends ?? []).filter((l) => l.id !== id);
  const { legends: _old, ...rest } = layout;
  return legends.length > 0 ? { ...rest, legends } : rest;
}
