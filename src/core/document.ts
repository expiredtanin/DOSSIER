// Projekt-Dokument im Rust-Kern ([K4], Stufe S1; S3: Prüfung und Undo/Redo im Kern, s. `commit`;
// S4: Laden/Speichern der Projektdatei, s. `loadFile`/`serialize`). Änderungen kommen als Ops
// (`commit`), ein anderes Projekt als Ganzes (`load`, `loadFile` — leert den Verlauf). TS hält die
// Leseansicht (`current`). Das gemeinsame Abfrage-Dokument (`documentFor`) folgt fremden Projekten
// feldweise (`sync`); bei jedem Widerspruch wird es aus dem vollen Projekt neu geöffnet.

import type { Project } from "../model/types";
import { core } from "../engine/coreWasm";
import { applyOps, opsToJson } from "./ops";
import { fromMarkedJson, toMarkedJson } from "./ops";
import type { CoreOp } from "./ops";
import { fieldOps } from "./opsBuild";
import { opsMutation } from "./opsBuild";
import type { ProjectMutation } from "./opsBuild";
import type { IfcImportResult } from "../io/ifcImport";
import type { MeshImportReport } from "../io/meshImport";

/**
 * Gelesene Zeichnungs-Datei für den Kern ([K4] S4): Puffer des Format-Moduls, je Stück (paralleles Lesen
 * grosser DXF) hintereinander als `[n, len_0 … len_{n−1}, daten …]`, die String-Tabellen je Stück, und wie
 * der Puffer zu lesen ist (DXF/DWG bzw. PDF-Seite mit Massstab).
 */
export interface ImportSource {
  geom: Float64Array;
  strings: string[][];
  source: { kind: "drawing" } | { kind: "pdf"; scale: number; texts?: boolean };
}

/** Entscheidung des Import-Dialogs (bzw. CLI) für {@link ProjectDocument.importDrawing}; Texte schon übersetzt. */
export interface DrawingImportDecision {
  target: { kind: "existing"; levelId: string } | { kind: "new"; name: string };
  categoryMode: "byLayer" | "active";
  activeCategoryCode: string;
  importMeshes: boolean;
  /** Mitte des Ausschnitts (Platzierung „viewCenter"); fehlt = an den Datei-Koordinaten. */
  viewCenter?: [number, number];
  /** Name einer neuen Zeichnung ohne Eingabe, `{n}` = Nummer. */
  levelNameTemplate?: string;
  /** Elternkategorie der neuen Layer-Kategorien. */
  parentName?: string;
  /** Name neuer Linienstile aus PDF-Strichmustern, `{pattern}` = Muster. */
  dashStyleTemplate?: string;
}

/** Rohergebnis des IFC-Lesers (`fileio`): Bericht (JSON), Positionen, Indizes, Zahlen der Bauteil-Erkennung. */
export interface IfcFlatInput {
  meta: string;
  positions: Float64Array;
  indices: Uint32Array;
  elementData?: Float64Array;
}

/** Ergebnis des Ladens einer Projektdatei ({@link ProjectDocument.loadFile}). */
export type LoadFileResult =
  | { ok: true; project: Project; warnings: string[]; migratedFrom: number | null }
  | { ok: false; error: string };

/** Wurzel-Abfragen des Kerns (`queries.rs::run_root`). */
export type RootQueryName = "penRebakeOps" | "penDeleteOps" | "penSeedOps" | "folderPdfPages" | "layoutTitleBlock" | "translatePatch" | "translateOps" | "selectionFilterPatch";

/** Abfragen des Kerns (`queries.rs`). */
export type QueryName =
  | "kennzahlen"
  | "areaTable"
  | "programCompare"
  | "programLayout"
  | "ivhb"
  | "siteCheck"
  | "buildingFootprint"
  | "modelTop"
  | "shadows"
  | "materialMaps"
  | "slabs"
  | "columnMeshes"
  | "walls"
  | "openingMeshes"
  | "stairSlabs"
  | "stairMeshes"
  | "stairRailings"
  | "roofMeshes"
  | "roofCutLayers"
  | "scheduleRows"
  | "scheduleCsv"
  | "pickGeometry"
  | "model3dParts"
  | "planDomains"
  | "ifcExportData"
  | "meshExportData"
  | "groupMembership"
  | "containingGroup"
  | "selectionCategoryCodes"
  | "expandToGroups"
  | "drawingUnderlay"
  | "drawingLines"
  | "drawingPrims"
  | "levelMarkers"
  | "planUnderlay"
  | "sectionPlan"
  | "elevationPlan"
  | "modelJson";

