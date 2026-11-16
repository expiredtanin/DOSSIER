// [263] Hilfe-Menü: Kurzanleitung und Fehler melden. Der Dialog (`ui/QuickGuideDialog.tsx`) registriert seinen Öffner;
// „Fehler melden …“ öffnet die Issue-Seite im System-Browser (Muster `shortcutOverviewHook`, `aboutDialogHook`).

import { t } from "../i18n";
import { bugReportUrl } from "../update/bugReport";
import { openExternalUrl } from "../native/blender";

let opener: (() => void) | null = null;

export function setQuickGuideOpener(fn: (() => void) | null): void {
  opener = fn;
}

export function openQuickGuide(): void {
  opener?.();
}

/** Öffnet die Issue-Seite (Tauri: System-Browser, sonst neuer Tab), vorbefüllt mit Version und Build. */
export function openBugReport(): void {
  void openExternalUrl(bugReportUrl(t("help.bugReport.body"), t("about.build")));
}
