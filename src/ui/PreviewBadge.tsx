// [265] „Vorschau“-Kennzeichnung für Funktionen, die noch nicht fertig sind (Pathtracing, Rendering mit Blender,
// Kamerafahrt/Video, Geist-Modus beim Begehen): eine dezente Marke mit Tooltip, EINE gemeinsame Stelle.
// Barrierefreiheit: die Marke ist für Screenreader verborgen, damit die Namen der Knöpfe und Dialoge stabil
// bleiben; der Tooltip steht zusätzlich als `title` am Auslöser (`previewTitle`).

import { t } from "../i18n";

/** Tooltip der Marke: sagt, dass das Ergebnis noch nicht verlässlich ist. */
export function previewHint(): string {
  return t("preview.tip");
}

/** `title`/Tooltip eines Auslösers: eigener Text, dann der Vorschau-Hinweis. */
export function previewTitle(base?: string): string {
  return base ? `${base} — ${previewHint()}` : previewHint();
}

/** Beschriftung nur als Text (native Menüs, Tooltips ohne Markup): „Name · Vorschau“. */
export function withPreview(label: string): string {
  return `${label} · ${t("preview.badge")}`;
}

export function PreviewBadge() {
  return (
    <span className="preview-badge" title={previewHint()} aria-hidden="true" data-testid="preview-badge">
      {t("preview.badge")}
    </span>
  );
}
