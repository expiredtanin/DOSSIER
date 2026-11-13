/**
 * Teil-Updates des 3D-Modells für render3d ([58], `web::set_parts`): merkt, welche Teile der Viewer schon
 * hat, und schreibt nur neue, geänderte und entfernte Teile als JSON. Unveränderliche Teile (`fixed`,
 * Wand-/Öffnungs-Einträge und [214] übrige Gruppen wie Decken, Dächer, Kontext des Kern-Caches mit Laufnummer
 * in der id) reisen genau einmal; übrige Teile (Dach-/Deckenfenster) werden über ihren JSON-Text verglichen.
 */

import type { Model3dPart } from "../core";

/** Ergebnis von {@link Model3dPartsSync.diff}: JSON für `set_parts` und Zahlen für Messung/Tests. */
export interface PartsDiff {
  json: string;
  upserted: number;
  removed: number;
  reset: boolean;
}

export class Model3dPartsSync {
  /** id → JSON-Text des Inhalts (Rest-Gruppen) bzw. `true` (unveränderlich). */
  private sent: Map<string, string | true> | null = null;

  /** Vergessen, was der Viewer hat (neuer Renderer, Vollaufbau über `set_model`): nächstes Mal `reset`. */
  reset(): void {
    this.sent = null;
  }

  /** Änderung gegenüber dem zuletzt Geschickten; `null`, wenn sich nichts geändert hat. */
  diff(parts: Model3dPart[]): PartsDiff | null {
    const reset = this.sent === null;
    const prev = this.sent ?? new Map<string, string | true>();
    const next = new Map<string, string | true>();
    const upserts: string[] = [];
    for (const p of parts) {
      if (next.has(p.id)) continue;
      const { id, fixed, ...content } = p;
      if (fixed) {
        next.set(id, true);
        if (prev.get(id) !== true) upserts.push(withId(id, JSON.stringify(content)));
      } else {
        const body = JSON.stringify(content);
        next.set(id, body);
        if (prev.get(id) !== body) upserts.push(withId(id, body));
      }
    }
    const removed: string[] = [];
    if (!reset) for (const id of prev.keys()) if (!next.has(id)) removed.push(id);
    this.sent = next;
    if (!reset && upserts.length === 0 && removed.length === 0) return null;
    const json = `{"reset":${reset},"remove":${JSON.stringify(removed)},"upsert":[${upserts.join(",")}]}`;
    return { json, upserted: upserts.length, removed: removed.length, reset };
  }
}

/** `{"id":…, …Inhalt}` aus dem JSON-Text des Inhalts (ein Objekt). */
function withId(id: string, body: string): string {
  return body === "{}" ? `{"id":${JSON.stringify(id)}}` : `{"id":${JSON.stringify(id)},${body.slice(1)}`;
}
