// Kanten und Höfe eines Dachs ([26]): Typen der Kantenliste (gerechnet im Kern, `selection_info.rs`),
// Änderungen als Teilobjekt (`Partial<Roof>`, für `updateRoof`/`patchItem` — ein Undo-Schritt). Höfe
// legt der Befehl im Kern an (`cmd_solid.rs`, samt Prüfung am Skelett); die Geometrie rechnet `roof.rs`.
//
// Kantennummerierung wie `Roof.edgePitchDeg`: erst die Kanten von `outline` (Kante i = Punkt i →
// i+1), dann die der `holes` Ring für Ring. Eintrag `null` = Giebel, Zahl ≥ 0 = Neigung, negativ
// (oder fehlend) = Standard.

import type { Roof, Vec2 } from "../model/types";

/** Vorgabe einer Kante. */
export type EdgeSpec = { kind: "default" } | { kind: "gable" } | { kind: "pitch"; deg: number };

/** Eine Kante der Kantenliste (Umriss oder Hof). */
export interface RoofEdge {
  /** Index in `edgePitchDeg`. */
  index: number;
  /** 0 = Umriss, 1.. = Hof (1-basiert). */
  ring: number;
  /** Index der Kante im eigenen Ring. */
  edge: number;
  a: Vec2;
  b: Vec2;
  /** Länge der Kante (Meter). */
  length: number;
  spec: EdgeSpec;
  /** Standard ist hier ein Giebel (Satteldach/Mansard-Satteldach, Kante quer zum First). */
  defaultGable: boolean;
}

const MAX_PITCH = 89;

/** `edgePitchDeg` ohne Standard-Einträge am Ende; alles Standard ⇒ `undefined` (Feld entfällt). */
function normalized(values: (number | null)[]): (number | null)[] | undefined {
  const v = values.slice();
  while (v.length > 0 && v[v.length - 1] !== null && (v[v.length - 1] as number) < 0) v.pop();
  return v.length === 0 ? undefined : v;
}

/** Teilobjekt für `updateRoof`: Kante `index` auf `spec` setzen. */
export function setRoofEdge(roof: Roof, index: number, spec: EdgeSpec): Pick<Roof, "edgePitchDeg"> {
  const total = roof.outline.length + (roof.holes ?? []).reduce((n, h) => n + h.length, 0);
  const values: (number | null)[] = Array.from({ length: total }, (_, i) => {
    const v = roof.edgePitchDeg?.[i];
    return v === undefined ? -1 : v;
  });
  if (index < 0 || index >= total) return { edgePitchDeg: roof.edgePitchDeg };
  values[index] = spec.kind === "gable" ? null : spec.kind === "pitch" ? Math.max(0, Math.min(MAX_PITCH, spec.deg)) : -1;
  return { edgePitchDeg: normalized(values) };
}

/** Teilobjekt für `updateRoof`: Hof `k` entfernen samt seinen Kantenneigungen. */
export function removeRoofHole(roof: Roof, k: number): Pick<Roof, "holes" | "edgePitchDeg"> {
  const holes = roof.holes ?? [];
  if (k < 0 || k >= holes.length) return { holes: roof.holes, edgePitchDeg: roof.edgePitchDeg };
  let from = roof.outline.length;
  for (let i = 0; i < k; i++) from += holes[i].length;
  const to = from + holes[k].length;
  const rest = holes.filter((_, i) => i !== k);
  const edges = roof.edgePitchDeg ? [...roof.edgePitchDeg.slice(0, from), ...roof.edgePitchDeg.slice(to)] : undefined;
  return { holes: rest.length > 0 ? rest : undefined, edgePitchDeg: edges ? normalized(edges) : undefined };
}