/** Ab so vielen Ops öffnet `sync` das Dokument neu, statt sie einzeln anzuwenden. */
const SYNC_REOPEN_OPS = 2000;

export class ProjectDocument {
  private handle = 0;
  private mirror: Project;
  /** Verlaufsgrenzen (Schritte, Bytes), beim Neuöffnen wieder gesetzt. */
  private limits: [number, number] | null = null;

  constructor(project: Project) {
    this.mirror = project;
    this.reopen(project);
  }

  /** Handle im Kern (0 = nicht offen). */
  get id(): number {
    return this.handle;
  }

  private reopen(project: Project): void {
    if (this.handle) core().doc_close(this.handle);
    this.handle = core().doc_open(JSON.stringify(project));
    if (!this.handle) console.warn("Projekt-Dokument im Kern konnte nicht geöffnet werden.");
    else if (this.limits) core().doc_history_limits(this.handle, this.limits[0], this.limits[1]);
  }

  /**
   * Bringt das Abfrage-Dokument auf den Stand `next` (ohne Verlauf): nur die Felder, deren Referenz
   * sich geändert hat, je über {@link fieldOps} (Listen elementweise) — unveränderte Teile kosten
   * nichts. Kein Weg für Benutzer-Änderungen (die gehen als Ops über {@link commit}).
   */
  sync(next: Project): void {
    if (next === this.mirror) return;
    const a = this.mirror as unknown as Record<string, unknown>;
    const b = next as unknown as Record<string, unknown>;
    const ops: CoreOp[] = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[key] !== b[key]) ops.push(...fieldOps(this.mirror, key as keyof Project, b[key] as never));
    }
    this.mirror = next;
    if (ops.length === 0) return;
    // Ganz anderes Projekt (Tests, Laden): neu öffnen statt Tausender Einzel-Ops — das Entfernen
    // vieler Elemente einzeln wäre quadratisch (Kataster-Importe mit 10⁵ Zeichnungen).
    if (!this.handle || ops.length > SYNC_REOPEN_OPS) {
      this.reopen(next);
      return;
    }
    const problems = core().doc_apply(this.handle, JSON.stringify(ops));
    if (problems) {
      console.warn("Kern-Dokument weicht ab, wird neu geöffnet:", problems);
      this.reopen(next);
    }
  }

  /**
   * Abfrage auf dem typisierten Projekt im Kern (`queries.rs`); `args` Zahlen, `text` ein Text
   * (z. B. eine id). Das Ergebnis ist JSON; Fehler im Kern (Projekt passt nicht zum Modell,
   * Rechenfehler) werfen mit der Meldung des Kerns.
   */
  query<T>(name: QueryName, args: number[] = [], text = ""): T {
    return JSON.parse(this.queryJson(name, args, text)) as T;
  }

  /** Wie {@link query}, aber das JSON als Text (spart das Parsen, wenn es nur weitergereicht wird). */
  queryJson(name: QueryName, args: number[] = [], text = ""): string {
    if (!this.handle) throw new Error(`Kern-Abfrage „${name}": Dokument nicht offen`);
    const out = core().doc_query_args(this.handle, name, Float64Array.from(args), text);
    if (out.startsWith("\u0001")) throw new Error(out.slice(1));
    return out;
  }

  /**
   * Abfrage auf dem rohen Projekt-JSON des Kerns (`queries.rs::run_root`): rechnet verlustfrei auf dem
   * Baum (unbekannte Felder, Schlüsselreihenfolge) und liefert meist Ops. `text`: Argument (Text/JSON).
   */
  queryRoot<T>(name: RootQueryName, text = ""): T {
    if (!this.handle) throw new Error(`Kern-Abfrage „${name}": Dokument nicht offen`);
    const out = core().doc_query_root(this.handle, name, text);
    if (out.startsWith("\u0001")) throw new Error(out.slice(1));
    return JSON.parse(out) as T;
  }

  /**
   * Abfrage mit binärer Antwort (`queries.rs::run_bin`, z. B. `planDomains` als Plan-Puffer v2,
   * s. `plan/planBuf.ts`). Fehler kommen als Fehlerpuffer (`decodePlanBuf` wirft die Meldung).
   */
  queryBin(name: QueryName, args: number[] | Float64Array = [], text = ""): Uint8Array {
    if (!this.handle) throw new Error(`Kern-Abfrage „${name}": Dokument nicht offen`);
    return core().doc_query_bin(this.handle, name, args instanceof Float64Array ? args : Float64Array.from(args), text);
  }

  /**
   * Projekt laden (Neu, Musterhaus, Abgleich nach einer Änderung vorbei an den Ops): ersetzt den
   * ganzen Inhalt im Kern und leert den Verlauf. `project` wird die Leseansicht (Identität bleibt).
   */
  load(project: Project): void {
    this.mirror = project;
    if (!this.handle || !core().doc_load_json(this.handle, JSON.stringify(project))) this.reopen(project);
  }

  /**
   * Projektdatei laden (Öffnen, Vorlage, Wiederherstellen; [K4] S4): der Kern liest den Text, migriert
   * ältere Formate, prüft und ergänzt (`project_format.rs`) und lädt das Ergebnis direkt ins Dokument
   * (Verlauf leer). Die Leseansicht kommt als JSON des Dokuments zurück. Bei Fehler bleibt alles, wie es war.
   */
  loadFile(text: string, now = Date.now()): LoadFileResult {
    if (!this.handle) this.reopen({} as Project);
    if (!this.handle) return { ok: false, error: "Projekt-Dokument im Kern nicht offen." };
    const r = JSON.parse(core().doc_load_file(this.handle, text, now)) as
      | { ok: true; warnings: string[]; migratedFrom: number | null }
      | { ok: false; error: string };
    if (!r.ok) return r;
    const project = JSON.parse(core().doc_json(this.handle)) as Project;
    this.mirror = project;
    return { ok: true, project, warnings: r.warnings, migratedFrom: r.migratedFrom };
  }

  /** Datei-Text des Projekts (Formatversion vorn, Einrückung 2, Zeichen für Zeichen wie `JSON.stringify`). */
  serialize(): string {
    return this.handle ? core().doc_serialize(this.handle) : "";
  }

  /** Boden-Spuren der 2D-Zeichnungen als LineList-Vertices `[px, py, pz, r, g, b]`. */
  drawingLineVerts(): Float32Array {
    return this.handle ? core().doc_drawing_line_verts(this.handle) : new Float32Array(0);
  }

  /** Das Dokument als JSON-Text (Test, Export). */
  json(): string {
    return this.handle ? core().doc_json(this.handle) : "";
  }

  close(): void {
    if (this.handle) core().doc_close(this.handle);
    this.handle = 0;
  }

  // ── Änderungen mit Verlauf ([K4] S3, [7], [8]) ──────────────────────────────
  // Der Kern prüft, wendet an und zeichnet Undo-Schritte als inverse Ops auf; das TS-Projekt ist
  // die Leseansicht und wird mit genau den Ops nachgeführt, die der Kern angenommen bzw. für
  // Undo/Redo geliefert hat (`applyOps`, unveränderte Elemente behalten ihre Identität).

  /** Stand des Spiegels (die zuletzt übernommene Leseansicht). */
  get current(): Project {
    return this.mirror;
  }

  /**
   * Stellt sicher, dass das Dokument `base` spiegelt. Wurde das Projekt vorbei an den Ops
   * geändert (fremder Stand), passt der Verlauf nicht mehr: `base` wird als Ganzes geladen.
   */
  private ensure(base: Project): void {
    if (base === this.mirror && this.handle) return;
    this.load(base);
  }

  /**
   * Benutzer-Änderung: `ops` (auf `base`) im Kern prüfen, anwenden und als Undo-Schritt
   * aufzeichnen (`coalesceKey` + `now` in ms: Serien im Zeitfenster = ein Schritt).
   * Ergebnis: neues Projekt oder die Meldungen des Kerns (dann bleibt alles unverändert).
   */
  commit(base: Project, ops: readonly CoreOp[], coalesceKey: string | undefined, now: number): { project: Project } | { problems: string[] } {
    this.ensure(base);
    if (!this.handle) return { problems: ["Projekt-Dokument im Kern nicht offen."] };
    const res = core().doc_commit(this.handle, opsToJson(ops), coalesceKey ?? "", now);
    if (res) {
      let problems: string[];
      try {
        problems = JSON.parse(res) as string[];
      } catch {
        problems = [res];
      }
      return { problems };
    }
    const project = applyOps(base, ops, core().doc_last_hits(this.handle));
    this.mirror = project;
    return { project };
  }

  /**
   * Griff-Änderung ([K4] S3, `grips.rs`): der Kern rechnet `req` (s. `GripRequest`) auf seinem Stand
   * von `base` und wendet das Ergebnis wie {@link commit} an — ein Aufruf je Mausschritt. Ergebnis:
   * neues Projekt und die angewendeten Ops (leer = nichts zu tun, dann `project === base`), ein
   * Hinweis-Schlüssel (i18n) oder die Meldungen der Prüfung (dann bleibt alles unverändert).
   */
  commitGrip(base: Project, req: object, coalesceKey: string | undefined, now: number): { project: Project; ops: CoreOp[]; notice?: string } | { problems: string[] } {
    this.ensure(base);
    if (!this.handle) return { problems: ["Projekt-Dokument im Kern nicht offen."] };
    const out = core().doc_grip_commit(this.handle, gripJson(req), coalesceKey ?? "", now);
    if (out.startsWith("\u0001")) throw new Error(out.slice(1));
    const r = fromMarkedJson<{ ops: CoreOp[]; notice?: string } | { problems: string[] }>(out);
    if ("problems" in r) return r;
    if (r.ops.length === 0) return { project: base, ops: r.ops, notice: r.notice };
    const project = applyOps(base, r.ops, core().doc_last_hits(this.handle));
    this.mirror = project;
    return { project, ops: r.ops, notice: r.notice };
  }

  /**
   * Wie {@link queryRoot} für Abfragen, deren Antwort nicht endliche Zahlen als Marken trägt
   * (`selectionInfo`, `drawingBBoxes`); die Marken werden wieder Zahlen.
   */
  queryRootMarked<T>(name: "selectionInfo" | "drawingBBoxes" | "verticalExtents", text = ""): T {
    if (!this.handle) throw new Error(`Kern-Abfrage „${name}": Dokument nicht offen`);
    const out = core().doc_query_root(this.handle, name, text);
    if (out.startsWith("\u0001")) throw new Error(out.slice(1));
    return fromMarkedJson<T>(out);
  }

  /** Wie {@link commitGrip}, aber nur rechnen (ohne Anwenden): die Ops und ggf. der Hinweis. */
  gripOps(req: object): { ops: CoreOp[]; notice?: string } {
    if (!this.handle) throw new Error("Kern-Abfrage „gripOps“: Dokument nicht offen");
    const out = core().doc_query_root(this.handle, "gripOps", gripJson(req));
    if (out.startsWith("\u0001")) throw new Error(out.slice(1));
    return fromMarkedJson(out);
  }

  /**
   * Ops eines Befehls ([K4] S3, `commands.rs`): `req` = `{cmd, …}` (Zahlen dürfen NaN/±∞ sein), gerechnet
   * auf dem Stand des Dokuments (ohne Anwenden). Nicht endliche Ergebnisse kommen als Zahlen zurück.
   */
  cmdOps(req: object): CoreOp[] {
    if (!this.handle) throw new Error("Kern-Abfrage „cmdOps“: Dokument nicht offen");
    const out = core().doc_query_root(this.handle, "cmdOps", toMarkedJson(req));
    if (out.startsWith("\u0001")) throw new Error(out.slice(1));
    return fromMarkedJson<{ ops: CoreOp[] }>(out).ops;
  }

  /**
   * Befehl rechnen und anwenden ([K4] S3, `doc_cmd_commit`): wie {@link commitGrip} — ein Kern-Aufruf
   * statt Ops hin (Rechnung) und zurück (Commit). Ergebnis: neues Projekt und die angewendeten Ops (leer
   * = nichts zu tun, dann `project === base`) oder die Meldungen der Prüfung.
   */
  commitCmd(base: Project, req: object, coalesceKey: string | undefined, now: number): { project: Project; ops: CoreOp[] } | { problems: string[] } {
    this.ensure(base);
    if (!this.handle) return { problems: ["Projekt-Dokument im Kern nicht offen."] };
    const out = core().doc_cmd_commit(this.handle, toMarkedJson(req), coalesceKey ?? "", now);
    if (out.startsWith("\u0001")) throw new Error(out.slice(1));
    const r = fromMarkedJson<{ ops: CoreOp[] } | { problems: string[] }>(out);
    if ("problems" in r) return r;
    if (r.ops.length === 0) return { project: base, ops: r.ops };
    const project = applyOps(base, r.ops);
    this.mirror = project;
    return { project, ops: r.ops };
  }

  /**
   * Kern-Aufruf, der Ops rechnet und gleich als Benutzer-Änderung anwendet (Importe, [K4] S4): `call`
   * bekommt das Handle und liefert `{ops, …}`, `{problems}` oder einen Fehlertext mit `\u0001` vorn (wirft).
   * Die Leseansicht wird mit den angewendeten Ops nachgeführt; die übrigen Felder kommen unverändert zurück.
   */
  private commitCore<R extends object>(base: Project, call: (h: number) => string): ({ project: Project; ops: CoreOp[] } & R) | { problems: string[] } {
    this.ensure(base);
    if (!this.handle) return { problems: ["Projekt-Dokument im Kern nicht offen."] };
    const out = call(this.handle);
    if (out.startsWith("\u0001")) throw new Error(out.slice(1));
    const r = fromMarkedJson<({ ops: CoreOp[] } & R) | { problems: string[] }>(out);
    if ("problems" in r) return r;
    const project = r.ops.length ? applyOps(base, r.ops) : base;
    this.mirror = project;
    return { ...r, project };
  }

  /**
   * Zeichnungs-Import (DXF/DWG/PDF, [K4] S4): der Kern wandelt die gelesene Datei (`src`, Puffer des
   * Format-Moduls) nach der Entscheidung des Dialogs in Ops (Zeichnungsebene, Kategorien je Layer,
   * Linienstile, 2D-Zeichnungen, Kontext-Meshes) und wendet sie als EINEN Undo-Schritt an.
   */
  importDrawing(base: Project, src: ImportSource, decision: DrawingImportDecision, now: number) {
    return this.commitCore<{ levelId: string; drawings: number; meshes: number }>(base, (h) =>
      core().doc_import_drawing(h, src.geom, JSON.stringify(src.strings), JSON.stringify(src.source), JSON.stringify(decision), "", now),
    );
  }

  /** IFC-Import ([B3]/[B4], [K4] S4): Kontext-Meshes bzw. (`opts.elements`) Bauteile, ein Undo-Schritt. */
  importIfc(base: Project, flat: IfcFlatInput, opts: { fileName: string; group?: string; elements?: boolean }, now: number) {
    return this.commitCore<IfcImportResult>(base, (h) =>
      core().doc_import_ifc(h, flat.meta, flat.positions, flat.indices, flat.elementData ?? new Float64Array(0), JSON.stringify(opts), "", now),
    );
  }

  /** Mesh-Import (OBJ/STL/glTF/PLY, [C11], [K4] S4): Kontext-Meshes, ein Undo-Schritt. */
  importMesh(base: Project, flat: { flat: Float64Array; strings: string[] }, opts: { fileName: string; placement?: string; group?: string }, now: number) {
    return this.commitCore<{ report: MeshImportReport; contextObjects: number }>(base, (h) =>
      core().doc_import_mesh(h, flat.flat, JSON.stringify(flat.strings), JSON.stringify(opts), "", now),
    );
  }

  /** Abfrage eines Befehls zwischen den Schritten (`doc_cmd_query`: Treffer, Vorschau-Formen), JSON-Antwort. */
  cmdQuery<T>(req: object): T {
    if (!this.handle) throw new Error("Kern-Abfrage „cmdQuery“: Dokument nicht offen");
    const out = core().doc_cmd_query(this.handle, toMarkedJson(req));
    if (out.startsWith("\u0001")) throw new Error(out.slice(1));
    return fromMarkedJson<T>(out);
  }

  /** Vorschau-Formen eines Befehls (`doc_cmd_preview`): flach je Form `[art, n, x0, y0, …]`. */
  cmdPreview(req: object): Float64Array {
    return this.handle ? core().doc_cmd_preview(this.handle, toMarkedJson(req)) : new Float64Array(0);
  }

  /** Einen Schritt zurück auf `base` (= aktuelles Projekt); `null` = nichts rückgängig zu machen. */
  undo(base: Project): Project | null {
    return this.jump(base, "doc_undo");
  }

  /** Einen Schritt vor; `null` = nichts wiederherzustellen. */
  redo(base: Project): Project | null {
    return this.jump(base, "doc_redo");
  }

  private jump(base: Project, fn: "doc_undo" | "doc_redo"): Project | null {
    if (base !== this.mirror || !this.handle) {
      this.ensure(base);
      return null;
    }
    const json = core()[fn](this.handle);
    if (!json) return null;
    const project = applyOps(base, JSON.parse(json) as CoreOp[], core().doc_last_hits(this.handle));
    this.mirror = project;
    return project;
  }

  /** Verlaufsstand: Undo-/Redo-Tiefe und geschätzter Speicher (Bytes). */
  historyState(): { undo: number; redo: number; bytes: number } {
    const s = this.handle ? core().doc_history_state(this.handle) : new Float64Array(0);
    return { undo: s[0] ?? 0, redo: s[1] ?? 0, bytes: s[2] ?? 0 };
  }

  clearHistory(): void {
    if (this.handle) core().doc_history_clear(this.handle);
  }

  /** Grenzen des Verlaufs (Schritte, ungefähre Bytes). */
  setHistoryLimits(steps: number, bytes: number): void {
    this.limits = [steps, bytes];
    if (this.handle) core().doc_history_limits(this.handle, steps, bytes);
  }

  /** Gruppe: alle Änderungen bis {@link endGroup} werden ein Undo-Schritt (verschachtelbar). */
  beginGroup(): void {
    if (this.handle) core().doc_group_begin(this.handle);
  }

  /**
   * Wie {@link beginGroup}, mit `coalesceKey` (+ `now` in ms): aufeinanderfolgende Gruppen mit
   * gleichem Schlüssel im Zeitfenster schliessen an denselben Undo-Schritt an (Griff-Zug, der je
   * Mausschritt mehrere Elemente bewegt), [K4] S3.
   */
  beginKeyedGroup(coalesceKey: string, now: number): void {
    if (this.handle) core().doc_group_begin_keyed(this.handle, coalesceKey, now);
  }

  endGroup(): void {
    if (this.handle) core().doc_group_end(this.handle);
  }
}

