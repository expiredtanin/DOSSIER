// Projekt-Dokument im Rust-Kern ([K4], Stufe S1): spiegelt das TS-Projekt über Ops nach Rust
// (`document.rs`). TS bleibt vorerst Quelle der Änderungen (`setProject` → `diffToOps`); Rust hält
// den Stand, auf dem die Ableitungen später direkt rechnen, ohne dass TS das Projekt je Aufruf
// flach neu sammeln muss. Bei jedem Widerspruch (abgelehnte Ops, Fehler) wird das Dokument aus dem
// vollen Projekt neu geöffnet — der Spiegel heilt sich selbst.

import type { Project } from "../model/types";
import { core } from "../engine/coreWasm";
import { diffToOps } from "./ops";

/** Abfragen des Kerns (`queries.rs`). */
export type QueryName =
  | "kennzahlen"
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
  | "planDomains";

export class ProjectDocument {
  private handle = 0;
  private mirror: Project;

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
}

let shared: ProjectDocument | null = null;

/**
 * Das gemeinsame Kern-Dokument, auf den Stand von `project` gebracht. Der Abgleich läuft über die
 * Differenz zum zuletzt gesehenen Projekt (Referenzvergleich, unveränderte Teile kosten nichts);
 * wechselt ein Aufrufer zwischen sehr verschiedenen Projekten, ist es nur langsamer, nie falsch.
 */
export function documentFor(project: Project): ProjectDocument {
  if (!shared) shared = new ProjectDocument(project);
  else shared.sync(project);
  return shared;
}
