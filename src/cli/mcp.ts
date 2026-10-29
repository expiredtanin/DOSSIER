// MCP-Server (stdio, JSON-RPC 2.0, newline-delimited) auf einer Projektdatei — lessons-bimcraft
// [9] in der headless Variante: ein Agent liest, rendert und ändert das Projekt über dieselben
// `CoreOp`s wie die UI (core/ops.ts). Änderungen werden validiert und atomar in die Datei
// geschrieben. Start: `node dist-cli/dossier-cli.mjs projekt.obp mcp`.
// Nur `../core` wird importiert (Wächter in cli.test.ts).

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  applyOps,
  computeSection,
  generateElevationPlan,
  generatePlan,
  generateSectionPlan,
  parseProjectFile,
  planToSvgString,
  serializeProject,
  validateOps,
  validateProject,
  projectWarnings,
} from "../core";
import type { CoreOp, Project } from "../core";

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "project_info",
    description: "Zählt Bauteile des Projekts und listet Geschosse/Schnitte/Ansichten.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "query",
    description: "Liest Elemente einer Liste (walls, ceilings, roofs, openings, stairs, rooms, drawings2d, extrudedSolids, …), optional eine id.",
    inputSchema: {
      type: "object",
      properties: { collection: { type: "string" }, id: { type: "string" }, limit: { type: "number" } },
      required: ["collection"],
    },
  },
  {
    name: "render_svg",
    description: "Rendert Grundriss (kind=floor), Schnitt (section) oder Ansicht (elevation) als SVG-Text.",
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["floor", "section", "elevation"] }, name: { type: "string" }, scale: { type: "number" } },
      required: ["kind"],
    },
  },
  {
    name: "apply_ops",
    description:
      "Wendet CoreOps an (add/replace/remove/reorder/setField, JSON). Validiert (NaN, doppelte ids) und schreibt die Datei nur bei Erfolg.",
    inputSchema: {
      type: "object",
      properties: { ops: { type: "array", items: { type: "object" } } },
      required: ["ops"],
    },
  },
  { name: "validate", description: "Prüft das gesamte Projekt auf nicht endliche Zahlen und doppelte ids.", inputSchema: { type: "object", properties: {} } },
];

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

function load(file: string): Project {
  const r = parseProjectFile(readFileSync(file, "utf8"));
  if (!r.ok) throw new Error(r.error);
  return r.project;
}

function save(file: string, p: Project): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, serializeProject(p));
  renameSync(tmp, file); // atomar
}

export async function callTool(file: string, name: string, args: Record<string, unknown>) {
  const project = load(file);
  const codes = new Set(project.layers.map((l) => l.code));
  switch (name) {
    case "project_info":
      return text(
        JSON.stringify({
          name: project.name,
          counts: Object.fromEntries(
            Object.entries(project as unknown as Record<string, unknown>)
              .filter(([, v]) => Array.isArray(v))
              .map(([k, v]) => [k, (v as unknown[]).length]),
          ),
          levels: project.drawingLevels.map((l) => ({ id: l.id, name: l.name, kind: l.kind })),
        }),
      );
    case "query": {
      const list = (project as unknown as Record<string, unknown>)[String(args.collection)];
      if (!Array.isArray(list)) return text(`Keine Liste: ${String(args.collection)}`, true);
      const rows = args.id ? list.filter((e) => (e as { id?: string }).id === args.id) : list.slice(0, Number(args.limit ?? 50));
      return text(JSON.stringify(rows));
    }
    case "render_svg": {
      const kind = String(args.kind);
      const lvl = project.drawingLevels.find((l) => l.kind === kind && (!args.name || l.name === args.name || l.id === args.name));
      if (!lvl) return text(`Ebene nicht gefunden: ${kind} ${String(args.name ?? "")}`, true);
      const scale = Number(args.scale ?? 100);
      if (kind === "floor") return text(planToSvgString(generatePlan(project, lvl.id, codes), { scaleDenominator: scale }));
      if (kind === "section") {
        const o = await computeSection(project, lvl);
        if (!o) return text("keine gültige Schnittlinie", true);
        return text(planToSvgString(generateSectionPlan(o, false, { visibleCodes: codes }), { scaleDenominator: scale }));
      }
      const plan = generateElevationPlan(project, lvl);
      return plan ? text(planToSvgString(plan, { scaleDenominator: scale })) : text("keine gültige Ansichtslinie", true);
    }
    case "apply_ops": {
      const ops = args.ops as CoreOp[];
      if (!Array.isArray(ops)) return text("ops muss eine Liste sein", true);
      const next = applyOps(project, ops);
      const problems = validateOps(next, ops, project);
      if (problems.length) return text(`Abgelehnt, nichts geschrieben: ${problems.join("; ")}`, true);
      save(file, next);
      return text(`ok: ${ops.length} Op(s) angewendet und gespeichert`);
    }
    case "validate": {
      const problems = validateProject(project);
      const warnings = projectWarnings(project).map((w) => `Warnung: ${w}`);
      return text([...problems, ...warnings].join("\n") || "ok", problems.length > 0);
    }
    default:
      return text(`unbekanntes Werkzeug: ${name}`, true);
  }
}

/** Behandelt EINE JSON-RPC-Nachricht; `null` = keine Antwort (Notification). */
export async function handleMessage(file: string, msg: Rpc): Promise<object | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined) return null; // Notification (z. B. notifications/initialized)
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "dossier", version: "0.1.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const p = msg.params ?? {};
      try {
        return reply(await callTool(file, String(p.name), (p.arguments ?? {}) as Record<string, unknown>));
      } catch (e) {
        return reply(text(e instanceof Error ? e.message : String(e), true));
      }
    }
    default:
      return error(-32601, `Methode nicht gefunden: ${msg.method}`);
  }
}

/** stdio-Schleife. */
export async function serveStdio(file: string): Promise<void> {
  let buf = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: Rpc;
      try {
        msg = JSON.parse(line) as Rpc;
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
        continue;
      }
      const res = await handleMessage(file, msg);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    }
  }
}
