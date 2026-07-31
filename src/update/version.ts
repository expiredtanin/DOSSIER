// Tatsaechlich laufende App-Version (aus Tauris eigenen Metadaten, NICHT der
// manuell gepflegte `APP_VERSION`-String in ui/TopBar.tsx) — vermeidet, dass
// die Anzeige von der echten Installation abweicht, falls jemand beim
// Versionsbump eine der beiden Stellen vergisst.
import { isTauriRuntime } from "../io/projectFile";

/** `null` ausserhalb von Tauri (Vite-Dev-Server im Browser, keine Installation). */
export async function getRunningVersion(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}
