// [9] KI-Werkzeuge: EINE Liste für den headless MCP-Server (`dossier-cli … mcp`) und die Brücke zur
// laufenden App (`dossier-cli mcp --app`), dazu das Brücken-Protokoll (Nachrichten, gegenseitige
// Anmeldung per HMAC). Bewusst ohne Importe: die Brücke und der e2e-Test laden nur diese Datei.

/** Beschreibung eines Werkzeugs (MCP `tools/list`) plus Dossier-Merkmale. */
export interface AiToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** Ändert das Projekt (in der App: ein Undo-Schritt „KI: <name>“, im Protokoll markiert). */
  mutating?: boolean;
  /** Braucht die laufende App (Auswahl, Ansicht, Speichern-Dialog). */
  appOnly?: boolean;
}

const obj = (properties: Record<string, unknown> = {}, required?: string[]) =>
  ({ type: "object", properties, ...(required ? { required } : {}) }) as AiToolDef["inputSchema"];
const ids = { type: "array", items: { type: "string" } };

export const AI_TOOLS: AiToolDef[] = [
  {
    name: "project_info",
    description: "Zählt Bauteile des Projekts und listet Geschosse/Schnitte/Ansichten (in der App mit aktivem Geschoss).",
    inputSchema: obj(),
  },
  {
    name: "query",
    description:
      "Liest Elemente einer Liste (walls, ceilings, roofs, openings, stairs, rooms, columns, drawings2d, extrudedSolids, drawingLevels, …), optional nach id/ids gefiltert.",
    inputSchema: obj({ collection: { type: "string" }, id: { type: "string" }, ids, limit: { type: "number" } }, ["collection"]),
  },
  {
    name: "render_svg",
    description: "Rendert Grundriss (kind=floor), Schnitt (section) oder Ansicht (elevation) als SVG-Text.",
    inputSchema: obj({ kind: { type: "string", enum: ["floor", "section", "elevation"] }, name: { type: "string" }, scale: { type: "number" } }, ["kind"]),
  },
  {
    name: "apply_ops",
    description:
      "Wendet CoreOps an (add/replace/remove/reorder/setField, JSON). Der Kern prüft (NaN, doppelte ids); bei Fehler bleibt das Projekt unverändert.",
    inputSchema: obj({ ops: { type: "array", items: { type: "object" } } }, ["ops"]),
    mutating: true,
  },
  {
    name: "run_command",
    description:
      "Führt einen Kern-Befehl mit JSON-Parametern aus (dieselben wie die Befehle der Oberfläche): z. B. " +
      '{cmd:"wall", pts:[[0,0],[5,0]]}, {cmd:"room"|"ceiling"|"roof", pts:[…]}, {cmd:"column", at:[x,y]}, ' +
      '{cmd:"opening", wall:<id>, start, end (Wandachse), pos, width, height, sill, kind:"door"|"window"}, {cmd:"rect"|"polyline"|"circle", …}, {cmd:"transform", ids, …}, ' +
      '{cmd:"align"|"distribute", ids, mode|axis}, {cmd:"split", ids}. `level` = Geschoss-id (Standard: aktives bzw. erstes).',
    inputSchema: obj({ cmd: { type: "string" }, params: { type: "object" }, level: { type: "string" } }, ["cmd"]),
    mutating: true,
  },
  { name: "validate", description: "Prüft das gesamte Projekt auf nicht endliche Zahlen und doppelte ids.", inputSchema: obj() },
  {
    name: "kennzahlen",
    description: "Kennzahlen (kind=kennzahlen: Flächen/Volumen, Raumprogramm, Baurecht), SIA-416-Flächentabelle (sia416) oder IVHB-Kennziffern (ivhb) als JSON.",
    inputSchema: obj({ kind: { type: "string", enum: ["kennzahlen", "sia416", "ivhb"] } }),
  },
  {
    name: "schedule",
    description: "Listen: Fenster/Türen (kind=openings, JSON), Bauteile mit U-Werten (elements, JSON) oder Bauteilliste (list, CSV).",
    inputSchema: obj({ kind: { type: "string", enum: ["openings", "elements", "list"] } }),
  },
  { name: "get_selection", description: "Liefert die aktuelle Auswahl der App als {collection: [ids]}.", inputSchema: obj(), appOnly: true },
  {
    name: "select",
    description: "Wählt Elemente nach id in der App aus (ersetzt die Auswahl; leere Liste = Auswahl aufheben).",
    inputSchema: obj({ ids }, ["ids"]),
    appOnly: true,
  },
  {
    name: "zoom_to",
    description: "Wechselt aufs Geschoss der Elemente und passt die Planansicht der App auf sie ein.",
    inputSchema: obj({ ids }, ["ids"]),
    appOnly: true,
  },
  {
    name: "export",
    description:
      "Exportiert Grundriss als SVG (format=svg) oder PDF (pdf, nur App) bzw. das Modell als IFC (ifc). Liefert den Inhalt " +
      "(PDF base64); mit save=true öffnet die App den Speichern-Dialog und die Nutzerin wählt den Ort.",
    inputSchema: obj(
      { format: { type: "string", enum: ["svg", "pdf", "ifc"] }, level: { type: "string" }, scale: { type: "number" }, save: { type: "boolean" } },
      ["format"],
    ),
  },
];

export const aiToolDef = (name: string): AiToolDef | undefined => AI_TOOLS.find((t) => t.name === name);

// ── Brücken-Protokoll (WebSocket, JSON je Nachricht) ─────────────────────────────────────────
//
// Die Brücke (`dossier-cli mcp --app`) lauscht auf 127.0.0.1:<port>; die App verbindet sich nur,
// wenn „KI-Zugriff erlauben“ an ist. Anmeldung gegenseitig, ohne dass der Schlüssel reist:
//   Brücke → App   {type:"hello", nonce:Nb}
//   App → Brücke   {type:"auth", nonce:Na, mac:HMAC(token, "app:"+Nb)}
//   Brücke → App   {type:"auth", mac:HMAC(token, "bridge:"+Na)}        (sonst Abbruch)
//   App → Brücke   {type:"ready"}
// danach Brücke → App {type:"call", id, name, args}, App → Brücke {type:"result", id, result}.

export const AI_BRIDGE_DEFAULT_PORT = 7979;

export type AiBridgeMsg =
  | { type: "hello"; nonce: string }
  | { type: "auth"; nonce?: string; mac: string }
  | { type: "ready" }
  | { type: "call"; id: number; name: string; args: Record<string, unknown> }
  | { type: "result"; id: number; result: AiToolResult };

/** Ergebnis eines Werkzeugs (MCP `tools/call`). */
export interface AiToolResult {
  content: ({ type: "text"; text: string } | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } })[];
  isError: boolean;
}

export const aiText = (text: string, isError = false): AiToolResult => ({ content: [{ type: "text", text }], isError });

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Zufällige Hex-Zeichenkette (`bytes` Bytes) aus dem Krypto-Zufall. */
export function randomHex(bytes = 16): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return hex(b);
}

/** HMAC-SHA256(token, msg) als Hex (WebCrypto: Browser, Tauri-WebView und Node). */
export async function hmacHex(token: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(msg))));
}

/** Vergleich in konstanter Zeit (gleich lange Hex-Texte). */
export function sameMac(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
