// Modusleiste der aktiven Transformation (Bewegen/Spiegeln/Drehen), im Stil von
// Vectorworks. Zeigt die Operation, die Vervielfältigungs-Modi U/I/O/P und einen
// kontextuellen Klick-Hinweis. Tasten U/I/O/P schalten die Modi (in App); ein
// Klick auf die Schaltflächen tut dasselbe. Rein gesteuert (controlled).

import { t } from "../i18n";
import type { CopyMode, TransformOp } from "../tools/transform";

const MODES: { key: string; mode: CopyMode; labelKey: string }[] = [
  { key: "U", mode: "move", labelKey: "transform.mode.move" },
  { key: "I", mode: "copy", labelKey: "transform.mode.copy" },
  { key: "O", mode: "array", labelKey: "transform.mode.array" },
  { key: "P", mode: "distribute", labelKey: "transform.mode.distribute" },
];

/** Kontextueller Hinweis je Operation + Anzahl bereits gesetzter Punkte. */
function hintKey(op: TransformOp, pointsLen: number): string {
  return `transform.hint.${op}.${Math.min(pointsLen, op === "rotate" ? 2 : 1)}`;
}

export function TransformBar({
  op,
  copyMode,
  count,
  pointsLen,
  onMode,
  onCancel,
}: {
  op: TransformOp;
  copyMode: CopyMode;
  count: number;
  pointsLen: number;
  onMode: (mode: CopyMode) => void;
  onCancel: () => void;
}) {
  return (
    <div className="transform-bar" role="group" aria-label={t("transform.bar")}>
      <span className="tf-op">{t(`transform.${op}`)}</span>
      <span className="tf-sep" />
      <div className="tf-modes">
        {MODES.map((m) => (
          <button
            key={m.mode}
            className={`tf-mode${copyMode === m.mode ? " active" : ""}`}
            onClick={() => onMode(m.mode)}
            title={t(m.labelKey)}
          >
            <span className="tf-key">{m.key}</span>
            <span className="tf-mode-label">
              {t(m.labelKey)}
              {(m.mode === "array" || m.mode === "distribute") && copyMode === m.mode
                ? ` ×${count}`
                : ""}
            </span>
          </button>
        ))}
      </div>
      <span className="tf-sep" />
      <span className="tf-hint">{t(hintKey(op, pointsLen))}</span>
      <button className="tf-cancel" onClick={onCancel} title={t("transform.cancel")}>
        ✕
      </button>
    </div>
  );
}
