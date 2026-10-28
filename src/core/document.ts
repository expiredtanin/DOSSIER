// Projekt-Dokument im Rust-Kern ([K4], Stufe S1): spiegelt das TS-Projekt über Ops nach Rust
// (`document.rs`). TS bleibt vorerst Quelle der Änderungen (`setProject` → `diffToOps`); Rust hält
// den Stand, auf dem die Ableitungen später direkt rechnen, ohne dass TS das Projekt je Aufruf
// flach neu sammeln muss. Bei jedem Widerspruch (abgelehnte Ops, Fehler) wird das Dokument aus dem
// vollen Projekt neu geöffnet — der Spiegel heilt sich selbst.

import type { Project } from "../model/types";
import { core } from "../engine/coreWasm";
import { diffToOps } from "./ops";

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
   * Abfrage auf dem typisierten Projekt im Kern. Das Ergebnis ist JSON; ein Fehler (Projekt passt
   * nicht zum Modell, unbekannte Abfrage) wirft.
   */
  query<T>(name: "kennzahlen" | "siteCheck" | "buildingFootprint" | "modelTop" | "shadows" | "slabs" | "columnMeshes" | "walls" | "openingMeshes" | "stairSlabs" | "stairMeshes" | "stairRailings" | "roofMeshes" | "roofCutLayers", args: number[] = []): T {
    const text = this.handle ? core().doc_query_args(this.handle, name, Float64Array.from(args)) : "";
    if (!text) throw new Error(`Kern-Abfrage „${name}": Projekt passt nicht zum Kern-Modell`);
    return JSON.parse(text) as T;
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
