// Grafische Overrides — reine Auswertungs-Engine (Regel-Engine, DOSSIER A1).
//
// Wertet die Regelliste `Project.overrideRules` für ein Element aus und
// liefert die effektiven Aktionen (Farbe/Strichstärke/Linienstil). Die Regeln
// werden ADDITIV angewendet: pro Aktions-Feld gewinnt die OBERSTE (erste)
// aktive Regel, deren Bedingung matcht; spätere Regeln füllen nur noch die
// verbleibenden Felder. Deaktivierte Regeln werden übersprungen.
//
// Reines Rendering-Overlay: die Engine kennt weder Project noch Renderer —
// der Aufrufer (plan/generatePlan.ts) baut das Subjekt aus Ebene + Element
// und legt das Ergebnis als oberste Schicht ÜBER die reguläre
// By-Layer/By-Object-Attribut-Auflösung. Elementdaten bleiben unverändert.

import type {
  OverrideActions,
  OverrideCondition,
  OverrideRule,
} from "../model/types";

/**
 * Das Subjekt einer Auswertung — die vergleichbaren Eigenschaften EINES
 * Elements. `layer_name`-Bedingungen matchen gegen Namen ODER Code der Ebene
 * (LayerCategory), `object_name`-Bedingungen gegen den Element-/Typ-Namen.
 */
export interface OverrideSubject {
  /** Name der Ebene (LayerCategory.name) des Elements. */
  layerName?: string;
  /** Code der Ebene (LayerCategory.code / Element.categoryCode). */
  layerCode?: string;
  /** Element-/Typ-Name (z. B. Wandtyp-Name, Raum-Name, Öffnungs-Label). */
  objectName?: string;
}

/** Leere Aktionen (kein Override) — geteilte Konstante für den Schnellpfad. */
export const EMPTY_OVERRIDES: OverrideActions = Object.freeze({});

/** Case-insensitiver Feld-Vergleich eines Operators. */
function matchValue(
  operator: OverrideCondition["operator"],
  candidate: string,
  value: string,
): boolean {
  switch (operator) {
    case "equals":
      return candidate === value;
    case "contains":
      return candidate.includes(value);
    case "starts_with":
      return candidate.startsWith(value);
    case "not_equals":
      return candidate !== value;
  }
}

/**
 * Prüft, ob eine Bedingung auf ein Subjekt zutrifft (case-insensitiv,
 * Wert getrimmt). `layer_name` vergleicht gegen Ebenen-NAME und -CODE:
 * positive Operatoren (equals/contains/starts_with) treffen, wenn EINER der
 * beiden passt; `not_equals` trifft nur, wenn KEINER der beiden gleich ist
 * (sonst würde der Code fast jede Namens-Ungleichheit erfüllen).
 */
export function matchesCondition(
  condition: OverrideCondition,
  subject: OverrideSubject,
): boolean {
  const value = condition.value.trim().toLowerCase();
  const candidates: string[] = [];
  if (condition.type === "layer_name") {
    if (subject.layerName != null) candidates.push(subject.layerName.trim().toLowerCase());
    if (subject.layerCode != null) candidates.push(subject.layerCode.trim().toLowerCase());
  } else {
    if (subject.objectName != null) candidates.push(subject.objectName.trim().toLowerCase());
  }
  if (candidates.length === 0) {
    // Subjekt trägt die Eigenschaft nicht: positive Operatoren können nicht
    // treffen; „ungleich" ist trivial erfüllt.
    return condition.operator === "not_equals";
  }
  if (condition.operator === "not_equals") {
    return candidates.every((c) => c !== value);
  }
  return candidates.some((c) => matchValue(condition.operator, c, value));
}

/**
 * Kollabiert die Regelliste für ein Subjekt zu den effektiven Aktionen.
 * Additiv, oberste Regel gewinnt PRO FELD: die erste aktive, matchende Regel,
 * die ein Feld setzt, bestimmt es; weitere Regeln füllen nur offene Felder.
 * Ohne Treffer (oder ohne Regeln) kommt {@link EMPTY_OVERRIDES} zurück.
 */
export function effectiveOverrides(
  rules: readonly OverrideRule[] | undefined,
  subject: OverrideSubject,
): OverrideActions {
  if (!rules || rules.length === 0) return EMPTY_OVERRIDES;
  let out: OverrideActions | null = null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!matchesCondition(rule.condition, subject)) continue;
    const a = rule.actions;
    if (a.color === undefined && a.lineweight === undefined && a.linetypeId === undefined) {
      continue;
    }
    if (!out) out = {};
    if (out.color === undefined && a.color !== undefined) out.color = a.color;
    if (out.lineweight === undefined && a.lineweight !== undefined) {
      out.lineweight = a.lineweight;
    }
    if (out.linetypeId === undefined && a.linetypeId !== undefined) {
      out.linetypeId = a.linetypeId;
    }
    // Alle Felder belegt → keine weitere Regel kann noch etwas beitragen.
    if (
      out.color !== undefined &&
      out.lineweight !== undefined &&
      out.linetypeId !== undefined
    ) {
      break;
    }
  }
  return out ?? EMPTY_OVERRIDES;
}

/** True, wenn mindestens eine Aktion gesetzt ist (Schnelltest für Aufrufer). */
export function hasOverrides(actions: OverrideActions): boolean {
  return (
    actions.color !== undefined ||
    actions.lineweight !== undefined ||
    actions.linetypeId !== undefined
  );
}
