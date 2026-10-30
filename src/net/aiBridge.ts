// [9] App-Seite der MCP-Brücke: verbindet sich (nur wenn „KI-Zugriff erlauben“ an ist) mit der Brücke
// `dossier-cli mcp --app` auf 127.0.0.1, meldet sich gegenseitig per HMAC an (der Schlüssel reist nie,
// s. `core/aiToolDefs.ts`) und beantwortet deren Werkzeug-Aufrufe über `call`. Kein Abruf ins Netz:
// fest auf die lokale Schleife; versucht es bis `close()` alle `retryMs` erneut.

import { aiText, hmacHex, randomHex, sameMac, type AiBridgeMsg, type AiToolResult } from "../core/aiToolDefs";

export type AiBridgeStatus = "connecting" | "connected" | "auth-failed" | "closed";

export interface AiBridgeClientOptions {
  port: number;
  token: string;
  call: (name: string, args: Record<string, unknown>) => Promise<AiToolResult>;
  onStatus?: (s: AiBridgeStatus) => void;
  retryMs?: number;
}

/** Startet die Verbindungsschleife; `close()` beendet sie und trennt. */
export function connectAiBridge(o: AiBridgeClientOptions): { close(): void } {
  let stopped = false;
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failed = false; // nach falschem Schlüssel bleibt die Meldung stehen, bis eine Anmeldung gelingt
  const status = (s: AiBridgeStatus) => o.onStatus?.(s);

  const retry = () => {
    if (stopped) return;
    timer = setTimeout(open, o.retryMs ?? 2000);
  };

  function open(): void {
    if (stopped) return;
    if (!failed) status("connecting");
    let sock: WebSocket;
    try {
      sock = new WebSocket(`ws://127.0.0.1:${o.port}`);
    } catch {
      retry();
      return;
    }
    ws = sock;
    let stage: "hello" | "auth" | "ready" = "hello";
    let myNonce = "";
    const send = (m: AiBridgeMsg) => sock.send(JSON.stringify(m));
    sock.onmessage = async (ev) => {
      let m: AiBridgeMsg;
      try {
        m = JSON.parse(String(ev.data)) as AiBridgeMsg;
      } catch {
        sock.close();
        return;
      }
      if (stage === "hello" && m.type === "hello" && typeof m.nonce === "string") {
        myNonce = randomHex();
        stage = "auth";
        send({ type: "auth", nonce: myNonce, mac: await hmacHex(o.token, `app:${m.nonce}`) });
      } else if (stage === "auth" && m.type === "auth") {
        if (!sameMac(m.mac, await hmacHex(o.token, `bridge:${myNonce}`))) {
          failed = true;
          status("auth-failed");
          sock.close();
          return;
        }
        stage = "ready";
        send({ type: "ready" });
        failed = false;
        status("connected");
      } else if (stage === "ready" && m.type === "call" && typeof m.id === "number") {
        let result: AiToolResult;
        try {
          result = await o.call(String(m.name), m.args && typeof m.args === "object" ? m.args : {});
        } catch (e) {
          result = aiText(e instanceof Error ? e.message : String(e), true);
        }
        if (sock.readyState === WebSocket.OPEN) send({ type: "result", id: m.id, result });
      } else if (stage !== "ready") {
        // Unerwartete Nachricht vor der Anmeldung: kein Gespräch mit Unbekannten.
        sock.close();
      }
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (stage === "ready") status("connecting");
      else if (stage === "auth") {
        // Die Brücke trennt nach unserer Anmeldung: sie kennt einen anderen Schlüssel.
        failed = true;
        status("auth-failed");
      }
      retry();
    };
    sock.onerror = () => {
      /* onclose folgt */
    };
  }

  open();
  return {
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
      ws = null;
      status("closed");
    },
  };
}
