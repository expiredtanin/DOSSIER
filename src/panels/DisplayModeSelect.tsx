// Darstellungsmodus-Umschalter — kleines dunkles Dropdown für die Panel-Kopfzeile.
//
// Reines, kontrolliertes Steuerelement: zeigt die fünf DOSSIER-DisplayMode-
// Optionen (Alle anzeigen / Ausgewählte / Nur aktive / Andere grau / Andere
// grau & gesperrt) und meldet die Wahl per Callback. Es kennt weder Host noch
// Registry — der Rahmen (PanelFrame) reicht `value` und `onChange` durch, die
// App verdrahtet sie mit `host.displayMode`.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import type { DisplayMode } from "./types";
import { t } from "../i18n";
import { Dropdown } from "../ui/Dropdown";

/**
 * Beschriftungs-Keys je Modus (Werte englisch, vgl. types.ts) — exakt die
 * fünf DOSSIER-Modi aus docs/design/context-menu.md.
 */
const MODE_OPTIONS: { value: DisplayMode; labelKey: string }[] = [
  { value: "all_force", labelKey: "display.all_force" },
  { value: "all", labelKey: "display.all" },
  { value: "active", labelKey: "display.active" },
  { value: "grey", labelKey: "display.grey" },
  { value: "grey_locked", labelKey: "display.grey_locked" },
];

/**
 * Kleines Pill-Dropdown für den Darstellungsmodus. Vollständig kontrolliert:
 * `value` ist der aktuelle Modus, `onChange` liefert den neuen.
 */
export function DisplayModeSelect({
  value,
  onChange,
  title,
}: {
  /** Aktuell gewählter Darstellungsmodus. */
  value: DisplayMode;
  /** Wird mit dem neuen Modus aufgerufen, wenn der Nutzer wählt. */
  onChange: (mode: DisplayMode) => void;
  /** Optionaler Tooltip auf dem Dropdown (Default: i18n „Darstellungsmodus"). */
  title?: string;
}) {
  const label = title ?? t("display.title");
  return (
    <Dropdown
      triggerClassName="display-mode"
      value={value}
      title={label}
      onChange={(v) => onChange(v as DisplayMode)}
      options={MODE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
    />
  );
}
