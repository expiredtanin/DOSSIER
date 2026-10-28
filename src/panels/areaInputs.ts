// Eingaben und Hilfen des Flächen-Nachweises im Flächenbilanz-Panel ([70]).

import type { AgfBasis, IvhbOptions } from "../core";

/** Eingaben, die das Modell nicht hergibt; als Text, damit halbfertiges Tippen erhalten bleibt. */
export interface AreaInputs {
  agsf: string;
  greenArea: string;
  agfBasis: AgfBasis;
  includeUnderground: boolean;
}

export const DEFAULT_AREA_INPUTS: AreaInputs = { agsf: "", greenArea: "", agfBasis: "ngf", includeUnderground: false };

/** Zahl aus einer Eingabe (Komma oder Punkt); leer/ungültig/negativ → undefined. */
export function parseAreaNumber(text: string): number | undefined {
  const s = text.trim().replace(",", ".");
  if (s === "") return undefined;
  const v = Number(s);
  return Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Eingaben → Optionen für den Kern. */
export function ivhbOptionsOf(i: AreaInputs): IvhbOptions {
  return { agsf: parseAreaNumber(i.agsf), greenArea: parseAreaNumber(i.greenArea), agfBasis: i.agfBasis, includeUnderground: i.includeUnderground };
}
