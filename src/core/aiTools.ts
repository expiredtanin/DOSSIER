// [9] Verteilung der KI-Werkzeuge (`aiToolDefs.ts`) auf einen Host: die Projektdatei (headless,
// `dossier-cli … mcp`) oder die laufende App (Brücke, `state/aiBridge.ts`). Gemeinsam ist alles, was
// nur das Projekt braucht; Auswahl, Ansicht, PDF und Speichern-Dialog liefert nur die App.
// Änderungen gehen ausschliesslich als Ops an `host.commit` (ein Schritt, Beschriftung „KI: <tool>“).

import type { Project } from "../model/types";
import type { Plan } from "../plan/generatePlan";
import { generatePlan } from "../plan/generatePlan";
import { computeSection, generateSectionPlan } from "../plan/toSection";
import { generateElevationPlan } from "../plan/toElevation";
import { planToSvgString } from "../export/planToSvgString";
import { exportIfcSpf } from "../export/exportIfc";
import { exportScheduleCsv } from "../export/exportSchedule";
import { openingSchedule } from "../export/openingSchedule";
import { elementSchedule } from "../export/elementSchedule";
import { computeKennzahlen, checkRoomProgram } from "../analysis/kennzahlen";
import { computeAreaTable, computeIvhb } from "../analysis/areaTable";
import { checkSiteRules } from "../analysis/siteRules";
import { loadFileio } from "../engine/fileioWasm";
import { documentFor } from "./document";
import { validateProject, projectWarnings, type CoreOp } from "./ops";
import { aiText, aiToolDef, randomHex, type AiToolResult } from "./aiToolDefs";

/** Was ein Werkzeug vom Gegenüber braucht. Optionale Teile fehlen headless. */
export interface AiHost {
  project(): Project;
  /** Ops als EIN Schritt anwenden (Beschriftung `label`); `null` = angenommen, sonst der Grund. */
  commit(ops: CoreOp[], label: string): string | null;
  activeLevelId?(): string | undefined;
  /** Vorgaben der Befehle wie in der Oberfläche (aktive Kategorie, Wandtyp). */
  commandDefaults?(): { cat?: string; wallType?: string };
  /** Auswahl je Liste (`walls`, `rooms`, …). */
  selection?(): Record<string, string[]>;
  select?(ids: string[]): void;
  /** Auf die Elemente einpassen; `false` = keine Geometrie gefunden. */
  zoomTo?(ids: string[]): boolean;
  planPdf?(plan: Plan, scale: number, title: string): Promise<Uint8Array>;
  /** Speichern-Dialog: die Nutzerin wählt den Ort; `false` = abgebrochen. */
  save?(data: string | Uint8Array, name: string, mime: string): Promise<boolean>;
}

const json = (v: unknown) => aiText(JSON.stringify(v));
const err = (t: string) => aiText(t, true);

