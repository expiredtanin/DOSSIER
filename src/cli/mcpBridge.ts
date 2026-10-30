// [9] MCP-Brücke zur laufenden App: `dossier-cli mcp --app [--port 7979] [--token …]` spricht MCP über
// stdio mit dem KI-Client und reicht die Werkzeug-Aufrufe an die App weiter. Die App verbindet sich
// (nur mit „KI-Zugriff erlauben“) als WebSocket-Client mit dieser Brücke, die nur auf 127.0.0.1 lauscht;
// beide Seiten melden sich per HMAC mit dem Sitzungsschlüssel aus den Einstellungen der App an
// (`core/aiToolDefs.ts`). So braucht der App-Host (Tauri/Electron/Browser) keinen eigenen Server.
// Der WebSocket-Server ist bewusst minimal (RFC 6455: Text, Ping/Pong, Schliessen; keine Erweiterungen).

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { AI_TOOLS, aiText, hmacHex, randomHex, sameMac } from "../core";
import type { AiBridgeMsg, AiToolResult } from "../core";
import { handleRpc, type Rpc } from "./mcp";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 64 * 1024 * 1024;

// ── WebSocket (Server-Seite, minimal) ─────────────────────────────────────────────────────────

interface WsConn {
  send(text: string): void;
  close(): void;
  onmessage?: (text: string) => void;
  onclose?: () => void;
}

/** Rahmen (Server → Client: unmaskiert). */
export function wsFrame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (n >= 126 && n < 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else if (n >= 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

function upgrade(req: IncomingMessage, socket: Duplex): WsConn | null {
  const key = req.headers["sec-websocket-key"];
  if (String(req.headers.upgrade).toLowerCase() !== "websocket" || typeof key !== "string" || req.headers["sec-websocket-version"] !== "13") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return null;
  }
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buf = Buffer.alloc(0);
  let parts: Buffer[] = [];
  let closed = false;
  const conn: WsConn = {
    send: (text) => {
      if (!closed) socket.write(wsFrame(1, Buffer.from(text, "utf8")));
    },
    close: () => {
      if (closed) return;
      closed = true;
      socket.end(wsFrame(8, Buffer.alloc(0)));
      conn.onclose?.();
    },
  };
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return conn.close();
        len = Number(big);
        off = 10;
      }
      if (!masked || len > MAX_MESSAGE) return conn.close(); // Client-Rahmen müssen maskiert sein
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) return conn.close();
      if (op === 9) socket.write(wsFrame(10, data));
      else if (op === 1 || op === 0) {
        parts.push(data);
        if (parts.reduce((s, p) => s + p.length, 0) > MAX_MESSAGE) return conn.close();
        if (fin) {
          const text = Buffer.concat(parts).toString("utf8");
          parts = [];
          conn.onmessage?.(text);
        }
      }
    }
  });
  const end = () => {
    if (!closed) {
      closed = true;
      conn.onclose?.();
    }
  };
  socket.on("close", end);
  socket.on("error", end);
  return conn;
}

// ── Brücke ───────────────────────────────────────────────────────────────────────────────────

export interface Bridge {
  port: number;
  connected(): boolean;
  call(name: string, args: Record<string, unknown>): Promise<AiToolResult>;
  handle(msg: Rpc): Promise<object | null>;
  close(): Promise<void>;
}

/** Startet die Brücke auf 127.0.0.1:`port` (0 = frei wählen). */
export function startBridge(opts: { port: number; token: string; callTimeoutMs?: number }): Promise<Bridge> {
  let app: WsConn | null = null;
  let nextId = 1;
  const pending = new Map<number, (r: AiToolResult) => void>();
  const server = createServer((_req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Dossier MCP-Brücke: nur WebSocket\n");
  });
  server.on("upgrade", (req, socket) => {
    const conn = upgrade(req, socket);
    if (!conn) return;
    const nonce = randomHex();
    let authed = false;
    let ready = false;
    conn.onmessage = async (text) => {
      let m: AiBridgeMsg;
      try {
        m = JSON.parse(text) as AiBridgeMsg;
      } catch {
        return conn.close();
      }
      if (!ready && m.type === "auth" && typeof m.nonce === "string") {
        if (authed || !sameMac(m.mac, await hmacHex(opts.token, `app:${nonce}`))) return conn.close();
        authed = true;
        conn.send(JSON.stringify({ type: "auth", mac: await hmacHex(opts.token, `bridge:${m.nonce}`) } satisfies AiBridgeMsg));
      } else if (authed && !ready && m.type === "ready") {
        if (app) return conn.close(); // nur eine App zugleich
        ready = true;
        app = conn;
      } else if (ready && m.type === "result") {
        pending.get(m.id)?.(m.result);
        pending.delete(m.id);
      } else if (!ready) conn.close();
    };
    conn.onclose = () => {
      if (app !== conn) return;
      app = null;
      for (const [id, done] of pending) {
        done(aiText("Verbindung zur App getrennt", true));
        pending.delete(id);
      }
    };
    conn.send(JSON.stringify({ type: "hello", nonce } satisfies AiBridgeMsg));
  });

  const call = (name: string, args: Record<string, unknown>): Promise<AiToolResult> => {
    const conn = app;
    if (!conn)
      return Promise.resolve(
        aiText("Dossier ist nicht verbunden: in der App unter Einstellungen „KI-Zugriff erlauben“ einschalten und den Schlüssel als --token übergeben.", true),
      );
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(aiText("Zeitüberschreitung: keine Antwort der App", true));
      }, opts.callTimeoutMs ?? 300_000);
      pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      conn.send(JSON.stringify({ type: "call", id, name, args } satisfies AiBridgeMsg));
    });
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : opts.port,
        connected: () => app !== null,
        call,
        handle: (msg) => handleRpc(msg, AI_TOOLS, call, "dossier-app"),
        close: () =>
          new Promise<void>((done) => {
            app?.close();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
