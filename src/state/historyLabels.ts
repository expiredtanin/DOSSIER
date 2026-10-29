// Beschriftungen der Undo-Schritte ([84]). Der Kern speichert je Schritt einen kurzen Text: einen
// i18n-Schlüssel (`history.…`, Sprache folgt der Oberfläche), `history.op.<art>:<liste>` (aus den Ops
// abgeleitet) oder freien Text; leer = Standard.

import { t } from "../i18n";
import type { CoreOp } from "../core/ops";

/** Beschriftung aus den Ops (erste Op), wenn der Aufrufer keine setzt: `history.op.<art>:<liste>`. */
export function opsLabel(ops: readonly CoreOp[]): string {
  const op = ops[0];
  if (!op) return "";
  return op.kind === "setField" ? `history.op.setField:${op.key}` : `history.op.${op.kind}:${op.collection}`;
}

/** Anzeigetext eines Schritts in der aktuellen Sprache. */
export function historyLabelText(label: string): string {
  if (!label) return t("history.step.generic");
  if (!label.startsWith("history.")) return label;
  const [key, arg] = label.split(":", 2);
  if (arg !== undefined) {
    const coll = t(`history.coll.${arg}`);
    return t(key!, { what: coll === `history.coll.${arg}` ? arg : coll });
  }
  const text = t(key!);
  return text === key ? t("history.step.generic") : text;
}
