// Körper-Booleans des Rust-Kerns ([107] Schritt 2, `src-tauri/core/src/solid_bool.rs`, Manifold-Port
// `manifold-rust`, exakter Modus): synchron, Netze als flache Positionen/Indizes (Modell-Meter).
// Ungültige Eingaben (offen, nicht endlich, Volumen 0, zu viele Dreiecke) ergeben `null` statt einer
// Ausnahme; innen nach aussen gedrehte Körper werden gedreht.

import { core } from "../engine/coreWasm";

export interface SolidMesh {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}

export type SolidOp = "union" | "difference" | "intersection";

const OPS: Record<SolidOp, number> = { union: 0, difference: 1, intersection: 2 };

function encode(m: SolidMesh): Float64Array {
  const nv = Math.floor(m.positions.length / 3);
  const nt = Math.floor(m.indices.length / 3);
  const out = new Float64Array(2 + nv * 3 + nt * 3);
  out[0] = nv;
  for (let i = 0; i < nv * 3; i++) out[1 + i] = m.positions[i];
  out[1 + nv * 3] = nt;
  for (let i = 0; i < nt * 3; i++) out[2 + nv * 3 + i] = m.indices[i];
  return out;
}

/** `a op b`; `null` bei ungültiger Eingabe. Ein leeres Ergebnis (z. B. Schnitt ohne Überdeckung) hat
 *  leere Listen. */
export function solidBoolean(a: SolidMesh, b: SolidMesh, op: SolidOp): { positions: Float64Array; indices: Uint32Array } | null {
  const r = core().solid_boolean(OPS[op], encode(a), encode(b));
  if (r.length < 2) return null;
  const nv = r[0];
  const positions = r.slice(1, 1 + nv * 3);
  const nt = r[1 + nv * 3];
  const indices = Uint32Array.from(r.subarray(2 + nv * 3, 2 + nv * 3 + nt * 3));
  return { positions, indices };
}
