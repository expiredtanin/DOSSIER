// [195b] Sync-Brücke des nativen Fensters „Objekteinstellungen" (Taste T) — reine Teile, ohne Tauri.
//
// Das Nebenfenster rendert DIESELBEN Komponenten wie das schwebende Panel (`ObjectSettingsPanel` mit Objekt-Info
// und Attributen), nur mit anderer Datenquelle: Es lädt denselben Store, hält ihn aber als Spiegel des
// Hauptfensters (Projekt-Leseansicht + eigenes Kern-Dokument, Auswahl, aktive Ebene) und stellt einen Panel-Host
// bereit, dessen Wert-Felder gespiegelt sind und dessen Handler ans Hauptfenster gehen.
//
// Hauptfenster → Nebenfenster: „object-settings-sync" mit dem ganzen Stand (`{ full }`, nach „ready") bzw. danach
//   nur den Änderungen: Projekt als Feld-Differenz der obersten Ebene (`projectDelta`, Referenzvergleich — die
//   Leseansicht teilt unveränderte Listen), UI-Teil als `StateDelta` (Strukturvergleich, kleine Werte).
// Nebenfenster → Hauptfenster: „object-settings-command" mit `{ name, args }`:
//   - `change` [ops, coalesceKey]: Projekt-Änderung (Store-Aktionen im Nebenfenster rechnen Ops auf dem Spiegel
//     und geben sie über `changeSink.ts` ab) → `applyChange` im Hauptfenster (Prüfung, Undo je Änderung);
//   - `host` [name, args]: Handler des Panel-Hosts (Wand-Typ setzen, Treppe ändern …) — läuft im Hauptfenster;
//   - `undo`, `redo`, `notify` [text, kind].
// Der neue Stand kommt in beiden Fällen über den nächsten Sync zurück (auch nach Undo im Hauptfenster).

import type { Project } from "../model/types";
import type { CoreOp } from "../core/ops";
import type { PanelHostValue } from "../panels/host";
import type { InfoGroupId } from "../panels/objectInfo/groups";
import { getState, setState } from "../state/appStore";
import { storeDocument } from "../state/historySlice";
import type { Selection } from "../state/selection";
import { applyProjectDelta, projectDelta, type ProjectDelta } from "./projectDelta";
import { applyStateDelta, stateDelta, type StateDelta } from "./windowBridge";

export const OBJECT_SETTINGS_WINDOW_LABEL = "object-settings";
export const OBJECT_SETTINGS_PREFIX = "object-settings";

/** UI-Teil des Spiegels (klein, Strukturvergleich). */
export interface ObjectSettingsUi {
  selection: Selection;
  activeLevelId: string;
  /** Wert-Felder des Panel-Hosts (aktives Werkzeug, Schnittlinie …). */
  host: Record<string, unknown>;
  /** Namen der Handler, die der Host im Hauptfenster hat. */
  handlers: string[];
  /** Taste T: Bereich „Objekt" zeigen und diesen Abschnitt aufklappen (`seq` zählt die Anfragen). */
  focus: { seq: number; group: InfoGroupId | null } | null;
}

export interface ObjectSettingsSnapshot {
  project: Project;
  ui: ObjectSettingsUi;
}

export type ObjectSettingsSync = { full: ObjectSettingsSnapshot } | { project?: ProjectDelta; ui?: StateDelta };

/** Nachricht von `prev` (zuletzt gesendet, `null` = noch nichts) nach `next`; `null` = nichts zu senden. */
export function objectSettingsSync(prev: ObjectSettingsSnapshot | null, next: ObjectSettingsSnapshot): ObjectSettingsSync | null {
  if (!prev) return { full: next };
  const project = prev.project === next.project ? null : projectDelta(prev.project, next.project);
  const ui = stateDelta(prev.ui, next.ui);
  if (ui === "full") return { full: next };
  if (!project && !ui) return null;
  return { ...(project ? { project } : {}), ...(ui ? { ui } : {}) };
}

