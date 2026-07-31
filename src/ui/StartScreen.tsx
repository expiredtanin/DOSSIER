// Startbildschirm nach dem Splash (s. SplashScreen.tsx) — wie bei den meisten
// CAD-Programmen: „Neues Projekt" / „Projekt öffnen…" plus eine Liste zuletzt
// geöffneter/gespeicherter Projekte (state/recentProjects.ts, nur Tauri —
// im Browser gibt es keine echten Dateipfade zum Wiederöffnen).
import { useState } from "react";
import { t } from "../i18n";
import { isTauriRuntime } from "../io/projectFile";
import {
  getRecentProjects,
  removeRecentProject,
  type RecentProjectEntry,
} from "../state/recentProjects";

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
  const showRecent = isTauriRuntime() && recent.length > 0;

  return (
    <div className="start-screen">
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
  );
}