/** Griff-Anfrage als JSON; Marken nur bei nicht endlichen Zahlen (der Ersetzer kostet je Wert einen Aufruf). */
function gripJson(req: object): string {
  for (const v of Object.values(req)) {
    const bad = typeof v === "number" ? !Number.isFinite(v) : Array.isArray(v) && v.some((x) => typeof x === "number" && !Number.isFinite(x));
    if (bad) return toMarkedJson(req);
  }
  return JSON.stringify(req);
}

let shared: ProjectDocument | null = null;

/**
 * Das gemeinsame Abfrage-Dokument (ohne Verlauf), z. B. für das CLI: eine dort geladene Datei
 * ({@link ProjectDocument.loadFile}) ist sofort das Dokument der Abfragen auf ihrem Projekt.
 */
export function sharedDocument(): ProjectDocument {
  if (!shared) shared = new ProjectDocument({} as Project);
  return shared;
}
/** Dokument des Stores (mit Verlauf); Abfragen auf dessen aktuellem Projekt laufen direkt darüber. */
let primary: ProjectDocument | null = null;

/** Meldet das Dokument des Stores an (s. {@link documentFor}). */
export function setPrimaryDocument(doc: ProjectDocument | null): void {
  primary = doc;
}

/**
 * Das gemeinsame Kern-Dokument, auf den Stand von `project` gebracht. Der Abgleich läuft über die
 * Differenz zum zuletzt gesehenen Projekt (Referenzvergleich, unveränderte Teile kosten nichts);
 * wechselt ein Aufrufer zwischen sehr verschiedenen Projekten, ist es nur langsamer, nie falsch.
 */
export function documentFor(project: Project): ProjectDocument {
  if (primary && primary.current === project && primary.id) return primary;
  if (!shared) shared = new ProjectDocument(project);
  else shared.sync(project);
  return shared;
}

/**
 * Änderung als Befehls-Anfrage an den Kern ([K4] S3, `commands.rs`): `toOps` rechnet die Ops auf dem
 * Dokument des Projekts; der Store wendet `coreReq` direkt im Kern an (`ProjectDocument.commitCmd`).
 */
export function cmdMutation(req: object): ProjectMutation {
  return Object.assign(opsMutation((p) => documentFor(p).cmdOps(req)), { coreReq: req });
}
