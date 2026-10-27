// Selbst-Update: fragt `endpoints` aus tauri.conf.json ab (Gitea-Release-Asset
// `latest.json`, per `/releases/latest/download/` immer der aktuellste Release
// dieses Repos — die URL selbst muss bei neuen Versionen nicht angepasst
// werden). Nur unter Tauri aktiv; im reinen Browser/Vite-Dev-Server gibt es
// weder die Plugins noch etwas zu aktualisieren.
import { ask, message } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";
import { isTauriRuntime } from "../native/projectFile";

/** localStorage-Key fuer die Update-Pause (s. `getUpdateSnoozeUntil`). */
const SNOOZE_KEY = "dossier.updateSnoozeUntil";

/** Ende der aktuellen Update-Pause (ms epoch), `null` wenn keine aktiv/abgelaufen. */
export function getUpdateSnoozeUntil(): number | null {
  const raw = localStorage.getItem(SNOOZE_KEY);
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= Date.now()) return null;
  return n;
}

/** Pausiert den STILLEN Start-Check bis `untilMs` (epoch); `null` hebt die Pause auf.
 * Der manuelle Check (Button in Settings/About) ignoriert die Pause immer —
 * das ist eine explizite Nutzeraktion. */
export function setUpdateSnooze(untilMs: number | null): void {
  if (untilMs == null) localStorage.removeItem(SNOOZE_KEY);
  else localStorage.setItem(SNOOZE_KEY, String(untilMs));
}

/**
 * Prueft auf eine neue Version. `silent=true` (Start-Check) meldet sich nur
 * bei einem GEFUNDENEN Update oder einem echten Fehler — nicht bei „aktuell",
 * damit der App-Start nicht bei jedem Start einen Dialog zeigt. Respektiert
 * ausserdem eine aktive Update-Pause (s. `setUpdateSnooze`). Der manuelle
 * Aufruf (About-/Settings-Dialog, `silent=false`) meldet in jedem Fall ein
 * Ergebnis und ignoriert die Pause.
 */
export async function checkForUpdate(silent: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  if (silent && getUpdateSnoozeUntil() != null) return;
  const { check } = await import("@tauri-apps/plugin-updater");
  let update: Awaited<ReturnType<typeof check>>;
  try {
    update = await check();
  } catch (err) {
    if (!silent) {
      await message(t("update.checkFailed", { error: String(err) }), {
        title: t("update.title"),
        kind: "error",
      });
    }
    return;
  }
  if (!update) {
    if (!silent) {
      await message(t("update.upToDate"), {
        title: t("update.title"),
        kind: "info",
      });
    }
    return;
  }
  const install = await ask(t("update.availableBody", { version: update.version }), {
    title: t("update.title"),
    kind: "info",
    okLabel: t("update.installNow"),
    cancelLabel: t("update.installLater"),
  });
  if (!install) return;
  try {
    await update.downloadAndInstall();
  } catch (err) {
    await message(t("update.installFailed", { error: String(err) }), {
      title: t("update.title"),
      kind: "error",
    });
    return;
  }
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
