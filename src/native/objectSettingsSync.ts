// [195b] Sync-Brücke des nativen Fensters „Objekteinstellungen" (Taste T) — reine Teile, ohne Tauri.
//
// Das Nebenfenster rendert DIESELBEN Komponenten wie das schwebende Panel (`ObjectSettingsPanel` mit Objekt-Info
// und Attributen), nur mit anderer Datenquelle: Es lädt denselben Store, hält ihn aber als Spiegel des
// Hauptfensters (Projekt-Leseansicht + eigenes Kern-Dokument, Auswahl, aktive Ebene) und stellt einen Panel-Host
// bereit, dessen Wert-Felder gespiegelt sind und dessen Handler ans Hauptfenster gehen.
//
// Hauptfenster → Nebenfenster: „object-settings-sync" mit laufender Nummer `seq` und dem ganzen Stand (`{ full }`,
//   nach „ready") bzw. danach nur den Änderungen: Projekt als Ops-Strom (`ops`, die vom Kern-Dokument des
//   Hauptfensters angenommenen Ops seit dem letzten Sync — Commit, Griff, Befehl, Import, Undo/Redo; das Fenster
//   führt sie per `doc_apply` ohne Verlauf und `applyOps` nach, `ProjectDocument.applyRemote`), nur wenn die
//   Ops-Kette fehlt (Laden/Neu, grosser Verlaufsschritt ohne Ops, Änderung vorbei am Dokument) als Feld-Differenz
//   der obersten Ebene (`projectDelta`) mit Vollabgleich des Kern-Dokuments im Fenster; UI-Teil als `StateDelta`.
//   Lücke in `seq` oder abgelehnte Ops: das Fenster meldet erneut „ready" und bekommt den ganzen Stand.
// Nebenfenster → Hauptfenster: „object-settings-command" mit `{ name, args }`:
//   - `change` [ops, coalesceKey]: Projekt-Änderung (Store-Aktionen im Nebenfenster rechnen Ops auf dem Spiegel
//     und geben sie über `changeSink.ts` ab) → `applyChange` im Hauptfenster (Prüfung, Undo je Änderung);
//   - `host` [name, args]: Handler des Panel-Hosts (Wand-Typ setzen, Treppe ändern …) — läuft im Hauptfenster;
//   - `undo`, `redo`, `notify` [text, kind].
// Der neue Stand kommt in beiden Fällen über den nächsten Sync zurück (auch nach Undo im Hauptfenster).

import type { Project } from "../model/types";
import { fromMarkedJson, opsToJson, type CoreOp } from "../core/ops";
import type { ProjectDocument } from "../core/document";
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

/** Inhalt einer Sync-Nachricht (ohne Nummer). `ops` = Op-Folge als JSON mit Nicht-endlich-Marken (`opsToJson`). */
export type ObjectSettingsSyncBody = { full: ObjectSettingsSnapshot } | { project?: ProjectDelta; ops?: string; ui?: StateDelta };

/** Sync-Nachricht: `seq` zählt je Nachricht um 1 (Lücke = verlorene Nachricht → Vollabgleich). */
export type ObjectSettingsSync = { seq: number } & ObjectSettingsSyncBody;

/**
 * Nachricht von `prev` (zuletzt gesendet, `null` = noch nichts) nach `next`; `null` = nichts zu senden. `ops` =
 * die angenommenen Ops von `prev.project` nach `next.project` (`null` = nicht bekannt → Feld-Differenz).
 */
export function objectSettingsSync(
  prev: ObjectSettingsSnapshot | null,
  next: ObjectSettingsSnapshot,
  ops: readonly CoreOp[] | null = null,
): ObjectSettingsSyncBody | null {
  if (!prev) return { full: next };
  const ui = stateDelta(prev.ui, next.ui);
  if (ui === "full") return { full: next };
  const changed = prev.project !== next.project;
  const project = changed && !ops ? projectDelta(prev.project, next.project) : null;
  const opsJson = changed && ops ? opsToJson(ops) : null;
  if (!project && !opsJson && !ui) return null;
  return { ...(project ? { project } : {}), ...(opsJson ? { ops: opsJson } : {}), ...(ui ? { ui } : {}) };
}

/** Eine angenommene Änderung des Kern-Dokuments (s. `ProjectDocument.onChange`). */
interface JournalEntry {
  before: Project;
  after: Project;
  ops: readonly CoreOp[];
}

/** Ab so vielen gesammelten Ops zwischen zwei Syncs lohnt der Strom nicht mehr (Feld-Differenz). */
const MAX_STREAM_OPS = 20000;

