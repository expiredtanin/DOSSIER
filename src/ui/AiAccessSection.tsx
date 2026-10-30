// [9] Einstellungen → Allgemein → KI-Zugriff: Schalter (aus per Vorgabe), Sitzungsschlüssel und die
// Zeile für den MCP-Client. Rein darstellend (Werte über Props), damit sie auch im nativen
// Einstellungs-Fenster läuft (Sync-Brücke, `native/settingsWindow.ts`).

import { t } from "../i18n";

/** Was die Einstellungen vom KI-Zugriff zeigen (über die Fenstergrenze serialisierbar). */
export interface AiAccessView {
  enabled: boolean;
  token: string;
  port: number;
  status: string;
}

export function aiBridgeCommandLine(v: Pick<AiAccessView, "token" | "port">): string {
  const port = v.port === 7979 ? "" : ` --port ${v.port}`;
  return `dossier-cli mcp --app${port} --token ${v.token}`;
}

export function AiAccessSection({ view, onChange }: { view: AiAccessView; onChange: (on: boolean) => void }) {
  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});
  return (
    <section className="imp-section" data-testid="ai-access">
      <div className="imp-section-title">{t("settings.section.ai")}</div>
      <label className="settings-check">
        <input type="checkbox" checked={view.enabled} onChange={(e) => onChange(e.target.checked)} />
        {t("settings.ai.enable")}
      </label>
      <div className="imp-note">{t("settings.ai.hint")}</div>
      {view.enabled && (
        <>
          <span className="settings-field-label">{t("settings.ai.token")}</span>
          <div className="ai-token-row">
            <input className="ai-token" readOnly value={view.token} data-testid="ai-token" onFocus={(e) => e.currentTarget.select()} />
            <button type="button" onClick={() => copy(view.token)}>{t("settings.ai.copy")}</button>
          </div>
          <span className="settings-field-label">{t("settings.ai.command")}</span>
          <div className="ai-token-row">
            <code className="ai-cmd">{aiBridgeCommandLine(view)}</code>
            <button type="button" onClick={() => copy(aiBridgeCommandLine(view))}>{t("settings.ai.copy")}</button>
          </div>
          <div className="imp-note" data-testid="ai-status">{t(`settings.ai.status.${view.status}`)}</div>
        </>
      )}
    </section>
  );
}
