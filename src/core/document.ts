// Projekt-Dokument im Rust-Kern ([K4], Stufe S1; S3: Prüfung und Undo/Redo im Kern, s. `commit`).
// Spiegelt das TS-Projekt über Ops nach Rust (`document.rs`). Befehle liefern vorerst noch
// Projekt → Projekt (`setProject` → `diffToOps`); Rust hält
// den Stand, auf dem die Ableitungen später direkt rechnen, ohne dass TS das Projekt je Aufruf
// flach neu sammeln muss. Bei jedem Widerspruch (abgelehnte Ops, Fehler) wird das Dokument aus dem
// vollen Projekt neu geöffnet — der Spiegel heilt sich selbst.

import type { Project } from "../model/types";
import { core } from "../engine/coreWasm";
import { applyOps, diffToOps, opsToJson } from "./ops";
import type { CoreOp } from "./ops";

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
  | "modelJson";

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

  /** Bringt das Dokument auf den Stand `next` (über die Differenz als Ops). */
  sync(next: Project): void {
    if (next === this.mirror) return;
    const ops = diffToOps(this.mirror, next);
    this.mirror = next;
    if (ops.length === 0) return;
    if (!this.handle) {
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
   * Abfrage mit binärer Antwort (`queries.rs::run_bin`, z. B. `planDomains` als Plan-Puffer v2,
   * s. `plan/planBuf.ts`). Fehler kommen als Fehlerpuffer (`decodePlanBuf` wirft die Meldung).
   */
  queryBin(name: QueryName, args: number[] = [], text = ""): Uint8Array {
    if (!this.handle) throw new Error(`Kern-Abfrage „${name}": Dokument nicht offen`);
    return core().doc_query_bin(this.handle, name, Float64Array.from(args), text);
  }

  /** Datei-Text des Projekts (Formatversion vorn, Einrückung 2). */
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
   * geändert (Laden in Tests, fremder Stand), passt der Verlauf nicht mehr: er wird geleert.
   */
  private ensure(base: Project): void {
    if (base === this.mirror && this.handle) return;
    this.sync(base);
    if (!this.handle) this.reopen(base);
    if (this.handle) core().doc_history_clear(this.handle);
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
    const project = applyOps(base, ops);
    this.mirror = project;
    return { project };
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
    const project = applyOps(base, JSON.parse(json) as CoreOp[]);
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

let shared: ProjectDocument | null = null;
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
