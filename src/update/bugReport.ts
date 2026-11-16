// [263] Hilfe → „Fehler melden …“: Adresse der Issue-Seite im Gitea des Projekts, mit Version und Build vorbefüllt.
// Bewusst nichts weiter (keine Projektdaten, kein Dateiname, keine Systemangaben): die Person ergänzt selbst.

import { BUILD_INFO, formatBuildInfo, type BuildInfo } from "./buildInfo";

export const BUG_REPORT_URL = "https://git.openbureau.ch/karim/dossier/issues/new";

/** `versionLine` kommt fertig übersetzt (z. B. „Version 1.0.0-beta.1 (Build 261115.1)“), `bodyTemplate` enthält `{version}`. */
export function bugReportUrl(bodyTemplate: string, buildWord: string, info: BuildInfo = BUILD_INFO): string {
  const body = bodyTemplate.replace("{version}", formatBuildInfo(info, buildWord));
  return `${BUG_REPORT_URL}?body=${encodeURIComponent(body)}`;
}
