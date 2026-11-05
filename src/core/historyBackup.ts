// Kopie des Undo/Redo-Verlaufs über einen Kern-Neustart ([118]): Der Verlauf lebt im Rust-Dokument und
// wäre nach einem Panic mit der alten WASM-Instanz weg. `ProjectDocument` gleicht diese Kopie nach jeder
// angenommenen Änderung (und Undo/Redo) ab: der Kern liefert die Laufnummern beider Stapel
// (`doc_history_index`), TS holt nur die Schritte, die es noch nicht kennt (`doc_history_step`, JSON je
// Schritt, unverändert gehalten). Nach dem Neustart setzt `restore` sie in das frisch geöffnete Dokument ein
// (`doc_history_import`) — aber nur, wenn die Kopie zur Leseansicht gehört, aus der das Dokument neu
// geöffnet wurde. Eine Änderung, deren Aufruf den Panic auslöste, war nie angenommen: weder in der
// Leseansicht noch im Verlauf, sie wird also nicht wiederholt.
//
// Speicher: nur Schritte, die der Kern selbst noch hält (gleiche Grenzen wie dort); einzelne Schritte über
// MAX_STEP_BYTES und die ältesten über MAX_TOTAL_CHARS werden nicht kopiert — der Verlauf endet dann dort
// (Undo bis vor den fehlenden Schritt, Redo ebenso).
import { core } from "../engine/coreWasm";

/** Grösster kopierter Schritt (geschätzter Speicher im Kern, Bytes); grössere: Verlauf endet dort. */
export const MAX_STEP_BYTES = 8 << 20;
/** Höchstens so viele Zeichen JSON insgesamt; darüber fallen die ältesten Undo-Schritte weg. */
export const MAX_TOTAL_CHARS = 64 << 20;

interface HistoryIndex {
  undo: number[];
  redo: number[];
  lastKey: string | null;
  lastAt: number;
}

export class HistoryBackup {
  /** Leseansicht, zu der die Kopie gehört (Identität). */
  private at: object | null = null;
  private index: HistoryIndex | null = null;
  /** JSON je Laufnummer; `null` = nicht kopiert (zu gross). */
  private steps = new Map<number, string | null>();
  private chars = 0;

  /** Kopie an den Verlauf von Dokument `handle` angleichen; `mirror` = dessen Leseansicht. */
  sync(handle: number, mirror: object): void {
    const json = handle ? core().doc_history_index(handle) : "";
    if (!json) return this.clear();
    const index = JSON.parse(json) as HistoryIndex;
    const live = new Set([...index.undo, ...index.redo]);
    for (const [seq, s] of this.steps)
      if (!live.has(seq)) {
        this.chars -= s?.length ?? 0;
        this.steps.delete(seq);
      }
    for (const seq of live)
      if (!this.steps.has(seq)) {
        const s = core().doc_history_step(handle, seq, MAX_STEP_BYTES) || null;
        this.chars += s?.length ?? 0;
        this.steps.set(seq, s);
      }
    for (const seq of index.undo) {
      if (this.chars <= MAX_TOTAL_CHARS) break;
      this.chars -= this.steps.get(seq)?.length ?? 0;
      this.steps.set(seq, null);
    }
    this.index = index;
    this.at = mirror;
  }

  /**
   * Nach dem Neustart: Verlauf in Dokument `handle` einsetzen, wenn die Kopie zu `mirror` gehört (das
   * Dokument wurde aus `mirror` geöffnet). `true` = eingesetzt (oder nichts einzusetzen).
   */
  restore(handle: number, mirror: object): boolean {
    const index = this.index;
    const ok = !index || (this.at === mirror && handle !== 0 && core().doc_history_import(handle, this.importJson(index)));
    this.clear();
    if (ok) this.sync(handle, mirror); // neue Laufnummern
    return ok;
  }

  clear(): void {
    this.at = null;
    this.index = null;
    this.steps.clear();
    this.chars = 0;
  }

  /** Stapel bis zum jüngsten fehlenden Schritt abgeschnitten (über ihn führt kein Undo/Redo). */
  private importJson(index: HistoryIndex): string {
    const stack = (seqs: number[]) => {
      let from = 0;
      seqs.forEach((s, i) => {
        if (!this.steps.get(s)) from = i + 1;
      });
      return seqs.slice(from).map((s) => this.steps.get(s) as string);
    };
    return `{"undo":[${stack(index.undo).join(",")}],"redo":[${stack(index.redo).join(",")}],"lastKey":${JSON.stringify(index.lastKey)},"lastAt":${JSON.stringify(index.lastAt)}}`;
  }
}
