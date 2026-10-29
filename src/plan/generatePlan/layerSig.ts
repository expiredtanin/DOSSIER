// Signatur der STILRELEVANTEN Ebenen-Eigenschaften (Farbe, Strichstärke,
// Schraffur, Code). Die
// GPU-Chunks der Unterlage hängen davon ab — NICHT von `visible`/`locked`/`name`.
// Mit der Array-Referenz als Schlüssel galt jedes Ein-/Ausblenden einer Ebene als
// "Stil geändert": bei einem Kataster-Import wurde dadurch alles neu erzeugt.

import type { LayerCategory } from "../../model/types";
import { flattenCategories } from "../../model/types";

const sigCache = new WeakMap<LayerCategory[], string>();
/** Identische Signaturen teilen sich dasselbe String-Objekt → `===` ist ein Zeigervergleich. */
const interned = new Map<string, string>();

export function layersStyleSig(layers: LayerCategory[]): string {
  let sig = sigCache.get(layers);
  if (sig !== undefined) return sig;
  const raw = flattenCategories(layers)
    .map((c) => `${c.code}|${c.color}|${c.lw}|${c.hatch ?? ""}`)
    .join(";");
  if (interned.size > 64) interned.clear();
  sig = interned.get(raw);
  if (sig === undefined) {
    interned.set(raw, raw);
    sig = raw;
  }
  sigCache.set(layers, sig);
  return sig;
}