/** Fensterseite: Nachricht anwenden. Eine Differenz vor dem ersten ganzen Stand wird verworfen (`null`). */
export function applyObjectSettingsSync(prev: ObjectSettingsSnapshot | null, msg: ObjectSettingsSync): ObjectSettingsSnapshot | null {
  if ("full" in msg) return msg.full;
  if (!prev) return null;
  return {
    project: msg.project ? applyProjectDelta(prev.project, msg.project) : prev.project,
    ui: msg.ui ? applyStateDelta(prev.ui, msg.ui) : prev.ui,
  };
}

/** Felder, die das Nebenfenster selbst stellt (nicht JSON-tauglich bzw. je Mausschritt neu). */
const LOCAL_HOST_FIELDS = new Set(["displayMode", "measurement"]);

/** Übersteht der Wert die IPC-Serialisierung (keine Zyklen)? */
function jsonSafe(v: unknown): boolean {
  try {
    JSON.stringify(v);
    return true;
  } catch {
    return false;
  }
}

/** Host des Hauptfensters zerlegt in gespiegelte Wert-Felder und die Namen seiner Handler. */
export function hostSnapshot(host: object): Pick<ObjectSettingsUi, "host" | "handlers"> {
  const values: Record<string, unknown> = {};
  const handlers: string[] = [];
  for (const [k, v] of Object.entries(host)) {
    if (LOCAL_HOST_FIELDS.has(k)) continue;
    if (typeof v === "function") handlers.push(k);
    else if (v !== undefined && jsonSafe(v)) values[k] = v;
  }
  return { host: values, handlers: handlers.sort() };
}

/**
 * Panel-Host des Nebenfensters: Wert-Felder aus dem Spiegel, Handler leiten über `call` ans Hauptfenster weiter
 * (Argumente sind reine Daten). Handler, die das Hauptfenster nicht hat, fehlen auch hier (Panels prüfen
 * optionale Handler auf Vorhandensein). Kein Messwert im Nebenfenster (änderte sich je Mausschritt).
 */
export function remoteHost(
  ui: Pick<ObjectSettingsUi, "host" | "handlers">,
  call: (name: string, args: unknown[]) => void,
): PanelHostValue {
  const handlers = new Set(ui.handlers);
  const forwarders = new Map<string, (...args: unknown[]) => void>();
  const displayMode = { mode: "all" as const, setMode: () => {} };
  return new Proxy({} as PanelHostValue, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop === "displayMode") return displayMode;
      if (prop === "measurement") return null;
      if (handlers.has(prop)) {
        let fn = forwarders.get(prop);
        if (!fn) {
          fn = (...args: unknown[]) => call(prop, args);
          forwarders.set(prop, fn);
        }
        return fn;
      }
      return ui.host[prop];
    },
    has(_t, prop) {
      return typeof prop === "string" && (handlers.has(prop) || prop in ui.host || LOCAL_HOST_FIELDS.has(prop));
    },
  });
}

/**
 * Fensterseite: Spiegel in den Store übernehmen. Ein neues Projekt wird ins Kern-Dokument des Stores geladen
 * (Abfragen wie die Objekt-Info rechnen darauf, `documentFor`); Verlauf führt nur das Hauptfenster.
 */
export function mirrorIntoStore(prev: ObjectSettingsSnapshot | null, next: ObjectSettingsSnapshot): void {
  const patch: Record<string, unknown> = {};
  if (!prev || prev.project !== next.project) {
    const doc = storeDocument(next.project);
    if (doc.current !== next.project) doc.load(next.project);
    patch.project = next.project;
  }
  if (!prev || prev.ui.selection !== next.ui.selection) patch.selection = next.ui.selection;
  if (!prev || prev.ui.activeLevelId !== next.ui.activeLevelId) patch.activeLevelId = next.ui.activeLevelId;
  if (Object.keys(patch).length > 0) setState(patch as Parameters<typeof setState>[0]);
}

/** Hauptfensterseite: Änderung aus dem Nebenfenster anwenden (`null` aus JSON = kein Schlüssel). */
export function applyForwardedChange(ops: readonly CoreOp[], coalesceKey: string | null | undefined): void {
  if (!Array.isArray(ops) || ops.length === 0) return;
  getState().applyChange(ops, coalesceKey ?? undefined);
}
