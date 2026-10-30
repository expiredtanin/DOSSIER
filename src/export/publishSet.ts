// Publikationssätze ([79]): welche Dateien ein Satz erzeugt, mit welchen Namen und Revisionsindizes, und
// die Ops, die Index und Protokoll im Projekt nachführen. Reine Logik ohne DOM — das Rendern der PDFs
// macht `publishRun.ts`.

import type { Layout, LayoutPaperFormat, Project, PublishLogSheet, PublishSet } from "../model/types";
import { findMaster, resolveTitleBlock } from "../model/layoutModel";
import { fieldOps, patchItem } from "../core/opsBuild";
import type { CoreOp } from "../core/ops";

/** Standard-Muster für Einzeldateien (je Blatt). */
export const DEFAULT_NAME_PATTERN = "{Projektnummer}_{Blattnummer}_{Blattname}_{Index}";

export type PublishFormat = "pdf-multi" | "pdf-single" | "dxf" | "dwg";

/** Revisionsindex hochzählen: "" → A, A → B, Z → AA, 2 → 3, 09 → 10; sonst wird "2" angehängt. */
export function nextRevision(rev: string | undefined): string {
  const r = (rev ?? "").trim();
  if (r === "") return "A";
  if (/^[A-Z]+$/.test(r)) {
    const c = r.split("");
    let i = c.length - 1;
    while (i >= 0) {
      if (c[i] === "Z") {
        c[i] = "A";
        i--;
      } else {
        c[i] = String.fromCharCode(c[i].charCodeAt(0) + 1);
        return c.join("");
      }
    }
    return "A" + c.join("");
  }
  const m = /^(.*?)(\d+)$/.exec(r);
  if (m) {
    const n = String(Number(m[2]) + 1);
    return m[1] + n.padStart(m[2].length, "0");
  }
  return r + "2";
}

/** Dateiname aus Muster: `{Projektnummer} {Projekt} {Blattnummer} {Blattname} {Index} {Datum} {Satz}`; Unbekanntes/Leeres entfällt. */
export function expandNamePattern(pattern: string, vars: Record<string, string>): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  const out = pattern
    .replace(/\{([^{}]+)\}/g, (_m, k: string) => clean(vars[k] ?? ""))
    .replace(/_{2,}/g, "_")
    .replace(/^[\s_.-]+|[\s_.-]+$/g, "");
  return out || clean(vars.Satz ?? "") || "publikation";
}

export interface PublishPlanFile {
  fileName: string;
  /** Blätter dieser Datei in Reihenfolge (leer bei DXF: Papierbereiche des Projekts). */
  layoutIds: string[];
  /** Gespeicherte Ansichten, die als eigene Seiten in diese Datei kommen (nur PDF). */
  snapshotIds: string[];
  format: PublishFormat;
}

export interface PublishPlan {
  files: PublishPlanFile[];
  /** Blätter mit Nummer und dem Index, der in der Ausgabe steht (nach dem Hochzählen). */
  sheets: PublishLogSheet[];
  paperOverride?: LayoutPaperFormat;
  scaleOverride?: number;
  pdfLayers: boolean;
  includeRevision: boolean;
}

/** Die Layouts des Satzes in Satz-Reihenfolge (unbekannte ids entfallen). */
export function setLayouts(project: Project, set: PublishSet): Layout[] {
  const all = project.layouts ?? [];
  return set.layoutIds.flatMap((id) => all.filter((l) => l.id === id));
}

/** Plant die Ausgabe: Dateien mit Namen, Blätter mit Nummer/Index (Index schon hochgezählt, wenn `bumpRevision`). */
export function planPublish(project: Project, set: PublishSet, today: string): PublishPlan {
  const includeRevision = set.includeRevision ?? true;
  const bump = set.bumpRevision ?? false;
  const format = (set.format as PublishFormat | undefined) ?? "pdf-multi";
  const layouts = setLayouts(project, set);

  const sheets = layouts.map((l) => {
    const tb = resolveTitleBlock(project, l, findMaster(project, l));
    const revision = includeRevision ? (bump ? nextRevision(l.revision) : (l.revision ?? "")) : "";
    return { layoutId: l.id, number: tb.planNumber, name: l.name, revision };
  });
  const base = {
    Projektnummer: project.projectNumber ?? "",
    Projekt: project.name ?? "",
    Datum: today,
    Satz: set.name,
  };
  const cad = format === "dxf" || format === "dwg";
  const ext = cad ? format : "pdf";
  const snaps = cad ? [] : (set.snapshotIds ?? []).flatMap((id) => (project.viewSnapshots ?? []).filter((v) => v.id === id));
  const pattern = set.namePattern || DEFAULT_NAME_PATTERN;
  const files: PublishPlanFile[] =
    format === "pdf-single"
      ? [
          ...sheets.map((s) => ({
            fileName: `${expandNamePattern(pattern, { ...base, Blattnummer: s.number, Blattname: s.name, Index: s.revision })}.${ext}`,
            layoutIds: [s.layoutId],
            snapshotIds: [],
            format,
          })),
          ...snaps.map((v) => ({
            fileName: `${expandNamePattern(pattern, { ...base, Blattnummer: "", Blattname: v.name, Index: "" })}.${ext}`,
            layoutIds: [],
            snapshotIds: [v.id],
            format,
          })),
        ]
      : [
          {
            fileName: `${expandNamePattern(set.namePattern || "{Satz}", { ...base, Blattnummer: "", Blattname: "", Index: "" })}.${ext}`,
            layoutIds: cad ? [] : sheets.map((s) => s.layoutId),
            snapshotIds: snaps.map((v) => v.id),
            format,
          },
        ];
  return {
    files,
    sheets,
    ...(set.paperOverride ? { paperOverride: set.paperOverride } : {}),
    ...(set.scaleOverride ? { scaleOverride: set.scaleOverride } : {}),
    pdfLayers: set.pdfLayers ?? true,
    includeRevision,
  };
}

/** Ops einer Publikation: Index je Blatt hochzählen (`bumpRevision`) und Protokolleintrag anhängen. */
export function publishOps(project: Project, set: PublishSet, plan: PublishPlan, nowIso: string, logId: string): CoreOp[] {
  const ops: CoreOp[] = [];
  if (set.bumpRevision) {
    for (const s of plan.sheets) ops.push(...patchItem(project, "layouts", s.layoutId, { revision: nextRevision(project.layouts?.find((l) => l.id === s.layoutId)?.revision) }));
  }
  const entry = { id: logId, setId: set.id, setName: set.name, date: nowIso, sheets: plan.sheets, files: plan.files.map((f) => f.fileName) };
  ops.push(...fieldOps(project, "publishLog", [...(project.publishLog ?? []), entry]));
  return ops;
}
