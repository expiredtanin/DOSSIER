// Arbeitsumgebung-Menü (Fenster-/Dock-Layouts) — aktuelles Layout speichern,
// benanntes Layout laden/löschen. Extrahiert aus App.tsx, damit SettingsDialog
// es sowohl inline (Haupt-App) als auch in seinem eigenen nativen Fenster
// (native/SettingsWindowApp.tsx) rendern kann, ohne es als vorgefertigtes
// ReactNode über die Fenstergrenze reichen zu müssen (JSX ist nicht
// serialisierbar). Speichern/Laden/Löschen laufen direkt über localStorage
// (panels/layout.ts) — funktioniert in JEDEM Fenster identisch, da alle
// Tauri-Fenster derselben App dieselbe Origin/denselben Storage teilen. Nur
// „aktuelles Layout übernehmen" (`onApply`) muss zurück ins Fenster mit dem
// echten App-Zustand — daher weiterhin ein Callback-Prop, kein Store-Zugriff
// hier.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useState } from "react";
import { Dropdown } from "./Dropdown";
import type { DropdownItem } from "./Dropdown";
import { PromptDialog } from "./PromptDialog";
import { t } from "../i18n";
import {
  deleteNamedLayout,
  listNamedLayouts,
  loadNamedLayout,
  saveNamedLayout,
} from "../panels/layout";
import type { LayoutState } from "../panels/types";

export function LayoutMenu({
  layout,
  onApply,
}: {
  layout: LayoutState;
  onApply: (layout: LayoutState) => void;
}) {
  const [names, setNames] = useState<string[]>([]);
  // Name-Erfassung über PromptDialog statt window.prompt (im Tauri-WKWebView
  // deaktiviert — liefert sofort null, nichts würde je gespeichert).
  const [saving, setSaving] = useState(false);

  const refresh = () => setNames(listNamedLayouts());

  const onSave = () => setSaving(true);
  const commitSave = (name: string) => {
    saveNamedLayout(name.trim(), layout);
    refresh();
    setSaving(false);
  };

  // Aktions-Menü (analog ComboMenu in TopBar.tsx): „Aktuelles speichern" oben,
  // dann je eine Gruppe „Laden" und „Löschen" (Trenner statt <optgroup>, die
  // die Dropdown-Komponente nicht kennt).
  const items: DropdownItem[] = [];
  items.push({ label: t("layout.saveCurrent"), onSelect: onSave });
  if (names.length > 0) {
    items.push({ divider: true });
    for (const n of names) {
      items.push({
        label: n,
        onSelect: () => {
          const loaded = loadNamedLayout(n);
          if (loaded) onApply(loaded);
        },
      });
    }
    items.push({ divider: true });
    for (const n of names) {
      items.push({
        label: `✕ ${n}`,
        danger: true,
        onSelect: () => {
          deleteNamedLayout(n);
          refresh();
        },
      });
    }
  }

  return (
    <span onPointerDownCapture={refresh}>
      <Dropdown items={items} placeholder={t("layout.placeholder")} title={t("layout.title")} />
      {saving && (
        <PromptDialog
          title={t("layout.title")}
          label={t("layout.savePrompt")}
          onConfirm={commitSave}
          onClose={() => setSaving(false)}
        />
      )}
    </span>
  );
}
