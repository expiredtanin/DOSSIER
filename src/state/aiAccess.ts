// [9] KI-Zugriff auf das offene Projekt: Zustand (aus per Vorgabe, Sitzungsschlüssel, Pause, Protokoll),
// die Verbindung zur MCP-Brücke (`net/aiBridge.ts`) und der Host, über den die gemeinsamen Werkzeuge
// (`core/aiTools.ts`) den Store bedienen. Jede Änderung = ein Undo-Schritt „KI: <werkzeug>“; jeder Aufruf
// steht im Protokoll (Anzeige `ui/AiActivityPanel.tsx`). Dateien schreibt nur der Speichern-Dialog.

import { useSyncExternalStore } from "react";
import { AI_BRIDGE_DEFAULT_PORT, aiText, aiToolDef, applyOps, callAiTool, randomHex, validateOps } from "../core";
import type { AiHost, AiToolResult, CoreOp, Project } from "../core";
import type { Vec2 } from "../model/types";
import { connectAiBridge, type AiBridgeStatus } from "../net/aiBridge";
import { buildPlanPdf } from "../export/exportPdf";
import { saveBinaryFile, saveTextFile } from "../native/saveFile";
import { getState, setState } from "./appStore";

export interface AiLogEntry {
  at: number;
  tool: string;
  mutating: boolean;
  ok: boolean;
  /** Kurztext: Fehler oder Ergebnis-Anfang. */
  note: string;
}

export interface AiAccessState {
  enabled: boolean;
  paused: boolean;
  /** Sitzungsschlüssel (leer, bis der Zugriff einmal eingeschaltet wurde). */
  token: string;
  port: number;
  status: AiBridgeStatus | "off";
  /** Neueste zuerst. */
  log: AiLogEntry[];
}

const LOG_LIMIT = 50;
const PORT_KEY = "dossier.aiBridge.port";

function storedPort(): number {
  try {
    const n = Number(globalThis.localStorage?.getItem(PORT_KEY));
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : AI_BRIDGE_DEFAULT_PORT;
  } catch {
    return AI_BRIDGE_DEFAULT_PORT;
  }
}

let state: AiAccessState = { enabled: false, paused: false, token: "", port: AI_BRIDGE_DEFAULT_PORT, status: "off", log: [] };
const listeners = new Set<() => void>();
let conn: { close(): void } | null = null;

function update(patch: Partial<AiAccessState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const getAiAccess = (): AiAccessState => state;

export function useAiAccess(): AiAccessState {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
    () => state,
  );
}

/** „KI-Zugriff erlauben“: verbindet (bzw. trennt) die Brücke. Der Schlüssel gilt für die ganze Sitzung. */
export function setAiAccessEnabled(on: boolean): void {
  if (on === state.enabled) return;
  conn?.close();
  conn = null;
  if (!on) {
    update({ enabled: false, status: "off" });
    return;
  }
  const token = state.token || randomHex();
  const port = storedPort();
  update({ enabled: true, token, port, status: "connecting" });
  if (typeof WebSocket === "undefined") return;
  conn = connectAiBridge({
    port,
    token,
    call: handleAiCall,
    onStatus: (s) => {
      if (state.enabled) update({ status: s });
    },
  });
}

/** „KI pausieren“: weist jeden Aufruf ab, die Verbindung bleibt. */
export function setAiPaused(on: boolean): void {
  update({ paused: on });
}

export function clearAiLog(): void {
  update({ log: [] });
}

/** Planansicht für `zoom_to` (App meldet ihr Handle an, `null` beim Abbau). */
let view: { fitBounds(pts: Vec2[]): void } | null = null;
export function setAiView(v: { fitBounds(pts: Vec2[]): void } | null): void {
  view = v;
}

// ── Host über den Store ─────────────────────────────────────────────────────────────────────

type SelSetter = keyof Pick<
  ReturnType<typeof getState>,
  | "setSelectedWallIds"
  | "setSelectedDrawingIds"
  | "setSelectedCeilingIds"
  | "setSelectedOpeningIds"
  | "setSelectedStairIds"
  | "setSelectedRoomIds"
  | "setSelectedExtrudedSolidIds"
  | "setSelectedColumnIds"
  | "setSelectedRoofIds"
  | "setSelectedContextObjectIds"
>;

