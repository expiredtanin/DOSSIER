// Name, der sich an Ort und Stelle umbenennen lässt (Doppelklick oder Stift-Knopf): zeigt Text, beim Bearbeiten ein
// Feld; Enter oder Verlassen übernimmt, Esc verwirft. Statt dauerhafter Textfelder in Listen ([272], Panel „Varianten“).

import { useEffect, useRef, useState } from "react";

export interface InlineNameProps {
  value: string;
  /** Beschriftung des Felds (Screenreader). */
  label: string;
  /** Beschriftung/Tooltip des Stift-Knopfs (z. B. „Umbenennen“). */
  editLabel: string;
  onCommit: (name: string) => void;
  disabled?: boolean;
  testId?: string;
  className?: string;
}

export function InlineName({ value, label, editLabel, onCommit, disabled, testId, className }: InlineNameProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
  const start = () => {
    if (disabled) return;
    setDraft(value);
    setEditing(true);
  };
  const finish = (commit: boolean) => {
    setEditing(false);
    const next = draft.trim();
    if (commit && next && next !== value) onCommit(next);
  };
  if (editing) {
    return (
      <input
        ref={input}
        type="text"
        className={`inline-name-input${className ? ` ${className}` : ""}`}
        value={draft}
        aria-label={label}
        data-testid={testId ? `${testId}-input` : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(true);
          else if (e.key === "Escape") {
            e.stopPropagation();
            finish(false);
          }
        }}
      />
    );
  }
  return (
    <span className={`inline-name${className ? ` ${className}` : ""}`}>
      <span className="inline-name-text" title={value} data-testid={testId} onDoubleClick={start}>
        {value}
      </span>
      {!disabled && (
        <button type="button" className="inline-name-edit" title={editLabel} aria-label={`${editLabel}: ${value}`} data-testid={testId ? `${testId}-edit` : undefined} onClick={start}>
          <span className="material-symbols-outlined" aria-hidden="true">edit</span>
        </button>
      )}
    </span>
  );
}