function strIds(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function floorLevel(project: Project, host: AiHost, want: unknown) {
  const floors = project.drawingLevels.filter((l) => l.kind === "floor");
  if (typeof want === "string" && want) return floors.find((l) => l.id === want || l.name === want);
  const active = host.activeLevelId?.();
  return floors.find((l) => l.id === active) ?? floors[0];
}

const codesOf = (p: Project) => new Set(p.layers.map((l) => l.code));

/** Führt Werkzeug `name` mit `args` auf `host` aus (MCP-Ergebnis, Fehler als `isError`). */
export async function callAiTool(host: AiHost, name: string, args: Record<string, unknown>): Promise<AiToolResult> {
  const def = aiToolDef(name);
  if (!def) return err(`unbekanntes Werkzeug: ${name}`);
  try {
    return await dispatch(host, name, args ?? {});
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function dispatch(host: AiHost, name: string, args: Record<string, unknown>): Promise<AiToolResult> {
  const project = host.project();
  const label = `KI: ${name}`;
  switch (name) {
    case "project_info":
      return json({
        name: project.name,
        counts: Object.fromEntries(
          Object.entries(project as unknown as Record<string, unknown>)
            .filter(([, v]) => Array.isArray(v))
            .map(([k, v]) => [k, (v as unknown[]).length]),
        ),
        levels: project.drawingLevels.map((l) => ({ id: l.id, name: l.name, kind: l.kind })),
        ...(host.activeLevelId ? { activeLevelId: host.activeLevelId() } : {}),
      });
    case "query": {
      const list = (project as unknown as Record<string, unknown>)[String(args.collection)];
      if (!Array.isArray(list)) return err(`Keine Liste: ${String(args.collection)}`);
      const want = strIds(args.ids) ?? (typeof args.id === "string" ? [args.id] : null);
      const rows = want ? list.filter((e) => want.includes((e as { id?: string }).id ?? "")) : list.slice(0, Number(args.limit ?? 50));
      return json(rows);
    }
    case "render_svg": {
      const kind = String(args.kind);
      const lvl = project.drawingLevels.find((l) => l.kind === kind && (!args.name || l.name === args.name || l.id === args.name));
      if (!lvl) return err(`Ebene nicht gefunden: ${kind} ${String(args.name ?? "")}`);
      const scale = Number(args.scale ?? 100);
      const codes = codesOf(project);
      if (kind === "floor") return aiText(planToSvgString(generatePlan(project, lvl.id, codes), { scaleDenominator: scale }));
      if (kind === "section") {
        const o = await computeSection(project, lvl);
        if (!o) return err("keine gültige Schnittlinie");
        return aiText(planToSvgString(generateSectionPlan(o, false, { visibleCodes: codes }), { scaleDenominator: scale }));
      }
      const plan = generateElevationPlan(project, lvl, { scaleDenominator: scale });
      return plan ? aiText(planToSvgString(plan, { scaleDenominator: scale })) : err("keine gültige Ansichtslinie");
    }
    case "apply_ops": {
      const ops = args.ops as CoreOp[];
      if (!Array.isArray(ops)) return err("ops muss eine Liste sein");
      const problem = host.commit(ops, label);
      return problem ? err(`Abgelehnt, nichts geändert: ${problem}`) : aiText(`ok: ${ops.length} Op(s) angewendet`);
    }
    case "run_command": {
      const cmd = args.cmd;
      if (typeof cmd !== "string" || !cmd) return err("cmd fehlt");
      const params = (args.params && typeof args.params === "object" ? args.params : {}) as Record<string, unknown>;
      const lvl = floorLevel(project, host, args.level);
      const d = host.commandDefaults?.() ?? {};
      const cat = d.cat ?? project.walls[0]?.categoryCode ?? project.layers[0]?.code ?? "";
      const ctx = { level: lvl?.id ?? "", floorHeight: lvl?.floorHeight ?? null, cat, wallType: d.wallType ?? "", ...((params.ctx as object) ?? {}) };
      const ops = documentFor(project).cmdOps({ ...params, cmd, ctx, stamp: `ki${Date.now().toString(36)}${randomHex(3)}` });
      if (ops.length === 0) return err(`Befehl „${cmd}“ ergab keine Änderung (Parameter prüfen)`);
      const problem = host.commit(ops, label);
      if (problem) return err(`Abgelehnt, nichts geändert: ${problem}`);
      const added = ops.flatMap((o) => (o.kind === "add" ? o.items.map((e) => ({ collection: o.collection, id: (e as { id?: string }).id })) : []));
      return json({ ok: true, ops: ops.length, added });
    }
    case "validate": {
      const problems = validateProject(project);
      const warnings = projectWarnings(project).map((w) => `Warnung: ${w}`);
      return aiText([...problems, ...warnings].join("\n") || "ok", problems.length > 0);
    }
    case "kennzahlen": {
      const kind = String(args.kind ?? "kennzahlen");
      if (kind === "sia416") return json(computeAreaTable(project));
      if (kind === "ivhb") return json(computeIvhb(project));
      return json({ kennzahlen: computeKennzahlen(project), raumprogramm: checkRoomProgram(project), baurecht: checkSiteRules(project) });
    }
    case "schedule": {
      const kind = String(args.kind ?? "openings");
      if (kind === "openings") return json(openingSchedule(project));
      if (kind === "elements") return json(elementSchedule(project));
      if (kind === "list") return aiText(exportScheduleCsv(project));
      return err(`schedule: unbekannte Art ${kind}`);
    }
    case "get_selection":
      return host.selection ? json(host.selection()) : appOnly(name);
    case "select": {
      if (!host.select) return appOnly(name);
      const ids = strIds(args.ids);
      if (!ids) return err("ids muss eine Liste von Texten sein");
      host.select(ids);
      return aiText(`ok: ${ids.length} gewählt`);
    }
    case "zoom_to": {
      if (!host.zoomTo) return appOnly(name);
      const ids = strIds(args.ids);
      if (!ids) return err("ids muss eine Liste von Texten sein");
      return host.zoomTo(ids) ? aiText("ok") : err("keine Geometrie zu diesen ids gefunden");
    }
    case "export":
      return exportTool(host, project, args);
    default:
      return err(`unbekanntes Werkzeug: ${name}`);
  }
}

const appOnly = (name: string) => err(`${name}: nur mit der laufenden App (dossier-cli mcp --app)`);

async function exportTool(host: AiHost, project: Project, args: Record<string, unknown>): Promise<AiToolResult> {
  const format = String(args.format);
  const stem = project.name || "projekt";
  const scale = Number(args.scale ?? 100);
  if (args.save === true && !host.save) return err("save: Speichern nur in der App (Dialog, Ort wählt die Nutzerin)");
  let data: string | Uint8Array;
  let file: string;
  let mime: string;
  if (format === "ifc") {
    await loadFileio();
    data = exportIfcSpf(project);
    file = `${stem}.ifc`;
    mime = "application/x-step";
  } else if (format === "svg" || format === "pdf") {
    const lvl = floorLevel(project, host, args.level);
    if (!lvl) return err("kein Geschoss");
    const plan = generatePlan(project, lvl.id, codesOf(project));
    if (format === "svg") {
      data = planToSvgString(plan, { scaleDenominator: scale });
      mime = "image/svg+xml";
    } else {
      if (!host.planPdf) return appOnly("export pdf");
      data = await host.planPdf(plan, scale, `${stem} – ${lvl.name}`);
      mime = "application/pdf";
    }
    file = `${stem}-${lvl.name}.${format}`;
  } else return err(`export: unbekanntes Format ${format}`);
  if (args.save === true) {
    const ok = await host.save!(data, file, mime);
    return ok ? aiText(`gespeichert: ${file}`) : err("Speichern abgebrochen");
  }
  if (typeof data === "string") return aiText(data);
  return { content: [{ type: "resource", resource: { uri: `dossier:${file}`, mimeType: mime, blob: b64(data) } }], isError: false };
}
