// Command-Line-UI (docs/design/rhino-command-system.md §3.2) — sitzt ÜBER der
// Statusleiste. Drei Rollen gleichzeitig (§2.1): Prompt-Text (links), klickbare
// Inline-Optionen, Texteingabe; darüber ein Autocomplete-Dropdown.
//
// Rein gesteuert: alle Aktionen laufen über Callbacks an die Engine. Tab (global
// in App) fokussiert das Eingabefeld. Bezeichner englisch, sichtbarer Text via t().

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";

export interface CommandLineOption {
  id: string;
  labelKey: string;
  value?: string;
  /** Aktuell gewählte Option (hervorgehoben)? */
  active?: boolean;
  /** Tastatur-Kürzel (z. B. „U"), wirkt AUCH bei fokussiertem Eingabefeld. */
  key?: string;
}

/** Ein Zahlenfeld des Tab-Feld-Zyklus (§2.7). */
export interface CommandLineField {
  id: string;
  labelKey: string;
  /** Gelockter ODER live (maus-folgender) Wert; null = (noch) keiner. */
  value: number | null;
  /** Ist der Wert gelockt (getippt) statt live (folgt der Maus)? */
  locked: boolean;
  /** Aktuelles Tab-Ziel? */
  active: boolean;
}

export interface CommandLineProps {
  /** Läuft gerade ein Befehl? (steuert den Ruhetext.) */
  active: boolean;
  /** Aktueller Prompt-Key (i18n) oder null im Ruhezustand. */
  promptKey: string | null;
  /** Inline-Optionen des aktuellen Schritts. */
  options: CommandLineOption[];
  /** Geordnete Zahlenfelder des aktuellen Schritts (Tab-Feld-Zyklus). */
  fields: CommandLineField[];
  /** Enter mit dem aktuellen Eingabetext (Befehl/Koordinate/Zahl). */
  onSubmit: (text: string) => void;
  /** Klick auf eine Inline-Option. */
  onOption: (id: string) => void;
  /** Tab im Feld-Modus: nächstes Feld aktivieren. */
  onCycleField: () => void;
  /** Esc: laufenden Befehl abbrechen. */
  onCancel: () => void;
  /**
   * Live-Echo des Eingabetexts (bei jeder Änderung, inkl. Leeren nach Submit/
   * Esc) — speist das Cursor-HUD, das den getippten Wert im aktiven Feld
   * spiegelt (VW-Verhalten: tippen → Wert erscheint oben UND unten).
   */
  onTextChange?: (text: string) => void;
  /** Autocomplete-Kandidaten für ein Präfix (nur im Ruhezustand sinnvoll). */
  suggest: (prefix: string) => string[];
}

export interface CommandLineHandle {
  /** Fokussiert (und öffnet) das Eingabefeld — vom globalen Tab-Handler genutzt. */
  focus: () => void;
  /**
   * Startet die Zahleneingabe mit einem ersten Zeichen (globales Tippen beim
   * Zeichnen, ohne dass das Feld fokussiert war): fokussiert + setzt den Text.
   */
  beginTyping: (seed: string) => void;
}

