// Kanten und Höfe eines Dachs ([26]): die Kantenliste fürs Objekt-Info (Neigung je Kante, Giebel),
// Änderungen als Teilobjekt (`Partial<Roof>`, für `updateRoof`/`patchItem` — ein Undo-Schritt) und
// die Prüfung, ob ein Hof wirkt. Die Geometrie selbst rechnet der Rust-Kern (`roof.rs`).
//
// Kantennummerierung wie `Roof.edgePitchDeg`: erst die Kanten von `outline` (Kante i = Punkt i →
// i+1), dann die der `holes` Ring für Ring. Eintrag `null` = Giebel, Zahl ≥ 0 = Neigung, negativ
// (oder fehlend) = Standard.

import type { Roof, Vec2 } from "../model/types";
import { roofGeometry } from "./roof";

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

/** Die Vorgabe aus einem Eintrag von `edgePitchDeg`. */
function specOf(v: number | null | undefined): EdgeSpec {
  if (v === null) return { kind: "gable" };
  if (v === undefined || !Number.isFinite(v) || v < 0) return { kind: "default" };
  return { kind: "pitch", deg: v };
}

/** Giebelt der Standard dieser Dachform die Kante a→b (quer zur Firstrichtung)? */
function defaultGableEdge(roof: Roof, a: Vec2, b: Vec2): boolean {
  const gabled = roof.shape === "sattel" || (roof.shape === "mansarde" && (roof.mansardType ?? "giebel") === "giebel");
  if (!gabled) return false;
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  return roof.ridgeAxis === "y" ? dy < dx : dx < dy;
}

/** Alle Kanten des Dachs (Umriss, dann Höfe) mit ihrer Vorgabe. */
export function roofEdgeList(roof: Roof): RoofEdge[] {
  const rings: Vec2[][] = [roof.outline, ...(roof.holes ?? [])];
  const out: RoofEdge[] = [];
  let index = 0;
  rings.forEach((ring, r) => {
    ring.forEach((a, edge) => {
      const b = ring[(edge + 1) % ring.length];
      out.push({
        index,
        ring: r,
        edge,
        a,
        b,
        length: Math.hypot(b.x - a.x, b.y - a.y),
        spec: specOf(roof.edgePitchDeg?.[index]),
        defaultGable: defaultGableEdge(roof, a, b),
      });
      index++;
    });
  });
  return out;
}

/** `edgePitchDeg` ohne Standard-Einträge am Ende; alles Standard ⇒ `undefined` (Feld entfällt). */
function normalized(values: (number | null)[]): (number | null)[] | undefined {
  const v = values.slice();
  while (v.length > 0 && v[v.length - 1] !== null && (v[v.length - 1] as number) < 0) v.pop();
  return v.length === 0 ? undefined : v;
}

/** Teilobjekt für `updateRoof`: Kante `index` auf `spec` setzen. */
export function setRoofEdge(roof: Roof, index: number, spec: EdgeSpec): Pick<Roof, "edgePitchDeg"> {
  const total = roofEdgeList(roof).length;
  const values: (number | null)[] = Array.from({ length: total }, (_, i) => {
    const v = roof.edgePitchDeg?.[i];
    return v === undefined ? -1 : v;
  });
  if (index < 0 || index >= total) return { edgePitchDeg: roof.edgePitchDeg };
  values[index] = spec.kind === "gable" ? null : spec.kind === "pitch" ? Math.max(0, Math.min(MAX_PITCH, spec.deg)) : -1;
  return { edgePitchDeg: normalized(values) };
}

/** Wirkt ein Hof `ring` an diesem Dach? Der Kern verwirft Höfe, die nicht ganz im Umriss liegen, sich
 *  schneiden oder bei einer Dachform ohne Höfe (Pult) — dann liefert er keinen Hof-Traufring. */
export function roofHoleWorks(roof: Roof, ring: Vec2[]): boolean {
  if (ring.length < 3) return false;
  const probe: Roof = { ...roof, holes: [...(roof.holes ?? []), ring] };
  return roofGeometry(probe, 0).eavesHoles.length === (probe.holes?.length ?? 0);
}

/** Teilobjekt für `updateRoof`: Hof anhängen (seine Kanten folgen mit Standard-Neigung). */
export function addRoofHole(roof: Roof, ring: Vec2[]): Pick<Roof, "holes"> {
  return { holes: [...(roof.holes ?? []), ring.map((p) => ({ x: p.x, y: p.y }))] };
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
