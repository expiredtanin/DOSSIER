// [9] MCP-Brücke Ende zu Ende: KI-Zugriff in den Einstellungen einschalten, `dossier-cli mcp --app`
// mit dem angezeigten Schlüssel starten, über MCP (stdio) eine Wand zeichnen lassen, Protokoll,
// Rückgängig („KI: run_command“) und Pause prüfen.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { expect, startNewProject, test } from "./app";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** MCP-Client über stdio: eine Anfrage je Zeile, Antworten nach id. */
function mcpClient(proc: ChildProcessWithoutNullStreams) {
  let buf = "";
  const waiting = new Map<number, (v: unknown) => void>();
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl)) as { id: number };
      buf = buf.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  let id = 0;
  const request = (method: string, params: object = {}) =>
    new Promise<{ result: { isError?: boolean; content?: { text: string }[]; tools?: { name: string }[] } }>((resolve) => {
      const my = ++id;
      waiting.set(my, resolve as (v: unknown) => void);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
    });
  const call = async (name: string, args: object = {}) => (await request("tools/call", { name, arguments: args })).result;
  return { request, call };
}

test("KI-Zugriff: MCP-Client zeichnet über die Brücke eine Wand in der offenen App", async ({ page }) => {
  const port = await freePort();
  await page.addInitScript((p) => localStorage.setItem("dossier.aiBridge.port", String(p)), port);
  await startNewProject(page);

  // Aus per Vorgabe: kein Protokoll sichtbar. Einschalten in den Einstellungen.
  await expect(page.getByTestId("ai-activity")).toHaveCount(0);
  await page.getByRole("menubar").getByRole("button", { name: "Fenster", exact: true }).click();
  await page.getByRole("option", { name: "Einstellungen" }).click();
  await page.getByRole("checkbox", { name: "KI-Zugriff erlauben" }).check();
  const token = await page.getByTestId("ai-token").inputValue();
  expect(token).toMatch(/^[0-9a-f]{32}$/);

  const proc = spawn("node", ["dist-cli/dossier-cli.mjs", "mcp", "--app", "--port", String(port), "--token", token]);
  try {
    const mcp = mcpClient(proc);
    await mcp.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
    const tools = (await mcp.request("tools/list")).result.tools!.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["run_command", "select", "zoom_to", "export"]));

    await expect(page.getByTestId("ai-status")).toHaveText("Verbunden", { timeout: 15_000 });
    await page.getByRole("button", { name: "Schließen" }).first().click();

    const before = JSON.parse((await mcp.call("project_info")).content![0].text).counts.walls ?? 0;
    const r = await mcp.call("run_command", { cmd: "wall", params: { pts: [[0, 0], [5, 0]] } });
    expect(r.isError, r.content?.[0]?.text).toBe(false);
    const added = JSON.parse(r.content![0].text).added as { collection: string; id: string }[];
    expect(added.map((a) => a.collection)).toEqual(["walls"]);
    expect(JSON.parse((await mcp.call("project_info")).content![0].text).counts.walls).toBe(before + 1);
    expect((await mcp.call("select", { ids: [added[0].id] })).isError).toBe(false);
    expect(JSON.parse((await mcp.call("get_selection")).content![0].text)).toEqual({ walls: [added[0].id] });

    // Protokoll in der App: Änderung markiert
    const log = page.getByTestId("ai-log");
    await expect(log.locator("li.is-change")).toHaveCount(1);
    await expect(log).toContainText("run_command");

    // Ein Undo-Schritt nimmt die ganze KI-Änderung zurück
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => JSON.parse((await mcp.call("project_info")).content![0].text).counts.walls ?? 0).toBe(before);

    // Pause: Aufrufe abgewiesen
    await page.getByTestId("ai-pause").check();
    const paused = await mcp.call("project_info");
    expect(paused.isError).toBe(true);
    expect(paused.content![0].text).toContain("pausiert");
  } finally {
    proc.kill();
  }
});
