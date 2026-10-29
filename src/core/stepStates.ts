// Gemerkte Stände grosser Verlaufsschritte ([K4]): Undo/Redo eines Imports mit 10⁵ Elementen soll
// nicht alle Elemente als JSON aus dem Kern holen und neu parsen. Die Leseansicht ist unveränderlich —
// die Listen vor und nach einem Schritt existieren in TS ohnehin. Für grosse Schritte merkt sich
// `ProjectDocument` je berührtem Projekt-Feld den Wert davor und danach (nur Verweise, keine Kopie),
// unter der Laufnummer des Kern-Schritts (`doc_history_seq`). Ist dieser Schritt oben auf dem Stapel,
// wendet der Kern ihn ohne Ops-Rückgabe an (`doc_jump_quiet`) und TS setzt die Felder zurück.
//
// Exakt, weil der Verlauf linear ist: steht Schritt S oben, ist der Inhalt jedes von S berührten
// Felds gleich dem Stand direkt nach (Undo) bzw. vor (Redo) S; S berührt genau die Felder seiner Ops.
// Unveränderte Elemente behalten ihre Identität — auch die per Redo zurückkehrenden (Plan-/3D-Caches).
import type { Project } from "../model/types";
import type { CoreOp } from "./ops";

/** Ab so vielen berührten Elementen merkt sich TS die Stände (darunter ist der JSON-Weg billig). */
export const BIG_STEP = 1000;

/** Höchstens so viele Schritte gemerkt (die ältesten fallen weg; dann wieder der JSON-Weg). */
const MAX_STEPS = 8;

/** Werte der berührten Felder (fehlender Schlüssel = Feld fehlte). */
type Fields = Record<string, unknown>;

interface StepState {
  keys: string[];
  /** Stand am Undo-Ende des Schritts (vor der Änderung). */
  before: Fields;
  /** Stand am Redo-Ende (nach der Änderung). */
  after: Fields;
}

/** Zahl der Elemente, die die Ops berühren (Mass für „gross"). */
export function opsWeight(ops: readonly CoreOp[]): number {
  let n = 0;
  for (const op of ops) {
    if (op.kind === "add") n += op.items.length;
    else if (op.kind === "remove" || op.kind === "reorder") n += op.ids.length;
    else n += 1;
  }
  return n;
}

function pick(p: Project, keys: readonly string[]): Fields {
  const src = p as unknown as Record<string, unknown>;
  const out: Fields = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  return out;
}

/** Gemerkte Stände je Kern-Schritt (Laufnummer). */
export class StepStates {
  private steps = new Map<number, StepState>();

  /**
   * Schritt `seq` führt zwischen `before` (Undo-Ende) und `after` (Redo-Ende); `ops` = die Ops einer
   * Richtung (bestimmen die Felder). Kleine Schritte werden nicht gemerkt.
   */
  remember(seq: number, before: Project, after: Project, ops: readonly CoreOp[]): void {
    if (!(seq > 0) || opsWeight(ops) < BIG_STEP) return;
    const keys = [...new Set(ops.map((op) => (op.kind === "setField" ? op.key : op.collection)))];
    this.set(seq, { keys, before: pick(before, keys), after: pick(after, keys) });
  }

  has(seq: number): boolean {
    return seq > 0 && this.steps.has(seq);
  }

  /**
   * Schritt `seq` auf `base` anwenden (`toBefore` = Undo) und unter der neuen Laufnummer `next` (der
   * Gegenschritt auf dem anderen Stapel) wieder merken. Liefert das neue Projekt.
   */
  jump(seq: number, base: Project, toBefore: boolean, next: number): Project {
    const s = this.steps.get(seq);
    if (!s) return base;
    this.steps.delete(seq);
    const vals = toBefore ? s.before : s.after;
    const cur = { ...(base as unknown as Record<string, unknown>) };
    for (const k of s.keys) {
      if (Object.prototype.hasOwnProperty.call(vals, k)) cur[k] = vals[k];
      else delete cur[k];
    }
    if (next > 0) this.set(next, s);
    return cur as unknown as Project;
  }

  clear(): void {
    this.steps.clear();
  }

  private set(seq: number, s: StepState): void {
    this.steps.set(seq, s);
    while (this.steps.size > MAX_STEPS) this.steps.delete(this.steps.keys().next().value as number);
  }
}
