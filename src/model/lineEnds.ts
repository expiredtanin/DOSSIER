// Linienenden und -ecken ([146]): eine Projekt-Einstellung (`Project.lineCap`/`lineJoin`) für alle
// Ausgabewege. Über die WASM-Grenze als Zahl `cap | join << 2` (Kern `plan/line_ends.rs`);
// 0 = flach + Gehrung (Standard, auch wenn die Felder fehlen).

import type { LineCap, LineJoin, Project } from "./types";

const CAPS: readonly LineCap[] = ["butt", "round", "square"];
const JOINS: readonly LineJoin[] = ["miter", "round", "bevel"];

/** Gehrungsgrenze wie SVG `stroke-miterlimit` (darüber gefast). */
export const MITER_LIMIT = 4;

export interface LineEnds {
  cap: LineCap;
  join: LineJoin;
}

export function lineEndsOf(p: Pick<Project, "lineCap" | "lineJoin">): LineEnds {
  return {
    cap: p.lineCap && CAPS.includes(p.lineCap) ? p.lineCap : "butt",
    join: p.lineJoin && JOINS.includes(p.lineJoin) ? p.lineJoin : "miter",
  };
}

/** Kodierung `cap | join << 2` für die Kern-Bindungen. */
export function lineEndsCode(p: Pick<Project, "lineCap" | "lineJoin">): number {
  const e = lineEndsOf(p);
  return CAPS.indexOf(e.cap) | (JOINS.indexOf(e.join) << 2);
}

/** Umkehrung von {@link lineEndsCode}; Unsinn → Standard. */
export function lineEndsFromCode(code: number | undefined): LineEnds {
  const c = Number.isInteger(code) && code! >= 0 && code! < 16 ? code! : 0;
  return { cap: CAPS[c & 3] ?? "butt", join: JOINS[(c >> 2) & 3] ?? "miter" };
}

/** SVG-Attribute (Name → Wert) für ein umschliessendes Element; Kinder erben sie. */
export function lineEndsSvgAttrs(code: number | undefined): Record<"stroke-linecap" | "stroke-linejoin" | "stroke-miterlimit", string> {
  const e = lineEndsFromCode(code);
  return { "stroke-linecap": e.cap, "stroke-linejoin": e.join, "stroke-miterlimit": String(MITER_LIMIT) };
}

/** Wie {@link lineEndsSvgAttrs} als React-SVG-Eigenschaften (PlanView-Gruppe der Plan-Striche). */
export function planLineEndsProps(code: number | undefined): { strokeLinecap: LineCap; strokeLinejoin: LineJoin; strokeMiterlimit: number } {
  const e = lineEndsFromCode(code);
  return { strokeLinecap: e.cap, strokeLinejoin: e.join, strokeMiterlimit: MITER_LIMIT };
}