/** Liste des Projekts → Auswahl-Kanal (Lesen, Setzen). */
const CHANNELS: [keyof Project, string, SelSetter][] = [
  ["walls", "selectedWallIds", "setSelectedWallIds"],
  ["drawings2d", "selectedDrawingIds", "setSelectedDrawingIds"],
  ["ceilings", "selectedCeilingIds", "setSelectedCeilingIds"],
  ["openings", "selectedOpeningIds", "setSelectedOpeningIds"],
  ["stairs", "selectedStairIds", "setSelectedStairIds"],
  ["rooms", "selectedRoomIds", "setSelectedRoomIds"],
  ["extrudedSolids", "selectedExtrudedSolidIds", "setSelectedExtrudedSolidIds"],
  ["columns", "selectedColumnIds", "setSelectedColumnIds"],
  ["roofs", "selectedRoofIds", "setSelectedRoofIds"],
  ["context", "selectedContextObjectIds", "setSelectedContextObjectIds"],
];

type Ent = Record<string, unknown> & { id?: string };
const listOf = (p: Project, k: keyof Project) => ((p as unknown as Record<string, unknown>)[k] as Ent[] | undefined) ?? [];

function findEntity(p: Project, id: string): Ent | undefined {
  for (const [k] of CHANNELS) {
    const e = listOf(p, k).find((x) => x.id === id);
    if (e) return e;
  }
  return undefined;
}

/** Alle Punkte {x, y} bzw. [x, y] eines Elements (Grundriss-Meter), für das Einpassen. */
function pointsOf(v: unknown, out: Vec2[], depth = 0): void {
  if (depth > 6 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) {
    if (v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") out.push({ x: v[0], y: v[1] });
    else for (const x of v) pointsOf(x, out, depth + 1);
    return;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.x === "number" && typeof o.y === "number" && Number.isFinite(o.x) && Number.isFinite(o.y)) {
    out.push({ x: o.x, y: o.y });
    return;
  }
  for (const x of Object.values(o)) pointsOf(x, out, depth + 1);
}

export const appHost: AiHost = {
  project: () => getState().project,
  activeLevelId: () => getState().activeLevelId,
  commandDefaults: () => ({ cat: getState().activeCategoryCode }),
  commit: (ops: CoreOp[], label: string) => {
    const s = getState();
    const before = s.project;
    // Vorprüfung für eine verständliche Antwort; der Store prüft beim Anwenden nochmals (Kern).
    const problems = validateOps(applyOps(before, ops), ops, before);
    if (problems.length) return problems.join("; ");
    s.groupChanges(() => getState().applyChange(ops), undefined, label);
    return getState().project === before ? "vom Kern abgelehnt" : null;
  },
  selection: () => {
    const s = getState() as unknown as Record<string, string[]>;
    return Object.fromEntries(CHANNELS.map(([k, sel]) => [k, s[sel] ?? []]).filter(([, ids]) => ids.length > 0));
  },
  select: (ids: string[]) => {
    const s = getState();
    const p = s.project;
    s.clearSelection();
    for (const [k, , set] of CHANNELS) {
      const have = new Set(listOf(p, k).map((e) => e.id));
      const mine = ids.filter((id) => have.has(id));
      if (mine.length) s[set](mine);
    }
  },
  zoomTo: (ids: string[]) => {
    const p = getState().project;
    const pts: Vec2[] = [];
    let level: string | undefined;
    for (const id of ids) {
      const e = findEntity(p, id);
      if (!e) continue;
      level ??= (e.floorId ?? e.levelId) as string | undefined;
      const before = pts.length;
      pointsOf(e, pts);
      if (pts.length === before && typeof e.wallId === "string") pointsOf(findEntity(p, e.wallId), pts);
    }
    if (pts.length === 0) return false;
    if (level && p.drawingLevels.some((l) => l.id === level)) setState({ activeLevelId: level });
    // Erst nach dem Geschosswechsel einpassen (neuer Plan).
    const v = view;
    if (v) setTimeout(() => v.fitBounds(pts), 0);
    return true;
  },
  planPdf: async (plan, scale, title) => {
    const doc = await buildPlanPdf(plan, { scaleDenominator: scale, paper: "a3", orientation: "landscape", title });
    return new Uint8Array(doc.output("arraybuffer"));
  },
  save: (data, name, mime) => (typeof data === "string" ? saveTextFile(data, name, mime) : saveBinaryFile(data, name, mime)),
};

/** Ein Aufruf der Brücke: Pause prüfen, ausführen, protokollieren. */
export async function handleAiCall(name: string, args: Record<string, unknown>): Promise<AiToolResult> {
  const mutating = aiToolDef(name)?.mutating === true;
  const result = state.paused ? aiText("KI-Zugriff ist in Dossier pausiert", true) : await callAiTool(appHost, name, args);
  const first = result.content[0];
  const note = first?.type === "text" ? first.text.slice(0, 120) : (first?.resource.uri ?? "");
  update({ log: [{ at: Date.now(), tool: name, mutating, ok: !result.isError, note }, ...state.log].slice(0, LOG_LIMIT) });
  return result;
}