/**
 * Hauptfensterseite: baut die Sync-Nachrichten. {@link record} sammelt die angenommenen Ops des Kern-Dokuments
 * seit dem letzten Sync; {@link next} schickt sie, wenn sie lückenlos vom zuletzt gesendeten zum aktuellen
 * Projekt führen, sonst die Feld-Differenz.
 */
export class ObjectSettingsSender {
  private sent: ObjectSettingsSnapshot | null = null;
  private seq = 0;
  private journal: JournalEntry[] | null = [];
  private journalOps = 0;

  /** Neu anfangen (Fenster [wieder] bereit, Senden fehlgeschlagen): nächste Nachricht ist der ganze Stand. */
  reset(): void {
    this.sent = null;
    this.journal = [];
    this.journalOps = 0;
  }

  /** Neue Leseansicht des Kern-Dokuments (Listener von `ProjectDocument.onChange`). */
  record(before: Project, after: Project, ops: readonly CoreOp[] | null): void {
    if (!this.sent || !this.journal || before === after) return;
    if (!ops || this.journalOps + ops.length > MAX_STREAM_OPS) {
      this.journal = null; // Kette unterbrochen: bis zum nächsten Sync Feld-Differenz
      return;
    }
    this.journal.push({ before, after, ops });
    this.journalOps += ops.length;
  }

  /** Ops von `from` nach `to` aus dem Journal, `null` = keine lückenlose Kette. */
  private chain(from: Project, to: Project): CoreOp[] | null {
    const j = this.journal;
    if (!j || j.length === 0) return null;
    let at = from;
    const out: CoreOp[] = [];
    for (const e of j) {
      if (e.before !== at) return null;
      for (const op of e.ops) out.push(op);
      at = e.after;
    }
    return at === to ? out : null;
  }

  /** Nachricht zum Stand `snap` (`null` = nichts zu senden); merkt ihn als gesendet. */
  next(snap: ObjectSettingsSnapshot): ObjectSettingsSync | null {
    const prev = this.sent;
    const ops = prev && prev.project !== snap.project ? this.chain(prev.project, snap.project) : null;
    const body = objectSettingsSync(prev, snap, ops);
    this.journal = [];
    this.journalOps = 0;
    this.sent = snap;
    if (!body) return null;
    this.seq++;
    return { seq: this.seq, ...body };
  }
}

/**
 * Fensterseite: wendet die Nachrichten auf den Spiegel und das Kern-Dokument des Fensters an (`docFor` = das
 * Dokument, dessen Leseansicht das Projekt ist; im Fenster `storeDocument`).
 */
export class ObjectSettingsReceiver {
  private snap: ObjectSettingsSnapshot | null = null;
  private seq = 0;
  private requested = false;
  /** Zahl der Vollabgleiche des Kern-Dokuments (Messung, Tests). */
  fullLoads = 0;

  constructor(private readonly docFor: (project: Project) => ProjectDocument) {}

  get current(): ObjectSettingsSnapshot | null {
    return this.snap;
  }

  /**
   * Nachricht anwenden: neuer Stand, `"resync"` = Lücke bzw. Ops abgelehnt, das Hauptfenster soll den ganzen
   * Stand schicken (einmal je Lücke; bis dahin liefern Differenzen `null` = verworfen).
   */
  receive(msg: ObjectSettingsSync): ObjectSettingsSnapshot | "resync" | null {
    if ("full" in msg) {
      const p = msg.full.project;
      this.loadDoc(p);
      this.snap = msg.full;
      this.seq = msg.seq;
      this.requested = false;
      return this.snap;
    }
    const prev = this.snap;
    let project = prev?.project;
    if (prev && project && msg.seq === this.seq + 1) {
      if (msg.ops) project = this.docFor(project).applyRemote(project, fromMarkedJson<CoreOp[]>(msg.ops)) ?? undefined;
      else if (msg.project) this.loadDoc((project = applyProjectDelta(project, msg.project)));
    } else project = undefined;
    if (!prev || !project) {
      this.snap = null;
      if (this.requested) return null;
      this.requested = true;
      return "resync";
    }
    this.seq = msg.seq;
    this.snap = { project, ui: msg.ui ? applyStateDelta(prev.ui, msg.ui) : prev.ui };
    return this.snap;
  }

  /** Vollabgleich: `project` als Ganzes ins Kern-Dokument laden. */
  private loadDoc(project: Project): void {
    const doc = this.docFor(project);
    if (doc.current === project) return;
    doc.load(project);
    this.fullLoads++;
  }
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