export const CommandLine = forwardRef<CommandLineHandle, CommandLineProps>(
  function CommandLine(
    { active, promptKey, options, fields, onSubmit, onOption, onCycleField, onCancel, suggest, onTextChange },
    ref,
  ) {
    const [text, setTextRaw] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    // Jede Textänderung (auch programmatisch/Leeren) ans Live-Echo melden.
    const setText = (v: string) => {
      setTextRaw(v);
      onTextChange?.(v);
    };

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      beginTyping: (seed: string) => {
        setText(seed);
        inputRef.current?.focus();
      },
    }));

    // Autocomplete nur im Ruhezustand (Befehlsname tippen), nicht in einem Schritt.
    const suggestions = !active && text.trim() !== "" ? suggest(text).slice(0, 6) : [];
    const hasFields = fields.length > 0;

    const submit = (value: string) => {
      onSubmit(value);
      setText("");
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Options-Kürzel (z. B. U/I/O/P der Kopiermodi): auch bei fokussiertem Feld
      // aktiv. Ein einzelner Buchstabe, der einer Option zugeordnet ist, löst die
      // Option aus statt in die Zahleneingabe zu fallen (Ziffern bleiben Eingabe).
      if (
        active &&
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        const opt = options.find(
          (o) => o.key && o.key.toLowerCase() === e.key.toLowerCase(),
        );
        if (opt) {
          e.preventDefault();
          onOption(opt.id);
          return;
        }
      }
      // Tasten NICHT zum globalen App-Handler durchreichen (eigener Eingabefokus).
      if (e.key === "Enter") {
        e.preventDefault();
        submit(text);
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (active) onCancel();
        setText("");
        inputRef.current?.blur();
      } else if (e.key === "Tab") {
        if (hasFields) {
          // Feld-Modus (§2.7): Tab zyklt die Felder. Steht eine getippte Zahl im
          // Feld, wird sie zuerst ins aktive Feld gelockt (das rückt selbst vor),
          // sonst nur zum nächsten Feld weiterschalten.
          e.preventDefault();
          if (text.trim() !== "") submit(text);
          else onCycleField();
        } else if (suggestions.length > 0) {
          // Ruhezustand: Tab akzeptiert den ersten Autocomplete-Vorschlag.
          e.preventDefault();
          setText(suggestions[0]);
        }
      }
    };

    const promptText = promptKey
      ? t(promptKey as TranslationKey)
      : t("cmd.idle.prompt");

    return (
      <div className="cmdline" role="group" aria-label={t("cmd.aria")}>
        {suggestions.length > 0 && (
          <ul className="cmdline-suggest" role="listbox">
            {suggestions.map((s) => (
              <li
                key={s}
                role="option"
                aria-selected="false"
                className="cmdline-suggest-item"
                onMouseDown={(e) => {
                  // mousedown (vor blur), damit der Klick nicht den Fokus verliert.
                  e.preventDefault();
                  submit(s);
                }}
              >
                {s}
              </li>
            ))}
          </ul>
        )}
        <span className="cmdline-prompt">{promptText}</span>
        {options.length > 0 && (
          <span className="cmdline-options">
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`cmdline-option${o.active ? " active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onOption(o.id);
                }}
              >
                {o.key && <span className="cmdline-option-key">{o.key}</span>}
                {t(o.labelKey as TranslationKey)}
                {o.value != null && <span className="cmdline-option-val">={o.value}</span>}
              </button>
            ))}
          </span>
        )}
        {hasFields && (
          <span className="cmdline-fields">
            {fields.map((f) => {
              // Winkelfeld in Grad, sonst Längen in Metern. Gelockte Werte fest
              // (mehr Nachkommastellen), live (maus-folgende) Werte gerundet.
              const isAngle = f.id === "angle";
              const digits = isAngle ? (f.locked ? 1 : 0) : f.locked ? 3 : 2;
              const unit = isAngle ? "°" : " m";
              const text =
                f.value == null
                  ? "—"
                  : `${Number(f.value.toFixed(digits)).toString()}${unit}`;
              return (
                <span
                  key={f.id}
                  className={
                    `cmdline-field${f.active ? " active" : ""}` +
                    (f.locked ? " locked" : f.value != null ? " live" : "")
                  }
                  title={t(f.labelKey as TranslationKey)}
                >
                  <span className="cmdline-field-label">{t(f.labelKey as TranslationKey)}</span>
                  <span className="cmdline-field-val">{text}</span>
                </span>
              );
            })}
          </span>
        )}
        <input
          ref={inputRef}
          className="cmdline-input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          value={text}
          placeholder={active ? "" : t("cmd.idle.placeholder")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    );
  },
);
