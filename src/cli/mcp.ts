// MCP-Server (stdio, JSON-RPC 2.0, newline-delimited) auf einer Projektdatei — lessons-bimcraft
// [9] in der headless Variante: ein Agent liest, rendert und ändert das Projekt über dieselben
// Werkzeuge wie die Brücke zur laufenden App (`core/aiToolDefs.ts`, `core/aiTools.ts`; die
// App-Werkzeuge fehlen hier). Änderungen werden validiert und atomar in die Datei geschrieben.
// Start: `node dist-cli/dossier-cli.mjs projekt.obp mcp`.
// Nur `../core` wird importiert (Wächter in cli.test.ts).

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { AI_TOOLS, aiText, applyOps, callAiTool, parseProjectFile, serializeProject, validateOps } from "../core";
import type { AiHost, AiToolDef, AiToolResult, Project } from "../core";

export interface Rpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Werkzeug für `tools/list` (ohne die internen Kennzeichen, mit MCP-Hinweisen). */
export const mcpTool = (t: AiToolDef) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: { readOnlyHint: !t.mutating },
});

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

/** Host über eine Projektdatei: liest je Aufruf neu, schreibt nur angenommene Änderungen. */
export function fileHost(file: string): AiHost {
  const project = load(file);
  return {
    project: () => project,
    commit: (ops) => {
      const next = applyOps(project, ops);
      const problems = validateOps(next, ops, project);
      if (problems.length) return problems.join("; ");
      save(file, next);
      return null;
    },
  };
}

export async function callTool(file: string, name: string, args: Record<string, unknown>): Promise<AiToolResult> {
  if (AI_TOOLS.find((t) => t.name === name)?.appOnly) return aiText(`${name}: nur mit der laufenden App (dossier-cli mcp --app)`, true);
  return callAiTool(fileHost(file), name, args);
}

/** Behandelt EINE JSON-RPC-Nachricht mit Werkzeugliste `tools` und Ausführer `call`; `null` = keine Antwort. */
export async function handleRpc(
  msg: Rpc,
  tools: AiToolDef[],
  call: (name: string, args: Record<string, unknown>) => Promise<AiToolResult>,
  serverName = "dossier",
): Promise<object | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined) return null; // Notification (z. B. notifications/initialized)
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: "0.2.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: tools.map(mcpTool) });
    case "tools/call": {
      const p = msg.params ?? {};
      try {
        return reply(await call(String(p.name), (p.arguments ?? {}) as Record<string, unknown>));
      } catch (e) {
        return reply(aiText(e instanceof Error ? e.message : String(e), true));
      }
    }
    default:
      return error(-32601, `Methode nicht gefunden: ${msg.method}`);
  }
}

/** Headless: Werkzeuge ohne die App-Werkzeuge, auf der Datei. */
export function handleMessage(file: string, msg: Rpc): Promise<object | null> {
  return handleRpc(
    msg,
    AI_TOOLS.filter((t) => !t.appOnly),
    (name, args) => callTool(file, name, args),
  );
}

/** stdio-Schleife: jede Zeile eine JSON-RPC-Nachricht an `handle`. */
export async function serveStdio(handle: string | ((msg: Rpc) => Promise<object | null>)): Promise<void> {
  const h = typeof handle === "string" ? (m: Rpc) => handleMessage(handle, m) : handle;
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
      const res = await h(msg);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    }
  }
}
