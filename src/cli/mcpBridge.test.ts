// [9] Brücke MCP ↔ laufende App: echte Brücke (WebSocket auf 127.0.0.1) gegen den echten App-Client
// (`net/aiBridge.ts`) mit einem Host im Speicher statt des Stores.
import { afterEach, describe, expect, it } from "vitest";
import { startBridge, wsFrame, type Bridge } from "./mcpBridge";
import { connectAiBridge, type AiBridgeStatus } from "../net/aiBridge";
import { aiText, callAiTool, randomHex, type AiHost } from "../core";
import { sampleProject } from "../model/sampleProject";

const until = async (f: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("Zeitüberschreitung");
    await new Promise((r) => setTimeout(r, 20));
  }
};

let bridge: Bridge | null = null;
let client: { close(): void } | null = null;
afterEach(async () => {
  client?.close();
  client = null;
  await bridge?.close();
  bridge = null;
});

const host: AiHost = { project: () => sampleProject, commit: () => null, select: () => {} };

describe("MCP-Brücke zur App", () => {
  it("ohne App: tools/list mit allen Werkzeugen, Aufruf meldet fehlende Verbindung", async () => {
    bridge = await startBridge({ port: 0, token: randomHex() });
    const list = (await bridge.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toContain("zoom_to");
    const r = (await bridge.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "project_info", arguments: {} } })) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("KI-Zugriff");
  });

  it("App mit richtigem Schlüssel: Aufrufe laufen über die App", async () => {
    const token = randomHex();
    bridge = await startBridge({ port: 0, token });
    const seen: string[] = [];
    let status: AiBridgeStatus = "closed";
    client = connectAiBridge({
      port: bridge.port,
      token,
      retryMs: 50,
      onStatus: (s) => (status = s),
      call: (name, args) => {
        seen.push(name);
        return callAiTool(host, name, args);
      },
    });
    await until(() => bridge!.connected() && status === "connected");
    const r = (await bridge.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "project_info", arguments: {} } })) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(r.result.isError).toBe(false);
    expect(JSON.parse(r.result.content[0].text).counts.walls).toBe(sampleProject.walls.length);
    // grosse Antwort (16-/64-Bit-Länge im Rahmen)
    const svg = await bridge.call("render_svg", { kind: "floor" });
    expect((svg.content[0] as { text: string }).text).toContain("<svg");
    expect(seen).toEqual(["project_info", "render_svg"]);
  });

  it("falscher Schlüssel: keine Verbindung, Status auth-failed", async () => {
    bridge = await startBridge({ port: 0, token: randomHex() });
    let status: AiBridgeStatus = "closed";
    let called = false;
    client = connectAiBridge({
      port: bridge.port,
      token: randomHex(),
      retryMs: 50,
      onStatus: (s) => (status = s),
      call: async () => ((called = true), aiText("x")),
    });
    await until(() => status === "auth-failed");
    expect(bridge.connected()).toBe(false);
    expect((await bridge.call("project_info", {})).isError).toBe(true);
    expect(called).toBe(false);
  });

  it("Fremder ohne Anmeldung wird getrennt und bekommt keine Aufrufe", async () => {
    bridge = await startBridge({ port: 0, token: randomHex() });
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    const msgs: string[] = [];
    ws.onmessage = (e) => msgs.push(String(e.data));
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ type: "ready" }));
    await new Promise((r) => (ws.onclose = r));
    expect(bridge.connected()).toBe(false);
    expect(msgs.map((m) => JSON.parse(m).type)).toEqual(["hello"]);
  });

  it("Rahmen-Längen 7/16/64 Bit", () => {
    expect(wsFrame(1, Buffer.alloc(5))[1]).toBe(5);
    expect(wsFrame(1, Buffer.alloc(300))[1]).toBe(126);
    expect(wsFrame(1, Buffer.alloc(70000))[1]).toBe(127);
  });
});
