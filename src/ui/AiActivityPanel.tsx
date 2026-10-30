// [9] Kleines Protokoll der KI-Aufrufe (unten links, nur solange „KI-Zugriff erlauben“ an ist):
// Verbindungsstand, Schalter „KI pausieren“, die letzten Aufrufe (Änderungen hervorgehoben).

import { useState } from "react";
import { t } from "../i18n";
import { clearAiLog, setAiPaused, useAiAccess } from "../state/aiAccess";

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function AiActivityPanel() {
  const ai = useAiAccess();
  const [open, setOpen] = useState(true);
  if (!ai.enabled) return null;
  const changes = ai.log.filter((e) => e.mutating && e.ok).length;
  return (
    <div className={`ai-activity${ai.paused ? " is-paused" : ""}`} data-testid="ai-activity" role="region" aria-label={t("ai.activity.title")}>
      <div className="ai-activity-head">
        <span className={`ai-dot ai-dot-${ai.status}`} title={t(`settings.ai.status.${ai.status}`)} />
        <button type="button" className="ai-activity-title" onClick={() => setOpen(!open)} aria-expanded={open}>
          {t("ai.activity.title")} {changes > 0 && <span className="ai-count">{changes}</span>}
        </button>
        <label className="ai-pause">
          <input type="checkbox" checked={ai.paused} onChange={(e) => setAiPaused(e.target.checked)} data-testid="ai-pause" />
          {t("ai.activity.pause")}
        </label>
      </div>
      {open && (
        <>
          {ai.log.length === 0 ? (
            <div className="ai-activity-empty">{t("ai.activity.empty")}</div>
          ) : (
            <ul className="ai-activity-log" data-testid="ai-log">
              {ai.log.slice(0, 12).map((e, i) => (
                <li key={`${e.at}-${i}`} className={`${e.ok ? "" : "is-error"}${e.mutating ? " is-change" : ""}`} title={e.note}>
                  <span className="ai-time">{time(e.at)}</span>
                  <span className="ai-tool">{e.tool}</span>
                  {e.mutating && <span className="ai-tag">{t("ai.activity.change")}</span>}
                  {!e.ok && <span className="ai-tag">{t("ai.activity.error")}</span>}
                </li>
              ))}
            </ul>
          )}
          {ai.log.length > 0 && (
            <button type="button" className="ai-activity-clear" onClick={clearAiLog}>
              {t("ai.activity.clear")}
            </button>
          )}
        </>
      )}
    </div>
  );
}
