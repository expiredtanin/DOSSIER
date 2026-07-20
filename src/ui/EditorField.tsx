// Beschriftetes Feld des Ebenen-/Geschoss-InlineEditors (App.tsx) — extrahiert,
// damit das native Ebeneneinstellungs-Fenster (native/LayerSettingsWindowApp.tsx)
// dasselbe Layout wiederverwendet, ohne den ganzen App.tsx-Modulgraph in das
// (bewusst schlanke) Nebenfenster-Bundle zu ziehen.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import type { ReactNode } from "react";

export function EditorField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="editor-field">
      <span className="editor-label">{label}</span>
      <span className="editor-control">{children}</span>
    </label>
  );
}
