// Startbildschirm nach dem Splash (s. SplashScreen.tsx) — wie bei den meisten
// CAD-Programmen: „Neues Projekt" / „Projekt öffnen…" plus eine Liste zuletzt
// geöffneter/gespeicherter Projekte (state/recentProjects.ts, nur Tauri —
// im Browser gibt es keine echten Dateipfade zum Wiederöffnen) und die
// tatsächlich laufende Version in der Fussleiste (s. update/version.ts).
import { useEffect, useState } from "react";
import { getLanguage, t } from "../i18n";
import { isTauriRuntime } from "../native/projectFile";
import { APP_VERSION } from "./TopBar";
import { getRunningVersion } from "../update/version";
import {
  getRecentProjects,
  removeRecentProject,
  type RecentProjectEntry,
} from "../state/recentProjects";

/** "vor 2 Std." / "2 hours ago" — grob gerundet auf die gröbste sinnvolle
 * Einheit (Minuten/Stunden/Tage), lokalisiert über die aktuelle App-Sprache. */
function formatRelativeTime(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const rtf = new Intl.RelativeTimeFormat(getLanguage(), { numeric: "auto" });
  const minutes = Math.round(diffMs / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(diffMs / 3_600_000);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = Math.round(diffMs / 86_400_000);
  return rtf.format(days, "day");
}

export function StartScreen({
  onNewProject,
  onOpenProject,
  onOpenRecent,
}: {
  onNewProject: () => void;
  onOpenProject: () => void;
  onOpenRecent: (path: string) => void;
}) {
  const [recent, setRecent] = useState<RecentProjectEntry[]>(() => getRecentProjects());
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void getRunningVersion().then(setVersion);
  }, []);
  const showRecent = isTauriRuntime() && recent.length > 0;

  return (
    <div className="start-screen">
      <div className="start-main">
        <div className="start-brand">
          dossier<span className="brand-dot">.</span>
        </div>
        <div className="start-actions">
          <button type="button" className="start-action" onClick={onNewProject}>
            <span className="start-action-title">{t("start.newProject")}</span>
            <span className="start-action-hint">{t("start.newProject.hint")}</span>
          </button>
          <button type="button" className="start-action" onClick={onOpenProject}>
            <span className="start-action-title">{t("start.openProject")}</span>
            <span className="start-action-hint">{t("start.openProject.hint")}</span>
          </button>
        </div>
        {showRecent && (
          <div className="start-recent">
            <div className="start-recent-title">{t("start.recent")}</div>
            <ul className="start-recent-list">
              {recent.map((e) => (
                <li key={e.path} className="start-recent-row">
                  <button
                    type="button"
                    className="start-recent-item"
                    onClick={() => onOpenRecent(e.path)}
                    title={e.path}
                  >
                    <span className="start-recent-name">{e.name}</span>
                    <span className="start-recent-path">{e.path}</span>
                  </button>
                  <span className="start-recent-time">{formatRelativeTime(e.openedAt)}</span>
                  <button
                    type="button"
                    className="start-recent-remove"
                    aria-label={t("start.recent.remove")}
                    title={t("start.recent.remove")}
                    onClick={() => {
                      removeRecentProject(e.path);
                      setRecent(getRecentProjects());
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="start-footer">
        {t("about.version")} {version ?? APP_VERSION}
      </div>
    </div>
  );
}
