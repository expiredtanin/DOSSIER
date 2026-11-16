// Selbst-Update: fragt `endpoints` aus tauri.conf.json ab (Gitea-Release-Asset
// `latest.json`, per `/releases/latest/download/` immer der aktuellste Release
// dieses Repos — die URL selbst muss bei neuen Versionen nicht angepasst
// werden). Nur unter Tauri aktiv; im reinen Browser/Vite-Dev-Server gibt es
// weder die Plugins noch etwas zu aktualisieren.
import { ask, message } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";
import { isTauriRuntime } from "../native/projectFile";
import { isOffline } from "../net/net";

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

/** localStorage-Key: Update-Pruefung beim Start ([262], Datenschutz zuerst: Vorgabe AUS). */
const ON_START_KEY = "dossier.updateCheckOnStart";

/** Soll die App beim Start von sich aus beim Update-Server nachfragen? Vorgabe: nein. */
export function getUpdateCheckOnStart(): boolean {
  try {
    return localStorage.getItem(ON_START_KEY) === "1";
  } catch {
    return false;
  }
}

export function setUpdateCheckOnStart(on: boolean): void {
  try {
    if (on) localStorage.setItem(ON_START_KEY, "1");
    else localStorage.removeItem(ON_START_KEY);
  } catch {
    /* Speicher gesperrt: Vorgabe (aus) gilt */
  }
}

let startupCheckRan = false;

/**
 * Stiller Start-Check (Aufruf in `App.tsx`): nur wenn in den Einstellungen eingeschaltet, hoechstens einmal je
 * Seitenladen (ein Neuaufbau der App beim Sprachwechsel fragt nicht erneut), nie offline (`checkForUpdate`).
 */
export async function checkForUpdateOnStart(): Promise<void> {
  if (startupCheckRan || !getUpdateCheckOnStart()) return;
  startupCheckRan = true;
  await checkForUpdate(true);
}

/** Nur fuer Tests: der Start-Check darf wieder laufen. */
export function resetStartupCheckForTests(): void {
  startupCheckRan = false;
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
  // Offline-Modus ([262]): der Update-Check geht am Tauri-Plugin vorbei an `netFetch`, prüft den Schalter also selbst.
  if (isOffline()) {
    if (!silent) await message(t("update.offline"), { title: t("update.title"), kind: "info" });
    return;
  }
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
